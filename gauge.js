// Callaghan Creek estimated gauge
// Single-predictor model: Fitzsimmons Creek EC gauge 08MG026
// callaghan_stage = INTERCEPT + FITZSIMMONS_COEF * fitzsimmons_discharge

const INTERCEPT        = 0.0181;
const FITZSIMMONS_COEF = 0.0413;
const MIN_DISCHARGE    = 1.5;   // m³/s — below training range

// ECCC GeoMet OGC API — CORS-enabled, no proxy needed
// Returns GeoJSON FeatureCollection with DISCHARGE and DATETIME properties
function apiURL() {
  const now   = new Date();
  const start = new Date(now - 48 * 60 * 60 * 1000).toISOString();
  const end   = now.toISOString();
  const base  = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items';
  return `${base}?STATION_NUMBER=08MG026&datetime=${start}/${end}&limit=1000&sortby=DATETIME`;
}

// ── Fetch + parse ─────────────────────────────────────────────────────────────

async function fetchReadings() {
  const response = await fetch(apiURL());
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
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

function estimateCallaghan(discharge) {
  if (discharge < MIN_DISCHARGE) return null;
  return Math.round((INTERCEPT + FITZSIMMONS_COEF * discharge) * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function loadData() {
  const points = await fetchReadings();

  const labels        = [];
  const fitzData      = [];
  const callaghanData = [];

  for (const p of points) {
    labels.push(p.ts);
    fitzData.push(p.discharge);
    callaghanData.push(estimateCallaghan(p.discharge));
  }

  // Latest reading for the summary cards
  const latest = points[points.length - 1] ?? null;
  const latestStage = latest ? estimateCallaghan(latest.discharge) : null;

  return { labels, fitzData, callaghanData, latest, latestStage };
}
