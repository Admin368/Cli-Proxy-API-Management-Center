import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { apiClient } from './client';

export interface UsageRecord {
  id: string;
  timestamp: number;
  model: string;
  effort: string;
  provider: string;
  source: string;
  keyId: string;
  failed: boolean;
  canceled: boolean;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
  latencyMs: number | null;
  ttftMs: number | null;
  cost: number | null;
}

export const usageFingerprint = (value: string) =>
  bytesToHex(sha256(new TextEncoder().encode(value)));
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value.slice(0, 240).trim() : '');
const number = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const bool = (value: unknown) => value === true || value === 'true';

/** Only known auth filenames are displayed: API-key sources can themselves contain secrets. */
function safeSource(value: unknown): string {
  const source = text(value);
  return /^[\w.@+() -]+\.json$/i.test(source) ? source : '';
}

/** Shared by the documented v8 queue and desktop CSV imports. Raw keys/headers/bodies are discarded. */
export function normalizeUsageRecord(value: unknown): UsageRecord | null {
  const row = object(value);
  const timestamp = Date.parse(text(row.timestamp));
  const id = text(row.execution_id) || text(row.request_id) || text(row.id);
  if (!id || !Number.isFinite(timestamp)) return null;
  const tokens = Object.keys(object(row.tokens)).length ? object(row.tokens) : row;
  const input = number(tokens.input_tokens);
  const output = number(tokens.output_tokens);
  const suppliedHash = text(row.api_key_hash);
  const rawKey = typeof row.api_key === 'string' ? row.api_key : '';
  const keyId = /^[a-f0-9]{64}$/i.test(suppliedHash)
    ? suppliedHash.toLowerCase()
    : rawKey
      ? usageFingerprint(rawKey)
      : '';
  const source = safeSource(row.source_display) || safeSource(row.source);
  return {
    id: /^[a-f0-9]{64}$/i.test(id) ? id.toLowerCase() : usageFingerprint(id),
    timestamp,
    model: text(row.resolved_model) || text(row.model),
    effort: text(row.reasoning_effort),
    provider: text(row.provider),
    source: rawKey && source === rawKey ? '' : source,
    keyId,
    failed: bool(row.failed),
    canceled:
      bool(row.canceled) || (bool(row.failed) && number(object(row.fail).status_code) === 499),
    input,
    output,
    reasoning: number(tokens.reasoning_tokens),
    cacheRead: number(tokens.cache_read_tokens),
    cacheWrite: number(tokens.cache_creation_tokens),
    total:
      number(tokens.total_tokens) ?? (input !== null && output !== null ? input + output : null),
    latencyMs: number(row.latency_ms),
    ttftMs: number(row.ttft_ms),
    cost: number(row.estimated_cost_usd),
  };
}

export const usageRecordsApi = {
  /** Destructive read: this POPS the shared backend queue. Invoke only after explicit opt-in. */
  async collect(): Promise<UsageRecord[]> {
    const data: unknown = await apiClient.get('/observability/usage/queue', {
      params: { count: 200 },
      timeout: 15_000,
    });
    if (!Array.isArray(data)) throw new Error('Invalid usage queue response');
    return data.flatMap((row) => {
      const record = normalizeUsageRecord(row);
      return record ? [record] : [];
    });
  },
};

/** Re-project browser history too; never trust arbitrary properties in an old/corrupt cache. */
export function restoreUsageRecord(value: unknown): UsageRecord | null {
  const row = object(value);
  if (
    !/^[a-f0-9]{64}$/i.test(text(row.id)) ||
    typeof row.timestamp !== 'number' ||
    !Number.isFinite(row.timestamp) ||
    Math.abs(row.timestamp) > 8.64e15
  )
    return null;
  return normalizeUsageRecord({
    id: row.id,
    timestamp: new Date(row.timestamp).toISOString(),
    model: row.model,
    reasoning_effort: row.effort,
    provider: row.provider,
    source: row.source,
    api_key_hash: row.keyId,
    failed: row.failed,
    canceled: row.canceled,
    input_tokens: row.input,
    output_tokens: row.output,
    reasoning_tokens: row.reasoning,
    cache_read_tokens: row.cacheRead,
    cache_creation_tokens: row.cacheWrite,
    total_tokens: row.total,
    latency_ms: row.latencyMs,
    ttft_ms: row.ttftMs,
    estimated_cost_usd: row.cost,
  });
}
