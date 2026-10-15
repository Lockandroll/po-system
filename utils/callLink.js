// Customer call link (/c/<token>) + customer-facing employee photos.
// Plan: claude/nova-dispatch-new-call-plan.md, step 4 (Tony, 2026-10-13).
//
// Ships dark: nothing is texted unless the setting dispatch_customer_link is '1',
// and the onboarding photo gate only bites when onboarding_require_customer_photos
// is '1'. Both default off.
//
// No backticks anywhere in this file (Windows corrupts them in .js).

const crypto = require('crypto');
const { pool } = require('../db');
const r2 = require('./r2');

const PHOTO_SLOTS = ['tech', 'vehicle'];
// Calls the customer can still change or cancel. Once the tech is on scene the
// details are being worked on in person (Tony: lock edits and cancel on scene).
// 'scheduled' = booked for later (Tony 2026-10-15): the customer can still fix
// details or cancel, and the page shows the appointment instead of minutes.
const CUSTOMER_EDITABLE = ['scheduled', 'new', 'assigned', 'accepted', 'enroute'];
const OPEN = ['scheduled', 'new', 'assigned', 'accepted', 'enroute', 'onscene'];
// The tech's photo shows once someone has acknowledged the call, not while it
// might still be handed to somebody else.
const SHOW_TECH = ['accepted', 'enroute', 'onscene'];

async function getSetting(key, dflt) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows.length && r.rows[0].value !== null ? String(r.rows[0].value) : dflt;
  } catch (e) { return dflt; }
}
async function linkEnabled() { return (await getSetting('dispatch_customer_link', '0')) === '1'; }
async function photosRequired() { return (await getSetting('onboarding_require_customer_photos', '0')) === '1'; }
async function photoRoles() {
  const v = await getSetting('customer_photo_roles', 'locksmith,roadside_technician');
  return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function newToken() { return crypto.randomBytes(24).toString('base64url'); }
function baseUrl() { return String(process.env.APP_URL || '').replace(/\/+$/, ''); }
function linkUrl(token) { return baseUrl() + '/c/' + token; }

// The token is minted once per call and never changes, so a resend points at
// the same page.
async function ensureToken(jobId) {
  const cur = await pool.query('SELECT customer_token FROM dispatch_jobs WHERE id = $1', [jobId]);
  if (!cur.rows.length) return null;
  if (cur.rows[0].customer_token) return cur.rows[0].customer_token;
  for (var i = 0; i < 3; i++) {
    const t = newToken();
    try {
      const r = await pool.query(
        'UPDATE dispatch_jobs SET customer_token = $1 WHERE id = $2 AND customer_token IS NULL RETURNING customer_token', [t, jobId]);
      if (r.rows.length) return r.rows[0].customer_token;
      const again = await pool.query('SELECT customer_token FROM dispatch_jobs WHERE id = $1', [jobId]);
      return again.rows[0].customer_token;
    } catch (e) { if (i === 2) throw e; }
  }
  return null;
}

function e164(phone) {
  const d = String(phone || '').replace(/[^0-9]/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
  return null;
}

function whenLabel(at, tz) {
  try {
    return new Date(at).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return new Date(at).toISOString(); }
}

// Texts the link. Returns { ok, url, error }. Never throws for expected cases.
async function sendLink(jobId) {
  const r = await pool.query(
    'SELECT j.id, j.job_number, j.callback_phone, j.customer_phone, j.status, j.scheduled_for, c.timezone ' +
    'FROM dispatch_jobs j LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) WHERE j.id = $1', [jobId]);
  if (!r.rows.length) return { ok: false, error: 'Call not found.' };
  const j = r.rows[0];
  if (OPEN.indexOf(j.status) === -1) return { ok: false, error: 'This call is closed.' };
  const to = e164(j.callback_phone || j.customer_phone);
  if (!to) return { ok: false, error: 'No usable callback number on this call.' };
  const token = await ensureToken(j.id);
  const url = linkUrl(token);
  const brand = await getSetting('company_name', 'Pop-A-Lock');
  var msg = brand + ': we have your service call ' + (j.job_number || '') +
    '. Track your technician, fix your details or add your ID here: ' + url;
  if (j.status === 'scheduled' && j.scheduled_for) {
    msg = brand + ': your appointment ' + (j.job_number || '') + ' is booked for ' + whenLabel(j.scheduled_for, j.timezone) +
      '. See it, fix your details or add your ID here: ' + url;
  }
  var res;
  try { res = await require('./sms').sendSmsDetailed(to, msg); }
  catch (e) { res = { ok: false, error: e.message }; }
  if (res && res.ok) {
    await pool.query('UPDATE dispatch_jobs SET customer_link_sent_at = NOW() WHERE id = $1', [j.id]);
  }
  return { ok: !!(res && res.ok), url: url, error: res && res.error ? res.error : null };
}

// A data: URL from the browser into private R2. Same rules as the invoice ID
// photo (routes/invoices.js storeIdImage): images only, 12 MB cap.
async function storeDataUrl(prefix, dataUrl) {
  if (!r2.configured()) return { error: 'Photo storage is not set up yet (R2).' };
  const m = /^data:([^;]+);base64,(.*)$/i.exec(String(dataUrl || ''));
  if (!m) return { error: 'That did not look like a photo.' };
  const mime = m[1].toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(mime)) return { error: 'Please use a photo (JPG or PNG).' };
  var buf;
  try { buf = Buffer.from(m[2], 'base64'); } catch (e) { return { error: 'That photo could not be read.' }; }
  if (!buf || !buf.length) return { error: 'That photo was empty.' };
  if (buf.length > 12 * 1024 * 1024) return { error: 'That photo is too large (12 MB max).' };
  const ext = mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg');
  const key = prefix + '/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
  await r2.putObject(key, buf, mime);
  return { key: key, mime: mime };
}

async function photosFor(userId) {
  const out = { tech: null, vehicle: null };
  if (!userId) return out;
  const r = await pool.query('SELECT slot, uploaded_at FROM employee_photos WHERE user_id = $1', [userId]);
  r.rows.forEach(function (p) { if (PHOTO_SLOTS.indexOf(p.slot) !== -1) out[p.slot] = p.uploaded_at; });
  return out;
}

// Who hears about a customer edit or cancel: the tech on the call, plus anyone
// who runs the board (manage_dispatch by role or extra perm). Admins and owners
// only when nobody else does, so they are not pinged for every call.
async function watchers(job) {
  const ids = {};
  if (job.assigned_to) ids[job.assigned_to] = 1;
  try {
    const permissions = require('./permissions');
    const cfg = await permissions.getRolePerms();
    const u = await pool.query('SELECT id, role, extra_perms FROM users WHERE active = true');
    var mgrs = u.rows.filter(function (x) {
      if (x.role === 'admin' || x.role === 'owner') return false;
      const byRole = cfg && Array.isArray(cfg[x.role]) ? cfg[x.role].indexOf('manage_dispatch') !== -1
        : permissions.defaultHas(x.role, 'manage_dispatch');
      return byRole || (Array.isArray(x.extra_perms) && x.extra_perms.indexOf('manage_dispatch') !== -1);
    });
    if (!mgrs.length) mgrs = u.rows.filter(function (x) { return x.role === 'admin' || x.role === 'owner'; });
    mgrs.forEach(function (x) { ids[x.id] = 1; });
  } catch (e) { console.error('[callLink] watchers:', e.message); }
  return Object.keys(ids).map(Number);
}

async function notify(job, title, body) {
  try {
    const ids = await watchers(job);
    if (!ids.length) return;
    await require('./push').sendPushToUsers(ids, {
      title: title, body: body, url: '/?view=dispatch-call&id=' + job.id, tag: 'dispatch-cust-' + job.id, channel: 'calls'
    });
  } catch (e) { console.error('[callLink] notify:', e.message); }
}

module.exports = {
  PHOTO_SLOTS: PHOTO_SLOTS, CUSTOMER_EDITABLE: CUSTOMER_EDITABLE, OPEN: OPEN, SHOW_TECH: SHOW_TECH, whenLabel: whenLabel,
  getSetting: getSetting, linkEnabled: linkEnabled, photosRequired: photosRequired, photoRoles: photoRoles,
  ensureToken: ensureToken, linkUrl: linkUrl, sendLink: sendLink, storeDataUrl: storeDataUrl,
  photosFor: photosFor, watchers: watchers, notify: notify, e164: e164
};
