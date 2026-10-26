import { useEffect, useRef, useState } from 'react';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { useQuotaStore } from '@/stores';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS } from '../providers';
import { LIVE_TICK_MS, QuotaPollQueue, readQuotaLive, writeQuotaLive } from '../livePolling';

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
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const queue = useRef({ generation: options.generation, value: new QuotaPollQueue() });
  const running = useRef(false);

  useEffect(() => {
    if (queue.current.generation !== options.generation) {
      queue.current = { generation: options.generation, value: new QuotaPollQueue() };
    }
    if (!live) return;
    let stopped = false;
    let nextListRead = Date.now() + 120_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const current = latest.current;
        if (
          stopped ||
          running.current ||
          !current.connected ||
          current.busy ||
          document.visibilityState !== 'visible' ||
          !navigator.onLine ||
          current.generation !== useQuotaStore.getState().cacheGeneration
        )
          return;
        if (Date.now() >= nextListRead) {
          running.current = true;
          try {
            await current.refreshFiles();
          } finally {
            nextListRead = Date.now() + 120_000;
            running.current = false;
          }
          return;
        }
        if (!current.ready) return;
        const eligible = current.entries.filter((entry) => !entry.file.disabled);
        const keyFor = (entry: QuotaFileEntry) => `${entry.type}:${getQuotaCacheKey(entry.file)}`;
        const activeQueue = queue.current.value;
        const key = activeQueue.next(eligible.map(keyFor), Date.now());
        const entry = eligible.find((candidate) => keyFor(candidate) === key);
        if (!entry || !key) return;
        running.current = true;
        let success = false;
        try {
          await current.loadQuota([entry]);
          const adapter = QUOTA_ADAPTERS[entry.type];
          const state = adapter.storeSelector(useQuotaStore.getState());
          success = state[getQuotaCacheKey(entry.file)]?.status === 'success';
        } finally {
          activeQueue.complete(key, Date.now(), success);
          running.current = false;
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll().catch(() => {}), LIVE_TICK_MS);
      }
    };
    timer = setTimeout(() => void poll().catch(() => {}), 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live, options.generation]);

  return {
    live,
    setLive: (enabled: boolean) => {
      writeQuotaLive(enabled);
      setLive(enabled);
    },
  };
}
