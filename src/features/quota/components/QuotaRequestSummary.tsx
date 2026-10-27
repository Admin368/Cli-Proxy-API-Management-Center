import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { toneForSuccessRate } from '@/features/dashboard/utils';
import styles from './QuotaRequestSummary.module.scss';

export function quotaRequestTotals(files: AuthFileItem[]) {
  const count = (value: number | undefined) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
  const success = files.reduce((sum, file) => sum + count(file.successCount), 0);
  const failure = files.reduce((sum, file) => sum + count(file.failureCount), 0);
  const total = success + failure;
  return { success, failure, total, rate: total > 0 ? (success / total) * 100 : null };
}

export function QuotaRequestSummary({ files, ready }: { files: AuthFileItem[]; ready: boolean }) {
  const { t, i18n } = useTranslation();
  const totals = quotaRequestTotals(files);
  const rate = ready ? totals.rate : null;
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  const percent = new Intl.NumberFormat(i18n.resolvedLanguage, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  return (
    <section
      className={styles.summary}
      data-tone={toneForSuccessRate(rate)}
      aria-label={t('quota_management.request_summary_scope')}
    >
      <span className={styles.label} title={t('quota_management.request_summary_scope')}>
        {t('dashboard.success_rate')}
      </span>
      <strong className={styles.rate}>{rate === null ? '—' : percent.format(rate / 100)}</strong>
      {rate !== null && (
        <meter
          className={styles.meter}
          min={0}
          max={100}
          value={rate}
          aria-label={t('dashboard.success_rate')}
        />
      )}
      <span className={styles.success}>
        {t('stats.success')} <b>{ready ? number.format(totals.success) : '—'}</b>
      </span>
      <span className={styles.failure}>
        {t('stats.failure')} <b>{ready ? number.format(totals.failure) : '—'}</b>
      </span>
      <span className={styles.scope}>
        {t(
          rate === null && ready
            ? 'quota_management.request_summary_empty'
            : 'quota_management.request_summary_scope'
        )}
      </span>
    </section>
  );
}
