import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import type { ResolvedTheme } from '@/types';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { QUOTA_PAGE_SIZE } from '../constants';
import { buildTimelineLane, laneHasWindow } from '../quotaTimelineModel';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { readQuotaView, writeQuotaView, type QuotaView } from '../viewPreference';
import { QuotaOverview } from './QuotaOverview';
import { QuotaTimeline } from './QuotaTimeline';
import styles from './QuotaViews.module.scss';

const displayNameFor = (name: string) => name;

export function QuotaViews({
  entries,
  quotaFor,
  resolvedTheme,
  initialView,
}: {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  resolvedTheme: ResolvedTheme;
  initialView?: QuotaView;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<QuotaView>(() => initialView ?? readQuotaView());
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(entries.length / QUOTA_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const timelineEntries = entries.slice(
    (currentPage - 1) * QUOTA_PAGE_SIZE,
    currentPage * QUOTA_PAGE_SIZE
  );
  const hasTimeline = timelineEntries.some((entry) =>
    laneHasWindow(
      buildTimelineLane({
        name: getQuotaCacheKey(entry.file),
        displayName: getQuotaDisplayName(entry.file),
        provider: entry.type,
        quota: quotaFor(entry),
      })
    )
  );

  return (
    <section className={styles.views}>
      <div className={styles.controls} role="group" aria-label={t('quota_management.view_label')}>
        {(['overview', 'timeline'] as const).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={view === value ? 'primary' : 'secondary'}
            aria-pressed={view === value}
            onClick={() => {
              setView(value);
              writeQuotaView(value);
            }}
          >
            {t(`quota_management.view_${value}`)}
          </Button>
        ))}
      </div>
      {view === 'overview' ? (
        <QuotaOverview entries={entries} quotaFor={quotaFor} />
      ) : (
        <>
          {hasTimeline ? (
            <QuotaTimeline
              entries={timelineEntries}
              quotaFor={quotaFor}
              displayNameFor={displayNameFor}
              resolvedTheme={resolvedTheme}
            />
          ) : (
            <EmptyState
              title={t('quota_management.timeline_waiting')}
              description={t('quota_management.timeline_waiting_hint')}
            />
          )}
          {totalPages > 1 && (
            <div className={styles.controls}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={currentPage === 1}
                onClick={() => setPage(currentPage - 1)}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <span>
                {t('quota_management.timeline_page', { current: currentPage, total: totalPages })}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={currentPage === totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
