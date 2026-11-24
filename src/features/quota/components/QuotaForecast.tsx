import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { Select } from '@/components/ui/Select';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { buildTimelineLane } from '../quotaTimelineModel';
import {
  FORECAST_EVENT,
  readObservations,
  quotaObservationId,
  quotaBurnRate,
  projectedRemaining,
  poolHistorySeries,
  type ForecastWindow,
} from '../forecast';
import {
  readForecastPreferences,
  normalizeForecastPreferences,
  writeForecastPreferences,
  type ForecastPreferences,
  type ForecastScale,
} from '../forecastPreferences';
import { lastMeasuredForecast } from '../retainedForecast';
import { QUOTA_PREFERENCE_RESTORE, announceQuotaPreferenceChange } from '../preferenceEvents';
import { forecastChartScale } from '../forecastChartScale';
import styles from './QuotaForecast.module.scss';

const HOUR = 3_600_000;
function segments(
  points: { at: number; value: number | null }[],
  x: (at: number) => number,
  y: (value: number) => number
) {
  const output: string[] = [];
  let current: string[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (current.length) output.push(current.join(' '));
      current = [];
    } else current.push(`${x(point.at)},${y(point.value)}`);
  }
  if (current.length) output.push(current.join(' '));
  return output;
}
export function QuotaForecast({
  scope,
  entries,
  quotaFor,
  shared = false,
}: {
  scope: string;
  shared?: boolean;
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const [history, setHistory] = useState(() => readObservations(scope));
  const [preferences, setPreferences] = useState(readForecastPreferences);
  const { window, rateHours, horizon, factor, showAccounts, scale } = preferences;
  const updatePreferences = (patch: Partial<ForecastPreferences>) => {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    writeForecastPreferences(next, false);
    announceQuotaPreferenceChange(patch);
  };
  useEffect(() => {
    const restore = (event: Event) => {
      const remote = (event as CustomEvent<Record<string, unknown>>).detail;
      if (remote && typeof remote === 'object')
        setPreferences((previous) => normalizeForecastPreferences({ ...previous, ...remote }));
      else setPreferences(readForecastPreferences());
    };
    globalThis.window.addEventListener(QUOTA_PREFERENCE_RESTORE, restore);
    globalThis.window.addEventListener('storage', restore);
    return () => {
      globalThis.window.removeEventListener(QUOTA_PREFERENCE_RESTORE, restore);
      globalThis.window.removeEventListener('storage', restore);
    };
  }, []);
  useEffect(() => {
    const reload = () => setHistory(readObservations(scope));
    reload();
    globalThis.window.addEventListener(FORECAST_EVENT, reload);
    globalThis.window.addEventListener('storage', reload);
    return () => {
      globalThis.window.removeEventListener(FORECAST_EVENT, reload);
      globalThis.window.removeEventListener('storage', reload);
    };
  }, [scope]);
  const retained = useMemo(() => {
    const result = new Map<string, ReturnType<typeof lastMeasuredForecast>>();
    for (const entry of entries) {
      const id = quotaObservationId(entry);
      result.set(
        id,
        lastMeasuredForecast(
          history.filter(
            (row) => row.id === id && row.provider === entry.type && row.window === window
          ),
          Date.now(),
          rateHours
        )
      );
    }
    return result;
  }, [entries, history, window, rateHours]);
  const providers = useMemo(() => [...new Set(entries.map((entry) => entry.type))], [entries]);
  const date = (at: number) =>
    new Date(at).toLocaleString(i18n.resolvedLanguage, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  const number = (value: number) =>
    new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 }).format(value);
  return (
    <section className={styles.forecast} aria-label={t('quota_management.forecast_view')}>
      <div className={styles.controls}>
        <Select
          size="sm"
          ariaLabel={t('quota_management.forecast_window')}
          value={window}
          onChange={(value) => updatePreferences({ window: value as ForecastWindow })}
          options={(['session', 'weekly'] as const).map((value) => ({
            value,
            label: t(`quota_management.forecast_${value}`),
          }))}
        />
        <Select
          size="sm"
          ariaLabel={t('quota_management.forecast_rate')}
          value={String(rateHours)}
          onChange={(value) => updatePreferences({ rateHours: Number(value) })}
          options={[1, 3, 6].map((value) => ({
            value: String(value),
            label: t('quota_management.forecast_last_hours', { count: value }),
          }))}
        />
        <Select
          size="sm"
          ariaLabel={t('quota_management.forecast_horizon')}
          value={String(horizon)}
          onChange={(value) => updatePreferences({ horizon: Number(value) })}
          options={[5, 10, 24, 48, 72, 168].map((value) => ({
            value: String(value),
            label: t('quota_management.forecast_next_hours', { count: value }),
          }))}
        />
        <Select
          size="sm"
          ariaLabel={t('quota_management.forecast_scenario')}
          value={String(factor)}
          onChange={(value) => updatePreferences({ factor: Number(value) })}
          options={[0.5, 1, 2].map((value) => ({
            value: String(value),
            label: t('quota_management.forecast_multiplier', { value }),
          }))}
        />
        <Select
          size="sm"
          ariaLabel={t('quota_management.forecast_scale')}
          value={scale}
          onChange={(value) => updatePreferences({ scale: value as ForecastScale })}
          options={(['capacity', 'adaptive', 'normalized'] as const).map((value) => ({
            value,
            label: t(`quota_management.forecast_scale_${value}`),
          }))}
        />
        <label>
          <input
            type="checkbox"
            checked={showAccounts}
            onChange={(event) => updatePreferences({ showAccounts: event.target.checked })}
          />{' '}
          {t('quota_management.forecast_accounts')}
        </label>
      </div>
      <p className={styles.note}>
        {t(shared ? 'quota_management.forecast_shared_hint' : 'quota_management.forecast_hint')}
      </p>
      {providers.map((provider) => {
        const group = entries.filter(
          (entry) => entry.type === provider && !entry.file.disabled && !entry.file.unavailable
        );
        const rows = history.filter((row) => row.provider === provider && row.window === window);
        const accounts = group.map((entry) => {
          const id = quotaObservationId(entry);
          const samples = rows.filter((row) => row.id === id).sort((a, b) => a.at - b.at);
          const current = samples[samples.length - 1];
          const quota = quotaFor(entry);
          const fresh = current && now - current.at <= 30 * 60_000 && current.reset > now;
          const measuredRate = quotaBurnRate(samples, now, rateHours);
          const previous = retained.get(id);
          const useCurrent = fresh && measuredRate !== null;
          const latest = useCurrent ? current : (previous?.latest ?? current);
          const baseRate = useCurrent ? measuredRate : (previous?.rate ?? null);
          const rate = baseRate === null ? null : baseRate * factor;
          const retainedReading = !useCurrent && previous !== null && previous !== undefined;
          const empty =
            !latest || rate === null || rate <= 0
              ? null
              : latest.at + (latest.remaining / rate) * HOUR < latest.reset
                ? latest.at + (latest.remaining / rate) * HOUR
                : 100 / rate < latest.period
                  ? latest.reset + (100 / rate) * HOUR
                  : null;
          const credits = buildTimelineLane({
            name: getQuotaCacheKey(entry.file),
            displayName: '',
            provider: entry.type,
            quota,
          }).resetCredits.filter((credit) => credit.expiresAtMs > now);
          return {
            id,
            entry,
            samples,
            latest,
            current,
            fresh,
            rate,
            empty,
            credits,
            retainedReading,
          };
        });
        const ready = accounts.length > 0 && accounts.every((a) => a.latest && a.rate !== null);
        const measured = accounts.filter((a) => a.fresh);
        const projectedAccounts = accounts.filter((a) => a.latest && a.rate !== null);
        const balanceReady =
          accounts.length > 0 && accounts.every((a) => a.latest && (a.fresh || a.retainedReading));
        const historicalAccounts = accounts.filter((a) => a.samples.length > 0);
        const showingPrevious = accounts.some((a) => a.retainedReading);
        const previousAt = Math.min(
          ...accounts.filter((a) => a.latest && a.rate !== null).map((a) => a.latest!.at)
        );
        const capacity = accounts.length * 100;
        const from = now - (horizon / 2) * HOUR,
          until = now + horizon * HOUR;
        const x = (at: number) => 48 + ((at - from) / (until - from)) * 920;
        const old = poolHistorySeries(
          rows,
          accounts.map((a) => a.id),
          from,
          now
        );
        const times = new Set(
          Array.from({ length: 121 }, (_, i) => now + ((until - now) * i) / 120)
        );
        for (const a of accounts)
          if (a.latest) {
            for (
              let at = a.latest.reset, i = 0;
              at <= until && i < 200;
              at += a.latest.period * HOUR, i++
            ) {
              if (at > now) {
                times.add(at - 1);
                times.add(at);
              }
            }
            if (a.empty !== null && a.empty >= now && a.empty <= until) times.add(a.empty);
          }
        const future = [...times]
          .sort((a, b) => a - b)
          .map((at) => ({
            at,
            value: ready
              ? accounts.reduce((sum, a) => sum + projectedRemaining(a.latest!, a.rate!, at)!, 0)
              : null,
          }));
        const individualFuture = projectedAccounts.map((account) =>
          [...times]
            .sort((a, b) => a - b)
            .map((at) => ({
              at,
              value: projectedRemaining(account.latest!, account.rate!, at),
            }))
        );
        const visibleValues = [
          ...old.map((point) => point.value),
          ...future.map((point) => point.value),
          ...historicalAccounts.flatMap((account) =>
            account.samples
              .filter((sample) => sample.at >= from && sample.at <= now)
              .map((sample) => sample.remaining)
          ),
          ...(!ready
            ? individualFuture.flatMap((series) => series.map((point) => point.value))
            : []),
        ];
        const chartScale = forecastChartScale(scale, capacity, visibleValues);
        const max = chartScale.max;
        const y = (value: number) => 168 - (value / max) * 140;
        const next = accounts
          .filter((a) => a.latest && (a.fresh || a.retainedReading))
          .map((a) => (a.fresh ? a.current! : a.latest!).reset)
          .sort((a, b) => a - b)[0];
        const first = accounts
          .map((a) => a.empty)
          .filter((at): at is number => at !== null && at >= now && at <= until)
          .sort((a, b) => a - b)[0];
        const empty = ready ? future.find((point) => point.value === 0)?.at : null;
        return (
          <article key={provider} className={styles.provider}>
            <header>
              <strong>{provider}</strong>
              <span>
                {t('quota_management.forecast_coverage', {
                  count: measured.length,
                  total: accounts.length,
                })}
              </span>
              <b>
                {balanceReady
                  ? number(
                      chartScale.label(
                        accounts.reduce(
                          (sum, a) => sum + (a.fresh ? a.current! : a.latest!).remaining,
                          0
                        )
                      )
                    ) + '%'
                  : '—'}{' '}
                / {scale === 'normalized' ? 100 : capacity}%
              </b>
            </header>
            <div className={styles.stats}>
              <span>
                {t('quota_management.forecast_next_reset')}: <b>{next ? date(next) : '—'}</b>
              </span>
              <span>
                {t('quota_management.forecast_first_empty')}: <b>{first ? date(first) : '—'}</b>
              </span>
              <span>
                {t('quota_management.forecast_pool_empty')}:{' '}
                <b>
                  {empty ? date(empty) : ready ? t('quota_management.forecast_not_predicted') : '—'}
                </b>
              </span>
              <span>
                {t('quota_management.forecast_rate')}:{' '}
                <b>
                  {ready
                    ? number(chartScale.label(accounts.reduce((sum, a) => sum + a.rate!, 0))) +
                      '%/h'
                    : '—'}
                </b>
              </span>
            </div>
            {showingPrevious && Number.isFinite(previousAt) && (
              <p className={styles.note} role="status">
                {t('quota_management.forecast_retained', { time: date(previousAt) })}
              </p>
            )}
            <div className={styles.chart}>
              <svg
                viewBox="0 0 1000 205"
                role="img"
                aria-label={t('quota_management.forecast_chart', { provider })}
              >
                <title>{t('quota_management.forecast_chart', { provider })}</title>
                {[0, 0.5, 1].map((f) => (
                  <g key={f}>
                    <line
                      x1="48"
                      x2="968"
                      y1={y(max * f)}
                      y2={y(max * f)}
                      className={styles.grid}
                    />
                    <text x="43" y={y(max * f) + 4} textAnchor="end">
                      {number(chartScale.label(max * f))}%
                    </text>
                  </g>
                ))}
                {historicalAccounts.map((account) =>
                  segments(poolHistorySeries(rows, [account.id], from, now), x, y).map(
                    (points, i) => (
                      <polyline
                        key={`account-${account.id}-${i}`}
                        points={points}
                        className={styles.recorded}
                        opacity="0.45"
                      />
                    )
                  )
                )}
                {historicalAccounts.flatMap((account) => {
                  const visible = account.samples.filter(
                    (sample) => sample.at >= from && sample.at <= now
                  );
                  const stride = Math.max(1, Math.ceil(visible.length / 120));
                  return visible
                    .filter((_, index) => index % stride === 0 || index === visible.length - 1)
                    .map((sample) => (
                      <circle
                        key={`reading-${account.id}-${sample.at}`}
                        cx={x(sample.at)}
                        cy={y(sample.remaining)}
                        r="2.5"
                        className={styles.recorded}
                        opacity="0.45"
                      >
                        <title>
                          {t('quota_management.forecast_account_reading', {
                            account: getQuotaDisplayName(account.entry.file),
                            time: date(sample.at),
                            value: number(chartScale.label(sample.remaining)),
                            accountValue: number(sample.remaining),
                          })}
                        </title>
                      </circle>
                    ));
                })}
                {segments(old, x, y).map((points, i) => (
                  <polyline key={'h' + i} points={points} className={styles.recorded} />
                ))}
                {old
                  .filter((point) => point.value !== null)
                  .map((point) => (
                    <circle
                      key={`pool-${point.at}`}
                      cx={x(point.at)}
                      cy={y(point.value!)}
                      r="2.5"
                      className={styles.recorded}
                    >
                      <title>
                        {t('quota_management.forecast_pool_reading', {
                          time: date(point.at),
                          value: number(chartScale.label(point.value!)),
                        })}
                      </title>
                    </circle>
                  ))}
                {!ready &&
                  projectedAccounts.flatMap((account) =>
                    segments(
                      [...times]
                        .sort((a, b) => a - b)
                        .map((at) => ({
                          at,
                          value: projectedRemaining(account.latest!, account.rate!, at),
                        })),
                      x,
                      y
                    ).map((points, i) => (
                      <polyline
                        key={`estimate-${account.id}-${i}`}
                        points={points}
                        className={styles.projected}
                        opacity="0.5"
                      />
                    ))
                  )}
                {segments(future, x, y).map((points, i) => (
                  <polyline key={'f' + i} points={points} className={styles.projected} />
                ))}
                <line x1={x(now)} x2={x(now)} y1="20" y2="172" className={styles.grid} />
                <text x={x(now)} y="15" textAnchor="middle">
                  {t('quota_management.forecast_now')}
                </text>
                {[from, now, now + (horizon / 2) * HOUR, until].map((at, i) => (
                  <text
                    key={at}
                    x={x(at)}
                    y="195"
                    textAnchor={i === 0 ? 'start' : i === 3 ? 'end' : 'middle'}
                  >
                    {date(at)}
                  </text>
                ))}
                {next && next <= until && (
                  <circle
                    cx={x(next)}
                    cy={y(ready ? (future.find((p) => p.at === next)?.value ?? 0) : 0)}
                    r="4"
                    className={styles.reset}
                  >
                    <title>{`${t('quota_management.forecast_next_reset')}: ${date(next)}`}</title>
                  </circle>
                )}
              </svg>
            </div>
            <p className={styles.note}>
              {t(`quota_management.forecast_scale_${scale}_hint`)}
              {' · '}
              {t('quota_management.forecast_legend')}
              {' · ' +
                t('quota_management.forecast_history_coverage', {
                  count: historicalAccounts.length,
                  total: accounts.length,
                })}
              {' · ' + t('quota_management.forecast_series_hint')}
              {!ready && ' · ' + t('quota_management.forecast_insufficient')}
            </p>
            {showAccounts && (
              <div className={styles.accounts}>
                <table>
                  <thead>
                    <tr>
                      {[
                        'forecast_accounts',
                        'forecast_remaining',
                        'forecast_rate',
                        'forecast_next_reset',
                        'forecast_unused',
                        'forecast_credits',
                      ].map((field) => (
                        <th key={field}>{t('quota_management.' + field)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => (
                      <tr key={a.id}>
                        <td>{getQuotaDisplayName(a.entry.file)}</td>
                        <td>{a.fresh ? number(a.latest!.remaining) + '%' : '—'}</td>
                        <td>{a.rate !== null ? number(a.rate) + '%/h' : '—'}</td>
                        <td>{a.latest ? date(a.latest.reset) : '—'}</td>
                        <td>
                          {a.fresh && a.rate !== null
                            ? number(
                                Math.max(
                                  0,
                                  a.latest!.remaining -
                                    (a.rate * (a.latest!.reset - a.latest!.at)) / HOUR
                                )
                              ) + '%'
                            : '—'}
                        </td>
                        <td>
                          {a.credits.length
                            ? a.credits.map((c) => date(c.expiresAtMs)).join(' · ')
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </article>
        );
      })}
    </section>
  );
}
