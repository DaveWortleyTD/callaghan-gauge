#!/usr/bin/env python3
"""
Build a linear regression model: Callaghan level ~ Elaho River discharge.

Reads all historical Callaghan observation CSVs, fetches ECCC daily-mean
discharge for station 08GA071 (Elaho River near the Mouth), joins on date,
and prints the regression coefficients ready to paste into gauge.js.

Usage:
    python3 scripts/build_elaho_model.py [/path/to/csv/dir]

Default CSV dir: /home/dave/bcwhitewater
"""

import sys, re, json
from datetime import date, timedelta
from urllib.request import urlopen
from urllib.parse import urlencode

CSV_DIR = sys.argv[1] if len(sys.argv) > 1 else '/home/dave/bcwhitewater'
STATION = '08GA071'

# ── CSV parsers ───────────────────────────────────────────────────────────────

def parse_date(raw_date, year):
    """Parse 'DD/M', 'DD/MM', or 'DD/MM/YYYY' into a date object."""
    raw_date = raw_date.strip()
    # Full date like 16/05/2022 or 12/07/2024
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{4})$', raw_date)
    if m:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    # Partial date like 20/4 or 28/5
    m = re.match(r'^(\d{1,2})/(\d{1,2})$', raw_date)
    if m:
        return date(year, int(m.group(2)), int(m.group(1)))
    return None


def parse_csv(path, year):
    """
    Return list of (date, callaghan_level_m) tuples.
    Skips rows with non-numeric levels or levels <= -0.05 (below gauge zero).
    """
    results = []
    in_data = False
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            cells = [c.strip() for c in line.rstrip('\n').split(',')]
            if not cells or not cells[0]:
                continue
            # Detect header row
            if cells[0].lower() == 'date':
                in_data = True
                continue
            if not in_data:
                continue
            if len(cells) < 3:
                continue
            raw_date, _time, raw_level = cells[0], cells[1], cells[2]
            if not raw_date or not raw_level:
                continue
            d = parse_date(raw_date, year)
            if d is None:
                continue
            try:
                level = float(raw_level)
            except ValueError:
                continue
            if level <= -0.05:   # below gauge zero — uninformative
                continue
            results.append((d, level))
    return results


# ── Load all CSVs ─────────────────────────────────────────────────────────────

import os

files = {
    'callaghan_2022.csv':      2022,
    'callaghan_2023.csv':      2023,
    'callaghan_2024.csv':      2024,
    'callaghan_2024_fitz.csv': 2024,
    'callaghan.csv':           2025,
}

all_obs = {}   # date -> callaghan level (last write wins for duplicate dates)
for fname, year in files.items():
    path = os.path.join(CSV_DIR, fname)
    if not os.path.exists(path):
        print(f'  skipping {fname} (not found)')
        continue
    rows = parse_csv(path, year)
    for d, lvl in rows:
        all_obs[d] = lvl
    print(f'  {fname}: {len(rows)} observations')

print(f'\nTotal unique observation dates: {len(all_obs)}')

# ── Fetch ECCC daily-mean Elaho discharge ─────────────────────────────────────

def fetch_daily_mean(station, start, end):
    """Fetch daily-mean discharge from ECCC API. Returns {date: discharge_m3s}."""
    base = 'https://api.weather.gc.ca/collections/hydrometric-daily-mean/items'
    params = urlencode({
        'STATION_NUMBER': station,
        'datetime': f'{start}/{end}',
        'limit': 5000,
        'sortby': 'DATE',
    })
    url = f'{base}?{params}'
    with urlopen(url, timeout=30) as resp:
        data = json.load(resp)
    result = {}
    for f in data.get('features', []):
        p = f['properties']
        d_str = p.get('DATE') or p.get('DATETIME', '')[:10]
        discharge = p.get('DISCHARGE')
        if d_str and discharge is not None:
            result[date.fromisoformat(d_str)] = float(discharge)
    return result

# Determine date ranges to fetch (year by year to avoid huge requests)
if all_obs:
    years_needed = sorted({d.year for d in all_obs})
    elaho = {}
    for yr in years_needed:
        start = date(yr, 1, 1)
        end   = date(yr, 12, 31)
        print(f'  fetching Elaho daily-mean {yr}…', end=' ', flush=True)
        chunk = fetch_daily_mean(STATION, start, end)
        elaho.update(chunk)
        print(f'{len(chunk)} records')
    print(f'\nTotal Elaho daily-mean records: {len(elaho)}')

# ── Join & filter ─────────────────────────────────────────────────────────────

pairs = []
for d, cal_level in sorted(all_obs.items()):
    elaho_q = elaho.get(d)
    if elaho_q is None:
        continue
    pairs.append((elaho_q, cal_level))

print(f'Matched pairs (Elaho + Callaghan obs on same day): {len(pairs)}')

if len(pairs) < 5:
    print('\nNot enough matched pairs to build a model.')
    sys.exit(1)

# ── Linear regression (OLS, no external deps) ─────────────────────────────────

xs = [p[0] for p in pairs]
ys = [p[1] for p in pairs]
n  = len(pairs)

x_mean = sum(xs) / n
y_mean = sum(ys) / n

ss_xy = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, ys))
ss_xx = sum((x - x_mean) ** 2 for x in xs)

slope     = ss_xy / ss_xx
intercept = y_mean - slope * x_mean

y_pred  = [intercept + slope * x for x in xs]
ss_res  = sum((y - yp) ** 2 for y, yp in zip(ys, y_pred))
ss_tot  = sum((y - y_mean) ** 2 for y in ys)
r2      = 1 - ss_res / ss_tot

x_min = min(xs)
x_max = max(xs)

print(f'\n── Elaho model ──────────────────────────────────────────────────')
print(f'  Station:    {STATION} (Elaho River near the Mouth)')
print(f'  n:          {n}')
print(f'  intercept:  {intercept:.6f}')
print(f'  slope:      {slope:.8f}')
print(f'  R²:         {r2:.3f}')
print(f'  Elaho range: {x_min:.1f} – {x_max:.1f} m³/s')
print()
print('── Paste into gauge.js ──────────────────────────────────────────')
print(f"const ELAHO_INTERCEPT     = {intercept:.4f};")
print(f"const ELAHO_COEF          = {slope:.8f};")
print(f"const ELAHO_MIN_DISCHARGE = {x_min:.1f};  // m³/s — below training range")
print()
print('── Model equation ───────────────────────────────────────────────')
print(f'  Callaghan (m) = {intercept:.4f} + {slope:.6f} × Elaho (m³/s)')
print(f'  Valid for {x_min:.0f}–{x_max:.0f} m³/s')

# ── Show sample predictions ───────────────────────────────────────────────────
print()
print('── Sample predictions ───────────────────────────────────────────')
print(f'  {"Elaho (m³/s)":>14}  {"Predicted Cal (m)":>17}  {"Actual Cal (m)":>14}')
for x, y in sorted(pairs, key=lambda p: p[0])[::max(1, n//10)]:
    pred = intercept + slope * x
    print(f'  {x:>14.1f}  {pred:>17.3f}  {y:>14.3f}')
