# Custom Web UI controller

A Windows amd64 native plugin for the official EasyCLIProxyAPI portable app with CLIProxyAPI v8.0.53. It adds a **Custom Web UI** plugin menu with server status, **Start server**, **Stop server**, and **Open dashboard**. No desktop or core rebuild is needed.

## Build and install

Requires Go, an amd64 C compiler, Python with PyYAML, and Bun. Run `./build.ps1`, then:

```powershell
python install.py --installation 'C:\path\to\EasyCLIProxyAPI'
```

The installer preserves existing configuration, backs it up locally, enables only this plugin, and configures absolute checkout/Bun paths. A single DLL embeds the panel's HTML/CSS/JavaScript. The public resource path is declared by the core under `/v0/resource/plugins/custom-web-ui/panel`; this is a plugin resource contract, not a legacy Management API fallback.

Plugin controls use authenticated `/v0/management/plugins/custom-web-ui/status`, `/start`, and `/stop`. These are backend-declared plugin extension paths; ordinary app Management API calls remain v8. Only POST starts or stops a process. The resource GET route is static and cannot execute actions. EasyCLIProxyAPI injects its signed-in management connection into the plugin webview; the panel reads that existing connection at runtime. No key is built into HTML, saved by the plugin, or placed in URLs. All six app languages are supported.

## Serving modes and options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `dev` | `static` serves the built dashboard (`dist/`) from inside the plugin with no Bun or Python process. `dev` runs `bun run dev` on 127.0.0.1 as before. The installer selects `static`. |
| `dist_dir` | `<workspace>\dist` | Static mode: built dashboard to serve. Run `bun run build` after pulling changes. |
| `listen` | `127.0.0.1` | Static mode: comma-separated IP addresses, e.g. `127.0.0.1,100.64.0.1` to also serve on a Tailscale address. Addresses that are not available yet (Tailscale still starting, port busy) are retried every 10 seconds. `0.0.0.0`/`::` are refused: name each address, and scope the firewall rule to it. |
| `auto_start` | `false` | Start the dashboard server whenever the core loads the plugin, so it is up for as long as the core runs. Start/Stop in the panel still work. Errors appear in the panel instead of failing plugin load. |
| `usage_database` | none | The desktop app's `usage-records\usage.db`. Enables **Request details → Desktop history → Use proxy history (plugin)**. |

Static mode only serves regular files below `dist` (hidden files and paths outside `dist` are refused; extension-less paths fall back to `index.html`). The dashboard itself still connects to the proxy API you sign in to.

## Desktop history through the plugin

Authenticated `GET /v0/management/plugins/custom-web-ui/usage-records?after=<cursor>` returns the same pages as `scripts/usage-helper` (up to 500 records from the newest 10,000 rows, identical record ids and account fingerprints, no failure bodies, headers, raw keys or client IPs). The database is opened read-only per request and recent WAL records are included. It uses the dashboard's existing Management API sign-in, so it works from any machine that can reach the proxy, and the separate loopback helper and its token are not needed.

## Process ownership

Start launches exactly `bun run dev --host 127.0.0.1 --port <port> --strictPort` in the configured checkout. It uses Windows CreateProcess with a suspended parent, assigns a private Job Object, then resumes it. Every descendant stays in that job. Stop terminates only that job, never the proxy core or a process merely listening on the same port. An independently started server is reported as external and cannot be stopped by the plugin.

The job uses kill-on-close. Disabling the plugin or exiting/updating the core stops its managed web server. The code never runs user-supplied shell commands. Configuring another folder or port requires stopping the managed server first.

If the taskbar launcher is installed, installation links it to the same authenticated controller. Its shortcut starts the plugin-managed server rather than launching a second independent copy. EasyCLIProxyAPI must be running with this plugin enabled. Only the desktop config path and backend URL are stored in the launcher binding; its management key is read at click time and never written to the binding file.

## Verification and removal

`go test -count=1 ./...` checks a real child HTTP server start/stop, idempotent starts, external-server protection, and read-only resource routing. Live installation verification should check unauthenticated control rejection, resource loading, authenticated start/status/stop, port closure, and unchanged proxy availability.

Disable **custom-web-ui** in Plugins to stop its managed server. Restart the core to completely unload native DLLs. Restore the backed-up launcher script and remove its local `proxy-controller.txt` if reverting to standalone launching. Backups may contain credentials; keep them local.

## Shared forecast data (0.2.0)

The plugin also persists credential-free quota observations and quota UI preference patches in the configured `history_file`. It captures Claude 5h/7d and Codex reported quota percentages/reset timestamps from generation usage headers even when the custom UI is closed. It never estimates quota percentages from token counts. Observations retain hashed auth indexes, provider, observation/reset times, remaining percentage and window period only, with a 5-minute sampling bucket and a bound of 5,000 points / 14 days. Requests without quota headers cannot create quota history.

Authenticated GET/PUT `/v0/management/plugins/custom-web-ui/forecast` reads/merges observations and validated preferences. Preference patches preserve other controls; defaults are never written merely because a view mounted. The state is scoped to this installation, remains available across browser origins/profiles and core restarts, and is not erased by stopping the web server. Normal app API calls remain v8; the plugin extension uses the backend-declared route.

`seed_history.py` can recover older quota readings by matching retained request-log IDs to the read-only desktop usage database. It reads only response quota headers for a single, unambiguous upstream attempt. It rejects retry logs whose account cannot be verified. Output contains no headers, credentials or request/response bodies. Import its `observations` JSON through the authenticated forecast PUT route, preserving preferences.
