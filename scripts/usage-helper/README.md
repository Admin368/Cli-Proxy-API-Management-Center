# Desktop usage helper

This optional Python 3.10+ helper reads the official EasyCLIProxyAPI desktop application's SQLite history. It does not replace, rebuild, configure, or drain the desktop/core collector. No Python packages are required.

From the management frontend repository, run (PowerShell example):

```powershell
python scripts/usage-helper/server.py `
  --database 'C:\path\to\EasyCLIProxyAPI\usage-records\usage.db' `
  --token-file "$env:LOCALAPPDATA\CLIProxyUsageHelper\access-token.txt" `
  --origin 'http://localhost:5173' `
  --backend 'http://127.0.0.1:8317'
```

Use the exact origin of the web page (scheme, hostname and port, without a path or trailing slash). Repeat `--origin` for additional trusted origins. `--backend` must match the connection URL entered at web login (`localhost` and `127.0.0.1` are accepted as equivalent when scheme, port and path match); this prevents accidentally importing this desktop's records into a different backend connection. The helper listens only on `http://127.0.0.1:8318`; use `--port` to change it. The URL must use `127.0.0.1`, not `localhost`.

The token file is generated on first launch and reused thereafter. Keep it private and outside the repository. Open it locally to copy its contents; never use the management key as the helper token.

In **Usage → Request details → Desktop history helper**, enter the helper URL and token, select **Use desktop history**, and enable **Live collection**. The URL/token are stored in this browser tab's session storage, scoped to the current backend and management credential, and cleared on logout. Switching sources requires enabling collection again. The helper never receives the management credential.

While Request details is open and focused, the web app reads up to 500 records per page, every 30 seconds. It catches up the most recent 10,000 database rows on each page visit, then follows new row IDs. Browser history retains the existing 10,000-record / 30-day limit. Deleting browser history does not delete desktop history; re-enabling desktop sync can import it again. Desktop deletions or edits to older rows are reflected when revisiting Request details, but already imported browser records retain their own local lifetime. Costs remain blank because desktop costs are calculated dynamically rather than stored on event rows.

Keep the helper running for sync; Ctrl+C stops a foreground instance. It is not installed as a Windows service or startup task. The desktop app must run to collect new requests; the helper can read previously saved history even when it is closed. If an official desktop update moves the installation directory, restart the helper with the new database path. Unsupported schemas fail closed without migration. Do not copy a live `usage.db` alone: its WAL can contain recent records. The helper reads SQLite normally in read-only mode, including the WAL.

The helper belongs on the desktop machine. A browser on another machine cannot reach that machine through its own `127.0.0.1`. HTTPS pages may also require browser permission to access local services; browser policy can block such requests. A remote setup needs an explicitly designed authenticated HTTPS reverse proxy rather than exposing this helper publicly.

Verification: `bun test tests/desktopUsageHelper.test.ts` invokes the Python integration tests using temporary fixture databases. Python must also be available when running the full Bun test suite. No tests read your personal database.


Account attribution is carried as a SHA-256 fingerprint of the desktop's `auth_index`, independently of the sanitized source. The frontend resolves account names from the authenticated v8 credential listing; retired/unmatched accounts retain separate anonymous labels. The client API-key fingerprint is not used as an upstream account identity. Token analytics automatically replays configured desktop history once when it finds unattributed rows; **Recover desktop history** also allows an explicit replay. Stable desktop row IDs let recovered fields replace old browser rows without duplication.

Request-log identifiers are retained separately for on-demand inspection through the existing authenticated core request-log endpoint. Click a model in Request details to inspect its request and response bodies. Logs must have been recorded and retained by the current core; missing IDs, old/deleted logs and logs larger than 4 MB show an availability message. Headers are excluded from the inspector, and bodies are not persisted in browser usage history. Selecting chart bars or account totals opens corresponding request filters.

**Quota Management → Capacity forecast** is a separate view (`#/quota/forecast`). It records fresh quota responses while the quota page is open, scoped to the connection, up to 5,000 observations / 14 days. It does not add a background quota collector to this helper. Forecasts require at least five minutes of readings in one reset window and stop after 30 minutes without a fresh observation. Session and long windows are separate, future demand is adjustable, and scheduled resets repeat only as a stated projection assumption. Percentages are summed account percentage points with equal weighting, not a token budget; disabled/unavailable accounts are excluded. Manual reset-credit expiry is displayed without assuming a credit will be used. Historical gaps remain blank. This view does not alter routing.
