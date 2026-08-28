import { randomUUID } from 'crypto';
import type { IpcMain } from 'electron';
import type { CocoGatewayClient } from './gateway-client';

export interface DirectMessage {
  _id: string;
  sender_id: string;
  recipient_id: string;
  content: string;
  created_at: string;
  read_at?: string | null;
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

export interface SocialInboxSnapshot {
  friendships: FriendshipList;
  knowledgeRequests: KnowledgeRequestList;
  unreadCount: number;
  incomingRequestCount: number;
  incomingKnowledgeRequestCount: number;
  unreadKnowledgeAnswerCount: number;
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
  ): Promise<Record<string, unknown>> {
    if (!content.trim()) throw new Error('Message cannot be empty.');
    return this.gateway().requestJson('/api/social/direct-messages', 'POST', {
      _id: randomUUID(),
      recipient_id: participantId,
      content,
    });
  }

  async markRead(participantId: string): Promise<Record<string, unknown>> {
    return this.gateway().requestJson(
      `/api/social/direct-messages/${encodeURIComponent(participantId)}/read`,
      'PATCH',
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
    (_event, participantId: string, content: string) =>
      service.sendMessage(participantId, content),
  );
  reset('social-mark-read');
  targetIpcMain.handle('social-mark-read', (_event, participantId: string) =>
    service.markRead(participantId),
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
}
