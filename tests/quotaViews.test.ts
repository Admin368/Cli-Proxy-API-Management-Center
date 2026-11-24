import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaViews } from '@/features/quota/components/QuotaViews';
import { readQuotaView, writeQuotaView } from '@/features/quota/viewPreference';

test('both quota designs are selectable and timeline has an explicit pending state', () => {
  const props = {
    entries: [{ type: 'claude' as const, file: { name: 'personal.json', type: 'claude' } }],
    quotaFor: () => undefined,
    resolvedTheme: 'light' as const,
  };
  const overview = renderToStaticMarkup(
    createElement(QuotaViews, { ...props, initialView: 'overview' })
  );
  expect(overview).toContain(i18n.t('quota_management.overview_title'));
  expect(overview).toContain('aria-pressed="true"');
  const timeline = renderToStaticMarkup(
    createElement(QuotaViews, { ...props, initialView: 'timeline' })
  );
  expect(timeline).toContain(i18n.t('quota_management.timeline_waiting'));
  expect(timeline).not.toContain(i18n.t('quota_management.overview_title'));
});

test('timeline uses bounded pages over all accounts, independent of detail pagination', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    type: 'claude' as const,
    file: { name: `account-${index}.json`, type: 'claude' },
  }));
  const html = renderToStaticMarkup(
    createElement(QuotaViews, {
      entries,
      resolvedTheme: 'light',
      initialView: 'timeline',
      quotaFor: () => ({
        status: 'success',
        windows: [
          {
            label: 'Weekly',
            usedPercent: 25,
            periodHours: 168,
            resetAtMs: Date.now() + 86_400_000,
          },
        ],
      }),
    })
  );
  expect(html).toContain('account-19.json');
  expect(html).not.toContain('account-20.json');
  expect(html).toContain(i18n.t('quota_management.timeline_page', { current: 1, total: 2 }));
});

test('view preference persists and invalid stored values fall back safely', () => {
  const original = (globalThis as { window?: unknown }).window;
  let value: string | null = null;
  try {
    Object.assign(globalThis, {
      window: {
        localStorage: {
          getItem: () => value,
          setItem: (_key: string, next: string) => {
            value = next;
          },
        },
      },
    });
    expect(readQuotaView()).toBe('overview');
    writeQuotaView('timeline');
    expect(readQuotaView()).toBe('timeline');
    writeQuotaView('overview');
    expect(readQuotaView()).toBe('overview');
    value = 'invalid';
    expect(readQuotaView()).toBe('overview');
  } finally {
    if (original === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.assign(globalThis, { window: original });
  }
});
