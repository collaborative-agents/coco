import React, {
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

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

interface KnowledgeRequest {
  _id: string;
  requester_id: string;
  owner_id: string;
  question: string;
  status: 'pending' | 'answered' | 'declined';
  created_at: string;
  updated_at: string;
  answer?: string | null;
  answered_at?: string | null;
  answer_read_at?: string | null;
  declined_at?: string | null;
}

type ConversationTimelineItem =
  | { kind: 'message'; timestamp: string; message: DirectMessage }
  | {
      kind: 'knowledge-request';
      timestamp: string;
      request: KnowledgeRequest;
    }
  | {
      kind: 'knowledge-answer';
      timestamp: string;
      request: KnowledgeRequest;
    };

interface KnowledgeRequestList {
  incoming: KnowledgeRequest[];
  outgoing: KnowledgeRequest[];
}

interface SocialInboxSnapshot {
  friendships: FriendshipList;
  knowledgeRequests: KnowledgeRequestList;
  unreadCount: number;
  incomingRequestCount: number;
  incomingKnowledgeRequestCount: number;
  unreadKnowledgeAnswerCount: number;
  updatedAt: string;
}

const EMPTY_FRIENDSHIPS: FriendshipList = {
  friends: [],
  incoming: [],
  outgoing: [],
};
const EMPTY_KNOWLEDGE_REQUESTS: KnowledgeRequestList = {
  incoming: [],
  outgoing: [],
};
const ACCENT = '#204A79';
const ACCENT_BG = '#E9EFFF';
const BORDER = '#e5e7eb';
const FONT =
  "'PT Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'absolute',
    inset: 0,
    zIndex: 10,
    display: 'flex',
    flexDirection: 'column',
    background: '#fff',
    fontFamily: FONT,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 14px',
    borderBottom: `1px solid ${BORDER}`,
  },
  title: { color: '#374151', fontSize: 14, fontWeight: 700 },
  back: {
    marginLeft: 'auto',
    border: 'none',
    background: 'transparent',
    color: ACCENT,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    fontFamily: FONT,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
  addForm: { display: 'flex', gap: 7, marginBottom: 14 },
  input: {
    flex: 1,
    minWidth: 0,
    border: `1px solid ${BORDER}`,
    borderRadius: 9,
    padding: '8px 10px',
    color: '#111827',
    fontFamily: FONT,
    fontSize: 12.5,
  },
  primaryButton: {
    border: 'none',
    borderRadius: 9,
    padding: '7px 11px',
    background: ACCENT,
    color: '#fff',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 12,
    fontWeight: 700,
  },
  secondaryButton: {
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    padding: '5px 9px',
    background: '#fff',
    color: '#4b5563',
    cursor: 'pointer',
    fontFamily: FONT,
    fontSize: 11.5,
    fontWeight: 700,
  },
  sectionTitle: {
    margin: '13px 2px 6px',
    color: '#6b7280',
    fontSize: 10.5,
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
    borderRadius: 10,
    padding: '9px 10px',
    background: '#fff',
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
    fontSize: 13,
  },
  cardText: { flex: 1, minWidth: 0 },
  participant: {
    display: 'block',
    color: '#374151',
    fontSize: 12.5,
    fontWeight: 700,
  },
  preview: {
    display: 'block',
    marginTop: 2,
    overflow: 'hidden',
    color: '#9ca3af',
    fontSize: 11,
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  badge: {
    minWidth: 18,
    height: 18,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    padding: '0 5px',
    background: ACCENT,
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
  },
  actions: { display: 'flex', gap: 5 },
  question: {
    color: '#374151',
    fontSize: 12.5,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  knowledgePanel: {
    borderBottom: `1px solid ${BORDER}`,
    padding: 10,
    background: '#f8fafc',
  },
  knowledgeTimelineCard: {
    width: 'auto',
    maxWidth: '82%',
    boxSizing: 'border-box',
    border: '1px solid #bfdbfe',
    borderLeft: `4px solid ${ACCENT}`,
    borderRadius: 11,
    padding: '10px 11px',
    background: '#eff6ff',
    boxShadow: '0 1px 2px rgba(32, 74, 121, 0.08)',
  },
  knowledgeTimelineHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 6,
  },
  knowledgeLabel: {
    color: ACCENT,
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: '0.02em',
  },
  knowledgeStatus: {
    borderRadius: 10,
    padding: '2px 7px',
    background: '#dbeafe',
    color: ACCENT,
    fontSize: 9.5,
    fontWeight: 700,
  },
  knowledgeFriendCue: {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 8,
    padding: '2px 6px',
    background: '#dbeafe',
    color: ACCENT,
    fontSize: 9.5,
    fontWeight: 700,
  },
  empty: {
    padding: '18px 8px',
    color: '#9ca3af',
    fontSize: 12,
    textAlign: 'center',
  },
  error: {
    marginBottom: 9,
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '7px 9px',
    background: '#fef2f2',
    color: '#b91c1c',
    fontSize: 11.5,
  },
  success: {
    marginBottom: 9,
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: '7px 9px',
    background: '#f0fdf4',
    color: '#15803d',
    fontSize: 11.5,
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
    color: '#fff',
    fontSize: 12.5,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  friendBubble: {
    borderRadius: '4px 14px 14px 14px',
    padding: '8px 11px',
    background: '#f3f4f6',
    color: '#374151',
    fontSize: 12.5,
    lineHeight: 1.4,
    overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap',
  },
  timestamp: { marginTop: 2, color: '#9ca3af', fontSize: 9.5 },
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
    borderRadius: 10,
    padding: '8px 10px',
    color: '#111827',
    fontFamily: FONT,
    fontSize: 12.5,
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function participantInitial(participantId: string): string {
  return participantId.trim().charAt(0).toUpperCase() || '?';
}

function messageTime(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? ''
    : timestamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function knowledgeRequestId(request: KnowledgeRequest): string {
  // Mongo-compatible API payloads use `_id` consistently.
  // eslint-disable-next-line no-underscore-dangle
  return request._id;
}

function sameParticipant(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
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
    const cleanup = window.electron?.ipcRenderer.on(
      'social-inbox-updated',
      (value) => {
        const snapshot = value as SocialInboxSnapshot | undefined;
        if (!snapshot) return;
        setAttentionCount(
          snapshot.unreadCount +
            snapshot.incomingRequestCount +
            (snapshot.incomingKnowledgeRequestCount || 0) +
            (snapshot.unreadKnowledgeAnswerCount || 0),
        );
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, []);

  const countLabel = attentionCount > 99 ? '99+' : String(attentionCount);
  const title = attentionCount
    ? `Friends and messages (${attentionCount} new)`
    : 'Friends and messages';
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
      ♡
      {attentionCount > 0 && (
        <span
          style={{
            position: 'absolute',
            top: -4,
            right: -5,
            minWidth: 14,
            height: 14,
            boxSizing: 'border-box',
            borderRadius: 7,
            padding: '0 3px',
            background: '#dc2626',
            color: '#fff',
            fontSize: 8.5,
            fontWeight: 700,
            lineHeight: '14px',
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
  const [knowledgeRequests, setKnowledgeRequests] = useState(
    EMPTY_KNOWLEDGE_REQUESTS,
  );
  const [selectedFriend, setSelectedFriend] =
    useState<FriendshipSummary | null>(null);
  const [messages, setMessages] = useState<DirectMessage[]>([]);
  const [participantId, setParticipantId] = useState('');
  const [draft, setDraft] = useState('');
  const [showKnowledgeQuestion, setShowKnowledgeQuestion] = useState(false);
  const [knowledgeQuestion, setKnowledgeQuestion] = useState('');
  const [draftingKnowledgeId, setDraftingKnowledgeId] = useState('');
  const [editingKnowledgeId, setEditingKnowledgeId] = useState('');
  const [knowledgeAnswerDraft, setKnowledgeAnswerDraft] = useState('');
  const [knowledgeSendingId, setKnowledgeSendingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const messageListRef = useRef<HTMLDivElement>(null);

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
      setMessages(page?.messages || []);
      await window.electron?.ipcRenderer.invoke(
        'social-mark-read',
        friend.participant_id,
      );
      setError('');
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  const loadKnowledgeRequests = useCallback(async () => {
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'social-list-knowledge-requests',
      )) as KnowledgeRequestList;
      setKnowledgeRequests(result || EMPTY_KNOWLEDGE_REQUESTS);
      setError('');
    } catch (loadError) {
      setError(errorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    loadFriendships(true);
    loadKnowledgeRequests();
  }, [loadFriendships, loadKnowledgeRequests]);

  useEffect(() => {
    const cleanup = window.electron?.ipcRenderer.on(
      'social-inbox-updated',
      (value) => {
        const snapshot = value as SocialInboxSnapshot | undefined;
        if (!snapshot) return;
        setFriendships(snapshot.friendships);
        setKnowledgeRequests(
          snapshot.knowledgeRequests || EMPTY_KNOWLEDGE_REQUESTS,
        );
        if (selectedFriend) loadMessages(selectedFriend);
      },
    );
    return () => {
      if (typeof cleanup === 'function') cleanup();
    };
  }, [loadMessages, selectedFriend]);

  useEffect(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (!selectedFriend) return;
    knowledgeRequests.outgoing
      .filter(
        (request) =>
          request.status === 'answered' &&
          !request.answer_read_at &&
          sameParticipant(request.owner_id, selectedFriend.participant_id),
      )
      .forEach((request) => {
        window.electron?.ipcRenderer
          .invoke(
            'social-mark-knowledge-answer-read',
            knowledgeRequestId(request),
          )
          .then(() => {
            const readAt = new Date().toISOString();
            setKnowledgeRequests((current) => ({
              ...current,
              outgoing: current.outgoing.map((item) =>
                knowledgeRequestId(item) === knowledgeRequestId(request)
                  ? { ...item, answer_read_at: readAt }
                  : item,
              ),
            }));
            return undefined;
          })
          .catch(() => undefined);
      });
  }, [knowledgeRequests.outgoing, selectedFriend]);

  const openConversation = async (friend: FriendshipSummary) => {
    setSelectedFriend(friend);
    setMessages([]);
    await loadMessages(friend);
    await loadFriendships();
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

  const submitKnowledgeQuestion = async (event: FormEvent) => {
    event.preventDefault();
    const question = knowledgeQuestion.trim();
    if (!selectedFriend || !question || knowledgeSendingId) return;
    setKnowledgeSendingId('question');
    setError('');
    setNotice('');
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-request-knowledge',
        selectedFriend.participant_id,
        question,
      );
      setKnowledgeQuestion('');
      setShowKnowledgeQuestion(false);
      setNotice(
        `Question sent to ${selectedFriend.participant_id} for approval.`,
      );
      await loadKnowledgeRequests();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setKnowledgeSendingId('');
    }
  };

  const draftKnowledgeAnswer = async (request: KnowledgeRequest) => {
    const requestId = knowledgeRequestId(request);
    setDraftingKnowledgeId(requestId);
    setError('');
    setNotice('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'social-draft-knowledge-answer',
        request.question,
      )) as { answer?: string } | undefined;
      if (!result?.answer?.trim()) {
        throw new Error('The tutor returned no answer.');
      }
      setEditingKnowledgeId(requestId);
      setKnowledgeAnswerDraft(result.answer);
    } catch (draftError) {
      setError(errorMessage(draftError));
    } finally {
      setDraftingKnowledgeId('');
    }
  };

  const sendKnowledgeAnswer = async (request: KnowledgeRequest) => {
    const requestId = knowledgeRequestId(request);
    if (!knowledgeAnswerDraft.trim() || knowledgeSendingId) return;
    setKnowledgeSendingId(requestId);
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-answer-knowledge-request',
        requestId,
        knowledgeAnswerDraft,
      );
      setEditingKnowledgeId('');
      setKnowledgeAnswerDraft('');
      setNotice('Your edited answer was sent.');
      await loadKnowledgeRequests();
    } catch (sendError) {
      setError(errorMessage(sendError));
    } finally {
      setKnowledgeSendingId('');
    }
  };

  const declineKnowledgeRequest = async (request: KnowledgeRequest) => {
    const requestId = knowledgeRequestId(request);
    setKnowledgeSendingId(requestId);
    setError('');
    try {
      await window.electron?.ipcRenderer.invoke(
        'social-decline-knowledge-request',
        requestId,
      );
      if (editingKnowledgeId === requestId) {
        setEditingKnowledgeId('');
        setKnowledgeAnswerDraft('');
      }
      setNotice('The question was declined without sharing an answer.');
      await loadKnowledgeRequests();
    } catch (declineError) {
      setError(errorMessage(declineError));
    } finally {
      setKnowledgeSendingId('');
    }
  };

  if (selectedFriend) {
    const normalizedFriendId = selectedFriend.participant_id.toLowerCase();
    const conversationKnowledgeRequests = [
      ...knowledgeRequests.incoming.filter((request) =>
        sameParticipant(request.requester_id, selectedFriend.participant_id),
      ),
      ...knowledgeRequests.outgoing.filter((request) =>
        sameParticipant(request.owner_id, selectedFriend.participant_id),
      ),
    ];
    const timelineItems: ConversationTimelineItem[] = [
      ...messages.map((message) => ({
        kind: 'message' as const,
        timestamp: message.created_at,
        message,
      })),
      ...conversationKnowledgeRequests.flatMap((request) => [
        {
          kind: 'knowledge-request' as const,
          timestamp: request.created_at,
          request,
        },
        ...(request.status === 'answered' && request.answer
          ? [
              {
                kind: 'knowledge-answer' as const,
                timestamp: request.answered_at || request.updated_at,
                request,
              },
            ]
          : []),
      ]),
    ].sort(
      (first, second) =>
        new Date(first.timestamp).getTime() -
        new Date(second.timestamp).getTime(),
    );
    return (
      <div style={styles.root}>
        <div style={styles.header}>
          <span style={styles.title}>{selectedFriend.participant_id}</span>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => setShowKnowledgeQuestion((visible) => !visible)}
          >
            Ask their Coco
          </button>
          <button
            type="button"
            style={styles.back}
            onClick={() => setSelectedFriend(null)}
          >
            Back to friends
          </button>
        </div>
        {error && <div style={{ ...styles.error, margin: 10 }}>{error}</div>}
        {notice && (
          <div style={{ ...styles.success, margin: 10 }}>{notice}</div>
        )}
        <div style={styles.conversation}>
          {showKnowledgeQuestion && (
            <form
              style={styles.knowledgePanel}
              onSubmit={submitKnowledgeQuestion}
            >
              <div style={{ ...styles.preview, marginBottom: 7 }}>
                They must approve before Coco uses their private memory.
              </div>
              <textarea
                aria-label={`Question for ${selectedFriend.participant_id}'s Coco`}
                style={{
                  ...styles.textarea,
                  width: '100%',
                  boxSizing: 'border-box',
                }}
                maxLength={1_000}
                placeholder="What would you like to ask?"
                value={knowledgeQuestion}
                onChange={(event) => setKnowledgeQuestion(event.target.value)}
              />
              <div
                style={{
                  ...styles.actions,
                  marginTop: 7,
                  justifyContent: 'flex-end',
                }}
              >
                <button
                  type="button"
                  style={styles.secondaryButton}
                  onClick={() => {
                    setShowKnowledgeQuestion(false);
                    setKnowledgeQuestion('');
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={styles.primaryButton}
                  disabled={
                    !knowledgeQuestion.trim() || Boolean(knowledgeSendingId)
                  }
                >
                  {knowledgeSendingId === 'question'
                    ? 'Sending…'
                    : 'Request answer'}
                </button>
              </div>
            </form>
          )}
          <div style={styles.messageList} ref={messageListRef}>
            {timelineItems.length === 0 && (
              <div style={styles.empty}>No messages yet. Say hello.</div>
            )}
            {timelineItems.map((item) => {
              if (item.kind === 'knowledge-answer') {
                const { request } = item;
                const isIncoming = sameParticipant(
                  request.requester_id,
                  selectedFriend.participant_id,
                );
                const answerFromFriend = !isIncoming;
                return (
                  <div
                    key={`${knowledgeRequestId(request)}:answer`}
                    data-message-kind="knowledge-answer"
                    data-message-owner={answerFromFriend ? 'friend' : 'self'}
                    style={
                      answerFromFriend
                        ? styles.friendMessage
                        : styles.ownMessage
                    }
                  >
                    <div
                      style={
                        answerFromFriend
                          ? styles.friendBubble
                          : styles.ownBubble
                      }
                    >
                      <div
                        style={{
                          marginBottom: 4,
                          fontSize: 10.5,
                          fontWeight: 700,
                          opacity: 0.82,
                        }}
                      >
                        ✦ Approved Coco reply
                      </div>
                      {request.answer}
                    </div>
                    <div
                      style={{
                        ...styles.timestamp,
                        textAlign: answerFromFriend ? 'left' : 'right',
                      }}
                    >
                      {messageTime(request.answered_at || request.updated_at)}
                    </div>
                  </div>
                );
              }

              if (item.kind === 'knowledge-request') {
                const { request } = item;
                const requestId = knowledgeRequestId(request);
                const isIncoming = sameParticipant(
                  request.requester_id,
                  selectedFriend.participant_id,
                );
                const isEditing = editingKnowledgeId === requestId;
                const isDrafting = draftingKnowledgeId === requestId;
                const isSending = knowledgeSendingId === requestId;
                let status = 'Waiting for approval';
                if (request.status === 'answered') {
                  status = isIncoming ? 'Answer sent' : 'Coco replied';
                } else if (request.status === 'declined') {
                  status = isIncoming ? 'You declined' : 'Declined';
                } else if (isIncoming) {
                  status = 'Needs your approval';
                }
                return (
                  <div
                    key={`${requestId}:request`}
                    data-message-kind="knowledge-request"
                    data-message-owner={isIncoming ? 'friend' : 'self'}
                    style={{
                      ...styles.knowledgeTimelineCard,
                      alignSelf: isIncoming ? 'flex-start' : 'flex-end',
                    }}
                  >
                    <div style={styles.knowledgeTimelineHeader}>
                      <span style={styles.knowledgeLabel}>
                        ✦ Coco memory request
                      </span>
                      <span style={styles.knowledgeStatus}>{status}</span>
                    </div>
                    <div style={styles.question}>{request.question}</div>

                    {request.status === 'pending' &&
                      isIncoming &&
                      !isEditing && (
                        <>
                          <div
                            style={{
                              ...styles.preview,
                              marginTop: 6,
                              whiteSpace: 'normal',
                            }}
                          >
                            Approve to let Coco retrieve relevant memory for a
                            draft. Nothing is shared until you review and send
                            it.
                          </div>
                          <div style={{ ...styles.actions, marginTop: 8 }}>
                            <button
                              type="button"
                              style={styles.primaryButton}
                              disabled={isDrafting || isSending}
                              onClick={() => draftKnowledgeAnswer(request)}
                            >
                              {isDrafting ? 'Drafting…' : 'Approve & draft'}
                            </button>
                            <button
                              type="button"
                              style={styles.secondaryButton}
                              disabled={isDrafting || isSending}
                              onClick={() => declineKnowledgeRequest(request)}
                            >
                              {isSending ? 'Declining…' : 'Decline'}
                            </button>
                          </div>
                        </>
                      )}

                    {request.status === 'pending' &&
                      isIncoming &&
                      isEditing && (
                        <>
                          <textarea
                            aria-label={`Answer to ${request.requester_id}`}
                            style={{
                              ...styles.textarea,
                              width: '100%',
                              boxSizing: 'border-box',
                              marginTop: 8,
                            }}
                            maxLength={4_000}
                            value={knowledgeAnswerDraft}
                            onChange={(event) =>
                              setKnowledgeAnswerDraft(event.target.value)
                            }
                          />
                          <div
                            style={{
                              ...styles.preview,
                              marginTop: 5,
                              whiteSpace: 'normal',
                            }}
                          >
                            Review and edit this draft. Only the answer you send
                            is shared.
                          </div>
                          <div style={{ ...styles.actions, marginTop: 8 }}>
                            <button
                              type="button"
                              style={styles.primaryButton}
                              disabled={
                                !knowledgeAnswerDraft.trim() || isSending
                              }
                              onClick={() => sendKnowledgeAnswer(request)}
                            >
                              {isSending ? 'Sending…' : 'Send answer'}
                            </button>
                            <button
                              type="button"
                              style={styles.secondaryButton}
                              disabled={isSending}
                              onClick={() => {
                                setEditingKnowledgeId('');
                                setKnowledgeAnswerDraft('');
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              style={styles.secondaryButton}
                              disabled={isSending}
                              onClick={() => declineKnowledgeRequest(request)}
                            >
                              Decline
                            </button>
                          </div>
                        </>
                      )}

                    {request.status === 'pending' && !isIncoming && (
                      <div style={{ ...styles.preview, marginTop: 6 }}>
                        Your friend will decide whether Coco may use their
                        memory.
                      </div>
                    )}

                    {request.status === 'declined' && (
                      <div style={{ ...styles.preview, marginTop: 6 }}>
                        No memory or answer was shared.
                      </div>
                    )}
                    <div style={{ ...styles.timestamp, textAlign: 'right' }}>
                      {messageTime(request.created_at)}
                    </div>
                  </div>
                );
              }

              const { message } = item;
              const fromFriend = message.sender_id === normalizedFriendId;
              return (
                <div
                  key={directMessageId(message)}
                  style={fromFriend ? styles.friendMessage : styles.ownMessage}
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
          <form style={styles.composer} onSubmit={sendMessage}>
            <textarea
              aria-label={`Message ${selectedFriend.participant_id}`}
              style={styles.textarea}
              maxLength={4_000}
              placeholder="Write a message…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              style={{
                ...styles.primaryButton,
                ...(!draft.trim() || sending
                  ? { opacity: 0.45, cursor: 'default' }
                  : {}),
              }}
              disabled={!draft.trim() || sending}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>Friends</span>
        <button type="button" style={styles.back} onClick={onClose}>
          Back to Coco
        </button>
      </div>
      <div style={styles.body}>
        <form style={styles.addForm} onSubmit={submitFriendRequest}>
          <input
            aria-label="Friend participant ID"
            style={styles.input}
            placeholder="Add by participant ID"
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
        {error && <div style={styles.error}>{error}</div>}
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
                Add a study participant to start messaging.
              </div>
            ) : (
              friendships.friends.map((friend) => {
                const incomingKnowledgeRequests =
                  knowledgeRequests.incoming.filter((request) =>
                    sameParticipant(
                      request.requester_id,
                      friend.participant_id,
                    ),
                  );
                const outgoingKnowledgeRequests =
                  knowledgeRequests.outgoing.filter((request) =>
                    sameParticipant(request.owner_id, friend.participant_id),
                  );
                const pendingKnowledgeRequests =
                  incomingKnowledgeRequests.filter(
                    (request) => request.status === 'pending',
                  );
                const unreadKnowledgeAnswers = outgoingKnowledgeRequests.filter(
                  (request) =>
                    request.status === 'answered' && !request.answer_read_at,
                );
                const latestKnowledgeRequest = [
                  ...incomingKnowledgeRequests,
                  ...outgoingKnowledgeRequests,
                ].sort(
                  (first, second) =>
                    new Date(second.updated_at).getTime() -
                    new Date(first.updated_at).getTime(),
                )[0];
                const knowledgeAttention =
                  pendingKnowledgeRequests.length +
                  unreadKnowledgeAnswers.length;
                const totalAttention =
                  (friend.unread_count || 0) + knowledgeAttention;
                let preview = friend.last_message?.content || 'No messages yet';
                let showKnowledgeCue = false;
                if (pendingKnowledgeRequests[0]) {
                  preview = `Coco request: ${pendingKnowledgeRequests[0].question}`;
                  showKnowledgeCue = true;
                } else if (unreadKnowledgeAnswers[0]) {
                  preview = `New Coco reply: ${unreadKnowledgeAnswers[0].question}`;
                  showKnowledgeCue = true;
                } else if (
                  latestKnowledgeRequest &&
                  (!friend.last_message ||
                    new Date(latestKnowledgeRequest.updated_at).getTime() >=
                      new Date(friend.last_message.created_at).getTime())
                ) {
                  preview = `Coco ${latestKnowledgeRequest.status}: ${latestKnowledgeRequest.question}`;
                  showKnowledgeCue = true;
                }
                return (
                  <button
                    key={friend.friendship_id}
                    type="button"
                    style={{
                      ...styles.card,
                      ...styles.friendButton,
                      ...(showKnowledgeCue
                        ? { borderColor: '#bfdbfe', background: '#f8fbff' }
                        : {}),
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
                    {showKnowledgeCue && (
                      <span style={styles.knowledgeFriendCue}>✦ Coco</span>
                    )}
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
