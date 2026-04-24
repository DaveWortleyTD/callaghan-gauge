// Callaghan Creek estimated gauge
// Two-predictor models:
//   1. Fitzsimmons Creek EC gauge 08MG026 — Callaghan = 0.0181 + 0.0413 × Fitz (m³/s), R²=0.815, n=118
//   2. Ashlu Creek EC gauge 08MH024      — Callaghan = 0.1778 + 0.005735 × Ashlu (m³/s), R²=0.786, n=95

const FITZ_INTERCEPT      = 0.0181;
const FITZ_COEF           = 0.0413;
const FITZ_MIN_DISCHARGE  = 1.5;    // m³/s — below training range

const ASHLU_INTERCEPT     = 0.1778;
const ASHLU_COEF          = 0.005735;
const ASHLU_MIN_DISCHARGE = 2.6;    // m³/s — below training range

// ECCC GeoMet OGC API — CORS-enabled, no proxy needed
function apiURL(station) {
  const now   = new Date();
  const start = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const end   = now.toISOString();
  const base  = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items';
  return `${base}?STATION_NUMBER=${station}&datetime=${start}/${end}&limit=1000&sortby=DATETIME`;
}

// ── Fetch + parse ─────────────────────────────────────────────────────────────

async function fetchReadings(station) {
  const response = await fetch(apiURL(station));
  if (!response.ok) throw new Error(`Fetch failed for ${station}: ${response.status}`);
  const geojson = await response.json();

  return geojson.features
    .filter(f => f.properties.DISCHARGE !== null)
    .map(f => ({
      ts:        new Date(f.properties.DATETIME),
      discharge: f.properties.DISCHARGE,
    }))
    .sort((a, b) => a.ts - b.ts);
}

// ── Regression ────────────────────────────────────────────────────────────────

function estimateFromFitz(discharge) {
  if (discharge < FITZ_MIN_DISCHARGE) return null;
  return Math.round((FITZ_INTERCEPT + FITZ_COEF * discharge) * 100) / 100;
}

function estimateFromAshlu(discharge) {
  if (discharge < ASHLU_MIN_DISCHARGE) return null;
  return Math.round((ASHLU_INTERCEPT + ASHLU_COEF * discharge) * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function loadData() {
  const [fitzPoints, ashluPoints] = await Promise.all([
    fetchReadings('08MG026'),
    fetchReadings('08MH024'),
  ]);

  // Per-predictor series using {x, y} point format for Chart.js time axes
  const fitzSeries     = fitzPoints.map(p => ({ x: p.ts, y: p.discharge }));
  const fitzCalSeries  = fitzPoints.map(p => ({ x: p.ts, y: estimateFromFitz(p.discharge) }));
  const ashluSeries    = ashluPoints.map(p => ({ x: p.ts, y: p.discharge }));
  const ashluCalSeries = ashluPoints.map(p => ({ x: p.ts, y: estimateFromAshlu(p.discharge) }));

  const latestFitz  = fitzPoints[fitzPoints.length - 1]  ?? null;
  const latestAshlu = ashluPoints[ashluPoints.length - 1] ?? null;

  const latestFitzStage  = latestFitz  ? estimateFromFitz(latestFitz.discharge)   : null;
  const latestAshluStage = latestAshlu ? estimateFromAshlu(latestAshlu.discharge) : null;

  return {
    fitzSeries, fitzCalSeries,
    ashluSeries, ashluCalSeries,
    latestFitz, latestAshlu,
    latestFitzStage, latestAshluStage,
  };
}
