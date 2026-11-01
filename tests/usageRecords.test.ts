import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { UsagePage } from '@/features/usage/UsagePage';
import { readUsagePreferences, writeUsagePreferences } from '@/features/usage/preferences';
import { apiClient } from '@/services/api/client';
import {
  normalizeUsageRecord,
  usageFingerprint,
  usageRecordsApi,
  restoreUsageRecord,
} from '@/services/api/usageRecords';
import {
  filterUsageRecords,
  mergeUsageRecords,
  parseUsageCsv,
  usageCsv,
  USAGE_RETENTION_MS,
} from '@/features/usage/model';

const now = Date.UTC(2026, 9, 27, 12);
const raw = {
  request_id: 'fixture-request',
  timestamp: new Date(now).toISOString(),
  model: 'fixture-model',
  provider: 'claude',
  source: 'claude-1234abcd-fixture@example.test.json',
  api_key: 'fixture-client-secret',
  failed: false,
  latency_ms: 5000,
  ttft_ms: 1000,
  tokens: {
    input_tokens: 100,
    output_tokens: 20,
    reasoning_tokens: 5,
    cache_read_tokens: 80,
    total_tokens: 120,
  },
};

test('request page renders collection off with filters and import/export controls', async () => {
  await i18n.changeLanguage('en');
  const get = spyOn(apiClient, 'get').mockResolvedValue([]);
  try {
    const html = renderToStaticMarkup(createElement(UsagePage));
    expect(html).toContain('Request details');
    expect(html).toContain('Import desktop CSV');
    expect(html).toContain('Export filtered CSV');
    const toggle = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).not.toContain('checked');
    expect(get).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
  }
});

test('display preferences persist only recognized columns and page sizes', () => {
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
    writeUsagePreferences(['source', 'timing'], 25);
    expect(readUsagePreferences()).toEqual({ columns: ['source', 'timing'], pageSize: 25 });
    saved.set('usagePage.display', '{"columns":["source","source","invalid"],"pageSize":-5}');
    expect(readUsagePreferences()).toEqual({ columns: ['source'], pageSize: 50 });
    saved.set('usagePage.display', 'invalid json');
    expect(readUsagePreferences().columns).toHaveLength(6);
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.assign(globalThis, { window: original });
  }
});

test('queue records retain metrics without keys, headers, arbitrary sources, or failure bodies', () => {
  const record = normalizeUsageRecord({
    ...raw,
    response_headers: { authorization: 'fixture-upstream-secret' },
    fail: { body: 'fixture-failure-secret' },
  })!;
  expect(record.total).toBe(120);
  expect(record.ttftMs).toBe(1000);
  expect(record.keyId).toBe(usageFingerprint(raw.api_key));
  const saved = JSON.stringify(record);
  for (const secret of [raw.api_key, 'fixture-upstream-secret', 'fixture-failure-secret'])
    expect(saved).not.toContain(secret);
  expect(normalizeUsageRecord({ ...raw, source: raw.api_key })!.source).toBe('');
  expect(
    normalizeUsageRecord({ ...raw, api_key: 'secret.json', source: 'secret.json' })!.source
  ).toBe('');
});

test('unknown metrics stay unavailable and canceled failures are distinguishable', () => {
  expect(normalizeUsageRecord(null)).toBeNull();
  expect(normalizeUsageRecord({ ...raw, timestamp: 'invalid' })).toBeNull();
  const record = normalizeUsageRecord({
    ...raw,
    failed: true,
    fail: { status_code: 499 },
    tokens: {},
    latency_ms: undefined,
    ttft_ms: -1,
  })!;
  expect(record.canceled).toBe(true);
  expect(record.total).toBeNull();
  expect(record.ttftMs).toBeNull();
  expect(record.cost).toBeNull();
});

test('restoring browser records drops corrupt rows and unexpected properties', () => {
  const record = normalizeUsageRecord(raw)!;
  expect(restoreUsageRecord({ ...record, rawSecret: 'fixture-secret' })).toEqual(record);
  expect(restoreUsageRecord({ ...record, timestamp: Infinity })).toBeNull();
  expect(restoreUsageRecord({ ...record, id: 'not-a-record-id' })).toBeNull();
  expect(restoreUsageRecord(null)).toBeNull();
});

test('different executions of one trace do not overwrite each other', () => {
  const a = normalizeUsageRecord({ ...raw, execution_id: 'execution-a' })!;
  const b = normalizeUsageRecord({ ...raw, execution_id: 'execution-b' })!;
  expect(mergeUsageRecords([a], [a, b], now)).toHaveLength(2);
});

test('history deduplicates, sorts, caps, and expires records', () => {
  const current = normalizeUsageRecord(raw)!;
  const old = { ...current, id: 'old', timestamp: now - USAGE_RETENTION_MS - 1 };
  expect(mergeUsageRecords([old, current], [current], now)).toEqual([current]);
  const records = Array.from({ length: 10_005 }, (_, index) => ({
    ...current,
    id: String(index),
    timestamp: now - index,
  }));
  const merged = mergeUsageRecords([], records, now);
  expect(merged).toHaveLength(10_000);
  expect(merged[0].timestamp).toBe(now);
});

test('filters combine without changing stored records', () => {
  const current = normalizeUsageRecord(raw)!;
  const other = { ...current, id: 'other', failed: true, model: 'other-model' };
  const filters = {
    hours: 24,
    model: 'fixture-model',
    source: '',
    key: current.keyId,
    result: 'success',
    search: 'claude',
  };
  expect(filterUsageRecords([current, other], filters, now)).toEqual([current]);
  expect(filterUsageRecords([current], { ...filters, hours: 1 }, now + 2 * 60 * 60_000)).toEqual(
    []
  );
  expect(
    filterUsageRecords([other], { ...filters, model: '', search: '', result: 'failure' }, now)
  ).toEqual([other]);
});

test('desktop CSV handles BOM, escaped quotes, embedded commas/newlines, and optional metrics', () => {
  const csv =
    '\uFEFFid,timestamp,failed,model,input_tokens,output_tokens,estimated_cost_usd\r\n"csv-id","2026-10-27T12:00:00Z",false,"model,""quoted""\nvariant",10,20,0.03\r\n';
  const records = parseUsageCsv(csv);
  expect(records).toHaveLength(1);
  expect(records[0].model).toBe('model,"quoted"\nvariant');
  expect(records[0].total).toBe(30);
  expect(records[0].cost).toBe(0.03);
  expect(() => parseUsageCsv('id,timestamp\nx,y')).toThrow();
  expect(() => parseUsageCsv('id,timestamp,failed\n"unclosed')).toThrow();
});

test('sanitized CSV round-trips without duplicate IDs and guards spreadsheet formulas', () => {
  const record = normalizeUsageRecord(raw)!;
  const restored = parseUsageCsv(usageCsv([record]));
  expect(restored).toEqual([record]);
  const dangerous = { ...record, model: '\u0000 =WEBSERVICE("fixture")' };
  expect(usageCsv([dangerous])).toContain("'\u0000 =WEBSERVICE");
  expect(usageCsv([record])).not.toContain(raw.api_key);
});

test('explicit collection uses only the verified v8 queue domain endpoint', async () => {
  const get = spyOn(apiClient, 'get').mockResolvedValue([raw]);
  try {
    const records = await usageRecordsApi.collect();
    expect(records).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('/observability/usage/queue', {
      params: { count: 200 },
      timeout: 15_000,
    });
  } finally {
    get.mockRestore();
  }
});
