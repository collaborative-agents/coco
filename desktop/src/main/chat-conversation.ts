import type { StoredConversation } from './conversation-store';

/** Assign a conversation before exposing a blank chat, without starting a session. */
export default function ensureChatConversation(deps: {
  current: () => string | null;
  latest: () => StoredConversation | null | undefined;
  draftId: () => string;
  select: (id: string, saved?: StoredConversation) => void;
}): void {
  if (deps.current()) return;
  const saved = deps.latest();
  deps.select(saved?.sessionId ?? deps.draftId(), saved ?? undefined);
}
