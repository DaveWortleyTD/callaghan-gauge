// Callaghan Creek estimated gauge
// Single-predictor model: Fitzsimmons Creek EC gauge 08MG026
// callaghan_stage = INTERCEPT + FITZSIMMONS_COEF * fitzsimmons_discharge

const INTERCEPT        = 0.0181;
const FITZSIMMONS_COEF = 0.0413;
const MIN_DISCHARGE    = 1.5;   // m³/s — below training range

// Fitzsimmons real-time data from ECCC wateroffice API
// wateroffice.ec.gc.ca doesn't send CORS headers so we route via corsproxy.io
const PROXY = 'https://corsproxy.io/?url=';

function fitzURL() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now - 48 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return `https://wateroffice.ec.gc.ca/services/real_time_data/csv/inline?stations[]=08MG026&parameters[]=47&start_date=${start}&end_date=${end}&lang=en`;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchCSV(url) {
  const proxyURL = PROXY + encodeURIComponent(url);
  console.log('[gauge] fetching:', proxyURL);
  const response = await fetch(proxyURL);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  const text = await response.text();
  console.log('[gauge] raw response (first 500 chars):', text.slice(0, 500));
  return text;
}

// Parse the ECCC wateroffice inline CSV.
// Columns: ID, Date, Parameter/Paramètre, Value/Valeur, ...
// Parameter 47 = discharge (m³/s)
function parseECCSV(csv) {
  const lines = csv.split('\n');
  console.log('[gauge] CSV header:', lines[0]);
  console.log('[gauge] CSV row 1:', lines[1]);
  const dataLines = lines.slice(1);
  const points = [];

  for (const line of dataLines) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const dateStr   = cols[1]?.trim().replace(/"/g, '');
    const discharge = parseFloat(cols[3]?.replace(/"/g, ''));
    if (!dateStr || isNaN(discharge)) continue;

    const ts = new Date(dateStr);
    if (isNaN(ts.getTime())) continue;

    points.push({ ts, discharge });
  }

  console.log('[gauge] parsed points:', points.length, points[0]);
  return points.sort((a, b) => a.ts - b.ts);
}

// ── Regression ────────────────────────────────────────────────────────────────

function estimateCallaghan(discharge) {
  if (discharge < MIN_DISCHARGE) return null;
  return Math.round((INTERCEPT + FITZSIMMONS_COEF * discharge) * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function loadData() {
  const csv = await fetchCSV(fitzURL());
  const all  = parseECCSV(csv);

  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const window = all.filter(p => p.ts.getTime() >= cutoff);

  const labels        = [];
  const fitzData      = [];
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
