'use strict';
/*
 * Job health  (Nova)
 * ------------------
 * One durable row per scheduled job, so "is the schedule actually running?" is a
 * question that can be answered from the Settings screen instead of from a Railway
 * log that has already aged out.
 *
 * Why this exists: on 2026-08-18 a single failing migration inside initDB() meant
 * startScheduledJobs() never ran, so not one cron in Nova started. The site served
 * pages perfectly the entire time. The SOP quiz texts and the Monday deposit
 * reminder simply stopped, and the only evidence anywhere was a log line nobody
 * was watching. Nothing in the product could have told you. This is that missing
 * thing.
 *
 * How it works: server.js calls install() once, then names each scheduler as it
 * starts it. install() wraps node-cron's schedule() on the shared module object,
 * so every cron registered while a startX() is running is attributed to that job
 * and its callback is timed and recorded. No job file has to be edited to be
 * covered, which is the whole point - a job that has to opt in is a job that gets
 * forgotten.
 *
 * Failure policy: this module must NEVER be able to break a job.
 *   - Every database write is fire-and-forget and swallowed.
 *   - If node-cron is not the shape expected, install() does nothing at all.
 *   - A callback that throws is recorded and swallowed rather than re-thrown. That
 *     is deliberate and is a change: an exception escaping a cron callback takes
 *     the whole process down on modern Node. Every tick in Nova already has its own
 *     try/catch, so in practice this only catches the case that used to be fatal.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var cron = require('node-cron');
var { pool } = require('../db');

var MIN = 60000;
var HOUR = 60 * MIN;
var DAY = 24 * HOUR;

// A per-minute cron would otherwise write 1440 rows a day on its own. The
// in-memory mirror is always exact; the stored row lags by at most this much on a
// healthy job, and is written immediately on registration and on every error.
var PERSIST_EVERY_MS = 5 * MIN;

var _jobs = Object.create(null);  // job name -> live state
var _order = [];                  // registration order, so the panel is stable
var _currentJob = null;           // the startX() being invoked right now
var _bootAt = null;
var _installed = false;
var _warnedOnce = false;

function _entry(name) {
  var e = _jobs[name];
  if (!e) {
    e = _jobs[name] = {
      job_name: name,
      schedules: [],
      registered_at: null,
      boot_error: null,
      last_run_at: null,
      last_ok_at: null,
      last_error_at: null,
      last_error: null,
      last_duration_ms: null,
      runs: 0,
      errors: 0,
      pendingRuns: 0,
      pendingErrors: 0,
      lastPersistMs: 0
    };
    _order.push(name);
  }
  return e;
}

/* ------------------------------------------------------------ persistence */

function _persist(e, force) {
  var now = Date.now();
  if (!force && (now - e.lastPersistMs) < PERSIST_EVERY_MS) return;
  e.lastPersistMs = now;
  var runs = e.pendingRuns; e.pendingRuns = 0;
  var errs = e.pendingErrors; e.pendingErrors = 0;
  var params = [
    e.job_name,
    e.schedules.join(', ') || null,
    e.registered_at,
    e.boot_error,
    e.last_run_at,
    e.last_ok_at,
    e.last_error_at,
    e.last_error,
    e.last_duration_ms,
    runs,
    errs
  ];
  pool.query(
    'INSERT INTO job_runs (job_name, schedules, registered_at, boot_error, last_run_at,' +
    ' last_ok_at, last_error_at, last_error, last_duration_ms, run_count, error_count, updated_at)' +
    ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())' +
    ' ON CONFLICT (job_name) DO UPDATE SET' +
    '   schedules = COALESCE(EXCLUDED.schedules, job_runs.schedules),' +
    '   registered_at = COALESCE(EXCLUDED.registered_at, job_runs.registered_at),' +
    '   boot_error = EXCLUDED.boot_error,' +
    '   last_run_at = COALESCE(EXCLUDED.last_run_at, job_runs.last_run_at),' +
    '   last_ok_at = COALESCE(EXCLUDED.last_ok_at, job_runs.last_ok_at),' +
    '   last_error_at = COALESCE(EXCLUDED.last_error_at, job_runs.last_error_at),' +
    '   last_error = COALESCE(EXCLUDED.last_error, job_runs.last_error),' +
    '   last_duration_ms = COALESCE(EXCLUDED.last_duration_ms, job_runs.last_duration_ms),' +
    '   run_count = job_runs.run_count + $10,' +
    '   error_count = job_runs.error_count + $11,' +
    '   updated_at = NOW()',
    params
  ).catch(function (err) {
    // Hand the counts back so a transient DB blip does not lose them, and never
    // let this surface. A missing job_runs table (migrations failed) is exactly
    // the situation this module exists to report on - it must not add noise to it.
    e.pendingRuns += runs;
    e.pendingErrors += errs;
    if (!_warnedOnce) {
      _warnedOnce = true;
      console.error('[jobhealth] could not record job runs (' + (err && err.message) +
        '). The jobs themselves are unaffected.');
    }
  });
}

function _finish(e, startedMs, err) {
  var at = new Date();
  e.last_run_at = at;
  e.last_duration_ms = Date.now() - startedMs;
  e.runs++; e.pendingRuns++;
  if (err) {
    e.errors++; e.pendingErrors++;
    e.last_error_at = at;
    e.last_error = String((err && err.message) || err).slice(0, 500);
    console.error('[jobhealth] ' + e.job_name + ' tick failed: ' + e.last_error);
  } else {
    e.last_ok_at = at;
  }
  _persist(e, !!err);
}

/* --------------------------------------------------------- the cron shim */

function install() {
  if (_installed) return;
  _installed = true;
  _bootAt = new Date();
  var orig = cron && cron.schedule;
  if (typeof orig !== 'function') {
    console.error('[jobhealth] node-cron does not expose schedule(); job tracking is off.');
    return;
  }
  cron.schedule = function (expr, fn, opts) {
    var name = _currentJob || 'unattributed';
    var e = _entry(name);
    var key = String(expr);
    if (e.schedules.indexOf(key) === -1) e.schedules.push(key);
    var tracked = function () {
      var started = Date.now();
      var out;
      try {
        out = fn.apply(this, arguments);
      } catch (syncErr) {
        _finish(e, started, syncErr);
        return;
      }
      if (out && typeof out.then === 'function') {
        return out.then(
          function (v) { _finish(e, started, null); return v; },
          function (asyncErr) { _finish(e, started, asyncErr); }
        );
      }
      _finish(e, started, null);
      return out;
    };
    return orig.call(cron, expr, tracked, opts);
  };
}

// server.js brackets each startX() with these, so every cron registered in
// between is attributed to it.
function beginRegister(name) {
  _currentJob = name;
  var e = _entry(name);
  e.registered_at = new Date();
  e.boot_error = null;
}

function endRegister(name, errMessage) {
  _currentJob = null;
  var e = _entry(name);
  if (errMessage) {
    e.boot_error = String(errMessage).slice(0, 500);
    e.registered_at = null;
  }
  _persist(e, true);
}

/* ------------------------------------------------------ staleness maths */

// Roughly how often a cron expression should fire. Used only to decide when
// "nothing has happened in a while" becomes worth showing in red, so it errs
// toward the frequent reading rather than trying to be a real cron parser.
function expectedIntervalMs(expr) {
  var parts = String(expr || '').trim().split(/\s+/);
  if (parts.length < 5) return null;
  var min = parts[0], hr = parts[1], dom = parts[2], dow = parts[4];
  var stepMin = /^\*\/(\d+)$/.exec(min);
  var stepHr = /^\*\/(\d+)$/.exec(hr);
  if (min === '*') return MIN;
  if (stepMin && hr === '*') {
    var sm = parseInt(stepMin[1], 10);
    return (sm > 0 ? sm : 1) * MIN;
  }
  if (hr === '*') return HOUR;
  if (stepHr) {
    var sh = parseInt(stepHr[1], 10);
    return (sh > 0 ? sh : 1) * HOUR;
  }
  if (dom !== '*') return 31 * DAY;
  if (dow !== '*') return 7 * DAY;
  return DAY;
}

// The most frequent schedule a job owns is what decides whether it looks alive:
// a job with a per-minute tick and a nightly sweep is broken the moment the
// per-minute tick stops, regardless of the sweep.
function fastestInterval(schedules) {
  var best = null;
  for (var i = 0; i < schedules.length; i++) {
    var v = expectedIntervalMs(schedules[i]);
    if (v != null && (best == null || v < best)) best = v;
  }
  return best;
}

function staleAfterMs(interval) {
  if (interval == null) return null;
  // One whole missed cycle, plus slack. Ten minutes of grace keeps a per-minute
  // job from flickering red because a tick landed a few seconds late.
  return interval + Math.max(interval * 0.25, 10 * MIN);
}

function _status(e, interval, staleAfter) {
  if (e.boot_error) return 'failed_to_start';
  if (!e.schedules.length) return 'timer';
  var now = Date.now();
  var last = e.last_run_at ? new Date(e.last_run_at).getTime() : null;
  if (last == null) {
    var bootAge = _bootAt ? (now - _bootAt.getTime()) : 0;
    return (staleAfter != null && bootAge > staleAfter) ? 'never_ran' : 'waiting';
  }
  if (staleAfter != null && (now - last) > staleAfter) return 'stale';
  var errAt = e.last_error_at ? new Date(e.last_error_at).getTime() : null;
  var okAt = e.last_ok_at ? new Date(e.last_ok_at).getTime() : null;
  if (errAt != null && (okAt == null || errAt > okAt)) return 'erroring';
  return 'ok';
}

// What this process knows right now. Authoritative for "is it running"; the
// stored table is what carries lifetime counts across restarts.
function snapshot() {
  return _order.map(function (name) {
    var e = _jobs[name];
    var interval = fastestInterval(e.schedules);
    var stale = staleAfterMs(interval);
    return {
      job_name: e.job_name,
      schedules: e.schedules.join(', '),
      registered_at: e.registered_at,
      boot_error: e.boot_error,
      last_run_at: e.last_run_at,
      last_ok_at: e.last_ok_at,
      last_error_at: e.last_error_at,
      last_error: e.last_error,
      last_duration_ms: e.last_duration_ms,
      runs_this_boot: e.runs,
      errors_this_boot: e.errors,
      expected_interval_ms: interval,
      stale_after_ms: stale,
      status: _status(e, interval, stale)
    };
  });
}

function boot() {
  return {
    installed: _installed,
    booted_at: _bootAt,
    jobs_registered: _order.length,
    crons_registered: _order.reduce(function (n, k) { return n + _jobs[k].schedules.length; }, 0)
  };
}

module.exports = {
  install: install,
  beginRegister: beginRegister,
  endRegister: endRegister,
  snapshot: snapshot,
  boot: boot,
  expectedIntervalMs: expectedIntervalMs,
  fastestInterval: fastestInterval,
  staleAfterMs: staleAfterMs
};
