import { expect, test } from 'bun:test';
import { quotaAvailability } from '../src/features/quota/availability';

const score = (short: number, weekly: number) => quotaAvailability({
  name: 'test.json', displayName: 'test', provider: 'claude',
  quota: { status: 'success', windows: [
    { periodHours: 5, usedPercent: 100 - short, resetAtMs: Date.now() + 3600000 },
    { periodHours: 168, usedPercent: 100 - weekly, resetAtMs: Date.now() + 86400000 },
  ] } as Parameters<typeof quotaAvailability>[0]['quota'],
});
test('weekly exhaustion sorts last regardless of five-hour remaining', () => {
  expect(score(100, 0)).toBeLessThan(score(0, 80));
  expect(score(100, 0)).toBeLessThan(quotaAvailability({
    name: 'unknown', displayName: 'unknown', provider: 'claude', quota: undefined,
  }));
});
test('availability combines both windows without changing reported quota', () => {
  expect(score(80, 80)).toBe(80);
  expect(score(100, 25)).toBe(50);
  expect(score(80, 80)).toBeGreaterThan(score(100, 25));
});
