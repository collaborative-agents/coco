import { SocialAvatarNotificationTracker } from './social-avatar-notifications';
import type { SocialInboxSnapshot } from './social-service';

function snapshot(
  overrides: Partial<SocialInboxSnapshot> = {},
): SocialInboxSnapshot {
  return {
    friendships: { friends: [], incoming: [], outgoing: [] },
    knowledgeRequests: { incoming: [], outgoing: [] },
    unreadCount: 0,
    incomingRequestCount: 0,
    incomingKnowledgeRequestCount: 0,
    unreadKnowledgeAnswerCount: 0,
    updatedAt: '2026-08-28T12:00:00Z',
    ...overrides,
  };
}

describe('SocialAvatarNotificationTracker', () => {
  it('emits a direct-message alert once per new message id', () => {
    const tracker = new SocialAvatarNotificationTracker();
    const inbox = snapshot({
      friendships: {
        incoming: [],
        outgoing: [],
        friends: [
          {
            friendship_id: 'friendship-1',
            participant_id: 'participant-2',
            status: 'accepted',
            created_at: '2026-08-28T11:00:00Z',
            updated_at: '2026-08-28T12:00:00Z',
            unread_count: 1,
            last_message: {
              _id: 'message-1',
              sender_id: 'participant-2',
              recipient_id: 'participant-1',
              content: 'Hello',
              created_at: '2026-08-28T12:00:00Z',
            },
          },
        ],
      },
      unreadCount: 1,
    });

    expect(tracker.next(inbox)).toEqual(
      expect.objectContaining({
        kind: 'direct-message',
        participantId: 'participant-2',
      }),
    );
    expect(tracker.next(inbox)).toBeNull();

    inbox.friendships.friends[0].last_message = {
      ...inbox.friendships.friends[0].last_message!,
      _id: 'message-2',
    };
    expect(tracker.next(inbox)?.kind).toBe('direct-message');
  });

  it('combines simultaneous social changes into one alert', () => {
    const tracker = new SocialAvatarNotificationTracker();
    const inbox = snapshot({
      friendships: {
        friends: [],
        outgoing: [],
        incoming: [
          {
            friendship_id: 'friendship-2',
            participant_id: 'participant-2',
            status: 'pending',
            direction: 'incoming',
            created_at: '2026-08-28T12:00:00Z',
            updated_at: '2026-08-28T12:00:00Z',
          },
        ],
      },
      knowledgeRequests: {
        outgoing: [],
        incoming: [
          {
            _id: 'knowledge-1',
            requester_id: 'participant-3',
            owner_id: 'participant-1',
            question: 'What works?',
            status: 'pending',
            created_at: '2026-08-28T12:00:00Z',
            updated_at: '2026-08-28T12:00:00Z',
          },
        ],
      },
    });

    expect(tracker.next(inbox)).toEqual({
      kind: 'summary',
      title: 'New from Friends',
      message: 'You have 2 new messages and requests.',
      count: 2,
    });
  });

  it('does not replay an item after it has been read', () => {
    const tracker = new SocialAvatarNotificationTracker();
    const answered = snapshot({
      knowledgeRequests: {
        incoming: [],
        outgoing: [
          {
            _id: 'knowledge-2',
            requester_id: 'participant-1',
            owner_id: 'participant-2',
            question: 'What works?',
            status: 'answered',
            answer: 'This does.',
            answer_read_at: null,
            answered_at: '2026-08-28T12:00:00Z',
            created_at: '2026-08-28T11:00:00Z',
            updated_at: '2026-08-28T12:00:00Z',
          },
        ],
      },
    });

    expect(tracker.next(answered)?.kind).toBe('knowledge-answer');
    answered.knowledgeRequests.outgoing[0].answer_read_at =
      '2026-08-28T12:01:00Z';
    expect(tracker.next(answered)).toBeNull();
  });
});
