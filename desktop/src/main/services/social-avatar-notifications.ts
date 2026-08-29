/* eslint no-underscore-dangle: off */
import type { SocialInboxSnapshot } from './social-service';

export type SocialAvatarNotificationKind =
  | 'direct-message'
  | 'friend-request'
  | 'knowledge-request'
  | 'knowledge-answer'
  | 'group-message'
  | 'group-invitation'
  | 'admin-announcement'
  | 'summary';

export interface SocialAvatarNotification {
  kind: SocialAvatarNotificationKind;
  title: string;
  message: string;
  participantId?: string;
  count: number;
}

interface NotificationCandidate extends SocialAvatarNotification {
  key: string;
  timestamp: string;
}

/**
 * Converts successive social inbox snapshots into one-shot avatar alerts.
 * Stable item IDs prevent the five-second inbox poll from replaying alerts.
 */
export class SocialAvatarNotificationTracker {
  private knownKeys = new Set<string>();

  next(snapshot: SocialInboxSnapshot): SocialAvatarNotification | null {
    const candidates = SocialAvatarNotificationTracker.candidates(snapshot);
    const currentKeys = new Set(candidates.map((candidate) => candidate.key));
    const fresh = candidates.filter(
      (candidate) => !this.knownKeys.has(candidate.key),
    );
    this.knownKeys = currentKeys;

    if (fresh.length === 0) return null;
    if (fresh.length > 1) {
      return {
        kind: 'summary',
        title: 'New in Social',
        message: `You have ${fresh.length} new messages and requests.`,
        count: fresh.length,
      };
    }

    const notification = fresh[0];
    return {
      kind: notification.kind,
      title: notification.title,
      message: notification.message,
      participantId: notification.participantId,
      count: notification.count,
    };
  }

  private static candidates(
    snapshot: SocialInboxSnapshot,
  ): NotificationCandidate[] {
    const directMessages = snapshot.friendships.friends.flatMap((friend) => {
      if (!friend.unread_count || !friend.last_message) return [];
      return [
        {
          key: `direct-message:${friend.last_message._id}`,
          kind: 'direct-message' as const,
          title: 'New message',
          message: `${friend.participant_id} sent you a message.`,
          participantId: friend.participant_id,
          count: 1,
          timestamp: friend.last_message.created_at,
        },
      ];
    });
    const friendRequests = snapshot.friendships.incoming.map((request) => ({
      key: `friend-request:${request.friendship_id}`,
      kind: 'friend-request' as const,
      title: 'Friend request',
      message: `${request.participant_id} wants to add you as a friend.`,
      participantId: request.participant_id,
      count: 1,
      timestamp: request.created_at,
    }));
    const knowledgeRequests = snapshot.knowledgeRequests.incoming
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        key: `knowledge-request:${request._id}`,
        kind: 'knowledge-request' as const,
        title: 'Coco memory request',
        message: `${request.requester_id} asked Coco to use your memory.`,
        participantId: request.requester_id,
        count: 1,
        timestamp: request.created_at,
      }));
    const knowledgeAnswers = snapshot.knowledgeRequests.outgoing
      .filter(
        (request) => request.status === 'answered' && !request.answer_read_at,
      )
      .map((request) => ({
        key: `knowledge-answer:${request._id}`,
        kind: 'knowledge-answer' as const,
        title: 'Coco replied',
        message: `${request.owner_id}’s Coco answered your question.`,
        participantId: request.owner_id,
        count: 1,
        timestamp: request.answered_at || request.updated_at,
      }));
    const groupMessages = (snapshot.groupInbox?.groups || []).flatMap(
      (group) => {
        if (!group.unread_count || !group.last_message || group.muted)
          return [];
        return [
          {
            key: `group-message:${group.last_message._id}`,
            kind: 'group-message' as const,
            title: group.name,
            message: `${group.unread_count} new group ${group.unread_count === 1 ? 'message' : 'messages'}.`,
            count: group.unread_count,
            timestamp: group.last_message.created_at,
          },
        ];
      },
    );
    const groupInvitations = (snapshot.groupInbox?.invitations || []).map(
      (invitation) => ({
        key: `group-invitation:${invitation.invitation_id}`,
        kind: 'group-invitation' as const,
        title: 'Group invitation',
        message: `The study team invited you to ${invitation.group_name}.`,
        count: 1,
        timestamp: invitation.created_at,
      }),
    );
    const announcements = (snapshot.groupInbox?.announcements || [])
      .filter((announcement) => !announcement.read_at)
      .map((announcement) => ({
        key: `admin-announcement:${announcement._id}`,
        kind: 'admin-announcement' as const,
        title: announcement.title,
        message: 'New announcement from the study team.',
        count: 1,
        timestamp: announcement.created_at,
      }));

    return [
      ...directMessages,
      ...friendRequests,
      ...knowledgeRequests,
      ...knowledgeAnswers,
      ...groupMessages,
      ...groupInvitations,
      ...announcements,
    ].sort(
      (left, right) =>
        new Date(right.timestamp).getTime() -
        new Date(left.timestamp).getTime(),
    );
  }
}
