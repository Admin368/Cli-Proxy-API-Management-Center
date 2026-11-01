import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('quota home starts with searchable cards, followed by day and weekly timelines', () => {
  const source = readFileSync('src/features/quota/QuotaPage.tsx', 'utf8');
  const search = source.indexOf('type="search"');
  const cards = source.indexOf('<QuotaCard');
  const day = source.indexOf('fixedMode="session"');
  const weekly = source.indexOf('fixedMode="weekly"');
  expect(search).toBeGreaterThan(0);
  expect(cards).toBeGreaterThan(search);
  expect(day).toBeGreaterThan(cards);
  expect(weekly).toBeGreaterThan(day);
  expect(source).not.toContain('<QuotaViews');
  expect(source).not.toContain('<QuotaOverview');
});
