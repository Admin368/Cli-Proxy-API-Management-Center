import { expect, test } from 'bun:test';
import { lastMeasuredForecast } from '@/features/quota/retainedForecast';
import type { QuotaObservation } from '@/features/quota/forecast';
const hour = 3_600_000;
const start = Date.UTC(2026, 10, 4);
const sample = (at: number, remaining: number, reset = start + 24 * hour): QuotaObservation => ({
  id: 'account',
  provider: 'claude',
  window: 'weekly',
  at,
  remaining,
  reset,
  period: 168,
});

test('retains measured inputs across stale readings, reloads and a new incomplete window', () => {
  const rows = [sample(start, 80), sample(start + hour / 2, 70)];
  const expected = { latest: rows[1], rate: 20 };
  expect(lastMeasuredForecast(rows, start + 3 * hour, 3)).toEqual(expected);
  const reloaded = JSON.parse(JSON.stringify(rows));
  expect(lastMeasuredForecast(reloaded, start + 3 * hour, 3)).toEqual(expected);
  rows.push(sample(start + 25 * hour, 90, start + 8 * 24 * hour));
  expect(lastMeasuredForecast(rows, start + 25 * hour, 3)).toEqual(expected);
  rows.push(sample(start + 25.5 * hour, 85, start + 8 * 24 * hour));
  expect(lastMeasuredForecast(rows, start + 26 * hour, 3)).toEqual({ latest: rows[3], rate: 10 });
});

test('does not invent a projection from missing, single or gapped observations', () => {
  expect(lastMeasuredForecast([], start, 3)).toBeNull();
  expect(lastMeasuredForecast([sample(start, 80)], start + hour, 3)).toBeNull();
  expect(
    lastMeasuredForecast([sample(start, 80), sample(start + 2 * hour, 60)], start + 3 * hour, 3)
  ).toBeNull();
});
