import { expect, mock, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { apiClient } from '@/services/api/client';
import { desktopErrorKey } from '@/features/usage/useUsageRecords';
import { desktopUsageUrl, pluginUsageUrl, readDesktopUsage } from '@/services/api/desktopUsage';
import {
  readDesktopUsageConnection,
  writeDesktopUsageConnection,
} from '@/features/usage/desktopConnection';

test('desktop helper enforces auth, isolation, pagination, and read-only database access', () => {
  const output = execFileSync('python', ['tests/helpers/desktop_usage_helper_test.py'], {
    encoding: 'utf8',
  });
  expect(output).toBe('');
}, 15000);

test('desktop helper URL rejects remote servers, credentials and paths', () => {
  expect(desktopUsageUrl('http://127.0.0.1:8318')).toBe('http://127.0.0.1:8318');
  for (const url of [
    'https://example.com',
    'http://localhost:8318',
    'http://key@127.0.0.1',
    'http://127.0.0.1/other',
  ]) {
    expect(() => desktopUsageUrl(url)).toThrow();
  }
});

test('desktop extension uses only its dedicated token and rejects stalled pagination', async () => {
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ items: [], cursor: '5', hasMore: false }))
  );
  try {
    const result = await readDesktopUsage(
      { kind: 'helper', url: 'http://127.0.0.1:8318', token: 'fixture-helper' },
      'http://backend.test/',
      '0'
    );
    expect(result.cursor).toBe('5');
    const options = fetch.mock.calls[0][1];
    expect(options?.headers).toEqual({
      Authorization: 'Bearer fixture-helper',
      'X-Usage-Backend': 'http://backend.test',
    });
    expect(options?.redirect).toBe('error');
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ items: [], cursor: '0', hasMore: true }))
    );
    expect(
      readDesktopUsage(
        { kind: 'helper', url: 'http://127.0.0.1:8318', token: 'fixture' },
        'http://backend.test',
        '0'
      )
    ).rejects.toThrow();
  } finally {
    fetch.mockRestore();
  }
});

test('plugin source reads through the signed-in Management API and never calls the helper', async () => {
  const fetch = spyOn(globalThis, 'fetch');
  const get = mock(async () => ({ items: [], cursor: '7', hasMore: false }));
  const capture = spyOn(apiClient, 'captureConnection').mockReturnValue({
    get,
  } as unknown as ReturnType<typeof apiClient.captureConnection>);
  try {
    const result = await readDesktopUsage({ kind: 'plugin' }, 'http://100.64.0.1:8317/', '3');
    expect(result.cursor).toBe('7');
    expect(get.mock.calls[0][0]).toBe(
      'http://100.64.0.1:8317/v0/management/plugins/custom-web-ui/usage-records?after=3'
    );
    expect(fetch).not.toHaveBeenCalled();
    get.mockResolvedValue({ items: [], cursor: '3', hasMore: true });
    expect(readDesktopUsage({ kind: 'plugin' }, 'http://backend.test', '3')).rejects.toThrow();
  } finally {
    capture.mockRestore();
    fetch.mockRestore();
  }
  expect(pluginUsageUrl('http://backend.test', '0')).toBe(
    'http://backend.test/v0/management/plugins/custom-web-ui/usage-records?after=0'
  );
});

test('stored desktop sources keep working: legacy helper entries and the plugin source', () => {
  /* bun has no sessionStorage; install a Map-backed stub and restore the global afterwards. */
  const original = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  const store = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  try {
    checkStoredSources();
  } finally {
    if (original === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else (globalThis as { sessionStorage?: unknown }).sessionStorage = original;
  }
});

test('plugin source failures point at the plugin, not the helper token', () => {
  expect(desktopErrorKey({ kind: 'plugin' })).toBe('desktop_plugin_error');
  expect(desktopErrorKey({ kind: 'helper', url: 'http://127.0.0.1:8318', token: 't' })).toBe(
    'desktop_error'
  );
});

function checkStoredSources() {
  sessionStorage.setItem(
    'usagePage.desktop:legacy',
    JSON.stringify({ url: 'http://127.0.0.1:8318', token: 'x'.repeat(32) })
  );
  expect(readDesktopUsageConnection('legacy')).toEqual({
    kind: 'helper',
    url: 'http://127.0.0.1:8318',
    token: 'x'.repeat(32),
  });
  writeDesktopUsageConnection('plugin', { kind: 'plugin' });
  expect(readDesktopUsageConnection('plugin')).toEqual({ kind: 'plugin' });
  sessionStorage.setItem('usagePage.desktop:bad', JSON.stringify({ kind: 'other' }));
  expect(readDesktopUsageConnection('bad')).toBeNull();
}
