'use strict';
/*
 * GET /api/job-health  (Nova)
 * ---------------------------
 * What the Settings > Job Health panel reads.
 *
 * Two sources, deliberately merged:
 *   - utils/jobHealth's in-memory snapshot is authoritative for "is this running
 *     RIGHT NOW", because it only ever describes the process answering this request.
 *   - the job_runs table carries lifetime counts and the last known state across
 *     restarts, and - the useful part - it remembers jobs that used to register and
 *     no longer do. A job that quietly stopped being started is exactly the failure
 *     this screen exists to catch, and only the stored row can see it.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var JH = require('../utils/jobHealth');

var router = express.Router();

// Worst first. Someone opening this screen is looking for the broken one.
var RANK = {
  failed_to_start: 0,
  never_ran: 1,
  stale: 2,
  erroring: 3,
  not_registered: 4,
  waiting: 5,
  timer: 6,
  ok: 7
};

router.get('/', requireAuth, requirePermission('manage_settings'), async function (req, res) {
  try {
    var jobs = JH.snapshot();
    var byName = {};
    jobs.forEach(function (j) { byName[j.job_name] = j; });

    var stored = [];
    var storeError = null;
    try {
      var r = await pool.query('SELECT * FROM job_runs ORDER BY job_name ASC');
      stored = r.rows;
    } catch (e) {
      // The table not existing IS a finding, not an outage: it means initDB did
      // not get far enough to create it. Report it instead of failing the screen.
      storeError = e.message;
    }

    stored.forEach(function (row) {
      var live = byName[row.job_name];
      if (live) {
        live.total_runs = Number(row.run_count) || 0;
        live.total_errors = Number(row.error_count) || 0;
        live.last_run_previous_boot = row.last_run_at;
        if (!live.last_error && row.last_error) {
          live.previous_error = row.last_error;
          live.previous_error_at = row.last_error_at;
        }
      } else {
        jobs.push({
          job_name: row.job_name,
          schedules: row.schedules,
          registered_at: null,
          boot_error: row.boot_error,
          last_run_at: null,
          last_run_previous_boot: row.last_run_at,
          last_error: row.last_error,
          last_error_at: row.last_error_at,
          runs_this_boot: 0,
          errors_this_boot: 0,
          total_runs: Number(row.run_count) || 0,
          total_errors: Number(row.error_count) || 0,
          status: 'not_registered'
        });
      }
    });

    jobs.sort(function (a, b) {
      var ra = RANK[a.status] != null ? RANK[a.status] : 9;
      var rb = RANK[b.status] != null ? RANK[b.status] : 9;
      if (ra !== rb) return ra - rb;
      return String(a.job_name).localeCompare(String(b.job_name));
    });

    var counts = {};
    jobs.forEach(function (j) { counts[j.status] = (counts[j.status] || 0) + 1; });

    res.json({
      now: new Date().toISOString(),
      boot: JH.boot(),
      store_error: storeError,
      counts: counts,
      jobs: jobs
    });
  } catch (err) {
    console.error('job-health:', err);
    res.status(500).json({ error: 'Could not read job health' });
  }
});

module.exports = router;
