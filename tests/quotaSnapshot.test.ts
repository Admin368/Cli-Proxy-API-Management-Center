import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaSnapshotNotice } from '@/features/quota/components/QuotaSnapshotNotice';
import { QUOTA_CLASS_KEYS } from '@/features/quota/types';
import { QUOTA_TAB_ORDER } from '@/features/quota/constants';
import {
  clearSavedQuotaSnapshots,
  quotaSnapshotScope,
  readQuotaSnapshot,
  resolveSavedQuota,
  sanitizeQuota,
  snapshotFile,
  snapshotIdentity,
  snapshotKey,
  writeQuotaSnapshot,
  type QuotaSnapshot,
} from '@/features/quota/snapshot';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
mock.module('../src/features/quota/components/QuotaBody.module.scss', () => ({
  default: Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
}));
const { QuotaCard } = await import('@/features/quota/components/QuotaCard');
const saved = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
    removeItem: (key: string) => {
      saved.delete(key);
    },
    key: (index: number) => [...saved.keys()][index] ?? null,
    get length() {
      return saved.size;
    },
  },
});
afterAll(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});
beforeEach(() => saved.clear());

const now = Date.now();
const file = { name: 'personal.json', type: 'codex', authIndex: '7', modified: 100 };
const scope = quotaSnapshotScope('http://backend-a', 'fake-management-key');
const value = sanitizeQuota('codex', {
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'Weekly',
      usedPercent: 37,
      resetAtMs: now + 60_000,
      periodHours: 168,
    },
  ],
  access_token: 'DO-NOT-SAVE-TOKEN',
  account: 'DO-NOT-SAVE-ACCOUNT',
  raw: { key: 'DO-NOT-SAVE-RAW' },
})!;
const snapshot = (): QuotaSnapshot => ({
  savedAt: now,
  files: [snapshotFile({ ...file, account: 'DO-NOT-SAVE-ACCOUNT' })],
  quotas: {
    [snapshotKey('codex', file)]: {
      type: 'codex',
      identity: snapshotIdentity(file),
      savedAt: now,
      value,
    },
  },
});

describe('saved quota snapshots', () => {
  test('restores last successful quota on reload without persisting credentials', () => {
    writeQuotaSnapshot(scope, snapshot());
    const restored = readQuotaSnapshot(scope, now)!;
    expect(restored.files[0]).toEqual(file);
    const quota = resolveSavedQuota('codex', file, undefined, restored, false, true);
    expect(quota).toMatchObject({ status: 'success', cachedAt: now, refreshing: true });
    expect(quota).toMatchObject({ windows: [{ usedPercent: 37 }] });
    const storage = JSON.stringify([...saved]);
    expect(storage).not.toContain('fake-management-key');
    expect(storage).not.toContain('DO-NOT-SAVE');
  });

  test('backend and management-key changes cannot restore another connection', () => {
    writeQuotaSnapshot(scope, snapshot());
    expect(
      readQuotaSnapshot(quotaSnapshotScope('http://backend-b', 'fake-management-key'), now)
    ).toBeNull();
    expect(
      readQuotaSnapshot(quotaSnapshotScope('http://backend-a', 'different-key'), now)
    ).toBeNull();
  });

  test('saved request counts preserve numeric strings without copying account fields', () => {
    expect(snapshotFile({ ...file, success: '42', failed: '3', account: 'DO-NOT-SAVE' })).toEqual({
      ...file,
      success: 42,
      failed: 3,
    });
  });

  test('failure retains saved values, fresh success replaces them, mutations reject them', () => {
    const state = snapshot();
    const failed = { status: 'error' as const, error: 'unavailable' };
    expect(resolveSavedQuota('codex', file, failed, state, false, false)).toMatchObject({
      cachedAt: now,
      refreshFailed: true,
    });
    const fresh = { status: 'success' as const, windows: [] };
    expect(resolveSavedQuota('codex', file, fresh, state, false, false)).toBe(fresh);
    expect(resolveSavedQuota('codex', file, undefined, state, true, false)).toBeUndefined();
    expect(
      resolveSavedQuota(
        'codex',
        { ...file, authIndex: 'other-account' },
        undefined,
        state,
        false,
        false
      )
    ).toBeUndefined();
    expect(
      resolveSavedQuota('codex', { ...file, modified: 200 }, undefined, state, false, false)
    ).toBeUndefined();
  });

  test('rejects expired, corrupt, oversized, and incompatible saved data', () => {
    writeQuotaSnapshot(scope, snapshot());
    expect(readQuotaSnapshot(scope, now + 8 * 24 * 60 * 60_000)).toBeNull();
    const key = [...saved.keys()][0];
    for (const raw of [
      '{bad',
      'null',
      JSON.stringify({ savedAt: now, files: null }),
      'x'.repeat(2_000_001),
    ]) {
      saved.set(key, raw);
      expect(readQuotaSnapshot(scope, now)).toBeNull();
    }
  });

  test('logout removes saved quotas without touching unrelated preferences', () => {
    saved.set('quotaPage.live', 'true');
    writeQuotaSnapshot(scope, snapshot());
    writeQuotaSnapshot(quotaSnapshotScope('http://other', 'other'), snapshot());
    clearSavedQuotaSnapshots();
    expect(readQuotaSnapshot(scope, now)).toBeNull();
    expect([...saved]).toEqual([['quotaPage.live', 'true']]);
  });

  test('cached values have distinct waiting, updating, and failed labels', () => {
    const cached = { ...value, cachedAt: now };
    for (const [state, key] of [
      [cached, 'snapshot_waiting'],
      [{ ...cached, refreshing: true }, 'snapshot_updating'],
      [{ ...cached, refreshFailed: true }, 'snapshot_failed'],
    ] as const) {
      const html = renderToStaticMarkup(createElement(QuotaSnapshotNotice, { quota: state }));
      expect(html).toContain(i18n.t(`quota_management.${key}`));
      expect(html).toContain('dateTime=');
    }
  });

  test('cached quota cards keep their values while updating and disable reset actions', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaCard, {
        entry: { type: 'codex', file },
        quota: { ...value, cachedAt: now, refreshing: true },
        resolvedTheme: 'light',
        canRefresh: true,
        resetting: false,
        onRefresh() {},
        onReset() {},
      })
    );
    expect(html).toContain('Weekly');
    expect(html).toContain('63%');
    expect(html).toContain(i18n.t('quota_management.snapshot_updating'));
    expect(html).not.toContain(i18n.t('codex_quota.reset_button'));
  });

  test('every provider can render sanitized saved observations without credential fields', () => {
    for (const type of QUOTA_TAB_ORDER) {
      const quota = sanitizeQuota(type, {
        status: 'success',
        windows: [
          {
            id: null,
            label: null,
            usedPercent: 25,
            remainingPercent: 75,
            resetAtMs: now + 60_000,
            periodHours: 5,
          },
        ],
        groups: [
          {
            id: 'group',
            label: 'Group',
            buckets: [{ id: 'bucket', label: null, remainingFraction: 0.5 }],
          },
        ],
        summary: [{ key: 'remaining', label: 'Remaining', value: 50 }],
        rows: [{ id: 'weekly', label: 'Weekly', used: 25, limit: 100 }],
        data: { windows: [] },
        billing: null,
        access_token: 'DO-NOT-SAVE',
      })!;
      expect(JSON.stringify(quota)).not.toContain('DO-NOT-SAVE');
      expect(() =>
        renderToStaticMarkup(
          createElement(QuotaCard, {
            entry: { type, file: { name: 'fixture.json', type } },
            quota: { ...quota, cachedAt: now },
            resolvedTheme: 'light',
            canRefresh: false,
            resetting: false,
            onRefresh() {},
            onReset() {},
          })
        )
      ).not.toThrow();
    }
  });
});
