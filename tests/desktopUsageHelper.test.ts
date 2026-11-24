import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { desktopUsageUrl, readDesktopUsage } from '@/services/api/desktopUsage';

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
      { url: 'http://127.0.0.1:8318', token: 'fixture-helper' },
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
        { url: 'http://127.0.0.1:8318', token: 'fixture' },
        'http://backend.test',
        '0'
      )
    ).rejects.toThrow();
  } finally {
    fetch.mockRestore();
  }
});
