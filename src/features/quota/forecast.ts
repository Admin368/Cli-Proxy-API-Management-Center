import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';
import { buildTimelineLane } from './quotaTimelineModel';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { usageFingerprint } from '@/services/api/usageRecords';

export type ForecastWindow = 'session' | 'weekly';
export interface QuotaObservation {
  id: string;
  provider: string;
  window: ForecastWindow;
  at: number;
  remaining: number;
  reset: number;
  period: number;
}
export const quotaObservationId = (entry: QuotaFileEntry) =>
  usageFingerprint(
    entry.file.authIndex != null
      ? 'auth:' + String(entry.file.authIndex).trim()
      : 'file:' + getQuotaCacheKey(entry.file)
  );
const PREFIX = 'quota.observations.v1.';
const HOUR = 3_600_000;
export const FORECAST_EVENT = 'quota-observations-updated';

export function observationFor(
  entry: QuotaFileEntry,
  quota: QuotaCardState,
  at: number
): QuotaObservation[] {
  if (
    quota.status !== 'success' ||
    quota.cachedAt ||
    !quota.readAt ||
    !Number.isFinite(quota.readAt) ||
    quota.readAt > at
  )
    return [];
  at = quota.readAt;
  return (['session', 'weekly'] as const).flatMap((window) => {
    const lane = buildTimelineLane({
      name: getQuotaCacheKey(entry.file),
      displayName: '',
      provider: entry.type,
      quota,
      maxPeriodHours: window === 'session' ? 5 : 336,
    });
    if (
      lane.remaining === null ||
      lane.anchorMs === null ||
      !lane.periodHours ||
      lane.anchorMs <= at ||
      (window === 'session' ? lane.periodHours > 5 : lane.periodHours < 24)
    )
      return [];
    return [
      {
        id: quotaObservationId(entry),
        provider: entry.type,
        window,
        at,
        remaining: lane.remaining,
        reset: lane.anchorMs,
        period: lane.periodHours,
      },
    ];
  });
}
export function mergeObservations(
  previous: QuotaObservation[],
  incoming: QuotaObservation[],
  now: number
) {
  const rows = new Map<string, QuotaObservation>();
  for (const row of [...previous, ...incoming]) {
    if (
      !/^[a-f0-9]{64}$/.test(row.id) ||
      typeof row.provider !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(row.provider) ||
      !['session', 'weekly'].includes(row.window) ||
      ![row.at, row.remaining, row.reset, row.period].every(Number.isFinite) ||
      row.at > now ||
      row.at < now - 14 * 24 * HOUR ||
      row.remaining < 0 ||
      row.remaining > 100 ||
      row.period <= 0
    )
      continue;
    rows.set(`${row.id}:${row.window}:${row.at}`, {
      id: row.id,
      provider: row.provider,
      window: row.window,
      at: row.at,
      remaining: row.remaining,
      reset: row.reset,
      period: row.period,
    });
  }
  return [...rows.values()].sort((a, b) => a.at - b.at).slice(-5000);
}
export function readObservations(scope: string): QuotaObservation[] {
  try {
    const rows: unknown = JSON.parse(localStorage.getItem(PREFIX + scope) ?? '[]');
    if (!Array.isArray(rows)) return [];
    return mergeObservations(
      [],
      rows.filter((row) => row && typeof row === 'object'),
      Date.now()
    );
  } catch {
    return [];
  }
}
export function saveObservations(scope: string, incoming: QuotaObservation[]) {
  if (!incoming.length) return;
  try {
    const previous = readObservations(scope);
    const next = mergeObservations(previous, incoming, Date.now());
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    localStorage.setItem(PREFIX + scope, JSON.stringify(next));
    window.dispatchEvent(new Event(FORECAST_EVENT));
  } catch {
    /* Forecast stays unavailable rather than inventing historical readings. */
  }
}

/** Percent-points per hour, measured within one reset window, excluding long observation gaps. */
export function quotaBurnRate(rows: QuotaObservation[], now: number, hours: number): number | null {
  const sorted = [...rows]
    .filter((r) => r.at <= now && r.at >= now - hours * HOUR)
    .sort((a, b) => a.at - b.at);
  const latest = sorted[sorted.length - 1];
  if (!latest || now - latest.at > 30 * 60_000 || latest.reset <= now) return null;
  let elapsed = 0,
    consumed = 0;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1],
      b = sorted[i];
    const gap = b.at - a.at;
    if (
      Math.abs(a.reset - latest.reset) > 60_000 ||
      Math.abs(b.reset - latest.reset) > 60_000 ||
      gap <= 0 ||
      gap > HOUR ||
      b.remaining > a.remaining
    )
      continue;
    elapsed += gap;
    consumed += a.remaining - b.remaining;
  }
  return elapsed >= 5 * 60_000 ? consumed / (elapsed / HOUR) : null;
}
export function projectedRemaining(row: QuotaObservation, rate: number, at: number) {
  if (at < row.at || rate < 0) return null;
  if (at < row.reset) return Math.max(0, row.remaining - (rate * (at - row.at)) / HOUR);
  const sinceReset = (at - row.reset) % (row.period * HOUR);
  return Math.max(0, 100 - (rate * sinceReset) / HOUR);
}

/** Null points are intentional gaps: never carry a quota reading through an unobserved hour. */
export function poolHistory(rows: QuotaObservation[], ids: string[], at: number): number | null {
  if (!ids.length) return null;
  let sum = 0;
  for (const id of ids) {
    const row = rows.filter((r) => r.id === id && r.at <= at).sort((a, b) => b.at - a.at)[0];
    if (!row || at - row.at > HOUR || row.reset <= at) return null;
    sum += row.remaining;
  }
  return sum;
}

/** Include actual observation times so short histories remain visible on a long chart. */
export function poolHistorySeries(
  rows: QuotaObservation[],
  ids: string[],
  from: number,
  until: number
) {
  const allowed = new Set(ids);
  const sorted = rows
    .filter((row) => allowed.has(row.id) && row.at <= until)
    .sort((a, b) => a.at - b.at);
  const times = [
    ...new Set([
      ...sorted.filter((row) => row.at >= from).map((row) => row.at),
      ...Array.from({ length: 61 }, (_, i) => from + ((until - from) * i) / 60),
    ]),
  ].sort((a, b) => a - b);
  const latest = new Map<string, QuotaObservation>();
  let cursor = 0;
  return times.map((at) => {
    while (cursor < sorted.length && sorted[cursor].at <= at) {
      latest.set(sorted[cursor].id, sorted[cursor]);
      cursor++;
    }
    let value: number | null = ids.length ? 0 : null;
    for (const id of ids) {
      const row = latest.get(id);
      if (!row || at - row.at > HOUR || row.reset <= at) {
        value = null;
        break;
      }
      value! += row.remaining;
    }
    return { at, value };
  });
}
