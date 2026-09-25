'use strict';
/*
 * Completion Paperwork - the knobs  (Nova)
 * ----------------------------------------
 * Every setting the completion-paperwork sender reads lives in the settings
 * table, not a constant, so the send time, the standing internal Cc, the from/
 * reply-to and the subject can change without a deploy (CLAUDE.md section 9).
 *
 * Shared by routes/paperwork.js (the Settings card and, later, the queue) and
 * jobs/paperwork.js (the daily send) so the page and the cron never disagree.
 *
 * OFF by default: completion_send_enabled starts false, so nothing is ever
 * emailed to a customer until somebody turns it on.
 *
 * NOTE: no backtick/template-literal strings anywhere (Windows-safe per the
 * Nova editing rules).
 */

const { pool } = require('../db');

const DEFAULTS = {
  completion_send_enabled: false,
  completion_send_time: '17:00',
  completion_internal_cc: [],
  completion_from: '',
  completion_reply_to: 'lscall@popalockar.com',
  completion_subject_template: 'Completion Paperwork · PO {po} · Invoice #{invoice}',
  completion_max_attach_mb: 20,
  completion_signature: '',
  // Stale-job reminder (Tony 2026-09-24): a job that sits in Needs Review this
  // many BUSINESS days (weekends and the holidays table skipped) gets listed in
  // a morning email to these people. 0 turns the flag and the email off.
  completion_stale_days: 2,
  completion_stale_notify: [],
  completion_stale_time: '08:00'
};

async function get(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!r.rows.length || r.rows[0].value == null || r.rows[0].value === '') return fallback;
    return JSON.parse(r.rows[0].value);
  } catch (e) { return fallback; }
}

async function put(key, val) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(val)]
  );
}

function cleanEmails(list) {
  const raw = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,;\s]+/);
  const seen = {}, out = [];
  raw.forEach(function (e) {
    const s = String(e || '').trim().toLowerCase();
    if (!s) return;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s)) return;
    if (seen[s]) return;
    seen[s] = 1;
    out.push(s);
  });
  return out.slice(0, 50);
}

function normTime(t, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t == null ? '' : t).trim());
  if (!m) return fallback || DEFAULTS.completion_send_time;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const mi = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return (h < 10 ? '0' + h : '' + h) + ':' + (mi < 10 ? '0' + mi : '' + mi);
}

function clampDays(v) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return DEFAULTS.completion_stale_days;
  return Math.max(0, Math.min(30, n));
}

function clampMb(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return DEFAULTS.completion_max_attach_mb;
  return Math.max(1, Math.min(40, n));
}

// The full settings object the UI reads, each key from the settings table or
// its default.
async function getAll() {
  const out = {};
  const keys = Object.keys(DEFAULTS);
  for (let i = 0; i < keys.length; i++) {
    out[keys[i]] = await get(keys[i], DEFAULTS[keys[i]]);
  }
  out.completion_internal_cc = cleanEmails(out.completion_internal_cc);
  out.completion_send_time = normTime(out.completion_send_time);
  out.completion_max_attach_mb = clampMb(out.completion_max_attach_mb);
  out.completion_send_enabled = out.completion_send_enabled === true;
  out.completion_stale_days = clampDays(out.completion_stale_days);
  out.completion_stale_notify = cleanEmails(out.completion_stale_notify);
  out.completion_stale_time = normTime(out.completion_stale_time, DEFAULTS.completion_stale_time);
  return out;
}

// Save only the keys present in the patch, each coerced to the shape of its
// default, so the endpoint cannot store junk. Returns the fresh full object.
async function saveAll(patch) {
  patch = patch || {};
  if (patch.completion_send_enabled !== undefined) await put('completion_send_enabled', patch.completion_send_enabled === true);
  if (patch.completion_send_time !== undefined) await put('completion_send_time', normTime(patch.completion_send_time));
  if (patch.completion_internal_cc !== undefined) await put('completion_internal_cc', cleanEmails(patch.completion_internal_cc));
  if (patch.completion_from !== undefined) await put('completion_from', String(patch.completion_from || ''));
  if (patch.completion_reply_to !== undefined) await put('completion_reply_to', String(patch.completion_reply_to || ''));
  if (patch.completion_subject_template !== undefined) await put('completion_subject_template', String(patch.completion_subject_template || DEFAULTS.completion_subject_template));
  if (patch.completion_max_attach_mb !== undefined) await put('completion_max_attach_mb', clampMb(patch.completion_max_attach_mb));
  if (patch.completion_signature !== undefined) await put('completion_signature', String(patch.completion_signature || ''));
  if (patch.completion_stale_days !== undefined) await put('completion_stale_days', clampDays(patch.completion_stale_days));
  if (patch.completion_stale_notify !== undefined) await put('completion_stale_notify', cleanEmails(patch.completion_stale_notify));
  if (patch.completion_stale_time !== undefined) await put('completion_stale_time', normTime(patch.completion_stale_time, DEFAULTS.completion_stale_time));
  return getAll();
}

// Accessors the sender (jobs/paperwork.js) will use in a later phase.
async function enabled() { return (await get('completion_send_enabled', false)) === true; }
async function sendTime() { return normTime(await get('completion_send_time', DEFAULTS.completion_send_time)); }
async function internalCc() { return cleanEmails(await get('completion_internal_cc', [])); }
async function maxAttachMb() { return clampMb(await get('completion_max_attach_mb', DEFAULTS.completion_max_attach_mb)); }
async function staleDays() { return clampDays(await get('completion_stale_days', DEFAULTS.completion_stale_days)); }
async function maxAttachBytes() { return Math.round((await maxAttachMb()) * 1024 * 1024); }

module.exports = {
  DEFAULTS: DEFAULTS,
  get: get, put: put, cleanEmails: cleanEmails, normTime: normTime,
  getAll: getAll, saveAll: saveAll,
  enabled: enabled, sendTime: sendTime, internalCc: internalCc,
  maxAttachMb: maxAttachMb, maxAttachBytes: maxAttachBytes, staleDays: staleDays
};
