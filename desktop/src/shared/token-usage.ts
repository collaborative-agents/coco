import type { LLMCallMetrics } from '../renderer/components/observation-types';

export interface TokenUsageRecord {
  requestId: string;
  sessionId: string;
  at: string;
  model: string;
  input: number | null;
  output: number | null;
  successful: boolean;
  models?: { model: string; input: number | null; output: number | null }[];
}
/** Missing counts stay unknown; cached input is included in pi's input count. */
export function tokenCounts(...metrics: (LLMCallMetrics | null | undefined)[]) {
  const present = metrics.filter((metric): metric is LLMCallMetrics =>
    Boolean(metric),
  );
  const sum = (key: 'input' | 'output') => {
    if (!present.length) return null;
    const counts = present.map((metric) =>
      key === 'input'
        ? (metric.input_tokens ?? metric.prompt_tokens)
        : (metric.output_tokens ?? metric.completion_tokens),
    );
    return counts.every(
      (count) =>
        typeof count === 'number' && Number.isFinite(count) && count >= 0,
    )
      ? counts.reduce<number>((total, count) => total + count!, 0)
      : null;
  };
  return { input: sum('input'), output: sum('output') };
}
