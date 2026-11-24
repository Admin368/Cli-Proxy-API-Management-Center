import type { UsageRecord } from '@/services/api/usageRecords';
import { usageAccountKey } from './analytics';

export function accountUsageSummary(records: UsageRecord[]) {
  const groups = new Map<
    string,
    {
      key: string;
      requests: number;
      total: number;
      known: number;
      cacheRead: number;
      cacheWrite: number;
      cacheInput: number;
      cacheKnown: number;
      output: number;
      writeKnown: number;
      outputKnown: number;
      failures: number;
    }
  >();
  for (const r of records) {
    const key = usageAccountKey(r);
    const group = groups.get(key) ?? {
      key,
      requests: 0,
      total: 0,
      known: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheInput: 0,
      cacheKnown: 0,
      output: 0,
      writeKnown: 0,
      outputKnown: 0,
      failures: 0,
    };
    group.requests++;
    group.total += r.total ?? 0;
    group.known += Number(r.total !== null);
    group.cacheWrite += r.cacheWrite ?? 0;
    group.writeKnown += Number(r.cacheWrite !== null);
    group.outputKnown += Number(r.output !== null);
    group.output += r.output ?? 0;
    group.failures += Number(r.failed || r.canceled);
    if (r.input !== null && r.input > 0 && r.cacheRead !== null && r.cacheRead <= r.input) {
      group.cacheRead += r.cacheRead;
      group.cacheInput += r.input;
      group.cacheKnown++;
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}
