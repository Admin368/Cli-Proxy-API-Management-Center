import { announceQuotaPreferenceChange } from './preferenceEvents';
import type { ForecastWindow } from './forecast';

export type ForecastScale = 'capacity' | 'adaptive' | 'normalized';

export interface ForecastPreferences {
  window: ForecastWindow;
  rateHours: number;
  horizon: number;
  factor: number;
  showAccounts: boolean;
  scale: ForecastScale;
}

export const FORECAST_PREFERENCES_KEY = 'quota.forecast.preferences.v1';
const defaults: ForecastPreferences = {
  window: 'weekly',
  rateHours: 3,
  horizon: 168,
  factor: 1,
  showAccounts: false,
  scale: 'capacity',
};

export function normalizeForecastPreferences(value: unknown): ForecastPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
  const saved = value as Record<string, unknown>;
  return {
    window: saved.window === 'session' ? 'session' : 'weekly',
    rateHours:
      typeof saved.rateHours === 'number' && [1, 3, 6].includes(saved.rateHours)
        ? saved.rateHours
        : defaults.rateHours,
    horizon:
      typeof saved.horizon === 'number' && [5, 10, 24, 48, 72, 168].includes(saved.horizon)
        ? saved.horizon
        : defaults.horizon,
    factor:
      saved.factor === 0.5 || saved.factor === 1 || saved.factor === 2
        ? saved.factor
        : defaults.factor,
    scale: saved.scale === 'adaptive' || saved.scale === 'normalized' ? saved.scale : 'capacity',
    showAccounts:
      typeof saved.showAccounts === 'boolean' ? saved.showAccounts : defaults.showAccounts,
  };
}
export function readForecastPreferences(): ForecastPreferences {
  try {
    return normalizeForecastPreferences(
      JSON.parse(window.localStorage.getItem(FORECAST_PREFERENCES_KEY) ?? 'null')
    );
  } catch {
    return { ...defaults };
  }
}

export function writeForecastPreferences(preferences: ForecastPreferences, notify = true): void {
  try {
    window.localStorage.setItem(FORECAST_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // Storage restrictions must not prevent changing the controls.
  }
  if (notify) announceQuotaPreferenceChange({ ...preferences });
}
