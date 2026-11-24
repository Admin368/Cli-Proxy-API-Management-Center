import { RequestInspector } from './RequestInspector';
import { useUsageAccountLabels } from './useUsageAccountLabels';
import { DesktopUsageSettings } from './DesktopUsageSettings';
import {
  readDesktopUsageConnection,
  writeDesktopUsageConnection,
  type DesktopUsageConnection,
} from './desktopConnection';
import { writeUsageCollection } from './preferences';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useAuthStore, useNotificationStore } from '@/stores';
import { usageFingerprint, type UsageRecord } from '@/services/api/usageRecords';
import { downloadBlob } from '@/utils/download';
import { compactCredentialLabel } from '@/features/quota/credentialLabel';
import { useNow } from '@/hooks/useNow';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { filterUsageRecords, usageCsv, usageFiltersFromHash, type UsageFilters } from './model';
import { useUsageRecords } from './useUsageRecords';
import styles from './UsagePage.module.scss';
import { readUsagePreferences, writeUsagePreferences, type UsageColumn } from './preferences';

const OPTIONAL_COLUMNS = ['source', 'key', 'cache', 'timing', 'speed', 'cost'] as const;
type Column = UsageColumn;

export function UsagePage() {
  const layer = usePageTransitionLayer();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const scope = usageFingerprint(JSON.stringify([apiBase, managementKey]));
  return (
    <UsageConnection
      key={scope}
      backend={apiBase}
      scope={scope}
      connected={connected}
      pageActive={layer?.isCurrentLayer ?? true}
    />
  );
}

function UsageConnection(props: {
  scope: string;
  connected: boolean;
  pageActive: boolean;
  backend: string;
}) {
  const [desktop, setDesktop] = useState(() => readDesktopUsageConnection(props.scope));
  const changeDesktop = (value: DesktopUsageConnection | null) => {
    // Switching sources requires a new opt-in, particularly when returning to the shared queue.
    writeUsageCollection(props.scope, false);
    writeDesktopUsageConnection(props.scope, value);
    setDesktop(value);
  };
  return (
    <UsageContent
      {...props}
      key={usageFingerprint(JSON.stringify(desktop))}
      desktop={desktop}
      changeDesktop={changeDesktop}
    />
  );
}

function UsageContent({
  scope,
  connected,
  pageActive,
  backend,
  desktop,
  changeDesktop,
}: {
  scope: string;
  connected: boolean;
  pageActive: boolean;
  backend: string;
  desktop: DesktopUsageConnection | null;
  changeDesktop: (value: DesktopUsageConnection | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const accountLabels = useUsageAccountLabels(scope);
  const history = useUsageRecords(scope, connected, pageActive, desktop, backend);
  const { collecting, collect, reload } = history;
  const refresh = useCallback(async () => {
    await reload();
    if (collecting) await collect();
  }, [collecting, collect, reload]);
  useHeaderRefresh(refresh, pageActive);
  const confirm = useNotificationStore((state) => state.showConfirmation);
  const fileInput = useRef<HTMLInputElement>(null);
  const [filters, setFilters] = useState<UsageFilters>(() =>
    usageFiltersFromHash(typeof window === 'undefined' ? '' : (window.location?.hash ?? ''))
  );
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => readUsagePreferences().pageSize);
  const [columns, setColumns] = useState<Column[]>(() => readUsagePreferences().columns);
  const [inspected, setInspected] = useState<UsageRecord | null>(null);
  const now = useNow();
  const filtered = useMemo(
    () => filterUsageRecords(history.records, filters, now),
    [history.records, filters, now]
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);
  const failures = filtered.filter((record) => record.failed || record.canceled).length;
  const tokenTotal = filtered.reduce((sum, record) => sum + (record.total ?? 0), 0);
  const numeric = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });
  const compact = new Intl.NumberFormat(i18n.resolvedLanguage, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
  const number = (value: number | null) => (value === null ? '—' : compact.format(value));
  const duration = (value: number | null) =>
    value === null ? '—' : `${numeric.format(value / 1000)} s`;
  const visible = (column: Column) => columns.includes(column);
  const change = (patch: Partial<UsageFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  };
  const choices = (key: 'model' | 'source' | 'keyId', all: string) => [
    { value: '', label: t(`usage.${all}`) },
    ...[
      ...new Set(
        history.records
          .map((record) => (key === 'source' ? record.accountId || record.source : record[key]))
          .filter(Boolean)
      ),
    ]
      .sort()
      .map((value) => ({
        value,
        label:
          key === 'keyId'
            ? t('usage.key_label', { id: value.slice(0, 8) })
            : key === 'source'
              ? accountLabels.get(value) ||
                (/^[a-f0-9]{64}$/.test(value)
                  ? t('analytics.account_id', { id: value.slice(0, 8) })
                  : compactCredentialLabel(value))
              : value,
      })),
  ];
  const startCollection = (enabled: boolean) => {
    if (!enabled) {
      history.setCollecting(false);
      return;
    }
    confirm({
      title: t('usage.collect_title'),
      message: t(desktop ? 'usage.desktop_notice' : 'usage.queue_notice'),
      confirmText: t('usage.start'),
      onConfirm: () => history.setCollecting(true),
    });
  };
  const exportCsv = () =>
    downloadBlob({
      filename: `usage-${new Date().toISOString().slice(0, 10)}.csv`,
      blob: new Blob([usageCsv(filtered)], { type: 'text/csv;charset=utf-8' }),
    });

  const renderRow = (record: UsageRecord) => {
    const date = new Date(record.timestamp);
    const cacheRatio =
      record.input !== null &&
      record.input > 0 &&
      record.cacheRead !== null &&
      record.cacheRead <= record.input
        ? (record.cacheRead / record.input) * 100
        : null;
    const generationMs =
      record.latencyMs !== null && record.ttftMs !== null ? record.latencyMs - record.ttftMs : 0;
    const speed =
      record.output !== null && generationMs > 0 ? (record.output / generationMs) * 1000 : null;
    const result = record.canceled ? 'canceled' : record.failed ? 'failure' : 'success';
    return (
      <tr key={record.id}>
        <td className={styles.time}>
          <strong>{date.toLocaleTimeString(i18n.resolvedLanguage)}</strong>
          <small>{date.toLocaleDateString(i18n.resolvedLanguage)}</small>
        </td>
        <td>
          <button
            type="button"
            className={styles.inspectButton}
            onClick={() => setInspected(record)}
            aria-label={`${t('usage.inspect')}: ${record.model}`}
          >
            <strong>{record.model || '—'}</strong>
          </button>
          <small>{[record.provider, record.effort].filter(Boolean).join(' · ') || '—'}</small>
        </td>
        {visible('source') && (
          <td className={styles.source} title={record.source}>
            {record.accountId
              ? accountLabels.get(record.accountId) ||
                t('analytics.account_id', { id: record.accountId.slice(0, 8) })
              : record.source
                ? compactCredentialLabel(record.source)
                : t('usage.hidden_source')}
          </td>
        )}
        {visible('key') && (
          <td>{record.keyId ? t('usage.key_label', { id: record.keyId.slice(0, 8) }) : '—'}</td>
        )}
        <td>
          <span className={`${styles.result} ${styles[result]}`}>{t(`usage.${result}`)}</span>
        </td>
        <td>
          <strong title={record.total === null ? undefined : numeric.format(record.total)}>
            {number(record.total)}
          </strong>
          <small>
            {t('usage.input')} {number(record.input)} · {t('usage.output')} {number(record.output)}
          </small>
          <small>
            {t('usage.reasoning')} {number(record.reasoning)}
          </small>
        </td>
        {visible('cache') && (
          <td>
            <strong title={t('usage.cache_ratio')}>
              {cacheRatio === null ? '—' : `${numeric.format(cacheRatio)}%`}
            </strong>
            <small>
              {t('usage.read')} {number(record.cacheRead)} · {t('usage.write')}{' '}
              {number(record.cacheWrite)}
            </small>
          </td>
        )}
        {visible('timing') && (
          <td>
            <small>
              TTFT <b>{duration(record.ttftMs)}</b>
            </small>
            <small>
              {t('usage.elapsed')} <b>{duration(record.latencyMs)}</b>
            </small>
          </td>
        )}
        {visible('speed') && (
          <td title={t('usage.speed_hint')}>
            {speed === null ? '—' : `${numeric.format(speed)} ${t('usage.tokens_second')}`}
          </td>
        )}
        {visible('cost') && (
          <td>
            {record.cost === null
              ? '—'
              : new Intl.NumberFormat(i18n.resolvedLanguage, {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 4,
                }).format(record.cost)}
          </td>
        )}
      </tr>
    );
  };

  return (
    <div className={styles.page}>
      {inspected && (
        <RequestInspector
          key={inspected.id}
          record={inspected}
          account={
            inspected.accountId
              ? accountLabels.get(inspected.accountId) ||
                t('analytics.account_id', { id: inspected.accountId.slice(0, 8) })
              : inspected.source || t('analytics.unknown')
          }
          onClose={() => setInspected(null)}
        />
      )}
      <header className={styles.header}>
        <div>
          <h1>{t('usage.title')}</h1>
        </div>
        <div className={styles.actions}>
          <span
            className={styles.status}
            role="status"
            title={
              history.lastRead
                ? t('usage.updated', {
                    time: new Date(history.lastRead).toLocaleTimeString(i18n.resolvedLanguage),
                  })
                : undefined
            }
          >
            {t(
              `usage.${history.collecting ? (history.focused && connected ? 'collecting' : 'paused') : 'collection_off'}`
            )}{' '}
            · {t('usage.stored', { count: history.records.length })}
          </span>
          <ToggleSwitch
            checked={history.collecting}
            onChange={startCollection}
            label={t('usage.live')}
            disabled={!connected || !history.loaded || history.busy}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={history.busy || !history.loaded}
            onClick={() => void refresh()}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </header>
      {history.error && (
        <div className={styles.error} role="alert">
          {t(`usage.${history.error}`)}
        </div>
      )}
      <section className={styles.metrics} aria-label={t('usage.filtered_summary')}>
        <div>
          <span>{t('usage.requests')}</span>
          <strong>{numeric.format(filtered.length)}</strong>
        </div>
        <div>
          <span>{t('dashboard.success_rate')}</span>
          <strong>
            {filtered.length
              ? `${numeric.format(((filtered.length - failures) / filtered.length) * 100)}%`
              : '—'}
          </strong>
        </div>
        <div>
          <span>{t('usage.tokens')}</span>
          <strong>{filtered.some((r) => r.total !== null) ? number(tokenTotal) : '—'}</strong>
        </div>
        <div>
          <span>{t('usage.unsuccessful')}</span>
          <strong>{numeric.format(failures)}</strong>
        </div>
      </section>
      {filters.from !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => change({ from: undefined, to: undefined, hours: 24 })}
        >
          {t('usage.range_filter', { time: new Date(filters.from).toLocaleString() })}
        </Button>
      )}
      <div className={styles.filters}>
        <Select
          size="sm"
          ariaLabel={t('usage.period')}
          value={String(filters.hours)}
          onChange={(value) => change({ hours: Number(value), from: undefined, to: undefined })}
          options={[1, 24, 72, 168, 720, 0].map((value) => ({
            value: String(value),
            label: t(value ? 'usage.last_hours' : 'usage.all_time', { count: value }),
          }))}
        />
        <Select
          size="sm"
          ariaLabel={t('usage.model')}
          value={filters.model}
          onChange={(model) => change({ model })}
          options={choices('model', 'all_models')}
        />
        <Select
          size="sm"
          ariaLabel={t('usage.source')}
          value={filters.source}
          onChange={(source) => change({ source })}
          options={choices('source', 'all_sources')}
        />
        <Select
          size="sm"
          ariaLabel={t('usage.key')}
          value={filters.key}
          onChange={(key) => change({ key })}
          options={choices('keyId', 'all_keys')}
        />
        <Select
          size="sm"
          ariaLabel={t('usage.result')}
          value={filters.result}
          onChange={(result) => change({ result })}
          options={['', 'success', 'failure', 'canceled'].map((value) => ({
            value,
            label: t(`usage.${value || 'all_results'}`),
          }))}
        />
        <input
          type="search"
          className={styles.searchInput}
          aria-label={t('usage.search')}
          placeholder={t('usage.search')}
          value={filters.search}
          onChange={(event) => change({ search: event.target.value })}
        />
      </div>
      <div className={styles.tableWrap} role="region" aria-label={t('usage.title')} tabIndex={0}>
        <table>
          <thead>
            <tr>
              <th>{t('usage.time')}</th>
              <th>{t('usage.model')}</th>
              {visible('source') && <th>{t('usage.source')}</th>}
              {visible('key') && <th>{t('usage.key')}</th>}
              <th>{t('usage.result')}</th>
              <th>{t('usage.tokens')}</th>
              {visible('cache') && <th>{t('usage.cache')}</th>}
              {visible('timing') && <th>{t('usage.timing')}</th>}
              {visible('speed') && <th>{t('usage.speed')}</th>}
              {visible('cost') && <th>{t('usage.cost')}</th>}
            </tr>
          </thead>
          <tbody>
            {items.length ? (
              items.map(renderRow)
            ) : (
              <tr>
                <td colSpan={4 + columns.length} className={styles.empty}>
                  <strong>
                    {t(
                      history.loaded
                        ? history.records.length
                          ? 'usage.no_matches'
                          : 'usage.empty'
                        : 'common.loading'
                    )}
                  </strong>
                  <p>{t('usage.empty_hint')}</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className={styles.footer}>
        <DesktopUsageSettings
          className={styles.setup}
          connection={desktop}
          onChange={changeDesktop}
          disabled={history.busy || !history.loaded}
        />
        <span>
          {t('usage.showing', {
            start: filtered.length ? start + 1 : 0,
            end: Math.min(start + pageSize, filtered.length),
            total: filtered.length,
          })}
        </span>
        <details className={styles.columnOptions}>
          <summary>{t('usage.columns')}</summary>
          <div>
            {OPTIONAL_COLUMNS.map((column) => (
              <label key={column}>
                <input
                  type="checkbox"
                  checked={visible(column)}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...columns, column]
                      : columns.filter((item) => item !== column);
                    setColumns(next);
                    writeUsagePreferences(next, pageSize);
                  }}
                />
                {t(`usage.${column}`)}
              </label>
            ))}
          </div>
        </details>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => fileInput.current?.click()}
          disabled={history.busy || !history.loaded}
        >
          {t('usage.import')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void history.importCsv(file);
            event.target.value = '';
          }}
        />
        <Button size="sm" variant="secondary" onClick={exportCsv} disabled={!filtered.length}>
          {t('usage.export')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={history.busy || !history.records.length}
          onClick={() =>
            confirm({
              title: t('usage.clear'),
              message: t('usage.clear_confirm'),
              variant: 'danger',
              onConfirm: history.clear,
            })
          }
        >
          {t('usage.clear')}
        </Button>
        <div className={styles.pagination}>
          <Select
            size="sm"
            ariaLabel={t('usage.page_size')}
            fullWidth={false}
            value={String(pageSize)}
            options={[25, 50, 100].map((value) => ({
              value: String(value),
              label: t('usage.per_page', { count: value }),
            }))}
            onChange={(value) => {
              setPageSize(Number(value));
              writeUsagePreferences(columns, Number(value));
              setPage(1);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            {t('usage.previous')}
          </Button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            {t('usage.next')}
          </Button>
        </div>
      </footer>
    </div>
  );
}
