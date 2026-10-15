// utils/dispatchRecordings.js
// Customer call recordings on a DISPATCH call (Tony, 2026-10-15: "On every
// dispatched call, I want the recordings from the customer on that call. Same as
// the customer complaint section... make sure there is something in the call
// stating that we are working on pulling the calls.")
//
// Same source as the complaint panel (routes/feedback.js): Nova's own GoTo call
// index (goto_calls), matched by phone number. Two differences, both on purpose:
//
//  1. A complaint lists every call the number ever made. A dispatch call lists
//     only the calls AROUND this job: from dispatch_rec_before_hours before it
//     was created until dispatch_rec_after_hours after it closed (or now, while
//     it is open). A motor club or a business line can match hundreds of calls,
//     and the job is what the dispatcher came to hear about.
//
//  2. The job carries a STATE (dispatch_jobs.rec_status) and writes events into
//     the call's own log, because this is time sensitive. "pulling" means Nova is
//     still working on it - GoTo publishes a call some minutes after it ends and
//     hangs the recording on later still - and a dispatcher must never read an
//     empty panel as "the customer never called".
//
// rec_status: pulling | complete | partial | none | no_phone | not_connected
//
// No backticks in this file (Windows clipboard safety, CLAUDE.md 1.1).

'use strict';

const { pool } = require('../db');
const goto = require('./goto');

const CLOSED = ['done', 'goa', 'cancelled'];

async function settingNum(key, dflt, min, max) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    var n = r.rows.length ? parseFloat(r.rows[0].value) : NaN;
    if (!isFinite(n)) n = dflt;
    return Math.min(max, Math.max(min, n));
  } catch (e) { return dflt; }
}

// Every knob in settings (CLAUDE.md 9). Defaults: 6h either side of the job.
async function config() {
  return {
    beforeHours: await settingNum('dispatch_rec_before_hours', 6, 0, 72),
    afterHours: await settingNum('dispatch_rec_after_hours', 6, 1, 72),
    // A job never reads "all in" during its first minutes: the customer is often
    // still on the line when the call is created, and GoTo only posts a call some
    // minutes after it ends.
    settleMinutes: await settingNum('dispatch_rec_settle_minutes', 15, 0, 240)
  };
}

// Every number on the call, deduped by its last 10 digits, each labelled with
// the field(s) it came from. The label goes to the screen INSTEAD of the number,
// so a tech-facing payload never carries the customer's phone.
function numbersOf(job) {
  const out = [];
  const seen = {};
  [['callback_phone', 'Call back'], ['customer_phone', 'Customer phone'], ['caller_id', 'Caller ID']]
    .forEach(function (f) {
      const d = goto.normalizeDigits(job && job[f[0]]);
      if (!d) return;
      if (seen[d]) {
        if (seen[d].labels.indexOf(f[1]) === -1 && f[0] !== 'customer_phone') seen[d].labels.push(f[1]);
        return;
      }
      seen[d] = { digits: d, labels: [f[1]] };
      out.push(seen[d]);
    });
  return out;
}

function ms(v) {
  if (!v) return NaN;
  const t = new Date(v).getTime();
  return isNaN(t) ? NaN : t;
}

// When the job stopped being live, or null while it is still open.
function closedAt(job) {
  if (!job || CLOSED.indexOf(job.status) === -1) return null;
  var t = NaN;
  if (job.status === 'done') t = ms(job.completed_at);
  else if (job.status === 'goa') t = ms(job.goa_at);
  if (isNaN(t)) t = ms(job.status_since);
  if (isNaN(t)) t = ms(job.updated_at);
  if (isNaN(t)) t = Date.now();
  return t;
}

function windowOf(job, cfg, now) {
  now = now || Date.now();
  var created = ms(job.created_at);
  if (isNaN(created)) created = now;
  const closed = closedAt(job);
  const start = created - cfg.beforeHours * 3600000;
  const pullUntil = closed === null ? null : closed + cfg.afterHours * 3600000;
  // While open the window runs to NOW, so a customer calling back to ask where
  // the tech is lands on the call too.
  const end = pullUntil === null ? now : Math.min(pullUntil, Math.max(now, closed));
  return {
    start: start,
    end: pullUntil === null ? now : pullUntil,
    shownEnd: end,
    closed: closed,
    pullUntil: pullUntil,
    active: pullUntil === null || now < pullUntil
  };
}

async function gotoReady() {
  if (!goto.configured()) return false;
  try {
    const s = await goto.status();
    return !!(s && s.connected && s.accountKey);
  } catch (e) { return false; }
}

// High-water mark of the whole index (measures the indexer, not the customer).
async function indexInfo() {
  const r = await pool.query('SELECT MAX(call_started_at) AS newest FROM goto_calls');
  return { newest: (r.rows[0] && r.rows[0].newest) || null, empty: !(r.rows[0] && r.rows[0].newest) };
}

async function findCalls(job, cfg, now) {
  const nums = numbersOf(job);
  if (!nums.length) return [];
  const w = windowOf(job, cfg, now);
  const r = await pool.query(
    'SELECT c.id, c.direction, c.call_started_at, c.call_ended_at, c.duration_sec, c.external_digits,' +
    '       c.has_recording, c.recording_id, c.transcript_id, c.r2_key, l.hidden' +
    ' FROM goto_calls c' +
    ' LEFT JOIN dispatch_job_recordings l ON l.call_id = c.id AND l.job_id = $1' +
    ' WHERE c.external_digits = ANY($2) AND c.call_started_at >= $3 AND c.call_started_at <= $4' +
    ' ORDER BY c.call_started_at DESC LIMIT 100',
    [job.id, nums.map(function (n) { return n.digits; }), new Date(w.start), new Date(w.end)]
  );
  return r.rows;
}

// The state of one job, from its calls. Pure, so the tests can drive it.
function stateOf(job, calls, idx, cfg, gotoOk, now) {
  now = now || Date.now();
  const nums = numbersOf(job);
  const w = windowOf(job, cfg, now);
  const visible = (calls || []).filter(function (c) { return !c.hidden; });
  const recorded = visible.filter(function (c) { return !!c.has_recording; }).length;
  const waiting = visible.length - recorded;
  var state;
  if (!nums.length) state = 'no_phone';
  else if (!gotoOk) state = 'not_connected';
  else if (w.active) {
    var created = ms(job.created_at);
    if (isNaN(created)) created = now;
    const settling = now - created < (cfg.settleMinutes || 0) * 60000;
    state = (settling || !visible.length || waiting) ? 'pulling' : 'complete';
  } else {
    state = !visible.length ? 'none' : (waiting ? 'partial' : 'complete');
  }
  return {
    state: state,
    found: visible.length,
    recorded: recorded,
    waiting: waiting,
    hidden: (calls || []).length - visible.length,
    window_start: new Date(w.start).toISOString(),
    window_end: new Date(w.end).toISOString(),
    pull_until: w.pullUntil === null ? null : new Date(w.pullUntil).toISOString(),
    active: w.active
  };
}

async function logEvent(jobId, event, detail) {
  await pool.query(
    'INSERT INTO dispatch_job_events (job_id, event, detail) VALUES ($1, $2, $3)', [jobId, event, detail]);
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

// Re-evaluate one job, store the result and write what changed into the call's
// own event log. Returns the computed state.
async function evaluate(job, ctx) {
  ctx = ctx || {};
  const cfg = ctx.cfg || await config();
  const idx = ctx.idx || await indexInfo();
  const ok = ctx.gotoOk === undefined ? await gotoReady() : ctx.gotoOk;
  const calls = await findCalls(job, cfg, ctx.now);
  const s = stateOf(job, calls, idx, cfg, ok, ctx.now);

  const prev = job.rec_status || null;
  const prevRec = parseInt(job.rec_recorded, 10) || 0;
  const prevFound = parseInt(job.rec_found, 10) || 0;

  await pool.query(
    'UPDATE dispatch_jobs SET rec_status = $2, rec_found = $3, rec_recorded = $4, rec_checked_at = NOW()' +
    (s.state !== prev ? ', rec_status_at = NOW()' : '') + ' WHERE id = $1',
    [job.id, s.state, s.found, s.recorded]
  );

  // The log is what a dispatcher reads, so every line is a plain sentence.
  if (prev === null) {
    if (s.state === 'pulling') {
      await logEvent(job.id, 'rec_pulling', 'Working on pulling the customer call recordings from GoTo.');
    } else if (s.state === 'not_connected') {
      await logEvent(job.id, 'rec_unavailable', 'GoTo is not connected, so the customer calls cannot be pulled.');
    }
  } else if (prev === 'not_connected' && s.state === 'pulling') {
    await logEvent(job.id, 'rec_pulling', 'GoTo is back. Working on pulling the customer call recordings.');
  }
  if (s.recorded > prevRec) {
    await logEvent(job.id, 'rec_found',
      plural(s.recorded, 'customer call recording') + ' pulled from GoTo' +
      (s.waiting ? ', ' + s.waiting + ' still waiting on GoTo' : '') + '.');
  } else if (s.found > prevFound && s.waiting && prev !== null) {
    await logEvent(job.id, 'rec_found',
      plural(s.found, 'customer call') + ' found in GoTo, recording' + (s.waiting === 1 ? '' : 's') + ' not posted yet.');
  }
  if (s.state !== prev && prev !== null) {
    if (s.state === 'none') {
      await logEvent(job.id, 'rec_none', 'Stopped looking: no customer calls found in GoTo for this call.');
    } else if (s.state === 'partial') {
      await logEvent(job.id, 'rec_partial', 'Stopped looking: ' + plural(s.waiting, 'call') + ' never got a recording from GoTo.');
    }
  }
  s.prev = prev;
  return s;
}

// ---- pulling from GoTo now ---------------------------------------------------
// Bounded and single-flight, same guards as the complaint refresh: the window is
// global, so two people (or a person and the cron) share ONE upstream sync, and
// a click inside the gap re-reads the table instead of hammering GoTo.
const REFRESH_GAP_MS = 45000;
var _at = 0;
var _flight = null;

async function pullRecent(hoursBack, maxPages) {
  if (_flight) {
    try { const r = await _flight; return Object.assign({}, r, { ran: true, reason: 'shared' }); }
    catch (e) { return { ran: false, reason: 'failed' }; }
  }
  if (Date.now() - _at < REFRESH_GAP_MS) return { ran: false, reason: 'cooldown' };
  const now = Date.now();
  const hrs = Math.min(24, Math.max(1, hoursBack || 3));
  _flight = (async function () {
    const stats = await goto.syncWindow({
      startIso: new Date(now - hrs * 3600000).toISOString(),
      endIso: new Date(now).toISOString(),
      maxPages: maxPages || 10
    });
    var drained = { attached: 0 };
    try { drained = await goto.drainPendingMedia(); } catch (e) { drained = { attached: 0 }; }
    return { ran: true, reason: null, inserted: stats.inserted || 0, updated: stats.updated || 0, attached: drained.attached || 0 };
  })();
  try { return await _flight; }
  catch (e) { console.error('dispatch recordings pull:', e.message); return { ran: false, reason: 'failed' }; }
  finally { _at = Date.now(); _flight = null; }
}

// How far back a pull for this job needs to reach (capped at a day).
function hoursBackFor(job, cfg) {
  const w = windowOf(job, cfg);
  return Math.ceil((Date.now() - w.start) / 3600000);
}

// ---- the cron ---------------------------------------------------------------
// Every 2 minutes (jobs/dispatch.js). Picks up every job still inside its pull
// window, plus anything new that has never been looked at, pulls the last few
// hours from GoTo once if any of them is still waiting, then re-evaluates each.
async function runPending() {
  const cfg = await config();
  const r = await pool.query(
    'SELECT * FROM dispatch_jobs' +
    " WHERE created_at > NOW() - interval '7 days'" +
    "   AND (rec_status IS NULL OR rec_status IN ('pulling', 'not_connected')" +
    '        OR status <> ALL($1)' +
    "        OR COALESCE(completed_at, goa_at, status_since, updated_at) > NOW() - ($2 || ' hours')::interval)" +
    ' ORDER BY created_at DESC LIMIT 500',
    [CLOSED, String(cfg.afterHours)]
  );
  if (!r.rows.length) return { jobs: 0 };
  const ok = await gotoReady();
  var pulled = null;
  if (ok && r.rows.some(function (j) { return j.rec_status === null || j.rec_status === 'pulling'; })) {
    // The 10-minute indexer already re-reads the whole day; this pass only has
    // to be quick about the last few hours, which is where a live call is.
    pulled = await pullRecent(3, 10);
  }
  const idx = await indexInfo();
  var changed = 0;
  for (const job of r.rows) {
    try {
      const s = await evaluate(job, { cfg: cfg, idx: idx, gotoOk: ok });
      if (s.state !== s.prev) changed++;
    } catch (e) { console.error('dispatch recordings evaluate ' + job.id + ':', e.message); }
  }
  return { jobs: r.rows.length, changed: changed, pulled: pulled };
}

module.exports = {
  CLOSED: CLOSED,
  config: config,
  numbersOf: numbersOf,
  windowOf: windowOf,
  closedAt: closedAt,
  gotoReady: gotoReady,
  indexInfo: indexInfo,
  findCalls: findCalls,
  stateOf: stateOf,
  evaluate: evaluate,
  pullRecent: pullRecent,
  hoursBackFor: hoursBackFor,
  runPending: runPending,
  _resetForTests: function () { _at = 0; _flight = null; }
};
