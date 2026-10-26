import { describe, expect, test } from 'bun:test';
import {
  QuotaPollQueue,
  LIVE_ACCOUNT_INTERVAL_MS,
  readQuotaLive,
  writeQuotaLive,
} from '@/features/quota/livePolling';

describe('paced quota polling', () => {
  test('saves both toggle values across reads and tolerates blocked storage', () => {
    const original = (globalThis as { window?: unknown }).window;
    const saved = new Map<string, string>();
    try {
      Object.assign(globalThis, {
        window: {
          localStorage: {
            getItem: (key: string) => saved.get(key) ?? null,
            setItem: (key: string, value: string) => saved.set(key, value),
          },
        },
      });
      expect(readQuotaLive()).toBe(true);
      writeQuotaLive(false);
      expect(readQuotaLive()).toBe(false);
      writeQuotaLive(true);
      expect(readQuotaLive()).toBe(true);
      Object.assign(globalThis, {
        window: {
          get localStorage() {
            throw new Error('blocked');
          },
        },
      });
      expect(() => writeQuotaLive(false)).not.toThrow();
      expect(readQuotaLive()).toBe(true);
    } finally {
      if (original === undefined) delete (globalThis as { window?: unknown }).window;
      else Object.assign(globalThis, { window: original });
    }
  });
  test('loads every account before revisiting one, including beyond a 20-card page', () => {
    const queue = new QuotaPollQueue();
    const accounts = Array.from({ length: 45 }, (_, index) => `account-${index}`);
    let now = 1_000_000;
    const visited: string[] = [];
    for (let index = 0; index < accounts.length; index++) {
      const next = queue.next(accounts, now)!;
      visited.push(next);
      queue.complete(next, now, true);
      now += 5_000;
    }
    expect(new Set(visited).size).toBe(45);
    expect(queue.next(accounts, now)).toBe(accounts[0]);
  });

  test('cooldown starts after completion and does not burst when the tab resumes', () => {
    const queue = new QuotaPollQueue();
    queue.complete('a', 10_000, true);
    expect(queue.next(['a'], 10_000 + LIVE_ACCOUNT_INTERVAL_MS - 1)).toBeUndefined();
    expect(queue.next(['a'], 10_000 + LIVE_ACCOUNT_INTERVAL_MS)).toBe('a');
    queue.complete('a', 9_000_000, true);
    expect(queue.next(['a'], 9_000_000)).toBeUndefined();
  });

  test('backs off errors to 15 minutes and returns to normal pace after recovery', () => {
    const queue = new QuotaPollQueue();
    let now = 1_000_000;
    for (const delay of [240_000, 480_000, 900_000, 900_000]) {
      queue.complete('rate-limited', now, false);
      expect(queue.next(['rate-limited'], now + delay - 1)).toBeUndefined();
      expect(queue.next(['rate-limited'], now + delay)).toBe('rate-limited');
      now += delay;
    }
    queue.complete('rate-limited', now, true);
    expect(queue.next(['rate-limited'], now + 120_000)).toBe('rate-limited');
  });

  test('removed accounts are pruned and a new session does not inherit cooldowns', () => {
    const queue = new QuotaPollQueue();
    queue.complete('removed', 1_000_000, false);
    expect(queue.next([], 1_000_000)).toBeUndefined();
    expect(queue.next(['removed'], 1_000_000)).toBe('removed');
    queue.complete('account', 1_000_000, true);
    expect(new QuotaPollQueue().next(['account'], 1_000_000)).toBe('account');
  });
});
