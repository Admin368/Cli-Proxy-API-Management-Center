"""Recover quota readings from retained response headers, matched to desktop history."""
import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import time


def response_quota_headers(tail):
    sections = list(re.finditer(r'^=== API RESPONSE (\d+) ===\r?\n', tail, re.M))
    # A retry may switch accounts. Without attempt identity, never attribute its quota.
    if len(sections) != 1 or sections[0][1] != '1':
        return None
    response = tail[sections[0].end():].split('\n=== ', 1)[0]
    lines = response.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == 'Headers:') + 1
    except StopIteration:
        return None
    values = {}
    allowed = re.compile(r'^anthropic-ratelimit-unified-(5h|7d)-(reset|utilization)$')
    for line in lines[start:]:
        if not line.strip():
            break
        key, separator, value = line.partition(':')
        if separator and allowed.fullmatch(key.strip().lower()):
            try:
                number = float(value.strip())
                if math.isfinite(number):
                    values[key.strip().lower()] = number
            except ValueError:
                pass
    return values


def recover(database, logs, now):
    with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        rows = db.execute('SELECT request_id, auth_index, provider, timestamp_ms FROM usage_events '
                          'WHERE timestamp_ms >= ?', ((now - 14*86400)*1000,)).fetchall()
    lookup = collections.defaultdict(list)
    for request, index, provider, at in rows:
        if request and index and provider == 'claude':
            lookup[request[-8:]].append((index, provider, at))
    observations = []
    matched = 0
    for path in logs.glob('*.log'):
        suffix = re.search(r'-([a-z0-9]{8})\.log$', path.name, re.I)
        if not suffix or len(lookup[suffix[1]]) != 1:
            continue
        index, provider, at = lookup[suffix[1]][0]
        with path.open('rb') as stream:
            stream.seek(max(0, path.stat().st_size - 131072))
            headers = response_quota_headers(stream.read().decode('utf-8', errors='replace'))
        if not headers:
            continue
        matched += 1
        for name, window, period in [('5h', 'session', 5), ('7d', 'weekly', 168)]:
            used = headers.get(f'anthropic-ratelimit-unified-{name}-utilization')
            reset = headers.get(f'anthropic-ratelimit-unified-{name}-reset')
            if used is None or reset is None or not 0 <= used <= 10 or reset*1000 <= at:
                continue
            observations.append({'id': hashlib.sha256(('auth:' + str(index)).encode()).hexdigest(),
                                 'provider': provider, 'window': window, 'at': at,
                                 'remaining': max(0, 100-used*100), 'reset': reset*1000,
                                 'period': period})
    observations.sort(key=lambda row: row['at'])
    return observations[-5000:], matched


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--logs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    observations, matched = recover(args.database, args.logs, time.time())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'observations': observations}), encoding='utf-8')
    print(f'Recovered {len(observations)} quota readings from {matched} matched response logs. No bodies or credentials exported.')


if __name__ == '__main__':
    main()
