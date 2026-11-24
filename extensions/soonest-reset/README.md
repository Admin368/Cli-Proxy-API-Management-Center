# Soonest-reset routing extension

This Windows amd64 native plugin works with the existing official EasyCLIProxyAPI desktop build and CLIProxyAPI **v8.0.53**. Only the extension is compiled. It does not replace the desktop app or proxy core. Re-test the ABI and affinity integration before enabling it on a different core release.

## Routing behavior

- Among the host's eligible candidates in its selected priority tier, prefer the credential whose **weekly quota resets first**. Claude uses the unified 7-day reset; Codex uses the primary/secondary window explicitly reported as 10,080 minutes. This is an expiry preference, not a comparison of tokens or subscription capacity.
- Existing session affinity remains owned by the core. Bound sessions, parent/child sessions, explicit pins, unsupported lookups, and requests without a canonical session ID delegate to the built-in selector. Quota-only versus transient-failure rebinding remains the core's setting. Failover from an existing binding can therefore use the core's fallback ordering.
- If **any candidate** has unknown, expired, or more than 24-hour-old reset data, delegate to normal routing. This gives unknown accounts chances to acquire data instead of starving them. Do not infer reset times from token counts or advance a passed reset by an assumed week.
- Successful custom cold selections are bound by the core on completion. A bounded 60-second pending-session map keeps concurrent cold requests stable. Equal reset times rotate across new sessions.
- The host still controls model support, disabled credentials, priorities, 429 cooldowns, retries, and credentials removed during a request. This plugin never clears cooldowns or sends probe requests.

The desktop strategy selector will still say **round-robin**: that is the fallback strategy. The enabled **soonest-reset** plugin runs before it. Adding a new built-in dropdown choice would require rebuilding the desktop shell/core; do not put an unsupported strategy string into the config.

## Quota data and privacy

`usage.handle` observes selected response headers for completed generation requests, including streams. Count-tokens requests do not replace these observations. It retains only provider, observation time, weekly reset, and SHA-256 credential keys in the local state file. API keys, account names, request/response bodies, raw headers, and session IDs are not persisted. In-memory pending sessions also use hashed keys. No management key or network service is needed.

`seed.py` reads the desktop SQLite usage inbox in read-only mode and exports valid recent weekly reset timestamps keyed by hashed auth index. The plugin uses `host.auth.list` once per minute to associate those indexes with current runtime IDs; it does not request credential contents. The export is a separate seed file and never overwrites live state.

The state file is **connection-specific**. Use a different file for another proxy installation. It persists across restarts. `<state_file>.status.json` records registration time, last pick, custom selection count, core delegation count, and live observation count, and fallback reason counts (existing affinity, missing session, parent/pin, lookup failure, missing reset), with writes limited to once per five seconds during picks. Counts restart with the core/plugin instance.

## Build and test

Requires Go, a Windows amd64 C compiler, and Python 3.11+. Installation additionally uses PyYAML (`python -m pip install PyYAML`). From this directory:

```powershell
./build.ps1
Push-Location integration
 go test -count=1 -v ./...
Pop-Location
```

`go test ./...` tests parsing, staleness, fallback, eligibility, privacy, and pending-session behavior. `abi_test.py` loads the actual DLL and verifies C ABI callbacks and buffer ownership. `integration/affinity_test.go` loads the DLL with the pinned core SDK's real session-affinity selector and checks cold selection, successful binding, transient 503 preservation with quota-only rebind, 429 failover, and the resulting new binding. All tests use synthetic credentials and make no upstream requests. The core dependency is pinned in both Go modules and their checksum files.

## Install into a portable desktop installation

```powershell
python seed.py --database 'C:\path\EasyCLIProxyAPI\usage-records\usage.db' --output "$env:LOCALAPPDATA\CLIProxySoonestReset\seed.json"
python install.py --installation 'C:\path\EasyCLIProxyAPI'
```

The installer backs up both configurations under `%LOCALAPPDATA%\CLIProxySoonestReset\backups`, copies the tested DLL, enables global plugin loading and the plugin instance, and preserves the existing fallback and affinity settings. It refuses to enable a disabled plugin directory containing other DLLs. Configuration changes are picked up by the running core's file watcher. When replacing an existing DLL, disable and re-enable soonest-reset in the web Plugins page after copying it, so the host loads the new binary. Verify a new `loaded_at` in the diagnostic file; if the host does not reload plugins, restart the desktop core normally. Subsequent traffic should advance counters; custom selections require all eligible accounts to have reliable readings.

## Disable / rollback

Set `plugins.configs.soonest-reset.enabled: false` in the core YAML (or disable soonest-reset in the web Plugins page). This returns all picks to the core selector and leaves session affinity enabled. Do not delete a DLL while assuming that unloads native code: the host keeps resident native runtimes until process exit. Restart the core to completely unload it. Restore the saved config files only when needed, taking care not to overwrite newer settings. Backups can contain secrets; keep them local and never commit them.

Plugin priority controls precedence among plugins; larger values run first. Only the highest-priority active scheduler plugin is used. With soonest-reset as the only scheduler, leave priority at 0. This does not change credential priority tiers or override affinity.

Version 0.1.2 accepts the v8 combined-router request shape (empty Provider with a homogeneous Claude or Codex candidate pool), while retaining its mixed affinity namespace. Heterogeneous provider pools still use the core fallback.
