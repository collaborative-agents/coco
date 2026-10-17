import type { AgentActivity } from '../../shared/agent-execution';
import type { TutorToolCall } from '../../renderer/components/observation-types';
import type { TutorStreamEvent } from './tutor-stream';

/** Converts pi's multi-message turn into Coco's ordered activity + final reply. */
export default class PiEventTranslator {
  text = '';

  activity: AgentActivity[] = [];

  calls = new Map<string, TutorToolCall>();

  error?: string;

  private readonly startedAt = Date.now();

  private inputTokens = 0;

  private outputTokens = 0;

  metrics(model: string) {
    return {
      model,
      operation: 'pi_agent',
      success: !this.error,
      prompt_tokens: this.inputTokens,
      completion_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
      duration_ms: Date.now() - this.startedAt,
    };
  }

  private readonly emit: (event: TutorStreamEvent) => void;

  constructor(emit: (event: TutorStreamEvent) => void) {
    this.emit = emit;
  }

  private publish() {
    this.emit({
      type: 'agent_activity',
      activity: [...this.activity],
      text: this.text,
    });
  }

  handle(event: any) {
    if (
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta'
    ) {
      const text = event.assistantMessageEvent.delta;
      this.text += text;
      this.emit({ type: 'text_delta', text });
    } else if (
      event.type === 'message_end' &&
      event.message?.role === 'assistant'
    ) {
      const { usage } = event.message;
      this.inputTokens +=
        (usage?.input ?? 0) +
        (usage?.cacheRead ?? 0) +
        (usage?.cacheWrite ?? 0);
      this.outputTokens += usage?.output ?? 0;
      if (event.message.stopReason === 'error') {
        this.error =
          event.message.errorMessage ||
          'The agent could not complete this request.';
      }
    } else if (event.type === 'auto_retry_start') {
      this.error = undefined;
      this.activity.push({
        kind: 'message',
        text: `Retrying the model (${event.attempt}/${event.maxAttempts})…`,
      });
      this.publish();
    } else if (event.type === 'compaction_start') {
      this.activity.push({
        kind: 'message',
        text: 'Condensing earlier context so I can keep working…',
      });
      this.publish();
    } else if (event.type.startsWith('tool_execution_')) {
      if (event.type === 'tool_execution_start' && this.text) {
        this.activity.push({ kind: 'message', text: this.text });
        this.text = '';
      }
      const previous = this.calls.get(event.toolCallId);
      const rawResult = event.result ?? event.partialResult;
      const output = rawResult?.content
        ?.filter((part: any) => part.type === 'text')
        .map((part: any) => part.text)
        .join('\n');
      const call: TutorToolCall = {
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args ?? previous?.arguments ?? {},
        status: event.type === 'tool_execution_end' ? 'completed' : 'running',
        ...(rawResult
          ? {
              result: {
                ...rawResult.details,
                output: output?.slice(-24000),
                ...(event.isError ? { error: output || 'Tool failed' } : {}),
              },
            }
          : {}),
      };
      if (event.isError) call.status = 'error';
      this.calls.set(call.id, call);
      const index = this.activity.findIndex(
        (item) => item.kind === 'tool' && item.call.id === call.id,
      );
      if (index < 0) this.activity.push({ kind: 'tool', call });
      else this.activity[index] = { kind: 'tool', call };
      this.publish();
    }
  }

  finish(stopped: boolean) {
    this.activity = this.activity.map((item) => {
      if (item.kind !== 'tool' || item.call.status !== 'running') return item;
      const call: TutorToolCall = {
        ...item.call,
        status: 'error',
        result: { error: stopped ? 'Stopped' : 'Interrupted' },
      };
      this.calls.set(call.id, call);
      return { kind: 'tool', call };
    });
    this.publish();
    if (this.error && !stopped) throw new Error(this.error);
    return this.text || (stopped ? 'Stopped.' : 'Done.');
  }
}
