import {
  applyAgentPreferences,
  observerPreferences,
} from './agent-preferences';

test('custom preferences persist the prompt and route it only to the observer', () => {
  const next = applyAgentPreferences(
    { userName: 'Alex', aiTools: ['legacy'] },
    {
      scenario: 'custom',
      hideAvatar: false,
      customObserverPrompt: 'Observe editing mistakes.\nBe concise.',
    },
  );
  expect(next).toMatchObject({
    userName: 'Alex',
    tutorScenario: 'custom',
    customSystemPrompt: 'Observe editing mistakes.\nBe concise.',
  });
  expect(next).not.toHaveProperty('aiTools');
  expect(observerPreferences(next)).toEqual({
    scenario: 'everyday_support',
    customObserverPrompt: next.customSystemPrompt,
  });
  const everyday = applyAgentPreferences(next, {
    scenario: 'everyday_support',
    hideAvatar: false,
  });
  expect(observerPreferences(everyday).customObserverPrompt).toBe('');
  expect(everyday.customSystemPrompt).toBe(next.customSystemPrompt);
});

test('rejects empty custom prompts and invalid inputs before saving', () => {
  expect(() =>
    applyAgentPreferences(
      {},
      { scenario: 'custom', hideAvatar: false, customObserverPrompt: '  ' },
    ),
  ).toThrow('Enter an observer prompt');
  expect(() =>
    applyAgentPreferences(
      {},
      {
        scenario: 'custom',
        hideAvatar: false,
        customObserverPrompt: 'x'.repeat(40001),
      },
    ),
  ).toThrow('40,000');
  expect(
    observerPreferences({
      tutorScenario: 'custom',
      customSystemPrompt: 'Existing prompt',
    }).customObserverPrompt,
  ).toBe('Existing prompt');
});
