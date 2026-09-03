import { randomUUID } from 'crypto';
import axios from 'axios';
import type { IpcMain } from 'electron';
import log from 'electron-log';
import { readConversations, saveConversation } from '../conversation-store';
import {
  readModelConfiguration,
  resolveTutorRuntimeConnection,
} from '../model-config-store';
import { readLocalMemory, readTutorProfile } from '../user-data-store';

export interface ChatSeed {
  phrase: string;
  label: string;
  rawObservation: string;
  /** Attach context to the user's next turn instead of sending immediately. */
  deferUntilUserMessage?: boolean;
  /** Pre-fill Coco's composer without sending the message. */
  initialInput?: string;
}

export type SessionCompletionReason = 'user_ended' | 'app_quit' | 'error';
export type SessionStartTrigger =
  | 'proactive_suggestion'
  | 'user_message'
  | 'manual';

type GatewayOperation = (
  type: 'session_start' | 'session_end',
  payload: Record<string, unknown>,
) => void;

export interface ChatSessionControllerOptions {
  appRunId: string;
  openChatForSession: (
    sessionId: string,
    problemStatement: string,
    seed?: ChatSeed,
  ) => void;
  onSessionEnded: () => void;
  queueGatewayOperation: GatewayOperation;
}

export default class ChatSessionController {
  private readonly options: ChatSessionControllerOptions;

  private active = false;

  private sessionId: string | null = null;

  private taskLabel: string | null = null;

  private tutorModelId: string | null = null;

  private readonly endedGatewaySessions = new Set<string>();

  constructor(options: ChatSessionControllerOptions) {
    this.options = options;
  }

  get isActive(): boolean {
    return this.active;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get pendingTaskLabel(): string | null {
    return this.taskLabel;
  }

  get currentTutorModelId(): string | null {
    return this.tutorModelId;
  }

  setPendingTaskLabel(taskLabel: string | null): void {
    this.taskLabel = taskLabel;
  }

  setCurrentTutorModelId(modelId: string | null): void {
    this.tutorModelId = modelId;
  }

  syncRendererState(active: boolean, sessionId?: string): void {
    this.active = active;
    if (active && sessionId) {
      this.sessionId = sessionId;
      return;
    }
    if (!active) {
      this.sessionId = null;
      this.notifySensingSessionEnded();
    }
  }

  registerConversationIpc(ipcMain: IpcMain): void {
    ipcMain.removeHandler('get-chat-conversations');
    ipcMain.handle('get-chat-conversations', () => readConversations());

    const save = (payload: Record<string, unknown> | null | undefined) => {
      saveConversation({
        ...(payload ?? {}),
        tutorModelId: this.tutorModelId,
      });
    };
    ipcMain.removeHandler('save-chat-conversation');
    ipcMain.handle('save-chat-conversation', (_event, payload) => {
      save(payload);
      return { success: true };
    });
    ipcMain.removeAllListeners('save-chat-conversation');
    ipcMain.on('save-chat-conversation', (_event, payload) => save(payload));

    ipcMain.removeHandler('resume-chat-conversation');
    ipcMain.handle(
      'resume-chat-conversation',
      async (_event, { sessionId }: { sessionId?: string } = {}) =>
        this.resume(sessionId),
    );
  }

  async start(
    problemStatement: string,
    struggleSeconds: number,
    seed?: ChatSeed,
    startTrigger: SessionStartTrigger = 'manual',
  ): Promise<string> {
    if (this.sessionId && !this.endedGatewaySessions.has(this.sessionId)) {
      this.end('user_ended');
    }

    const { aiTools, scenario, customObserverPrompt, userName } =
      readTutorProfile();
    const sensingPort = process.env.SENSING_PORT || '8080';
    const tutorPort = process.env.TUTOR_PORT || '8081';
    const sensing = `http://127.0.0.1:${sensingPort}`;
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const sessionId = randomUUID();
    const modelConfig = readModelConfiguration();
    const selectedTutor = resolveTutorRuntimeConnection();
    this.tutorModelId = selectedTutor?.id ?? null;

    // Publish the new session before configuring services so the UI remains
    // responsive and every subsequent user turn has the correct session id.
    this.sessionId = sessionId;
    this.active = true;
    this.options.openChatForSession(sessionId, problemStatement, seed);
    log.info(`[ProactiveSession] Local tutor session started: ${sessionId}`);
    this.options.queueGatewayOperation('session_start', {
      _id: sessionId,
      started_at: new Date().toISOString(),
      start_trigger: startTrigger,
      scenario,
      ...(selectedTutor?.model ? { tutor_model: selectedTutor.model } : {}),
      ...(modelConfig?.sensing.model
        ? { observer_model: modelConfig.sensing.model }
        : {}),
      app_run_id: this.options.appRunId,
      repository: 'coco',
      ...(process.env.COCO_GIT_COMMIT_SHA
        ? { git_commit_sha: process.env.COCO_GIT_COMMIT_SHA }
        : {}),
      ...(process.env.COCO_GIT_BRANCH
        ? { git_branch: process.env.COCO_GIT_BRANCH }
        : {}),
    });

    try {
      await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
      if (selectedTutor) {
        await axios.post(
          `${tutor}/config/model`,
          { model: selectedTutor.model },
          { timeout: 8000 },
        );
      }
      await axios.post(
        `${tutor}/config/scenario`,
        { scenario },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/problem_statement`,
        { problem_statement: problemStatement },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/ai_tools`,
        { ai_tools: aiTools },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/user_name`,
        { user_name: userName },
        { timeout: 8000 },
      );
      const savedMemory = readLocalMemory();
      if (savedMemory) {
        await axios.post(
          `${tutor}/context/memory`,
          { memory: savedMemory },
          { timeout: 8000 },
        );
      }
    } catch (error) {
      log.warn(
        `[ProactiveSession] Tutor context setup failed: ${(error as Error).message}`,
      );
    }

    try {
      await axios.post(
        `${sensing}/session`,
        {
          node_uuid: sessionId,
          struggle_detection_seconds: struggleSeconds,
          scenario,
          config_source: 'session_start',
          ...(customObserverPrompt && {
            custom_observer_prompt: customObserverPrompt,
          }),
        },
        { timeout: 15000 },
      );
    } catch (error) {
      log.warn(
        `[ProactiveSession] Sensing session setup failed (proactive disabled): ${(error as Error).message}`,
      );
    }

    return sessionId;
  }

  async resume(sessionId?: string): Promise<{
    success: boolean;
    tutorModelId?: string | null;
    error?: string;
  }> {
    const conversation = readConversations().find(
      (saved) => saved.sessionId === sessionId,
    );
    if (!conversation) {
      return { success: false, error: 'Conversation not found.' };
    }

    const tutorPort = process.env.TUTOR_PORT || '8081';
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const { aiTools, scenario, userName } = readTutorProfile();
    try {
      await axios.post(`${tutor}/context/reset`, {}, { timeout: 8000 });
      const selectedTutor = resolveTutorRuntimeConnection(
        conversation.tutorModelId,
      );
      if (selectedTutor) {
        await axios.post(
          `${tutor}/config/model`,
          { model: selectedTutor.model },
          { timeout: 8000 },
        );
        this.tutorModelId = selectedTutor.id;
      }
      await axios.post(
        `${tutor}/config/scenario`,
        { scenario },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/problem_statement`,
        { problem_statement: conversation.problem },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/ai_tools`,
        { ai_tools: aiTools },
        { timeout: 8000 },
      );
      await axios.post(
        `${tutor}/context/user_name`,
        { user_name: userName },
        { timeout: 8000 },
      );
      const savedMemory = readLocalMemory();
      if (savedMemory) {
        await axios.post(
          `${tutor}/context/memory`,
          { memory: savedMemory },
          { timeout: 8000 },
        );
      }
      await axios.post(
        `${tutor}/context/conversation`,
        {
          messages: conversation.messages
            .filter((message) => !message.isError)
            .map(({ role, text }) => ({ role, text })),
        },
        { timeout: 8000 },
      );
      this.sessionId = conversation.sessionId;
      this.active = true;
      this.taskLabel = conversation.problem;
      return { success: true, tutorModelId: this.tutorModelId };
    } catch (error) {
      log.warn(
        `[Chat] Could not resume conversation: ${(error as Error).message}`,
      );
      return { success: false, error: (error as Error).message };
    }
  }

  async restoreAfterModelRestart(): Promise<void> {
    if (!this.sessionId) return;
    const conversation = readConversations().find(
      (item) => item.sessionId === this.sessionId,
    );
    const tutorPort = process.env.TUTOR_PORT || '8081';
    const sensingPort = process.env.SENSING_PORT || '8080';
    const tutor = `http://127.0.0.1:${tutorPort}`;
    const sensing = `http://127.0.0.1:${sensingPort}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        // Readiness retries are intentionally sequential.
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([
          axios.get(`${tutor}/health`, { timeout: 1000 }),
          axios.get(`${sensing}/health`, { timeout: 1000 }),
        ]);
        break;
      } catch {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
      }
    }
    const { aiTools, scenario, customObserverPrompt, userName } =
      readTutorProfile();
    await axios.post(
      `${tutor}/config/scenario`,
      { scenario },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/problem_statement`,
      { problem_statement: conversation?.problem || this.taskLabel || '' },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/ai_tools`,
      { ai_tools: aiTools },
      { timeout: 8000 },
    );
    await axios.post(
      `${tutor}/context/user_name`,
      { user_name: userName },
      { timeout: 8000 },
    );
    const memory = readLocalMemory();
    if (memory) {
      await axios.post(
        `${tutor}/context/memory`,
        { memory },
        { timeout: 8000 },
      );
    }
    if (conversation) {
      await axios.post(
        `${tutor}/context/conversation`,
        {
          messages: conversation.messages
            .filter((message) => !message.isError)
            .map(({ role, text }) => ({ role, text })),
        },
        { timeout: 8000 },
      );
    }
    await axios.post(
      `${sensing}/session`,
      {
        node_uuid: this.sessionId,
        struggle_detection_seconds: 120,
        scenario,
        config_source: 'model_settings_restart',
        ...(customObserverPrompt && {
          custom_observer_prompt: customObserverPrompt,
        }),
      },
      { timeout: 15000 },
    );
  }

  end(completionReason: SessionCompletionReason = 'user_ended'): void {
    this.recordGatewayEnd(completionReason);
    this.active = false;
    this.sessionId = null;
    this.options.onSessionEnded();
    this.notifySensingSessionEnded();
  }

  recordGatewayEnd(completionReason: SessionCompletionReason): void {
    if (!this.sessionId || this.endedGatewaySessions.has(this.sessionId)) {
      return;
    }
    this.endedGatewaySessions.add(this.sessionId);
    this.options.queueGatewayOperation('session_end', {
      session_id: this.sessionId,
      ended_at: new Date().toISOString(),
      completion_reason: completionReason,
    });
  }

  // eslint-disable-next-line class-methods-use-this
  private notifySensingSessionEnded(): void {
    const sensingPort = process.env.SENSING_PORT || '8080';
    axios
      .post(`http://127.0.0.1:${sensingPort}/session/end`)
      .catch((error) =>
        log.warn('Could not notify sensing server of session end:', error),
      );
  }
}
