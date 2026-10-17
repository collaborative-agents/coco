interface GatewayLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface CocoGatewayClientOptions {
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
  logger?: GatewayLogger;
}

export interface GatewayAuthCredentials {
  participantId: string;
  email?: string;
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

export type GatewayOperationType =
  | 'session_start'
  | 'session_end'
  | 'message'
  | 'interaction_batch'
  | 'fatal_error'
  | 'personalization_run';

export interface GatewayQueuedOperation {
  id: string;
  type: GatewayOperationType;
  createdAt: string;
  payload: Record<string, unknown>;
}

const silentLogger: GatewayLogger = {
  info: () => {},
  warn: () => {},
};

/** Authenticated HTTP client for the shared Coco Gateway. */
export class CocoGatewayClient {
  private readonly gatewayUrl: string;

  private readonly fetchImpl: typeof fetch;

  private readonly logger: GatewayLogger;

  private authToken: string | null = null;

  private readonly unsupportedOptionalOperations =
    new Set<GatewayOperationType>();

  constructor(options: CocoGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? silentLogger;
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

  setAuthSession(token: string): void {
    this.authToken = token;
  }

  clearAuthSession(): void {
    this.authToken = null;
  }

  /** Prevent pending records from one study server reaching another one. */
  storageNamespace(): string {
    try {
      const url = new URL(this.gatewayUrl);
      return `${url.hostname}${url.pathname}`
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '_');
    } catch {
      return 'gateway';
    }
  }

  async signUp(
    credentials: GatewayAuthCredentials,
  ): Promise<GatewayAuthSession> {
    return this.authenticate('/api/auth/signup', credentials);
  }

  async signIn(
    credentials: GatewayAuthCredentials,
  ): Promise<GatewayAuthSession> {
    return this.authenticate('/api/auth/signin', credentials);
  }

  async restoreAuthSession(token: string): Promise<{ participantId: string }> {
    this.authToken = token;
    try {
      const result = await this.request('/api/auth/me', 'GET');
      const participantId = String(result.participant_id ?? '');
      if (!participantId) throw new Error('Invalid account response.');
      return { participantId };
    } catch (error) {
      this.clearAuthSession();
      throw error;
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.request('/api/auth/logout', 'POST');
    } finally {
      this.clearAuthSession();
    }
  }

  async issueRouterCredential(): Promise<GatewayRouterCredential> {
    const result = await this.request('/api/auth/router-credential', 'POST');
    const credential = {
      token: String(result.token ?? ''),
      expiresAt: String(result.expires_at ?? ''),
    };
    if (!credential.token || !credential.expiresAt) {
      throw new Error('Invalid model-access response from Coco Gateway.');
    }
    return credential;
  }

  /** Authenticated request surface for feature-specific Gateway clients. */
  async requestJson(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: object,
  ): Promise<Record<string, unknown>> {
    return this.request(path, method, body);
  }

  async deliver(operation: GatewayQueuedOperation): Promise<void> {
    switch (operation.type) {
      case 'session_start':
        await this.request('/api/storage/sessions', 'POST', {
          ...operation.payload,
          // A manual start has no equivalent in the shared Gateway schema.
          ...(operation.payload.start_trigger === 'manual'
            ? { start_trigger: null }
            : {}),
        });
        return;
      case 'session_end': {
        const { session_id: sessionId, ...body } = operation.payload;
        if (typeof sessionId !== 'string' || !sessionId) {
          throw new Error('Queued session end is missing session_id.');
        }
        await this.request(
          `/api/storage/sessions/${encodeURIComponent(sessionId)}/end`,
          'PATCH',
          {
            ...body,
            // The shared Gateway requires recap/quiz fields even when Coco
            // ends a conversation without a separate recap or quiz flow.
            recap_completed_at: body.recap_completed_at ?? body.ended_at,
            quiz_skipped: body.quiz_skipped ?? true,
            quiz_answered: body.quiz_answered ?? false,
          },
        );
        return;
      }
      case 'message':
        await this.request('/api/storage/messages', 'POST', operation.payload);
        return;
      case 'interaction_batch':
        await this.deliverOptional(
          operation.type,
          '/api/storage/interaction-events/batch',
          operation.payload,
        );
        return;
      case 'fatal_error':
        await this.deliverOptional(
          operation.type,
          '/api/storage/fatal-errors',
          operation.payload,
        );
        return;
      case 'personalization_run':
        await this.deliverOptional(
          operation.type,
          '/api/storage/personalization-run-events',
          operation.payload,
        );
        return;
      default:
        throw new Error(
          `Unsupported Gateway operation: ${String(operation.type)}`,
        );
    }
  }

  private async deliverOptional(
    type: GatewayOperationType,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (this.unsupportedOptionalOperations.has(type)) return;
    try {
      await this.request(path, 'POST', payload);
    } catch (error) {
      if (
        error instanceof Error &&
        'status' in error &&
        (error.status === 404 || error.status === 405)
      ) {
        this.unsupportedOptionalOperations.add(type);
        this.logger.info(
          `[Gateway] ${path} is unavailable; skipping optional events`,
        );
        return;
      }
      throw error;
    }
  }

  private async authenticate(
    path: string,
    credentials: GatewayAuthCredentials,
  ): Promise<GatewayAuthSession> {
    const result = await this.request(path, 'POST', {
      participant_id: credentials.participantId,
      ...(credentials.email ? { email: credentials.email } : {}),
      password: credentials.password,
      keep_signed_in: credentials.keepSignedIn,
    });
    const session = {
      participantId: String(result.participant_id ?? ''),
      token: String(result.token ?? ''),
      expiresAt: String(result.expires_at ?? ''),
    };
    if (!session.participantId || !session.token || !session.expiresAt) {
      throw new Error('Invalid authentication response from Coco Gateway.');
    }
    this.setAuthSession(session.token);
    return session;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: object,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken
            ? { Authorization: `Bearer ${this.authToken}` }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      this.logger.warn(`[Gateway] ${method} ${path} failed: ${String(error)}`);
      throw new Error(
        `Could not connect to the Coco study server. ${String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    let result: Record<string, unknown> = {};
    try {
      result = (await response.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON responses use the HTTP status fallback below.
    }
    if (!response.ok) {
      throw Object.assign(
        new Error(
          Array.isArray(result.detail)
            ? result.detail
                .map(
                  (issue: { loc?: unknown[]; msg?: string }) =>
                    `${issue.loc?.filter((part) => part !== 'body').join('.') || 'Request'}: ${issue.msg || 'Invalid value'}`,
                )
                .join('; ')
            : String(result.detail ?? `HTTP ${response.status}`),
        ),
        { status: response.status },
      );
    }
    return result;
  }
}
