import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { QuotaTimeline } from '../src/features/quota/components/QuotaTimeline';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import { buildKimiQuotaRows } from '../src/utils/quota';
import i18n from '../src/i18n';

const entries: QuotaFileEntry[] = [
  {
    file: { name: 'weekly-only.json', type: 'claude' },
    type: 'claude',
  },
];

const baseProps = {
  entries,
  displayNameFor: (name: string) => name,
  resolvedTheme: 'light' as const,
  now: new Date(2026, 6, 29, 12).getTime(),
};

describe('QuotaTimeline rendering', () => {
  test('Claude five-hour quota stays visible at 100% without an upstream reset time', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        fixedMode: 'session',
        quotaFor: () => ({
          status: 'success',
          windows: [
            { id: 'five-hour', label: '5-hour', usedPercent: 0, resetAtMs: null, periodHours: 5 },
            {
              id: 'weekly',
              label: '7-day',
              usedPercent: 44,
              resetAtMs: baseProps.now + 86400000,
              periodHours: 168,
            },
          ],
        }),
      })
    );
    expect(markup).toContain('weekly-only.json');
    expect(markup).toContain('100%');
    expect(markup).toContain(i18n.t('quota_management.windows_reset_unknown'));
    expect(markup).not.toContain('windowLive');
  });

  test('a disabled Claude with no reading still has an explicit row in the day view', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        fixedMode: 'session',
        entries: [
          { type: 'claude', file: { name: 'paused-fixture.json', type: 'claude', disabled: true } },
        ],
        quotaFor: () => undefined,
      })
    );
    expect(markup).toContain('paused-fixture.json');
    expect(markup).toContain(i18n.t('quota_management.windows_no_reading'));
  });
  test('dedicated five-hour chart shows one day with 24 hourly labels and no zoom toggle', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        fixedMode: 'session',
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              id: 'five-hour',
              label: '5-hour',
              usedPercent: 25,
              resetAtMs: new Date(2026, 6, 29, 15).getTime(),
              periodHours: 5,
            },
          ],
        }),
      })
    );
    expect(markup).toContain(i18n.t('quota_management.windows_title_session'));
    expect(markup).toContain('00:00');
    expect(markup).toContain('12:00');
    expect(markup).toContain('23:00');
    expect(markup.match(/data-hour=/g)).toHaveLength(24);
    expect(markup).not.toContain('aria-pressed=');
    expect(markup).toMatch(/tabindex="0"/i);
  });

  test('dedicated charts remain visible while quota data is pending', () => {
    for (const mode of ['session', 'weekly'] as const) {
      const markup = renderToStaticMarkup(
        createElement(QuotaTimeline, {
          ...baseProps,
          fixedMode: mode,
          quotaFor: () => undefined,
        })
      );
      expect(markup).toContain(i18n.t(`quota_management.windows_title_${mode}`));
      expect(markup).toContain('role="status"');
    }
  });
  test('shows the selected period date instead of always labelling it Today', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        initialOffset: 1,
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              label: '7-day',
              usedPercent: 25,
              resetAtMs: new Date(2026, 7, 1, 12).getTime(),
              periodHours: 168,
            },
          ],
        }),
      })
    );

    // The next weekly period starts on Sunday 08/02. The button remains the
    // shortcut back to Today (aria-label/title), but its visible label now
    // reflects the period selected with the previous/next arrows.
    expect(markup).toMatch(
      /<button type="button" aria-label="[^"]+" title="[^"]+">08\/02<\/button>/
    );
  });

  test('keeps the panel and controls visible when 5-hour mode has no matching lanes', () => {
    const weeklyOnlyQuota = {
      status: 'success' as const,
      windows: [
        {
          label: '7-day',
          usedPercent: 25,
          resetAtMs: new Date(2026, 7, 1, 12).getTime(),
          periodHours: 168,
        },
      ],
    };

    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        initialMode: 'session',
        quotaFor: () => weeklyOnlyQuota,
      })
    );

    expect(markup).toContain('<section');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('role="status"');
  });

  test('renders a Kimi 5-hour lane from the protobuf-style time unit', () => {
    const rows = buildKimiQuotaRows({
      usage: {
        used: '1',
        limit: '100',
        resetTime: '2099-08-06T13:59:23.136523Z',
      },
      limits: [
        {
          window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' },
          detail: {
            used: '2',
            limit: '100',
            resetTime: '2099-07-31T06:59:23.136523Z',
          },
        },
      ],
    });

    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries: [
          {
            file: { name: 'kimi-real-response.json', type: 'kimi' },
            type: 'kimi',
          },
        ],
        displayNameFor: (name: string) => name,
        resolvedTheme: 'light',
        now: new Date('2099-07-31T04:40:00Z').getTime(),
        initialMode: 'session',
        quotaFor: () => ({ status: 'success', rows }),
      })
    );

    expect(markup).toContain('kimi-real-response.json');
    expect(markup).not.toContain('role="status"');
  });

  test('renders an unexpired Codex reset credit as an expiry tick', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries: [
          {
            file: { name: 'codex-credit.json', type: 'codex' },
            type: 'codex',
          },
        ],
        displayNameFor: (name: string) => name,
        resolvedTheme: 'light',
        now: new Date(2026, 6, 29, 12).getTime(),
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              label: '7-day',
              usedPercent: 90,
              resetAtMs: new Date(2026, 7, 1, 12).getTime(),
              periodHours: 168,
            },
          ],
          rateLimitResetCredits: [
            {
              id: 'credit-1',
              status: 'available',
              grantedAt: '2026-07-20T12:00:00Z',
              expiresAt: '2026-08-03T12:00:00Z',
            },
          ],
        }),
      })
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain('08/03 12:00');
  });

  test('stays hidden before any credential exposes a usable quota window', () => {
    const markup = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        ...baseProps,
        quotaFor: () => undefined,
      })
    );

    expect(markup).toBe('');
  });
});
