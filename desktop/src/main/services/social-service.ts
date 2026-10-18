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
    if (!normalized) throw new Error('Username is required.');
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

  private gateway(): CocoGatewayClient {
    const gateway = this.gatewayProvider();
    if (!gateway) throw new Error('The Coco Learn server is not configured.');
    return gateway;
  }
  private friendRequestAction(requestId: string, action: 'accept' | 'decline') {
    return this.gateway().requestJson(
      `/api/social/friend-requests/${encodeURIComponent(requestId)}/${action}`, 'POST');
  }
}

export function registerSocialIpcHandlers(ipc: Pick<IpcMain, 'handle'>, service: SocialService): void {
  ipc.handle('social-list-friendships', () => service.listFriendships());
  ipc.handle('social-request-friend', (_event, id: string) => service.requestFriend(id));
  ipc.handle('social-accept-friend', (_event, id: string) => service.acceptFriend(id));
  ipc.handle('social-decline-friend', (_event, id: string) => service.declineFriend(id));
  ipc.handle('social-list-messages', (_event, id: string, before?: string) => service.listMessages(id, before));
  ipc.handle('social-send-message', (_event, id: string, content: string) => service.sendMessage(id, content));
  ipc.handle('social-mark-read', (_event, id: string) => service.markRead(id));
}
