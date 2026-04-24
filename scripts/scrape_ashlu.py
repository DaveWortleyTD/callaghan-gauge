#!/usr/bin/env python3
"""
Scrape current Ashlu Creek flow from Innergex and append to ashlu-data.json.
Keeps a rolling 48-hour window of 15-minute readings.
"""

import json, re, sys, urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

DATA_FILE   = Path(__file__).parent.parent / 'ashlu-data.json'
WINDOW_HRS  = 48
INNERGEX_URL = 'https://www.innergex.com/en/kayak/ashlu-creek'
PACIFIC      = ZoneInfo('America/Vancouver')


def fetch_flow():
    req = urllib.request.Request(
        INNERGEX_URL,
        headers={'User-Agent': 'Mozilla/5.0 (compatible; callaghan-gauge/1.0)'},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode('utf-8', errors='replace')

    flow_m = re.search(r'TotalRiverFlow:"([0-9.]+)"', html)
    ts_m   = re.search(r'PacificLocalTime:"([^"]+)"',  html)

    if not flow_m or not ts_m:
        raise ValueError('Could not parse Innergex page — patterns not found')

    flow    = float(flow_m.group(1))
    naive   = datetime.strptime(ts_m.group(1), '%Y-%m-%d %H:%M:%S')
    utc_ts  = naive.replace(tzinfo=PACIFIC).astimezone(timezone.utc)

    return {'t': utc_ts.isoformat(), 'v': flow}


def load_history():
    if DATA_FILE.exists():
        with open(DATA_FILE) as f:
            return json.load(f).get('history', [])
    return []


def save(history):
    with open(DATA_FILE, 'w') as f:
        json.dump({'history': history}, f, separators=(',', ':'))


def main():
    point   = fetch_flow()
    history = load_history()

    # Skip duplicate timestamps
    if any(p['t'] == point['t'] for p in history):
        print(f'Already recorded {point["t"]} ({point["v"]} m³/s) — no change')
        return

    history.append(point)

    # Prune to 48-hour window
    cutoff  = datetime.now(timezone.utc) - timedelta(hours=WINDOW_HRS)
    history = [p for p in history if datetime.fromisoformat(p['t']) > cutoff]
    history.sort(key=lambda p: p['t'])

    save(history)
    print(f'Saved {point["t"]} → {point["v"]} m³/s  ({len(history)} points in window)')


if __name__ == '__main__':
    main()
