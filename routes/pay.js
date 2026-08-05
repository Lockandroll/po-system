const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const permissions = require('../utils/permissions');
const pay = require('../utils/pay');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Personnel - Tech pay
// ---------------------------------------------------------------------------
// A GRADE is a saved pay table. Same grade names company-wide, a separate set
// of rows per city, so a tech who transfers keeps their grade instead of
// needing a new one invented for them.
//
// Nothing here can rewrite a job that has already been paid. Every read of a
// closed call goes to the snapshot on the call, never back through these
// tables - which is what makes a rate change safe to make on a Friday.
// ---------------------------------------------------------------------------

function s(v, n) {
  return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null;
}
function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function intList(v) {
  if (v === undefined || v === null || v === '') return null;
  const a = Array.isArray(v) ? v : String(v).split(/[^0-9]+/);
  const out = a.map(function (x) { return parseInt(x, 10); })
    .filter(function (x) { return isFinite(x); })
    .filter(function (x, i, arr) { return arr.indexOf(x) === i; });
  return out.length ? out : null;
}
function ymd(v, fallback) {
  const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[0] : fallback;
}

// Same resolution order the rest of Nova uses: admin/owner, then the role
// matrix, then the per-person extra_perms grant that makes a dark-shipped
// pilot possible.
async function hasPerm(req, perm) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (e) {}
  const ep = req._userRow && req._userRow.extra_perms;
  return Array.isArray(ep) && ep.indexOf(perm) !== -1;
}

// Anyone allowed to look at EVERYBODY's pay. The report is readable by more
// people than the tables are writable by, which is the normal shape: a
// supervisor checking a cheque should not need the ability to change a rate.
async function canRead(req) {
  return (await hasPerm(req, 'view_pay_report')) || (await hasPerm(req, 'manage_pay_grades'));
}

// ---------------------------------------------------------------------------
//  Reference data for the editor
// ---------------------------------------------------------------------------
router.get('/reference', requireAuth, requirePermission('view_pay_report'), async function (req, res) {
  const grades = await pool.query(
    'SELECT g.*, (SELECT COUNT(*)::int FROM pay_rows r WHERE r.grade_id = g.id AND r.active = true) AS row_count, ' +
    '       (SELECT COUNT(*)::int FROM users u WHERE u.pay_grade_id = g.id AND u.active = true) AS people ' +
    'FROM pay_grades g WHERE g.active = true ORDER BY g.sort, g.name');
  const cities = await pool.query('SELECT TRIM(code) AS code, name FROM cities WHERE active = true ORDER BY name');
  const services = await pool.query(
    'SELECT id, code, name, category_code FROM service_types WHERE active = true ORDER BY sort, name');
  // Time codes are numbered TC1..TC6 per service per city; a pay row scopes by
  // the NUMBER, because that is the thing a person recognises across services.
  const codes = await pool.query(
    'SELECT DISTINCT code_id, title FROM service_time_codes WHERE active = true ORDER BY code_id');
  res.json({
    grades: grades.rows,
    cities: cities.rows,
    services: services.rows,
    time_codes: codes.rows,
    labor_types: [
      { key: 'completed_call', label: 'Completed call', unit: '$', help: 'Flat amount for finishing the call.' },
      { key: 'service_labor', label: 'Service labor', unit: '$', help: 'Flat amount, billed as labor on an account job.' },
      { key: 'percent_labor', label: 'Percent of labor', unit: '%', help: 'Percent of the labor line. The locksmith model.' },
      { key: 'gone_on_arrival', label: 'Gone on arrival', unit: '$', help: 'Flat amount when the tech marks GOA.' },
      { key: 'holiday_additional', label: 'Holiday additional', unit: '%', help: 'Percent ADDED on top on a holiday. Never pays on its own.' },
      { key: 'out_of_area', label: 'Out of area', unit: '%', help: 'Percent ADDED on top outside a primary zone. Never pays on its own.' },
      { key: 'percent_parts_margin', label: 'Percent of parts margin', unit: '%', dormant: true, help: 'Not switched on yet.' }
    ],
    arrangements: [
      { key: 'none', label: 'Not set', split: null },
      { key: 'own_vehicle', label: 'Own vehicle', split: 30 },
      { key: 'company_vehicle', label: 'Company vehicle', split: 0 },
      { key: 'hourly', label: 'Hourly', split: 0 },
      { key: 'salary', label: 'Salary', split: 0 }
    ]
  });
});

// ---------------------------------------------------------------------------
//  Grades
// ---------------------------------------------------------------------------
router.post('/grades', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const b = req.body || {};
  const id = parseInt(b.id, 10) || null;
  const name = s(b.name, 80);
  if (!name) return res.status(400).json({ error: 'A grade needs a name.' });
  const sort = parseInt(b.sort, 10) || 0;
  var gid = id;
  if (id) {
    await pool.query('UPDATE pay_grades SET name=$1, sort=$2 WHERE id=$3', [name, sort, id]);
  } else {
    const r = await pool.query('INSERT INTO pay_grades (name, sort) VALUES ($1,$2) RETURNING id', [name, sort]);
    gid = r.rows[0].id;
  }
  await logAudit({ entity_type: 'pay_grade', entity_id: gid, action: id ? 'update' : 'create',
    user_id: req.user.id, user_name: req.user.name, details: { name: name }, ip: req.ip });
  res.json({ ok: true, id: gid });
});

router.post('/grades/:id/deactivate', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  // Refused while anyone is on it. Deactivating a grade somebody is assigned to
  // does not stop their calls closing - it makes every one of them pay $0 with
  // a flag, which is a payroll problem discovered a fortnight later.
  const inUse = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE pay_grade_id = $1 AND active = true', [id]);
  if (inUse.rows[0].n) {
    return res.status(409).json({
      error: inUse.rows[0].n + ' active ' + (inUse.rows[0].n === 1 ? 'person is' : 'people are') +
        ' still on this grade. Move them first.',
      reason: 'grade_in_use'
    });
  }
  const r = await pool.query('UPDATE pay_grades SET active = false WHERE id = $1 RETURNING name', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'pay_grade', entity_id: id, action: 'deactivate',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Rows - one pay table
// ---------------------------------------------------------------------------
// A table is identified by (grade_id OR user_id) + city. That pair is the thing
// the UI shows as a screen, and the thing a duplicate-scope check is scoped to.
router.get('/rows', requireAuth, requirePermission('view_pay_report'), async function (req, res) {
  const gradeId = parseInt(req.query.grade_id, 10) || null;
  const userId = parseInt(req.query.user_id, 10) || null;
  const city = s(req.query.city, 3);
  if (!gradeId && !userId) return res.status(400).json({ error: 'Pick a grade or a person.' });
  const params = [];
  var where = '';
  if (gradeId) { params.push(gradeId); where = ' AND r.grade_id = $' + params.length; }
  else { params.push(userId); where = ' AND r.user_id = $' + params.length; }
  if (city) { params.push(city); where += ' AND TRIM(r.city_code) = TRIM($' + params.length + ')'; }
  const r = await pool.query(
    'SELECT r.*, v.name AS account_name FROM pay_rows r ' +
    'LEFT JOIN vendors v ON v.id = r.account_id ' +
    'WHERE r.active = true' + where + ' ORDER BY r.city_code, r.title', params);
  res.json({ rows: r.rows });
});

router.post('/rows', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const b = req.body || {};
  const id = parseInt(b.id, 10) || null;
  const gradeId = parseInt(b.grade_id, 10) || null;
  const userId = parseInt(b.user_id, 10) || null;
  const city = s(b.city_code, 3);
  const title = s(b.title, 80);
  const laborType = s(b.labor_type, 24);
  const amount = money(b.amount);
  const note = s(b.note, 2000);

  if (!!gradeId === !!userId) {
    return res.status(400).json({ error: 'A row belongs to a grade or to one person, not both and not neither.' });
  }
  if (!city) return res.status(400).json({ error: 'A pay row needs a city - rates differ per market.' });
  if (!title) return res.status(400).json({ error: 'A pay row needs a title. It is what the tech sees on their pay report.' });
  if (pay.ALL_TYPES.indexOf(laborType) === -1) return res.status(400).json({ error: 'Unknown labor type.' });
  if (amount === null) return res.status(400).json({ error: 'A pay row needs an amount.' });
  // ⚠️ An off-grade rate with no stated reason becomes unexplainable within a
  // year, and then nobody dares change it.
  if (userId && !note) {
    return res.status(400).json({
      error: 'An override row needs a note saying why this person is off-grade.',
      reason: 'note_required'
    });
  }

  const row = {
    grade_id: gradeId, user_id: userId, city_code: city, title: title,
    labor_type: laborType, amount: amount,
    applies_public: b.applies_public === false ? false : true,
    applies_accounts: b.applies_accounts === false ? false : true,
    account_id: parseInt(b.account_id, 10) || null,
    code_ids: intList(b.code_ids),
    service_type_ids: intList(b.service_type_ids),
    edu_only: b.edu_only === true || b.edu_only === 'true',
    note: note,
    effective_from: ymd(b.effective_from, null),
    effective_to: ymd(b.effective_to, null)
  };
  if (row.account_id) { row.applies_accounts = true; row.applies_public = false; }
  if (!row.applies_public && !row.applies_accounts && !row.account_id) {
    return res.status(400).json({ error: 'A row that applies to neither public nor account calls can never pay anything.' });
  }

  // ⚠️ Ties are impossible BY CONSTRUCTION, and they have to stay that way. A
  // "first row wins" fallback works fine right up until somebody reorders the
  // list, and then last month's numbers stop reproducing.
  const sibs = await pool.query(
    'SELECT * FROM pay_rows WHERE active = true AND TRIM(city_code) = TRIM($1) ' +
    '  AND ' + (gradeId ? 'grade_id = $2' : 'user_id = $2') +
    (id ? ' AND id <> $3' : ''),
    id ? [city, gradeId || userId, id] : [city, gradeId || userId]);
  const key = pay.scopeKey(row);
  const clash = sibs.rows.filter(function (x) { return pay.scopeKey(x) === key; })[0];
  if (clash) {
    return res.status(400).json({
      error: '"' + clash.title + '" already covers exactly this: same services, same accounts, ' +
        'same time codes, same labor type. Two rows that match the same call have no defined winner.',
      reason: 'duplicate_scope', conflict_id: clash.id
    });
  }
  const sameTitle = sibs.rows.filter(function (x) {
    return String(x.title).toLowerCase() === title.toLowerCase();
  })[0];
  if (sameTitle) return res.status(400).json({ error: 'This table already has a row called "' + title + '".' });

  const cols = ['grade_id', 'user_id', 'city_code', 'title', 'labor_type', 'amount',
    'applies_public', 'applies_accounts', 'account_id', 'code_ids', 'service_type_ids',
    'edu_only', 'note'];
  const vals = cols.map(function (c) { return row[c]; });
  var rowId = id;
  if (id) {
    const sets = cols.map(function (c, i) { return c + '=$' + (i + 1); });
    var p = vals.slice();
    if (row.effective_from) { p.push(row.effective_from); sets.push('effective_from=$' + p.length); }
    p.push(row.effective_to); sets.push('effective_to=$' + p.length);
    p.push(id);
    await pool.query('UPDATE pay_rows SET ' + sets.join(', ') + ' WHERE id=$' + p.length, p);
  } else {
    var p2 = vals.slice();
    var extraCols = '', extraVals = '';
    if (row.effective_from) { p2.push(row.effective_from); extraCols += ', effective_from'; extraVals += ', $' + p2.length; }
    if (row.effective_to) { p2.push(row.effective_to); extraCols += ', effective_to'; extraVals += ', $' + p2.length; }
    const ph = vals.map(function (v, i) { return '$' + (i + 1); }).join(',');
    const r = await pool.query(
      'INSERT INTO pay_rows (' + cols.join(',') + extraCols + ') VALUES (' + ph + extraVals + ') RETURNING id', p2);
    rowId = r.rows[0].id;
  }
  await logAudit({ entity_type: 'pay_row', entity_id: rowId, action: id ? 'update' : 'create',
    user_id: req.user.id, user_name: req.user.name,
    details: { title: title, city: city, labor_type: laborType, amount: amount,
      grade_id: gradeId, user_id: userId }, ip: req.ip });
  res.json({ ok: true, id: rowId });
});

router.post('/rows/:id/deactivate', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  // Deactivated, never deleted: calls paid under this row last month still have
  // to be explainable, and pay_row_id on those calls has to keep pointing
  // somewhere.
  const r = await pool.query('UPDATE pay_rows SET active = false WHERE id = $1 RETURNING title', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'pay_row', entity_id: id, action: 'deactivate',
    user_id: req.user.id, user_name: req.user.name, details: { title: r.rows[0].title }, ip: req.ip });
  res.json({ ok: true });
});

// Copy a table in as a starting point rather than typing forty rows again.
router.post('/rows/import', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const b = req.body || {};
  const fromGrade = parseInt(b.from_grade_id, 10) || null;
  const fromCity = s(b.from_city, 3);
  const toGrade = parseInt(b.to_grade_id, 10) || null;
  const toUser = parseInt(b.to_user_id, 10) || null;
  const toCity = s(b.to_city, 3);
  if (!fromGrade || !fromCity || !toCity) return res.status(400).json({ error: 'Pick a source table and a destination city.' });
  if (!!toGrade === !!toUser) return res.status(400).json({ error: 'Import into a grade or into one person, not both.' });
  if (fromGrade === toGrade && fromCity === toCity) return res.status(400).json({ error: 'That is the same table.' });

  const src = await pool.query(
    'SELECT * FROM pay_rows WHERE active = true AND grade_id = $1 AND TRIM(city_code) = TRIM($2) ORDER BY title',
    [fromGrade, fromCity]);
  if (!src.rows.length) return res.status(400).json({ error: 'That table is empty - nothing to copy.' });

  const existing = await pool.query(
    'SELECT * FROM pay_rows WHERE active = true AND TRIM(city_code) = TRIM($1) AND ' +
    (toGrade ? 'grade_id = $2' : 'user_id = $2'), [toCity, toGrade || toUser]);
  const taken = {};
  existing.rows.forEach(function (x) { taken[pay.scopeKey(x)] = x; });

  var copied = 0; const skipped = [];
  for (var i = 0; i < src.rows.length; i++) {
    const x = src.rows[i];
    // Existing rows are never overwritten. An import that silently replaced a
    // rate somebody had already tuned would be the worst kind of helpful.
    if (taken[pay.scopeKey(x)]) { skipped.push(x.title); continue; }
    await pool.query(
      'INSERT INTO pay_rows (grade_id, user_id, city_code, title, labor_type, amount, ' +
      'applies_public, applies_accounts, account_id, code_ids, service_type_ids, edu_only, note) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [toGrade, toUser, toCity, x.title, x.labor_type, x.amount, x.applies_public,
        x.applies_accounts, x.account_id, x.code_ids, x.service_type_ids, x.edu_only,
        toUser ? (x.note || 'Imported from another table') : x.note]);
    copied++;
  }
  await logAudit({ entity_type: 'pay_row', entity_id: toGrade || toUser, action: 'import',
    user_id: req.user.id, user_name: req.user.name,
    details: { from_grade: fromGrade, from_city: fromCity, to_city: toCity, copied: copied }, ip: req.ip });
  res.json({ ok: true, copied: copied, skipped: skipped });
});

// ---------------------------------------------------------------------------
//  Who is on what grade
// ---------------------------------------------------------------------------
router.get('/people', requireAuth, requirePermission('view_pay_report'), async function (req, res) {
  const params = [];
  var where = '';
  if (req.query.city) { params.push(String(req.query.city).trim().slice(0, 3)); where = ' AND TRIM(u.home_city) = TRIM($1)'; }
  const r = await pool.query(
    'SELECT u.id, u.name, u.role, TRIM(u.home_city) AS home_city, u.pay_grade_id, ' +
    '       u.pay_arrangement, u.vehicle_split_pct, g.name AS grade_name, ' +
    '       (SELECT COUNT(*)::int FROM pay_rows r WHERE r.user_id = u.id AND r.active = true) AS override_rows ' +
    'FROM users u LEFT JOIN pay_grades g ON g.id = u.pay_grade_id ' +
    'WHERE u.active = true' + where + ' ORDER BY u.name', params);
  res.json({ people: r.rows });
});

router.post('/people/:id', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const gradeId = b.pay_grade_id === null || b.pay_grade_id === '' ? null : (parseInt(b.pay_grade_id, 10) || null);
  const arrangements = ['none', 'own_vehicle', 'company_vehicle', 'hourly', 'salary'];
  const arrangement = arrangements.indexOf(b.pay_arrangement) === -1 ? 'none' : b.pay_arrangement;
  // ⚠️ Stored, not a hardcoded 70. If one person moves to 75/25 that is a field
  // edit, and every call already paid keeps the split it was paid under.
  var split = money(b.vehicle_split_pct);
  if (split === null) split = arrangement === 'own_vehicle' ? 30 : 0;
  split = Math.min(100, Math.max(0, split));
  if (arrangement !== 'own_vehicle' && split > 0) {
    return res.status(400).json({
      error: 'Vehicle reimbursement only applies to somebody driving their own vehicle.',
      reason: 'split_without_own_vehicle'
    });
  }
  const r = await pool.query(
    'UPDATE users SET pay_grade_id=$1, pay_arrangement=$2, vehicle_split_pct=$3 WHERE id=$4 RETURNING name',
    [gradeId, arrangement, split, id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'user', entity_id: id, action: 'pay_setup',
    user_id: req.user.id, user_name: req.user.name,
    details: { grade_id: gradeId, arrangement: arrangement, split: split }, ip: req.ip });
  res.json({ ok: true });
});

// What this person's table actually resolves to, overrides folded in. The
// answer to "why did that call pay that" before the call has even happened.
router.get('/people/:id/effective', requireAuth, requirePermission('view_pay_report'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const u = await pool.query('SELECT id, name, TRIM(home_city) AS home_city, pay_grade_id FROM users WHERE id = $1', [id]);
  if (!u.rows.length) return res.status(404).json({ error: 'Not found' });
  const city = s(req.query.city, 3) || u.rows[0].home_city;
  const rows = await pay.effectiveRows({ user_id: id, city_code: city, grade_id: u.rows[0].pay_grade_id });
  res.json({ user: u.rows[0], city_code: city, rows: rows });
});

// ---------------------------------------------------------------------------
//  The pay report
// ---------------------------------------------------------------------------
// One row per call, showing WHICH PAY ROW paid it, so a tech querying their
// cheque gets an answer instead of an argument. Vertical totals underneath.
router.get('/report', requireAuth, async function (req, res) {
  const mine = !(await canRead(req));
  if (mine && !(await hasPerm(req, 'view_own_pay'))) {
    return res.status(403).json({ error: 'You do not have access to pay figures.' });
  }
  const from = ymd(req.query.from, null);
  const to = ymd(req.query.to, null);
  if (!from || !to) return res.status(400).json({ error: 'Pick a date range.' });

  const params = [from, to];
  // ⚠️ view_own_pay never widens past the person asking, and it is enforced
  // HERE rather than in the template - a client that posts somebody else's id
  // gets its own figures back.
  var where = '';
  if (mine) { params.push(req.user.id); where += ' AND j.assigned_to = $' + params.length; }
  else if (req.query.user_id) { params.push(parseInt(req.query.user_id, 10) || 0); where += ' AND j.assigned_to = $' + params.length; }
  if (req.query.city) { params.push(String(req.query.city).trim().slice(0, 3)); where += ' AND TRIM(j.city_code) = TRIM($' + params.length + ')'; }

  const r = await pool.query(
    'SELECT j.id, j.job_number, j.status, j.service_type, j.account_name, ' +
    '       TRIM(j.city_code) AS city_code, j.is_edu, ' +
    '       COALESCE(j.completed_at, j.goa_at) AS closed_at, ' +
    '       j.assigned_to, u.name AS tech_name, ' +
    '       j.pay_row_id, j.pay_row_title, j.pay_labor_type, j.pay_basis_amount, ' +
    '       j.pay_total, j.pay_job_amount, j.pay_vehicle_amount, j.pay_split_pct, ' +
    '       j.pay_tip_amount, j.pay_note ' +
    'FROM dispatch_jobs j LEFT JOIN users u ON u.id = j.assigned_to ' +
    'WHERE j.pay_locked_at IS NOT NULL ' +
    '  AND COALESCE(j.completed_at, j.goa_at) >= $1::date ' +
    '  AND COALESCE(j.completed_at, j.goa_at) < ($2::date + INTERVAL \'1 day\') ' +
    where + ' ORDER BY u.name, COALESCE(j.completed_at, j.goa_at)', params);

  const totals = { job_pay: 0, vehicle: 0, tips: 0, total: 0, calls: r.rows.length, unpaid: 0 };
  const byTech = {};
  r.rows.forEach(function (x) {
    const job = Number(x.pay_job_amount || 0);
    const veh = Number(x.pay_vehicle_amount || 0);
    const tip = Number(x.pay_tip_amount || 0);
    totals.job_pay += job; totals.vehicle += veh; totals.tips += tip;
    // A call that matched no row. Counted separately and loudly - this is the
    // number somebody has to go and fix before payroll runs.
    if (!x.pay_row_id) totals.unpaid++;
    const k = x.assigned_to || 0;
    if (!byTech[k]) byTech[k] = { user_id: x.assigned_to, name: x.tech_name || 'Unassigned', calls: 0, job_pay: 0, vehicle: 0, tips: 0, total: 0, unpaid: 0 };
    byTech[k].calls++;
    byTech[k].job_pay += job; byTech[k].vehicle += veh; byTech[k].tips += tip;
    if (!x.pay_row_id) byTech[k].unpaid++;
  });
  function r2(n) { return Math.round(n * 100) / 100; }
  totals.total = r2(totals.job_pay + totals.vehicle);
  totals.job_pay = r2(totals.job_pay); totals.vehicle = r2(totals.vehicle); totals.tips = r2(totals.tips);
  const techs = Object.keys(byTech).map(function (k) {
    const t = byTech[k];
    t.total = r2(t.job_pay + t.vehicle);
    t.job_pay = r2(t.job_pay); t.vehicle = r2(t.vehicle); t.tips = r2(t.tips);
    return t;
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

  res.json({ from: from, to: to, calls: r.rows, techs: techs, totals: totals, own_only: mine });
});

// Why did that call pay that. Reads the SNAPSHOT for a closed call and only
// recalculates for one still open.
router.get('/job/:id', requireAuth, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const j = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
  if (!j.rows.length) return res.status(404).json({ error: 'Not found' });
  const job = j.rows[0];
  const mine = !(await canRead(req));
  if (mine) {
    if (!(await hasPerm(req, 'view_own_pay')) || job.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'You do not have access to pay figures for that call.' });
    }
  }
  if (job.pay_locked_at) {
    return res.json({
      locked: true, locked_at: job.pay_locked_at,
      pay: {
        pay_row_id: job.pay_row_id, pay_row_title: job.pay_row_title,
        pay_labor_type: job.pay_labor_type, pay_basis_amount: job.pay_basis_amount,
        pay_total: job.pay_total, pay_job_amount: job.pay_job_amount,
        pay_vehicle_amount: job.pay_vehicle_amount, pay_split_pct: job.pay_split_pct,
        pay_tip_amount: job.pay_tip_amount, note: job.pay_note
      }
    });
  }
  const preview = await pay.previewForJob(job);
  res.json({ locked: false, preview: preview });
});

// Re-price one call. Deliberately narrow: manage_pay_grades only, a reason is
// required, and it writes an audit row naming the old figure and the new one.
router.post('/job/:id/recalculate', requireAuth, requirePermission('manage_pay_grades'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = s(req.body && req.body.reason, 500);
  if (!reason) return res.status(400).json({ error: 'Re-pricing a paid call needs a reason.' });
  const before = await pool.query('SELECT pay_total, pay_row_title FROM dispatch_jobs WHERE id = $1', [id]);
  if (!before.rows.length) return res.status(404).json({ error: 'Not found' });
  const out = await pay.snapshotForJob(id, { force: true });
  if (!out || out.skipped) return res.status(409).json({ error: 'That call is not closed out.' });
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'pay_recalc',
    user_id: req.user.id, user_name: req.user.name,
    details: { reason: reason, was: before.rows[0].pay_total, was_row: before.rows[0].pay_row_title,
      now: out.pay && out.pay.pay_total, now_row: out.pay && out.pay.pay_row_title }, ip: req.ip });
  res.json({ ok: true, pay: out.pay, flags: out.flags });
});

module.exports = router;
