"""Export only quota reset timestamps from the desktop's read-only usage inbox."""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import sqlite3
import time


def observation(record, now):
    if record.get('generate') is False:
        return None
    provider = record.get('provider')
    index = record.get('auth_index')
    if provider not in ('claude', 'codex') or not isinstance(index, str) or not index:
        return None
    try:
        at = dt.datetime.fromisoformat(record['timestamp'].replace('Z', '+00:00')).timestamp()
        headers = {k.lower(): v[-1] if isinstance(v, list) else v
                   for k, v in record.get('response_headers', {}).items() if v}
        reset = 0
        if provider == 'claude':
            raw = headers.get('anthropic-ratelimit-unified-7d-reset', '')
            try:
                reset = int(raw)
            except ValueError:
                reset = dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).timestamp()
        else:
            for window in ('primary', 'secondary'):
                prefix = 'x-codex-' + window + '-'
                if not 10000 <= int(headers.get(prefix + 'window-minutes', '0')) <= 10080:
                    continue
                candidate = int(headers.get(prefix + 'reset-at', '0'))
                if not candidate:
                    candidate = at + int(headers.get(prefix + 'reset-after-seconds', '0'))
                if candidate and (not reset or candidate < reset):
                    reset = candidate
        if at > now + 60 or now - at > 86400 or not now < reset < now + 691200:
            return None
        stamp = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat().replace('+00:00', 'Z')
        key = hashlib.sha256(('index:' + index).encode()).hexdigest()
        return key, {'observed': stamp(at), 'reset': stamp(reset), 'provider': provider}
    except (KeyError, ValueError, TypeError, OverflowError):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    now = time.time()
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        records = {}
        for (raw,) in db.execute('SELECT raw_message FROM usage_inbox ORDER BY id DESC LIMIT 50000'):
            try:
                item = observation(json.loads(raw), now)
            except (ValueError, TypeError):
                continue
            if item and item[0] not in records:
                records[item[0]] = item[1]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Export to a separate seed file; never overwrite a running plugin's state.
    args.output.write_text(json.dumps(records, indent=2), encoding='utf-8')
    print(f'Exported valid weekly reset observations for {len(records)} accounts; no credentials or bodies exported.')


if __name__ == '__main__':
    main()
