export const QUOTA_PREFERENCE_CHANGE = 'quota-preference-change';
export const QUOTA_PREFERENCE_RESTORE = 'quota-preference-restore';

export function announceQuotaPreferenceChange(patch: Record<string, unknown>) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(QUOTA_PREFERENCE_CHANGE, { detail: patch }));
  }
}

/** A slow initial read must never undo a selection made while it was pending. */
export function untouchedPreferences(
  remote: Record<string, unknown>,
  dirty: Set<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(remote).filter(([key]) => !dirty.has(key)));
}
