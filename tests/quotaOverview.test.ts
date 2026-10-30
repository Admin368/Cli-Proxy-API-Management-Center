import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaOverview } from '@/features/quota/components/QuotaOverview';
import type { QuotaFileEntry } from '@/features/quota/logic';

const entries: QuotaFileEntry[] = [
  { type: 'claude', file: { name: 'personal.json', type: 'claude', success: 12, failed: 2 } },
  { type: 'codex', file: { name: 'work.json', type: 'codex' } },
];

describe('quota overview', () => {
  test('keeps account limits separate and distinguishes unknown quota from zero', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaOverview, {
        entries,
        quotaFor: (entry) =>
          entry.type === 'claude'
            ? {
                status: 'success',
                windows: [
                  {
                    label: '5-hour',
                    usedPercent: 25,
                    resetAtMs: Date.now() + 60_000,
                    periodHours: 5,
                  },
                  {
                    label: 'Weekly',
                    usedPercent: 100,
                    resetAtMs: Date.now() + 120_000,
                    periodHours: 168,
                  },
                ],
              }
            : undefined,
      })
    );
    expect(html).toContain('personal.json');
    expect(html).toContain('work.json');
    expect(html).toContain('aria-valuenow="75"');
    expect(html).toContain('aria-valuenow="0"');
    expect(html.match(/role="meter"/g)).toHaveLength(2);
    expect(html).toContain(i18n.t('quota_management.overview_pending'));
    expect(html).toContain('12');
  });

  test('does not portray a passed reset as freshly replenished quota', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaOverview, {
        entries: entries.slice(0, 1),
        quotaFor: () => ({
          status: 'success',
          windows: [{ usedPercent: 25, resetAtMs: Date.now() - 60_000, periodHours: 5 }],
        }),
      })
    );
    expect(html).not.toContain('role="meter"');
    expect(html).toContain(i18n.t('quota_management.overview_expired'));
  });

  test('malformed reset times cannot crash the overview or produce invalid meters', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaOverview, {
        entries: entries.slice(0, 1),
        quotaFor: () => ({
          status: 'success',
          windows: [{ usedPercent: NaN, resetAtMs: NaN, periodHours: 5 }],
        }),
      })
    );
    expect(html).not.toContain('aria-valuenow="NaN"');
    expect(html).toContain(i18n.t('quota_management.overview_details'));
  });

  test('an expired short window does not hide a still-valid weekly limit', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaOverview, {
        entries: entries.slice(0, 1),
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              label: 'Expired short window',
              usedPercent: 25,
              resetAtMs: Date.now() - 60_000,
              periodHours: 5,
            },
            {
              label: 'Valid weekly window',
              usedPercent: 30,
              resetAtMs: Date.now() + 60_000,
              periodHours: 168,
            },
          ],
        }),
      })
    );
    expect(html).not.toContain('Expired short window');
    expect(html).toContain('Valid weekly window');
    expect(html).toContain('aria-valuenow="70"');
    expect(html.match(/role="meter"/g)).toHaveLength(1);
  });
});
