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
