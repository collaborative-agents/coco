export class RetryCancelledError extends Error {
  constructor(message = 'Retry cancelled.') {
    super(message);
    this.name = 'RetryCancelledError';
  }
}

export interface RetryOperationOptions {
  /** Delay before each attempt; the first value is normally zero. */
  delaysMs?: number[];
  shouldContinue?: () => boolean;
  onRetry?: (
    error: unknown,
    nextDelayMs: number,
    failedAttempt: number,
  ) => void;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });

/** Retry a startup-sensitive local operation without reviving a stale session. */
export async function retryOperation<T>(
  operation: () => Promise<T>,
  options: RetryOperationOptions = {},
): Promise<T> {
  const delaysMs = options.delaysMs ?? [0, 500, 1000, 2000, 4000];
  const shouldContinue = options.shouldContinue ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;
  if (delaysMs.length === 0) {
    throw new Error('No retry attempts were configured.');
  }

  const attempt = async (index: number): Promise<T> => {
    if (!shouldContinue()) throw new RetryCancelledError();
    const delayMs = delaysMs[index];
    if (delayMs > 0) await sleep(delayMs);
    if (!shouldContinue()) throw new RetryCancelledError();

    try {
      return await operation();
    } catch (error) {
      const nextDelayMs = delaysMs[index + 1];
      if (nextDelayMs === undefined) throw error;
      options.onRetry?.(error, nextDelayMs, index + 1);
      return attempt(index + 1);
    }
  };

  return attempt(0);
}
