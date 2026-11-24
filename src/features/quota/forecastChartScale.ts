import type { ForecastScale } from './forecastPreferences';

/** Geometry stays in account percentage points; only normalized labels change units. */
export function forecastChartScale(
  mode: ForecastScale,
  capacity: number,
  values: (number | null)[]
) {
  const peak = values.reduce<number>(
    (highest, value) =>
      value !== null && Number.isFinite(value) ? Math.max(highest, value) : highest,
    0
  );
  return {
    max: mode === 'adaptive' ? Math.max(1, peak) : Math.max(100, capacity),
    label: (value: number) =>
      mode === 'normalized' ? (value / Math.max(100, capacity)) * 100 : value,
  };
}
