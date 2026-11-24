export interface DesktopUsageConnection {
  url: string;
  token: string;
}
const PREFIX = 'usagePage.desktop:';
export function readDesktopUsageConnection(scope: string): DesktopUsageConnection | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PREFIX + scope) ?? 'null');
    if (
      value &&
      typeof value === 'object' &&
      'url' in value &&
      'token' in value &&
      typeof value.url === 'string' &&
      typeof value.token === 'string'
    ) {
      return { url: value.url, token: value.token };
    }
  } catch {
    /* No automatic opt-in without valid settings. */
  }
  return null;
}
export function writeDesktopUsageConnection(scope: string, value: DesktopUsageConnection | null) {
  if (value) sessionStorage.setItem(PREFIX + scope, JSON.stringify(value));
  else sessionStorage.removeItem(PREFIX + scope);
}
export function clearDesktopUsageConnections() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    /* Storage can be disabled. */
  }
}
