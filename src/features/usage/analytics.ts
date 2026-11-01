import type { UsageRecord } from '@/services/api/usageRecords';

export const HOUR = 3_600_000;
export interface UsageBucket {
  at: number;
  total: number;
  requests: number;
  models: Record<string, number>;
  accounts: Record<string, number>;
}
/** Half-open hourly buckets; missing total tokens remain unknown, never inferred by summing
 * overlapping input/cache/reasoning fields. End includes the current partial hour. */
export function hourlyUsage(records: UsageRecord[], hours: number, now: number) {
  const end = Math.floor(now / HOUR) * HOUR + HOUR;
  const start = end - hours * HOUR;
  const buckets: UsageBucket[] = Array.from({ length: hours }, (_, i) => ({
    at: start + i * HOUR,
    total: 0,
    requests: 0,
    models: {},
    accounts: {},
  }));
  const selected = records.filter((r) => r.timestamp >= start && r.timestamp <= now);
  for (const r of selected) {
    const b = buckets[Math.floor((r.timestamp - start) / HOUR)];
    b.requests++;
    if (r.total === null) continue;
    b.total += r.total;
    b.models[r.model] = (b.models[r.model] ?? 0) + r.total;
    b.accounts[r.source] = (b.accounts[r.source] ?? 0) + r.total;
  }
  return { buckets, selected };
}
export function usageSeries(buckets: UsageBucket[], dimension: 'models' | 'accounts') {
  const totals = new Map<string, number>();
  for (const b of buckets)
    for (const [key, value] of Object.entries(b[dimension])) {
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  const keys = [...totals.keys()].sort(
    (a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b)
  );
  const top = keys.slice(0, 6);
  return [
    ...top.map((key) => ({ key, values: buckets.map((b) => b[dimension][key] ?? 0) })),
    ...(keys.length > 6
      ? [
          {
            key: null,
            values: buckets.map((b) =>
              keys.slice(6).reduce((sum, key) => sum + (b[dimension][key] ?? 0), 0)
            ),
          },
        ]
      : []),
  ];
}
