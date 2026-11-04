import type WorkspacePermissions from './workspace-permissions';
import { readPiConnection } from './pi-provider';
import { retryOperation } from './retry-operation';
import type CommandApprovalRules from './command-approval-rules';
import fs from 'fs';
import path from 'path';
import { loadPiRuntime } from './pi-runtime-loader';
import { app } from 'electron';
import type { AgentContextSnapshot } from '../../shared/agent-context';
import PiEventTranslator from './pi-events';
import type { TutorStreamEvent } from './tutor-stream';
import AgentPermissions, { type ActionApproval } from './agent-permissions';

export interface SessionContextInput {
  model: string;
  scenario: string;
  problem: string;
  user_name: string;
  ai_tools: string[];
  memory: string;
  messages: { role: string; text: string }[];
}

interface AgentContext {
  model: string;
  instructions: string;
  profile: string;
  history: string[];
  tools: unknown[];
}
interface Runtime {
  getContextSnapshot(): AgentContextSnapshot | null;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, images: string[], context: AgentContext): Promise<void>;
  setHistoryLength(length: number): void;
  answerQuestion(toolCallId: string, response: unknown): void;
  abort(): Promise<void>;
  dispose(): void;
}

export default class PiHarness {
  constructor(private readonly workspacePermissions?: WorkspacePermissions) {}

  private runtime?: Runtime;

  private key = '';

  private workspaceGrant?: string;

  private workspaceDirectory?: string;

  private revokingWorkspace = false;

  hasWorkspaceAccess(directory: string) {
    try {
      return this.workspacePermissions
        ? this.workspacePermissions.hasWorkspace(directory)
        : this.workspaceGrant === fs.realpathSync(directory);
    } catch {
      return false;
    }
  }

  usesWorkspace(directory: string) {
    return this.workspaceDirectory === fs.realpathSync(directory);
  }

  async revokeWorkspaceAccess(directory = this.workspaceGrant) {
    if (directory) this.workspacePermissions?.revokeWorkspace(directory);
    this.revokingWorkspace = true;
    try {
      this.workspaceGrant = undefined;
      await this.dispose();
    } finally {
      this.revokingWorkspace = false;
    }
  }

  private active?: {
    requestId: string;
    stopped: boolean;
    controller: AbortController;
    permissions: AgentPermissions;
    workspaceApproval?: Promise<boolean>;
  };

  getContextSnapshot(sessionId: string) {
    if (!this.runtime || !this.key || JSON.parse(this.key)[0] !== sessionId)
      return null;
    return this.runtime.getContextSnapshot();
  }

  get busy() {
    return Boolean(this.active);
  }

  answerQuestion(toolCallId: string, response: unknown) {
    if (!this.active || this.active.stopped)
      throw new Error('This run is no longer active.');
    this.runtime?.answerQuestion(toolCallId, response);
  }

  answerPermission(id: string, allow: unknown) {
    if (!this.active || this.active.stopped)
      throw new Error('This run is no longer active.');
    this.active.permissions.answer(id, allow);
  }

  async abort(requestId?: string) {
    if (!this.active || (requestId && requestId !== this.active.requestId))
      return;
    this.active.stopped = true;
    this.active.controller.abort();
    await this.runtime?.abort();
  }

  async dispose() {
    this.workspaceGrant = undefined;
    this.workspaceDirectory = undefined;
    await this.abort();
    this.runtime?.dispose();
    this.runtime = undefined;
    this.key = '';
  }

  async run(options: {
    requestId: string;
    sessionId: string;
    directory: string;
    tutorUrl: string;
    token: string;
    text: string;
    images: string[];
    audioData?: string;
    authoringInstructions?: string;
    approvalRules?: CommandApprovalRules;
    curatedSkills?: { paths: string[]; revision: string };
    context: SessionContextInput;
    emit: (event: TutorStreamEvent) => void;
  }) {
    if (this.revokingWorkspace)
      throw new Error('Workspace access is changing. Please try again.');
    if (this.active)
      throw new Error('Coco is already working. Stop the current run first.');
    const translator = new PiEventTranslator(options.emit);
    const active = {
      requestId: options.requestId,
      stopped: false,
      controller: new AbortController(),
      permissions: new AgentPermissions(
        (request) => translator.permission(request),
        options.approvalRules,
        this.workspacePermissions,
      ),
    };
    this.active = active;
    let unsubscribe: (() => void) | undefined;
    let usageModel = 'Unknown model';
    let localContext = false;
    const timer = setTimeout(() => this.abort(options.requestId), 30 * 60_000);
    const request = async (route: string, body?: unknown, timeout?: number) => {
      const response = await fetch(`${options.tutorUrl}/agent/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          'X-Coco-Session': options.sessionId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          active.controller.signal,
          AbortSignal.timeout(
            timeout ?? (route === 'transcribe' ? 120_000 : 30_000),
          ),
        ]),
      });
      if (!response.ok)
        throw new Error(
          `Coco's agent service is unavailable (HTTP ${response.status}).`,
        );
      return response.json();
    };
    try {
      const cwd = fs.realpathSync(options.directory);
      if (!fs.statSync(cwd).isDirectory())
        throw new Error('Choose an existing working folder.');
      this.workspaceDirectory = cwd;
      const selectedModel = options.context.model;
      const [, provider, ...modelParts] = selectedModel.split('/');
      const connection = selectedModel.startsWith('pi/')
        ? { mode: 'native' as const, provider, model: modelParts.join('/') }
        : selectedModel
          ? { mode: 'coco' as const }
          : readPiConnection();
      const prepare = async () => {
        const value = await request(
          `sessions/${encodeURIComponent(options.sessionId)}`,
          options.context,
          connection.mode === 'native' ? 1500 : undefined,
        );
        localContext = true;
        return value;
      };
      const context: AgentContext =
        connection.mode === 'native'
          ? await prepare().catch((error) => {
              if (active.stopped) throw error;
              return {
                instructions: '',
                profile: `Current task: ${options.context.problem}\nUser memory: ${options.context.memory}`,
                history: options.context.messages.map(
                  (m) => `${m.role}: ${m.text}`,
                ),
                tools: [],
              };
            })
          : await retryOperation(prepare, {
              shouldContinue: () => !active.stopped,
            });
      if (connection.mode === 'native')
        context.model = `${connection.provider}/${connection.model}`;
      if (options.authoringInstructions) {
        context.instructions = options.authoringInstructions;
        context.profile = '';
        context.history = [];
        context.tools = [];
      }
      usageModel = context.model;
      let userText = options.text;
      if (options.audioData) {
        if (!localContext)
          throw new Error('Voice transcription needs the local Coco service.');
        const transcription = await request('transcribe', {
          audio_data: options.audioData,
        });
        userText = transcription.text;
        options.emit({ type: 'transcription', text: userText });
      }
      const key = JSON.stringify([
        options.sessionId,
        cwd,
        context.model,
        context.instructions,
        context.tools,
        options.tutorUrl,
        connection,
        options.curatedSkills,
        options.authoringInstructions,
      ]);
      if (!this.runtime || key !== this.key) {
        this.runtime?.dispose();
        this.runtime = undefined;
        const runtimePath = app.isPackaged
          ? path.join(app.getAppPath(), 'agent', 'pi-runtime.mjs')
          : path.join(
              app.getAppPath(),
              'release',
              'app',
              'agent',
              'pi-runtime.mjs',
            );
        const { createRuntime } = await loadPiRuntime(runtimePath);
        this.runtime = await createRuntime({
          cwd,
          sessionId: options.sessionId,
          dataDir: app.getPath('userData'),
          tutorUrl: options.tutorUrl,
          token: options.token,
          context,
          connection,
          authoring: Boolean(options.authoringInstructions),
          skillPaths: options.curatedSkills?.paths ?? [],
          requestWorkspaceAccess: async (signal?: AbortSignal) => {
            const run = this.active;
            if (!run || run.stopped || signal?.aborted) return false;
            if (this.hasWorkspaceAccess(cwd)) return true;
            const workspaceSignal = signal
              ? AbortSignal.any([signal, run.controller.signal])
              : run.controller.signal;
            // Concurrent file calls share one workspace prompt for this run.
            run.workspaceApproval ??= run.permissions
              .request({ kind: 'workspace', directory: cwd }, workspaceSignal)
              .then((allowed) => {
                if (
                  !allowed ||
                  this.active !== run ||
                  run.stopped ||
                  workspaceSignal.aborted
                )
                  return false;
                this.workspaceGrant = cwd;
                return true;
              });
            const allowed = await run.workspaceApproval;
            return (
              allowed && this.active === run && !run.stopped && !signal?.aborted
            );
          },
          requestApproval: async (
            action: ActionApproval,
            signal?: AbortSignal,
          ) => {
            // Runtime instances survive turns: always bind approval to the
            // currently active run, never the run that created the runtime.
            const run = this.active;
            if (!run || run.stopped) return false;
            const approvalSignal = signal
              ? AbortSignal.any([signal, run.controller.signal])
              : run.controller.signal;
            const allowed = await run.permissions.request(
              {
                kind: action.fileAccess ? 'path' : 'action',
                fileAccess: action.fileAccess,
                directory: action.directory,
                tool: action.tool,
                arguments: action.arguments,
              },
              approvalSignal,
            );
            return (
              allowed &&
              this.active === run &&
              !run.stopped &&
              !approvalSignal.aborted
            );
          },
        });
        this.key = key;
      }
      const runtime = this.runtime!;
      unsubscribe = runtime.subscribe((event) => translator.handle(event));
      if (!active.stopped)
        await runtime.prompt(userText, options.images, context);
      const guidance = translator.finish(active.stopped);
      if (!active.stopped && localContext && !options.authoringInstructions) {
        const recorded = await request('turn', {
          user_text: userText,
          text: guidance,
          metrics: translator.metrics(context.model),
        }).catch((error) => {
          if (connection.mode !== 'native') throw error;
          return null;
        });
        if (recorded) runtime.setHistoryLength(recorded.history_length);
      }
      options.emit({
        type: 'done',
        guidance,
        stopped: active.stopped,
        tool_calls: [...translator.calls.values()],
        activity: translator.activity,
        llm_metrics: translator.metrics(usageModel),
      });
    } catch (error) {
      if (active.stopped) {
        options.emit({
          type: 'done',
          guidance: translator.finish(true),
          stopped: true,
          llm_metrics: translator.metrics(usageModel),
          tool_calls: [...translator.calls.values()],
          activity: translator.activity,
        });
      } else {
        // Retain progress/tool output so failures do not erase completed work.
        try {
          translator.finish(false);
        } catch {
          /* original error below */
        }
        if (error instanceof Error)
          Object.assign(error, { llm_metrics: translator.metrics(usageModel) });
        throw error;
      }
    } finally {
      active.permissions.cancel();
      clearTimeout(timer);
      if (localContext)
        await fetch(
          `${options.tutorUrl}/agent/sessions/${encodeURIComponent(options.sessionId)}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${options.token}` },
            signal: AbortSignal.timeout(1500),
          },
        ).catch(() => {});

      unsubscribe?.();
      if (this.active === active) this.active = undefined;
    }
  }
}
