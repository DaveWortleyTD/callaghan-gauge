#!/usr/bin/env python3
"""
One-time backfill: parse the last ~24h of flow history from the Innergex
__data.json endpoint and merge it into ashlu-data.json.

Run once from the repo root:  python3 scripts/backfill_ashlu.py
"""

import json, re, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DATA_FILE  = Path(__file__).parent.parent / 'ashlu-data.json'
WINDOW_HRS = 48
PACIFIC    = ZoneInfo('America/Vancouver')
URL        = 'https://www.innergex.com/en/kayak/ashlu-creek/__data.json'


def fetch_raw():
    req = urllib.request.Request(
        URL,
        headers={'User-Agent': 'Mozilla/5.0 (compatible; callaghan-gauge/1.0)'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', errors='replace')


def parse_history(raw):
    outer = json.loads(raw)
    data  = outer['nodes'][1]['data']

    # Navigate: root → flowData → cumulFlows → CSV array → rows
    root        = data[0]
    flow_data   = data[root['flowData']]
    cumul       = data[flow_data['cumulFlows']]
    csv_idx     = next(iter(cumul.values()))
    row_indices = data[csv_idx]   # list of indices, each pointing to a row array

    points = []
    for ri in row_indices:
        row_ref = data[ri]        # [date_idx, time_idx, value_idx]
        if not isinstance(row_ref, list) or len(row_ref) < 3:
            continue
        date_v, time_v, flow_v = [data[i] for i in row_ref]
        if not isinstance(date_v, str) or not re.match(r'\d{4}-\d{2}-\d{2}', date_v):
            continue  # skip header row
        if flow_v is None or flow_v == '':
            continue
        try:
            naive  = datetime.strptime(f'{date_v} {time_v}', '%Y-%m-%d %H:%M:%S')
            utc_ts = naive.replace(tzinfo=PACIFIC).astimezone(timezone.utc)
            points.append({'t': utc_ts.isoformat(), 'v': float(flow_v)})
        except (ValueError, TypeError):
            continue

    return points


def load_history():
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f).get('history', [])
    return []


def save(history):
    with open(DATA_FILE, 'w') as f:
        json.dump({'history': history}, f, separators=(',', ':'))


def main():
    print('Fetching Innergex cumulative flow history…')
    raw = fetch_raw()

    new_points = parse_history(raw)
    print(f'Parsed {len(new_points)} historical points from Innergex')

    existing       = load_history()
    combined_dict  = {p['t']: p['v'] for p in existing}
    combined_dict.update({p['t']: p['v'] for p in new_points})

    cutoff   = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HRS)
    history  = sorted(
        [{'t': t, 'v': v} for t, v in combined_dict.items()
         if datetime.fromisoformat(t) > cutoff],
        key=lambda p: p['t'],
    )

    save(history)
    added = len(history) - len(existing)
    print(f'Added {max(added,0)} new points. Total in window: {len(history)}')
    if history:
        print(f'Range: {history[0]["t"]} → {history[-1]["t"]}')


if __name__ == '__main__':
    main()
