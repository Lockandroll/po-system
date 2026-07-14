const { pool } = require('../db');

// Minimum client version enforcement.
//
// Normally a new deploy lands quietly: the service worker picks it up and the user
// sees a "new version available" prompt. But when a deploy is backward-INcompatible
// (the old front-end would break against the new API), asking nicely is not enough.
//
// An admin sets the settings key client_min_version to the version number that
// clients must be at or above (e.g. "162" — matching CACHE_VERSION 'nova-v162' in
// public/sw.js). Every authenticated response then carries an X-Min-Version header.
// Any client running below it clears its caches, unregisters its service worker and
// reloads — WITHOUT logging the user out.
//
// This is a blunt instrument: it reloads every open Nova tab in the company, including
// someone halfway through an invoice. Bump CACHE_VERSION every deploy; raise
// client_min_version only when an old client is genuinely broken.

var cached = null;
var cachedAt = 0;
var TTL_MS = 30000;

async function minVersion() {
  if (cached !== null && (Date.now() - cachedAt) < TTL_MS) return cached;
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'client_min_version'");
    var v = (rows.length && rows[0].value != null) ? String(rows[0].value).trim() : '';
    // Only ever emit a plain integer; anything else is treated as unset so a typo in
    // the settings screen can't lock the whole company into a reload loop.
    cached = /^\d+$/.test(v) ? v : '';
  } catch (e) {
    cached = '';
  }
  cachedAt = Date.now();
  return cached;
}

// Let a settings write take effect immediately rather than waiting out the TTL.
function bust() {
  cached = null;
  cachedAt = 0;
}

module.exports = { minVersion: minVersion, bust: bust };
