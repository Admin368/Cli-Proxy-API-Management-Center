import { afterAll, expect, test } from 'bun:test';
import React from 'react';
import i18n from '@/i18n';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuotaForecast } from '@/features/quota/components/QuotaForecast';
import { quotaObservationId } from '@/features/quota/forecast';
import type { QuotaFileEntry } from '@/features/quota/logic';

const savedWindow = (globalThis as { window?: unknown }).window;
const savedStorage = (globalThis as { localStorage?: unknown }).localStorage;
afterAll(() => {
  if (savedWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = savedWindow;
  if (savedStorage === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
  else (globalThis as { localStorage?: unknown }).localStorage = savedStorage;
});
test('an account with readings remains visible when another account has no history', () => {
  const now = Date.now();
  const entries: QuotaFileEntry[] = [
    { type: 'claude', file: { name: 'a.json', authIndex: 'a' } },
    { type: 'claude', file: { name: 'b.json', authIndex: 'b' } },
  ];
  const rows = [20, 10].map((minutes, index) => ({
    id: quotaObservationId(entries[0]),
    provider: 'claude',
    window: 'weekly',
    at: now - minutes * 60000,
    remaining: 80 - index * 10,
    reset: now + 86400000,
    period: 168,
  }));
  const storage = {
    getItem: (key: string) => (key.startsWith('quota.observations.') ? JSON.stringify(rows) : null),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  const markup = renderToStaticMarkup(
    React.createElement(QuotaForecast, { scope: 'fixture', entries, quotaFor: () => undefined })
  );
  expect(markup).toContain('polyline');
  expect(markup).toContain('opacity="0.45"');
  expect(markup).toContain('opacity="0.5"');
  expect(markup).toContain('r="2.5"');
});

test('normalized account tooltip uses the plotted pool units and preserves account context', async () => {
  const language = i18n.language;
  await i18n.changeLanguage('en');
  const now = Date.now();
  const entries: QuotaFileEntry[] = ['a', 'b', 'c', 'd'].map((name) => ({
    type: 'claude',
    file: { name: name + '.json', authIndex: name },
  }));
  const rows = [
    {
      id: quotaObservationId(entries[0]),
      provider: 'claude',
      window: 'weekly',
      at: now - 60000,
      remaining: 92,
      reset: now + 86400000,
      period: 168,
    },
  ];
  const storage = {
    getItem: (key: string) =>
      key.startsWith('quota.observations.')
        ? JSON.stringify(rows)
        : JSON.stringify({ scale: 'normalized' }),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  const markup = renderToStaticMarkup(
    React.createElement(QuotaForecast, {
      scope: 'fixture',
      entries,
      quotaFor: () => undefined,
    })
  );
  expect(markup).toContain('23% on chart (92% of this account remaining)');
  expect(markup).toContain('opacity="0.45"');
  expect(markup).toContain('combined pool remaining');
  await i18n.changeLanguage(language);
});
