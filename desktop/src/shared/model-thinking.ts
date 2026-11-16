export const THINKING_SETTINGS = [
  'default',
  'off',
  'on',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ModelThinking = (typeof THINKING_SETTINGS)[number];

export const THINKING_LABELS: Record<ModelThinking, string> = {
  default: 'Default',
  off: 'Off',
  on: 'On',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

export function isHostedQwen(provider: string, model: string): boolean {
  return provider === 'hosted_vllm' && /^(?:.*\/)?qwen3[.\-]/i.test(model);
}
