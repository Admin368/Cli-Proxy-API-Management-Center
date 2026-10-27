import { useTranslation } from 'react-i18next';
import type { QuotaCardState } from '../providers';
import styles from './QuotaSnapshotNotice.module.scss';

export function QuotaSnapshotNotice({ quota }: { quota?: QuotaCardState }) {
  const { t, i18n } = useTranslation();
  if (!quota?.cachedAt) return null;
  const key = quota.refreshFailed
    ? 'snapshot_failed'
    : quota.refreshing
      ? 'snapshot_updating'
      : 'snapshot_waiting';
  return (
    <p className={styles.notice} role="status" aria-busy={quota.refreshing || undefined}>
      {t(`quota_management.${key}`)}{' '}
      <time dateTime={new Date(quota.cachedAt).toISOString()}>
        {t('quota_management.snapshot_saved_at', {
          time: new Date(quota.cachedAt).toLocaleString(i18n.resolvedLanguage),
        })}
      </time>
    </p>
  );
}
