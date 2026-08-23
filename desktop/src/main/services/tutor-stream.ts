export interface TutorStreamEvent {
  type:
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'transcription'
    | 'text_delta'
    | 'done'
    | 'error';
  [key: string]: unknown;
}

export interface TutorStreamTimeouts {
  idleMs: number;
  hardMs: number;
}

export class TutorStreamTimeoutError extends Error {
  readonly kind: 'idle' | 'hard';

  constructor(kind: 'idle' | 'hard') {
    super(
      kind === 'idle'
        ? 'Tutor stream stopped producing activity'
        : 'Tutor stream exceeded its maximum duration',
    );
    this.name = 'TutorStreamTimeoutError';
    this.kind = kind;
  }
}

/** Tracks user-visible, end-to-end timing for one streamed tutor turn. */
export class TutorTurnTiming {
  readonly requestStartedAt: Date;

  private firstTokenAt?: Date;

  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
    this.requestStartedAt = now();
  }

  recordTextDelta(text: unknown): void {
    if (this.firstTokenAt || String(text ?? '').trim().length === 0) return;
    this.firstTokenAt = this.now();
  }

  complete(model?: string) {
    return {
      requestStartedAt: this.requestStartedAt,
      ...(this.firstTokenAt ? { firstTokenAt: this.firstTokenAt } : {}),
      responseCompletedAt: this.now(),
      ...(model ? { model } : {}),
    };
  }
}

function extractSseEvents(buffer: string): {
  events: TutorStreamEvent[];
  remainder: string;
} {
  const events: TutorStreamEvent[] = [];
  let remainder = buffer;
  while (true) {
    const match = /\r?\n\r?\n/.exec(remainder);
    if (!match || match.index === undefined) break;
    const raw = remainder.slice(0, match.index);
    remainder = remainder.slice(match.index + match[0].length);
    const payload = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload) continue;
    events.push(JSON.parse(payload) as TutorStreamEvent);
  }
  return { events, remainder };
}

export async function consumeTutorStream(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: TutorStreamEvent) => void,
  signal?: AbortSignal,
  timeouts?: TutorStreamTimeouts,
): Promise<void> {
  const controller = new AbortController();
  let timeoutKind: 'idle' | 'hard' | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const abortFromSignal = () => controller.abort();
  const armIdleTimer = () => {
    if (!timeouts) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timeoutKind = 'idle';
      controller.abort();
    }, timeouts.idleMs);
  };

  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromSignal, { once: true });
  armIdleTimer();
  if (timeouts) {
    hardTimer = setTimeout(() => {
      timeoutKind = 'hard';
      controller.abort();
    }, timeouts.hardMs);
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Tutor stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (value?.length) armIdleTimer();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.remainder;
      parsed.events.forEach(onEvent);
      if (done) break;
    }
  } catch (error) {
    if (timeoutKind) throw new TutorStreamTimeoutError(timeoutKind);
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    signal?.removeEventListener('abort', abortFromSignal);
  }
}

export { extractSseEvents };
