import type { TutorStreamEvent } from './tutor-stream';
import { parseAgentActivity } from '../../shared/agent-execution';

/** Samples the latest real activity, rather than interrupting on every token. */
export default class AgentProgressReminder {
  private latest = 'Still working on your request…';
  private assistantText = '';
  private active = true;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(publish: (text: string) => void, intervalMs = 30_000) {
    this.timer = setInterval(() => {
      if (this.active) publish(this.latest);
    }, intervalMs);
  }

  update(event: TutorStreamEvent) {
    if (event.type === 'done' || event.type === 'error') {
      this.dispose();
      return;
    }
    if (event.type === 'text_delta' && typeof event.text === 'string') {
      this.assistantText = (this.assistantText + event.text).slice(-1000);
      const text = this.assistantText.replace(/\s+/g, ' ').trim();
      if (text) this.latest = text.length > 180 ? `…${text.slice(-177)}` : text;
      return;
    }
    if (event.type !== 'agent_activity') return;
    this.assistantText = '';
    const last = parseAgentActivity(event.activity)?.at(-1);
    if (!last) return;
    const text =
      last.kind === 'message'
        ? last.text
        : last.call.result?.waitingForAnswer
          ? 'Waiting for your answer in chat.'
          : last.call.status === 'running'
            ? `Working with ${last.call.name}…`
            : last.call.status === 'error'
              ? `The ${last.call.name} step had an error; checking what to do next…`
              : `Finished the ${last.call.name} step; continuing…`;
    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact)
      this.latest =
        compact.length > 180 ? `${compact.slice(0, 177)}…` : compact;
  }

  dispose() {
    this.active = false;
    clearInterval(this.timer);
  }
}
