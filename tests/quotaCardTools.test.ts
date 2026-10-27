import { expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import type { AuthFileItem } from '@/types';
import { QuotaCardRequests } from '@/features/quota/components/QuotaCardRequests';
import { useQuotaAccountTools } from '@/features/quota/hooks/useQuotaAccountTools';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { apiClient, authFilesApi } from '@/services/api';
import { useNotificationStore } from '@/stores';

function Tools({ file, disabled = false }: { file: AuthFileItem; disabled?: boolean }) {
  return useQuotaAccountTools(disabled, async () => {}).actionsFor(file);
}

test('home request strip retains recent-window rate independently of cumulative counts', () => {
  const file = {
    name: 'fixture',
    successCount: 5,
    failureCount: 5,
    recentRequests: [{ success: 99, failed: 1 }],
  };
  const html = renderToStaticMarkup(createElement(QuotaCardRequests, { file, ready: true }));
  expect(html).toContain('99%');
  expect(html).not.toContain('50%');
  const pending = renderToStaticMarkup(createElement(QuotaCardRequests, { file, ready: false }));
  expect(pending).not.toContain('99%');
});

test('home account tools expose existing actions and honour provider capabilities', async () => {
  await i18n.changeLanguage('en');
  const claude = renderToStaticMarkup(
    createElement(Tools, { file: { name: 'fixture', type: 'claude' } })
  );
  expect(claude).toContain(i18n.t('auth_files.models_button'));
  expect(claude).toContain(i18n.t('auth_files.manual_refresh_button'));
  expect(claude).toContain(i18n.t('auth_files.download_button'));
  expect(claude).toContain(i18n.t('auth_files.prefix_proxy_button'));
  expect(claude).toContain(i18n.t('auth_files.delete_button'));
  expect(claude).toContain('type="checkbox"');
  const runtime = renderToStaticMarkup(
    createElement(Tools, { file: { name: 'runtime', type: 'claude', runtimeOnly: true } })
  );
  expect(runtime).not.toContain('<button');
});

test('cached or disconnected account tools cannot mutate files', () => {
  const html = renderToStaticMarkup(
    createElement(Tools, { file: { name: 'fixture', type: 'claude' }, disabled: true })
  );
  const buttons = html.match(/<button\b[^>]*>/g) ?? [];
  expect(buttons.length).toBeGreaterThan(4);
  expect(buttons.every((button) => button.includes('disabled'))).toBe(true);
});

test('a pending delete confirmation cannot delete from a newly selected connection', async () => {
  const revision = spyOn(apiClient, 'getConnectionRevision').mockReturnValue(10);
  const remove = spyOn(authFilesApi, 'deleteFile').mockImplementation(async () => {
    throw new Error('Deletion must not run after switching connections');
  });
  function DeleteHarness() {
    // SSR runs this fixture once; no browser interaction or live backend is involved.
    useAuthFilesData().handleDelete('fixture');
    return null;
  }
  try {
    renderToStaticMarkup(createElement(DeleteHarness));
    const confirmation = useNotificationStore.getState().confirmation.options;
    expect(confirmation).not.toBeNull();
    revision.mockReturnValue(11);
    await confirmation!.onConfirm();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    revision.mockRestore();
    remove.mockRestore();
    useNotificationStore.getState().hideConfirmation();
  }
});
