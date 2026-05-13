// Cloudflare Worker — receives field observations and appends them to
// observations.json in the callaghan-gauge GitHub repo via the GitHub API.
//
// Deploy steps:
//   1. wrangler deploy  (or paste into the Cloudflare dashboard)
//   2. wrangler secret put GITHUB_PAT  (paste your fine-grained token when prompted)
//
// Required secret:  GITHUB_PAT  — fine-grained token with Contents: read+write
//                                 scoped to DaveWortleyTD/callaghan-gauge

const REPO     = 'DaveWortleyTD/callaghan-gauge';
const FILE     = 'observations.json';
const API_URL  = `https://api.github.com/repos/${REPO}/contents/${FILE}`;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Regression model constants (kept in sync with gauge.js)
const ASHLU_INTERCEPT     = 0.1778;
const ASHLU_COEF          = 0.005735;
const ASHLU_MIN_DISCHARGE = 2.6;

const ELAHO_INTERCEPT     = -0.0384;
const ELAHO_COEF          = 0.00191132;
const ELAHO_MIN_DISCHARGE = 67.3;

const ASHLU_DATA_URL = `https://raw.githubusercontent.com/${REPO}/main/ashlu-data.json`;

function ecccRealtimeURL(station) {
  const now   = new Date();
  const start = new Date(now - 3 * 60 * 60 * 1000).toISOString(); // last 3 hours is plenty
  const end   = now.toISOString();
  return `https://api.weather.gc.ca/collections/hydrometric-realtime/items?STATION_NUMBER=${station}&datetime=${start}/${end}&limit=10&sortby=-DATETIME`;
}

function estimateFromAshlu(q) {
  return q >= ASHLU_MIN_DISCHARGE ? Math.round((ASHLU_INTERCEPT + ASHLU_COEF * q) * 1000) / 1000 : null;
}

function isAshluExcluded(date) {
  const month = date.getMonth(); // 0-indexed: 4=May, 7=Aug, 8=Sep
  const day   = date.getDay();   // 0=Sun, 6=Sat
  return (month === 4 || month === 7 || month === 8) && (day === 0 || day === 6);
}

function estimateFromElaho(q) {
  return q >= ELAHO_MIN_DISCHARGE ? Math.round((ELAHO_INTERCEPT + ELAHO_COEF * q) * 1000) / 1000 : null;
}

async function handleEstimate() {
  const [ashluResp, elahoResp] = await Promise.allSettled([
    fetch(ASHLU_DATA_URL),
    fetch(ecccRealtimeURL('08GA071')),
  ]);

  let ashlu = null;
  if (ashluResp.status === 'fulfilled' && ashluResp.value.ok) {
    const data = await ashluResp.value.json();
    const latest = (data.history ?? []).at(-1);
    if (latest && !isAshluExcluded(new Date(latest.t))) {
      ashlu = { discharge: latest.v, timestamp: latest.t, estimate: estimateFromAshlu(latest.v) };
    }
  }

  let elaho = null;
  if (elahoResp.status === 'fulfilled' && elahoResp.value.ok) {
    const geojson = await elahoResp.value.json();
    const feature = (geojson.features ?? []).find(f => f.properties.DISCHARGE !== null);
    if (feature) {
      const q = feature.properties.DISCHARGE;
      elaho = { discharge: q, timestamp: feature.properties.DATETIME, estimate: estimateFromElaho(q) };
    }
  }

  const average_estimate = elaho?.estimate ?? null;

  return json({ ashlu, elaho, average_estimate, retrieved_at: new Date().toISOString() });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const path = new URL(request.url).pathname;

    if (path === '/estimate') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      return handleEstimate();
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const { t, v, note, paddler, fitz, ashlu, elaho } = body;

    // ── Validate level ───────────────────────────────────────────────────────
    const level = parseFloat(v);
    if (isNaN(level) || level < 0 || level > 3) {
      return json({ error: 'Level must be a number between 0 and 3 metres' }, 400);
    }

    // ── Validate timestamp ───────────────────────────────────────────────────
    const ts = t ? new Date(t) : new Date();
    if (isNaN(ts.getTime())) {
      return json({ error: 'Invalid timestamp' }, 400);
    }
    const ageMs = Date.now() - ts.getTime();
    if (ageMs > 7 * 24 * 60 * 60 * 1000 || ageMs < -60 * 60 * 1000) {
      return json({ error: 'Timestamp must be within the last 7 days' }, 400);
    }

    // ── Build observation object ─────────────────────────────────────────────
    const obs = { t: ts.toISOString(), v: Math.round(level * 1000) / 1000 };
    if (note    && typeof note    === 'string' && note.trim())    obs.note    = note.trim().slice(0, 300);
    if (paddler && typeof paddler === 'string' && paddler.trim()) obs.paddler = paddler.trim().slice(0, 60);
    if (fitz  != null && isFinite(fitz))  obs.fitz  = Math.round(fitz  * 100) / 100;
    if (ashlu != null && isFinite(ashlu)) obs.ashlu = Math.round(ashlu * 10)  / 10;
    if (elaho != null && isFinite(elaho)) obs.elaho = Math.round(elaho * 10)  / 10;

    // ── Read current file from GitHub ────────────────────────────────────────
    const ghHeaders = {
      'Authorization':        `Bearer ${env.GITHUB_PAT}`,
      'User-Agent':           'callaghan-gauge-worker',
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const getResp = await fetch(API_URL, { headers: ghHeaders });

    let current = { observations: [] };
    let sha;

    if (getResp.ok) {
      const file = await getResp.json();
      sha = file.sha;
      current = JSON.parse(atob(file.content.replace(/\s/g, '')));
      if (!Array.isArray(current.observations)) current.observations = [];
    } else if (getResp.status !== 404) {
      return json({ error: 'Failed to read observations file from GitHub' }, 502);
    }

    // ── Append and sort ──────────────────────────────────────────────────────
    current.observations.push(obs);
    current.observations.sort((a, b) => new Date(a.t) - new Date(b.t));

    // ── Write back ───────────────────────────────────────────────────────────
    const putPayload = {
      message: `Add field observation: ${obs.t.slice(0, 10)} ${obs.v}m`,
      content:  btoa(JSON.stringify(current)),
    };
    if (sha) putPayload.sha = sha;

    const putResp = await fetch(API_URL, {
      method:  'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(putPayload),
    });

    if (putResp.status === 409) {
      return json({ error: 'Conflict — someone else submitted simultaneously, please try again' }, 409);
    }
    if (!putResp.ok) {
      return json({ error: 'Failed to save observation' }, 502);
    }

    return json({ ok: true, observation: obs });
  },
};
