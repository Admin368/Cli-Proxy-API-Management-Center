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

test('refresh-all does not issue quota requests for disabled cards', async () => {
  const fetch = spyOn(QUOTA_ADAPTERS.claude, 'fetchQuota').mockImplementation(async () => {
    throw new Error('Disabled credentials must not be queried');
  });
  function DisabledBatch() {
    void useQuotaBatchLoader().loadQuota([{ file, type: 'claude' }]);
    return null;
  }
  try {
    renderToStaticMarkup(createElement(DisabledBatch));
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
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
