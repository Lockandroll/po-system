// utils/judi.js
//
// Judi is the AI receptionist that answers the inbound Pop-A-Lock line. It is
// operated by MidTN Dispatch, not by us, and it is a COMPLETELY DIFFERENT
// system from Nova's GoTo index (utils/goto.js). One customer contact can
// legitimately appear in both: Judi answers, decides, and transfers, and GoTo
// records the leg a human then handled. Read-only JSON API, key in X-API-Key.
//
// NOVA STORES NOTHING FROM THIS API. Every read is live and cached in memory
// for 60 seconds and no longer. That is deliberate and load-bearing, not an
// optimisation choice: the GoTo index deliberately stores a phone number and
// metadata and NEVER a customer name, while Judi hands back customer_name,
// lat/lng, street addresses inside transcripts, and vehicle details. Persisting
// any of it would quietly reverse that privacy decision without anyone ever
// deciding to. If a future change wants a judi_calls table, that is a decision
// to make out loud, not a refactor.
//
// No backticks in this file (Windows clipboard safety - see CLAUDE.md 1.1).

'use strict';

// normalizeDigits is borrowed from utils/goto.js rather than reimplemented.
// It carries a specific, expensive bug fix: '704.555.0134 x22' naively strips
// to '4555013422', a valid-looking key belonging to NOBODY, which silently
// serves the wrong customer's call history. Writing a second phone normaliser
// is how that bug comes back.
const gotoUtil = require('./goto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function intEnv(v, dflt) {
  const n = parseInt(v, 10);
  return isNaN(n) || n <= 0 ? dflt : n;
}

const BASE = String(process.env.JUDI_API_BASE || 'https://midtndispatch.com/api/v1').replace(/\/+$/, '');
const TIMEOUT_MS = intEnv(process.env.JUDI_TIMEOUT_MS, 12000);
const CACHE_TTL_MS = intEnv(process.env.JUDI_CACHE_TTL_MS, 60000);

// The documented limit is 120 requests/minute per key. We sit at 100 so a burst
// of user searches cannot walk us into a 429 that would look, from the Call
// Lookup page, like Judi simply having no calls for that customer.
const RATE_PER_MIN = intEnv(process.env.JUDI_RATE_PER_MIN, 100);

// Upstream paths live in ONE block on purpose. They were captured from the API
// walkthrough rather than from a published spec, so if MidTN moves one, this is
// the only place to change - and GET /api/judi/status reports exactly which of
// them answered, so a wrong path shows up as a diagnosis instead of an empty
// page. JUDI_PATH_CALLS exists so a path fix does not need a code change.
const PATHS = {
  ping: '/ping',
  locations: '/locations',
  calls: String(process.env.JUDI_PATH_CALLS || '/calls').replace(/\/+$/, '')
};

function apiKey() {
  return String(process.env.JUDI_API_KEY || '').trim();
}

function configured() {
  return apiKey().length > 0;
}

// ---------------------------------------------------------------------------
// Rate limiting - a token bucket shared by every caller in this process
// ---------------------------------------------------------------------------

const bucket = { tokens: RATE_PER_MIN, refilledAt: Date.now() };

function refill() {
  const now = Date.now();
  const elapsed = now - bucket.refilledAt;
  if (elapsed <= 0) return;
  const gained = (elapsed / 60000) * RATE_PER_MIN;
  if (gained >= 1) {
    bucket.tokens = Math.min(RATE_PER_MIN, bucket.tokens + gained);
    bucket.refilledAt = now;
  }
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Waits for capacity rather than throwing. A user who searches four numbers in
// a row should see the fourth answer a moment later, not see it fail.
async function takeToken() {
  for (let i = 0; i < 200; i++) {
    refill();
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return; }
    await sleep(120);
  }
  const err = new Error('Judi rate limiter did not free up');
  err.judiCode = 'rate_limited';
  throw err;
}

// ---------------------------------------------------------------------------
// Cache - in memory, 60s, never written to disk or to a table
// ---------------------------------------------------------------------------

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value: value });
  // Bounded so a long-lived process cannot accumulate customer data in memory
  // indefinitely. Oldest-inserted goes first; Map preserves insertion order.
  if (cache.size > 200) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

function cacheClear() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// The single request door
// ---------------------------------------------------------------------------

function buildUrl(path, query) {
  let url = BASE + path;
  const parts = [];
  const q = query || {};
  Object.keys(q).forEach(function (k) {
    const v = q[k];
    if (v === undefined || v === null || v === '') return;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
  });
  if (parts.length) url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
  return url;
}

function httpError(status, body) {
  let msg = 'Judi API returned ' + status;
  if (status === 401 || status === 403) msg = 'Judi rejected the API key (' + status + ')';
  // 404 from this API means "not in your account", NOT "does not exist". Saying
  // "no such call" would be a lie that sends someone hunting for a bug.
  if (status === 404) msg = 'Not found in this Judi account';
  if (status === 429) msg = 'Judi rate limit reached';
  const err = new Error(msg);
  err.status = status;
  err.judiBody = body;
  return err;
}

// Every outbound call goes through here. One door means the key, the timeout,
// the rate limit and the retry policy cannot drift apart between endpoints.
async function request(path, opts) {
  const o = opts || {};
  if (!configured()) {
    const err = new Error('Judi is not configured (JUDI_API_KEY is not set)');
    err.judiCode = 'not_configured';
    throw err;
  }

  const url = buildUrl(path, o.query);
  const cacheKey = 'GET ' + url;
  if (o.cache !== false) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }

  let attempt = 0;
  let lastErr = null;

  // At most two tries. Retrying a 400/401/403/404 just burns the rate budget on
  // a request that will never succeed, so those break out immediately.
  while (attempt < 2) {
    attempt++;
    await takeToken();

    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    let res = null;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'X-API-Key': apiKey(), 'Accept': 'application/json' },
        signal: ctl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = new Error(e.name === 'AbortError' ? 'Judi timed out after ' + TIMEOUT_MS + 'ms' : 'Judi unreachable: ' + e.message);
      lastErr.judiCode = e.name === 'AbortError' ? 'timeout' : 'unreachable';
      if (attempt >= 2) throw lastErr;
      await sleep(400);
      continue;
    }
    clearTimeout(timer);

    if (res.status >= 400) {
      let body = '';
      try { body = (await res.text()).slice(0, 500); } catch (e) { body = ''; }
      const err = httpError(res.status, body);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 2) throw err;

      // Honour the server's own backoff when it tells us one. RateLimit-Reset
      // is in seconds; cap it so one unlucky request cannot hang a page load.
      let waitMs = 600;
      const reset = res.headers.get('RateLimit-Reset') || res.headers.get('Retry-After');
      if (reset) {
        const secs = parseFloat(reset);
        if (!isNaN(secs) && secs > 0) waitMs = Math.min(5000, secs * 1000);
      }
      lastErr = err;
      await sleep(waitMs);
      continue;
    }

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      const err = new Error('Judi returned a non-JSON response');
      err.judiCode = 'bad_json';
      throw err;
    }
    if (o.cache !== false) cacheSet(cacheKey, json);
    return json;
  }

  throw lastErr || new Error('Judi request failed');
}

// ---------------------------------------------------------------------------
// Value normalisers
// ---------------------------------------------------------------------------

// Decimals arrive from this API as JSON STRINGS - quote_amount, lat, lng and
// every grade score. '125.00' + 0 is '125.000', and '9.5' > '10' is true, so
// every one of them has to be parsed before it is used or compared.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 999 (and anything from 160 up) is a SENTINEL meaning the location is closed
// or no tech is available. It is not an ETA. Rendering it as "999 minutes" is
// how a dispatcher ends up telling a customer their tech is 16 hours out.
const ETA_SENTINEL_FLOOR = 160;

function eta(v) {
  const n = num(v);
  if (n === null) return { minutes: null, unavailable: false };
  if (n >= ETA_SENTINEL_FLOOR) return { minutes: null, unavailable: true };
  return { minutes: n, unavailable: false };
}

// The API's field naming was captured by hand rather than from a spec, so every
// read goes through a tolerant picker. A renamed field then shows up as one
// blank value in the UI instead of a crash, and GET /status prints the real key
// list so the mapping can be corrected against live data.
function pick(obj, names, dflt) {
  if (!obj) return dflt === undefined ? null : dflt;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return dflt === undefined ? null : dflt;
}

function shortCodeOf(raw) {
  // short_code is NOT always short - 'tc_call_a7b018...' exists in the wild.
  // Treat it as an opaque string, never parse it, always encodeURIComponent it.
  const v = pick(raw, ['short_code', 'shortCode', 'call_id', 'id']);
  return v === null ? null : String(v);
}

// ---------------------------------------------------------------------------
// Shapers
// ---------------------------------------------------------------------------

// A summary row for the merged timeline. Deliberately does NOT carry the
// transcript: a 9-call lookup is 6 KB as summaries and 253 KB with ?full=true,
// and a single detail is roughly 95 KB. Never request full=true for a list.
function listRow(raw) {
  const etaMin = eta(pick(raw, ['eta_minutes_min', 'etaMinutesMin']));
  const channel = String(pick(raw, ['channel'], 'phone') || 'phone').toLowerCase();
  return {
    source: 'judi',
    short_code: shortCodeOf(raw),
    channel: channel,
    // Judi answers the inbound line, so every row is inbound by definition. It
    // is stated rather than inferred so the merged timeline can sort and badge
    // Judi and GoTo rows through the same code path.
    direction: 'INBOUND',
    // created_at is UTC. The API's start/end filters are US Central calendar
    // days, which is a different thing entirely - see callsForPhone.
    started_at: pick(raw, ['created_at', 'started_at', 'start_time']),
    ended_at: pick(raw, ['ended_at', 'end_time']),
    duration_sec: num(pick(raw, ['duration_seconds', 'duration_sec', 'duration'])),
    number: pick(raw, ['from_phone', 'caller_phone', 'from']),
    customer_name: pick(raw, ['customer_name', 'caller_name']),
    outcome: pick(raw, ['outcome', 'disposition', 'result']),
    quote_amount: num(pick(raw, ['quote_amount', 'quoteAmount'])),
    eta_minutes: etaMin.minutes,
    eta_unavailable: etaMin.unavailable,
    grade_score: num(pick(raw, ['grade_score', 'overall_score', 'ai_grade'])),
    location_id: pick(raw, ['location_id', 'locationId']),
    location_name: pick(raw, ['location_name', 'location']),
    // A chat row has no audio at all, so the UI must not offer a play button
    // for one. recording_url absent on a phone row means the recording is not
    // ready yet, which is a different message.
    has_recording: channel !== 'chat' && !!pick(raw, ['recording_url', 'recordingUrl', 'has_recording'])
  };
}

function gradeRows(raw) {
  // The AI grade arrives as either a flat object of dimension -> score or a list
  // of {dimension, score, notes}. Normalise both into one list so the UI has a
  // single shape to render.
  const g = pick(raw, ['grade', 'ai_grade', 'grading', 'scores']);
  if (!g) return [];
  if (Array.isArray(g)) {
    return g.map(function (row) {
      return {
        dimension: String(pick(row, ['dimension', 'name', 'category'], '') || ''),
        score: num(pick(row, ['score', 'value', 'rating'])),
        notes: pick(row, ['notes', 'note', 'coaching', 'feedback'], '')
      };
    }).filter(function (r) { return r.dimension; });
  }
  if (typeof g === 'object') {
    return Object.keys(g).map(function (k) {
      const v = g[k];
      if (v !== null && typeof v === 'object') {
        return {
          dimension: k,
          score: num(pick(v, ['score', 'value', 'rating'])),
          notes: pick(v, ['notes', 'note', 'coaching', 'feedback'], '')
        };
      }
      return { dimension: k, score: num(v), notes: '' };
    }).filter(function (r) { return r.score !== null || r.notes; });
  }
  return [];
}

function detailRow(raw) {
  const base = listRow(raw);
  const meta = pick(raw, ['metadata', 'meta'], {}) || {};
  return Object.assign(base, {
    transcript: pick(raw, ['transcript_english', 'transcript', 'transcript_text'], ''),
    summary: pick(raw, ['summary', 'call_summary'], ''),
    // Chat rows carry their content in metadata rather than as a transcript.
    chat_summary: pick(meta, ['chat_summary'], ''),
    user_sentiment: pick(meta, ['user_sentiment'], ''),
    vehicle: pick(raw, ['vehicle', 'vehicle_info'], ''),
    service_type: pick(raw, ['service_type', 'service'], ''),
    address: pick(raw, ['address', 'service_address'], ''),
    lat: num(pick(raw, ['lat', 'latitude'])),
    lng: num(pick(raw, ['lng', 'lon', 'longitude'])),
    grade_notes: pick(raw, ['grade_notes', 'coaching_notes'], ''),
    grades: gradeRows(raw),
    // The upstream media URL is intentionally NOT returned to the browser.
    // routes/judi.js proxies the audio instead, which keeps the API key server
    // side and works whether that URL turns out to be a signed, expiring link
    // or a permanent public one. Handing a permanent unsigned URL to the client
    // would put customer audio one copy-paste away from anyone.
    has_recording: base.has_recording
  });
}

// The raw upstream media URL, for the proxy in routes/judi.js only.
function recordingUrlOf(raw) {
  return pick(raw, ['recording_url', 'recordingUrl']);
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

function rowsOf(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  const list = json.calls || json.data || json.results || json.items;
  return Array.isArray(list) ? list : [];
}

// Every call Judi has for a phone number, newest first.
//
// Matching is on from_phone, the CALLER's number. A customer who called once
// from a mobile and once from a shop line will only match the one searched.
// That is upstream behaviour, not something Nova can widen.
async function callsForPhone(phone, opts) {
  const o = opts || {};
  const digits = gotoUtil.normalizeDigits(phone);
  if (!digits) return { calls: [], digits: null, reason: 'bad_phone' };

  const json = await request(PATHS.calls, {
    query: { phone: digits, limit: o.limit || 50 },
    cache: o.cache
  });

  const calls = rowsOf(json).map(listRow).filter(function (r) { return r.short_code; });

  // Newest first. The API's own ordering is not guaranteed, and the merged
  // timeline depends on this being true before the client interleaves sources.
  calls.sort(function (a, b) {
    return new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime();
  });

  return { calls: calls, digits: digits };
}

// One call in full. This is the ~95 KB fetch, so it only ever happens on an
// explicit open, never as part of a list.
async function callDetail(shortCode, opts) {
  const code = String(shortCode === null || shortCode === undefined ? '' : shortCode);
  if (!code) {
    const err = new Error('Missing call id');
    err.status = 400;
    throw err;
  }
  const json = await request(PATHS.calls + '/' + encodeURIComponent(code), {
    query: { full: 'true' },
    cache: opts && opts.cache
  });
  const raw = (json && (json.call || json.data)) || json;
  return { shaped: detailRow(raw), recordingUrl: recordingUrlOf(raw) };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// Answers, from production, the questions this integration could not answer
// while it was being written: what does the key actually see, does the calls
// path exist where we think it does, and what do the real field names look
// like. Admin only, and it never returns the key itself.
async function status(sampleLimit) {
  const out = {
    configured: configured(),
    base: BASE,
    calls_path: PATHS.calls,
    timeout_ms: TIMEOUT_MS,
    cache_ttl_ms: CACHE_TTL_MS,
    rate_per_min: RATE_PER_MIN,
    checks: {}
  };
  if (!out.configured) {
    out.checks.key = { ok: false, error: 'JUDI_API_KEY is not set' };
    return out;
  }

  async function probe(name, path, query) {
    try {
      const json = await request(path, { query: query, cache: false });
      const rows = rowsOf(json);
      out.checks[name] = {
        ok: true,
        path: path,
        row_count: rows.length,
        // Key names only, never values. The point is to correct the field
        // mapping, and printing values would drop customer names into an
        // admin screen for no reason.
        sample_keys: rows.length && rows[0] && typeof rows[0] === 'object'
          ? Object.keys(rows[0]).sort()
          : (json && typeof json === 'object' ? Object.keys(json).sort() : [])
      };
    } catch (e) {
      out.checks[name] = { ok: false, path: path, status: e.status || null, error: e.message };
    }
  }

  await probe('ping', PATHS.ping, null);
  await probe('locations', PATHS.locations, null);
  await probe('calls', PATHS.calls, { limit: sampleLimit || 1 });

  return out;
}

module.exports = {
  configured: configured,
  status: status,
  callsForPhone: callsForPhone,
  callDetail: callDetail,
  cacheClear: cacheClear,
  // exported for the test harness
  _internals: {
    num: num,
    eta: eta,
    pick: pick,
    listRow: listRow,
    detailRow: detailRow,
    gradeRows: gradeRows,
    rowsOf: rowsOf,
    buildUrl: buildUrl,
    ETA_SENTINEL_FLOOR: ETA_SENTINEL_FLOOR
  }
};
