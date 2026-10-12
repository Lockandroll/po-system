'use strict';
/*
 * Pulsar Call Data - the raw Call Search dump  (Nova)
 * --------------------------------------------------
 * Somewhere to drop the whole Pulsar Call Search export, every column, as far
 * back as Pulsar will go, and then look at it: browse and filter, roll it up,
 * export a slice, or let Claude query it through the Nova tools.
 *
 * Rules this module is built around:
 *   - Upsert on Call UID. Re-importing the same file changes nothing, an
 *     overlapping range is harmless, a corrected call overwrites itself.
 *   - Merge, do not replace. data = old || new, so two exports with different
 *     column layouts (one with GPS, one with Onsite) end up as one record with
 *     both. A column the newer file has always wins.
 *   - Nothing here deletes. A mis-scoped export cannot wipe anything.
 *
 * The browser parses the CSV and posts it in batches (a three-year export is
 * far bigger than one request should be). Each batch is its own transaction,
 * so a dropped connection halfway leaves every batch that landed correct and
 * the rest simply not there yet; re-dropping the same file finishes the job.
 *
 * Permissions: view_call_data (browse, summaries, export) and
 * manage_call_data (import). The free-form SQL endpoint is admin/owner only
 * regardless of the matrix, and runs read-only against the cd_* tables only.
 *
 * NOTE: no backtick/template-literal strings anywhere (Windows-safe).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var { logAudit } = require('../utils/audit');
var CD = require('../utils/callDataCsv');

var router = express.Router();

var MAX_BATCH = 2000;     // rows per POST from the browser
var CHUNK = 500;          // rows per INSERT; 500 x 14 params = 7,000 (< 65,535)
var PER_ROW = 14;

function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1) + '-' +
      (d.getDate() < 10 ? '0' : '') + d.getDate();
  }
  return String(d).slice(0, 10);
}
function list(v) {
  if (v == null || v === '') return [];
  return String(v).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function isAdmin(req) { return req.user && (req.user.role === 'admin' || req.user.role === 'owner'); }

/* ---------------------------------------------------------------- filters */

// Typed columns a client may sort or filter on by name. Anything else is
// treated as an export column and read out of data with a bound parameter,
// so no client string is ever spliced into SQL.
var TYPED = {
  call_uid: 'call_uid', call_at: 'call_at', call_date: 'call_date', location: 'location',
  task: 'task', tech: 'tech', status: 'status', account: 'account', ata_mins: 'ata_mins',
  onsite_mins: 'onsite_mins', revenue: 'revenue', updated_at: 'updated_at'
};

/*
 * Query string -> WHERE clause. Shared by rows, export, summary and the Nova
 * tools so a filter means the same thing on every screen.
 *   from, to       YYYY-MM-DD on the call date (inclusive)
 *   location       comma list, exact
 *   status         comma list, exact (case-insensitive)
 *   tech, task, account   contains, case-insensitive
 *   q              anywhere in the row
 *   col + val (+ op)  one export column: contains (default) | equals | empty | notempty
 */
function buildWhere(q, params) {
  var w = [];
  function p(v) { params.push(v); return '$' + params.length; }
  if (isYmd(q.from)) w.push('call_date >= ' + p(q.from));
  if (isYmd(q.to)) w.push('call_date <= ' + p(q.to));
  var locs = list(q.location);
  if (locs.length) w.push('location = ANY(' + p(locs) + ')');
  var sts = list(q.status).map(function (s) { return s.toLowerCase(); });
  if (sts.length) w.push('LOWER(status) = ANY(' + p(sts) + ')');
  ['tech', 'task', 'account'].forEach(function (k) {
    if (q[k]) w.push(k + ' ILIKE ' + p('%' + String(q[k]).trim() + '%'));
  });
  if (q.q) w.push('data::text ILIKE ' + p('%' + String(q.q).trim() + '%'));
  if (q.col) {
    var op = String(q.op || 'contains');
    var c = p(String(q.col));
    if (op === 'empty') w.push("COALESCE(data->>" + c + ", '') = ''");
    else if (op === 'notempty') w.push("COALESCE(data->>" + c + ", '') <> ''");
    else if (op === 'equals') w.push('LOWER(data->>' + c + ') = LOWER(' + p(String(q.val == null ? '' : q.val)) + ')');
    else if (q.val != null && q.val !== '') w.push('data->>' + c + ' ILIKE ' + p('%' + String(q.val) + '%'));
  }
  return w.length ? (' WHERE ' + w.join(' AND ')) : '';
}

function orderBy(q, params) {
  var dir = String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  var s = String(q.sort || 'call_at');
  if (TYPED[s]) return ' ORDER BY ' + TYPED[s] + ' ' + dir + ' NULLS LAST, id ' + dir;
  params.push(s);
  return ' ORDER BY data->>$' + params.length + ' ' + dir + ' NULLS LAST, id ' + dir;
}

/* ------------------------------------------------------------------- meta */

router.get('/meta', requireAuth, requirePermission('view_call_data'), async function (req, res) {
  try {
    var tot = await pool.query(
      'SELECT COUNT(*)::int AS calls, MIN(call_date) AS first_date, MAX(call_date) AS last_date, ' +
      '       MAX(updated_at) AS last_change FROM cd_calls');
    var cols = await pool.query('SELECT name, position FROM cd_columns ORDER BY position, first_seen, name');
    var locs = await pool.query(
      'SELECT location AS name, COUNT(*)::int AS calls FROM cd_calls WHERE location IS NOT NULL ' +
      ' GROUP BY location ORDER BY calls DESC LIMIT 200');
    var sts = await pool.query(
      'SELECT status AS name, COUNT(*)::int AS calls FROM cd_calls WHERE status IS NOT NULL ' +
      ' GROUP BY status ORDER BY calls DESC LIMIT 50');
    var imps = await pool.query(
      'SELECT id, filename, uploaded_by_name, total_rows, inserted_rows, updated_rows, unchanged_rows, ' +
      '       skipped_rows, first_date, last_date, status, mapping, created_at, finished_at ' +
      '  FROM cd_imports ORDER BY created_at DESC LIMIT 25');
    var t = tot.rows[0];
    res.json({
      calls: t.calls,
      first_date: ymd(t.first_date),
      last_date: ymd(t.last_date),
      last_change: t.last_change,
      columns: cols.rows.map(function (r) { return r.name; }),
      locations: locs.rows,
      statuses: sts.rows,
      imports: imps.rows.map(function (r) {
        r.first_date = ymd(r.first_date); r.last_date = ymd(r.last_date); return r;
      }),
      canImport: isAdmin(req) || await hasPerm(req, 'manage_call_data'),
      canSql: isAdmin(req)
    });
  } catch (e) {
    console.error('call-data meta', e);
    res.status(500).json({ error: 'Could not load call data.' });
  }
});

async function hasPerm(req, perm) {
  try {
    var permissions = require('../utils/permissions');
    if (await permissions.hasPermission(req.user.role, perm)) return true;
  } catch (e) {}
  try {
    var r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    var ep = r.rows[0] && r.rows[0].extra_perms;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (e) { return false; }
}

/* ------------------------------------------------------------------- rows */

router.get('/rows', requireAuth, requirePermission('view_call_data'), async function (req, res) {
  try {
    var q = req.query;
    var limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 500);
    var page = Math.max(parseInt(q.page, 10) || 1, 1);
    var params = [];
    var where = buildWhere(q, params);
    var cnt = await pool.query('SELECT COUNT(*)::int AS n FROM cd_calls' + where, params);
    var p2 = params.slice();
    var ord = orderBy(q, p2);
    p2.push(limit); var lim = '$' + p2.length;
    p2.push((page - 1) * limit); var off = '$' + p2.length;
    var r = await pool.query(
      'SELECT id, call_uid, data FROM cd_calls' + where + ord + ' LIMIT ' + lim + ' OFFSET ' + off, p2);
    res.json({ total: cnt.rows[0].n, page: page, limit: limit, rows: r.rows });
  } catch (e) {
    console.error('call-data rows', e);
    res.status(500).json({ error: 'Could not load calls.' });
  }
});

/* ----------------------------------------------------------------- export */

function csvCell(v) {
  var s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// The filtered rows, every export column, in the order Pulsar sent them.
// Read in id-keyset pages so a three-year export never sits in memory at once.
router.get('/export', requireAuth, requirePermission('view_call_data'), async function (req, res) {
  try {
    var cols = (await pool.query('SELECT name FROM cd_columns ORDER BY position, first_seen, name'))
      .rows.map(function (r) { return r.name; });
    var params = [];
    var where = buildWhere(req.query, params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="pulsar-call-data-' +
      new Date().toISOString().slice(0, 10) + '.csv"');
    res.write('﻿' + cols.map(csvCell).join(',') + '\r\n');
    var last = 0;
    for (;;) {
      var p2 = params.slice();
      p2.push(last);
      var r = await pool.query(
        'SELECT id, data FROM cd_calls' + (where ? where + ' AND ' : ' WHERE ') + 'id > $' + p2.length +
        ' ORDER BY id LIMIT 5000', p2);
      if (!r.rows.length) break;
      var buf = '';
      r.rows.forEach(function (row) {
        buf += cols.map(function (c) { return csvCell(row.data[c]); }).join(',') + '\r\n';
      });
      res.write(buf);
      last = r.rows[r.rows.length - 1].id;
      if (r.rows.length < 5000) break;
    }
    res.end();
  } catch (e) {
    console.error('call-data export', e);
    if (!res.headersSent) res.status(500).json({ error: 'Export failed.' });
    else res.end();
  }
});

/* ---------------------------------------------------------------- summary */

var PERIOD = {
  day: 'call_date',
  week: "date_trunc('week', call_date)::date",
  month: "date_trunc('month', call_date)::date",
  quarter: "date_trunc('quarter', call_date)::date",
  year: "date_trunc('year', call_date)::date",
  none: 'NULL::date'
};
var SERVICE_SQL =
  "CASE WHEN LOWER(COALESCE(task,'')) ~ '(^|\\.)ls(\\.|$)' THEN 'Locksmith' " +
  "     WHEN LOWER(COALESCE(task,'')) ~ '(^|\\.)bat(\\.|$)' THEN 'Battery' " +
  "     ELSE 'Roadside' END";
var BY = {
  none: "'All'",
  location: "COALESCE(location, '(blank)')",
  tech: "COALESCE(tech, '(blank)')",
  task: "COALESCE(task, '(blank)')",
  status: "COALESCE(status, '(blank)')",
  account: "COALESCE(account, '(blank)')",
  service: SERVICE_SQL,
  dow: "to_char(call_at, 'ID Dy')",
  hour: "to_char(call_at, 'HH24') || ':00'"
};

async function summary(q) {
  var params = [];
  var where = buildWhere(q, params);
  var per = PERIOD[q.group] || PERIOD.week;
  var by;
  if (q.by === 'col' && q.byCol) { params.push(String(q.byCol)); by = "COALESCE(NULLIF(data->>$" + params.length + ", ''), '(blank)')"; }
  else by = BY[q.by] || BY.location;
  var sql =
    'SELECT ' + per + ' AS period, ' + by + ' AS key, ' +
    '  COUNT(*)::int AS calls, ' +
    "  COUNT(*) FILTER (WHERE status ILIKE 'complete%')::int AS completed, " +
    "  COUNT(*) FILTER (WHERE status ILIKE 'goa%')::int AS goa, " +
    "  COUNT(*) FILTER (WHERE status ILIKE 'cancel%')::int AS canceled, " +
    '  ROUND(COALESCE(SUM(revenue), 0), 2)::float8 AS revenue, ' +
    '  ROUND(AVG(ata_mins) FILTER (WHERE ata_mins > 0), 1)::float8 AS ata_avg, ' +
    '  ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY ata_mins) FILTER (WHERE ata_mins > 0))::numeric, 1)::float8 AS ata_median, ' +
    '  ROUND((percentile_cont(0.9) WITHIN GROUP (ORDER BY ata_mins) FILTER (WHERE ata_mins > 0))::numeric, 1)::float8 AS ata_p90, ' +
    '  ROUND(AVG(onsite_mins) FILTER (WHERE onsite_mins > 0), 1)::float8 AS onsite_avg, ' +
    '  ROUND((percentile_cont(0.5) WITHIN GROUP (ORDER BY onsite_mins) FILTER (WHERE onsite_mins > 0))::numeric, 1)::float8 AS onsite_median ' +
    'FROM cd_calls' + where +
    ' GROUP BY 1, 2 ORDER BY 1 DESC NULLS LAST, calls DESC LIMIT 5000';
  var r = await pool.query(sql, params);
  return r.rows.map(function (row) { row.period = ymd(row.period); return row; });
}

router.get('/summary', requireAuth, requirePermission('view_call_data'), async function (req, res) {
  try { res.json({ rows: await summary(req.query) }); }
  catch (e) {
    console.error('call-data summary', e);
    res.status(500).json({ error: 'Could not build the summary.' });
  }
});

/* --------------------------------------------------------------------- sql */

/*
 * Free-form read-only SQL for evaluation (admin/owner only). Guarded four ways:
 *   1. one SELECT/WITH statement, wrapped as a subquery with a row cap;
 *   2. it may not name any table outside cd_*, any system catalog, or any
 *      function that reaches outside the database;
 *   3. it runs in a READ ONLY transaction with a 20-second timeout;
 *   4. it is audited.
 * The point is "ask a question of the call data", not a database console.
 */
var BLOCKED = /\b(pg_[a-z_]*|information_schema|dblink\w*|lo_\w+|copy|current_setting|set_config|query_to_xml\w*|xpath)\b|u&|\$\$/i;

async function runSql(sql) {
  var s = String(sql || '').trim().replace(/;\s*$/, '');
  if (!s) throw new Error('No query.');
  if (s.length > 8000) throw new Error('Query is too long.');
  if (s.indexOf(';') !== -1) throw new Error('One statement only.');
  if (!/^(select|with)\b/i.test(s)) throw new Error('Only SELECT (or WITH ... SELECT) is allowed.');
  if (BLOCKED.test(s)) throw new Error('That query touches something outside the call data.');
  var tabs = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') " +
    "UNION SELECT viewname FROM pg_views WHERE schemaname NOT IN ('pg_catalog','information_schema')");
  var lower = s.toLowerCase();
  for (var i = 0; i < tabs.rows.length; i++) {
    var t = String(tabs.rows[i].tablename).toLowerCase();
    if (t.indexOf('cd_') === 0) continue;
    var re = new RegExp('(^|[^a-z0-9_])' + t.replace(/[^a-z0-9_]/g, '') + '([^a-z0-9_]|$)');
    if (re.test(lower)) throw new Error('Only the call data tables (cd_calls, cd_imports, cd_columns) can be queried. "' + t + '" is not one of them.');
  }
  var client = await pool.connect();
  var t0 = Date.now();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '20s'");
    var r = await client.query('SELECT * FROM (' + s + '\n) AS _cdq LIMIT 2001');
    await client.query('ROLLBACK');
    var rows = r.rows;
    var truncated = rows.length > 2000;
    if (truncated) rows = rows.slice(0, 2000);
    return { columns: r.fields.map(function (f) { return f.name; }), rows: rows, truncated: truncated, ms: Date.now() - t0 };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

router.post('/sql', requireAuth, async function (req, res) {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin or owner only.' });
  var sql = req.body && req.body.sql;
  try {
    var out = await runSql(sql);
    logAudit({ entity_type: 'call_data', action: 'sql_query', user_id: req.user.id, user_name: req.user.name,
      details: { sql: String(sql).slice(0, 2000), rows: out.rows.length }, ip: req.ip });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Query failed.' });
  }
});

/* ----------------------------------------------------------------- import */

/*
 * POST /imports  { filename, columns: [...headers], total_rows }
 * Opens an import, records the column layout, and says which columns feed the
 * typed fields. Refuses a file with no Call UID column: without the key there
 * is no way to tell a re-import from a duplicate.
 */
router.post('/imports', requireAuth, requirePermission('manage_call_data'), async function (req, res) {
  var b = req.body || {};
  var columns = Array.isArray(b.columns) ? b.columns.map(function (c) { return String(c == null ? '' : c).trim(); }) : [];
  var named = columns.filter(Boolean);
  if (!named.length) return res.status(400).json({ error: 'The file has no header row.' });
  var mapping = CD.detectColumns(columns);
  if (!mapping.uid) {
    return res.status(400).json({ error: 'No "Call UID" column in this export. Add Call UID to the Call Search columns in Pulsar and export again; it is how Nova tells a re-import from a new call.' });
  }
  try {
    var ins = await pool.query(
      'INSERT INTO cd_imports (filename, uploaded_by, uploaded_by_name, columns, mapping, total_rows) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [String(b.filename || 'callsearch.csv').slice(0, 255), req.user.id, req.user.name || null,
       JSON.stringify(named), JSON.stringify(mapping), parseInt(b.total_rows, 10) || 0]);
    var vals = [], params = [];
    named.forEach(function (c, i) {
      params.push(c.slice(0, 255), i);
      vals.push('($' + (params.length - 1) + ', $' + params.length + ')');
    });
    await pool.query(
      'INSERT INTO cd_columns (name, position) VALUES ' + vals.join(',') +
      ' ON CONFLICT (name) DO UPDATE SET last_seen = NOW()', params);
    res.status(201).json({ id: ins.rows[0].id, mapping: mapping });
  } catch (e) {
    console.error('call-data import open', e);
    res.status(500).json({ error: 'Could not start the import.' });
  }
});

/*
 * POST /imports/:id/rows  { rows: [ {header: value, ...}, ... ] }
 * One batch, one transaction. Returns what it did: new, changed, unchanged,
 * skipped (no Call UID).
 */
router.post('/imports/:id/rows', requireAuth, requirePermission('manage_call_data'), async function (req, res) {
  var id = parseInt(req.params.id, 10);
  var rows = req.body && req.body.rows;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'No rows.' });
  if (rows.length > MAX_BATCH) return res.status(400).json({ error: 'At most ' + MAX_BATCH + ' rows per batch.' });
  var imp = await pool.query('SELECT id, mapping, status FROM cd_imports WHERE id = $1', [id]);
  if (!imp.rows.length) return res.status(404).json({ error: 'Import not found.' });
  if (imp.rows[0].status !== 'running') return res.status(409).json({ error: 'That import is already finished.' });
  try {
    var out = await upsertBatch(id, imp.rows[0].mapping || {}, rows);
    res.json(out);
  } catch (e) {
    console.error('call-data batch', e);
    res.status(500).json({ error: 'A batch failed to save: ' + (e.message || 'unknown error') });
  }
});

async function upsertBatch(importId, mapping, rows) {
  var skipped = 0;
  var byUid = new Map();
  rows.forEach(function (raw) {
    var r = CD.interpret(raw, mapping);
    if (!r.uid) { skipped++; return; }
    var prev = byUid.get(r.uid);
    if (prev) {
      // Same call twice in one batch: merge like the database would, newest wins.
      r.data = Object.assign({}, prev.data, r.data);
      ['call_at', 'call_date', 'location', 'task', 'tech', 'status', 'account', 'ata_mins', 'onsite_mins', 'revenue']
        .forEach(function (k) { if (r[k] == null) r[k] = prev[k]; });
    }
    byUid.set(r.uid, r);
  });
  var items = Array.from(byUid.values());
  var inserted = 0, updated = 0, minD = null, maxD = null;
  items.forEach(function (r) {
    if (r.call_date) {
      if (!minD || r.call_date < minD) minD = r.call_date;
      if (!maxD || r.call_date > maxD) maxD = r.call_date;
    }
  });

  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (var i = 0; i < items.length; i += CHUNK) {
      var part = items.slice(i, i + CHUNK);
      var vals = [], params = [];
      part.forEach(function (r) {
        params.push(r.uid, JSON.stringify(r.data), r.call_at, r.call_date, r.location, r.task, r.tech,
          r.status, r.account, r.ata_mins, r.onsite_mins, r.revenue, importId, importId);
        var b = params.length - PER_ROW, ph = [];
        for (var k = 1; k <= PER_ROW; k++) ph.push('$' + (b + k));
        vals.push('(' + ph.join(',') + ')');
      });
      var q =
        'INSERT INTO cd_calls (call_uid, data, call_at, call_date, location, task, tech, status, account, ' +
        '  ata_mins, onsite_mins, revenue, import_id, first_import_id) VALUES ' + vals.join(',') +
        ' ON CONFLICT (call_uid) DO UPDATE SET ' +
        '  data = cd_calls.data || EXCLUDED.data, ' +
        '  call_at = COALESCE(EXCLUDED.call_at, cd_calls.call_at), ' +
        '  call_date = COALESCE(EXCLUDED.call_date, cd_calls.call_date), ' +
        '  location = COALESCE(EXCLUDED.location, cd_calls.location), ' +
        '  task = COALESCE(EXCLUDED.task, cd_calls.task), ' +
        '  tech = COALESCE(EXCLUDED.tech, cd_calls.tech), ' +
        '  status = COALESCE(EXCLUDED.status, cd_calls.status), ' +
        '  account = COALESCE(EXCLUDED.account, cd_calls.account), ' +
        '  ata_mins = COALESCE(EXCLUDED.ata_mins, cd_calls.ata_mins), ' +
        '  onsite_mins = COALESCE(EXCLUDED.onsite_mins, cd_calls.onsite_mins), ' +
        '  revenue = COALESCE(EXCLUDED.revenue, cd_calls.revenue), ' +
        '  import_id = EXCLUDED.import_id, updated_at = NOW() ' +
        // Only touch a row when the merged data actually differs. That is what
        // makes "unchanged" a real number rather than a guess.
        ' WHERE (cd_calls.data || EXCLUDED.data) IS DISTINCT FROM cd_calls.data ' +
        ' RETURNING (xmax = 0) AS inserted';
      var r = await client.query(q, params);
      r.rows.forEach(function (x) { if (x.inserted) inserted++; else updated++; });
    }
    var unchanged = items.length - inserted - updated;
    await client.query(
      'UPDATE cd_imports SET inserted_rows = inserted_rows + $1, updated_rows = updated_rows + $2, ' +
      '  unchanged_rows = unchanged_rows + $3, skipped_rows = skipped_rows + $4, ' +
      '  first_date = LEAST(first_date, $5::date), last_date = GREATEST(last_date, $6::date) WHERE id = $7',
      [inserted, updated, unchanged, skipped, minD, maxD, importId]);
    await client.query('COMMIT');
    return { inserted: inserted, updated: updated, unchanged: unchanged, skipped: skipped, duplicates: rows.length - skipped - items.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

router.post('/imports/:id/finish', requireAuth, requirePermission('manage_call_data'), async function (req, res) {
  var id = parseInt(req.params.id, 10);
  var status = (req.body && req.body.status === 'partial') ? 'partial' : 'done';
  try {
    var r = await pool.query(
      "UPDATE cd_imports SET status = $1, finished_at = NOW() WHERE id = $2 AND status = 'running' RETURNING *", [status, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Import not found or already finished.' });
    var x = r.rows[0];
    logAudit({
      entity_type: 'call_data_import', entity_id: id,
      entity_number: (ymd(x.first_date) || '?') + ' to ' + (ymd(x.last_date) || '?'),
      action: status === 'done' ? 'imported' : 'import_partial',
      user_id: req.user.id, user_name: req.user.name,
      details: { filename: x.filename, rows: x.total_rows, inserted: x.inserted_rows, updated: x.updated_rows,
                 unchanged: x.unchanged_rows, skipped: x.skipped_rows },
      ip: req.ip
    });
    x.first_date = ymd(x.first_date); x.last_date = ymd(x.last_date);
    res.json(x);
  } catch (e) {
    console.error('call-data finish', e);
    res.status(500).json({ error: 'Could not finish the import.' });
  }
});

module.exports = router;
module.exports._test = { buildWhere: buildWhere, runSql: runSql, summary: summary, upsertBatch: upsertBatch };
