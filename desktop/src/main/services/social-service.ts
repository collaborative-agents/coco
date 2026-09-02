import { randomUUID } from 'crypto';
import type { IpcMain } from 'electron';
import type { CocoGatewayClient } from './gateway-client';

export interface MessageReaction {
  emoji: string;
  count: number;
  reacted_by_me: boolean;
}

export interface DirectMessage {
  _id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  created_at: string;
  read_at?: string | null;
  reactions?: MessageReaction[];
  coco_gif_id?: string | null;
}

export interface FriendshipSummary {
  friendship_id: string;
  participant_id: string;
  status: 'pending' | 'accepted';
  direction?: 'incoming' | 'outgoing';
  created_at: string;
  updated_at: string;
  unread_count?: number;
  last_message?: DirectMessage | null;
}

export interface FriendshipList {
  friends: FriendshipSummary[];
  incoming: FriendshipSummary[];
  outgoing: FriendshipSummary[];
}

export interface DirectMessagePage {
  messages: DirectMessage[];
  next_before?: string | null;
}

export interface KnowledgeRequest {
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

export interface KnowledgeRequestList {
  incoming: KnowledgeRequest[];
  outgoing: KnowledgeRequest[];
}

export interface GroupMessage {
  _id: string;
  group_id: string;
  sequence: number;
  sender_id: string;
  sender_label: string;
  sender_type: 'participant' | 'admin';
  message_type: 'message' | 'announcement';
  content: string;
  created_at: string;
  reactions?: MessageReaction[];
  coco_gif_id?: string | null;
}

export interface GroupSummary {
  group_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  member_count: number;
  unread_count: number;
  last_read_sequence: number;
  muted: boolean;
  joined_at: string;
  last_message?: GroupMessage | null;
}

export interface GroupInvitation {
  invitation_id: string;
  group_id: string;
  group_name: string;
  group_description: string;
  member_count: number;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  created_at: string;
  expires_at?: string | null;
  responded_at?: string | null;
}

export interface StudyAnnouncement {
  _id: string;
  title: string;
  content: string;
  created_at: string;
  read_at?: string | null;
}

export interface GroupInbox {
  groups: GroupSummary[];
  invitations: GroupInvitation[];
  announcements: StudyAnnouncement[];
  unread_group_count: number;
  invitation_count: number;
  unread_announcement_count: number;
  can_administer: boolean;
}

export interface GroupMessagePage {
  messages: GroupMessage[];
  next_before_sequence?: number | null;
}

export interface GroupMember {
  participant_id: string;
  joined_at: string;
}

export interface AdminGroupInvitation {
  invitation_id: string;
  participant_id: string;
  status: 'pending' | 'accepted' | 'declined' | 'revoked';
  created_at: string;
}

export interface AdminGroup {
  group_id: string;
  name: string;
  description: string;
  status: 'active' | 'archived';
  member_count: number;
  created_at: string;
  invitations: AdminGroupInvitation[];
}

export interface AdminGroupReport {
  _id: string;
  group_id: string;
  group_name: string;
  reporter_id: string;
  message_id?: string | null;
  reason: string;
  details: string;
  status: 'open' | 'reviewed' | 'dismissed';
  created_at: string;
  reviewed_at?: string | null;
}

export interface SocialInboxSnapshot {
  friendships: FriendshipList;
  knowledgeRequests: KnowledgeRequestList;
  unreadCount: number;
  incomingRequestCount: number;
  incomingKnowledgeRequestCount: number;
  unreadKnowledgeAnswerCount: number;
  groupInbox?: GroupInbox;
  unreadGroupCount?: number;
  groupInvitationCount?: number;
  unreadAnnouncementCount?: number;
  updatedAt: string;
}

type GatewayProvider = () => CocoGatewayClient | null;

/** Social API client kept separate from telemetry and tutor-session storage. */
export class SocialService {
  private readonly gatewayProvider: GatewayProvider;

  constructor(gatewayProvider: GatewayProvider) {
    this.gatewayProvider = gatewayProvider;
  }

  async listFriendships(): Promise<FriendshipList> {
    return (await this.gateway().requestJson(
      '/api/social/friendships',
      'GET',
    )) as unknown as FriendshipList;
  }

  async requestFriend(participantId: string): Promise<Record<string, unknown>> {
    const normalized = participantId.trim();
    if (!normalized) throw new Error('Participant ID is required.');
    return this.gateway().requestJson('/api/social/friend-requests', 'POST', {
      participant_id: normalized,
    });
  }

  async acceptFriend(requestId: string): Promise<Record<string, unknown>> {
    return this.friendRequestAction(requestId, 'accept');
  }

  async declineFriend(requestId: string): Promise<Record<string, unknown>> {
    return this.friendRequestAction(requestId, 'decline');
  }

  async listMessages(
    participantId: string,
    before?: string,
  ): Promise<DirectMessagePage> {
    const query = before ? `?before=${encodeURIComponent(before)}` : '';
    return (await this.gateway().requestJson(
      `/api/social/direct-messages/${encodeURIComponent(participantId)}${query}`,
      'GET',
    )) as unknown as DirectMessagePage;
  }

  async sendMessage(
    participantId: string,
    content: string,
    cocoGifId?: string,
  ): Promise<Record<string, unknown>> {
    if (!content.trim()) throw new Error('Message cannot be empty.');
    return this.gateway().requestJson('/api/social/direct-messages', 'POST', {
      _id: randomUUID(),
      recipient_id: participantId,
      content,
      ...(cocoGifId ? { coco_gif_id: cocoGifId } : {}),
    });
  }

  async markRead(participantId: string): Promise<Record<string, unknown>> {
    return this.gateway().requestJson(
      `/api/social/direct-messages/${encodeURIComponent(participantId)}/read`,
      'PATCH',
    );
  }

  async toggleMessageReaction(messageId: string, emoji: string) {
    return this.gateway().requestJson(
      `/api/social/direct-messages/${encodeURIComponent(messageId)}/reactions`,
      'POST',
      { emoji },
    );
  }

  async requestKnowledge(
    ownerId: string,
    question: string,
  ): Promise<Record<string, unknown>> {
    if (!question.trim()) throw new Error('Question is required.');
    return this.gateway().requestJson(
      '/api/social/knowledge-requests',
      'POST',
      {
        _id: randomUUID(),
        owner_id: ownerId,
        question,
      },
    );
  }

  async listKnowledgeRequests(): Promise<KnowledgeRequestList> {
    return (await this.gateway().requestJson(
      '/api/social/knowledge-requests',
      'GET',
    )) as unknown as KnowledgeRequestList;
  }

  async answerKnowledgeRequest(
    requestId: string,
    answer: string,
  ): Promise<Record<string, unknown>> {
    if (!answer.trim()) throw new Error('Answer cannot be empty.');
    return this.gateway().requestJson(
      `/api/social/knowledge-requests/${encodeURIComponent(requestId)}/answer`,
      'PATCH',
      { answer },
    );
  }

  async declineKnowledgeRequest(
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return this.gateway().requestJson(
      `/api/social/knowledge-requests/${encodeURIComponent(requestId)}/decline`,
      'PATCH',
    );
  }

  async markKnowledgeAnswerRead(
    requestId: string,
  ): Promise<Record<string, unknown>> {
    return this.gateway().requestJson(
      `/api/social/knowledge-requests/${encodeURIComponent(requestId)}/read`,
      'PATCH',
    );
  }

  async listGroupInbox(): Promise<GroupInbox> {
    return (await this.gateway().requestJson(
      '/api/social/group-inbox',
      'GET',
    )) as unknown as GroupInbox;
  }

  async acceptGroupInvitation(invitationId: string) {
    return this.gateway().requestJson(
      `/api/social/group-invitations/${encodeURIComponent(invitationId)}/accept`,
      'POST',
    );
  }

  async declineGroupInvitation(invitationId: string) {
    return this.gateway().requestJson(
      `/api/social/group-invitations/${encodeURIComponent(invitationId)}/decline`,
      'POST',
    );
  }

  async listGroupMembers(groupId: string): Promise<{ members: GroupMember[] }> {
    return (await this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/members`,
      'GET',
    )) as unknown as { members: GroupMember[] };
  }

  async listGroupMessages(
    groupId: string,
    beforeSequence?: number,
  ): Promise<GroupMessagePage> {
    const query = beforeSequence ? `?before_sequence=${beforeSequence}` : '';
    return (await this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/messages${query}`,
      'GET',
    )) as unknown as GroupMessagePage;
  }

  async sendGroupMessage(groupId: string, content: string, cocoGifId?: string) {
    if (!content.trim()) throw new Error('Message cannot be empty.');
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/messages`,
      'POST',
      {
        _id: randomUUID(),
        content,
        ...(cocoGifId ? { coco_gif_id: cocoGifId } : {}),
      },
    );
  }

  async toggleGroupMessageReaction(
    groupId: string,
    messageId: string,
    emoji: string,
  ) {
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(messageId)}/reactions`,
      'POST',
      { emoji },
    );
  }

  async markGroupRead(groupId: string, lastReadSequence: number) {
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/read`,
      'PATCH',
      { last_read_sequence: lastReadSequence },
    );
  }

  async setGroupMuted(groupId: string, muted: boolean) {
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/settings`,
      'PATCH',
      { muted },
    );
  }

  async leaveGroup(groupId: string) {
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/leave`,
      'POST',
    );
  }

  async markAnnouncementRead(announcementId: string) {
    return this.gateway().requestJson(
      `/api/social/announcements/${encodeURIComponent(announcementId)}/read`,
      'PATCH',
    );
  }

  async reportGroup(
    groupId: string,
    reason: string,
    details: string,
    messageId?: string,
  ) {
    return this.gateway().requestJson(
      `/api/social/groups/${encodeURIComponent(groupId)}/reports`,
      'POST',
      {
        _id: randomUUID(),
        reason,
        details,
        ...(messageId ? { message_id: messageId } : {}),
      },
    );
  }

  async listAdminGroups(): Promise<{ groups: AdminGroup[] }> {
    return (await this.gateway().requestJson(
      '/api/admin/groups',
      'GET',
    )) as unknown as { groups: AdminGroup[] };
  }

  async createAdminGroup(
    name: string,
    description: string,
    participantIds: string[],
  ) {
    return this.gateway().requestJson('/api/admin/groups', 'POST', {
      name,
      description,
      participant_ids: participantIds,
    });
  }

  async updateAdminGroup(
    groupId: string,
    changes: {
      status?: 'active' | 'archived';
      name?: string;
      description?: string;
    },
  ) {
    return this.gateway().requestJson(
      `/api/admin/groups/${encodeURIComponent(groupId)}`,
      'PATCH',
      changes,
    );
  }

  async inviteAdminGroup(groupId: string, participantIds: string[]) {
    return this.gateway().requestJson(
      `/api/admin/groups/${encodeURIComponent(groupId)}/invitations`,
      'POST',
      { participant_ids: participantIds },
    );
  }

  async revokeGroupInvitation(invitationId: string) {
    return this.gateway().requestJson(
      `/api/admin/group-invitations/${encodeURIComponent(invitationId)}/revoke`,
      'PATCH',
    );
  }

  async sendGroupAnnouncement(groupId: string, content: string) {
    return this.gateway().requestJson(
      `/api/admin/groups/${encodeURIComponent(groupId)}/announcements`,
      'POST',
      { _id: randomUUID(), content },
    );
  }

  async sendStudyAnnouncement(title: string, content: string) {
    return this.gateway().requestJson('/api/admin/announcements', 'POST', {
      _id: randomUUID(),
      title,
      content,
    });
  }

  async listAdminGroupReports(): Promise<{ reports: AdminGroupReport[] }> {
    return (await this.gateway().requestJson(
      '/api/admin/group-reports',
      'GET',
    )) as unknown as { reports: AdminGroupReport[] };
  }

  async reviewAdminGroupReport(
    reportId: string,
    status: 'reviewed' | 'dismissed',
  ) {
    return this.gateway().requestJson(
      `/api/admin/group-reports/${encodeURIComponent(reportId)}`,
      'PATCH',
      { status },
    );
  }

  private gateway(): CocoGatewayClient {
    const gateway = this.gatewayProvider();
    if (!gateway) throw new Error('The Coco study server is not configured.');
    return gateway;
  }

  private friendRequestAction(
    requestId: string,
    action: 'accept' | 'decline',
  ): Promise<Record<string, unknown>> {
    return this.gateway().requestJson(
      `/api/social/friend-requests/${encodeURIComponent(requestId)}/${action}`,
      'POST',
    );
  }
}

export function registerSocialIpcHandlers(
  targetIpcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  service: SocialService,
): void {
  const reset = (channel: string) => {
    targetIpcMain.removeHandler(channel);
  };
  reset('social-list-friendships');
  targetIpcMain.handle('social-list-friendships', () =>
    service.listFriendships(),
  );
  reset('social-request-friend');
  targetIpcMain.handle(
    'social-request-friend',
    (_event, participantId: string) => service.requestFriend(participantId),
  );
  reset('social-accept-friend');
  targetIpcMain.handle('social-accept-friend', (_event, requestId: string) =>
    service.acceptFriend(requestId),
  );
  reset('social-decline-friend');
  targetIpcMain.handle('social-decline-friend', (_event, requestId: string) =>
    service.declineFriend(requestId),
  );
  reset('social-list-messages');
  targetIpcMain.handle(
    'social-list-messages',
    (_event, participantId: string, before?: string) =>
      service.listMessages(participantId, before),
  );
  reset('social-send-message');
  targetIpcMain.handle(
    'social-send-message',
    (_event, participantId: string, content: string, cocoGifId?: string) =>
      service.sendMessage(participantId, content, cocoGifId),
  );
  reset('social-mark-read');
  targetIpcMain.handle('social-mark-read', (_event, participantId: string) =>
    service.markRead(participantId),
  );
  reset('social-toggle-message-reaction');
  targetIpcMain.handle(
    'social-toggle-message-reaction',
    (_event, messageId: string, emoji: string) =>
      service.toggleMessageReaction(messageId, emoji),
  );
  reset('social-request-knowledge');
  targetIpcMain.handle(
    'social-request-knowledge',
    (_event, ownerId: string, question: string) =>
      service.requestKnowledge(ownerId, question),
  );
  reset('social-list-knowledge-requests');
  targetIpcMain.handle('social-list-knowledge-requests', () =>
    service.listKnowledgeRequests(),
  );
  reset('social-answer-knowledge-request');
  targetIpcMain.handle(
    'social-answer-knowledge-request',
    (_event, requestId: string, answer: string) =>
      service.answerKnowledgeRequest(requestId, answer),
  );
  reset('social-decline-knowledge-request');
  targetIpcMain.handle(
    'social-decline-knowledge-request',
    (_event, requestId: string) => service.declineKnowledgeRequest(requestId),
  );
  reset('social-mark-knowledge-answer-read');
  targetIpcMain.handle(
    'social-mark-knowledge-answer-read',
    (_event, requestId: string) => service.markKnowledgeAnswerRead(requestId),
  );
  reset('social-list-group-inbox');
  targetIpcMain.handle('social-list-group-inbox', () =>
    service.listGroupInbox(),
  );
  reset('social-accept-group-invitation');
  targetIpcMain.handle('social-accept-group-invitation', (_event, id: string) =>
    service.acceptGroupInvitation(id),
  );
  reset('social-decline-group-invitation');
  targetIpcMain.handle(
    'social-decline-group-invitation',
    (_event, id: string) => service.declineGroupInvitation(id),
  );
  reset('social-list-group-members');
  targetIpcMain.handle('social-list-group-members', (_event, groupId: string) =>
    service.listGroupMembers(groupId),
  );
  reset('social-list-group-messages');
  targetIpcMain.handle(
    'social-list-group-messages',
    (_event, groupId: string, before?: number) =>
      service.listGroupMessages(groupId, before),
  );
  reset('social-send-group-message');
  targetIpcMain.handle(
    'social-send-group-message',
    (_event, groupId: string, content: string, cocoGifId?: string) =>
      service.sendGroupMessage(groupId, content, cocoGifId),
  );
  reset('social-toggle-group-message-reaction');
  targetIpcMain.handle(
    'social-toggle-group-message-reaction',
    (_event, groupId: string, messageId: string, emoji: string) =>
      service.toggleGroupMessageReaction(groupId, messageId, emoji),
  );
  reset('social-mark-group-read');
  targetIpcMain.handle(
    'social-mark-group-read',
    (_event, groupId: string, sequence: number) =>
      service.markGroupRead(groupId, sequence),
  );
  reset('social-set-group-muted');
  targetIpcMain.handle(
    'social-set-group-muted',
    (_event, groupId: string, muted: boolean) =>
      service.setGroupMuted(groupId, muted),
  );
  reset('social-leave-group');
  targetIpcMain.handle('social-leave-group', (_event, groupId: string) =>
    service.leaveGroup(groupId),
  );
  reset('social-mark-announcement-read');
  targetIpcMain.handle('social-mark-announcement-read', (_event, id: string) =>
    service.markAnnouncementRead(id),
  );
  reset('social-report-group');
  targetIpcMain.handle(
    'social-report-group',
    (
      _event,
      groupId: string,
      reason: string,
      details: string,
      messageId?: string,
    ) => service.reportGroup(groupId, reason, details, messageId),
  );
  reset('social-admin-list-groups');
  targetIpcMain.handle('social-admin-list-groups', () =>
    service.listAdminGroups(),
  );
  reset('social-admin-create-group');
  targetIpcMain.handle(
    'social-admin-create-group',
    (_event, name: string, description: string, ids: string[]) =>
      service.createAdminGroup(name, description, ids),
  );
  reset('social-admin-update-group');
  targetIpcMain.handle(
    'social-admin-update-group',
    (_event, groupId: string, changes: { status?: 'active' | 'archived' }) =>
      service.updateAdminGroup(groupId, changes),
  );
  reset('social-admin-invite-group');
  targetIpcMain.handle(
    'social-admin-invite-group',
    (_event, groupId: string, ids: string[]) =>
      service.inviteAdminGroup(groupId, ids),
  );
  reset('social-admin-revoke-invitation');
  targetIpcMain.handle('social-admin-revoke-invitation', (_event, id: string) =>
    service.revokeGroupInvitation(id),
  );
  reset('social-admin-send-group-announcement');
  targetIpcMain.handle(
    'social-admin-send-group-announcement',
    (_event, groupId: string, content: string) =>
      service.sendGroupAnnouncement(groupId, content),
  );
  reset('social-admin-send-study-announcement');
  targetIpcMain.handle(
    'social-admin-send-study-announcement',
    (_event, title: string, content: string) =>
      service.sendStudyAnnouncement(title, content),
  );
  reset('social-admin-list-group-reports');
  targetIpcMain.handle('social-admin-list-group-reports', () =>
    service.listAdminGroupReports(),
  );
  reset('social-admin-review-group-report');
  targetIpcMain.handle(
    'social-admin-review-group-report',
    (_event, reportId: string, status: 'reviewed' | 'dismissed') =>
      service.reviewAdminGroupReport(reportId, status),
  );
}
