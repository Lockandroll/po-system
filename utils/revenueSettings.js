'use strict';
/*
 * Weekly revenue report - the knobs  (Nova)
 * -----------------------------------------
 * Every setting the report reads lives in the settings table rather than in a
 * constant, so who gets the email, how many weeks it covers and which
 * locations are consolidated can all change without a deploy (CLAUDE.md §9).
 *
 * Shared by routes/revenue.js and jobs/revenueReport.js so the page and the
 * Monday send can never disagree about the window or the recipient list.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var { pool } = require('../db');
var CSV = require('./revenueCsv');

var KEY_WEEKS = 'revenue_report_weeks';
var KEY_RECIPIENTS = 'revenue_report_recipients';
var KEY_LOCATION_MAP = 'revenue_location_map';
var KEY_ENABLED = 'revenue_report_enabled';
var KEY_STALE_DAYS = 'revenue_report_stale_days';

var DEFAULT_WEEKS = 12;
// How old the newest ingested call may be before the page and the email say
// the data is stale. Ingest is a manual CSV drop, so silence is the expected
// failure mode and it has to be visible rather than inferred from a flat line
// on a chart.
var DEFAULT_STALE_DAYS = 10;

async function get(key, fallback) {
  try {
    var r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
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
  var raw = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[,;\s]+/);
  var seen = {}, out = [];
  raw.forEach(function (e) {
    var s = String(e || '').trim().toLowerCase();
    if (!s) return;
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s)) return;
    if (seen[s]) return;
    seen[s] = 1;
    out.push(s);
  });
  return out.slice(0, 50);
}

/*
 * Recipients. The settings row wins; REVENUE_REPORT_RECIPIENTS is only the
 * seed for a Nova that has never been told, and an EMPTY saved list means
 * nobody - not "fall back to the env var". Turning the list off has to
 * actually turn it off, or unsubscribing somebody is impossible.
 */
async function recipients() {
  var saved = await get(KEY_RECIPIENTS, null);
  if (saved !== null) return cleanEmails(saved);
  return cleanEmails(process.env.REVENUE_REPORT_RECIPIENTS || '');
}

async function weeks() {
  var v = parseInt(await get(KEY_WEEKS, DEFAULT_WEEKS), 10);
  if (!isFinite(v)) v = DEFAULT_WEEKS;
  return Math.max(2, Math.min(52, v));
}

async function locationMap() {
  var m = await get(KEY_LOCATION_MAP, null);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return CSV.DEFAULT_LOCATION_MAP;
  var out = {};
  Object.keys(m).forEach(function (k) {
    var key = CSV.squash(k);
    var val = String(m[k] == null ? '' : m[k]).trim();
    if (key && val) out[key] = val;
  });
  return Object.keys(out).length ? out : CSV.DEFAULT_LOCATION_MAP;
}

// The Monday send is OFF until somebody turns it on. A report that starts
// emailing seven managers the moment the code deploys is not a feature.
async function enabled() {
  return get(KEY_ENABLED, false) === true;
}

async function staleDays() {
  var v = parseInt(await get(KEY_STALE_DAYS, DEFAULT_STALE_DAYS), 10);
  if (!isFinite(v)) v = DEFAULT_STALE_DAYS;
  return Math.max(1, Math.min(120, v));
}

async function all() {
  return {
    weeks: await weeks(),
    recipients: await recipients(),
    locationMap: await locationMap(),
    enabled: await enabled(),
    staleDays: await staleDays()
  };
}

module.exports = {
  KEY_WEEKS: KEY_WEEKS,
  KEY_RECIPIENTS: KEY_RECIPIENTS,
  KEY_LOCATION_MAP: KEY_LOCATION_MAP,
  KEY_ENABLED: KEY_ENABLED,
  KEY_STALE_DAYS: KEY_STALE_DAYS,
  DEFAULT_WEEKS: DEFAULT_WEEKS,
  DEFAULT_STALE_DAYS: DEFAULT_STALE_DAYS,
  get: get,
  put: put,
  cleanEmails: cleanEmails,
  recipients: recipients,
  weeks: weeks,
  locationMap: locationMap,
  enabled: enabled,
  staleDays: staleDays,
  all: all
};
