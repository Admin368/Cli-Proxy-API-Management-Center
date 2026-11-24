import { apiClient } from './client';
import { normalizeApiBase } from '@/utils/connection';
import type { QuotaObservation } from '@/features/quota/forecast';

export interface SharedQuotaData {
  observations: QuotaObservation[];
  preferences: Record<string, unknown>;
  lastActivityAt?: number;
}
/** Exact backend-declared plugin extension path, independent of normal v8 domain routes. */
export function quotaForecastConnection(apiBase: string) {
  const client = apiClient.captureConnection();
  const url = `${normalizeApiBase(apiBase)}/v0/management/plugins/custom-web-ui/forecast`;
  return {
    read: () => client.get<SharedQuotaData>(url),
    update: (patch: Partial<SharedQuotaData>) => client.put<SharedQuotaData>(url, patch),
  };
}
