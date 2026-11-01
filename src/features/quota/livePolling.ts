export const LIVE_TICK_MS = 60_000;
export const LIVE_ACCOUNT_INTERVAL_MS = 300_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/** Per-account cooldowns survive toggling Live; session changes get a new queue. */
export class QuotaPollQueue {
  private attempts = new Map<string, { due: number; failures: number }>();

  next(keys: string[], now: number): string | undefined {
    const survivors = new Set(keys);
    for (const key of this.attempts.keys()) {
      if (!survivors.has(key)) this.attempts.delete(key);
    }
    return keys
      .filter((key) => (this.attempts.get(key)?.due ?? 0) <= now)
      .sort((a, b) => (this.attempts.get(a)?.due ?? 0) - (this.attempts.get(b)?.due ?? 0))[0];
  }

  complete(key: string, now: number, success: boolean, intervalMs = LIVE_ACCOUNT_INTERVAL_MS) {
    const failures = success ? 0 : (this.attempts.get(key)?.failures ?? 0) + 1;
    const delay = Math.max(intervalMs, Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures));
    this.attempts.set(key, { due: now + delay, failures });
  }
}

const LIVE_KEY = 'quotaPage.live';
const INTERVAL_KEY = 'quotaPage.refreshMinutes';

export function normalizeQuotaRefreshMinutes(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 60 ? value : 5;
}

export function readQuotaRefreshMinutes(): number {
  try {
    const saved = window.localStorage.getItem(INTERVAL_KEY);
    return normalizeQuotaRefreshMinutes(saved === null ? 5 : Number(saved));
  } catch {
    return 5;
  }
}

export function writeQuotaRefreshMinutes(value: number) {
  try {
    window.localStorage.setItem(INTERVAL_KEY, String(normalizeQuotaRefreshMinutes(value)));
  } catch {
    // Keep the current choice usable when browser storage is blocked.
  }
  window.dispatchEvent(new Event('quota-refresh-interval-change'));
}

export function readQuotaLive(): boolean {
  try {
    return window.localStorage.getItem(LIVE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeQuotaLive(enabled: boolean) {
  try {
    window.localStorage.setItem(LIVE_KEY, String(enabled));
  } catch {
    // Live still works when browser persistence is unavailable.
  }
}
