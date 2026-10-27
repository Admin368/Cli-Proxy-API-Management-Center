import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { normalizeUsageTotal } from '@/utils/recentRequests';
import { QUOTA_TAB_ORDER } from './constants';
import type { QuotaProviderType } from './providers/types';
import type { QuotaCardState } from './providers';

const PREFIX = 'quotaPage.snapshot.v1.';
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_BYTES = 2_000_000;
type Schema = 'text' | 'string' | 'number' | 'boolean' | { [key: string]: Schema } | [Schema];
const fields = (names: string, type: Schema): Record<string, Schema> =>
  Object.fromEntries(names.split(' ').map((key) => [key, type]));
const windowSchema: Schema = {
  labelParams: { duration: 'string', index: 'number', model: 'string', name: 'string' },
  ...fields('id label resetLabel', 'text'),
  ...fields('labelKey resetHint', 'string'),
  ...fields(
    'usedPercent remainingPercent resetAtMs periodHours used limit resetAt durationMinutes',
    'number'
  ),
};
const bucket: Schema = {
  ...fields('id label', 'text'),
  ...fields('window resetTime description', 'string'),
  ...fields('remainingFraction resetAtMs periodHours', 'number'),
};
// Persist only known quota/display fields. No auth files, raw responses, errors, or credentials.
const schemas: Record<QuotaProviderType, Record<string, Schema>> = {
  claude: {
    windows: [windowSchema],
    observedAt: 'string',
    planType: 'string',
    extraUsage: {
      ...fields('isEnabled userDisabled spendLimitReached', 'boolean'),
      ...fields('monthlyLimit usedCredits utilization', 'number'),
      ...fields('currency disabledReason', 'string'),
    },
    dollarWindows: [
      {
        ...fields('key resetsAt', 'string'),
        ...fields('limitDollars usedDollars remainingDollars utilization', 'number'),
      },
    ],
  },
  codex: {
    windows: [windowSchema],
    ...fields('planType creditBalance subscriptionActiveUntil', 'string'),
    creditsUnlimited: 'boolean',
  },
  devin: {
    windows: [windowSchema],
    plan: 'string',
    ...fields('observedAtMs planStartMs planEndMs', 'number'),
  },
  antigravity: {
    groups: [{ ...fields('id label description', 'string'), buckets: [bucket] }],
    serverTimeOffsetMs: 'number',
    subscription: fields('plan tierName tierId', 'string'),
  },
  plugin: {
    groups: [{ ...fields('id label description', 'string'), buckets: [bucket] }],
    subscription: fields('plan tierName tierId', 'string'),
    summary: [{ ...fields('key label unit format currency', 'string'), value: 'number' }],
  },
  kimi: { rows: [windowSchema] },
  meta: { data: { planName: 'string', isSubscriptionActive: 'boolean', windows: [windowSchema] } },
  xai: {
    billing: {
      ...fields(
        'mode source planType healthStatus periodType periodStart periodEnd planLabel planTier billingPeriodStart billingPeriodEnd',
        'string'
      ),
      ...fields(
        'usagePercent monthlyLimitCents usedCents includedUsedCents onDemandCapCents onDemandUsedCents onDemandUsedPercent prepaidBalanceCents usedPercent resetAtMs periodHours',
        'number'
      ),
      productUsage: [{ product: 'string', usagePercent: 'number' }],
    },
  },
};

function project(value: unknown, schema: Schema, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (schema === 'text') return typeof value === 'string' ? value.slice(0, 1000) : '';
  if (Array.isArray(schema)) {
    return Array.isArray(value)
      ? value.slice(0, 200).flatMap((item) => {
          const next = project(item, schema[0], depth + 1);
          return next == null ? [] : [next];
        })
      : [];
  }
  if (value === null) return null;
  if (typeof schema === 'string') {
    if (typeof value !== schema) return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return typeof value === 'string' ? value.slice(0, 1000) : value;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, field]) => {
      const next = project(record[key], field, depth + 1);
      return next === undefined ? [] : [[key, next]];
    })
  );
}

export function sanitizeQuota(type: QuotaProviderType, value: unknown): QuotaCardState | null {
  if (!value || typeof value !== 'object' || (value as QuotaCardState).status !== 'success')
    return null;
  const data = project(value, schemas[type]);
  if (!data || typeof data !== 'object') return null;
  return { ...data, status: 'success' };
}

export function quotaSnapshotScope(apiBase: string, managementKey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([apiBase, managementKey]))));
}

const fileSchema: Schema = {
  ...fields('name type provider quotaProvider quotaPluginId', 'string'),
  ...fields('supportsQuota disabled', 'boolean'),
  ...fields('modified success failed', 'number'),
};
export function snapshotFile(file: AuthFileItem): AuthFileItem {
  const safe = project(file, fileSchema) as AuthFileItem;
  for (const field of ['success', 'failed'] as const) {
    if (typeof file[field] === 'number' || typeof file[field] === 'string') {
      safe[field] = normalizeUsageTotal(file[field]);
    }
  }
  if (typeof file.authIndex === 'string' || typeof file.authIndex === 'number')
    safe.authIndex = file.authIndex;
  return safe;
}
export const snapshotIdentity = (file: AuthFileItem) =>
  JSON.stringify([file.name, file.authIndex ?? null, file.modified ?? null]);
export const snapshotKey = (type: QuotaProviderType, file: AuthFileItem) =>
  `${type}:${getQuotaCacheKey(file)}`;

export type QuotaSnapshot = {
  savedAt: number;
  files: AuthFileItem[];
  quotas: Record<
    string,
    { identity: string; savedAt: number; type: QuotaProviderType; value: QuotaCardState }
  >;
};

export function resolveSavedQuota(
  type: QuotaProviderType,
  file: AuthFileItem,
  current: QuotaCardState | undefined,
  snapshot: QuotaSnapshot | null,
  invalidated: boolean,
  refreshing: boolean
): QuotaCardState | undefined {
  if (current?.status === 'success') return current;
  const saved = snapshot?.quotas[snapshotKey(type, file)];
  if (!saved || saved.identity !== snapshotIdentity(file) || invalidated) return current;
  return {
    ...saved.value,
    cachedAt: saved.savedAt,
    refreshing: current?.status === 'loading' || refreshing,
    refreshFailed: current?.status === 'error',
  };
}

export function readQuotaSnapshot(scope: string, now = Date.now()): QuotaSnapshot | null {
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw || raw.length > MAX_BYTES) return null;
    const input = JSON.parse(raw) as QuotaSnapshot;
    if (
      !input ||
      !Number.isFinite(input.savedAt) ||
      now - input.savedAt > MAX_AGE_MS ||
      input.savedAt > now ||
      !Array.isArray(input.files)
    )
      return null;
    const files = input.files
      .slice(0, 500)
      .filter((file) => file && typeof file.name === 'string')
      .map(snapshotFile);
    const quotas: QuotaSnapshot['quotas'] = {};
    if (!input.quotas || typeof input.quotas !== 'object') return null;
    for (const [key, entry] of Object.entries(input.quotas).slice(0, 500)) {
      if (
        !entry ||
        !QUOTA_TAB_ORDER.includes(entry.type) ||
        typeof entry.identity !== 'string' ||
        !Number.isFinite(entry.savedAt) ||
        entry.savedAt > now ||
        now - entry.savedAt > MAX_AGE_MS
      )
        continue;
      const value = sanitizeQuota(entry.type, entry.value);
      if (value)
        quotas[key] = { identity: entry.identity, savedAt: entry.savedAt, type: entry.type, value };
    }
    return { savedAt: input.savedAt, files, quotas };
  } catch {
    return null;
  }
}

export function writeQuotaSnapshot(scope: string, snapshot: QuotaSnapshot) {
  try {
    const raw = JSON.stringify(snapshot);
    if (raw.length <= MAX_BYTES) localStorage.setItem(PREFIX + scope, raw);
  } catch {
    /* Browser storage may be unavailable or full. */
  }
}

export function clearSavedQuotaSnapshots() {
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* Logout must work without browser storage. */
  }
}
