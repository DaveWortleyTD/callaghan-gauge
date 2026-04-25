// Callaghan Creek estimated gauge
// Two-predictor models:
//   1. Fitzsimmons Creek EC gauge 08MG026 — Callaghan = 0.0181 + 0.0413 × Fitz (m³/s), R²=0.815, n=118
//   2. Ashlu Creek (Innergex)             — Callaghan = 0.1778 + 0.005735 × Ashlu (m³/s), R²=0.786, n=95

const FITZ_INTERCEPT      = 0.0181;
const FITZ_COEF           = 0.0413;
const FITZ_MIN_DISCHARGE  = 1.5;    // m³/s — below training range

const ASHLU_INTERCEPT     = 0.1778;
const ASHLU_COEF          = 0.005735;
const ASHLU_MIN_DISCHARGE = 2.6;    // m³/s — below training range

const ELAHO_INTERCEPT     = -0.0384;
const ELAHO_COEF          = 0.00191132;
const ELAHO_MIN_DISCHARGE = 67.3;   // m³/s — below training range

// Ashlu data: scraped from Innergex by GitHub Actions, stored in repo
const ASHLU_DATA_URL = 'https://raw.githubusercontent.com/DaveWortleyTD/callaghan-gauge/main/ashlu-data.json';

// Field observations: submitted by paddlers via the Cloudflare Worker
const OBSERVATIONS_URL = 'https://raw.githubusercontent.com/DaveWortleyTD/callaghan-gauge/main/observations.json';

// ECCC GeoMet OGC API — CORS-enabled, no proxy needed
function ecccRealtimeURL(station) {
  const now   = new Date();
  const start = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const end   = now.toISOString();
  const base  = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items';
  return `${base}?STATION_NUMBER=${station}&datetime=${start}/${end}&limit=1000&sortby=DATETIME`;
}

// ── Fetch + parse ─────────────────────────────────────────────────────────────

async function fetchEcccReadings(station, label) {
  const response = await fetch(ecccRealtimeURL(station));
  if (!response.ok) throw new Error(`${label} fetch failed: ${response.status}`);
  const geojson = await response.json();
  return geojson.features
    .filter(f => f.properties.DISCHARGE !== null)
    .map(f => ({
      ts:        new Date(f.properties.DATETIME),
      discharge: f.properties.DISCHARGE,
    }))
    .sort((a, b) => a.ts - b.ts);
}

function fetchFitzReadings()  { return fetchEcccReadings('08MG026', 'Fitzsimmons'); }
function fetchElahoReadings() { return fetchEcccReadings('08GA071', 'Elaho'); }

async function fetchAshluReadings() {
  const response = await fetch(ASHLU_DATA_URL);
  if (!response.ok) throw new Error(`Ashlu data fetch failed: ${response.status}`);
  const data = await response.json();

  return (data.history ?? []).map(p => ({
    ts:        new Date(p.t),
    discharge: p.v,
  }));
}

async function fetchObservations() {
  try {
    const response = await fetch(OBSERVATIONS_URL);
    if (!response.ok) return [];
    const data = await response.json();
    return (data.observations ?? []).map(p => ({
      ts:      new Date(p.t),
      level:   p.v,
      note:    p.note    ?? null,
      paddler: p.paddler ?? null,
    }));
  } catch {
    return [];
  }
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

function estimateFromElaho(discharge) {
  if (discharge < ELAHO_MIN_DISCHARGE) return null;
  return Math.round((ELAHO_INTERCEPT + ELAHO_COEF * discharge) * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function loadData() {
  const [fitzPoints, ashluPoints, observations, elahoPoints] = await Promise.all([
    fetchFitzReadings(),
    fetchAshluReadings(),
    fetchObservations(),
    fetchElahoReadings(),
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

  const elahoSeries    = elahoPoints.map(p => ({ x: p.ts, y: p.discharge }));
  const elahoCalSeries = elahoPoints.map(p => ({ x: p.ts, y: estimateFromElaho(p.discharge) }));

  const latestElaho      = elahoPoints[elahoPoints.length - 1] ?? null;
  const latestElahoStage = latestElaho ? estimateFromElaho(latestElaho.discharge) : null;

  const observationSeries = observations.map(p => ({
    x:       p.ts,
    y:       p.level,
    note:    p.note,
    paddler: p.paddler,
  }));

  return {
    fitzSeries, fitzCalSeries,
    ashluSeries, ashluCalSeries,
    elahoSeries, elahoCalSeries,
    latestFitz, latestAshlu, latestElaho,
    latestFitzStage, latestAshluStage, latestElahoStage,
    observations, observationSeries,
  };
}
