import type { AuthFileItem } from '@/types';
import { summarizeCooldowns } from '@/features/authFiles/cooldowns';
import { isDisabledAuthFile } from '@/utils/quota/validators';
import { buildTimelineLane } from './quotaTimelineModel';
import type { QuotaProviderType } from './providers/types';

export type QuotaReadinessState = 'available' | 'cooldown' | 'unknown';

export interface QuotaReadiness {
  state: QuotaReadinessState;
  /** When the credential is expected to be usable again; null when not known. */
  untilMs: number | null;
}

const UNKNOWN: QuotaReadiness = { state: 'unknown', untilMs: null };

/**
 * Whether a credential can take requests right now.
 *
 * Cooldown means a quota window it depends on is exhausted (five-hour or
 * weekly at 0%), the backend reports a credential-wide cooldown, or it is
 * marked unavailable. Disabled or unread credentials make no claim either way.
 */
export function quotaReadiness(
  entry: { file: AuthFileItem; type: QuotaProviderType },
  quota: { status?: string } | undefined,
  nowMs: number
): QuotaReadiness {
  const { file, type } = entry;
  if (isDisabledAuthFile(file)) return UNKNOWN;

  const blockedUntil: number[] = [];
  let blocked = false;

  const snapshot = file.cooldownSnapshot;
  if (snapshot?.records?.length) {
    const summary = summarizeCooldowns(snapshot, nowMs);
    if (summary.credentialWide) {
      blocked = true;
      blockedUntil.push(nowMs + summary.earliestSeconds * 1000);
    }
  }
  if (file.unavailable) blocked = true;

  const read = quota?.status === 'success';
  if (read) {
    const input = { name: file.name, displayName: file.name, provider: type, quota };
    const short = buildTimelineLane({ ...input, maxPeriodHours: 5 });
    const long = buildTimelineLane({ ...input, maxPeriodHours: 336 });
    const exhausted = [
      short.periodHours === 5 ? short : null,
      (long.periodHours ?? 0) >= 168 ? long : null,
    ].filter((lane) => lane !== null && lane.remaining !== null && lane.remaining <= 0);
    for (const lane of exhausted) {
      blocked = true;
      if (lane!.anchorMs !== null && lane!.anchorMs > nowMs) blockedUntil.push(lane!.anchorMs);
    }
  }

  if (blocked) {
    // Every exhausted limit must recover before requests succeed again.
    return { state: 'cooldown', untilMs: blockedUntil.length ? Math.max(...blockedUntil) : null };
  }
  return read ? { state: 'available', untilMs: null } : UNKNOWN;
}

/** Stable partition: cooldown credentials keep their relative order after the rest. */
export function pushCooldownLast<T>(items: T[], isCooldown: (item: T) => boolean): T[] {
  const ready: T[] = [];
  const cooling: T[] = [];
  for (const item of items) (isCooldown(item) ? cooling : ready).push(item);
  return cooling.length ? [...ready, ...cooling] : items;
}
