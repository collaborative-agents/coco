export type ChatRequestKind = 'chat' | 'practice_suggestions';

/**
 * Opening the chat panel is not a learning session. A user-initiated session
 * begins only when the user submits at least one non-whitespace character in a
 * regular chat turn. Proactive-session acceptance is handled separately.
 */
export function shouldStartSessionFromUserMessage(
  userText: string,
  requestKind: ChatRequestKind,
): boolean {
  return requestKind === 'chat' && userText.trim().length > 0;
}
