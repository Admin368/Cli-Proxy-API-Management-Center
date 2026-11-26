import { useEffect, useState } from 'react';
import { useAuthStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { quotaForecastConnection } from '@/services/api/quotaForecast';
import { FORECAST_EVENT, readObservations, saveObservations } from './forecast';
import {
  readForecastPreferences,
  writeForecastPreferences,
  FORECAST_PREFERENCES_KEY,
} from './forecastPreferences';
import { readQuotaUiState, writeQuotaUiState, isQuotaTabId, isQuotaSortMode } from './uiState';
import {
  QUOTA_PREFERENCE_CHANGE,
  QUOTA_PREFERENCE_RESTORE,
  untouchedPreferences,
} from './preferenceEvents';

const pendingWrites = new Map<string, Promise<unknown>>();

export function useSharedQuotaForecast(scope: string) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [shared, setShared] = useState(false);
  useEffect(() => {
    if (!connected) return;
    const client = quotaForecastConnection(apiBase);
    const revision = apiClient.getConnectionRevision();
    let disposed = false,
      loaded = false;
    let preferenceRevision = 0;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const dirty = new Set<string>();
    const changedAt = new Map<string, number>();
    const pending: Record<string, unknown> = {};
    let writes: Promise<unknown> = pendingWrites.get(scope) ?? Promise.resolve();
    const current = () => !disposed && apiClient.getConnectionRevision() === revision;
    const send = (patch: Parameters<typeof client.update>[0]) => {
      const captured = {
        ...patch,
        ...(patch.preferences ? { preferences: { ...patch.preferences } } : {}),
      };
      writes = writes
        .catch(() => {})
        .then(async () => {
          if (apiClient.getConnectionRevision() !== revision) return;
          const result = await client.update(captured);
          if (!current()) return;
          for (const [key, value] of Object.entries(captured.preferences ?? {})) {
            if (pending[key] === value) {
              delete pending[key];
              dirty.delete(key);
            }
          }
          return result;
        });
      pendingWrites.set(scope, writes);
      const queued = writes;
      const cleanup = () => {
        if (pendingWrites.get(scope) === queued) pendingWrites.delete(scope);
      };
      void queued.then(cleanup, cleanup);
    };
    const preferenceChange = (event: Event) => {
      preferenceRevision++;
      const patch = (event as CustomEvent<Record<string, unknown>>).detail;
      Object.keys(patch).forEach((key) => {
        dirty.add(key);
        changedAt.set(key, preferenceRevision);
      });
      Object.assign(pending, patch);
      send({ preferences: patch });
    };
    const observationsChange = () => {
      if (!loaded) return;
      clearTimeout(observationTimer);
      observationTimer = setTimeout(() => send({ observations: readObservations(scope) }), 250);
    };
    window.addEventListener(QUOTA_PREFERENCE_CHANGE, preferenceChange);
    window.addEventListener(FORECAST_EVENT, observationsChange);
    const load = async () => {
      try {
        const revisionAtRead = preferenceRevision;
        await (pendingWrites.get(scope) ?? Promise.resolve()).catch(() => {});
        if (!current()) return;
        const data = await client.read();
        if (!current()) return;
        if (Array.isArray(data.observations)) saveObservations(scope, data.observations);
        {
          const blocked = new Set([
            ...dirty,
            ...[...changedAt].filter(([, at]) => at > revisionAtRead).map(([key]) => key),
          ]);
          const remote = untouchedPreferences(data.preferences ?? {}, blocked);
          if (Object.keys(data.preferences ?? {}).length) {
            writeForecastPreferences({ ...readForecastPreferences(), ...remote }, false);
            writeQuotaUiState(
              {
                ...(isQuotaTabId(remote.tab) ? { tab: remote.tab } : {}),
                ...(isQuotaSortMode(remote.sortMode) ? { sortMode: remote.sortMode } : {}),
                ...(typeof remote.cooldownLast === 'boolean'
                  ? { cooldownLast: remote.cooldownLast }
                  : {}),
              },
              false
            );
            window.dispatchEvent(new CustomEvent(QUOTA_PREFERENCE_RESTORE, { detail: remote }));
          } else if (!loaded) {
            let forecast = {};
            try {
              if (localStorage.getItem(FORECAST_PREFERENCES_KEY))
                forecast = readForecastPreferences();
            } catch {
              /* Local storage may be restricted. */
            }
            Object.assign(pending, { ...forecast, ...readQuotaUiState(), ...pending });
          }
        }
        if (!loaded) {
          loaded = true;
          if (Object.keys(pending).length) send({ preferences: pending });
          send({ observations: readObservations(scope) });
        }
        setShared(true);
      } catch {
        /* An unavailable extension leaves existing local history usable. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      clearTimeout(observationTimer);
      window.removeEventListener(QUOTA_PREFERENCE_CHANGE, preferenceChange);
      window.removeEventListener(FORECAST_EVENT, observationsChange);
    };
  }, [scope, apiBase, connected]);
  return shared;
}
