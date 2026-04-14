// Callaghan Creek estimated gauge
// Single-predictor model: Fitzsimmons Creek EC gauge 08MG026
// callaghan_stage = INTERCEPT + FITZSIMMONS_COEF * fitzsimmons_discharge

const INTERCEPT        = 0.0181;
const FITZSIMMONS_COEF = 0.0413;
const MIN_DISCHARGE    = 1.5;   // m³/s — below training range

// Fitzsimmons hourly CSV from ECCC Datamart
const FITZ_CSV_URL = 'https://dd.weather.gc.ca/hydrometric/csv/BC/hourly/BC_08MG026_hourly_hydrometric.csv';

// CORS proxy fallback (used automatically if direct fetch fails)
const PROXY = 'https://corsproxy.io/?url=';

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchCSV(url) {
  let response;
  try {
    response = await fetch(url);
    if (!response.ok) throw new Error(response.status);
  } catch (_) {
    // retry via CORS proxy
    response = await fetch(PROXY + encodeURIComponent(url));
    if (!response.ok) throw new Error('Failed to fetch: ' + url);
  }
  return response.text();
}

// Parse the ECCC hydrometric CSV.
// Columns: ID, Date, Water Level (m), Grade, Symbol, QA/QC, Discharge (m³/s), ...
function parseECCSV(csv) {
  const lines = csv.split('\n').slice(1); // skip header
  const points = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const dateStr  = cols[1]?.trim();
    const discharge = parseFloat(cols[6]);
    if (!dateStr || isNaN(discharge)) continue;

    // Date format: "2024-05-01 15:00:00"
    const ts = new Date(dateStr.replace(' ', 'T') + 'Z'); // UTC
    if (isNaN(ts.getTime())) continue;

    points.push({ ts, discharge });
  }

  return points.sort((a, b) => a.ts - b.ts);
}

// ── Regression ────────────────────────────────────────────────────────────────

function estimateCallaghan(discharge) {
  if (discharge < MIN_DISCHARGE) return null;
  return Math.round((INTERCEPT + FITZSIMMONS_COEF * discharge) * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function loadData() {
  const csv = await fetchCSV(FITZ_CSV_URL);
  const all  = parseECCSV(csv);

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const window = all.filter(p => p.ts.getTime() >= cutoff);

  const labels       = [];
  const fitzData     = [];
  const callaghanData = [];

  for (const p of window) {
    labels.push(p.ts);
    fitzData.push(p.discharge);
    callaghanData.push(estimateCallaghan(p.discharge));
  }

  // Latest reading for the summary cards
  const latest = window[window.length - 1] ?? null;
  const latestStage = latest ? estimateCallaghan(latest.discharge) : null;

  return { labels, fitzData, callaghanData, latest, latestStage };
}
