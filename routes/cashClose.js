// routes/cashClose.js  (mounted at /api/cash-close)
// ---------------------------------------------------------------------------
// Weekly Cash Close (2026-09-27). One screen per pay week (Mon-Sun) that walks
// the person closing the week through:
//   1. Import the Pulsar Call Search export   (routes/pulsar.js, strict mode)
//   2. Link Pulsar names and map Pulsar tasks to a class
//   3. Review expenses: category + class + approve/deny (routes/deposits.js)
//   4. Reconcile cash per tech               (the existing Pulsar reconciliation)
//   5. Export the QuickBooks journal entries and close the week
// The accounting lives in utils/qboJournal.js (pure). This file loads rows,
// gates, freezes a closed week and unfreezes it on an admin reopen.
//
// Gate: weekly_cash_close (ships dark, CLAUDE.md 1.5) AND a manage role, since
// every step underneath already requires admin/manager. Editing the account
// mapping is admin/owner only; mapping a Pulsar task to a class is allowed to
// anyone who can close the week, because the week cannot close without it.
// House style: string concatenation, no template literals.
// ---------------------------------------------------------------------------

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var { logAudit } = require('../utils/audit');
var qbo = require('../utils/qboJournal');
var { editCityScope, scopeAllows } = require('../utils/depositAccess');

var router = express.Router();
var MANAGE = ['admin', 'manager'];

function manageOnly(req, res, next) {
  if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  next();
}
var gate = [requireAuth, requirePermission('weekly_cash_close'), manageOnly];

function ymdOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function addDays(ymd, n) {
  var d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isMonday(ymd) { return ymdOk(ymd) && new Date(ymd + 'T12:00:00Z').getUTCDay() === 1; }
function mondayOf(ymd) {
  var d = new Date(ymd + 'T12:00:00Z');
  var dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function weekParam(req, res) {
  var w = String(req.params.week || '');
  if (!isMonday(w)) { res.status(400).json({ error: 'Week must be a Monday (YYYY-MM-DD).' }); return null; }
  return w;
}

// The pay week a deposit belongs to. period_start is set on every deposit filed
// through the current form; the fallback only covers very old rows.
var DEP_WEEK = "COALESCE(d.period_start, (d.deposit_date - (EXTRACT(ISODOW FROM d.deposit_date)::int - 1)))";

async function cityNames() {
  var r = await pool.query('SELECT code, name FROM cities ORDER BY name');
  var map = {};
  r.rows.forEach(function (c) { map[String(c.code).toUpperCase()] = c.name; });
  return { map: map, list: r.rows };
}

async function weekRow(w) {
  var r = await pool.query('SELECT * FROM cash_weeks WHERE week_start = $1', [w]);
  return r.rows.length ? r.rows[0] : null;
}

// Everything utils/qboJournal.buildWeek needs for week w, plus the extras the
// screen shows (expense queue, unlinked names, unmapped tasks, KPIs).
async function loadWeek(w, cfg) {
  var wEnd = addDays(w, 6);
  var closed = (await pool.query("SELECT week_start::text AS w FROM cash_weeks WHERE status = 'closed'")).rows.map(function (r) { return r.w; });

  var deps = (await pool.query(
    "SELECT d.id, d.deposit_number, to_char(d.deposit_date, 'YYYY-MM-DD') AS deposit_date, d.amount, d.city_code, d.user_id, " +
    '  COALESCE(u.name, d.user_name) AS user_name, to_char(' + DEP_WEEK + ", 'YYYY-MM-DD') AS week_start, d.qbo_export_batch " +
    'FROM deposits d LEFT JOIN users u ON u.id = d.user_id ' +
    'WHERE (' + DEP_WEEK + ' = $1::date AND (d.qbo_export_batch IS NULL OR d.qbo_export_batch = $2)) ' +
    '   OR (' + DEP_WEEK + ' < $1::date AND to_char(' + DEP_WEEK + ", 'YYYY-MM-DD') = ANY($3::text[]) " +
    '       AND (d.qbo_export_batch IS NULL OR d.qbo_export_batch = $2)) ' +
    'ORDER BY d.deposit_number',
    [w, w, closed]
  )).rows;
  var orphanDeposits = deps.filter(function (d) { return !d.user_id; });
  deps = deps.filter(function (d) { return !!d.user_id; });

  var ids = deps.map(function (d) { return d.id; });
  var exRows = ids.length ? (await pool.query(
    "SELECT e.id, e.deposit_id, e.description, e.amount, e.category, e.qbo_class, COALESCE(e.review_status, 'pending') AS review_status, " +
    '  e.review_reason, e.reviewed_by_name, COALESCE(e.no_receipt, FALSE) AS no_receipt, e.no_receipt_reason, ' +
    '  (e.receipt_image IS NOT NULL) AS has_photo, e.file_name ' +
    'FROM deposit_expenses e WHERE e.deposit_id = ANY($1::int[]) ORDER BY e.id',
    [ids]
  )).rows : [];
  var exBy = {};
  exRows.forEach(function (e) { (exBy[e.deposit_id] = exBy[e.deposit_id] || []).push(e); });
  deps.forEach(function (d) { d.expenses = exBy[d.id] || []; });

  var weeks = [w];
  deps.forEach(function (d) { if (weeks.indexOf(d.week_start) === -1) weeks.push(d.week_start); });
  var calls = (await pool.query(
    "SELECT to_char(period_start, 'YYYY-MM-DD') AS week_start, tech_user_id, task, cash, tax, city_code " +
    'FROM pulsar_cash_calls WHERE period_start = ANY($1::date[])',
    [weeks]
  )).rows;

  var unlinked = (await pool.query(
    'SELECT tech_raw, MIN(tech_display) AS tech_display, COUNT(*)::int AS calls, COALESCE(SUM(cash), 0) AS cash, MIN(city_code) AS city_code ' +
    'FROM pulsar_cash_calls WHERE period_start = $1 AND tech_user_id IS NULL GROUP BY tech_raw ORDER BY 4 DESC',
    [w]
  )).rows;

  var held = (await pool.query(
    "SELECT id, to_char(week_start, 'YYYY-MM-DD') AS week_start, user_id, amount FROM cash_close_held " +
    'WHERE cleared_in_week IS NULL OR cleared_in_week = $1',
    [w]
  )).rows;

  var uids = {};
  deps.forEach(function (d) { uids[d.user_id] = true; });
  calls.forEach(function (c) { if (c.tech_user_id) uids[c.tech_user_id] = true; });
  var users = {};
  var uList = Object.keys(uids).map(function (x) { return parseInt(x, 10); });
  if (uList.length) {
    (await pool.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [uList])).rows
      .forEach(function (u) { users[u.id] = u.name; });
  }

  var cities = await cityNames();
  var built = qbo.buildWeek({
    week_start: w, week_end: wEnd, config: cfg, city_names: cities.map,
    calls: calls, deposits: deps, held: held, users: users
  });

  // Unmapped Pulsar tasks this week (with an example so it can be recognised).
  var tasks = {};
  calls.forEach(function (c) {
    if (c.week_start !== w) return;
    var k = qbo.taskKey(c.task) || '(blank)';
    if (!tasks[k]) tasks[k] = { task: c.task || '', calls: 0, cash: 0, cls: qbo.classForTask(c.task, cfg), group: qbo.royaltyGroup(c.task) };
    tasks[k].calls++;
    tasks[k].cash += parseFloat(c.cash) || 0;
  });
  var taskList = Object.keys(tasks).map(function (k) {
    var t = tasks[k];
    return { task: t.task, calls: t.calls, cash: Math.round(t.cash * 100) / 100, cls: t.cls.cls, source: t.cls.source, group: t.group };
  }).sort(function (a, b) { return b.cash - a.cash; });

  // The expense queue: every line on this close's deposits.
  var depById = {};
  deps.forEach(function (d) { depById[d.id] = d; });
  var queue = exRows.map(function (e) {
    var d = depById[e.deposit_id];
    return {
      id: e.id, deposit_id: e.deposit_id, deposit_number: d.deposit_number, user_name: d.user_name, city_code: d.city_code,
      late: d.week_start !== w, description: e.description, amount: e.amount, category: e.category, qbo_class: e.qbo_class,
      review_status: e.review_status, review_reason: e.review_reason, reviewed_by_name: e.reviewed_by_name,
      no_receipt: e.no_receipt, no_receipt_reason: e.no_receipt_reason, has_photo: e.has_photo, file_name: e.file_name
    };
  });

  var imp = (await pool.query(
    'SELECT id, filename, cash_rows, cash_total, uploaded_by_name, created_at FROM pulsar_imports WHERE period_start = $1 ORDER BY created_at DESC LIMIT 1',
    [w]
  )).rows[0] || null;

  // KPIs
  var pulsarCash = 0;
  calls.forEach(function (c) { if (c.week_start === w && c.tech_user_id) pulsarCash += qbo.toCents(c.cash); });
  unlinked.forEach(function (u) { pulsarCash += qbo.toCents(u.cash); });
  var claimed = 0;
  deps.forEach(function (d) {
    if (d.week_start !== w) return;
    claimed += qbo.toCents(d.amount);
    d.expenses.forEach(function (e) { if (e.review_status !== 'denied') claimed += qbo.toCents(e.amount); });
  });

  return {
    week_end: wEnd, built: built, queue: queue, unlinked: unlinked, tasks: taskList, import: imp,
    orphan_deposits: orphanDeposits.map(function (d) { return d.deposit_number; }),
    kpis: {
      pulsar_cash: pulsarCash,
      claimed: claimed,
      pending_expenses: queue.filter(function (q) { return q.review_status === 'pending'; }).length,
      no_deposit: built.units.filter(function (u) { return u.kind === 'held'; }).length,
      late_deposits: built.units.filter(function (u) { return u.kind === 'late'; }).length
    }
  };
}

function stepsFor(data, row) {
  var units = data.built.units;
  var unmapped = data.tasks.filter(function (t) { return !t.cls; });
  var expenseIssues = units.some(function (u) {
    return u.problems.some(function (p) { return /expense|category|class\.$/i.test(p) && !/Pulsar task/.test(p); });
  });
  var state = (row && row.state) || {};
  return {
    imported: !!data.import,
    names_tasks: !!data.import && !data.unlinked.length && !unmapped.length,
    expenses: data.kpis.pending_expenses === 0 && !expenseIssues,
    reconciled: !!state.reconciled_at,
    reconciled_by: state.reconciled_by_name || null,
    closed: !!(row && row.status === 'closed')
  };
}

/* ----------------------------------------------------------- routes --- */

// Category + class lists for the expense review dropdowns (deposit page too).
router.get('/categories', requireAuth, requirePermission('view_deposits'), async function (req, res) {
  try {
    var cfg = await qbo.loadConfig(pool);
    res.json({
      categories: cfg.categories.map(function (c) { return { key: c.key, label: c.label }; }),
      classes: cfg.classes
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load expense categories' });
  }
});

// The last 12 pay weeks with their status, for the week picker.
router.get('/weeks', gate, async function (req, res) {
  try {
    var today = new Date().toISOString().slice(0, 10);
    var cur = mondayOf(today);
    var list = [];
    for (var i = 1; i <= 12; i++) list.push(addDays(cur, -7 * i));
    var rows = (await pool.query(
      "SELECT week_start::text AS w, status, closed_at, closed_by_name FROM cash_weeks WHERE week_start = ANY($1::date[])", [list]
    )).rows;
    var imps = (await pool.query(
      "SELECT DISTINCT period_start::text AS w FROM pulsar_imports WHERE period_start = ANY($1::date[])", [list]
    )).rows.map(function (r) { return r.w; });
    var byW = {};
    rows.forEach(function (r) { byW[r.w] = r; });
    res.json(list.map(function (w) {
      var r = byW[w];
      return { week_start: w, week_end: addDays(w, 6), status: r ? r.status : 'open', closed_at: r ? r.closed_at : null,
        closed_by_name: r ? r.closed_by_name : null, imported: imps.indexOf(w) !== -1 };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load weeks' });
  }
});

router.get('/week/:week', gate, async function (req, res) {
  var w = weekParam(req, res); if (!w) return;
  try {
    var cfg = await qbo.loadConfig(pool);
    var row = await weekRow(w);
    if (row && row.status === 'closed') {
      var snap = row.snapshot || {};
      return res.json({
        week_start: w, week_end: addDays(w, 6), status: 'closed',
        closed_at: row.closed_at, closed_by_name: row.closed_by_name,
        units: snap.units || [], totals: snap.totals || [], kpis: snap.kpis || {}, import: snap.import || null,
        steps: { imported: true, names_tasks: true, expenses: true, reconciled: true, closed: true },
        classes: cfg.classes, can_reopen: req.user.role === 'admin'
      });
    }
    var data = await loadWeek(w, cfg);
    // Expense review is city-scoped for managers (routes/deposits.js), so the
    // queue says up front which lines this person can decide.
    var scope = await editCityScope(req);
    data.queue.forEach(function (q) { q.can_review = scopeAllows(scope, q.city_code); });
    var activeUsers = (await pool.query('SELECT id, name FROM users WHERE active = true ORDER BY name')).rows;
    res.json({
      week_start: w, week_end: data.week_end, status: 'open',
      reopened_at: row ? row.reopened_at : null, reopened_by_name: row ? row.reopened_by_name : null, reopen_reason: row ? row.reopen_reason : null,
      import: data.import, kpis: data.kpis, steps: stepsFor(data, row),
      unlinked: data.unlinked, tasks: data.tasks, queue: data.queue, orphan_deposits: data.orphan_deposits,
      units: data.built.units, totals: data.built.totals, config_problems: data.built.problems,
      classes: cfg.classes, categories: cfg.categories.map(function (c) { return { key: c.key, label: c.label }; }),
      users: activeUsers, can_edit_mapping: req.user.role === 'admin'
    });
  } catch (err) {
    console.error('Cash close week error:', err);
    res.status(500).json({ error: 'Failed to load the week' });
  }
});

// Step 4 sign-off: "I have been through the reconciliation".
router.put('/week/:week/reconciled', gate, async function (req, res) {
  var w = weekParam(req, res); if (!w) return;
  try {
    var row = await weekRow(w);
    if (row && row.status === 'closed') return res.status(409).json({ error: 'That week is closed.' });
    var state = (row && row.state) || {};
    if (req.body && req.body.done === false) {
      delete state.reconciled_at; delete state.reconciled_by_name;
    } else {
      state.reconciled_at = new Date().toISOString();
      state.reconciled_by_name = req.user.name;
    }
    await pool.query(
      'INSERT INTO cash_weeks (week_start, state, updated_at) VALUES ($1, $2, NOW()) ' +
      'ON CONFLICT (week_start) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()',
      [w, JSON.stringify(state)]
    );
    res.json({ success: true, state: state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save' });
  }
});

// Map one Pulsar task to a class (step 2). '' removes the mapping.
router.put('/task-class', gate, async function (req, res) {
  try {
    var task = String((req.body && req.body.task) || '').trim();
    var cls = String((req.body && req.body.cls) || '').trim();
    if (!task) return res.status(400).json({ error: 'Task is required.' });
    var cfg = await qbo.loadConfig(pool);
    if (cls && cfg.classes.indexOf(cls) === -1) return res.status(400).json({ error: 'Unknown class "' + cls + '".' });
    var k = qbo.taskKey(task);
    var before = cfg.task_classes[k] || null;
    if (cls) cfg.task_classes[k] = cls; else delete cfg.task_classes[k];
    await qbo.saveConfig(pool, cfg);
    await logAudit({ entity_type: 'setting', entity_id: null, entity_number: 'qbo_task_class', action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: { task: task, from: before, to: cls || null } });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save the task mapping' });
  }
});

router.get('/config', gate, async function (req, res) {
  try {
    var cfg = await qbo.loadConfig(pool);
    var cities = await cityNames();
    var t = (await pool.query(
      "SELECT task, COUNT(*)::int AS calls, COALESCE(SUM(cash), 0) AS cash FROM pulsar_cash_calls " +
      "WHERE call_date >= (CURRENT_DATE - INTERVAL '90 days') GROUP BY task ORDER BY 2 DESC"
    )).rows;
    var seen = {};
    var tasks = [];
    t.forEach(function (r) {
      var k = qbo.taskKey(r.task) || '(blank)';
      if (seen[k]) { seen[k].calls += r.calls; return; }
      var c = qbo.classForTask(r.task, cfg);
      seen[k] = { task: r.task || '', calls: r.calls, group: qbo.royaltyGroup(r.task), cls: c.cls, source: c.source };
      tasks.push(seen[k]);
    });
    // Mapped tasks not seen lately still show, so a mapping can be undone.
    Object.keys(cfg.task_classes).forEach(function (k) {
      if (seen[k]) return;
      tasks.push({ task: k, calls: 0, group: qbo.royaltyGroup(k), cls: cfg.task_classes[k], source: 'mapped' });
    });
    res.json({ config: cfg, cities: cities.list, tasks: tasks, problems: qbo.configProblems(cfg), can_edit: req.user.role === 'admin' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the QuickBooks mapping' });
  }
});

router.put('/config', gate, async function (req, res) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can change the QuickBooks mapping.' });
  try {
    var before = await qbo.loadConfig(pool);
    var saved = await qbo.saveConfig(pool, req.body && req.body.config);
    await logAudit({ entity_type: 'setting', entity_id: null, entity_number: qbo.SETTINGS_KEY, action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: { before: before, after: saved } });
    res.json({ config: saved, problems: qbo.configProblems(saved) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save the QuickBooks mapping' });
  }
});

// The CSV for QuickBooks' "Import journal entries". An open week gives the
// ready entries as they stand (safe to download any time, changes nothing); a
// closed week gives exactly the file that was frozen when it closed.
router.get('/week/:week/csv', gate, async function (req, res) {
  var w = weekParam(req, res); if (!w) return;
  try {
    var row = await weekRow(w);
    var csv;
    if (row && row.status === 'closed' && row.csv) {
      csv = row.csv;
    } else {
      var cfg = await qbo.loadConfig(pool);
      var cp = qbo.configProblems(cfg);
      if (cp.length) return res.status(400).json({ error: 'Finish the QuickBooks mapping first: ' + cp.join(' ') });
      var data = await loadWeek(w, cfg);
      csv = qbo.toCsv(data.built.units);
    }
    await logAudit({ entity_type: 'cash_week', entity_id: null, entity_number: w, action: 'csv_downloaded',
      user_id: req.user.id, user_name: req.user.name, details: { closed: !!(row && row.status === 'closed') } });
    res.json({ csv: csv, filename: 'nova-cash-JE-week-' + w + (row && row.status === 'closed' ? '' : '-DRAFT') + '.csv' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build the CSV' });
  }
});

router.post('/week/:week/close', gate, async function (req, res) {
  var w = weekParam(req, res); if (!w) return;
  var client = await pool.connect();
  try {
    var row = await weekRow(w);
    if (row && row.status === 'closed') return res.status(409).json({ error: 'That week is already closed.' });
    var cfg = await qbo.loadConfig(pool);
    var data = await loadWeek(w, cfg);
    var steps = stepsFor(data, row);
    var why = [];
    if (data.built.problems.length) why.push('Finish the QuickBooks mapping: ' + data.built.problems.join(' '));
    if (!steps.imported) why.push('Import the Pulsar Call Search for this week.');
    if (data.unlinked.length) why.push(data.unlinked.length + ' Pulsar name(s) are not linked to a Nova user.');
    var blocked = data.built.units.filter(function (u) { return u.problems.length; });
    if (blocked.length) why.push(blocked.length + ' entr' + (blocked.length === 1 ? 'y needs' : 'ies need') + ' attention (' +
      blocked.slice(0, 3).map(function (u) { return u.user_name; }).join(', ') + (blocked.length > 3 ? ', ...' : '') + ').');
    if (!steps.reconciled) why.push('Mark the reconciliation as reviewed (step 4).');
    if (why.length) return res.status(400).json({ error: 'The week cannot close yet. ' + why.join(' '), reasons: why });

    var units = data.built.units;
    var csv = qbo.toCsv(units);
    var snapshot = { units: units, totals: data.built.totals, kpis: data.kpis, import: data.import };

    await client.query('BEGIN');
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.deposit_ids.length) {
        await client.query(
          'UPDATE deposits SET qbo_export_batch = $1, qbo_exported_at = NOW(), qbo_exported_by_name = $2 WHERE id = ANY($3::int[])',
          [w, req.user.name, u.deposit_ids]
        );
      }
      if (u.kind === 'held' && u.held_amount > 0) {
        await client.query(
          'INSERT INTO cash_close_held (week_start, user_id, user_name, amount) VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (week_start, user_id) DO UPDATE SET amount = EXCLUDED.amount, user_name = EXCLUDED.user_name, cleared_in_week = NULL',
          [w, u.user_id, u.user_name, qbo.centsStr(u.held_amount)]
        );
      }
      if (u.kind === 'late' && u.clears_held_id) {
        await client.query('UPDATE cash_close_held SET cleared_in_week = $1 WHERE id = $2', [w, u.clears_held_id]);
      }
    }
    var state = (row && row.state) || {};
    await client.query(
      'INSERT INTO cash_weeks (week_start, status, state, snapshot, csv, closed_at, closed_by, closed_by_name, updated_at) ' +
      "VALUES ($1, 'closed', $2, $3, $4, NOW(), $5, $6, NOW()) " +
      "ON CONFLICT (week_start) DO UPDATE SET status = 'closed', state = EXCLUDED.state, snapshot = EXCLUDED.snapshot, csv = EXCLUDED.csv, " +
      'closed_at = NOW(), closed_by = EXCLUDED.closed_by, closed_by_name = EXCLUDED.closed_by_name, updated_at = NOW()',
      [w, JSON.stringify(state), JSON.stringify(snapshot), csv, req.user.id, req.user.name]
    );
    await client.query('COMMIT');

    var total = 0;
    units.forEach(function (x) { total += x.total; });
    await logAudit({ entity_type: 'cash_week', entity_id: null, entity_number: w, action: 'closed',
      user_id: req.user.id, user_name: req.user.name,
      details: { entries: units.length, total: qbo.centsStr(total),
        held: units.filter(function (x) { return x.kind === 'held'; }).map(function (x) { return x.user_name; }),
        late: units.filter(function (x) { return x.kind === 'late'; }).map(function (x) { return x.journal_no; }) } });
    res.json({ success: true, entries: units.length, csv: csv, filename: 'nova-cash-JE-week-' + w + '.csv' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Cash close error:', err);
    res.status(500).json({ error: 'Failed to close the week' });
  } finally {
    client.release();
  }
});

// Admin only, with a reason. Unfreezes the week's deposits, drops the held
// balances it created and un-clears the ones it cleared. The entries already
// imported into QuickBooks are NOT touched - the reason is in the audit log so
// the bookkeeper knows to delete or adjust them before re-importing.
router.post('/week/:week/reopen', gate, async function (req, res) {
  var w = weekParam(req, res); if (!w) return;
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can reopen a closed week.' });
  var reason = String((req.body && req.body.reason) || '').trim().slice(0, 1000);
  if (!reason) return res.status(400).json({ error: 'Say why the week is being reopened.' });
  var client = await pool.connect();
  try {
    var row = await weekRow(w);
    if (!row || row.status !== 'closed') return res.status(409).json({ error: 'That week is not closed.' });
    var later = (await pool.query(
      "SELECT DISTINCT to_char(cleared_in_week, 'YYYY-MM-DD') AS cw FROM cash_close_held WHERE week_start = $1 AND cleared_in_week IS NOT NULL AND cleared_in_week <> $1",
      [w]
    )).rows.map(function (r) { return r.cw; });
    if (later.length) return res.status(409).json({ error: 'A late deposit for this week was already exported by the week of ' + later.join(', ') + '. Reopen that week first.' });

    await client.query('BEGIN');
    await client.query('UPDATE deposits SET qbo_export_batch = NULL, qbo_exported_at = NULL, qbo_exported_by_name = NULL WHERE qbo_export_batch = $1', [w]);
    await client.query('DELETE FROM cash_close_held WHERE week_start = $1', [w]);
    await client.query('UPDATE cash_close_held SET cleared_in_week = NULL WHERE cleared_in_week = $1', [w]);
    await client.query(
      "UPDATE cash_weeks SET status = 'open', reopened_at = NOW(), reopened_by_name = $2, reopen_reason = $3, updated_at = NOW() WHERE week_start = $1",
      [w, req.user.name, reason]
    );
    await client.query('COMMIT');
    await logAudit({ entity_type: 'cash_week', entity_id: null, entity_number: w, action: 'reopened',
      user_id: req.user.id, user_name: req.user.name, details: { reason: reason, closed_by: row.closed_by_name, closed_at: row.closed_at } });
    res.json({ success: true });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Cash close reopen error:', err);
    res.status(500).json({ error: 'Failed to reopen the week' });
  } finally {
    client.release();
  }
});

module.exports = router;
