import { quotaBurnRate, type QuotaObservation } from './forecast';

/** Reuse measured inputs; never advance an old reading or fabricate a new observation. */
export function lastMeasuredForecast(rows: QuotaObservation[], now: number, hours: number) {
  const samples = rows.filter((row) => row.at <= now).sort((a, b) => a.at - b.at);
  for (let i = samples.length - 1; i >= 0; i--) {
    const latest = samples[i];
    const rate = quotaBurnRate(samples, latest.at, hours);
    if (rate !== null) return { latest, rate };
  }
  return null;
}
