# Request details

Open **Observe → Request details** (`#/usage`). The page has time/model/source/key/result
filters, search, token and cache counts, elapsed/first-token timings, output speed,
column selection, pagination, CSV import/export, and connection-scoped browser history.
Output speed uses output tokens divided by elapsed time after the first token; missing
measurements stay unavailable. Cost is displayed only when supplied by a desktop CSV export.

## Existing desktop history

Export CSV from the desktop app's Usage → Request Details page, then use **Import desktop CSV**.
The web UI cannot access the desktop app's private SQLite database. It accepts desktop CSV
exports up to 20 MB, retains the most recent 10,000 records within 30 days, and deduplicates
known record IDs. CSV export includes every filtered row, not just the visible page.

## New records

**Live collection starts off.** Enabling it requires an in-app confirmation because the v8
GET `/v8/management/observability/usage/queue?count=200` endpoint **pops** records from a shared
queue. Desktop or other collectors may not receive those same records. No backend request
is made just by opening this page. Collection only runs while this page is mounted, focused,
visible, online, and connected. It checks at most once per 30 seconds; this is separate from
the configurable quota refresh cadence. Navigating away or reloading stops collection.

The queue is not a complete historical archive: records can expire or be taken by another
collector. Browser collection cannot recreate missing history. Do not run multiple independent
collectors expecting each to receive a full copy.

The expected sibling backend checkout was absent during implementation. Contracts were instead
verified against the official `router-for-me/CLIProxyAPI` source at commit
`1f917e77c4562623aa49e9804d999524151a2f96`, specifically
`internal/api/server_management_v8.go`, `internal/api/handlers/management/usage.go`, and
`internal/redisqueue/plugin.go`. Desktop CSV fields were checked against the local
`../EasyCLIProxyAPI/src/pages/UsageEventsView.tsx` export implementation. No backend files
were modified and no legacy API fallback was added.

## Persistence and privacy

IndexedDB stores a whitelist of request metadata, scoped by a SHA-256 fingerprint of the
backend URL and management key. Raw client/management keys, response headers, failure bodies,
and arbitrary source strings are not persisted. Client keys are shown as fingerprints;
sources are shown only when they are recognizable auth filenames. Request IDs are fingerprinted.
All fields use text rendering, and CSV exports neutralize spreadsheet formula prefixes.

Logout clears browser request history. **Clear local history** clears only the current
connection's browser history, without touching the backend or desktop database. Browser
storage is not an encryption boundary. Export records that must be kept elsewhere.

Collection verifies storage availability before consuming the queue. If a later storage write
fails, collection stops and the in-memory batch remains available to export. Browsers with
Web Locks coordinate concurrent collectors, and IndexedDB merges records in a serialized
transaction to avoid overwriting another tab's writes.

## Hourly token analytics

Observe → Token analytics (`#/usage/analytics`) and the section below the quota
homepage use the same component and connection-scoped local request history.
Neither instance consumes the backend queue. Use Request details to import CSV
or explicitly enable collection, then Reload saved history to update the charts.

Choose 24, 72 or 168 hourly buckets, filter by model/account, and select model bars,
account bars, or combined model bars with account lines. The current partial hour
is included. Lines show hourly tokens on the same axis as the stacked bars, not
cumulative usage. Each dimension shows the six largest series plus a lossless
Other aggregate. Unknown accounts remain explicit.

Only reported total tokens contribute to the chart. Requests without token totals
still contribute to request and success counts; reading coverage is shown.
Input/cache/output/reasoning fields are shown separately because they can overlap.
The expandable hourly table provides exact totals and account-line values.
These local records are subject to the existing 30-day/10,000-record retention;
this is not a complete server-wide usage ledger.
