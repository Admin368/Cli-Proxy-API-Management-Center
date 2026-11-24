import { afterAll, expect, test } from 'bun:test';
import {
  FORECAST_PREFERENCES_KEY,
  readForecastPreferences,
  writeForecastPreferences,
} from '@/features/quota/forecastPreferences';

const originalWindow = (globalThis as { window?: unknown }).window;
afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

function storage(raw: string | null = null) {
  let saved = raw;
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: () => saved,
      setItem: (key: string, value: string) => {
        expect(key).toBe(FORECAST_PREFERENCES_KEY);
        saved = value;
      },
    },
  };
}

test('forecast restores every control from local storage across visits', () => {
  storage();
  const defaults = readForecastPreferences();
  const selected = {
    ...defaults,
    window: 'session' as const,
    rateHours: 6,
    horizon: 24,
    factor: 0.5,
    showAccounts: true,
  };
  writeForecastPreferences(selected);
  expect(readForecastPreferences()).toEqual(selected);
  writeForecastPreferences({ ...readForecastPreferences(), factor: 2 });
  expect(readForecastPreferences()).toEqual({ ...selected, factor: 2 });
});

test('invalid or unavailable storage uses defaults without breaking controls', () => {
  storage();
  const defaults = readForecastPreferences();
  for (const raw of [
    '{bad',
    'null',
    '[]',
    JSON.stringify({
      window: 'other',
      rateHours: '6',
      horizon: 99,
      factor: 0,
      showAccounts: 'false',
    }),
  ]) {
    storage(raw);
    expect(readForecastPreferences()).toEqual(defaults);
  }
  (globalThis as { window?: unknown }).window = {
    get localStorage() {
      throw Error('blocked');
    },
  };
  expect(readForecastPreferences()).toEqual(defaults);
  expect(() => writeForecastPreferences(defaults)).not.toThrow();
});

test('forecast restores new horizons and scale modes', () => {
  for (const horizon of [5, 10, 48, 72]) {
    for (const scale of ['adaptive', 'normalized'] as const) {
      storage();
      const selected = { ...readForecastPreferences(), horizon, scale };
      writeForecastPreferences(selected);
      expect(readForecastPreferences()).toEqual(selected);
    }
  }
});
