import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QUOTA_CLASS_KEYS } from '@/features/quota/types';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { QUOTA_ADAPTERS } from '@/features/quota/providers';
import {
  resolveSavedQuota,
  snapshotIdentity,
  snapshotKey,
  type QuotaSnapshot,
} from '@/features/quota/snapshot';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';

mock.module('../src/features/quota/components/QuotaBody.module.scss', () => ({
  default: Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
}));
const { QuotaCard } = await import('@/features/quota/components/QuotaCard');

const file: AuthFileItem = { name: 'fixture.json', type: 'claude', disabled: true };

test('disabled card remains visible and explains missing saved quota', async () => {
  await i18n.changeLanguage('en');
  const html = renderToStaticMarkup(
    createElement(QuotaCard, {
      entry: { file, type: 'claude' },
      resolvedTheme: 'light',
      canRefresh: false,
      resetting: false,
      onRefresh: () => {},
      onReset: () => {},
    })
  );
  expect(html).toContain('<article');
  expect(html).toContain('Disabled');
  expect(html).toContain('no saved quota yet');
  expect(html).toContain('disabled');
});

test('read-only quota monitoring reads disabled credentials without changing their status', async () => {
  const fetch = spyOn(QUOTA_ADAPTERS.claude, 'fetchQuota').mockResolvedValue({
    windows: [],
    dollarWindows: [],
    planType: null,
    observedAt: '2026-10-27T12:00:00Z',
  });
  function DisabledBatch() {
    void useQuotaBatchLoader().loadQuota([{ file, type: 'claude' }]);
    return null;
  }
  try {
    renderToStaticMarkup(createElement(DisabledBatch));
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(file);
    expect(file.disabled).toBe(true);
  } finally {
    fetch.mockRestore();
  }
});

test('disabling an unchanged credential does not invalidate its saved observation', () => {
  const enabled = { ...file, disabled: false };
  const value: ClaudeQuotaState = { status: 'success', windows: [] };
  const snapshot: QuotaSnapshot = {
    savedAt: 1000,
    files: [enabled],
    quotas: {
      [snapshotKey('claude', enabled)]: {
        identity: snapshotIdentity(enabled),
        savedAt: 1000,
        type: 'claude',
        value,
      },
    },
  };
  expect(resolveSavedQuota('claude', file, undefined, snapshot, false, false)?.cachedAt).toBe(1000);
});

test('a status-only mtime change retains the same known account, never another account or credential edit', () => {
  const original: AuthFileItem = {
    ...file,
    disabled: false,
    authIndex: 'index',
    email: 'fixture@example.test',
    modified: 100,
  };
  const value: ClaudeQuotaState = { status: 'success', windows: [] };
  const snapshot: QuotaSnapshot = {
    savedAt: 1000,
    files: [original],
    quotas: {
      [snapshotKey('claude', original)]: {
        identity: snapshotIdentity(original),
        savedAt: 1000,
        type: 'claude',
        value,
      },
    },
  };
  const paused = { ...original, disabled: true, modified: 200 };
  expect(resolveSavedQuota('claude', paused, undefined, snapshot, false, false)?.cachedAt).toBe(
    1000
  );
  expect(resolveSavedQuota('claude', paused, undefined, snapshot, true, false)).toBeUndefined();
  expect(
    resolveSavedQuota(
      'claude',
      { ...paused, email: 'other@example.test' },
      undefined,
      snapshot,
      false,
      false
    )
  ).toBeUndefined();
  expect(
    resolveSavedQuota(
      'claude',
      { ...paused, authIndex: 'other-index' },
      undefined,
      snapshot,
      false,
      false
    )
  ).toBeUndefined();
  expect(
    resolveSavedQuota('claude', { ...original, modified: 200 }, undefined, snapshot, false, false)
  ).toBeUndefined();
});
