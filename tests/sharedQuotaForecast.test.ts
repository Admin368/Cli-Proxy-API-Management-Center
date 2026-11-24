import { expect, test } from 'bun:test';
import { untouchedPreferences } from '@/features/quota/preferenceEvents';
import { quotaObservationId } from '@/features/quota/forecast';
import { snapshotFile } from '@/features/quota/snapshot';

test('remote preferences cannot overwrite changes made during hydration', () => {
  expect(
    untouchedPreferences(
      { window: 'weekly', horizon: 168, sortMode: 'default' },
      new Set(['window', 'sortMode'])
    )
  ).toEqual({ horizon: 168 });
});
test('quota account identity survives a saved snapshot and reload', () => {
  const file = { name: 'fixture.json', provider: 'claude', authIndex: 'account-index' };
  const saved = snapshotFile(file);
  expect(quotaObservationId({ type: 'claude', file: saved })).toBe(
    quotaObservationId({ type: 'claude', file })
  );
});
