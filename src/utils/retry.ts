import { isRetryable } from "@/utils/errors";
import { logger } from "@/utils/logger";

export interface RetryOptions {
  /** Total attempts including the first. 4 means 1 try + 3 retries. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Overrides the default retryable-error check. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Lets a caller honour a server-supplied Retry-After. */
  retryAfterMs?: (error: unknown) => number | undefined;
  label?: string;
  signal?: AbortSignal;
  /** Injectable for tests so we never actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Full jitter: `random(0, min(cap, base * 2^attempt))`.
 *
 * Chosen over "equal jitter" or fixed backoff because several locations can be
 * processed concurrently off one Pub/Sub burst, and full jitter is the variant
 * that spreads a thundering herd most evenly. It also means a single retrying
 * request never sleeps for the theoretical maximum.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(random() * exponential);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 400,
    maxDelayMs = 15_000,
    shouldRetry = isRetryable,
    retryAfterMs,
    label = "operation",
    signal,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error(`${label} aborted`);

    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !shouldRetry(error, attempt)) throw error;

      const serverDelay = retryAfterMs?.(error);
      const delay = serverDelay ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random);

      logger.warn("Retrying after failure", {
        label,
        attempt: attempt + 1,
        maxAttempts,
        delayMs: delay,
        error: error instanceof Error ? error.message : String(error),
      });

      await sleep(delay);
    }
  }

  throw lastError;
}
