import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  CocoGatewayClient,
  GatewayOperationType,
  GatewayQueuedOperation,
} from './gateway-client';

interface OutboxLogger {
  info(message: string): void;
  warn(message: string): void;
}

const silentLogger: OutboxLogger = { info: () => {}, warn: () => {} };

/** A participant-specific durable queue for idempotent Gateway writes. */
export default class GatewayOutbox {
  private readonly destination: string;

  private readonly client: CocoGatewayClient;

  private readonly logger: OutboxLogger;

  private operations: GatewayQueuedOperation[];

  private flushing: Promise<void> | null = null;

  constructor(
    userDataPath: string,
    participantId: string,
    client: CocoGatewayClient,
    logger: OutboxLogger = silentLogger,
  ) {
    const safeParticipant = participantId
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_');
    const gatewayNamespace = client.storageNamespace();
    this.destination = path.join(
      userDataPath,
      `coco-gateway-outbox-${gatewayNamespace}-${safeParticipant}.json`,
    );
    this.client = client;
    this.logger = logger;
    this.operations = this.read();
  }

  enqueue(
    type: GatewayOperationType,
    payload: Record<string, unknown>,
  ): GatewayQueuedOperation {
    const operation: GatewayQueuedOperation = {
      id: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      payload,
    };
    this.operations.push(operation);
    this.persist();
    this.flush();
    return operation;
  }

  pendingCount(): number {
    return this.operations.length;
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOperations().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async flushOperations(): Promise<void> {
    while (this.operations.length > 0) {
      const operation = this.operations[0];
      try {
        // Sequential delivery preserves foreign-key ordering (session before
        // messages/interactions) across app restarts.
        // eslint-disable-next-line no-await-in-loop
        await this.client.deliver(operation);
      } catch (error) {
        this.logger.warn(
          `[GatewayOutbox] delivery paused with ${this.operations.length} pending: ${String(error)}`,
        );
        return;
      }
      this.operations.shift();
      this.persist();
    }
  }

  private read(): GatewayQueuedOperation[] {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.destination, 'utf-8'),
      ) as GatewayQueuedOperation[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    const temporary = `${this.destination}.tmp`;
    fs.mkdirSync(path.dirname(this.destination), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(this.operations, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    fs.renameSync(temporary, this.destination);
    fs.chmodSync(this.destination, 0o600);
  }
}
