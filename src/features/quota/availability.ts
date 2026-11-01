import { buildTimelineLane, type TimelineLaneInput } from './quotaTimelineModel';

/** Unknown readings follow measured availability; exhausted weekly quota is last. */
export function quotaAvailability(input: TimelineLaneInput): number {
  const short = buildTimelineLane({ ...input, maxPeriodHours: 5 });
  const long = buildTimelineLane({ ...input, maxPeriodHours: 336 });
  const weekly = (long.periodHours ?? 0) >= 168 ? long.remaining : null;
  if (weekly === 0) return -2;
  const fiveHour = short.periodHours === 5 ? short.remaining : null;
  if (fiveHour === null && weekly === null) return -1;
  if (fiveHour === null) return weekly!;
  if (weekly === null) return fiveHour;
  return Math.sqrt(fiveHour * weekly);
}

export function readAvailabilityPreference(scope: string): boolean {
  try {
    return localStorage.getItem('quota.availability.' + scope) === 'true';
  } catch {
    return false;
  }
}

export function saveAvailabilityPreference(scope: string, enabled: boolean): void {
  try {
    localStorage.setItem('quota.availability.' + scope, String(enabled));
  } catch {
    // Sorting still works when browser persistence is unavailable.
  }
}
