'use strict';
/*
 * Pulsar cash import + deposit reconciliation  (Nova)
 * ---------------------------------------------------
 * A manager drops the Pulsar "Call Search" CSV for a pay week on the Cash
 * Deposits page. Every call where the technician collected CASH is stored, then
 * reconciled against the deposit that tech actually submitted.
 *
 * The point of the module: the Cash Deposits page can only show you deposits
 * that were MADE. A tech who collects cash all week and never submits anything
 * is invisible there. This is what makes that visible.
 *
 * NOTE: no backtick/template-literal strings are used anywhere in this file
 * (Windows-safe per the Nova editing rules).
 */

var express = require('express');
var { pool } = require('../db');
var { requireAuth, requirePermission } = require('../middleware/auth');
var { logAudit } = require('../utils/audit');
var PC = require('../utils/pulsarCash');

var router = express.Router();

// Import and reconciliation are a management view over everyone's money.
var MANAGE = ['admin', 'manager'];

function manageOnly(req, res, next) {
  if (!MANAGE.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  next();
}

function n2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// Exact-to-the-penny comparison. 0.005 is half a cent -- it absorbs float
// representation error only, never a real difference. Tony chose exact: a $0.10
// gap is a $0.10 gap and it says so.
function same(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005; }

/* ---------------------------------------------------------------- settings */

async function getSetting(key, fallback) {
  try {
    var r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (!r.rows.length || r.rows[0].value == null || r.rows[0].value === '') return fallback;
    return JSON.parse(r.rows[0].value);
  } catch (e) { return fallback; }
}

async function putSetting(key, val) {
  await pool.query(
    'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, JSON.stringify(val)]
  );
}

/* ------------------------------------------------------------ tech matching */

/*
 * Build the technician resolver.
 *
 * Pulsar writes "Yonkman, Michael"; Nova knows him as "Mike Yonkman". Four
 * tiers, most-trusted first, and anything that survives all four is handed back
 * to a human rather than guessed at:
 *
 *   0. the saved manual map (a human already decided this one -- always wins)
 *   1. users.pulsar_name          (the field that exists precisely for this)
 *   2. users.name / users.nickname
 *   3. last name + first initial, ONLY when it resolves to exactly one active
 *      user. Three different Lees collect cash in this data set -- Timothy,
 *      Matthew and Christopher -- so "same last name" alone can never match.
 */
async function buildResolver() {
  var u = await pool.query(
    'SELECT id, name, pulsar_name, nickname, active, home_city FROM users'
  );
  var exact = {};        // squashed key -> { id, tier }
  var initial = {};      // "lastname f" -> [ids]
  var byId = {};

  function claim(bucket, key, id, tier) {
    if (!key) return;
    var prior = bucket[key];
    if (!prior || tier < prior.tier) bucket[key] = { id: id, tier: tier };
  }

  u.rows.forEach(function (row) {
    byId[row.id] = { id: row.id, name: row.name, active: row.active, home_city: row.home_city };
    claim(exact, PC.squash(row.pulsar_name), row.id, 1);
    claim(exact, PC.squash(row.name), row.id, 2);
    String(row.nickname == null ? '' : row.nickname).split(',').forEach(function (nick) {
      claim(exact, PC.squash(nick), row.id, 2);
    });
    // Tier 3 index. Built from the user's real name AND each nickname, so
    // "Mike Yonkman" and "Michael Yonkman" both land on "yonkman m".
    var forms = [row.name].concat(String(row.nickname == null ? '' : row.nickname).split(','));
    forms.forEach(function (form) {
      var toks = PC.squash(form).split(' ').filter(Boolean);
      if (toks.length < 2) return;
      var key = toks[toks.length - 1] + ' ' + toks[0].charAt(0);
      if (!initial[key]) initial[key] = [];
      if (initial[key].indexOf(row.id) === -1) initial[key].push(row.id);
    });
  });

  return {
    byId: byId,
    /* Returns { user_id, tier, why } -- user_id null when unresolved. */
    resolve: function (techRaw, savedMap) {
      var rawKey = PC.squash(techRaw);
      if (savedMap && savedMap[rawKey]) {
        var mapped = parseInt(savedMap[rawKey], 10);
        if (byId[mapped]) return { user_id: mapped, tier: 0, why: 'saved' };
      }
      var nm = PC.normalizeTechName(techRaw);
      var best = null;
      for (var i = 0; i < nm.keys.length; i++) {
        var hit = exact[nm.keys[i]];
        if (hit && (!best || hit.tier < best.tier)) best = hit;
      }
      if (best) return { user_id: best.id, tier: best.tier, why: best.tier === 1 ? 'pulsar_name' : 'name' };

      if (nm.last && nm.first) {
        var key = PC.squash(nm.last) + ' ' + PC.squash(nm.first).charAt(0);
        var ids = (initial[key] || []).filter(function (id) { return byId[id] && byId[id].active; });
        // Exactly one active person, or the ambiguity is left for a human.
        if (ids.length === 1) return { user_id: ids[0], tier: 3, why: 'last name + initial' };
      }
      return { user_id: null, tier: 99, why: 'unmatched' };
    }
  };
}

/* -------------------------------------------------------- city mapping */

/*
 * Pulsar "Location" ("Jacksonville") -> Nova city_code ("JAX").
 * Exact name match, then a saved override, then the longest active city name
 * appearing inside the location string.
 */
async function buildCityMapper() {
  var c = await pool.query('SELECT code, name FROM cities');
  var saved = await getSetting('pulsar_location_map', {});
  var byName = {};
  var names = [];
  c.rows.forEach(function (row) {
    byName[PC.squash(row.name)] = row.code;
    names.push({ key: PC.squash(row.name), code: row.code });
  });
  names.sort(function (a, b) { return b.key.length - a.key.length; });
  return function (location) {
    var k = PC.squash(location);
    if (!k) return null;
    if (saved[k]) return saved[k];
    if (byName[k]) return byName[k];
    for (var i = 0; i < names.length; i++) {
      if (names[i].key && k.indexOf(names[i].key) !== -1) return names[i].code;
    }
    return null;
  };
}

/* ------------------------------------------------------------ POST /preview */

// Parse a CSV and report what WOULD be imported. Writes nothing.
router.post('/preview', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var csv = req.body && req.body.csv;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'No CSV provided' });

    var out = PC.extractCashRows(csv);
    if (out.meta.missing.length) {
      return res.status(400).json({
        error: 'This does not look like a Pulsar Call Search export -- missing the ' +
          out.meta.missing.join(', ') + ' column(s).',
        columns: out.meta.columns
      });
    }
    if (!out.rows.length) {
      return res.status(400).json({ error: 'No cash calls found in this file. Every row had $0.00 in Collected Cash.' });
    }

    var period = PC.detectPeriod(out.rows);
    var resolver = await buildResolver();
    var cityOf = await buildCityMapper();
    var savedMap = await getSetting('pulsar_tech_map', {});

    // Group by technician for the confirmation screen.
    var techs = {};
    out.rows.forEach(function (r) {
      var key = PC.squash(r.tech_raw);
      if (!techs[key]) {
        var m = resolver.resolve(r.tech_raw, savedMap);
        techs[key] = {
          tech_raw: r.tech_raw, tech_display: r.tech_display, key: key,
          user_id: m.user_id, match_why: m.why,
          user_name: m.user_id && resolver.byId[m.user_id] ? resolver.byId[m.user_id].name : null,
          calls: 0, cash: 0, city_code: cityOf(r.location_raw), location_raw: r.location_raw
        };
      }
      techs[key].calls++;
      techs[key].cash = n2(techs[key].cash + r.cash);
    });

    var techList = Object.keys(techs).map(function (k) { return techs[k]; })
      .sort(function (a, b) { return b.cash - a.cash; });

    // Does this period already have an import?
    var existing = await pool.query(
      'SELECT id, filename, cash_rows, cash_total, uploaded_by_name, created_at FROM pulsar_imports WHERE period_start = $1 ORDER BY created_at DESC',
      [period.start]
    );

    res.json({
      period: period,
      meta: out.meta,
      techs: techList,
      unmatched: techList.filter(function (t) { return !t.user_id; }),
      existing: existing.rows,
      users: Object.keys(resolver.byId).map(function (id) { return resolver.byId[id]; })
        .filter(function (x) { return x.active; })
        .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
    });
  } catch (err) {
    console.error('Pulsar preview error:', err);
    res.status(500).json({ error: 'Failed to read the CSV' });
  }
});

/* ------------------------------------------------------------- POST /import */

/*
 * Commit an import for one pay week.
 *
 * Replacement semantics: importing a period DELETES that period's prior imports
 * first, so re-dropping a corrected export overwrites cleanly rather than
 * doubling the week. call_uid is additionally UNIQUE at the database level, so
 * even a file that straddles two weeks cannot count a call twice -- the newer
 * import wins that row.
 */
router.post('/import', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  var client = await pool.connect();
  try {
    var csv = req.body && req.body.csv;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ error: 'No CSV provided' });
    var assignments = (req.body && req.body.assignments) || {};
    var filename = String((req.body && req.body.filename) || '').slice(0, 255) || null;

    var out = PC.extractCashRows(csv);
    if (out.meta.missing.length) return res.status(400).json({ error: 'Missing column(s): ' + out.meta.missing.join(', ') });
    if (!out.rows.length) return res.status(400).json({ error: 'No cash calls found in this file' });

    var detected = PC.detectPeriod(out.rows);
    var periodStart = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.period_start || '')) ? String(req.body.period_start) : detected.start;
    var periodEnd = PC.addDaysYmd(periodStart, 6);

    var resolver = await buildResolver();
    var cityOf = await buildCityMapper();
    var savedMap = await getSetting('pulsar_tech_map', {});

    // A manual pick on the preview screen is remembered forever, so the same
    // spelling never has to be resolved by hand twice.
    var learned = 0;
    Object.keys(assignments).forEach(function (k) {
      var uid = parseInt(assignments[k], 10);
      var key = PC.squash(k);
      if (key && uid && resolver.byId[uid] && savedMap[key] !== uid) { savedMap[key] = uid; learned++; }
    });
    if (learned) await putSetting('pulsar_tech_map', savedMap);

    // Only the rows belonging to the week being imported.
    var rows = out.rows.filter(function (r) { return r.call_date >= periodStart && r.call_date <= periodEnd; });
    if (!rows.length) return res.status(400).json({ error: 'No cash calls fall inside ' + periodStart + ' to ' + periodEnd });

    var cashTotal = 0, unmatched = 0;
    rows.forEach(function (r) { cashTotal += r.cash; });

    await client.query('BEGIN');
    await client.query('DELETE FROM pulsar_imports WHERE period_start = $1', [periodStart]);
    // Belt and braces: a prior import of a DIFFERENT week may still own one of
    // these call_uids if that file straddled the boundary. Clear them so the
    // upsert below cannot silently attribute a call to the wrong week.
    await client.query(
      'DELETE FROM pulsar_cash_calls WHERE call_uid = ANY($1::varchar[])',
      [rows.map(function (r) { return r.call_uid; })]
    );

    var imp = await client.query(
      'INSERT INTO pulsar_imports (period_start, period_end, filename, uploaded_by, uploaded_by_name, total_rows, cash_rows, cash_total) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, period_start, period_end, filename, cash_rows, cash_total, created_at',
      [periodStart, periodEnd, filename, req.user.id, req.user.name, out.meta.totalRows, rows.length, n2(cashTotal)]
    );
    var importId = imp.rows[0].id;

    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var m = resolver.resolve(r.tech_raw, savedMap);
      if (!m.user_id) unmatched++;
      await client.query(
        'INSERT INTO pulsar_cash_calls (import_id, call_uid, invoice, call_date, period_start, period_end, location_raw, city_code, tech_raw, tech_display, tech_user_id, task, status, account, cash, tax) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ' +
        'ON CONFLICT (call_uid) DO UPDATE SET import_id = EXCLUDED.import_id, call_date = EXCLUDED.call_date, ' +
        'period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, city_code = EXCLUDED.city_code, ' +
        'tech_user_id = EXCLUDED.tech_user_id, cash = EXCLUDED.cash, tax = EXCLUDED.tax',
        [
          importId, r.call_uid, r.invoice || null, r.call_date, periodStart, periodEnd,
          r.location_raw || null, cityOf(r.location_raw), r.tech_raw, r.tech_display,
          m.user_id, r.task || null, r.status || null, r.account || null, r.cash, r.tax
        ]
      );
    }
    await client.query('COMMIT');

    await logAudit({
      entity_type: 'pulsar_import',
      entity_id: importId,
      entity_number: periodStart + ' to ' + periodEnd,
      action: 'imported',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { filename: filename, cash_rows: rows.length, cash_total: n2(cashTotal), unmatched_techs: unmatched, learned_names: learned }
    });

    res.status(201).json({ success: true, import: imp.rows[0], cash_rows: rows.length, cash_total: n2(cashTotal), unmatched: unmatched });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Pulsar import error:', err);
    res.status(500).json({ error: 'Failed to import the Pulsar CSV' });
  } finally {
    client.release();
  }
});

/* ----------------------------------------------------- GET /reconciliation */

/*
 * The checker. One row per technician for the requested pay week.
 *
 * Statuses:
 *   match       Pulsar cash, the typed figure and the deposit all agree
 *   typo        the deposit is right but the tech mistyped "Pulsar shows owed"
 *   short       deposit + expenses is LESS than Pulsar says they collected
 *   over        deposit + expenses is MORE than Pulsar says they collected
 *   no_deposit  Pulsar shows cash collected and nothing was submitted
 *   no_pulsar   a deposit exists that the Pulsar export has no cash for
 *   unlinked    cash in Pulsar under a name that maps to no Nova user
 */
router.get('/reconciliation', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var periodStart = String(req.query.period_start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return res.status(400).json({ error: 'period_start (YYYY-MM-DD) is required' });
    var periodEnd = PC.addDaysYmd(periodStart, 6);

    var pulsar = await pool.query(
      'SELECT p.tech_user_id, p.tech_raw, p.tech_display, u.name AS user_name, ' +
      '  MIN(p.city_code) AS city_code, MIN(p.location_raw) AS location_raw, ' +
      '  COUNT(*)::int AS calls, COALESCE(SUM(p.cash), 0) AS cash ' +
      'FROM pulsar_cash_calls p LEFT JOIN users u ON u.id = p.tech_user_id ' +
      'WHERE p.call_date >= $1 AND p.call_date <= $2 ' +
      'GROUP BY p.tech_user_id, p.tech_raw, p.tech_display, u.name',
      [periodStart, periodEnd]
    );

    var deposits = await pool.query(
      'SELECT d.user_id, COALESCE(u.name, d.user_name) AS user_name, MIN(d.city_code) AS city_code, ' +
      '  COUNT(*)::int AS deposit_count, COALESCE(SUM(d.amount), 0) AS deposited, ' +
      '  COALESCE(SUM(d.pulsar_owed), 0) AS entered, ' +
      '  COALESCE(SUM((SELECT COALESCE(SUM(e.amount), 0) FROM deposit_expenses e WHERE e.deposit_id = d.id)), 0) AS expenses, ' +
      '  BOOL_OR(d.pulsar_owed IS NULL) AS any_entered_null, ' +
      "  STRING_AGG(d.deposit_number, ', ' ORDER BY d.deposit_number) AS deposit_numbers " +
      'FROM deposits d LEFT JOIN users u ON u.id = d.user_id ' +
      'WHERE d.period_start = $1 GROUP BY d.user_id, COALESCE(u.name, d.user_name)',
      [periodStart]
    );

    // Merge on user_id; technicians Pulsar names but Nova cannot place fall back
    // to their raw string so their money still shows up somewhere.
    var byKey = {};
    function slot(key) {
      if (!byKey[key]) {
        byKey[key] = {
          key: key, user_id: null, user_name: null, tech_raw: null, city_code: null,
          calls: 0, pulsar_cash: 0, entered: null, deposited: 0, expenses: 0,
          deposit_count: 0, deposit_numbers: null
        };
      }
      return byKey[key];
    }

    pulsar.rows.forEach(function (r) {
      var key = r.tech_user_id ? ('u' + r.tech_user_id) : ('raw:' + PC.squash(r.tech_raw));
      var s = slot(key);
      s.user_id = r.tech_user_id || null;
      s.user_name = r.user_name || r.tech_display || r.tech_raw;
      s.tech_raw = r.tech_raw;
      s.city_code = s.city_code || r.city_code || null;
      s.location_raw = r.location_raw;
      s.calls += r.calls;
      s.pulsar_cash = n2(s.pulsar_cash + Number(r.cash));
      s.in_pulsar = true;
    });

    deposits.rows.forEach(function (r) {
      var key = r.user_id ? ('u' + r.user_id) : ('raw:' + PC.squash(r.user_name));
      var s = slot(key);
      s.user_id = s.user_id || r.user_id || null;
      s.user_name = s.user_name || r.user_name;
      s.city_code = s.city_code || r.city_code || null;
      s.deposited = n2(s.deposited + Number(r.deposited));
      s.expenses = n2(s.expenses + Number(r.expenses));
      s.entered = r.any_entered_null ? null : n2(Number(r.entered));
      s.deposit_count += r.deposit_count;
      s.deposit_numbers = r.deposit_numbers;
      s.in_deposits = true;
    });

    var rows = Object.keys(byKey).map(function (k) {
      var s = byKey[k];
      var accounted = n2(s.deposited + s.expenses);
      var gap = n2(s.pulsar_cash - accounted);
      s.accounted = accounted;
      s.gap = gap;
      s.typed_mismatch = !!(s.in_deposits && s.entered != null && !same(s.entered, s.pulsar_cash));

      if (!s.in_deposits) s.status = 'no_deposit';
      else if (!s.in_pulsar) s.status = 'no_pulsar';
      else if (!same(gap, 0)) s.status = gap > 0 ? 'short' : 'over';
      else if (s.typed_mismatch) s.status = 'typo';
      else s.status = 'match';

      // Cash sitting in Pulsar under a name Nova cannot place is its own
      // problem: nobody is accountable for it until the name is mapped.
      if (!s.user_id && s.in_pulsar) s.status = 'unlinked';
      return s;
    });

    var order = { no_deposit: 0, unlinked: 1, short: 2, over: 3, typo: 4, no_pulsar: 5, match: 6 };
    rows.sort(function (a, b) {
      var d = (order[a.status] || 9) - (order[b.status] || 9);
      if (d) return d;
      return b.pulsar_cash - a.pulsar_cash;
    });

    var totals = { pulsar_cash: 0, deposited: 0, expenses: 0, gap: 0, techs: rows.length, unaccounted: 0 };
    rows.forEach(function (r) {
      totals.pulsar_cash = n2(totals.pulsar_cash + r.pulsar_cash);
      totals.deposited = n2(totals.deposited + r.deposited);
      totals.expenses = n2(totals.expenses + r.expenses);
      totals.gap = n2(totals.gap + r.gap);
      if (r.status === 'no_deposit' || r.status === 'unlinked') totals.unaccounted = n2(totals.unaccounted + r.pulsar_cash);
    });

    var imp = await pool.query(
      'SELECT id, filename, cash_rows, cash_total, uploaded_by_name, created_at FROM pulsar_imports WHERE period_start = $1 ORDER BY created_at DESC LIMIT 1',
      [periodStart]
    );

    res.json({
      period_start: periodStart,
      period_end: periodEnd,
      imported: imp.rows.length ? imp.rows[0] : null,
      rows: rows,
      totals: totals
    });
  } catch (err) {
    console.error('Pulsar reconciliation error:', err);
    res.status(500).json({ error: 'Failed to build the reconciliation' });
  }
});

/* ------------------------------------------------------------- GET /calls */

// The individual cash calls behind one technician's figure.
router.get('/calls', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var periodStart = String(req.query.period_start || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) return res.status(400).json({ error: 'period_start is required' });
    var periodEnd = PC.addDaysYmd(periodStart, 6);
    var userId = parseInt(req.query.user_id, 10);
    var techRaw = req.query.tech_raw ? String(req.query.tech_raw) : '';

    var where, params;
    if (userId) {
      where = 'p.call_date >= $1 AND p.call_date <= $2 AND p.tech_user_id = $3';
      params = [periodStart, periodEnd, userId];
    } else if (techRaw) {
      where = 'p.call_date >= $1 AND p.call_date <= $2 AND LOWER(TRIM(p.tech_raw)) = LOWER(TRIM($3))';
      params = [periodStart, periodEnd, techRaw];
    } else {
      return res.status(400).json({ error: 'user_id or tech_raw is required' });
    }
    var r = await pool.query(
      'SELECT p.id, p.call_uid, p.invoice, p.call_date, p.location_raw, p.city_code, p.tech_raw, ' +
      '  p.task, p.status, p.account, p.cash, p.tax ' +
      'FROM pulsar_cash_calls p WHERE ' + where + ' ORDER BY p.call_date, p.invoice',
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('Pulsar calls error:', err);
    res.status(500).json({ error: 'Failed to load the calls' });
  }
});

/* ------------------------------------------------------------ GET /imports */

router.get('/imports', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var r = await pool.query(
      'SELECT id, period_start, period_end, filename, uploaded_by_name, total_rows, cash_rows, cash_total, created_at ' +
      'FROM pulsar_imports ORDER BY period_start DESC, created_at DESC LIMIT 100'
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load imports' });
  }
});

router.delete('/imports/:id', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var r = await pool.query('DELETE FROM pulsar_imports WHERE id = $1 RETURNING id, period_start, period_end', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Import not found' });
    await logAudit({
      entity_type: 'pulsar_import',
      entity_id: r.rows[0].id,
      entity_number: r.rows[0].period_start + ' to ' + r.rows[0].period_end,
      action: 'deleted',
      user_id: req.user.id,
      user_name: req.user.name
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete the import' });
  }
});

/* ----------------------------------------------------------- GET /tech-map */

// The remembered name decisions, so a wrong one can be corrected.
router.get('/tech-map', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var map = await getSetting('pulsar_tech_map', {});
    var u = await pool.query('SELECT id, name FROM users WHERE active = TRUE ORDER BY name');
    res.json({ map: map, users: u.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the name map' });
  }
});

router.put('/tech-map', requireAuth, requirePermission('view_deposits'), manageOnly, async function (req, res) {
  try {
    var incoming = (req.body && req.body.map) || {};
    var clean = {};
    Object.keys(incoming).forEach(function (k) {
      var key = PC.squash(k);
      var uid = parseInt(incoming[k], 10);
      if (key && uid) clean[key] = uid;
    });
    await putSetting('pulsar_tech_map', clean);
    // Re-link already-imported calls so a correction applies retroactively
    // instead of only affecting the next import.
    var relinked = 0;
    var keys = Object.keys(clean);
    for (var i = 0; i < keys.length; i++) {
      var r = await pool.query(
        'UPDATE pulsar_cash_calls SET tech_user_id = $1 WHERE LOWER(REGEXP_REPLACE(TRIM(tech_raw), $3, $4, $5)) = $2 AND tech_user_id IS DISTINCT FROM $1',
        [clean[keys[i]], keys[i], '\\s+', ' ', 'g']
      );
      relinked += r.rowCount;
    }
    res.json({ success: true, relinked: relinked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save the name map' });
  }
});

module.exports = router;
