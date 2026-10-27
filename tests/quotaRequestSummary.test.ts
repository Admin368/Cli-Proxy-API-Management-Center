import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '@/i18n';
import {
  QuotaRequestSummary,
  quotaRequestTotals,
} from '@/features/quota/components/QuotaRequestSummary';

test('request success rate weights account totals rather than averaging account percentages', () => {
  expect(
    quotaRequestTotals([
      { name: 'a', successCount: 90, failureCount: 10 },
      { name: 'b', successCount: 0, failureCount: 900 },
    ])
  ).toEqual({ success: 90, failure: 910, total: 1000, rate: 9 });
});

test('missing or invalid counts never fabricate a perfect success rate', () => {
  expect(quotaRequestTotals([{ name: 'a', successCount: NaN, failureCount: -3 }]).rate).toBeNull();
  expect(quotaRequestTotals([]).rate).toBeNull();
});

test('summary exposes a meter only after request data is available', () => {
  const files = [{ name: 'a', successCount: 80, failureCount: 20 }];
  const loaded = renderToStaticMarkup(createElement(QuotaRequestSummary, { files, ready: true }));
  expect(loaded).toContain('<meter');
  expect(loaded).toContain('value="80"');
  expect(loaded).not.toContain('>a<');
  const pending = renderToStaticMarkup(createElement(QuotaRequestSummary, { files, ready: false }));
  expect(pending).not.toContain('<meter');
  expect(pending).toContain('—');
});
