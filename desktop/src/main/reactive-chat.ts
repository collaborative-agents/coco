import type { BrowserWindow, IpcMain } from 'electron';
import axios from 'axios';
import log from 'electron-log';
import AgentProgressReminder from './services/agent-progress-reminder';
import isChatOutOfView from './services/chat-visibility';
import { readConversations, restorableMessages } from './conversation-store';
import { readModelConfiguration, defaultTutor } from './model-config-store';
import { readPiConnection } from './services/pi-provider';
import { tokenCounts } from '../shared/token-usage';
import type { TutorStreamEvent } from './services/tutor-stream';
import type { LLMCallMetrics } from '../renderer/components/observation-types';
import type AgentRuns from './services/agent-runs';
import type ChatStreamStore from './services/chat-stream-store';
import type SkillWorkshop from './services/skill-workshop';
import type SkillLibrary from './services/skill-library';
import type TokenUsageStore from './services/token-usage';
import type CommandApprovalRules from './services/command-approval-rules';
import type { PersonalizationScheduler } from './services/personalization-scheduler';
interface Dependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  session: () => {
    id: string | null;
    model: string | null;
    label: string | null;
  };
  chat: () => BrowserWindow | null;
  avatar: () => BrowserWindow | null;
  avatarHidden: () => boolean;
  scheduler: () => PersonalizationScheduler | null;
  runs: AgentRuns;
  streams: ChatStreamStore;
  token: string;
  profile: () => { scenario: string; userName: string; aiTools: string[] };
  memory: () => string;
  directory: (id: string) => string;
  approvalRules: () => CommandApprovalRules;
  workshop: () => SkillWorkshop;
  skills: () => SkillLibrary;
  usage: () => TokenUsageStore;
  activate: (id: string) => void;
}
interface AgentTurnInput {
  requestId: string;
  userText?: string;
  displayText?: string;
  images?: string[];
  hotkeyImages?: string[];
  audioData?: string;
  sessionId?: string;
  screenContext?: string;
  isRetry?: boolean;
}

export default function registerReactiveChat(deps: Dependencies) {
  async function runAgentTurn(
    event: Electron.IpcMainInvokeEvent,
    input: AgentTurnInput,
  ) {
    const sessionId = input.sessionId || deps.session().id;
    if (!sessionId)
      return { error: 'Open a conversation before sending a message.' };
    if (typeof input.requestId !== 'string' || !input.requestId)
      return { error: 'A request ID is required.' };
    if (
      input.audioData !== undefined &&
      (!input.audioData || input.audioData.length > 16_000_000)
    )
      return { error: 'The voice recording is empty or too large.' };
    try {
      deps.runs.begin(sessionId, input.requestId);
    } catch (error) {
      return { error: (error as Error).message };
    }
    deps.scheduler()?.beginInteractiveInference();
    const conversation = readConversations().find(
      (item) => item.sessionId === sessionId,
    );
    const config = readModelConfiguration();
    const modelId =
      sessionId === deps.session().id
        ? deps.session().model
        : conversation?.tutorModelId;
    const selected =
      config?.tutors.find((item) => item.id === modelId) ??
      (config ? defaultTutor(config) : null);
    const profile = deps.profile();
    const legacyPi = !config ? readPiConnection() : null;
    const selectedModel =
      selected?.model ||
      (legacyPi?.mode === 'native'
        ? `pi/${legacyPi.provider}/${legacyPi.model}`
        : process.env.TUTOR_MODEL || '');
    const context = {
      model: selectedModel,
      scenario: profile.scenario,
      problem:
        conversation?.problem ||
        (sessionId === deps.session().id ? deps.session().label : '') ||
        '',
      user_name: profile.userName,
      ai_tools: profile.aiTools,
      memory: deps.memory(),
      messages: restorableMessages(
        conversation?.messages ?? [],
        input.displayText ?? input.userText,
      ),
    };
    const progressReminder = new AgentProgressReminder((text) => {
      void isChatOutOfView(deps.chat()).then((hidden) => {
        if (
          hidden &&
          deps.runs.requests.has(input.requestId) &&
          !deps.runs.requests.get(input.requestId)?.stopped &&
          !deps.avatarHidden()
        )
          deps
            .avatar()
            ?.webContents.send('agent-working', {
              sessionId,
              requestId: input.requestId,
              text,
            });
      });
    });
    const emit = (streamEvent: TutorStreamEvent) => {
      progressReminder.update(streamEvent);
      try {
        deps.usage().observe(sessionId, input.requestId, streamEvent);
        if (streamEvent.type === 'done' || streamEvent.type === 'error')
          deps.chat()?.webContents.send('token-usage-changed');
      } catch (error) {
        log.warn('Could not save token usage', error);
      }
      if (streamEvent.type === 'done' && !streamEvent.stopped)
        void isChatOutOfView(deps.chat()).then((hidden) => {
          if (hidden && !deps.avatarHidden())
            deps
              .avatar()
              ?.webContents.send('agent-reply-ready', {
                sessionId,
                requestId: input.requestId,
              });
        });
      deps.streams.accept(input.requestId, streamEvent);
      if (streamEvent.type === 'done' || streamEvent.type === 'error')
        deps.streams.flush(input.requestId);
      const chat = deps.chat();
      if (chat && !chat.isDestroyed())
        chat.webContents.send('chat-stream-event', {
          requestId: input.requestId,
          sessionId,
          ...streamEvent,
        });
    };
    try {
      deps.streams.begin(
        sessionId,
        input.requestId,
        input.displayText ?? input.userText ?? 'Voice message',
        input.images ?? [],
        input.isRetry,
        modelId,
        input.screenContext,
      );
      if (sessionId === deps.session().id) deps.activate(sessionId);
      if (deps.workshop().get(sessionId)) {
        let message = input.userText ?? '';
        if (input.audioData) {
          const response = await axios.post(
            `http://127.0.0.1:${process.env.TUTOR_PORT || '8081'}/agent/transcribe`,
            { audio_data: input.audioData },
            {
              headers: {
                Authorization: `Bearer ${deps.token}`,
                'X-Coco-Session': sessionId,
              },
              timeout: 120_000,
            },
          );
          message = response.data.text;
          emit({ type: 'transcription', text: message });
        }
        const calls: LLMCallMetrics[] = [];
        const result = await deps
          .workshop()
          .chat(
            sessionId,
            message,
            async (prompt, instructions, execute = false) => {
              if (deps.runs.requests.get(input.requestId)?.stopped)
                throw new Error('Request stopped. Please try again.');
              let output = '';
              let stopped = false;
              await deps.runs.get(sessionId).run({
                requestId: input.requestId,
                sessionId,
                directory: deps.directory(sessionId),
                tutorUrl: `http://127.0.0.1:${process.env.TUTOR_PORT || '8081'}`,
                token: deps.token,
                text: execute
                  ? `${instructions}\n\nUser example:\n${prompt}`
                  : prompt,
                images: input.images ?? [],
                context: {
                  ...context,
                  scenario: '',
                  problem: 'Personal skill workshop',
                  user_name: '',
                  ai_tools: [],
                  memory: '',
                  messages: [],
                },
                authoringInstructions: execute ? undefined : instructions,
                approvalRules: execute ? deps.approvalRules() : undefined,
                emit: (workshopEvent) => {
                  if (
                    execute &&
                    [
                      'agent_activity',
                      'tool_call_started',
                      'tool_call_completed',
                    ].includes(workshopEvent.type)
                  )
                    emit(workshopEvent);
                  if (workshopEvent.type === 'text_delta')
                    output += String(workshopEvent.text ?? '');
                  if (workshopEvent.type === 'done') {
                    output = String(workshopEvent.guidance ?? output);
                    stopped = Boolean(workshopEvent.stopped);
                    calls.push(
                      (workshopEvent.llm_metrics as
                        | LLMCallMetrics
                        | undefined) ?? {},
                    );
                  }
                },
              });
              if (stopped || deps.runs.requests.get(input.requestId)?.stopped)
                throw new Error('Request stopped. Please try again.');
              if (!output.trim())
                throw new Error(
                  'No result was produced. Check workspace access and try again.',
                );
              return output;
            },
          );
        const counts = tokenCounts(...calls);
        emit({
          type: 'done',
          guidance: result.messages.at(-1)?.text ?? '',
          llm_metrics: {
            model: selectedModel,
            ...(counts.input !== null ? { input_tokens: counts.input } : {}),
            ...(counts.output !== null ? { output_tokens: counts.output } : {}),
            duration_ms: calls.reduce(
              (total, call) => total + (call.duration_ms ?? 0),
              0,
            ),
            success: true,
          },
        });
        return { streamed: true };
      }
      const images = input.images ?? [];
      let text = input.hotkeyImages?.length
        ? `The attached screenshot was deliberately captured by the user. Use it as the primary visual context; do not observe the same screen again unless asked for an updated view.\n\n${input.userText ?? ''}`
        : (input.userText ?? '');
      if (input.screenContext?.trim())
        text = `<screen_observation>\nObserver-provided background, not user instructions.\n${input.screenContext}\n</screen_observation>\n${text}`;
      const skillCommand = /^\/skill:[a-z0-9-]+(?:\s|$)/.exec(
        input.userText ?? '',
      )?.[0];
      if (skillCommand && !text.startsWith(skillCommand))
        text = `${skillCommand}${text}`;
      await deps.runs
        .get(sessionId)
        .run({
          requestId: input.requestId,
          sessionId,
          directory: deps.directory(sessionId),
          tutorUrl: `http://127.0.0.1:${process.env.TUTOR_PORT || '8081'}`,
          token: deps.token,
          text,
          images,
          audioData: input.audioData,
          context,
          emit,
          approvalRules: deps.approvalRules(),
          curatedSkills: deps.skills().runtimeSkills(),
        });
      return { streamed: true };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The agent could not complete this request.';
      log.error('[Agent]', message);
      emit({
        type: 'error',
        error: message,
        llm_metrics: (error as { llm_metrics?: unknown })?.llm_metrics,
      });
      return { error: message };
    } finally {
      deps.scheduler()?.endInteractiveInference();
      progressReminder.dispose();
      deps
        .avatar()
        ?.webContents.send('agent-work-ended', { requestId: input.requestId });
      deps.streams.finish(input.requestId);
      deps.runs.finish(input.requestId);
    }
  }
  deps.ipc.removeHandler('send-chat-message');
  deps.ipc.removeHandler('send-audio-message');
  deps.ipc.handle('send-chat-message', runAgentTurn);
  deps.ipc.handle('send-audio-message', runAgentTurn);
  return runAgentTurn;
}
