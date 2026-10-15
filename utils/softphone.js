// Answer GoTo calls inside Nova (Tony 2026-10-14: "build it"). PILOT.
//
// GoTo's Devices and Calls API (developer.goto.com guide 17, "Make and Receive
// Calls using the Devices and Calls API") lets an app register itself as a
// WebRTC phone on a GoTo extension:
//   1. a notification channel (webhook) for this dispatcher,
//   2. POST {web-calls}/devices        (callbackReference -> that channel),
//   3. POST {web-calls}/devices/{id}/extensions  (organizationId + extension),
//   4. GoTo sends "greetings", then "incoming" { callId, name, number } when the
//      extension rings, and "ended" when a call finishes,
//   5. answer with the browser's SDP, reject (send to voicemail), hang up.
// The browser owns the audio (RTCPeerConnection); this server only carries the
// signalling, with the DISPATCHER'S OWN GoTo token (each person connects once).
//
// The guide links the answer / reject operations without printing their paths,
// so the calls below try the likely REST shapes in order and remember the one
// GoTo accepts (only on 404 / 405, never on a real refusal). Every GoTo error is
// kept on the person's row so the pilot shows exactly what GoTo said.
//
// No backticks anywhere in this file (Windows corrupts them in .js).

const crypto = require('crypto');
const { pool } = require('../db');

const AUTHORIZE_URL = 'https://authentication.logmeininc.com/oauth/authorize';
const TOKEN_URL = 'https://authentication.logmeininc.com/oauth/token';
const NOTIFY = 'https://api.goto.com/notification-channel/v1';
function webBase() { return (process.env.GOTO_WEBRTC_BASE || 'https://webrtc.jive.com/web-calls/v1').replace(/\/+$/, ''); }
function scopes() { return (process.env.GOTO_SOFTPHONE_SCOPES || 'webrtc.v1.read webrtc.v1.write').trim(); }
function clientId() { return (process.env.GOTO_CLIENT_ID || '').trim(); }
function clientSecret() { return (process.env.GOTO_CLIENT_SECRET || '').trim(); }
function redirectUri() { return (process.env.GOTO_REDIRECT_URI || '').trim(); }
function configured() { return !!(clientId() && clientSecret() && redirectUri()); }
function appUrl() { return String(process.env.APP_URL || '').replace(/\/+$/, ''); }

// ---- encryption (same scheme and key precedence as utils/goto.js) ----------
function encKey() {
  const raw = (process.env.GOTO_TOKEN_KEY || process.env.HR_DOC_ENC_KEY || process.env.JWT_SECRET || '').trim();
  if (!raw) return null;
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) return b; } catch (e) {}
  try { const h = Buffer.from(raw, 'hex'); if (h.length === 32) return h; } catch (e) {}
  return crypto.createHash('sha256').update('nova-goto-token-v1:' + raw).digest();
}
function enc(s) {
  if (!s) return null;
  const key = encKey(); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const e = Buffer.concat([c.update(String(s), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), e]).toString('base64');
}
function dec(b64) {
  if (!b64) return null;
  try {
    const p = Buffer.from(String(b64), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), p.subarray(0, 12));
    d.setAuthTag(p.subarray(12, 28));
    return Buffer.concat([d.update(p.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ---- OAuth state: "sp" marks a softphone connect so the shared GoTo callback
// (routes/goto.js) knows which flow it is finishing.
function secret() { return process.env.JWT_SECRET || 'nova-goto-state'; }
function makeState(userId) {
  const body = 'sp.' + (parseInt(userId, 10) || 0) + '.' + Date.now() + '.' + crypto.randomBytes(8).toString('hex');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('hex').slice(0, 32);
  return Buffer.from(body + '.' + sig, 'utf8').toString('base64url');
}
function readState(state) {
  try {
    const parts = Buffer.from(String(state || ''), 'base64url').toString('utf8').split('.');
    if (parts.length !== 5 || parts[0] !== 'sp') return { ok: false };
    const body = parts.slice(0, 4).join('.');
    const want = crypto.createHmac('sha256', secret()).update(body).digest('hex').slice(0, 32);
    if (want.length !== parts[4].length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(parts[4]))) return { ok: false };
    if (Date.now() - (parseInt(parts[2], 10) || 0) > 15 * 60000) return { ok: false };
    return { ok: true, userId: parseInt(parts[1], 10) || 0 };
  } catch (e) { return { ok: false }; }
}
function isState(state) {
  try { return Buffer.from(String(state || ''), 'base64url').toString('utf8').indexOf('sp.') === 0; } catch (e) { return false; }
}
function authorizeUrl(userId) {
  const p = new URLSearchParams();
  p.set('client_id', clientId()); p.set('response_type', 'code'); p.set('redirect_uri', redirectUri());
  p.set('scope', scopes()); p.set('state', makeState(userId));
  return AUTHORIZE_URL + '?' + p.toString();
}

async function row(userId) {
  const r = await pool.query('SELECT * FROM goto_user_phones WHERE user_id = $1', [userId]);
  return r.rows[0] || null;
}
async function patch(userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const vals = keys.map(function (k) { return fields[k]; });
  await pool.query(
    'INSERT INTO goto_user_phones (user_id, ' + keys.join(', ') + ', updated_at) VALUES ($1, ' +
    keys.map(function (k, i) { return '$' + (i + 2); }).join(', ') + ', NOW()) ON CONFLICT (user_id) DO UPDATE SET ' +
    keys.map(function (k, i) { return k + ' = $' + (i + 2); }).join(', ') + ', updated_at = NOW()', [userId].concat(vals));
}
async function noteError(userId, msg) {
  try { await patch(userId, { last_error: String(msg || '').slice(0, 1500), last_error_at: new Date() }); } catch (e) {}
}

async function postToken(form) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(clientId() + ':' + clientSecret()).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString()
  });
  var data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok || !data.access_token) throw new Error('GoTo sign-in failed: ' + ((data && (data.error_description || data.error)) || ('HTTP ' + r.status)));
  return data;
}
async function exchangeCode(code, userId) {
  const f = new URLSearchParams();
  f.set('grant_type', 'authorization_code'); f.set('code', code); f.set('redirect_uri', redirectUri());
  const d = await postToken(f);
  await patch(userId, { access_enc: enc(d.access_token), refresh_enc: enc(d.refresh_token || ''),
    expires_at: new Date(Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000), scope: d.scope || scopes(),
    connected_at: new Date(), last_error: null });
}
async function token(userId) {
  const r = await row(userId);
  if (!r || !r.access_enc) throw new Error('Connect your GoTo account first.');
  if (r.expires_at && new Date(r.expires_at).getTime() - Date.now() > 5 * 60000) {
    const t = dec(r.access_enc);
    if (t) return t;
  }
  const refreshTok = dec(r.refresh_enc);
  if (!refreshTok) throw new Error('Your GoTo sign-in expired. Connect GoTo again.');
  const f = new URLSearchParams();
  f.set('grant_type', 'refresh_token'); f.set('refresh_token', refreshTok);
  const d = await postToken(f);
  await patch(userId, { access_enc: enc(d.access_token), refresh_enc: d.refresh_token ? enc(d.refresh_token) : r.refresh_enc,
    expires_at: new Date(Date.now() + (parseInt(d.expires_in, 10) || 3600) * 1000) });
  return d.access_token;
}

// One GoTo request with this dispatcher's token. Throws with GoTo's own words.
async function call(userId, method, url, body) {
  const t = await token(userId);
  const r = await fetch(url, { method: method,
    headers: { Authorization: 'Bearer ' + t, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  var text = '';
  try { text = await r.text(); } catch (e) {}
  var data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) {
    const err = new Error('GoTo ' + r.status + ' on ' + method + ' ' + url.replace(webBase(), '{web-calls}') + ': ' + text.slice(0, 400));
    err.status = r.status;
    throw err;
  }
  return data;
}
// Try the likely shapes of an operation the guide does not print; remember the
// winner. Only "no such endpoint" moves on to the next shape.
async function callVariants(userId, opKey, variants, body) {
  var known = null;
  try { const s = await pool.query('SELECT value FROM settings WHERE key = $1', ['softphone_path_' + opKey]); known = s.rows.length ? s.rows[0].value : null; } catch (e) {}
  if (known) {
    const k = variants.filter(function (v) { return v[0] + ' ' + v[1] === known; })[0];
    if (k) variants = [k].concat(variants.filter(function (v) { return v !== k; }));
  }
  var last = null;
  for (const v of variants) {
    try {
      const out = await call(userId, v[0], webBase() + v[1], body);
      if (known !== v[0] + ' ' + v[1]) {
        try { await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ['softphone_path_' + opKey, v[0] + ' ' + v[1]]); } catch (e) {}
      }
      return out;
    } catch (e) {
      last = e;
      if (e.status !== 404 && e.status !== 405) throw e;
    }
  }
  throw last || new Error('GoTo did not accept any form of ' + opKey);
}

function hookSecret(userId) {
  return crypto.createHmac('sha256', secret()).update('softphone-hook:' + userId).digest('hex').slice(0, 32);
}
function hookUrl(userId) { return appUrl() + '/api/softphone/hook/' + userId + '/' + hookSecret(userId); }

// Turn the phone on: channel, device, extension. Safe to repeat (re-registers).
async function register(userId) {
  const r = await row(userId);
  if (!r || !r.access_enc) throw new Error('Connect your GoTo account first.');
  if (!r.extension) throw new Error('Enter your GoTo extension first.');
  if (!/^https:\/\//.test(appUrl())) throw new Error('APP_URL must be set to the https address of Nova.');
  const goto = require('./goto');
  const org = await goto.resolveOrgId();
  if (!org) throw new Error('No GoTo organization id. Connect GoTo in Settings, Integrations first.');
  try {
    // 1. channel
    const ch = await call(userId, 'POST', NOTIFY + '/channels/' + encodeURIComponent('nova-phone-' + userId), {
      channelType: 'Webhook', webhookChannelData: { webhook: { url: hookUrl(userId) } } });
    const channelId = ch.channelId || ch.id;
    if (!channelId) throw new Error('GoTo did not return a channel id.');
    // 2. device (we choose the device id)
    const deviceId = r.device_id || ('nova-' + userId + '-' + crypto.randomBytes(4).toString('hex'));
    await callVariants(userId, 'device', [['POST', '/devices']], {
      clientInformation: { deviceId: deviceId, appId: 'nova', appVersion: '1', platform: 'WEB' },
      callbackReference: { incomingCallChannelId: channelId, sessionManagementChannelId: channelId } });
    // 3. extension
    const ex = await call(userId, 'POST', webBase() + '/devices/' + encodeURIComponent(deviceId) + '/extensions', {
      organizationId: String(org), extensions: [{ number: String(r.extension) }] });
    const e0 = ex && Array.isArray(ex.extensions) ? ex.extensions[0] : null;
    if (e0 && e0.resultCode && Number(e0.resultCode) >= 400) throw new Error('GoTo refused extension ' + r.extension + ' (code ' + e0.resultCode + ').');
    await patch(userId, { channel_id: String(channelId), device_id: deviceId, organization_id: String(org),
      session_id: e0 && e0.sessionId ? String(e0.sessionId) : null, registered_at: new Date(), last_error: null });
    return { ok: true, extension: r.extension };
  } catch (e) { await noteError(userId, e.message); throw e; }
}

// ---- events from GoTo, held for the browser's long poll --------------------
async function ingest(userId, payload) {
  const items = Array.isArray(payload) ? payload : [payload];
  for (const p of items) {
    const n = (p && (p.type || (p.data && p.data.type))) ? p : (p && p.data) || p;
    const type = String((n && n.type) || '').toLowerCase();
    const content = (n && n.content) || {};
    if (!type) continue;
    await pool.query('INSERT INTO softphone_events (user_id, type, call_id, content) VALUES ($1,$2,$3,$4)',
      [userId, type.slice(0, 32), content.callId ? String(content.callId).slice(0, 128) : null, JSON.stringify(content).slice(0, 8000)]);
    if (type === 'greetings') await patch(userId, { greeted_at: new Date() });
  }
  try { await pool.query("DELETE FROM softphone_events WHERE at < NOW() - INTERVAL '2 hours'"); } catch (e) {}
}
async function events(userId, after, waitMs) {
  const until = Date.now() + Math.min(25000, Math.max(0, waitMs || 0));
  for (;;) {
    const r = await pool.query('SELECT id, type, call_id, content, at FROM softphone_events WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT 20',
      [userId, parseInt(after, 10) || 0]);
    if (r.rows.length || Date.now() >= until) {
      return r.rows.map(function (x) {
        var c = {}; try { c = typeof x.content === 'string' ? JSON.parse(x.content) : (x.content || {}); } catch (e) {}
        return { id: Number(x.id), type: x.type, call_id: x.call_id, name: c.name || null, number: c.number || null,
          reason: c.reasonCode || null, at: x.at };
      });
    }
    await new Promise(function (res) { setTimeout(res, 700); });
  }
}
async function ownsCall(userId, callId) {
  const r = await pool.query("SELECT 1 FROM softphone_events WHERE user_id = $1 AND call_id = $2 LIMIT 1", [userId, String(callId)]);
  return r.rows.length > 0;
}

async function answer(userId, callId, sdp) {
  const r = await row(userId);
  if (!(await ownsCall(userId, callId))) throw new Error('That call did not ring on your phone.');
  const id = encodeURIComponent(callId);
  try {
    const out = await callVariants(userId, 'answer', [['POST', '/calls/' + id + '/answer'], ['PUT', '/calls/' + id + '/answer'], ['POST', '/calls/' + id + '/answers']],
      { dialString: r.extension ? String(r.extension) : undefined, sdp: sdp, inCallChannelId: r.channel_id });
    return { sdp: out.sdp || (out.answer && out.answer.sdp) || null, status: out.status || null };
  } catch (e) { await noteError(userId, e.message); throw e; }
}
async function reject(userId, callId) {
  if (!(await ownsCall(userId, callId))) throw new Error('That call did not ring on your phone.');
  const id = encodeURIComponent(callId);
  try { await callVariants(userId, 'reject', [['POST', '/calls/' + id + '/reject'], ['PUT', '/calls/' + id + '/reject']], { action: 'SEND_TO_VOICEMAIL' }); }
  catch (e) { await noteError(userId, e.message); throw e; }
}
async function hangup(userId, callId) {
  if (!(await ownsCall(userId, callId))) throw new Error('That call is not yours.');
  const id = encodeURIComponent(callId);
  try { await callVariants(userId, 'hangup', [['DELETE', '/calls/' + id], ['POST', '/calls/' + id + '/hangup'], ['POST', '/calls/' + id + '/terminate']]); }
  catch (e) { if (e.status !== 404) { await noteError(userId, e.message); throw e; } }
}

async function status(userId) {
  const r = await row(userId);
  return {
    configured: configured(), connected: !!(r && r.access_enc), extension: r ? r.extension : null,
    registered_at: r ? r.registered_at : null, greeted_at: r ? r.greeted_at : null,
    last_error: r ? r.last_error : null, last_error_at: r ? r.last_error_at : null, app_url_ok: /^https:\/\//.test(appUrl())
  };
}
async function disconnect(userId) {
  await pool.query('DELETE FROM goto_user_phones WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM softphone_events WHERE user_id = $1', [userId]);
}

module.exports = { configured: configured, authorizeUrl: authorizeUrl, isState: isState, readState: readState, exchangeCode: exchangeCode,
  register: register, ingest: ingest, events: events, answer: answer, reject: reject, hangup: hangup, status: status,
  disconnect: disconnect, hookSecret: hookSecret, patch: patch, _enc: enc, _dec: dec };
