import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { readQuotaRefreshMinutes, writeQuotaRefreshMinutes } from '../livePolling';
import styles from './QuotaRefreshSettings.module.scss';

export function QuotaRefreshSettings() {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState(readQuotaRefreshMinutes);
  return (
    <section className={styles.settings}>
      <label>
        {t('quota_management.refresh_interval')}
        <select
          value={minutes}
          onChange={(event) => {
            const value = Number(event.target.value);
            setMinutes(value);
            writeQuotaRefreshMinutes(value);
          }}
        >
          {Array.from({ length: 60 }, (_, index) => index + 1).map((value) => (
            <option key={value} value={value}>
              {t('quota_management.refresh_minutes', { count: value })}
            </option>
          ))}
        </select>
      </label>
      <p>{t('quota_management.refresh_interval_hint')}</p>
    </section>
  );
}
