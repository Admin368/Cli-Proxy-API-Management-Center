import { useTranslation } from 'react-i18next';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { statusBarDataFromRecentRequests } from '@/utils/recentRequests';
import { formatFileSize } from '@/utils/format';
import { formatModified } from '@/features/authFiles/constants';
import authStyles from '@/features/authFiles/components/AuthFileCard.module.scss';
import type { AuthFileItem } from '@/types';
import styles from './QuotaCardRequests.module.scss';

export function QuotaCardRequests({ file, ready }: { file: AuthFileItem; ready: boolean }) {
  const { t } = useTranslation();
  const history = statusBarDataFromRecentRequests(ready ? (file.recentRequests ?? []) : []);
  return (
    <div className={styles.requests}>
      <div className={styles.counts}>
        <span>{t('auth_files.card_requests')}</span>
        <span className={styles.success}>
          {t('stats.success')} {ready ? (file.successCount ?? 0) : '—'}
        </span>
        <span className={styles.failure}>
          {t('stats.failure')} {ready ? (file.failureCount ?? 0) : '—'}
        </span>
      </div>
      <ProviderStatusBar
        statusData={history}
        styles={{
          ...authStyles,
          statusBlock: styles.block,
          statusRate: `${authStyles.statusRate} ${styles.rate}`,
        }}
      />
      <div className={styles.metadata}>
        <span title={t('auth_files.file_size')}>
          {ready && file.size ? formatFileSize(file.size) : '—'}
        </span>
        <span title={t('auth_files.file_modified')}>{ready ? formatModified(file) : '—'}</span>
        {ready && Number.isSafeInteger(file.priority) && (
          <span title={t('auth_files.priority_hint')}>
            {t('auth_files.priority_display')} {file.priority}
          </span>
        )}
      </div>
    </div>
  );
}
