export const AGENT_MODES = [
  { id: 'student_learning', label: 'Student Learning' },
  { id: 'everyday_support', label: 'Everyday Support' },
  { id: 'ai_upskilling', label: 'AI Fluency Upskilling' },
  { id: 'custom', label: 'Custom' },
] as const;

export type AgentModeId = (typeof AGENT_MODES)[number]['id'];

export const DEFAULT_SUPPORTED_MODES: AgentModeId[] = AGENT_MODES.map(
  ({ id }) => id,
);

const AGENT_MODE_IDS = new Set<string>(DEFAULT_SUPPORTED_MODES);

/**
 * Validate the packaging-time mode allowlist. Missing or invalid configuration
 * falls back to all modes so a malformed build can never strand onboarding.
 */
export function normalizeSupportedModes(value: unknown): AgentModeId[] {
  if (!Array.isArray(value)) return [...DEFAULT_SUPPORTED_MODES];

  const modes = value.filter(
    (mode, index): mode is AgentModeId =>
      typeof mode === 'string' &&
      AGENT_MODE_IDS.has(mode) &&
      value.indexOf(mode) === index,
  );
  return modes.length > 0 ? modes : [...DEFAULT_SUPPORTED_MODES];
}

export function defaultMode(
  supportedModes: readonly AgentModeId[],
): AgentModeId {
  return supportedModes[0] ?? DEFAULT_SUPPORTED_MODES[0];
}
