import ensureChatConversation from './chat-conversation';
import type { StoredConversation } from './conversation-store';

function setup(saved?: StoredConversation) {
  let current: string | null = null;
  return {
    current: () => current,
    latest: jest.fn(() => saved),
    draftId: jest.fn(() => 'draft'),
    select: jest.fn((id: string) => {
      current = id;
    }),
  };
}

it('initializes the first visible chat even when its window was pre-created', () => {
  const deps = setup();
  ensureChatConversation(deps);
  expect(deps.current()).toBe('draft');
  expect(deps.select).toHaveBeenCalledWith('draft', undefined);
});

it('restores the latest conversation instead of creating a new one', () => {
  const saved: StoredConversation = {
    sessionId: 'saved',
    problem: 'My task',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };
  const deps = setup(saved);
  ensureChatConversation(deps);
  expect(deps.select).toHaveBeenCalledWith('saved', saved);
  expect(deps.draftId).not.toHaveBeenCalled();
});

it('does not reinitialize the conversation when revealing Settings or Tasks again', () => {
  const deps = setup();
  ensureChatConversation(deps);
  ensureChatConversation(deps);
  expect(deps.select).toHaveBeenCalledTimes(1);
  expect(deps.latest).toHaveBeenCalledTimes(1);
});
