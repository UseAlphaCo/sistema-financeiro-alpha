const RETRY_DELAYS_MS = [0, 30_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

export function getRetryDelayMs(attempt: number): number {
  const index = Math.max(1, attempt) - 1;
  return RETRY_DELAYS_MS[Math.min(index, RETRY_DELAYS_MS.length - 1)];
}

export function getNextRetryAt(attempt: number, now = new Date()): Date {
  const delayMs = getRetryDelayMs(attempt);
  return new Date(now.getTime() + delayMs);
}
