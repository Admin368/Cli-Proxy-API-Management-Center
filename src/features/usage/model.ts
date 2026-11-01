import { normalizeUsageRecord, type UsageRecord } from '@/services/api/usageRecords';

export const MAX_USAGE_RECORDS = 10_000;
export const USAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function mergeUsageRecords(previous: UsageRecord[], incoming: UsageRecord[], now: number) {
  const records = new Map(previous.map((record) => [record.id, record]));
  incoming.forEach((record) => records.set(record.id, record));
  return [...records.values()]
    .filter((record) => record.timestamp >= now - USAGE_RETENTION_MS)
    .sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id))
    .slice(0, MAX_USAGE_RECORDS);
}

export interface UsageFilters {
  hours: number;
  model: string;
  source: string;
  key: string;
  result: string;
  search: string;
}
export function filterUsageRecords(records: UsageRecord[], filters: UsageFilters, now: number) {
  const search = filters.search.trim().toLowerCase();
  return records.filter(
    (record) =>
      (!filters.hours || record.timestamp >= now - filters.hours * 60 * 60_000) &&
      (!filters.model || record.model === filters.model) &&
      (!filters.source || record.source === filters.source) &&
      (!filters.key || record.keyId === filters.key) &&
      (!filters.result ||
        (filters.result === 'canceled'
          ? record.canceled
          : filters.result === 'failure'
            ? record.failed && !record.canceled
            : !record.failed && !record.canceled)) &&
      (!search ||
        [record.model, record.source, record.provider, record.effort]
          .join(' ')
          .toLowerCase()
          .includes(search))
  );
}

export function parseUsageCsv(csv: string): UsageRecord[] {
  if (csv.length > 20_000_000) throw new Error('CSV exceeds 20 MB');
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  const source = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(field);
      field = '';
      if (char !== ',') {
        if (char === '\r' && source[index + 1] === '\n') index++;
        rows.push(row);
        row = [];
        if (rows.length > 100_001) throw new Error('Too many CSV rows');
      }
    } else field += char;
  }
  if (quoted) throw new Error('Unclosed CSV field');
  if (field || row.length) rows.push([...row, field]);
  const headers = rows.shift() ?? [];
  if (
    !headers.includes('timestamp') ||
    !headers.includes('failed') ||
    (!headers.includes('id') && !headers.includes('request_id'))
  ) {
    throw new Error('Not a desktop usage export');
  }
  return rows.flatMap((cells) => {
    const record = normalizeUsageRecord(
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
    );
    return record ? [record] : [];
  });
}

export function usageCsv(records: UsageRecord[]): string {
  const headers = [
    'id',
    'timestamp',
    'model',
    'provider',
    'source',
    'api_key_hash',
    'failed',
    'canceled',
    'reasoning_effort',
    'input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'total_tokens',
    'latency_ms',
    'ttft_ms',
    'estimated_cost_usd',
  ];
  const cell = (value: unknown) => {
    let text = value == null ? '' : String(value);
    const first = [...text].find((char) => char.charCodeAt(0) > 31 && char.trim() !== '') ?? '';
    if (['=', '+', '@', '-'].includes(first)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return (
    '\uFEFF' +
    [
      headers,
      ...records.map((r) => [
        r.id,
        new Date(r.timestamp).toISOString(),
        r.model,
        r.provider,
        r.source,
        r.keyId,
        r.failed,
        r.canceled,
        r.effort,
        r.input,
        r.output,
        r.reasoning,
        r.cacheRead,
        r.cacheWrite,
        r.total,
        r.latencyMs,
        r.ttftMs,
        r.cost,
      ]),
    ]
      .map((row) => row.map(cell).join(','))
      .join('\r\n')
  );
}
