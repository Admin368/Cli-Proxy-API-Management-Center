/**
 * Where desktop history comes from:
 * - `plugin`: the proxy's custom-web-ui plugin, through the signed-in Management API
 *   connection (works from any machine that can reach the proxy; no extra token).
 * - `helper`: the standalone loopback helper (scripts/usage-helper) with its own token.
 */
export type DesktopUsageConnection =
  { kind: 'plugin' } | { kind: 'helper'; url: string; token: string };
const PREFIX = 'usagePage.desktop:';
export function readDesktopUsageConnection(scope: string): DesktopUsageConnection | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(PREFIX + scope) ?? 'null');
    if (value && typeof value === 'object') {
      if ('kind' in value && value.kind === 'plugin') return { kind: 'plugin' };
      if (
        'url' in value &&
        'token' in value &&
        typeof value.url === 'string' &&
        typeof value.token === 'string'
      ) {
        return { kind: 'helper', url: value.url, token: value.token };
      }
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
