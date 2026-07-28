// utils/goto.js
// GoTo Connect (formerly Jive) API client for Nova.
//
// WHY THIS LOOKS DIFFERENT FROM utils/graph.js:
// Microsoft Graph supports client_credentials, so it is app-only and never needs
// a human. GoTo does NOT support client_credentials. The only server-to-server
// path is: an admin consents once via the authorization-code flow, we store the
// refresh token, and we keep it alive forever in the background.
//
//   access token  = 60 minutes
//   refresh token = 30 days, and it does NOT rotate on every call
//
// That 30 days is a hard deadline. If Nova goes 30 days without refreshing, the
// integration dies and a human has to reconnect. jobs/gotoSync.js refreshes on a
// timer for exactly this reason, and status() surfaces last_error so it is loud
// in Settings rather than silently broken.
//
// Tokens are AES-256-GCM encrypted before they touch the database. A leaked GoTo
// refresh token reads EVERY call recording in the company (GoTo has no
// per-department scoping), so plaintext at rest is not acceptable here.
//
// No backticks in this file (Windows clipboard safety).

'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

// ---- Endpoints -------------------------------------------------------------
// The old api.getgo.com/oauth/v2/* endpoints were decommissioned 2025-09-30.
const AUTHORIZE_URL = 'https://authentication.logmeininc.com/oauth/authorize';
const TOKEN_URL = 'https://authentication.logmeininc.com/oauth/token';
const API_BASE = 'https://api.goto.com';

// ---- Scopes ----------------------------------------------------------------
// Taken from the granular list on GoTo's OAuth client form (confirmed 2026-07-28,
// since none of this is in their published docs):
//
//   cr.v1.read                            "Access call history for phone lines in
//                                          the PBX" - finds the calls
//   recording.v1.read                     "Retrieve call recordings and
//                                          transcripts" - the audio AND the
//                                          transcript, one scope covers both
//   call-events.v1.events.read            recover call events a missed webhook
//                                          dropped (the reconcile job)
//   call-events.v1.notifications.manage   subscribe to REPORT_SUMMARY and
//                                          REPORT_SUMMARY_REVISION
//   recording.v1.notifications.manage     be told when a recording is READY.
//                                          Undocumented but real; this is what
//                                          catches recordings that attach minutes
//                                          after the call ends.
//   voice-admin.v1.read                   enumerate our own numbers/extensions, so
//                                          the customer side of a call is found by
//                                          elimination rather than by guessing
//                                          which participant slot they are in
//
// Deliberately NOT requested: anything .write, call-control.v1.calls.control and
// calls.v2.initiate (write powers over live calls), messaging, contacts, fax,
// voicemail, presence. Recording access in GoTo is already all-or-nothing, so the
// surface around it is kept as small as it can be.
//
// Override with GOTO_SCOPES if GoTo renames one, then reconnect. Changing scopes
// requires re-consent - a refresh alone will not widen an existing grant.
const DEFAULT_SCOPES = [
  'cr.v1.read',
  'recording.v1.read',
  'call-events.v1.events.read',
  'call-events.v1.notifications.manage',
  'recording.v1.notifications.manage',
  'voice-admin.v1.read'
].join(' ');
function scopes() {
  return (process.env.GOTO_SCOPES || DEFAULT_SCOPES).trim();
}

// Refresh once we are this far into the token's life. GoTo's own reference
// implementation uses 1/3 of expires_in, so a transient failure still leaves
// two thirds of the window to retry in.
const REFRESH_AT_FRACTION = 1 / 3;

// ---- Config ----------------------------------------------------------------

function clientId() { return (process.env.GOTO_CLIENT_ID || '').trim(); }
function clientSecret() { return (process.env.GOTO_CLIENT_SECRET || '').trim(); }
function redirectUri() { return (process.env.GOTO_REDIRECT_URI || '').trim(); }
function accountKey() { return (process.env.GOTO_ACCOUNT_KEY || '').trim(); }

// True when the app is configured enough to attempt a connection. Deliberately
// does NOT require GOTO_ACCOUNT_KEY, because the connect flow works without it
// and the account key is only needed once we start querying calls.
function configured() {
  return !!(clientId() && clientSecret() && redirectUri());
}

// ---- Token encryption at rest ----------------------------------------------
// Key precedence: GOTO_TOKEN_KEY, then HR_DOC_ENC_KEY, then JWT_SECRET. JWT_SECRET
// always exists, so encryption is never silently skipped. The tradeoff: rotating
// JWT_SECRET makes stored GoTo tokens undecryptable. That is handled, not ignored
// - decrypt failure is reported as "disconnected, please reconnect" rather than
// throwing, so a secret rotation degrades to one admin click instead of a crash.
function encKey() {
  const raw = (process.env.GOTO_TOKEN_KEY || process.env.HR_DOC_ENC_KEY || process.env.JWT_SECRET || '').trim();
  if (!raw) return null;
  // Accept a real 32-byte base64/hex key as-is; otherwise derive one.
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) return b; } catch (e) {}
  try { const h = Buffer.from(raw, 'hex'); if (h.length === 32) return h; } catch (e) {}
  return crypto.createHash('sha256').update('nova-goto-token-v1:' + raw).digest();
}

function encField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = encKey();
  if (!key) throw new Error('No key available to encrypt GoTo tokens (set JWT_SECRET)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

// Returns the plaintext, or null when the blob cannot be decrypted (wrong key,
// tampering, or a pre-encryption legacy row). Never throws.
function decField(packedB64) {
  if (!packedB64) return null;
  try {
    const key = encKey();
    if (!key) return null;
    const packed = Buffer.from(String(packedB64), 'base64');
    if (packed.length < 12 + 16 + 1) return null;
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const enc = packed.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// ---- Token store (single row, id = 1) --------------------------------------

async function loadRow() {
  try {
    const r = await pool.query('SELECT * FROM goto_oauth WHERE id = 1');
    return r.rows.length ? r.rows[0] : null;
  } catch (e) {
    console.error('[goto] loadRow:', e.message);
    return null;
  }
}

async function saveTokens(fields) {
  const row = await loadRow();
  const accessEnc = fields.access_token !== undefined ? encField(fields.access_token) : (row ? row.access_token : null);
  const refreshEnc = fields.refresh_token !== undefined ? encField(fields.refresh_token) : (row ? row.refresh_token : null);
  await pool.query(
    'INSERT INTO goto_oauth (id, access_token, refresh_token, expires_at, scope, account_key, connected_by, connected_at, last_refresh_at, last_error)' +
    ' VALUES (1, $1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), $8, $9)' +
    ' ON CONFLICT (id) DO UPDATE SET access_token = $1, refresh_token = $2, expires_at = $3, scope = $4,' +
    ' account_key = COALESCE($5, goto_oauth.account_key), connected_by = COALESCE($6, goto_oauth.connected_by),' +
    ' connected_at = COALESCE($7, goto_oauth.connected_at), last_refresh_at = $8, last_error = $9',
    [
      accessEnc,
      refreshEnc,
      fields.expires_at || null,
      fields.scope || null,
      fields.account_key || null,
      fields.connected_by || null,
      fields.connected_at || null,
      fields.last_refresh_at || new Date().toISOString(),
      fields.last_error === undefined ? null : fields.last_error
    ]
  );
}

async function noteError(message) {
  try {
    await pool.query(
      'INSERT INTO goto_oauth (id, last_error) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_error = $1',
      [String(message || '').slice(0, 500)]
    );
  } catch (e) { console.error('[goto] noteError:', e.message); }
}

async function disconnect() {
  await pool.query(
    'INSERT INTO goto_oauth (id, access_token, refresh_token, expires_at, scope, connected_by, connected_at, last_error)' +
    ' VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL, NULL)' +
    ' ON CONFLICT (id) DO UPDATE SET access_token = NULL, refresh_token = NULL, expires_at = NULL,' +
    ' scope = NULL, connected_by = NULL, connected_at = NULL, last_error = NULL'
  );
}

// Health summary for the Settings panel. Never throws, never returns a token.
async function status() {
  const row = await loadRow();
  const hasRefresh = !!(row && row.refresh_token);
  const refreshPlain = hasRefresh ? decField(row.refresh_token) : null;
  const undecryptable = hasRefresh && !refreshPlain;
  const expiresAt = row && row.expires_at ? new Date(row.expires_at) : null;
  const lastRefresh = row && row.last_refresh_at ? new Date(row.last_refresh_at) : null;

  // GoTo refresh tokens die after 30 days of not being used. Warn before that.
  let staleDays = null;
  if (lastRefresh) staleDays = Math.floor((Date.now() - lastRefresh.getTime()) / 86400000);

  return {
    configured: configured(),
    connected: !!refreshPlain,
    undecryptable: undecryptable,
    accountKey: (row && row.account_key) || accountKey() || null,
    accountKeySource: (row && row.account_key) ? 'discovered' : (accountKey() ? 'env' : null),
    scope: (row && row.scope) || null,
    connectedAt: (row && row.connected_at) || null,
    lastRefreshAt: (row && row.last_refresh_at) || null,
    accessExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    accessValid: !!(expiresAt && expiresAt.getTime() > Date.now()),
    staleDays: staleDays,
    expiringSoon: staleDays !== null && staleDays >= 21,
    lastError: (row && row.last_error) || null,
    redirectUri: redirectUri() || null
  };
}

// ---- OAuth state (signed, so it survives a restart without a session store) --

function stateSecret() {
  return process.env.JWT_SECRET || 'nova-goto-state';
}

function makeState(userId) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const issued = String(Date.now());
  const body = (parseInt(userId, 10) || 0) + '.' + issued + '.' + nonce;
  const sig = crypto.createHmac('sha256', stateSecret()).update(body).digest('hex').slice(0, 32);
  return Buffer.from(body + '.' + sig, 'utf8').toString('base64url');
}

// Returns { ok, userId } - ok is false for a bad signature or a state older
// than 15 minutes.
function readState(state) {
  try {
    const raw = Buffer.from(String(state || ''), 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 4) return { ok: false, userId: 0 };
    const body = parts[0] + '.' + parts[1] + '.' + parts[2];
    const expect = crypto.createHmac('sha256', stateSecret()).update(body).digest('hex').slice(0, 32);
    const a = Buffer.from(expect);
    const b = Buffer.from(parts[3]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, userId: 0 };
    const issued = parseInt(parts[1], 10) || 0;
    if (Date.now() - issued > 15 * 60 * 1000) return { ok: false, userId: 0 };
    return { ok: true, userId: parseInt(parts[0], 10) || 0 };
  } catch (e) {
    return { ok: false, userId: 0 };
  }
}

function authorizeUrl(userId) {
  const p = new URLSearchParams();
  p.set('client_id', clientId());
  p.set('response_type', 'code');
  p.set('redirect_uri', redirectUri());
  p.set('scope', scopes());
  p.set('state', makeState(userId));
  return AUTHORIZE_URL + '?' + p.toString();
}

// ---- Token exchange / refresh ----------------------------------------------

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(clientId() + ':' + clientSecret()).toString('base64');
}

async function postToken(form) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: form.toString()
  });
  let data = {};
  try { data = await resp.json(); } catch (e) { data = {}; }
  if (!resp.ok || !data.access_token) {
    const detail = data && (data.error_description || data.error) ? (data.error_description || data.error) : ('HTTP ' + resp.status);
    throw new Error('GoTo token request failed: ' + detail);
  }
  return data;
}

function expiryFrom(data) {
  const secs = parseInt(data.expires_in, 10) || 3600;
  return new Date(Date.now() + secs * 1000).toISOString();
}

// Initial connect. userId is the admin who consented.
async function exchangeCode(code, userId) {
  if (!configured()) throw new Error('GoTo is not configured (GOTO_CLIENT_ID / GOTO_CLIENT_SECRET / GOTO_REDIRECT_URI)');
  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  form.set('redirect_uri', redirectUri());
  const data = await postToken(form);
  if (!data.refresh_token) {
    throw new Error('GoTo returned no refresh token. The OAuth client must allow the authorization_code grant.');
  }
  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiryFrom(data),
    scope: data.scope || scopes(),
    account_key: accountKey() || null,
    connected_by: userId || null,
    connected_at: new Date().toISOString(),
    last_refresh_at: new Date().toISOString(),
    last_error: null
  });

  // Discover the account key so nobody has to go hunting for it. The token
  // response used to carry account_key, but the current token endpoint dropped
  // that field, so it has to be fetched. Best effort: a failure here must not
  // undo a successful connection, since the key can still be set by hand.
  if (!accountKey()) {
    try {
      const found = await discoverAccounts();
      if (found.length === 1) {
        await pool.query('UPDATE goto_oauth SET account_key = $1 WHERE id = 1', [found[0].key]);
      }
      // More than one account means a human has to choose - routes/goto.js
      // exposes the list rather than picking arbitrarily.
    } catch (e) {
      console.error('[goto] account key discovery:', e.message);
    }
  }
  return true;
}

// Ask GoTo which account(s) this connection belongs to.
// The Admin "me" endpoint moved hosts over time and is not consistently
// documented, so try the known spellings in order and use whichever answers.
// Returns [{ key, name }], possibly empty. Never throws.
// api.getgo.com/admin/rest/v1/me is the URL GoTo's own Admin reference documents,
// with accountKey at the response root. The OAuth endpoints on that host were
// decommissioned in 2025 though, so the admin surface may have moved with them -
// hence the alternates.
const ME_ENDPOINTS = [
  'https://api.getgo.com/admin/rest/v1/me',
  'https://api.goto.com/admin/rest/v1/me',
  'https://api.goto.com/admin/v1/me',
  'https://api.getgo.com/identity/v1/Users/me',
  'https://api.goto.com/identity/v1/Users/me',
  'https://api.goto.com/scim/v2/Me',
  'https://api.goto.com/users/v1/users/me'
];

// Probe every candidate and report exactly what came back. This exists because
// discovery failed silently in production and no amount of reading GoTo's docs
// explained why - a 401 (scope), a 403 (permission), a 404 (moved host) and a
// redirect all need different fixes, and they are indistinguishable from a
// swallowed exception. Admin-only, and it truncates bodies so a response cannot
// dump anything large into a log.
async function probeMe() {
  const results = [];
  let token = null;
  try {
    token = await getAccessToken();
  } catch (e) {
    return [{ url: '(token)', ok: false, status: 0, note: e.message }];
  }
  for (let i = 0; i < ME_ENDPOINTS.length; i++) {
    const url = ME_ENDPOINTS[i];
    const entry = { url: url, ok: false, status: 0, note: '', body: '' };
    try {
      const resp = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        redirect: 'manual'
      });
      entry.status = resp.status;
      entry.ok = resp.ok;
      const loc = resp.headers.get('location');
      if (loc) entry.note = 'redirects to ' + loc;
      let text = '';
      try { text = await resp.text(); } catch (e2) { text = ''; }
      entry.body = String(text).slice(0, 400);
      // Surface the account key immediately if this response carries one.
      try {
        const j = JSON.parse(text);
        const k = j.accountKey || j.account_key ||
          (Array.isArray(j.accounts) && j.accounts.length && (j.accounts[0].key || j.accounts[0].accountKey));
        if (k) entry.accountKey = String(k);
      } catch (e3) {}
    } catch (e) {
      entry.note = 'threw: ' + e.message;
    }
    results.push(entry);
  }
  return results;
}

async function discoverAccounts() {
  const out = [];
  const seen = {};
  for (let i = 0; i < ME_ENDPOINTS.length; i++) {
    let data = null;
    try {
      data = await gotoFetch(ME_ENDPOINTS[i], { retries: 0 });
    } catch (e) {
      continue; // wrong host or not permitted by our scopes - try the next
    }
    if (!data || typeof data !== 'object') continue;

    // Shape A: { accounts: [ { key, name } ] }
    if (Array.isArray(data.accounts)) {
      data.accounts.forEach(function (a) {
        const k = a && (a.key || a.accountKey);
        if (k && !seen[k]) { seen[k] = true; out.push({ key: String(k), name: (a && (a.name || a.accountName)) || null }); }
      });
    }
    // Shape B: { accountKey: "..." } on the object itself
    const direct = data.accountKey || data.account_key;
    if (direct && !seen[direct]) { seen[direct] = true; out.push({ key: String(direct), name: data.name || null }); }

    if (out.length) return out;
  }
  return out;
}

// The account key actually in effect: what we discovered and stored, else the
// env var. Stored wins, so a value found at connect time survives a stale env.
async function resolveAccountKey() {
  const row = await loadRow();
  if (row && row.account_key) return row.account_key;
  return accountKey() || null;
}

async function setAccountKey(key) {
  const clean = String(key || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 64);
  if (!clean) throw new Error('Account key is empty or not a valid key');
  await pool.query(
    'INSERT INTO goto_oauth (id, account_key) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET account_key = $1',
    [clean]
  );
  return clean;
}

// Single-flight guard: several callers hitting an expired token at once should
// produce ONE refresh, not a thundering herd against a 10 req/sec limit.
let _refreshing = null;

async function refresh() {
  if (_refreshing) return _refreshing;
  _refreshing = (async function () {
    const row = await loadRow();
    const current = row ? decField(row.refresh_token) : null;
    if (!current) {
      const msg = row && row.refresh_token
        ? 'Stored GoTo tokens could not be decrypted (was JWT_SECRET rotated?). Reconnect GoTo in Settings.'
        : 'GoTo is not connected. An admin needs to connect it in Settings.';
      await noteError(msg);
      throw new Error(msg);
    }
    const form = new URLSearchParams();
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', current);
    let data;
    try {
      data = await postToken(form);
    } catch (e) {
      await noteError(e.message);
      throw e;
    }
    await saveTokens({
      access_token: data.access_token,
      // GoTo only returns a refresh_token when it issues a NEW one. Reusing the
      // current one when the field is absent is required, not an optimization -
      // writing null here would disconnect the integration on every refresh.
      refresh_token: data.refresh_token || current,
      expires_at: expiryFrom(data),
      scope: data.scope || (row && row.scope) || scopes(),
      last_refresh_at: new Date().toISOString(),
      last_error: null
    });
    return data.access_token;
  })();
  try {
    return await _refreshing;
  } finally {
    _refreshing = null;
  }
}

// Returns a usable access token, refreshing proactively at 1/3 of remaining life.
async function getAccessToken() {
  const row = await loadRow();
  if (!row) throw new Error('GoTo is not connected. An admin needs to connect it in Settings.');
  const token = decField(row.access_token);
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (token && expiresAt) {
    const lifeMs = 3600 * 1000;
    const refreshThreshold = expiresAt - lifeMs * (1 - REFRESH_AT_FRACTION);
    if (Date.now() < refreshThreshold) return token;
  }
  return refresh();
}

// ---- HTTP ------------------------------------------------------------------

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Authenticated request against api.goto.com.
//   path    - absolute URL, or a path like '/call-events-report/v1/report-summaries'
//   opts    - standard fetch options, plus:
//             raw:true    resolve with the Response instead of parsed JSON
//             retries:n   how many times to retry a 429 (default 3)
//
// Handles a 401 by refreshing once and retrying, and a 429 by honoring
// Retry-After. GoTo's limit is 10 requests per second, per API.
async function gotoFetch(path, opts) {
  opts = opts || {};
  const url = /^https?:\/\//.test(path) ? path : (API_BASE + path);
  const maxRetries = opts.retries === undefined ? 3 : opts.retries;
  let refreshed = false;
  let attempt = 0;

  for (;;) {
    const token = await getAccessToken();
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    headers.Authorization = 'Bearer ' + token;

    const resp = await fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body
    });

    if (resp.status === 401 && !refreshed) {
      refreshed = true;
      await refresh();
      continue;
    }

    if (resp.status === 429 && attempt < maxRetries) {
      const retryAfter = parseFloat(resp.headers.get('retry-after') || '');
      const waitMs = isNaN(retryAfter) ? Math.min(8000, 500 * Math.pow(2, attempt)) : Math.min(30000, retryAfter * 1000);
      attempt++;
      await sleep(waitMs);
      continue;
    }

    if (opts.raw) return resp;

    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.text()).slice(0, 300); } catch (e) { detail = ''; }
      throw new Error('GoTo API ' + resp.status + ' on ' + url + (detail ? (': ' + detail) : ''));
    }
    try { return await resp.json(); } catch (e) { return {}; }
  }
}

// ---- Phone normalization ---------------------------------------------------
// Match on the LAST 10 DIGITS. Pulsar, Twilio and GoTo all disagree about the
// country code and punctuation, and the trailing 10 is the only part they agree
// on for a North American number.
//
//   '(704) 555-0134'      -> '7045550134'
//   '+1 704-555-0134'     -> '7045550134'
//   '17045550134'         -> '7045550134'
//   '704.555.0134 x22'    -> '7045550134'
//   '704-555-0134 ext. 9' -> '7045550134'
//
// The extension has to be removed BEFORE the digits are stripped. Naively
// removing punctuation turns '704.555.0134 x22' into '7045550134 22', whose
// last 10 digits are '4555013422' - a plausible-looking key that belongs to
// nobody. That silently matches the wrong customer's recordings, which is the
// worst failure this module can have, so it is handled here rather than left to
// callers to remember.
//
// Returns null for anything that does not yield a usable 10-digit key. A short
// or partial number must NOT partial-match, for the same reason.
function normalizeDigits(input) {
  const raw = String(input === null || input === undefined ? '' : input);
  // Drop a trailing extension: 'x22', 'ext 22', 'ext. 22', 'extension 22', '#22'.
  // Bounded to 1-6 digits so a real 10-digit number is never mistaken for one.
  const noExt = raw.replace(/[\s,;]*(?:x|ext\.?|extension|#)[\s.:]*\d{1,6}\s*$/i, '');
  const digits = noExt.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Take the trailing 10, so an 11-digit '1XXXXXXXXXX', a '+1'-prefixed form and
  // a bare 10-digit number all land on the same key.
  const tail = digits.slice(-10);
  if (/^0+$/.test(tail)) return null;
  return tail;
}

// Pretty form for display, falling back to the original when it is not a plain
// 10-digit North American number.
function formatDigits(input) {
  const d = normalizeDigits(input);
  if (!d) return String(input === null || input === undefined ? '' : input);
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

module.exports = {
  // config + health
  configured: configured,
  status: status,
  scopes: scopes,
  accountKey: accountKey,
  // oauth
  authorizeUrl: authorizeUrl,
  readState: readState,
  exchangeCode: exchangeCode,
  discoverAccounts: discoverAccounts,
  probeMe: probeMe,
  resolveAccountKey: resolveAccountKey,
  setAccountKey: setAccountKey,
  refresh: refresh,
  getAccessToken: getAccessToken,
  disconnect: disconnect,
  noteError: noteError,
  // http
  gotoFetch: gotoFetch,
  API_BASE: API_BASE,
  // phone
  normalizeDigits: normalizeDigits,
  formatDigits: formatDigits
};
