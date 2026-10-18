import {
  shouldStartSessionFromUserMessage,
} from '../main/services/session-start-policy';

describe('shouldStartSessionFromUserMessage', () => {
  it('starts a regular chat session for one non-whitespace character', () => {
    expect(shouldStartSessionFromUserMessage('a', 'chat')).toBe(true);
  });

  it('does not start a session for empty or whitespace-only text', () => {
    expect(shouldStartSessionFromUserMessage('', 'chat')).toBe(false);
    expect(shouldStartSessionFromUserMessage('   \n', 'chat')).toBe(false);
  });

  it('does not treat practice-suggestion generation as a user message', () => {
    expect(
      shouldStartSessionFromUserMessage(
        'generate suggestions',
        'practice_suggestions',
      ),
    ).toBe(false);
  });
});
