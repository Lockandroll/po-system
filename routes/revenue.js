'use strict';
/*
 * Weekly revenue report - ingest and API  (Nova)
 * ----------------------------------------------
 * A manager drops the CallSearch "Call Search" CSV here; every row is stored
 * and the rolling report reads back out of it.
 *
 * THE ONE RULE THIS MODULE IS BUILT AROUND: upsert on Call UID.
 * Importing is idempotent. Re-dropping the same file changes nothing.
 * Overlapping date ranges are harmless. A call whose payment was corrected
 * after the fact overwrites its earlier version instead of adding to it.
 * That is what makes the recommended habit - export a trailing 3 to 4 weeks
 * every Monday, not just the newest week - free rather than dangerous, and it
 * is the only thing that stops prior weeks freezing at whatever they were the
 * day they were pulled while the books move on without them.
 *
 * Nothing here DELETES. There is no replace-the-week path on purpose: the
 * moment one exists, a mis-scoped export can silently wipe a week that was
 * already right.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var { logAudit } = require('../utils/audit');
var CSV = require('../utils/revenueCsv');
var RR = require('../utils/revenueReport');
var PDF = require('../utils/revenuePdf');
var SET = require('../utils/revenueSettings');
var DELIVER = require('../utils/revenueDeliver');

var router = express.Router();

// Rows per INSERT. 13,670 rows one statement at a time is thousands of round
// trips and a request that times out; one statement is a 150,000-parameter
// query Postgres will refuse (the limit is 65,535). 400 x 16 columns = 6,400
// parameters a statement, comfortably inside it.
var CHUNK = 400;
var COLS_PER_ROW = 16;

function n2(v) {
  var x = Number(v);
  if (!isFinite(x)) x = 0;
  return Math.round(x * 100) / 100;
}

function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/* ------------------------------------------------------------------- read */

/*
 * What is in the store, what the settings say, and when the report last went
 * out. One call so the page can draw itself without a waterfall.
 */
router.get('/meta', requireAuth, requirePermission('view_revenue'), async function (req, res) {
  var cfg = await SET.all();
  var history = await RR.historySummary(pool);
  var runs = await pool.query(
    'SELECT id, week_end, weeks, locations, revenue_total, recipients, bytes, ok, error, triggered_by, created_at ' +
    '  FROM cs_report_runs ORDER BY created_at DESC LIMIT 10');
  var imports = await pool.query(
    'SELECT id, filename, uploaded_by_name, first_date, last_date, total_rows, kept_rows, ' +
    '       inserted_rows, updated_rows, changed_rows, revenue_total, created_at ' +
    '  FROM cs_imports ORDER BY created_at DESC LIMIT 15');
  var weeks = await pool.query(
    'SELECT week_start, COUNT(*)::int AS calls, COALESCE(SUM(revenue),0)::float8 AS revenue ' +
    '  FROM cs_calls GROUP BY week_start ORDER BY week_start DESC LIMIT 26');

  var today = new Date().toISOString().slice(0, 10);
  res.json({
    settings: cfg,
    history: history,
    runs: runs.rows,
    imports: imports.rows,
    weeks: weeks.rows.map(function (w) {
      var d = w.week_start;
      var ymd = (d instanceof Date)
        ? d.getFullYear() + '-' + (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1) +
          '-' + (d.getDate() < 10 ? '0' : '') + d.getDate()
        : String(d).slice(0, 10);
      return { week_start: ymd, calls: w.calls, revenue: n2(w.revenue) };
    }),
    latestCompleteWeek: CSV.latestCompleteWeek(today),
    today: today
  });
});

// The report itself, as data. The on-screen page renders this; the PDF
// renders the identical object, so the two can never disagree.
router.get('/report', requireAuth, requirePermission('view_revenue'), async function (req, res) {
  var cfg = await SET.all();
  var report = await RR.buildReport(pool, {
    endWeek: isYmd(req.query.end) ? req.query.end : null,
    weeks: parseInt(req.query.weeks, 10) || cfg.weeks,
    locationMap: cfg.locationMap
  });
  res.json(report);
});

// The PDF, generated on demand and never stored. It is cheap to redraw and a
// stored copy is a copy that can go stale against a week that has restated.
router.get('/report.pdf', requireAuth, requirePermission('view_revenue'), async function (req, res) {
  var cfg = await SET.all();
  var report = await RR.buildReport(pool, {
    endWeek: isYmd(req.query.end) ? req.query.end : null,
    weeks: parseInt(req.query.weeks, 10) || cfg.weeks,
    locationMap: cfg.locationMap
  });
  var buf = await PDF.buildPdf(report);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="' + PDF.fileName(report) + '"');
  res.setHeader('Content-Length', String(buf.length));
  res.send(buf);
});

/* ----------------------------------------------------------------- ingest */

function parseBody(req) {
  var csv = req.body && req.body.csv;
  if (!csv || typeof csv !== 'string') return { error: 'No CSV provided.' };
  return { csv: csv };
}

/*
 * POST /preview - parse a file and report exactly what importing it WOULD do.
 * Writes nothing.
 *
 * The counts that matter are "new", "changed" and "unchanged". Unchanged is
 * the number that makes the trailing-window habit safe to teach: drop four
 * weeks every Monday and three of them come back as unchanged, which is the
 * upsert proving it is doing nothing rather than doubling anything.
 */
router.post('/preview', requireAuth, requirePermission('manage_revenue'), async function (req, res) {
  var b = parseBody(req);
  if (b.error) return res.status(400).json({ error: b.error });

  var map = await SET.locationMap();
  var out = CSV.extractRows(b.csv, map);
  if (!out.rows.length) return res.status(400).json({ error: CSV.emptyReason(out.meta) });

  // Compare against what is already stored, by uid. One query, not one per row.
  var uids = out.rows.map(function (r) { return r.call_uid; });
  var existing = {};
  for (var i = 0; i < uids.length; i += 1000) {
    var slice = uids.slice(i, i + 1000);
    var r = await pool.query(
      'SELECT call_uid, revenue::float8 AS revenue, call_date, service_class, location_raw ' +
      '  FROM cs_calls WHERE call_uid = ANY($1::varchar[])', [slice]);
    r.rows.forEach(function (row) { existing[row.call_uid] = row; });
  }

  var isNew = 0, changed = 0, unchanged = 0, revenueDelta = 0;
  out.rows.forEach(function (row) {
    var e = existing[row.call_uid];
    if (!e) { isNew++; revenueDelta += row.revenue; return; }
    var same = n2(e.revenue) === row.revenue &&
      String(e.service_class) === row.service_class &&
      String(e.location_raw) === row.location_raw;
    if (same) { unchanged++; return; }
    changed++;
    revenueDelta += row.revenue - n2(e.revenue);
  });

  // Per-week summary of the file, so a manager can see at a glance that the
  // export covers the weeks they meant it to.
  var byWeek = {};
  out.rows.forEach(function (row) {
    if (!byWeek[row.week_start]) byWeek[row.week_start] = { week_start: row.week_start, calls: 0, revenue: 0 };
    byWeek[row.week_start].calls++;
    byWeek[row.week_start].revenue = n2(byWeek[row.week_start].revenue + row.revenue);
  });

  var byClass = {};
  CSV.CLASSES.forEach(function (c) { byClass[c] = { calls: 0, revenue: 0 }; });
  out.rows.forEach(function (row) {
    byClass[row.service_class].calls++;
    byClass[row.service_class].revenue = n2(byClass[row.service_class].revenue + row.revenue);
  });

  res.json({
    meta: out.meta,
    weeks: Object.keys(byWeek).sort().map(function (k) { return byWeek[k]; }),
    byClass: byClass,
    locations: out.meta.locations.map(function (l) {
      return { location_raw: l.location, location: CSV.mapLocation(l.location, map), calls: l.calls };
    }),
    diff: {
      new: isNew,
      changed: changed,
      unchanged: unchanged,
      revenue_delta: n2(revenueDelta),
      revenue_total: out.meta.revenueTotal
    }
  });
});

/*
 * POST /import - commit.
 *
 * One transaction, chunked multi-row upserts. The (xmax = 0) test on the
 * RETURNING row is Postgres telling us whether that row was inserted or
 * updated, which is how the inserted/updated split is counted without a second
 * read of the table.
 */
router.post('/import', requireAuth, requirePermission('manage_revenue'), async function (req, res) {
  var b = parseBody(req);
  if (b.error) return res.status(400).json({ error: b.error });

  var filename = String((req.body && req.body.filename) || '').slice(0, 255) || null;
  var map = await SET.locationMap();
  var out = CSV.extractRows(b.csv, map);
  if (!out.rows.length) return res.status(400).json({ error: CSV.emptyReason(out.meta) });

  var client = await pool.connect();
  try {
    await client.query('BEGIN');

    var imp = await client.query(
      'INSERT INTO cs_imports (filename, uploaded_by, uploaded_by_name, first_date, last_date, ' +
      '                        total_rows, kept_rows, revenue_total) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [filename, req.user.id, req.user.name, out.meta.firstDate || null, out.meta.lastDate || null,
        out.meta.totalRows, out.meta.keptRows, out.meta.revenueTotal]
    );
    var importId = imp.rows[0].id;

    var inserted = 0, updated = 0, changed = 0;

    for (var start = 0; start < out.rows.length; start += CHUNK) {
      var slice = out.rows.slice(start, start + CHUNK);

      // What these rows look like BEFORE the upsert touches them. It has to be
      // read first: inside ON CONFLICT DO UPDATE, cs_calls.<col> in RETURNING
      // is the row as it now stands, not as it was, so "did this call's money
      // change?" cannot be answered from the upsert itself.
      var before = {};
      var beforeR = await client.query(
        'SELECT call_uid, revenue::float8 AS revenue FROM cs_calls WHERE call_uid = ANY($1::varchar[])',
        [slice.map(function (r) { return r.call_uid; })]);
      beforeR.rows.forEach(function (row) { before[row.call_uid] = n2(row.revenue); });

      var values = [], params = [];
      slice.forEach(function (r, i) {
        var base = i * COLS_PER_ROW;
        var ph = [];
        for (var p = 1; p <= COLS_PER_ROW; p++) ph.push('$' + (base + p));
        values.push('(' + ph.join(',') + ')');
        params.push(
          r.call_uid, importId, r.invoice || null, r.call_date, r.week_start, r.location_raw,
          r.task || null, r.service_class, r.tech_raw || null, r.status || null, r.account || null,
          r.cash, r.check_amt, r.cc, r.account_amt, r.revenue
        );
      });

      var q = await client.query(
        'INSERT INTO cs_calls (call_uid, import_id, invoice, call_date, week_start, location_raw, ' +
        '  task, service_class, tech_raw, status, account, cash, check_amt, cc, account_amt, revenue) ' +
        'VALUES ' + values.join(',') + ' ' +
        'ON CONFLICT (call_uid) DO UPDATE SET ' +
        '  import_id = EXCLUDED.import_id, invoice = EXCLUDED.invoice, call_date = EXCLUDED.call_date, ' +
        '  week_start = EXCLUDED.week_start, location_raw = EXCLUDED.location_raw, task = EXCLUDED.task, ' +
        '  service_class = EXCLUDED.service_class, tech_raw = EXCLUDED.tech_raw, status = EXCLUDED.status, ' +
        '  account = EXCLUDED.account, cash = EXCLUDED.cash, check_amt = EXCLUDED.check_amt, ' +
        '  cc = EXCLUDED.cc, account_amt = EXCLUDED.account_amt, revenue = EXCLUDED.revenue, ' +
        '  updated_at = NOW() ' +
        'RETURNING call_uid, (xmax = 0) AS was_insert, revenue::float8 AS revenue'
      , params);

      q.rows.forEach(function (row) {
        if (row.was_insert) { inserted++; return; }
        updated++;
        var prev = before[row.call_uid];
        if (prev !== undefined && prev !== n2(row.revenue)) changed++;
      });
    }

    await client.query(
      'UPDATE cs_imports SET inserted_rows = $1, updated_rows = $2, changed_rows = $3 WHERE id = $4',
      [inserted, updated, changed, importId]);

    await client.query('COMMIT');

    await logAudit({
      entity_type: 'revenue_import',
      entity_id: importId,
      entity_number: (out.meta.firstDate || '?') + ' to ' + (out.meta.lastDate || '?'),
      action: 'imported',
      user_id: req.user.id,
      user_name: req.user.name,
      details: {
        filename: filename, rows: out.meta.keptRows, inserted: inserted,
        updated: updated, payment_corrections: changed, revenue: out.meta.revenueTotal
      },
      ip: req.ip
    });

    res.status(201).json({
      success: true,
      import_id: importId,
      inserted: inserted,
      updated: updated,
      payment_corrections: changed,
      rows: out.meta.keptRows,
      revenue_total: out.meta.revenueTotal,
      first_date: out.meta.firstDate,
      last_date: out.meta.lastDate
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Revenue import error:', err);
    res.status(500).json({ error: 'Failed to import that CSV: ' + (err && err.message ? err.message : 'unknown error') });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------------- settings */

router.put('/settings', requireAuth, requirePermission('manage_revenue'), async function (req, res) {
  var b = req.body || {};
  var wrote = {};

  if (b.weeks !== undefined) {
    var w = Math.max(2, Math.min(52, parseInt(b.weeks, 10) || SET.DEFAULT_WEEKS));
    await SET.put(SET.KEY_WEEKS, w);
    wrote.weeks = w;
  }
  if (b.recipients !== undefined) {
    var list = SET.cleanEmails(b.recipients);
    await SET.put(SET.KEY_RECIPIENTS, list);
    wrote.recipients = list;
  }
  if (b.enabled !== undefined) {
    await SET.put(SET.KEY_ENABLED, b.enabled === true || b.enabled === 'true');
    wrote.enabled = b.enabled === true || b.enabled === 'true';
  }
  if (b.staleDays !== undefined) {
    var sd = Math.max(1, Math.min(120, parseInt(b.staleDays, 10) || SET.DEFAULT_STALE_DAYS));
    await SET.put(SET.KEY_STALE_DAYS, sd);
    wrote.staleDays = sd;
  }
  if (b.locationMap !== undefined && b.locationMap && typeof b.locationMap === 'object') {
    var clean = {};
    Object.keys(b.locationMap).forEach(function (k) {
      var key = CSV.squash(k);
      var val = String(b.locationMap[k] == null ? '' : b.locationMap[k]).trim();
      if (key && val) clean[key] = val;
    });
    await SET.put(SET.KEY_LOCATION_MAP, clean);
    wrote.locationMap = clean;
  }

  await logAudit({
    entity_type: 'revenue_report', entity_id: null, action: 'settings',
    user_id: req.user.id, user_name: req.user.name, details: wrote, ip: req.ip
  });

  res.json({ success: true, settings: await SET.all() });
});

/* ------------------------------------------------------------------- send */

/*
 * Send it now. Same code path as the Monday cron, so testing the button is a
 * real test of the schedule. 'to' lets an admin send one copy to themselves
 * without touching the standing list.
 */
router.post('/send', requireAuth, requirePermission('manage_revenue'), async function (req, res) {
  var b = req.body || {};
  var out = await DELIVER.generate({
    endWeek: isYmd(b.end) ? b.end : null,
    to: b.to || null,
    triggeredBy: 'manual'
  });
  await logAudit({
    entity_type: 'revenue_report', entity_id: out.run_id, action: 'sent',
    user_id: req.user.id, user_name: req.user.name,
    details: { recipients: out.recipients, week_end: CSV.addDays(out.report.window.last, 6), ok: out.sent },
    ip: req.ip
  });
  res.json({
    success: out.sent,
    sent: out.sent,
    recipients: out.recipients,
    stale: out.stale,
    error: out.error,
    week_end: CSV.addDays(out.report.window.last, 6),
    bytes: out.pdf.length
  });
});

module.exports = router;
