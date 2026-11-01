import { expect, test } from 'bun:test';
import { hourlyUsage, usageSeries, HOUR } from '../src/features/usage/analytics';
import { normalizeUsageRecord } from '../src/services/api/usageRecords';
const now = Date.UTC(2026, 10, 1, 12, 30);
const row = (time: number, model: string, total?: number) =>
  normalizeUsageRecord({
    id: model + time,
    timestamp: new Date(time).toISOString(),
    model,
    source: 'account.json',
    tokens: total === undefined ? {} : { total_tokens: total },
  })!;
test('hourly buckets respect boundaries, future exclusion, gaps and partial current hour', () => {
  const result = hourlyUsage(
    [
      row(now, 'a', 20),
      row(now - HOUR, 'b', 30),
      row(now - 24 * HOUR, 'old', 100),
      row(now + 1, 'future', 100),
      row(now, 'unknown'),
    ],
    24,
    now
  );
  expect(result.buckets).toHaveLength(24);
  expect(result.selected).toHaveLength(3);
  expect(result.buckets.at(-1)?.total).toBe(20);
  expect(result.buckets.at(-1)?.requests).toBe(2);
  expect(result.buckets.at(-2)?.total).toBe(30);
  expect(result.buckets[0].total).toBe(0);
});
test('series cap preserves all token totals in Other', () => {
  const { buckets } = hourlyUsage(
    Array.from({ length: 8 }, (_, i) => row(now, String(i), 10)),
    24,
    now
  );
  const series = usageSeries(buckets, 'models');
  expect(series).toHaveLength(7);
  expect(series.at(-1)?.key).toBeNull();
  expect(series.reduce((sum, s) => sum + s.values.at(-1)!, 0)).toBe(80);
});
