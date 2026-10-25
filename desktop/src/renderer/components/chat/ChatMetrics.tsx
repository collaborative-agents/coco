import type { LLMCallMetrics } from '../observation-types';
import { S } from './styles';
import { formatMetricTokens, formatMetricLatency } from './message-format';

export default function ChatMetrics({
  observerMetrics,
  tutorMetrics,
}: {
  observerMetrics?: LLMCallMetrics | null;
  tutorMetrics?: LLMCallMetrics | null;
}) {
  const metrics = [observerMetrics, tutorMetrics].filter(
    (m): m is LLMCallMetrics => Boolean(m),
  );
  if (metrics.length === 0) return null;

  const inputTokens = metrics.reduce(
    (total, m) => total + (m.input_tokens ?? m.prompt_tokens ?? 0),
    0,
  );
  const outputTokens = metrics.reduce(
    (total, m) => total + (m.output_tokens ?? m.completion_tokens ?? 0),
    0,
  );
  const durationMs = metrics.reduce(
    (total, m) => total + (m.duration_ms ?? 0),
    0,
  );

  return (
    <div style={S.metricRow}>
      <span style={S.metricChip}>
        {formatMetricTokens(inputTokens)} in /{' '}
        {formatMetricTokens(outputTokens)} out /{' '}
        {formatMetricLatency(durationMs)}
      </span>
    </div>
  );
}
