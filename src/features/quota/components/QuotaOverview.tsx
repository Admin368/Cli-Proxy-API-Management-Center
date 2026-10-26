import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { formatRelativeInstant } from '@/utils/quota';
import { normalizeRecentRequestUsageEntry } from '@/utils/recentRequests';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { buildTimelineLane } from '../quotaTimelineModel';
import styles from './QuotaOverview.module.scss';

export function QuotaOverview({
  entries,
  quotaFor,
}: {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  if (!entries.length) return null;

  return (
    <section className={styles.overview} aria-labelledby="quota-overview-title">
      <div className={styles.heading}>
        <h2 id="quota-overview-title">{t('quota_management.overview_title')}</h2>
        <p>{t('quota_management.overview_hint')}</p>
      </div>
      <div className={styles.accounts}>
        {entries.map((entry) => {
          const quota = quotaFor(entry);
          const name = getQuotaDisplayName(entry.file);
          const lane = buildTimelineLane({
            name: getQuotaCacheKey(entry.file),
            displayName: name,
            provider: entry.type,
            quota,
          });
          const limits = lane.limits.length
            ? lane.limits
            : lane.remaining !== null
              ? [{ label: '', remaining: lane.remaining, resetAtMs: lane.anchorMs }]
              : [];
          const usage = normalizeRecentRequestUsageEntry(entry.file);
          const resetMs =
            lane.anchorMs !== null && Number.isFinite(lane.anchorMs) ? lane.anchorMs : null;
          const expired =
            (resetMs !== null && resetMs <= now) ||
            limits.some(
              (limit) => Number.isFinite(limit.resetAtMs) && (limit.resetAtMs ?? Infinity) <= now
            );
          const status = entry.file.disabled
            ? 'overview_disabled'
            : quota?.status === 'error'
              ? 'overview_error'
              : quota?.status === 'loading'
                ? 'overview_loading'
                : quota?.status === 'success'
                  ? 'overview_details'
                  : 'overview_pending';
          return (
            <article className={styles.account} key={`${entry.type}:${lane.name}`}>
              <header>
                <span className={styles.provider}>{entry.type}</span>
                <strong className={styles.name}>{name}</strong>
              </header>
              {limits.some(
                (limit) =>
                  Number.isFinite(limit.remaining) &&
                  (!Number.isFinite(limit.resetAtMs) || (limit.resetAtMs ?? 0) > now)
              ) && !entry.file.disabled ? (
                limits
                  .filter(
                    (limit) =>
                      Number.isFinite(limit.remaining) &&
                      (!Number.isFinite(limit.resetAtMs) || (limit.resetAtMs ?? 0) > now)
                  )
                  .map((limit, index) => (
                    <div className={styles.limit} key={`${limit.label}:${index}`}>
                      <div className={styles.limitLabel}>
                        <span>
                          {limit.label.startsWith('meta_quota.')
                            ? t(limit.label)
                            : limit.label || t('quota_management.overview_limit')}
                        </span>
                        <strong>
                          {t('quota_management.overview_remaining', {
                            percent: Math.round(limit.remaining),
                          })}
                        </strong>
                      </div>
                      <div
                        className={styles.track}
                        role="meter"
                        aria-label={`${name}: ${limit.label}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={limit.remaining}
                      >
                        <div
                          className={limit.remaining <= 15 ? styles.low : styles.fill}
                          style={{ width: `${limit.remaining}%` }}
                        />
                      </div>
                      {limit.resetAtMs != null && Number.isFinite(limit.resetAtMs) && (
                        <p className={styles.status}>
                          {t('quota_management.overview_reset', {
                            time: formatRelativeInstant(
                              limit.resetAtMs,
                              now,
                              i18n.resolvedLanguage
                            ),
                          })}
                        </p>
                      )}
                    </div>
                  ))
              ) : (
                <p className={styles.status}>
                  {t(`quota_management.${expired ? 'overview_expired' : status}`)}
                </p>
              )}
              <footer>
                {t('quota_management.overview_requests', {
                  success: usage.success,
                  failed: usage.failed,
                })}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
