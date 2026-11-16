import type { SavedConversation } from './types';

interface Props {
  conversations: SavedConversation[];
  loading: boolean;
  error: boolean;
  selectedId: string | undefined;
  onSelect: (conversation: SavedConversation) => void;
  onRetry: () => void;
  onCurrent: () => void;
}

export default function ConversationSidebar({
  conversations,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
  onCurrent,
}: Props) {
  const history = conversations.filter(
    (conversation) => conversation.messages.length > 0,
  );
  return (
    <section
      className="workspace-history"
      id="conversation-sidebar"
      aria-label="Conversation history"
    >
      <h2>Conversations</h2>
      <button
        type="button"
        className="workspace-current-chat"
        onClick={onCurrent}
      >
        Current conversation
      </button>
      <div className="workspace-history-list">
        {loading && <p role="status">Loading conversations…</p>}
        {!loading && error && (
          <div role="alert">
            <p>Conversation history could not be loaded.</p>
            <button type="button" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
        {!loading && !error && history.length === 0 && (
          <p>Your past conversations will appear here.</p>
        )}
        {!loading &&
          !error &&
          history.map((conversation) => (
            <button
              type="button"
              className="workspace-conversation"
              key={conversation.sessionId}
              aria-current={
                selectedId === conversation.sessionId ? 'true' : undefined
              }
              onClick={() => onSelect(conversation)}
            >
              <strong>
                {conversation.title ||
                  conversation.problem ||
                  'New conversation'}
              </strong>
              {conversation.messages.some((message) => message.isStreaming) && (
                <span>Working…</span>
              )}
              <span>
                {conversation.messages.find((message) => message.text.trim())
                  ?.text ||
                  (conversation.messages.some(
                    (message) => message.images?.length,
                  )
                    ? 'Screenshot'
                    : 'Working…')}
              </span>
              <time dateTime={new Date(conversation.updatedAt).toISOString()}>
                {new Date(conversation.updatedAt).toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })}
              </time>
            </button>
          ))}
      </div>
    </section>
  );
}
