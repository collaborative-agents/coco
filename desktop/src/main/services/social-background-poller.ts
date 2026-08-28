import type { SocialInboxSnapshot } from './social-service';
import { SocialService } from './social-service';

interface SocialPollerLogger {
  warn(message: string): void;
}

/** Polls the authenticated inbox even while the chat renderer is hidden. */
export default class SocialBackgroundPoller {
  private readonly service: SocialService;

  private readonly publish: (snapshot: SocialInboxSnapshot) => void;

  private readonly logger?: SocialPollerLogger;

  private readonly intervalMs: number;

  private timer: ReturnType<typeof setInterval> | null = null;

  private inFlight: Promise<SocialInboxSnapshot | null> | null = null;

  private snapshot: SocialInboxSnapshot | null = null;

  constructor(
    service: SocialService,
    publish: (snapshot: SocialInboxSnapshot) => void,
    logger?: SocialPollerLogger,
    intervalMs = 5_000,
  ) {
    this.service = service;
    this.publish = publish;
    this.logger = logger;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latestSnapshot(): SocialInboxSnapshot | null {
    return this.snapshot;
  }

  refresh(): Promise<SocialInboxSnapshot | null> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all([
      this.service.listFriendships(),
      this.service.listKnowledgeRequests(),
    ])
      .then(([friendships, knowledgeRequests]) => {
        const snapshot: SocialInboxSnapshot = {
          friendships,
          knowledgeRequests,
          unreadCount: friendships.friends.reduce(
            (total, friend) => total + (friend.unread_count || 0),
            0,
          ),
          incomingRequestCount: friendships.incoming.length,
          incomingKnowledgeRequestCount: knowledgeRequests.incoming.filter(
            (request) => request.status === 'pending',
          ).length,
          unreadKnowledgeAnswerCount: knowledgeRequests.outgoing.filter(
            (request) =>
              request.status === 'answered' && !request.answer_read_at,
          ).length,
          updatedAt: new Date().toISOString(),
        };
        this.snapshot = snapshot;
        this.publish(snapshot);
        return snapshot;
      })
      .catch((error) => {
        this.logger?.warn(`[Social] background poll failed: ${String(error)}`);
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }
}
