import { normalizeUsageRecord, type UsageRecord } from './usageRecords';
import type { DesktopUsageConnection } from '@/features/usage/desktopConnection';

export function desktopUsageUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid desktop helper URL');
  }
  return url.origin;
}

/** Separate local extension: never send the Management API credential to the helper. */
export async function readDesktopUsage(
  connection: DesktopUsageConnection,
  backend: string,
  after: string
): Promise<{ records: UsageRecord[]; cursor: string; hasMore: boolean }> {
  const response = await fetch(
    `${desktopUsageUrl(connection.url)}/records?after=${encodeURIComponent(after)}`,
    {
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'X-Usage-Backend': backend.replace(/\/+$/, ''),
      },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!response.ok) throw new Error(`Desktop helper HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !('items' in data) ||
    !Array.isArray(data.items) ||
    !('cursor' in data) ||
    typeof data.cursor !== 'string' ||
    !/^\d{1,16}$/.test(data.cursor) ||
    !('hasMore' in data) ||
    typeof data.hasMore !== 'boolean' ||
    data.items.length > 500 ||
    (data.hasMore && BigInt(data.cursor) <= BigInt(after))
  ) {
    throw new Error('Invalid desktop helper response');
  }
  return {
    records: data.items.flatMap((row) => {
      const record = normalizeUsageRecord(row);
      if (!record) throw new Error('Invalid desktop history record');
      return [record];
    }),
    cursor: data.cursor,
    hasMore: data.hasMore,
  };
}
