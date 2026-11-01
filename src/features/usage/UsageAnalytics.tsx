import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { usageFingerprint } from '@/services/api/usageRecords';
import { useNow } from '@/hooks/useNow';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { compactCredentialLabel } from '@/features/quota/credentialLabel';
import { useUsageRecords } from './useUsageRecords';
import { hourlyUsage, usageSeries } from './analytics';
import styles from './UsageAnalytics.module.scss';

const colors = ['#60a5fa', '#34d399', '#c084fc', '#fbbf24', '#fb7185', '#22d3ee', '#94a3b8'];
export function UsageAnalytics() {
  const base = useAuthStore((s) => s.apiBase);
  const key = useAuthStore((s) => s.managementKey);
  const scope = usageFingerprint(JSON.stringify([base, key]));
  return <AnalyticsContent key={scope} scope={scope} />;
}
function AnalyticsContent({ scope }: { scope: string }) {
  const { t, i18n } = useTranslation();
  // Read the local history only. Never consume the destructive shared queue here.
  const history = useUsageRecords(scope, false, false);
  const now = useNow();
  const [hours, setHours] = useState(24);
  const [model, setModel] = useState('');
  const [account, setAccount] = useState('');
  const [view, setView] = useState('combined');
  const format = (n: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage, {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(n);
  const date = (n: number) =>
    new Date(n).toLocaleString(i18n.resolvedLanguage, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const label = (key: string | null) =>
    key === null
      ? t('analytics.other')
      : key
        ? compactCredentialLabel(key)
        : t('analytics.unknown');
  const models = [...new Set(history.records.map((r) => r.model))].sort();
  const accounts = [...new Set(history.records.map((r) => r.source))].sort();
  const { buckets, selected } = useMemo(
    () =>
      hourlyUsage(
        history.records.filter(
          (r) =>
            (!model || r.model === model) && (!account || (r.source || '__unknown') === account)
        ),
        hours,
        now
      ),
    [history.records, model, account, hours, now]
  );
  const bars = usageSeries(buckets, view === 'account' ? 'accounts' : 'models');
  const lines = view === 'combined' ? usageSeries(buckets, 'accounts') : [];
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const totals = selected.reduce(
    (a, r) => ({
      tokens: a.tokens + (r.total ?? 0),
      success: a.success + Number(!r.failed && !r.canceled),
      known: a.known + Number(r.total !== null),
    }),
    { tokens: 0, success: 0, known: 0 }
  );
  const breakdown = (['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const).map(
    (key) => ({
      key,
      count: selected.filter((r) => r[key] !== null).length,
      total: selected.reduce((sum, r) => sum + (r[key] ?? 0), 0),
    })
  );
  const w = 1000,
    h = 280,
    left = 65,
    plot = 910,
    step = plot / hours;
  const y = (value: number) => 245 - (value / max) * 210;
  return (
    <section className={styles.panel} aria-label={t('analytics.title')}>
      <div className={styles.header}>
        <h2>{t('analytics.title')}</h2>
        <Link to="/usage">{t('usage.title')}</Link>
        <Button variant="secondary" size="sm" onClick={() => void history.reload()}>
          {t('analytics.reload')}
        </Button>
      </div>
      <p className={styles.note}>{t('analytics.notice')}</p>
      <div className={styles.filters}>
        <Select
          value={String(hours)}
          onChange={(v) => setHours(Number(v))}
          ariaLabel={t('analytics.period')}
          options={[24, 72, 168].map((value) => ({
            value: String(value),
            label: t('analytics.hours', { count: value }),
          }))}
        />
        <Select
          value={model}
          onChange={setModel}
          ariaLabel={t('analytics.models')}
          options={[
            { value: '', label: t('analytics.models') },
            ...models.map((value) => ({ value, label: value || t('analytics.unknown') })),
          ]}
        />
        <Select
          value={account}
          onChange={setAccount}
          ariaLabel={t('analytics.accounts')}
          options={[
            { value: '', label: t('analytics.accounts') },
            ...accounts.map((value) => ({ value: value || '__unknown', label: label(value) })),
          ]}
        />
        <Select
          value={view}
          onChange={setView}
          ariaLabel={t('analytics.view')}
          options={['combined', 'model', 'account'].map((value) => ({
            value,
            label: t('analytics.' + value),
          }))}
        />
      </div>
      <div className={styles.metrics}>
        <div>
          {t('analytics.requests')}
          <strong>{format(selected.length)}</strong>
        </div>
        <div>
          {t('analytics.tokens')}
          <strong>{format(totals.tokens)}</strong>
        </div>
        <div>
          {t('analytics.success')}
          <strong>
            {selected.length ? ((totals.success / selected.length) * 100).toFixed(1) + '%' : '—'}
          </strong>
        </div>
        <div>
          {t('analytics.coverage')}
          <strong>
            {totals.known} / {selected.length}
          </strong>
        </div>
      </div>
      {history.error && <p role="alert">{t('usage.' + history.error)}</p>}
      {!history.loaded ? (
        <p role="status">{t('analytics.loading')}</p>
      ) : selected.length === 0 ? (
        <p>{t('analytics.empty')}</p>
      ) : (
        <>
          <p className={styles.note}>{t('analytics.chart_hint')}</p>
          <div className={styles.chart}>
            <svg viewBox={'0 0 ' + w + ' ' + h} role="img" aria-label={t('analytics.chart')}>
              <title>{t('analytics.chart')}</title>
              {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                <g key={f}>
                  <line
                    x1={left}
                    x2={975}
                    y1={y(max * f)}
                    y2={y(max * f)}
                    className={styles.grid}
                  />
                  <text x={left - 8} y={y(max * f) + 4} textAnchor="end">
                    {format(max * f)}
                  </text>
                </g>
              ))}
              {buckets.map((b, i) => {
                let accumulated = 0;
                return (
                  <g key={b.at}>
                    {bars.map((series, j) => {
                      const value = series.values[i];
                      const bottom = accumulated;
                      accumulated += value;
                      return (
                        <rect
                          key={j}
                          x={left + i * step + 2}
                          y={y(accumulated)}
                          width={Math.max(1, step - 4)}
                          height={(value / max) * 210}
                          fill={colors[j]}
                        >
                          <title>
                            {date(b.at)} · {label(series.key)}: {format(value)}
                          </title>
                        </rect>
                      );
                    })}
                    {i % Math.ceil(hours / 6) === 0 && (
                      <text x={left + i * step} y={267}>
                        {date(b.at)}
                      </text>
                    )}
                  </g>
                );
              })}
              {lines.map((series, j) => (
                <polyline
                  key={j}
                  fill="none"
                  stroke={colors[j]}
                  strokeWidth="2.5"
                  strokeDasharray={j % 2 ? '5 3' : undefined}
                  points={series.values
                    .map((v, i) => left + (i + 0.5) * step + ',' + y(v))
                    .join(' ')}
                >
                  <title>{label(series.key)}</title>
                </polyline>
              ))}
            </svg>
          </div>
          <div className={styles.legend}>
            {bars.map((s, i) => (
              <span key={'b' + i}>
                <i style={{ background: colors[i] }} />
                {t('analytics.bar')}: {label(s.key)}
              </span>
            ))}
            {lines.map((s, i) => (
              <span key={'l' + i}>
                <i className={styles.line} style={{ background: colors[i] }} />
                {t('analytics.line')}: {label(s.key)}
              </span>
            ))}
          </div>
          <details>
            <summary>{t('analytics.hourly_data')}</summary>
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>{t('analytics.period')}</th>
                    <th>{t('analytics.requests')}</th>
                    <th>{t('analytics.tokens')}</th>
                    {lines.map((s, i) => (
                      <th key={i}>{label(s.key)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={b.at}>
                      <td>{date(b.at)}</td>
                      <td>{b.requests}</td>
                      <td>{b.total.toLocaleString()}</td>
                      {lines.map((s, j) => (
                        <td key={j}>{s.values[i].toLocaleString()}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <div className={styles.breakdown}>
        {breakdown.map((b) => (
          <div key={b.key}>
            {t('analytics.' + b.key)}
            <strong>{b.count ? format(b.total) : '—'}</strong>
            <small>{t('analytics.reported', { count: b.count })}</small>
          </div>
        ))}
      </div>
      <p className={styles.note}>{t('analytics.overlap')}</p>
    </section>
  );
}
export function UsageAnalyticsPage() {
  return (
    <div className={styles.page}>
      <UsageAnalytics />
    </div>
  );
}
