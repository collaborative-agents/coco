export interface AgentPreferencesInput {
  scenario: string;
  hideAvatar: boolean;
  customObserverPrompt?: string;
}

/** Keep the existing profile field so previously saved custom prompts still load. */
export function applyAgentPreferences(
  profile: Record<string, unknown>,
  input: AgentPreferencesInput,
) {
  if (!['everyday_support', 'custom'].includes(input.scenario))
    throw new Error('Choose a supported agent mode.');
  const prompt = input.customObserverPrompt ?? profile.customSystemPrompt ?? '';
  if (typeof prompt !== 'string' || prompt.length > 40000)
    throw new Error('Observer prompt must be at most 40,000 characters.');
  if (input.scenario === 'custom' && !prompt.trim())
    throw new Error('Enter an observer prompt for Custom mode.');
  const next: Record<string, unknown> = {
    ...profile,
    tutorScenario: input.scenario,
    hideAvatar: input.hideAvatar === true,
    customSystemPrompt: prompt,
  };
  delete next.aiTools;
  return next;
}

/** Custom mode changes the observer only; judge and tutor keep the base scenario. */
export function observerPreferences(profile: Record<string, unknown>) {
  const custom = profile.tutorScenario === 'custom';
  return {
    scenario:
      !custom &&
      typeof profile.tutorScenario === 'string' &&
      profile.tutorScenario
        ? profile.tutorScenario
        : 'everyday_support',
    customObserverPrompt:
      custom && typeof profile.customSystemPrompt === 'string'
        ? profile.customSystemPrompt
        : '',
  };
}
