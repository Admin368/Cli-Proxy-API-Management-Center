import type { AuthFileItem } from '@/types';

export function quotaRequestTotals(files: AuthFileItem[]) {
  const count = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const success = files.reduce((sum, file) => sum + count(file.successCount), 0);
  const failure = files.reduce((sum, file) => sum + count(file.failureCount), 0);
  const total = success + failure;
  return { success, failure, total, rate: total > 0 ? (success / total) * 100 : null };
}
