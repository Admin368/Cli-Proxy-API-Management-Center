export type QuotaView = 'overview' | 'timeline';
const KEY = 'quotaPage.view';

export function readQuotaView(): QuotaView {
  try {
    return window.localStorage.getItem(KEY) === 'timeline' ? 'timeline' : 'overview';
  } catch {
    return 'overview';
  }
}

export function writeQuotaView(view: QuotaView) {
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    // Switching views remains available without persistent storage.
  }
}
