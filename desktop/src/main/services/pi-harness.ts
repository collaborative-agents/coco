import fs from 'fs';
import { readPiConnection } from './pi-provider';
import path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import type { AgentContextSnapshot } from '../../shared/agent-context';
import PiEventTranslator from './pi-events';
import { retryOperation } from './retry-operation';
import type { TutorStreamEvent } from './tutor-stream';

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
  private runtime?: Runtime;

  private key = '';

  private active?: {
    requestId: string;
    stopped: boolean;
    controller: AbortController;
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

  async abort(requestId?: string) {
    if (!this.active || (requestId && requestId !== this.active.requestId))
      return;
    this.active.stopped = true;
    this.active.controller.abort();
    await this.runtime?.abort();
  }

  async dispose() {
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
    emit: (event: TutorStreamEvent) => void;
  }) {
    if (this.active)
      throw new Error('Coco is already working. Stop the current run first.');
    const active = {
      requestId: options.requestId,
      stopped: false,
      controller: new AbortController(),
    };
    this.active = active;
    const translator = new PiEventTranslator(options.emit);
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => this.abort(options.requestId), 30 * 60_000);
    const request = async (route: string, body?: unknown, timeout?: number) => {
      const response = await fetch(`${options.tutorUrl}/agent/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
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
      let userText = options.text;
      if (options.audioData) {
        const transcription = await request('transcribe', {
          audio_data: options.audioData,
        });
        userText = transcription.text;
        options.emit({ type: 'transcription', text: userText });
      }
      const cwd = fs.realpathSync(options.directory);
      if (!fs.statSync(cwd).isDirectory())
        throw new Error('Choose an existing working folder.');
      const connection = readPiConnection();
      let localContext = connection.mode !== 'native';
      const context: AgentContext =
        connection.mode === 'native'
          ? await request('context', undefined, 1500)
              .then((value) => {
                localContext = true;
                return value;
              })
              .catch((error) => {
                if (active.stopped) throw error;
                return {
                  instructions: '',
                  profile: '',
                  history: [],
                  tools: [],
                };
              })
          : await retryOperation(() => request('context'), {
              shouldContinue: () => !active.stopped,
            });
      if (connection.mode === 'native')
        context.model = `${connection.provider}/${connection.model}`;
      const key = JSON.stringify([
        options.sessionId,
        cwd,
        context.model,
        connection,
        context.instructions,
        context.tools,
        options.tutorUrl,
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
        const { createRuntime } = await import(
          /* webpackIgnore: true */ pathToFileURL(runtimePath).href
        );
        this.runtime = await createRuntime({
          cwd,
          sessionId: options.sessionId,
          dataDir: app.getPath('userData'),
          tutorUrl: options.tutorUrl,
          token: options.token,
          context,
          connection,
        });
        this.key = key;
      }
      const runtime = this.runtime!;
      unsubscribe = runtime.subscribe((event) => translator.handle(event));
      if (!active.stopped)
        await runtime.prompt(userText, options.images, context);
      const guidance = translator.finish(active.stopped);
      if (!active.stopped && localContext) {
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
        llm_metrics: translator.metrics(context.model),
      });
    } catch (error) {
      if (active.stopped) {
        options.emit({
          type: 'done',
          guidance: translator.finish(true),
          stopped: true,
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
        throw error;
      }
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
      if (this.active === active) this.active = undefined;
    }
  }
}
