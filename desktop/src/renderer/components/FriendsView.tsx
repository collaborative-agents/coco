import React, {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import SocialMessageComposer from './SocialMessageComposer';
import { formatSocialTime, socialTimestampMs } from './social-time';

interface DirectMessage {
  _id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  created_at: string;
  read_at?: string | null;
}

interface FriendshipSummary {
  friendship_id: string;
  participant_id: string;
  status: 'pending' | 'accepted';
  direction?: 'incoming' | 'outgoing';
  created_at: string;
  updated_at: string;
  unread_count?: number;
  last_message?: DirectMessage | null;
}

interface FriendshipList {
  friends: FriendshipSummary[];
  incoming: FriendshipSummary[];
  outgoing: FriendshipSummary[];
}

interface DirectMessagePage {
  messages: DirectMessage[];
  next_before?: string | null;
}

const EMPTY_FRIENDSHIPS: FriendshipList = {
  friends: [],
  incoming: [],
  outgoing: [],
};
const ACCENT = 'var(--coco-color-primary)';
const ACCENT_BG = 'var(--coco-color-accent-soft)';
const BORDER = 'var(--coco-color-border)';
const FONT = 'var(--coco-font-family)';

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--coco-color-surface)',
    fontFamily: FONT,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 14px',
    borderBottom: `1px solid ${BORDER}`,
  },
  title: { color: 'var(--coco-color-text-secondary)', fontSize: 'var(--coco-text-section)', fontWeight: 700 },
  back: {
    marginLeft: 'auto',
    border: 'none',
    background: 'transparent',
    color: ACCENT,
    cursor: 'pointer',
    fontSize: 'var(--coco-text-control)',
    fontWeight: 700,
    fontFamily: FONT,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
  addForm: { display: 'flex', gap: 7, marginBottom: 14 },
  input: {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${BORDER}`,
    borderRadius: 'var(--coco-radius-control)',
    padding: '8px 10px',
    color: 'var(--coco-color-text)',
    fontFamily: FONT,
    fontSize: 'var(--coco-text-control)',
  },
  primaryButton: {
    border: 'none',
    borderRadius: 'var(--coco-radius-control)',
    padding: '7px 11px',
    background: ACCENT,
    color: 'var(--coco-color-surface)',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 'var(--coco-text-control)',
    fontWeight: 700,
  },
  secondaryButton: {
    border: `1px solid ${BORDER}`,
    borderRadius: 'var(--coco-radius-control)',
    padding: '5px 9px',
    background: 'var(--coco-color-surface)',
    color: 'var(--coco-color-text-secondary)',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 'var(--coco-text-control)',
    fontWeight: 700,
  },
  sectionTitle: {
    margin: '13px 2px 6px',
    color: 'var(--coco-color-text-muted)',
    fontSize: 'var(--coco-text-caption)',
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  card: {
    width: '100%',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    marginBottom: 6,
    border: `1px solid ${BORDER}`,
    borderRadius: 'var(--coco-radius-control)',
    padding: '9px 10px',
    background: 'var(--coco-color-surface)',
    textAlign: 'left',
    fontFamily: FONT,
  },
  friendButton: { cursor: 'pointer' },
  avatar: {
    width: 30,
    height: 30,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    background: ACCENT_BG,
    color: ACCENT,
    fontWeight: 700,
    fontSize: 'var(--coco-text-secondary)',
  },
  cardText: { flex: 1, minWidth: 0 },
  participant: {
    display: 'block',
    color: 'var(--coco-color-text-secondary)',
    fontSize: 'var(--coco-text-body)',
    fontWeight: 700,
  },
  preview: {
    display: 'block',
    marginTop: 2,
    overflow: 'hidden',
    color: 'var(--coco-color-text-subtle)',
    fontSize: 'var(--coco-text-secondary)',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    minWidth: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'var(--coco-radius-control)',
    padding: '0 5px',
    background: ACCENT,
    color: 'var(--coco-color-surface)',
    fontSize: 'var(--coco-text-caption)',
    fontWeight: 700,
  },
  actions: { display: 'flex', gap: 5 },
  empty: {
    padding: '18px 8px',
    color: 'var(--coco-color-text-subtle)',
    fontSize: 'var(--coco-text-body)',
    textAlign: 'center',
  },
  error: {
    marginBottom: 9,
    border: '1px solid var(--coco-color-danger-border)',
    borderRadius: 'var(--coco-radius-control)',
    padding: '7px 9px',
    background: 'var(--coco-color-danger-soft)',
    color: 'var(--coco-color-danger)',
    fontSize: 'var(--coco-text-secondary)',
  },
  success: {
    marginBottom: 9,
    border: '1px solid #bbf7d0',
    borderRadius: 'var(--coco-radius-control)',
    padding: '7px 9px',
    background: '#f0fdf4',
    color: 'var(--coco-color-success)',
    fontSize: 'var(--coco-text-secondary)',
  },
  conversation: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  messageList: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    overflowY: 'auto',
    padding: 12,
  },
  ownMessage: { alignSelf: 'flex-end', maxWidth: '82%' },
  friendMessage: { alignSelf: 'flex-start', maxWidth: '82%' },
  ownBubble: {
    borderRadius: '14px 14px 4px 14px',
    padding: '8px 11px',
    background: ACCENT,
    color: 'var(--coco-color-surface)',
    fontSize: 'var(--coco-text-body)',
    lineHeight: 'var(--coco-leading-body)',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  friendBubble: {
    borderRadius: '4px 14px 14px 14px',
    padding: '8px 11px',
    background: 'var(--coco-color-surface-muted)',
    color: 'var(--coco-color-text-secondary)',
    fontSize: 'var(--coco-text-body)',
    lineHeight: 'var(--coco-leading-body)',
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  timestamp: { marginTop: 2, color: 'var(--coco-color-text-subtle)', fontSize: 'var(--coco-text-caption)' },
  composer: {
    display: 'flex',
    alignItems: 'flex-end',
    gap: 7,
    borderTop: `1px solid ${BORDER}`,
    padding: 10,
  },
  textarea: {
    flex: 1,
    minHeight: 38,
    maxHeight: 120,
    resize: 'vertical',
    border: `1px solid ${BORDER}`,
    borderRadius: 'var(--coco-radius-control)',
    padding: '8px 10px',
    color: 'var(--coco-color-text)',
    fontFamily: FONT,
    fontSize: 'var(--coco-text-body)',
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function participantInitial(participantId: string): string {
  return participantId.trim().charAt(0).toUpperCase() || '?';
}

function messageTime(value: string): string {
  return formatSocialTime(value);
}

function directMessageId(message: DirectMessage): string {
  // Mongo-compatible API payloads use `_id` consistently.
  // eslint-disable-next-line no-underscore-dangle
  return message._id;
}

export function FriendsButton({
  active,
  onClick,
  style,
  activeStyle,
}: {
  active: boolean;
  onClick: () => void;
  style: React.CSSProperties;
  activeStyle: React.CSSProperties;
}) {
  const [attentionCount, setAttentionCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const inbox = (await window.electron?.ipcRenderer.invoke(
          'social-list-friendships',
        )) as FriendshipList;
        if (!cancelled && inbox)
          setAttentionCount(
            inbox.incoming.length +
              inbox.friends.reduce(
                (sum, friend) => sum + (friend.unread_count || 0),
                0,
              ),
          );
      } catch {
        /* The opened Friends panel displays connection errors. */
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const countLabel = attentionCount > 99 ? '99+' : String(attentionCount);
  const title = attentionCount
    ? `Social and messages (${attentionCount} new)`
    : 'Social and messages';
  return (
    <button
      type="button"
      style={{
        ...style,
        ...(active ? activeStyle : {}),
        position: 'relative',
      }}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      <svg
        data-header-icon="social"
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        style={{ display: 'block', flex: '0 0 15px' }}
      >
        <path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
      </svg>
      {attentionCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -4,
            right: -5,
            minWidth: 20,
            height: 20,
            boxSizing: 'border-box',
            borderRadius: 'var(--coco-radius-control)',
            padding: '0 3px',
            background: '#dc2626',
            color: 'var(--coco-color-surface)',
            fontSize: 'var(--coco-text-caption)',
            fontWeight: 700,
            lineHeight: '20px',
            textAlign: 'center',
          }}
        >
          {countLabel}
        </span>
      )}
    </button>
  );
}

export default function FriendsView({ onClose }: { onClose: () => void }) {
  const [friendships, setFriendships] = useState(EMPTY_FRIENDSHIPS);
  const [selectedFriend, setSelectedFriend] =
    useState<FriendshipSummary | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [participantId, setParticipantId] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const messageListRef = useRef<HTMLDivElement>(null);
  const selectedFriendId = useRef<string | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadedEarlier = useRef(false);
  const preserveScroll = useRef(false);

  const loadFriendships = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'social-list-friendships',
      )) as FriendshipList;
      setFriendships(result || EMPTY_FRIENDSHIPS);
      setError('');
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (friend: FriendshipSummary) => {
    try {
      const page = (await window.electron?.ipcRenderer.invoke(
        'social-list-messages',
        friend.participant_id,
      )) as DirectMessagePage;
      if (selectedFriendId.current !== friend.participant_id) return;
      if (!loadedEarlier.current) setNextBefore(page.next_before || null);
      setMessages((previous) => {
        const merged = [
          ...new Map(
            [...previous, ...(page?.messages || [])].map((message) => [
              message._id,
              message,
            ]),
          ).values(),
        ].sort(
          (a, b) =>
            socialTimestampMs(a.created_at) - socialTimestampMs(b.created_at),
        );
        return JSON.stringify(previous) === JSON.stringify(merged)
          ? previous
          : merged;
      });
      await window.electron?.ipcRenderer.invoke(
        'social-mark-read',
        friend.participant_id,
      );
      if (selectedFriendId.current === friend.participant_id) setError('');
    } catch (loadError) {
      if (selectedFriendId.current === friend.participant_id)
        setError(errorMessage(loadError));
    }
  }, []);

  // The Learn Gateway uses authenticated polling rather than dev/nv's
  // personalization/social background broadcast.
  useEffect(() => {
    let running = false;
    let initial = true;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        await loadFriendships(initial);
        initial = false;
        if (selectedFriend) await loadMessages(selectedFriend);
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadFriendships, loadMessages, selectedFriend]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = preserveScroll.current
        ? 0
        : messageListRef.current.scrollHeight;
      preserveScroll.current = false;
    }
  }, [messages]);

  const openConversation = (friend: FriendshipSummary) => {
    selectedFriendId.current = friend.participant_id;
    setSelectedFriend(friend);
    setMessages([]);
    setNextBefore(null);
    loadedEarlier.current = false;
    setDraft('');
    setNotice('');
  };

  const loadEarlier = async () => {
    if (!selectedFriend || !nextBefore || loadingEarlier) return;
    const friendId = selectedFriend.participant_id;
    setLoadingEarlier(true);
    try {
      const page = (await window.electron.ipcRenderer.invoke(
        'social-list-messages',
        friendId,
        nextBefore,
      )) as DirectMessagePage;
      if (selectedFriendId.current !== friendId) return;
      loadedEarlier.current = true;
      preserveScroll.current = true;
      setNextBefore(page.next_before || null);
      setMessages((previous) => [
        ...new Map(
          [...page.messages, ...previous].map((message) => [
            message._id,
            message,
          ]),
        ).values(),
      ]);
    } catch (loadError) {
      if (selectedFriendId.current === friendId)
        setError(errorMessage(loadError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const submitFriendRequest = async (event: FormEvent) => {
    event.preventDefault();
    const target = participantId.trim();
    if (!target) return;
    setError('');
    setNotice('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'social-request-friend',
        target,
      )) as { direction?: 'incoming' | 'outgoing' } | undefined;
      setParticipantId('');
      setNotice(
        result?.direction === 'incoming'
          ? `${target} already sent you a friend request.`
          : `Friend request sent to ${target}.`,
      );
      await loadFriendships();
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  };

  const respondToRequest = async (
    request: FriendshipSummary,
    action: 'accept' | 'decline',
  ) => {
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        action === 'accept' ? 'social-accept-friend' : 'social-decline-friend',
        request.friendship_id,
      );
      await loadFriendships();
    } catch (responseError) {
      setError(errorMessage(responseError));
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedFriend || !draft.trim() || sending) return;
    setSending(true);
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-send-message',
        selectedFriend.participant_id,
        draft,
      );
      setDraft('');
      await loadMessages(selectedFriend);
      await loadFriendships();
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setSending(false);
    }
  };

  if (selectedFriend) {
    const normalizedFriendId = selectedFriend.participant_id.toLowerCase();
    return (
      <div style={styles.root} aria-label="Friends conversation">
        <div style={styles.header}>
          <span style={styles.title}>{selectedFriend.participant_id}</span>
          <button
            type="button"
            style={styles.back}
            onClick={() => {
              selectedFriendId.current = null;
              setSelectedFriend(null);
            }}
          >
            Back to friends
          </button>
        </div>
        {error && (
          <div role="alert" style={{ ...styles.error, margin: 10 }}>
            {error}
          </div>
        )}
        {notice && (
          <div style={{ ...styles.success, margin: 10 }}>{notice}</div>
        )}
        <div style={styles.conversation}>
          <div style={styles.messageList} ref={messageListRef}>
            {nextBefore && (
              <button
                type="button"
                style={{ ...styles.secondaryButton, alignSelf: 'center' }}
                disabled={loadingEarlier}
                onClick={() => void loadEarlier()}
              >
                {loadingEarlier ? 'Loading…' : 'Load earlier messages'}
              </button>
            )}
            {messages.length === 0 && (
              <div style={styles.empty}>No messages yet. Say hello.</div>
            )}
            {messages.map((message) => {
              const fromFriend = message.sender_id === normalizedFriendId;
              return (
                <div
                  key={directMessageId(message)}
                  data-message-id={directMessageId(message)}
                  style={{
                    ...(fromFriend ? styles.friendMessage : styles.ownMessage),
                    position: 'relative',
                  }}
                >
                  <div
                    style={fromFriend ? styles.friendBubble : styles.ownBubble}
                  >
                    {message.content}
                  </div>
                  <div
                    style={{
                      ...styles.timestamp,
                      textAlign: fromFriend ? 'left' : 'right',
                    }}
                  >
                    {messageTime(message.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
          <SocialMessageComposer
            ariaLabel={`Message ${selectedFriend.participant_id}`}
            placeholder="Write a message…"
            value={draft}
            sending={sending}
            emojiPickerLabel="Add emoji to message"
            onChange={setDraft}
            onSubmit={sendMessage}
          />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Social</span>
        <button type="button" style={styles.back} onClick={onClose}>
          Back to Coco
        </button>
      </div>
      <div style={styles.body}>
        <div style={styles.sectionTitle}>Add a friend</div>
        <form style={styles.addForm} onSubmit={submitFriendRequest}>
          <input
            aria-label="Friend username"
            style={styles.input}
            placeholder="Add by username"
            value={participantId}
            onChange={(event) => setParticipantId(event.target.value)}
          />
          <button
            type="submit"
            style={styles.primaryButton}
            disabled={!participantId.trim()}
          >
            Add
          </button>
        </form>
        {error && (
          <div role="alert" style={styles.error}>
            {error}
          </div>
        )}
        {notice && <div style={styles.success}>{notice}</div>}
        {loading && <div style={styles.empty}>Loading friends…</div>}

        {!loading && friendships.incoming.length > 0 && (
          <>
            <div style={styles.sectionTitle}>Requests</div>
            {friendships.incoming.map((request) => (
              <div key={request.friendship_id} style={styles.card}>
                <span style={styles.avatar}>
                  {participantInitial(request.participant_id)}
                </span>
                <span style={styles.cardText}>
                  <span style={styles.participant}>
                    {request.participant_id}
                  </span>
                  <span style={styles.preview}>Wants to add you</span>
                </span>
                <span style={styles.actions}>
                  <button
                    type="button"
                    style={styles.primaryButton}
                    onClick={() => respondToRequest(request, 'accept')}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    style={styles.secondaryButton}
                    onClick={() => respondToRequest(request, 'decline')}
                  >
                    Decline
                  </button>
                </span>
              </div>
            ))}
          </>
        )}

        {!loading && (
          <>
            <div style={styles.sectionTitle}>Friends</div>
            {friendships.friends.length === 0 ? (
              <div style={styles.empty}>
                Add a friend by username to start messaging.
              </div>
            ) : (
              friendships.friends.map((friend) => {
                const totalAttention = friend.unread_count || 0;
                const preview =
                  friend.last_message?.content || 'No messages yet';
                return (
                  <button
                    key={friend.friendship_id}
                    type="button"
                    style={{
                      ...styles.card,
                      ...styles.friendButton,
                    }}
                    onClick={() => openConversation(friend)}
                  >
                    <span style={styles.avatar}>
                      {participantInitial(friend.participant_id)}
                    </span>
                    <span style={styles.cardText}>
                      <span style={styles.participant}>
                        {friend.participant_id}
                      </span>
                      <span style={styles.preview}>{preview}</span>
                    </span>
                    {totalAttention > 0 && (
                      <span style={styles.badge}>{totalAttention}</span>
                    )}
                  </button>
                );
              })
            )}
          </>
        )}

        {!loading && friendships.outgoing.length > 0 && (
          <>
            <div style={styles.sectionTitle}>Sent requests</div>
            {friendships.outgoing.map((request) => (
              <div key={request.friendship_id} style={styles.card}>
                <span style={styles.avatar}>
                  {participantInitial(request.participant_id)}
                </span>
                <span style={styles.cardText}>
                  <span style={styles.participant}>
                    {request.participant_id}
                  </span>
                  <span style={styles.preview}>Waiting for acceptance</span>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
