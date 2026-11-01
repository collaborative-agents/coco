import fs from 'fs';
import path from 'path';
import { tokenCounts, type TokenUsageRecord } from '../../shared/token-usage';
import type { LLMCallMetrics } from '../../renderer/components/observation-types';
import type { TutorStreamEvent } from './tutor-stream';

export default class TokenUsageStore {
  constructor(private readonly file: string) {}

  read(): { requests: TokenUsageRecord[]; trackingSince: string } {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !Array.isArray(data.requests) ||
        typeof data.trackingSince !== 'string'
      )
        throw new Error('Invalid token usage data.');
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { requests: [], trackingSince: new Date().toISOString() };
    }
  }

  observe(sessionId: string, requestId: string, event: TutorStreamEvent) {
    if (event.type !== 'done' && event.type !== 'error') return;
    const data = this.read();
    if (data.requests.some((request) => request.requestId === requestId))
      return;
    const metrics = event.llm_metrics as LLMCallMetrics | undefined;
    const observer = event.observer_metrics as LLMCallMetrics | undefined;
    data.requests.push({
      sessionId,
      requestId,
      at: new Date().toISOString(),
      model: metrics?.model ?? 'Unknown model',
      ...tokenCounts(metrics, observer),
      models: [metrics, observer]
        .filter((value): value is LLMCallMetrics => Boolean(value))
        .map((value) => ({
          model: value.model ?? 'Unknown model',
          ...tokenCounts(value),
        })),
      successful:
        event.type === 'done' && !event.stopped && metrics?.success !== false,
    });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}
