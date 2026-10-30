import { useEffect, useRef, useState } from 'react';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { useQuotaStore } from '@/stores';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS } from '../providers';
import {
  LIVE_TICK_MS,
  QuotaPollQueue,
  readQuotaLive,
  writeQuotaLive,
  readQuotaRefreshMinutes,
} from '../livePolling';

type Options = {
  entries: QuotaFileEntry[];
  ready: boolean;
  connected: boolean;
  busy: boolean;
  generation: number;
  loadQuota: (entries: QuotaFileEntry[]) => Promise<void>;
  refreshFiles: () => Promise<void>;
};

export function useQuotaLive(options: Options) {
  const [live, setLive] = useState(readQuotaLive);
  const [refreshMinutes, setRefreshMinutes] = useState(readQuotaRefreshMinutes);
  useEffect(() => {
    const update = () => setRefreshMinutes(readQuotaRefreshMinutes());
    window.addEventListener('storage', update);
    window.addEventListener('quota-refresh-interval-change', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('quota-refresh-interval-change', update);
    };
  }, []);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const queue = useRef({ generation: options.generation, value: new QuotaPollQueue() });
  const running = useRef(false);
  const lastRequest = useRef(0);

  useEffect(() => {
    if (queue.current.generation !== options.generation) {
      queue.current = { generation: options.generation, value: new QuotaPollQueue() };
    }
    if (!live) return;
    let stopped = false;
    let nextListRead = Date.now() + refreshMinutes * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = latest.current;
        if (
          stopped ||
          running.current ||
          Date.now() - lastRequest.current < LIVE_TICK_MS ||
          !current.connected ||
          current.busy ||
          document.visibilityState !== 'visible' ||
          !document.hasFocus() ||
          !navigator.onLine ||
          current.generation !== useQuotaStore.getState().cacheGeneration
        )
          return;
        if (Date.now() >= nextListRead) {
          lastRequest.current = Date.now();
          running.current = true;
          try {
            await current.refreshFiles();
          } finally {
            nextListRead = Date.now() + refreshMinutes * 60_000;
            running.current = false;
          }
          return;
        }
        if (!current.ready) return;
        // Disabled accounts remain eligible for read-only quota monitoring.
        const eligible = current.entries;
        const keyFor = (entry: QuotaFileEntry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`;
        const activeQueue = queue.current.value;
        const key = activeQueue.next(eligible.map(keyFor), Date.now());
        const entry = eligible.find((candidate) => keyFor(candidate) === key);
        if (!entry || !key) return;
        lastRequest.current = Date.now();
        running.current = true;
        let success = false;
        try {
          await current.loadQuota([entry]);
          const adapter = QUOTA_ADAPTERS[entry.type];
          const state = adapter.storeSelector(useQuotaStore.getState());
          success = state[getQuotaCacheKey(entry.file)]?.status === 'success';
        } finally {
          activeQueue.complete(key, Date.now(), success, refreshMinutes * 60_000);
          running.current = false;
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll().catch(() => {}), LIVE_TICK_MS);
      }
    };
    const wake = () => {
      if (running.current) return;
      clearTimeout(timer);
      void poll().catch(() => {});
    };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    timer = setTimeout(() => void poll().catch(() => {}), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [live, options.generation, refreshMinutes]);

  return {
    live,
    setLive: (enabled: boolean) => {
      writeQuotaLive(enabled);
      setLive(enabled);
    },
  };
}
