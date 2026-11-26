import { describe, expect, test } from 'bun:test';
import type { AuthFileItem } from '../src/types';
import { pushCooldownLast, quotaReadiness } from '../src/features/quota/readiness';

const NOW = Date.UTC(2026, 10, 26, 12);
const HOUR = 3_600_000;

const file = (extra: Partial<AuthFileItem> = {}) =>
  ({ name: 'claude-test.json', type: 'claude', ...extra }) as AuthFileItem;

const claude = (short: number, weekly: number) => ({
  status: 'success',
  windows: [
    { periodHours: 5, usedPercent: 100 - short, resetAtMs: NOW + 2 * HOUR },
    { periodHours: 168, usedPercent: 100 - weekly, resetAtMs: NOW + 48 * HOUR },
  ],
});

const readiness = (quota: unknown, extra?: Partial<AuthFileItem>) =>
  quotaReadiness({ file: file(extra), type: 'claude' }, quota as { status?: string }, NOW);

describe('quota readiness', () => {
  test('a credential with quota left in every window is available', () => {
    expect(readiness(claude(87, 76))).toEqual({ state: 'available', untilMs: null });
  });

  test('an exhausted weekly window is cooldown until that reset', () => {
    expect(readiness(claude(100, 0))).toEqual({ state: 'cooldown', untilMs: NOW + 48 * HOUR });
  });

  test('an exhausted five-hour window is cooldown until its reset', () => {
    expect(readiness(claude(0, 50))).toEqual({ state: 'cooldown', untilMs: NOW + 2 * HOUR });
  });

  test('both exhausted waits for the later reset', () => {
    expect(readiness(claude(0, 0)).untilMs).toBe(NOW + 48 * HOUR);
  });

  test('unread and disabled credentials make no claim', () => {
    expect(readiness(undefined).state).toBe('unknown');
    expect(readiness({ status: 'error' }).state).toBe('unknown');
    expect(readiness(claude(0, 0), { disabled: true }).state).toBe('unknown');
  });

  test('backend credential cooldown and unavailable flag count as cooldown', () => {
    expect(readiness(claude(90, 90), { unavailable: true }).state).toBe('cooldown');
    const cooled = readiness(claude(90, 90), {
      cooldownSnapshot: {
        receivedAtMs: NOW,
        records: [{ scope: 'credential', remainingSeconds: 600 }],
      },
    } as unknown as Partial<AuthFileItem>);
    expect(cooled).toEqual({ state: 'cooldown', untilMs: NOW + 600_000 });
  });
});

describe('pushCooldownLast', () => {
  test('moves cooldown items to the end and keeps both groups in order', () => {
    expect(pushCooldownLast([1, 2, 3, 4, 5], (n) => n % 2 === 0)).toEqual([1, 3, 5, 2, 4]);
  });

  test('returns the same array when nothing is cooling down', () => {
    const items = [1, 3];
    expect(pushCooldownLast(items, () => false)).toBe(items);
  });
});
