import { expect, test } from 'bun:test';
import { forecastChartScale } from '@/features/quota/forecastChartScale';

test('adaptive scale fits visible peaks including projections without using total capacity', () => {
  const scale = forecastChartScale('adaptive', 400, [null, 75, 195, 120]);
  expect(scale.max).toBe(195);
  expect(scale.label(195)).toBe(195);
  expect(forecastChartScale('adaptive', 400, [null, 0]).max).toBe(1);
});

test('normalized scale represents all included accounts rather than only measured accounts', () => {
  const scale = forecastChartScale('normalized', 400, [100]);
  expect(scale.max).toBe(400);
  expect(scale.label(400)).toBe(100);
  expect(scale.label(100)).toBe(25);
  expect(forecastChartScale('capacity', 400, [100]).label(400)).toBe(400);
});
