// utils/fcm.js
// Firebase Cloud Messaging (HTTP v1) for the Nova Android app.
//
// WHY THIS EXISTS: utils/push.js sends browser Web Push. A browser tab gets it;
// the Nova Android app does not, because the app is a WebView and Android
// WebViews have no Web Push at all. So a tech with the app closed got nothing
// when a call was assigned. This file reaches the phone app the way every
// native app is reached: through Firebase. (Tony, 2026-10-13: native phone
// alerts come first, because AI dispatch is useless if the tech never hears it.)
//
// SHIPS INERT. Nothing here does anything until FIREBASE_SERVICE_ACCOUNT is set
// in Railway (the JSON key of a Firebase service account, pasted as-is or
// base64-encoded). Without it isReady() is false, the phone app is told not to
// register, and push.js only sends browser push exactly as before.
//
// No new npm dependency: the OAuth token is a JWT signed with Node's own crypto
// and traded for an access token, which is all firebase-admin does for this.
//
// No backticks in this file (Windows clipboard safety).

'use strict';

const crypto = require('crypto');
const { pool } = require('../db');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

var _cfg;           // parsed service account, null = not configured, undefined = not read yet
var _access = null; // { token, exp }

function config() {
  if (_cfg !== undefined) return _cfg;
  _cfg = null;
  var raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!raw) return _cfg;
  try {
    raw = String(raw).trim();
    if (raw.charAt(0) !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');
    const j = JSON.parse(raw);
    if (j && j.project_id && j.client_email && j.private_key) {
      _cfg = { projectId: j.project_id, email: j.client_email,
        key: String(j.private_key).replace(/\\n/g, '\n') };
    } else {
      console.error('FCM: FIREBASE_SERVICE_ACCOUNT is missing project_id, client_email or private_key');
    }
  } catch (e) {
    console.error('FCM: FIREBASE_SERVICE_ACCOUNT could not be read: ' + e.message);
  }
  return _cfg;
}

function isReady() { return !!config(); }

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function accessToken() {
  const c = config();
  if (!c) return null;
  const now = Math.floor(Date.now() / 1000);
  if (_access && _access.exp - 120 > now) return _access.token;
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: c.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(head + '.' + claims);
  const jwt = head + '.' + claims + '.' + b64url(signer.sign(c.key));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(jwt)
  });
  if (!res.ok) throw new Error('FCM token ' + res.status);
  const j = await res.json();
  _access = { token: j.access_token, exp: now + (parseInt(j.expires_in, 10) || 3600) };
  return _access.token;
}

// Android notification channels. The app creates both on start (public/js/native.js);
// 'calls' is the loud one a tech can tell apart from a memo without looking.
const CHANNELS = { calls: 'nova_calls', general: 'nova_general' };

function buildMessage(token, payload) {
  const p = payload || {};
  const channel = CHANNELS[p.channel] || CHANNELS.general;
  const urgent = p.channel === 'calls';
  const data = { url: String(p.url || '/'), tag: String(p.tag || ''), channel: String(p.channel || 'general') };
  return {
    message: {
      token: token,
      notification: { title: String(p.title || 'Nova'), body: String(p.body || '') },
      data: data,
      android: {
        priority: 'HIGH',
        ttl: urgent ? '300s' : '86400s',
        notification: {
          channel_id: channel,
          tag: p.tag ? String(p.tag) : undefined,
          sound: 'default',
          default_vibrate_timings: true,
          notification_priority: urgent ? 'PRIORITY_MAX' : 'PRIORITY_DEFAULT',
          visibility: 'PUBLIC'
        }
      }
    }
  };
}

// Send to every app token the given users have. Prunes tokens Firebase says are
// dead. Never throws: a push failing must never fail the request that caused it.
async function sendToUsers(userIds, payload) {
  if (!isReady()) return 0;
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!ids.length) return 0;
  var rows;
  try {
    rows = (await pool.query('SELECT id, token FROM push_native_tokens WHERE user_id = ANY($1::int[])', [ids])).rows;
  } catch (e) { console.error('FCM: load tokens failed: ' + e.message); return 0; }
  if (!rows.length) return 0;
  var bearer;
  try { bearer = await accessToken(); }
  catch (e) { console.error('FCM: ' + e.message); return 0; }
  if (!bearer) return 0;
  const url = 'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(config().projectId) + '/messages:send';
  var sent = 0;
  for (const r of rows) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMessage(r.token, payload))
      });
      if (res.ok) { sent++; continue; }
      var body = '';
      try { body = await res.text(); } catch (e) {}
      // 404 / UNREGISTERED = the app was uninstalled or the token rotated.
      if (res.status === 404 || body.indexOf('UNREGISTERED') !== -1 || body.indexOf('INVALID_ARGUMENT') !== -1) {
        try { await pool.query('DELETE FROM push_native_tokens WHERE id = $1', [r.id]); } catch (e) {}
      } else {
        console.error('FCM send failed: ' + res.status + ' ' + body.slice(0, 200));
      }
    } catch (e) { console.error('FCM send failed: ' + e.message); }
  }
  return sent;
}

async function registerToken(userId, token, platform) {
  const t = String(token || '').trim();
  if (!t || t.length < 20 || t.length > 4096) return false;
  const pf = ['android', 'ios'].indexOf(String(platform || '').toLowerCase()) !== -1 ? String(platform).toLowerCase() : 'android';
  await pool.query(
    'INSERT INTO push_native_tokens (user_id, token, platform) VALUES ($1, $2, $3) ' +
    'ON CONFLICT (token) DO UPDATE SET user_id = $1, platform = $3, last_seen_at = NOW()',
    [userId, t, pf]);
  return true;
}

async function unregisterToken(token) {
  if (!token) return;
  await pool.query('DELETE FROM push_native_tokens WHERE token = $1', [String(token)]);
}

module.exports = {
  isReady: isReady,
  sendToUsers: sendToUsers,
  registerToken: registerToken,
  unregisterToken: unregisterToken,
  buildMessage: buildMessage,
  CHANNELS: CHANNELS,
  _reset: function () { _cfg = undefined; _access = null; }
};
