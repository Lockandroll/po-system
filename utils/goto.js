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
// Probed against the live account 2026-07-28. Results:
//   identity/v1/Users/me  -> 200 on BOTH hosts (a SCIM record, with getgo and
//                            jive schema extensions). Listed first because it
//                            is the only thing that answers.
//   admin/rest/v1/me      -> 401 not.authenticated on api.getgo.com. That is the
//                            Admin Center surface and our token is not valid for
//                            it. GoTo's Voice Admin guide points here, but that
//                            guide is out of date.
//   admin/rest/v1/me      -> 404 on api.goto.com (never moved there)
//   scim/v2/Me, users/v1  -> 404
const ME_ENDPOINTS = [
  'https://api.goto.com/identity/v1/Users/me',
  'https://api.getgo.com/identity/v1/Users/me',
  'https://api.getgo.com/admin/rest/v1/me',
  'https://api.goto.com/admin/v1/me',
  'https://api.goto.com/admin/rest/v1/me'
];

// Walk an arbitrary object looking for an account key. Written as a search
// rather than a fixed path because GoTo returns at least three different
// shapes for "who am I", and the SCIM response buries things inside
// namespaced extension objects such as
// "urn:scim:schemas:extension:jive:1.0". Guessing the path wastes a deploy
// each time; searching does not.
//
// Only accepts a plausible key: 6+ digits. A user id, a locale or a boolean
// sitting under a similarly-named field must not be mistaken for one.
function findAccountKey(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 6) return null;

  // SCIM shape, which is what GoTo actually returns from identity/v1/Users/me:
  //   "accounts":[{"value":"1842200297248054807","display":"Pop A Lock",
  //                "entitlements":["acctadmin","gotoconnect","jive"]}]
  // The key lives under "value", not "key" or "accountKey". Checked before the
  // generic walk so it wins over anything similarly-named deeper in the tree.
  if (Array.isArray(node.accounts)) {
    for (let i = 0; i < node.accounts.length; i++) {
      const a = node.accounts[i];
      if (!a || typeof a !== 'object') continue;
      const v = a.value !== undefined ? a.value : (a.key !== undefined ? a.key : a.accountKey);
      if ((typeof v === 'string' || typeof v === 'number') && /^[0-9]{6,}$/.test(String(v))) {
        return String(v);
      }
    }
  }

  const keys = Object.keys(node);
  // Exact-ish field names first, at this level, before recursing.
  for (let i = 0; i < keys.length; i++) {
    const name = keys[i];
    if (/^(account_?key|account_?id|accountnumber)$/i.test(name)) {
      const v = node[name];
      if ((typeof v === 'string' || typeof v === 'number') && /^[0-9]{6,}$/.test(String(v))) {
        return String(v);
      }
    }
  }
  for (let i = 0; i < keys.length; i++) {
    const v = node[keys[i]];
    if (Array.isArray(v)) {
      for (let j = 0; j < v.length; j++) {
        const hit = findAccountKey(v[j], depth + 1);
        if (hit) return hit;
      }
    } else if (v && typeof v === 'object') {
      const hit = findAccountKey(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

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
      entry.body = String(text).slice(0, 2500);
      // Surface the account key immediately if this response carries one.
      try {
        const j = JSON.parse(text);
        const k = findAccountKey(j);
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

    // Shape A: an accounts array. GoTo's SCIM record uses value/display; the
    // Admin API uses key/name. Accept either.
    if (Array.isArray(data.accounts)) {
      data.accounts.forEach(function (a) {
        if (!a || typeof a !== 'object') return;
        const k = a.value !== undefined ? a.value : (a.key !== undefined ? a.key : a.accountKey);
        if (k === undefined || k === null || !/^[0-9]{6,}$/.test(String(k))) return;
        if (seen[k]) return;
        seen[k] = true;
        out.push({ key: String(k), name: a.display || a.name || a.accountName || null });
      });
    }
    // Shape B/C: the key sits somewhere else in the payload, possibly inside a
    // namespaced SCIM extension. Search rather than guess the path.
    const direct = findAccountKey(data);
    if (direct && !seen[direct]) {
      seen[direct] = true;
      out.push({ key: String(direct), name: data.displayName || data.name || null });
    }

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




// ---- Recording audio -------------------------------------------------------
// GET /recording/v1/recordings/{id}/content. GoTo does not document whether this
// returns bytes directly or redirects to a signed URL, so handle both. When it
// redirects, the follow-up request must NOT carry our bearer token - a signed
// URL already carries its own auth and some object stores reject a second one.
async function fetchRecordingBytes(recordingId) {
  if (!recordingId) throw new Error('No recording id');
  const url = API_BASE + '/recording/v1/recordings/' + encodeURIComponent(recordingId) + '/content';
  let resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + (await getAccessToken()) },
    redirect: 'manual'
  });

  if (resp.status === 401) {
    await refresh();
    resp = await fetch(url, { headers: { Authorization: 'Bearer ' + (await getAccessToken()) }, redirect: 'manual' });
  }

  let hops = 0;
  while (resp.status >= 300 && resp.status < 400 && hops < 3) {
    const loc = resp.headers.get('location');
    if (!loc) break;
    resp = await fetch(loc);
    hops++;
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch (e) {}
    throw new Error('GoTo recording fetch failed (' + resp.status + ')' + (detail ? ': ' + detail : ''));
  }

  const mime = (resp.headers.get('content-type') || 'audio/wav').split(';')[0].trim();
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('GoTo returned an empty recording');
  return { buffer: buf, mime: mime };
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.indexOf('mpeg') !== -1 || m.indexOf('mp3') !== -1) return 'mp3';
  if (m.indexOf('ogg') !== -1) return 'ogg';
  if (m.indexOf('mp4') !== -1 || m.indexOf('m4a') !== -1) return 'm4a';
  return 'wav';
}

// Copy a call's audio into R2 once, and remember where it went. Idempotent: a
// call already archived returns its existing key without touching GoTo.
//
// This is the step that makes the feature outlive GoTo's ~13 month retention,
// which is the whole reason we copy rather than stream.
async function archiveCall(callId) {
  const r2 = require('./r2');
  const cur = await pool.query('SELECT id, recording_id, r2_key, r2_mime, r2_bytes FROM goto_calls WHERE id = $1', [callId]);
  if (!cur.rows.length) throw new Error('Call not found');
  const row = cur.rows[0];
  // A previously archived file that is not actually audio (an error page stored
  // before the guard below existed) would otherwise be served forever. Treat it
  // as unarchived so the next play re-fetches it.
  const storedLooksWrong = row.r2_key && (
    (row.r2_mime && String(row.r2_mime).indexOf('audio') !== 0 && String(row.r2_mime).indexOf('octet-stream') === -1) ||
    (row.r2_bytes !== null && Number(row.r2_bytes) < 512)
  );
  if (row.r2_key && !storedLooksWrong) {
    return { key: row.r2_key, mime: row.r2_mime, bytes: row.r2_bytes, cached: true };
  }
  if (storedLooksWrong) {
    console.warn('[goto] re-archiving call ' + row.id + ': stored file was ' + row.r2_mime + ', ' + row.r2_bytes + ' bytes');
  }
  if (!row.recording_id) throw new Error('This call has no recording');
  if (!r2.configured()) throw new Error('File storage is not configured (R2_* environment variables).');

  const got = await fetchRecordingBytes(row.recording_id);
  // If GoTo hands back something that is not audio - an error page, a JSON body,
  // an HTML redirect stub - storing it produces a player that silently refuses to
  // play with no clue why. Refuse it here, where the message can be useful.
  if (got.mime.indexOf('audio') !== 0 && got.mime.indexOf('octet-stream') === -1) {
    let peek = '';
    try { peek = got.buffer.slice(0, 120).toString('utf8').replace(/\s+/g, ' ').trim(); } catch (e) {}
    throw new Error('GoTo returned ' + got.mime + ' instead of audio for this recording' + (peek ? (': ' + peek) : '.'));
  }
  if (got.buffer.length < 512) {
    throw new Error('GoTo returned only ' + got.buffer.length + ' bytes for this recording, which is not a playable file.');
  }
  const key = 'call-recordings/' + row.id + '/' + row.recording_id + '.' + extForMime(got.mime);
  await r2.putObject(key, got.buffer, got.mime);
  await pool.query(
    'UPDATE goto_calls SET r2_key = $1, r2_mime = $2, r2_bytes = $3, archived_at = NOW() WHERE id = $4',
    [key, got.mime, got.buffer.length, row.id]
  );
  return { key: key, mime: got.mime, bytes: got.buffer.length, cached: false };
}

// A short-lived URL the browser can stream from. 120 seconds, not the 300s
// default: long enough to start playing, short enough that a link copied off a
// screen share is dead before anyone can reuse it.
async function playbackUrl(callId) {
  const r2 = require('./r2');
  const info = await archiveCall(callId);
  const name = 'call-' + callId + '.' + extForMime(info.mime);
  const url = await r2.presignDownload(info.key, name, true, 120, info.mime);
  return { url: url, mime: info.mime, bytes: info.bytes, cached: info.cached };
}

// ---- Call indexing ---------------------------------------------------------
// GoTo has NO server-side phone filter on report-summaries. All eleven plausible
// parameter names were probed against the live account on 2026-07-28 and every
// one was accepted and silently ignored (200, unfiltered result). So a lookup
// cannot be done on demand - finding one customer would mean paging the whole
// window at 100 calls per page against a 10 req/sec limit.
//
// Instead Nova indexes calls on a schedule and answers complaint lookups from
// its own table. The summary already carries the customer's number, the
// recording id and the transcript id, so a single pass captures everything with
// no second request per call.
//
// WHAT IS STORED: number and metadata only. Tony's call, 2026-07-28. The
// customer's NAME is deliberately dropped, including from the raw payload we
// keep for debugging. Staff names are kept - they are our own people.

const SUMMARY_PAGE_SIZE = 100;

// Which side of the call is the customer? Confirmed from the live API:
//   external customer -> type.value === 'PHONE_NUMBER', callProvider 'PSTN',
//                        a full +1XXXXXXXXXX number
//   our own staff     -> type.value === 'LINE', a 4-digit extension, a userKey
// This is a reliable discriminator, so we never have to guess by position.
function partyType(p) {
  return (p && p.type && p.type.value) || '';
}
function isExternalParty(p) {
  const t = partyType(p);
  return t === 'PHONE_NUMBER' || t === 'EXTERNAL_USER' || t === 'PSTN';
}
function isInternalParty(p) {
  const t = partyType(p);
  return t === 'LINE' || t === 'EXTENSION' || t === 'USER';
}

// All parties on a summary item, caller first.
function allParties(item) {
  const out = [];
  if (item && item.caller) out.push(item.caller);
  if (item && Array.isArray(item.participants)) item.participants.forEach(function (p) { if (p) out.push(p); });
  return out;
}

// Strip anything that identifies the customer, then keep the rest for debugging.
// Field names drift and are undocumented; holding the shape is worth a lot when
// something stops parsing. Holding customer names is not.
function redactRaw(node, depth) {
  depth = depth || 0;
  if (!node || typeof node !== 'object' || depth > 8) return node;
  if (Array.isArray(node)) return node.map(function (x) { return redactRaw(x, depth + 1); });
  const out = {};
  Object.keys(node).forEach(function (k) {
    // Redact the NAME fields only. An earlier version blanked the whole 'caller'
    // object, which threw away the phone number and the recording id with it -
    // the two things the index exists to hold. Recursing instead means a nested
    // caller keeps its number and loses only its name.
    if (k === 'name' || k === 'displayName' || k === 'firstName' || k === 'lastName') {
      // A LINE party's name is our own employee, so keep it.
      if (isInternalParty(node)) { out[k] = node[k]; return; }
      out[k] = '[redacted]';
      return;
    }
    out[k] = redactRaw(node[k], depth + 1);
  });
  return out;
}

function secondsBetween(a, b) {
  if (!a || !b) return null;
  const s = Date.parse(a), e = Date.parse(b);
  if (isNaN(s) || isNaN(e) || e < s) return null;
  return Math.round((e - s) / 1000);
}

// Turn one report-summaries item into a goto_calls row. Returns null when there
// is no external party, which means it was an internal extension-to-extension
// call and is of no use to a customer complaint.
function mapSummaryItem(item) {
  if (!item || !item.conversationSpaceId) return null;
  const parties = allParties(item);
  const ext = parties.filter(isExternalParty)[0] || null;
  const intl = parties.filter(isInternalParty)[0] || null;
  if (!ext) return null;

  const extNumber = ext.number || (ext.type && ext.type.number) || null;
  const digits = normalizeDigits(extNumber);
  if (!digits) return null;

  // Either leg can carry the recording; prefer the external leg, fall back to
  // whichever party has one.
  const withRec = [ext, intl].concat(parties).filter(function (p) { return p && p.recordingId; })[0] || null;
  const withTrans = [ext, intl].concat(parties).filter(function (p) { return p && p.liveTranscriptId; })[0] || null;

  return {
    conversation_space_id: String(item.conversationSpaceId),
    account_key: item.accountKey ? String(item.accountKey) : null,
    direction: item.direction ? String(item.direction).slice(0, 16) : null,
    call_started_at: item.callCreated || null,
    call_ended_at: item.callEnded || null,
    duration_sec: secondsBetween(item.callAnswered || item.callCreated, item.callEnded),
    external_number: extNumber ? String(extNumber).slice(0, 32) : null,
    external_digits: digits,
    internal_number: intl && intl.number ? String(intl.number).slice(0, 32) : null,
    // Our own employee, not the customer.
    agent_name: intl && intl.name ? String(intl.name).slice(0, 255) : null,
    agent_user_key: intl && intl.type && intl.type.userKey ? String(intl.type.userKey).slice(0, 64) : null,
    recording_id: withRec ? String(withRec.recordingId).slice(0, 128) : null,
    transcript_id: withTrans ? String(withTrans.liveTranscriptId).slice(0, 128) : null,
    has_recording: !!withRec,
    // The raw payload is a debugging aid for undocumented field drift. Keeping
    // it for every call costs real storage at ~59,000 calls per 90 days and
    // grows forever, so keep it only where we might actually need to look: the
    // calls that carry a recording. Set GOTO_KEEP_ALL_RAW=1 to keep everything.
    raw_report: (withRec || process.env.GOTO_KEEP_ALL_RAW === '1') ? redactRaw(item) : null
  };
}

// Upsert a page in ONE statement. The first version issued a query per row,
// which is fine for a 10-minute delta and hopeless for a backfill: Tony's
// account has ~59,000 calls in 90 days, so that was 59,000 sequential round
// trips. One multi-row INSERT per page is ~100x fewer.
//
// Returns { inserted, updated }.
async function upsertCalls(rows) {
  if (!rows.length) return { inserted: 0, updated: 0 };

  // Postgres refuses to let ON CONFLICT DO UPDATE touch the same row twice in
  // one statement, so a page containing the same call id twice would abort the
  // whole batch. Keep the last occurrence of each.
  const byId = {};
  rows.forEach(function (r) { byId[r.conversation_space_id] = r; });
  const uniq = Object.keys(byId).map(function (k) { return byId[k]; });

  const COLS = 15;
  const params = [];
  const tuples = [];
  uniq.forEach(function (r, i) {
    const base = i * COLS;
    const ph = [];
    for (let c = 1; c <= COLS; c++) ph.push('$' + (base + c));
    tuples.push('(' + ph.join(',') + ')');
    params.push(
      r.conversation_space_id, r.account_key, r.direction, r.call_started_at, r.call_ended_at,
      r.duration_sec, r.external_number, r.external_digits, r.internal_number, r.agent_name,
      r.agent_user_key, r.recording_id, r.transcript_id, r.has_recording,
      r.raw_report === null ? null : JSON.stringify(r.raw_report)
    );
  });

  try {
    const res = await pool.query(
      'INSERT INTO goto_calls (conversation_space_id, account_key, direction, call_started_at, call_ended_at,' +
      ' duration_sec, external_number, external_digits, internal_number, agent_name, agent_user_key,' +
      ' recording_id, transcript_id, has_recording, raw_report)' +
      ' VALUES ' + tuples.join(',') +
      ' ON CONFLICT (conversation_space_id) DO UPDATE SET' +
      // COALESCE so a later pass can only ADD a recording id, never erase one
      // that was present before (recordings attach after a call ends).
      '   recording_id = COALESCE(EXCLUDED.recording_id, goto_calls.recording_id),' +
      '   transcript_id = COALESCE(EXCLUDED.transcript_id, goto_calls.transcript_id),' +
      '   has_recording = (goto_calls.has_recording OR EXCLUDED.has_recording),' +
      '   call_ended_at = COALESCE(EXCLUDED.call_ended_at, goto_calls.call_ended_at),' +
      '   duration_sec = COALESCE(EXCLUDED.duration_sec, goto_calls.duration_sec),' +
      '   raw_report = COALESCE(EXCLUDED.raw_report, goto_calls.raw_report),' +
      '   last_seen_revision = NOW()' +
      ' RETURNING (xmax = 0) AS was_insert',
      params
    );
    let inserted = 0, updated = 0;
    res.rows.forEach(function (r) { if (r.was_insert) inserted++; else updated++; });
    return { inserted: inserted, updated: updated };
  } catch (e) {
    console.error('[goto] batch upsert failed (' + uniq.length + ' rows):', e.message);
    return { inserted: 0, updated: 0 };
  }
}

// One page of summaries. marker is the nextPageMarker from the previous page.
async function fetchSummaryPage(startIso, endIso, marker) {
  const acct = await resolveAccountKey();
  if (!acct) throw new Error('No GoTo account key. Set it in Settings > Integrations.');
  const p = new URLSearchParams();
  p.set('accountKey', acct);
  p.set('startTime', startIso);
  p.set('endTime', endIso);
  p.set('pageSize', String(SUMMARY_PAGE_SIZE));
  if (marker) p.set('pageMarker', marker);
  const data = await gotoFetch('/call-events-report/v1/report-summaries?' + p.toString());
  return {
    items: Array.isArray(data.items) ? data.items : [],
    marker: data.nextPageMarker || data.nextPageToken || null
  };
}

// GoTo rejects any report-summaries request spanning more than 31 days:
//   {"constraint":"InvalidRange","field":"maximum supported range is 31 days"}
// Undocumented, and only discovered by attempting a 90-day backfill. Anything
// longer has to be split. 30 rather than 31 to stay clear of boundary rounding.
const MAX_WINDOW_DAYS = 30;

// Page ONE window (must be <= 31 days) into goto_calls.
//   opts: { startIso, endIso, maxPages, onPage }
// maxPages is a hard stop so a bad marker cannot spin forever.
async function syncOneWindow(opts) {
  opts = opts || {};
  const endIso = opts.endIso || new Date().toISOString();
  const startIso = opts.startIso;
  if (!startIso) throw new Error('syncOneWindow needs a startIso');
  const maxPages = Math.min(Math.max(parseInt(opts.maxPages, 10) || 200, 1), 2000);

  const stats = { pages: 0, seen: 0, indexed: 0, skipped: 0, inserted: 0, updated: 0, truncated: false };
  let marker = null;
  const seenMarkers = {};

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchSummaryPage(startIso, endIso, marker);
    stats.pages++;
    stats.seen += res.items.length;

    const rows = [];
    res.items.forEach(function (it) {
      const row = mapSummaryItem(it);
      if (row) rows.push(row); else stats.skipped++;
    });
    stats.indexed += rows.length;
    const up = await upsertCalls(rows);
    stats.inserted += up.inserted;
    stats.updated += up.updated;
    if (typeof opts.onPage === 'function') { try { opts.onPage(stats); } catch (e) {} }

    if (!res.marker) break;
    // A repeated marker means the API is looping us; stop rather than spin.
    if (seenMarkers[res.marker]) { stats.truncated = true; break; }
    seenMarkers[res.marker] = 1;
    marker = res.marker;
    if (page === maxPages - 1) stats.truncated = true;
    // Stay comfortably inside 10 requests/second.
    await sleep(120);
  }
  return stats;
}

// Page an arbitrary range, splitting it into GoTo-sized chunks. Walks newest
// first so a long backfill makes the most useful history available soonest, and
// so an interrupted run has still covered the recent past.
async function syncWindow(opts) {
  opts = opts || {};
  const endIso = opts.endIso || new Date().toISOString();
  if (!opts.startIso) throw new Error('syncWindow needs a startIso');
  const outerOnPage = opts.onPage;
  const start = Date.parse(opts.startIso);
  const end = Date.parse(endIso);
  if (isNaN(start) || isNaN(end) || end <= start) throw new Error('syncWindow needs a valid range');

  const total = { pages: 0, seen: 0, indexed: 0, skipped: 0, inserted: 0, updated: 0, truncated: false, windows: 0 };
  const chunkMs = MAX_WINDOW_DAYS * 86400000;
  let chunkEnd = end;

  while (chunkEnd > start) {
    const chunkStart = Math.max(start, chunkEnd - chunkMs);
    const st = await syncOneWindow({
      startIso: new Date(chunkStart).toISOString(),
      endIso: new Date(chunkEnd).toISOString(),
      maxPages: opts.maxPages,
      onPage: function (st) {
        if (typeof outerOnPage !== 'function') return;
        try {
          outerOnPage({
            pages: total.pages + st.pages, seen: total.seen + st.seen,
            indexed: total.indexed + st.indexed, skipped: total.skipped + st.skipped,
            inserted: total.inserted + st.inserted, updated: total.updated + st.updated,
            windows: total.windows, truncated: total.truncated
          });
        } catch (e) {}
      }
    });
    total.pages += st.pages;
    total.seen += st.seen;
    total.indexed += st.indexed;
    total.skipped += st.skipped;
    total.inserted += st.inserted;
    total.updated += st.updated;
    if (st.truncated) total.truncated = true;
    total.windows++;
    chunkEnd = chunkStart;
    // onPage reports per-window numbers; surface the running total instead so a
    // multi-chunk backfill does not appear to start over at each boundary.
    if (typeof opts.onPage === 'function') { try { opts.onPage(total); } catch (e) {} }
  }
  return total;
}

// A backfill of ~59,000 calls runs for minutes, which is longer than an HTTP
// request should live. It runs in the background and reports progress here
// instead, so the browser can poll and the connection dropping costs nothing.
let _backfill = { running: false, days: 0, startedAt: null, finishedAt: null, error: null, stats: null, progress: null };

function backfillState() {
  return {
    running: _backfill.running,
    days: _backfill.days,
    startedAt: _backfill.startedAt,
    finishedAt: _backfill.finishedAt,
    error: _backfill.error,
    stats: _backfill.stats,
    progress: _backfill.progress
  };
}

// Returns immediately. Refuses to start a second run on top of a live one.
function startBackfill(days) {
  if (_backfill.running) return { started: false, reason: 'already_running', state: backfillState() };
  const d = Math.min(Math.max(parseInt(days, 10) || 90, 1), 400);
  _backfill = { running: true, days: d, startedAt: new Date().toISOString(), finishedAt: null, error: null, stats: null, progress: { pages: 0, seen: 0, inserted: 0, updated: 0 } };

  // Deliberately not awaited.
  syncDays(d, {
    maxPages: 2000,
    onPage: function (st) {
      _backfill.progress = { pages: st.pages, seen: st.seen, inserted: st.inserted, updated: st.updated };
    }
  }).then(function (stats) {
    _backfill.running = false;
    _backfill.finishedAt = new Date().toISOString();
    _backfill.stats = stats;
    console.log('[goto] backfill finished: ' + stats.inserted + ' new, ' + stats.updated + ' updated, ' + stats.pages + ' pages over ' + stats.windows + ' window(s)');
  }).catch(function (e) {
    _backfill.running = false;
    _backfill.finishedAt = new Date().toISOString();
    _backfill.error = e.message;
    console.error('[goto] backfill failed:', e.message);
  });

  return { started: true, state: backfillState() };
}

// Convenience: index the last N days.
async function syncDays(days, opts) {
  const d = Math.min(Math.max(parseInt(days, 10) || 1, 1), 400);
  const end = new Date();
  const start = new Date(end.getTime() - d * 86400000);
  return syncWindow(Object.assign({ startIso: start.toISOString(), endIso: end.toISOString() }, opts || {}));
}

// Complaint lookup: every indexed call for a phone number, newest first.
// This is the whole point of the index - a plain equality hit on external_digits
// instead of paging the GoTo API.
async function callsForNumber(phone, limit) {
  const digits = normalizeDigits(phone);
  if (!digits) return [];
  const n = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const r = await pool.query(
    'SELECT id, conversation_space_id, direction, call_started_at, call_ended_at, duration_sec,' +
    ' external_number, internal_number, agent_name, recording_id, transcript_id, has_recording,' +
    ' r2_key, archived_at' +
    ' FROM goto_calls WHERE external_digits = $1 ORDER BY call_started_at DESC NULLS LAST LIMIT ' + n,
    [digits]
  );
  return r.rows;
}

// How healthy is the index? Drives the Settings panel.
async function indexStats() {
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS total,' +
      ' COUNT(*) FILTER (WHERE has_recording)::int AS with_recording,' +
      ' COUNT(*) FILTER (WHERE r2_key IS NOT NULL)::int AS archived,' +
      ' MIN(call_started_at) AS oldest, MAX(call_started_at) AS newest,' +
      ' MAX(last_seen_revision) AS last_sync FROM goto_calls'
    );
    return r.rows[0];
  } catch (e) {
    return { total: 0, with_recording: 0, archived: 0, oldest: null, newest: null, last_sync: null, error: e.message };
  }
}

// ---- Call-search probe -----------------------------------------------------
// Four things about the Call Events Report API are undocumented and its OpenAPI
// reference is a JavaScript app we cannot read: the phone-number filter's
// parameter name, the pagination model, the shape of the participant object,
// and where the customer's number actually sits. Guessing costs a deploy each
// time. This asks the live account instead.
//
// PRIVACY: this returns a SCHEMA, not data. Every string value is replaced by
// its type and length before it leaves the server, because the caller is going
// to paste the output into a chat window and these are real customer calls.
// Only a short allow-list of structural, non-identifying fields keeps its value.

const REPORT_BASE = 'https://api.goto.com/call-events-report/v1';

// GoTo's guide says summaries "can be searched using either accounts, lines,
// phone numbers or users" but never names the parameter. These are the plausible
// spellings; the probe reports which are accepted and which change the result.
const PHONE_PARAM_CANDIDATES = [
  'phoneNumber', 'phoneNumbers', 'number', 'numbers', 'e164',
  'participantNumber', 'externalNumber', 'phone', 'callerNumber', 'did', 'line'
];

// Safe to echo verbatim: structural or already known to us, never identifying.
const SAFE_KEYS = {
  direction: 1, callCreated: 1, callEnded: 1, pageSize: 1, totalCount: 1,
  total: 1, count: 1, nextPageToken: 1, nextPage: 1, cursor: 1, offset: 1,
  hasMore: 1, type: 1, state: 1, status: 1, reason: 1, disposition: 1,
  startTime: 1, endTime: 1, duration: 1, durationMs: 1, mimeType: 1, format: 1,
  // Enums, not identities. Knowing that a participant's type is LINE vs
  // EXTERNAL_USER is exactly how we tell our own staff from the customer, and
  // it says nothing about who the customer is.
  callInitiator: 1, callerOutcome: 1, sentiment: 1, queueType: 1,
  leftQueueReason: 1, callProvider: 1, callbackOffered: 1, transcriptEnabled: 1,
  postCallTranscriptEnabled: 1, sequenceNumber: 1, callerWaitDuration: 1
};

// "value" is an enum under type/status, but it is also where GoTo hides the
// account key in a SCIM record. Only echo it when its parent makes it a type.
const SAFE_VALUE_PARENTS = { type: 1, status: 1 };

function shapeOf(v, key, depth, parentKey) {
  depth = depth || 0;
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'boolean') return 'boolean:' + v;
  if (t === 'number') return 'number:' + v;
  if (t === 'string') {
    const safe = SAFE_KEYS[key] || (key === 'value' && SAFE_VALUE_PARENTS[parentKey]);
    if (safe) return 'string:' + v.slice(0, 40);
    // Shape only. Note the pattern so we can tell a UUID from an E.164 number
    // from a name without ever revealing which customer it was.
    let pattern = 'text';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) pattern = 'uuid';
    else if (/^\+?[0-9]{7,15}$/.test(v)) pattern = 'phone-like';
    else if (/^[0-9]{4,}$/.test(v)) pattern = 'digits';
    else if (/^\d{4}-\d{2}-\d{2}T/.test(v)) pattern = 'iso-datetime';
    else if (/@/.test(v)) pattern = 'email-like';
    else if (/^https?:\/\//.test(v)) pattern = 'url';
    return 'string<' + pattern + ',len=' + v.length + '>';
  }
  if (Array.isArray(v)) {
    if (!v.length) return 'array[0]';
    if (depth > 5) return 'array[' + v.length + ']';
    return { _array: v.length, _first: shapeOf(v[0], key, depth + 1, parentKey) };
  }
  if (t === 'object') {
    if (depth > 5) return 'object';
    const out = {};
    Object.keys(v).slice(0, 40).forEach(function (k) { out[k] = shapeOf(v[k], k, depth + 1, key); });
    return out;
  }
  return t;
}

// Probe the call search. opts: { days, digits }
async function probeCallSearch(opts) {
  opts = opts || {};
  const acct = await resolveAccountKey();
  const result = { accountKey: acct ? 'set' : 'MISSING', steps: [] };
  if (!acct) {
    result.steps.push({ step: 'accountKey', ok: false, note: 'No account key stored. Set it in Settings > Integrations first.' });
    return result;
  }

  // Same 31-day ceiling as the indexer; a wider probe just gets a 400.
  const days = Math.min(Math.max(parseInt(opts.days, 10) || 7, 1), MAX_WINDOW_DAYS);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const baseParams = new URLSearchParams();
  baseParams.set('accountKey', acct);
  baseParams.set('startTime', start.toISOString());
  baseParams.set('endTime', end.toISOString());

  // --- 1. does the endpoint work at all, and what does it return? -----------
  const summaryUrl = REPORT_BASE + '/report-summaries?' + baseParams.toString();
  let summary = null;
  const s1 = { step: 'report-summaries', url: summaryUrl.replace(acct, '<accountKey>'), ok: false };
  try {
    const resp = await fetch(summaryUrl, { headers: { Authorization: 'Bearer ' + (await getAccessToken()), Accept: 'application/json' } });
    s1.status = resp.status;
    const text = await resp.text();
    s1.ok = resp.ok;
    if (resp.ok) {
      try { summary = JSON.parse(text); } catch (e) { summary = null; }
      s1.itemCount = summary && Array.isArray(summary.items) ? summary.items.length : null;
      s1.responseShape = shapeOf(summary);
      // Which top-level keys look like pagination?
      s1.paginationKeys = summary ? Object.keys(summary).filter(function (k) {
        return /page|cursor|offset|next|total|more/i.test(k);
      }) : [];
    } else {
      s1.body = text.slice(0, 400);
    }
  } catch (e) { s1.note = 'threw: ' + e.message; }
  result.steps.push(s1);
  if (!s1.ok) return result;

  // --- 2. which phone-filter parameter does it accept? ----------------------
  const digits = normalizeDigits(opts.digits);
  const s2 = { step: 'phone-filter', testedWith: digits ? 'a 10-digit number' : 'SKIPPED (no valid number supplied)', candidates: [] };
  if (digits) {
    const baseline = s1.itemCount;
    for (let i = 0; i < PHONE_PARAM_CANDIDATES.length; i++) {
      const name = PHONE_PARAM_CANDIDATES[i];
      const p = new URLSearchParams(baseParams.toString());
      p.set(name, digits);
      const entry = { param: name };
      try {
        const resp = await fetch(REPORT_BASE + '/report-summaries?' + p.toString(), {
          headers: { Authorization: 'Bearer ' + (await getAccessToken()), Accept: 'application/json' }
        });
        entry.status = resp.status;
        const text = await resp.text();
        if (resp.ok) {
          let j = null;
          try { j = JSON.parse(text); } catch (e) {}
          entry.itemCount = j && Array.isArray(j.items) ? j.items.length : null;
          // An unknown query param is usually IGNORED, so an unchanged count
          // means "not a real filter". A changed count means it did something.
          entry.filtered = (entry.itemCount !== null && baseline !== null && entry.itemCount !== baseline);
          entry.verdict = entry.filtered ? 'FILTERS (count changed from ' + baseline + ' to ' + entry.itemCount + ')' : 'ignored (count unchanged)';
        } else {
          entry.verdict = 'rejected';
          entry.body = text.slice(0, 200);
        }
      } catch (e) { entry.verdict = 'threw: ' + e.message; }
      s2.candidates.push(entry);
      await sleep(120); // stay well under 10 req/sec
    }
  }
  result.steps.push(s2);

  // --- 3. the full report: participants, and where the recording id lives ---
  const s3 = { step: 'report-detail', ok: false };
  const firstId = summary && Array.isArray(summary.items) && summary.items.length ? summary.items[0].conversationSpaceId : null;
  if (!firstId) {
    s3.note = 'No calls in the last ' + days + ' days to inspect. Try a longer window.';
  } else {
    try {
      const resp = await fetch(REPORT_BASE + '/reports/' + encodeURIComponent(firstId), {
        headers: { Authorization: 'Bearer ' + (await getAccessToken()), Accept: 'application/json' }
      });
      s3.status = resp.status;
      const text = await resp.text();
      s3.ok = resp.ok;
      if (resp.ok) {
        let j = null;
        try { j = JSON.parse(text); } catch (e) {}
        s3.reportShape = shapeOf(j);
        // Where does anything recording-shaped appear?
        const hits = [];
        (function walk(node, path, depth) {
          if (!node || typeof node !== 'object' || depth > 6) return;
          Object.keys(node).forEach(function (k) {
            if (/record|transcri/i.test(k)) hits.push(path + '.' + k);
            walk(node[k], path + '.' + k, depth + 1);
          });
        })(j, '$', 0);
        s3.recordingPaths = hits.slice(0, 20);
      } else {
        s3.body = text.slice(0, 400);
      }
    } catch (e) { s3.note = 'threw: ' + e.message; }
  }
  result.steps.push(s3);
  return result;
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
  probeCallSearch: probeCallSearch,
  mapSummaryItem: mapSummaryItem,
  redactRaw: redactRaw,
  upsertCalls: upsertCalls,
  fetchSummaryPage: fetchSummaryPage,
  syncWindow: syncWindow,
  syncOneWindow: syncOneWindow,
  MAX_WINDOW_DAYS: MAX_WINDOW_DAYS,
  syncDays: syncDays,
  startBackfill: startBackfill,
  backfillState: backfillState,
  callsForNumber: callsForNumber,
  fetchRecordingBytes: fetchRecordingBytes,
  archiveCall: archiveCall,
  playbackUrl: playbackUrl,
  extForMime: extForMime,
  indexStats: indexStats,
  shapeOf: shapeOf,
  findAccountKey: findAccountKey,
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
