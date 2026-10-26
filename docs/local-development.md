# Personal local setup

## Start the web UI

Use the pinned Bun version (1.3.14), then run:

```powershell
bun install --frozen-lockfile
bun run dev
```

Vite binds to `127.0.0.1:5173` and fails if the port is occupied. This starts the
frontend only. Keep the existing CLIProxyAPI v8 backend running separately with
its current configuration and auth directory.

## Local names for multiple apps (Windows x64)

```powershell
.\scripts\Setup-LocalDomain.ps1
```

This downloads the official Caddy Windows x64 release, checks its published
SHA-512, and installs a shared router under `%LOCALAPPDATA%\LocalDevProxy`.
It creates a route for `http://local.cli` to `http://127.0.0.1:5173` and a
per-user Startup shortcut. The router binds only to loopback. Vite explicitly
allows `local.cli`; it does not allow arbitrary Host headers.

The final hosts-file registration requires Administrator access. If the script
reports access denied, run only the reported `Add-Content` command in an
Administrator PowerShell window. The rest of the setup runs as your normal
user. Use `-SkipHosts` to prepare a route without changing hostname resolution.

Add another app with the same script:

```powershell
.\scripts\Setup-LocalDomain.ps1 -Domain local.notes -Port 3000
```

Each app gets a separate file in `%LOCALAPPDATA%\LocalDevProxy\sites`; rerunning
the script reloads the shared router. Allow that explicit hostname in the other
app's dev server too. Each name needs a hosts entry, but every app shares port 80
and the router. Do not use wildcard hosts entries: Windows does not support them.
For many machines, keep the route files and this script in your personal setup
repository and register names on each machine. These names are local overrides,
not owned public domains; use explicit `http://local.cli` to avoid a search query.

On first visiting the new origin, sign in again with backend address
`http://127.0.0.1:8317` and your existing management key. Browser login storage
is separate per origin; backend accounts/configuration are shared. The router
does not rewrite backend-declared plugin or extension paths.

To restart the router manually:

```powershell
& "$env:LOCALAPPDATA\LocalDevProxy\Start-LocalDevProxy.ps1"
```

The frontend still needs `bun run dev` after a reboot. To uninstall, stop only
the Caddy process whose executable is under `LocalDevProxy`, remove the
`LocalDevProxy.lnk` shortcut from your Startup folder, and remove only your
`# LocalDevProxy` hosts entries. Port 80 and local admin port 2020 must be free
before the initial setup; inspect `%LOCALAPPDATA%\LocalDevProxy\stderr.log` if
startup fails.

## Quota home and Live

The root route opens `/quota`; the previous dashboard remains at `/dashboard`.
The overview includes every quota-capable account, regardless of the detail
filters or pagination. It preserves independent limits rather than averaging
unrelated quotas. Unsupported or unobserved values stay unknown. Request counts
come from each account's backend-reported totals, not a fabricated time series.

Live is on by default and saved in browser local storage. It visits one enabled
account at a time, waiting 5 seconds after completion before checking again,
with at least 2 minutes between reads of the same account. Failures back off
exponentially up to 15 minutes. Large account sets take longer to cycle.
The account inventory/request totals refresh every 2 minutes. Hidden pages,
offline browsers, disconnected sessions, and ongoing batch/reset operations
pause new reads. Leaving the route stops scheduling; an already-started read
may finish using the existing session guards. Provider adapters may perform
multiple upstream calls/enrichment for a single quota read.

Turning Live off leaves explicit refresh buttons available. Live covers every
enabled account; the manual refresh button retains its existing current-page
scope. Preferences are per browser origin, not synced between machines.
