import { restoreUsageRecord, type UsageRecord } from '@/services/api/usageRecords';
import { mergeUsageRecords } from './model';

let database: Promise<IDBDatabase> | null = null;
let epoch = 0;
const restore = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((row) => {
        const record = restoreUsageRecord(row);
        return record ? [record] : [];
      })
    : [];
function openDatabase() {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cliproxy-request-history', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Request history database is blocked'));
    }).catch((error) => {
      database = null;
      throw error;
    });
  }
  return database;
}

export async function readUsageHistory(scope: string): Promise<UsageRecord[]> {
  const revision = epoch;
  const db = await openDatabase();
  if (revision !== epoch) return [];
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('history', 'readonly');
    const request = transaction.objectStore('history').get(scope);
    request.onsuccess = () =>
      resolve(
        revision === epoch && Array.isArray(request.result)
          ? mergeUsageRecords(restore(request.result), [], Date.now())
          : []
      );
    request.onerror = () => reject(request.error);
  });
}

export async function writeUsageHistory(scope: string, records: UsageRecord[]) {
  const revision = epoch;
  const db = await openDatabase();
  if (revision !== epoch) return;
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('history', 'readwrite');
    transaction.objectStore('history').put(records, scope);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Merge inside a serialized IDB transaction so separate tabs cannot overwrite each other. */
export async function appendUsageHistory(scope: string, incoming: UsageRecord[]) {
  const revision = epoch;
  const db = await openDatabase();
  if (revision !== epoch) return [];
  return new Promise<UsageRecord[]>((resolve, reject) => {
    const transaction = db.transaction('history', 'readwrite');
    const store = transaction.objectStore('history');
    const read = store.get(scope);
    let merged: UsageRecord[] = [];
    read.onsuccess = () => {
      merged = mergeUsageRecords(restore(read.result), incoming, Date.now());
      store.put(merged, scope);
    };
    transaction.oncomplete = () => resolve(merged);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearUsageHistory() {
  epoch++;
  if (typeof indexedDB === 'undefined') return;
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('history', 'readwrite');
    transaction.objectStore('history').clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
