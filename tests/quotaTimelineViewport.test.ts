import { expect, test } from 'bun:test';
import { compactCredentialLabel } from '@/features/quota/credentialLabel';
import { earliestActiveWindowStart, timelineScrollLeft } from '@/features/quota/timelineViewport';
import { HOUR_MS, type TimelineLane } from '@/features/quota/quotaTimelineModel';

test('credential labels remove only the generated hash and JSON extension', () => {
  expect(compactCredentialLabel('claude-597f6b81-first-last@example.test.json')).toBe(
    'claude-first-last@example.test'
  );
  expect(compactCredentialLabel('codex-1234abcd-person@example.test-plus.JSON')).toBe(
    'codex-person@example.test-plus'
  );
  expect(compactCredentialLabel('my-personal-account.json')).toBe('my-personal-account');
  expect(compactCredentialLabel('claude-deadbeef.json')).toBe('claude-deadbeef');
});

test('five-hour viewport starts at the earliest observed active window', () => {
  const now = 12 * HOUR_MS;
  const lane = (anchorMs: number): TimelineLane => ({
    name: 'fixture',
    displayName: 'fixture',
    provider: 'claude',
    anchorMs,
    periodHours: 5,
    remaining: 50,
    limits: [],
    resetCredits: [],
  });
  expect(
    earliestActiveWindowStart([lane(now + HOUR_MS), lane(now + 3 * HOUR_MS)], 0, 24 * HOUR_MS, now)
  ).toBe(now - 4 * HOUR_MS);
  expect(earliestActiveWindowStart([lane(now - HOUR_MS)], 0, 24 * HOUR_MS, now)).toBeNull();
  expect(earliestActiveWindowStart([lane(HOUR_MS)], 0, 24 * HOUR_MS, 0)).toBe(0);
});

test('scrolling accounts for the fixed credential column and clamps to chart bounds', () => {
  expect(timelineScrollLeft('session', 500, 0, 1000, 1000, 300)).toBe(488);
  expect(timelineScrollLeft('weekly', 500, 0, 1000, 1000, 300)).toBe(350);
  expect(timelineScrollLeft('session', 1000, 0, 1000, 1000, 300)).toBe(700);
  expect(timelineScrollLeft('session', -1, 0, 1000, 1000, 300)).toBe(0);
  expect(timelineScrollLeft('session', 500, 0, 1000, 1000, 1200)).toBe(0);
});
