import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/services/api/client';
import { usageRecordsApi, type UsageRecord } from '@/services/api/usageRecords';
import { mergeUsageRecords, parseUsageCsv } from './model';
import { appendUsageHistory, readUsageHistory, writeUsageHistory } from './storage';

export function useUsageRecords(scope: string, connected: boolean, pageActive: boolean) {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [lastRead, setLastRead] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const active = useRef(true);
  const running = useRef(false);
  const current = useRef<UsageRecord[]>([]);
  const lastAttempt = useRef(0);
  const revision = useRef(apiClient.getConnectionRevision());
  const eligibility = useRef({ pageActive, connected });
  useEffect(() => {
    eligibility.current = { pageActive, connected };
  }, [pageActive, connected]);
  const isCurrent = useCallback(
    () => active.current && revision.current === apiClient.getConnectionRevision(),
    []
  );
  useEffect(() => {
    active.current = true;
    const focus = () =>
      setFocused(document.visibilityState === 'visible' && document.hasFocus() && navigator.onLine);
    focus();
    window.addEventListener('focus', focus);
    window.addEventListener('blur', focus);
    window.addEventListener('online', focus);
    window.addEventListener('offline', focus);
    document.addEventListener('visibilitychange', focus);
    void readUsageHistory(scope)
      .then((saved) => {
        if (!isCurrent()) return;
        current.current = saved;
        setRecords(saved);
        setLoaded(true);
      })
      .catch(() => {
        if (isCurrent()) {
          setError('storage_error');
          setLoaded(true);
        }
      });
    return () => {
      active.current = false;
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('offline', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [scope, isCurrent]);

  const save = useCallback(
    async (incoming: UsageRecord[]) => {
      if (!isCurrent()) return;
      try {
        const merged = await appendUsageHistory(scope, incoming);
        if (!isCurrent()) return;
        current.current = merged;
        setRecords(merged);
      } catch (error) {
        // A consumed queue batch must remain exportable even if durable storage fills up.
        if (isCurrent()) {
          current.current = mergeUsageRecords(current.current, incoming, Date.now());
          setRecords(current.current);
        }
        throw error;
      }
    },
    [isCurrent, scope]
  );

  const collect = useCallback(async () => {
    if (
      !collecting ||
      !pageActive ||
      !connected ||
      !loaded ||
      running.current ||
      !isCurrent() ||
      document.visibilityState !== 'visible' ||
      !document.hasFocus() ||
      !navigator.onLine ||
      Date.now() - lastAttempt.current < 30_000
    )
      return;
    running.current = true;
    setBusy(true);
    const perform = async () => {
      // Verify durable storage BEFORE consuming the shared queue.
      await readUsageHistory(scope);
      if (
        !isCurrent() ||
        !eligibility.current.pageActive ||
        !eligibility.current.connected ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus() ||
        !navigator.onLine
      )
        return;
      lastAttempt.current = Date.now();
      const incoming = await usageRecordsApi.collect();
      await save(incoming);
      if (isCurrent()) {
        setError('');
        setLastRead(Date.now());
      }
    };
    try {
      if (navigator.locks) {
        await navigator.locks.request(
          `cliproxy-usage:${scope}`,
          { ifAvailable: true },
          async (lock) => {
            if (lock) await perform();
          }
        );
      } else await perform();
    } catch {
      if (isCurrent()) {
        setError('collection_error');
        setCollecting(false);
      }
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }, [collecting, connected, loaded, scope, save, isCurrent, pageActive]);

  useEffect(() => {
    if (!collecting || !focused || !pageActive) return;
    const timer = setInterval(() => void collect(), 30_000);
    void collect();
    return () => clearInterval(timer);
  }, [collect, collecting, focused, pageActive]);

  const importCsv = async (file: File) => {
    if (!loaded || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      if (file.size > 20_000_000) throw new Error('File too large');
      const incoming = parseUsageCsv(await file.text());
      if (!incoming.length) throw new Error('No valid records');
      await save(incoming);
      if (isCurrent()) setError('');
    } catch {
      if (isCurrent()) setError('import_error');
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  };
  const clear = async () => {
    if (running.current || !isCurrent()) return;
    running.current = true;
    try {
      setCollecting(false);
      await writeUsageHistory(scope, []);
      if (isCurrent()) {
        current.current = [];
        setRecords([]);
        setError('');
      }
    } catch {
      if (isCurrent()) setError('storage_error');
    } finally {
      running.current = false;
    }
  };
  const reload = useCallback(async () => {
    if (running.current || !isCurrent()) return;
    try {
      const saved = await readUsageHistory(scope);
      if (isCurrent()) {
        current.current = saved;
        setRecords(saved);
      }
    } catch {
      if (isCurrent()) setError('storage_error');
    }
  }, [scope, isCurrent]);
  return {
    records,
    collecting,
    setCollecting,
    busy,
    loaded,
    error,
    lastRead,
    focused,
    collect,
    importCsv,
    clear,
    reload,
  };
}
