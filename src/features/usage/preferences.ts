export const COLUMNS = ['source', 'key', 'cache', 'timing', 'speed', 'cost'] as const;
export type UsageColumn = (typeof COLUMNS)[number];
const KEY = 'usagePage.display';
export function readUsagePreferences(): { columns: UsageColumn[]; pageSize: number } {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      const row = saved as Record<string, unknown>;
      return {
        columns: Array.isArray(row.columns)
          ? [
              ...new Set(
                row.columns.filter(
                  (value: unknown): value is UsageColumn =>
                    typeof value === 'string' && COLUMNS.some((column) => column === value)
                )
              ),
            ]
          : [...COLUMNS],
        pageSize: [25, 50, 100].includes(Number(row.pageSize)) ? Number(row.pageSize) : 50,
      };
    }
  } catch {
    /* Display preferences remain usable without browser storage. */
  }
  return { columns: [...COLUMNS], pageSize: 50 };
}
export function writeUsagePreferences(columns: UsageColumn[], pageSize: number) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ columns, pageSize }));
  } catch {
    /* Preferences still apply for this page visit. */
  }
}

const COLLECTION_KEY = 'usagePage.collection';
/** Opt-in is scoped to the backend and credential fingerprint, never the raw key. */
export function readUsageCollection(scope: string): boolean {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(COLLECTION_KEY) ?? 'null');
    return Array.isArray(saved) && saved.includes(scope);
  } catch {
    return false;
  }
}
export function writeUsageCollection(scope: string, enabled: boolean) {
  const saved: unknown = JSON.parse(window.localStorage.getItem(COLLECTION_KEY) ?? 'null');
  const scopes = new Set(Array.isArray(saved) ? saved.filter((s) => typeof s === 'string') : []);
  if (enabled) scopes.add(scope);
  else scopes.delete(scope);
  window.localStorage.setItem(COLLECTION_KEY, JSON.stringify([...scopes]));
}
export function clearUsageCollection() {
  try {
    window.localStorage.removeItem(COLLECTION_KEY);
  } catch {
    // Storage may be disabled.
  }
}
