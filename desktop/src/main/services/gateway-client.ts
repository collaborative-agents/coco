import { randomUUID } from 'crypto';
import { readHarnessVersion } from './harness-version';
import type { HarnessVersion } from './harness-version';
import type { SessionStartTrigger } from '../../shared/session-start';

interface GatewayLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface CocoGatewayClientOptions {
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
  logger?: GatewayLogger;
  harnessVersionProvider?: () => HarnessVersion;
}

export interface GatewaySessionCompletion {
  endedAt: Date;
  recapCompletedAt: Date;
  quizSkipped: boolean;
  quizAnswered: boolean;
  quizCorrect?: boolean;
  selectedIndex?: number;
}

export interface GatewayAssistantTurnTiming {
  requestStartedAt: Date;
  firstTokenAt?: Date;
  responseCompletedAt: Date;
  model?: string;
}

export interface GatewayAuthCredentials {
  participantId: string;
  password: string;
  keepSignedIn: boolean;
}

export interface GatewayAuthSession {
  participantId: string;
  token: string;
  expiresAt: string;
}

export interface GatewayRouterCredential {
  token: string;
  expiresAt: string;
}

const silentLogger: GatewayLogger = {
  info: () => {},
  warn: () => {},
};

/**
 * HTTP client matching the monorepo GatewayClient pattern: send validated
 * storage objects to the backend and let the backend persist them to MongoDB.
 */
export class CocoGatewayClient {
  private readonly gatewayUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly logger: GatewayLogger;

  private readonly harnessVersionProvider: () => HarnessVersion;

  private userId: string | null;

  private authToken: string | null = null;

  constructor(options: CocoGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? silentLogger;
    this.harnessVersionProvider =
      options.harnessVersionProvider ?? readHarnessVersion;
    this.userId = process.env.COCO_GATEWAY_USER_ID?.trim() || null;
  }

  static fromEnvironment(
    logger?: GatewayLogger,
    defaultGatewayUrl = '',
  ): CocoGatewayClient | null {
    if (process.env.COCO_GATEWAY_ENABLED === '0') return null;
    const gatewayUrl = (
      process.env.COCO_GATEWAY_URL || defaultGatewayUrl
    ).trim();
    if (!gatewayUrl) {
      logger?.info('[Gateway] disabled; set COCO_GATEWAY_URL to enable');
      return null;
    }
    return new CocoGatewayClient({ gatewayUrl, logger });
  }

  setUserId(userId: string | null): void {
    this.userId = userId?.trim() || null;
  }

  setAuthSession(token: string, participantId: string): void {
    this.authToken = token;
    this.setUserId(participantId);
  }

  clearAuthSession(): void {
    this.authToken = null;
    this.userId = null;
  }

  async signUp(
    credentials: GatewayAuthCredentials,
  ): Promise<GatewayAuthSession> {
    const session = await this.authRequest('/api/auth/signup', 'POST', {
      participant_id: credentials.participantId,
      password: credentials.password,
      keep_signed_in: credentials.keepSignedIn,
    });
    return this.parseAuthSession(session);
  }

  async signIn(
    credentials: GatewayAuthCredentials,
  ): Promise<GatewayAuthSession> {
    const session = await this.authRequest('/api/auth/signin', 'POST', {
      participant_id: credentials.participantId,
      password: credentials.password,
      keep_signed_in: credentials.keepSignedIn,
    });
    return this.parseAuthSession(session);
  }

  async restoreAuthSession(token: string): Promise<{ participantId: string }> {
    this.authToken = token;
    try {
      const result = await this.authRequest('/api/auth/me', 'GET');
      const participantId = String(result.participant_id ?? '');
      if (!participantId) throw new Error('Invalid account response.');
      this.setUserId(participantId);
      return { participantId };
    } catch (error) {
      this.clearAuthSession();
      throw error;
    }
  }

  async issueRouterCredential(): Promise<GatewayRouterCredential> {
    if (!this.authToken) {
      throw new Error('Sign in before requesting model access.');
    }
    const result = await this.authRequest(
      '/api/auth/router-credential',
      'POST',
    );
    const credential = {
      token: String(result.token ?? ''),
      expiresAt: String(result.expires_at ?? ''),
    };
    if (!credential.token || !credential.expiresAt) {
      throw new Error('Invalid model-access response from Coco Gateway.');
    }
    return credential;
  }

  private parseAuthSession(
    result: Record<string, unknown>,
  ): GatewayAuthSession {
    const session = {
      participantId: String(result.participant_id ?? ''),
      token: String(result.token ?? ''),
      expiresAt: String(result.expires_at ?? ''),
    };
    if (!session.participantId || !session.token || !session.expiresAt) {
      throw new Error('Invalid authentication response from Coco Gateway.');
    }
    this.setAuthSession(session.token, session.participantId);
    return session;
  }

  async startSession(
    sessionId: string,
    startTrigger: SessionStartTrigger,
    startedAt = new Date(),
  ): Promise<void> {
    const tutorModel = process.env.TUTOR_MODEL?.trim();
    const observerModel = process.env.OBSERVER_MODEL?.trim();
    const harness = this.harnessVersionProvider();
    await this.post('/api/storage/sessions', {
      _id: sessionId,
      user_id: this.userId,
      started_at: startedAt.toISOString(),
      start_trigger: startTrigger,
      ...(tutorModel ? { tutor_model: tutorModel } : {}),
      ...(observerModel ? { observer_model: observerModel } : {}),
      ...(harness.gitCommitSha ? { git_commit_sha: harness.gitCommitSha } : {}),
      ...(harness.gitBranch ? { git_branch: harness.gitBranch } : {}),
      ...(harness.repository ? { repository: harness.repository } : {}),
      ...(harness.gitDirty !== undefined
        ? { git_dirty: harness.gitDirty }
        : {}),
    });
  }

  async endSession(
    sessionId: string,
    completion: GatewaySessionCompletion,
  ): Promise<void> {
    await this.patch(`/api/storage/sessions/${sessionId}/end`, {
      ended_at: completion.endedAt.toISOString(),
      recap_completed_at: completion.recapCompletedAt.toISOString(),
      quiz_skipped: completion.quizSkipped,
      quiz_answered: completion.quizAnswered,
      ...(typeof completion.quizCorrect === 'boolean'
        ? { quiz_correct: completion.quizCorrect }
        : {}),
      ...(typeof completion.selectedIndex === 'number'
        ? { selected_index: completion.selectedIndex }
        : {}),
    });
  }

  async addMessage(
    sessionId: string,
    role: 'user' | 'coco',
    content: string,
    turnTiming?: GatewayAssistantTurnTiming,
  ): Promise<void> {
    const messageTimestamp =
      role === 'coco' && turnTiming
        ? turnTiming.responseCompletedAt
        : new Date();
    await this.post('/api/storage/messages', {
      _id: randomUUID(),
      sid: sessionId,
      a: {
        type: role === 'user' ? 'user' : 'AITutor',
        id: role === 'user' ? this.userId || 'local-user' : 'AITutor',
      },
      content,
      ts: messageTimestamp.toISOString(),
      ...(role === 'coco' && turnTiming
        ? {
            request_started_at: turnTiming.requestStartedAt.toISOString(),
            ...(turnTiming.firstTokenAt
              ? { first_token_at: turnTiming.firstTokenAt.toISOString() }
              : {}),
            response_completed_at: turnTiming.responseCompletedAt.toISOString(),
            ...(turnTiming.model ? { model: turnTiming.model } : {}),
          }
        : {}),
    });
  }

  private async post(path: string, body: object): Promise<void> {
    await this.request(path, 'POST', body);
  }

  private async patch(path: string, body: object): Promise<void> {
    await this.request(path, 'PATCH', body);
  }

  private async request(
    path: string,
    method: 'POST' | 'PATCH',
    body: object,
  ): Promise<void> {
    try {
      const response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      this.logger.warn(`[Gateway] ${method} ${path} failed: ${String(error)}`);
    }
  }

  private async authRequest(
    path: string,
    method: 'GET' | 'POST',
    body?: object,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new Error(
        `Could not connect to the Coco backend. ${String(error)}`,
      );
    }
    let result: Record<string, unknown> = {};
    try {
      result = (await response.json()) as Record<string, unknown>;
    } catch {
      // A non-JSON backend response is handled by the HTTP fallback below.
    }
    if (!response.ok) {
      throw new Error(String(result.detail ?? `HTTP ${response.status}`));
    }
    return result;
  }
}
