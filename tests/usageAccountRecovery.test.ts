import { expect, test } from 'bun:test';
import {
  normalizeUsageRecord,
  restoreUsageRecord,
  usageFingerprint,
} from '@/services/api/usageRecords';
import {
  mergeUsageRecords,
  parseUsageCsv,
  usageCsv,
  usageFiltersFromHash,
  filterUsageRecords,
} from '@/features/usage/model';
import { hourlyUsage } from '@/features/usage/analytics';
import { accountUsageSummary } from '@/features/usage/accountSummary';
import { parseRequestLog } from '@/features/usage/requestLog';
import {
  observationFor,
  mergeObservations,
  quotaBurnRate,
  projectedRemaining,
  poolHistory,
  poolHistorySeries,
  type QuotaObservation,
} from '@/features/quota/forecast';

const now = Date.UTC(2026, 10, 4, 10);
const hour = 3_600_000;
const record = (auth: string, id = auth) =>
  normalizeUsageRecord({
    id,
    timestamp: new Date(now).toISOString(),
    auth_index: auth,
    source: 'fixture-secret-key',
    log_request_id: 'request-123',
    model: 'fixture-model',
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 80,
    total_tokens: 110,
  })!;

test('account identities survive cache/CSV and recovering a row replaces unknown attribution', () => {
  const a = record('fixture-account-a');
  const b = record('fixture-account-b');
  expect(a.accountId).toBe(usageFingerprint('auth:fixture-account-a'));
  expect(a.source).toBe('');
  expect(a.requestId).toBe('request-123');
  expect(restoreUsageRecord(a)).toEqual(a);
  expect(parseUsageCsv(usageCsv([a]))).toEqual([a]);
  const old = { ...a };
  delete old.accountId;
  delete old.requestId;
  const merged = mergeUsageRecords([old], [a, b], now);
  expect(merged).toHaveLength(2);
  expect(merged.every((r) => r.accountId)).toBe(true);
  const { buckets } = hourlyUsage(merged, 24, now);
  expect(Object.keys(buckets.at(-1)!.accounts)).toHaveLength(2);
  expect(JSON.stringify(merged)).not.toContain('fixture-secret-key');
  expect(JSON.stringify(merged)).not.toContain('fixture-account-a');
});

test('account cache share only uses paired known measurements and never merges accounts by client key', () => {
  const a = record('a');
  const groups = accountUsageSummary([
    a,
    { ...a, id: 'other', input: null, cacheRead: 1000 },
    record('b'),
  ]);
  expect(groups).toHaveLength(2);
  const group = groups.find((g) => g.key === a.accountId)!;
  expect(group.cacheRead / group.cacheInput).toBe(0.8);
  expect(group.cacheKnown).toBe(1);
  expect(group.outputKnown).toBe(2);
  expect(group.writeKnown).toBe(0);
});

test('request inspection extracts bodies while omitting header sections', () => {
  const parsed = parseRequestLog(
    '=== REQUEST INFO ===\nURL: /v1/messages\n=== HEADERS ===\nAuthorization: Bearer fixture-secret\n=== REQUEST BODY ===\n{"messages":[{"role":"user","content":"hello"}]}\n=== RESPONSE ===\nStatus: 200\nSet-Cookie: private-cookie\n\ndata: {"output":"hello"}\n'
  );
  expect(parsed.request).toContain('messages');
  expect(parsed.response).toContain('data:');
  expect(parsed.status).toBe('200');
  expect(JSON.stringify(parsed)).not.toContain('fixture-secret');
  expect(JSON.stringify(parsed)).not.toContain('private-cookie');
  expect(parseRequestLog('unrecognized log').request).toBe('');
});

test('chart links select a half-open hour and account with no rolling-time exclusion', () => {
  const a = record('a');
  const filters = usageFiltersFromHash(
    `#/usage?from=${now}&to=${now + hour}&source=${a.accountId}`
  );
  expect(filters.hours).toBe(0);
  expect(
    filterUsageRecords(
      [a, record('b'), { ...a, id: 'end', timestamp: now + hour }],
      filters,
      now + hour
    )
  ).toEqual([a]);
});

const sample = (at: number, remaining: number, reset = now + hour): QuotaObservation => ({
  id: usageFingerprint('account'),
  provider: 'claude',
  window: 'session',
  at,
  remaining,
  reset,
  period: 5,
});
test('forecast measures depletion only within a reset window with fresh and sufficiently spaced observations', () => {
  const rows = [sample(now - hour, 80), sample(now, 60)];
  expect(quotaBurnRate(rows, now, 3)).toBe(20);
  expect(quotaBurnRate([sample(now, 60)], now, 3)).toBeNull();
  expect(quotaBurnRate(rows, now + 31 * 60_000, 3)).toBeNull();
  expect(
    quotaBurnRate([sample(now - hour, 80, now), sample(now, 100, now + 5 * hour)], now, 3)
  ).toBeNull();
  expect(quotaBurnRate([sample(now - 2 * hour, 100), sample(now, 50)], now, 3)).toBeNull();
  expect(quotaBurnRate([sample(now - hour, 60), sample(now, 80)], now, 3)).toBeNull();
});
test('projection clamps exhausted quotas and resets to 100; history does not bridge gaps', () => {
  const row = sample(now, 10);
  expect(projectedRemaining(row, 20, now + hour / 2)).toBe(0);
  expect(projectedRemaining(row, 20, now + hour)).toBe(100);
  expect(projectedRemaining(row, 20, now + 2 * hour)).toBe(80);
  expect(poolHistory([row], [row.id], now)).toBe(10);
  expect(poolHistory([row], [row.id], now + 2 * hour)).toBeNull();
  expect(poolHistory([row], [row.id, usageFingerprint('missing')], now)).toBeNull();
});
test('observation history deduplicates and strips unapproved fields', () => {
  const row = sample(now, 10);
  const merged = mergeObservations(
    [row],
    [{ ...row, remaining: 20, secret: 'fixture' } as QuotaObservation],
    now
  );
  expect(merged).toHaveLength(1);
  expect(merged[0].remaining).toBe(20);
  expect(JSON.stringify(merged)).not.toContain('secret');
  expect(
    mergeObservations([], [sample(now + 1, 50), sample(now - 15 * 24 * hour, 50)], now)
  ).toEqual([]);
});

test('forecast captures actual read time and refuses cache-only or undated readings', () => {
  const entry = { type: 'claude' as const, file: { name: 'fixture.json', authIndex: 'a' } };
  const quota = {
    status: 'success' as const,
    readAt: now,
    windows: [
      { id: 'five-hour', usedPercent: 20, resetAtMs: now + hour, periodHours: 5 },
      { id: 'weekly', usedPercent: 40, resetAtMs: now + 24 * hour, periodHours: 168 },
    ],
  };
  const rows = observationFor(entry, quota, now + 10 * 60_000);
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.at === now)).toBe(true);
  expect(observationFor(entry, { ...quota, cachedAt: now }, now)).toEqual([]);
  expect(observationFor(entry, { ...quota, readAt: undefined }, now)).toEqual([]);
});

test('historical pool chart includes short observation intervals and preserves missing-account gaps', () => {
  const a = sample(now - 10 * 60_000, 70),
    b = sample(now - 5 * 60_000, 65);
  const points = poolHistorySeries([a, b], [a.id], now - 7 * 24 * hour, now);
  expect(points.some((point) => point.at === a.at && point.value === 70)).toBe(true);
  expect(points.some((point) => point.at === b.at && point.value === 65)).toBe(true);
  expect(points[0].value).toBeNull();
  expect(
    poolHistorySeries([a], [a.id, usageFingerprint('missing')], a.at, now).every(
      (point) => point.value === null
    )
  ).toBe(true);
});
