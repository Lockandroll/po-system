const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logAudit } = require('../utils/audit');
const push = require('../utils/push');

const router = express.Router();

// ---- helpers ---------------------------------------------------------------
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Roles that have NO overtime restriction (per Tony): field roles never trigger OT warnings.
const NO_OT_ROLES = ['locksmith', 'roadside_technician'];

function timeToMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
// Worked minutes for a shift; if end <= start it crosses midnight (+24h). Break deducted.
function shiftMinutes(s) {
  let start = timeToMin(s.start_time);
  let end = timeToMin(s.end_time);
  if (end <= start) end += 1440;
  let mins = end - start - (parseInt(s.break_minutes, 10) || 0);
  return mins > 0 ? mins : 0;
}
function ymd(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return ymd(dt);
}
// Monday (week start) of the given date, as YYYY-MM-DD.
function mondayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  const back = day === 0 ? 6 : day - 1;
  return addDays(dateStr, -back);
}
function dowOf(dateStr) { const a = dateStr.split('-').map(Number); return new Date(Date.UTC(a[0], a[1] - 1, a[2])).getUTCDay(); }
function fmtTime(t) {
  const mm = timeToMin(t);
  let h = Math.floor(mm / 60), min = mm % 60;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + String(min).padStart(2, '0') + ' ' + ap;
}

// Returns null (= all cities allowed) for admins and for managers with no
// explicit city assignment; otherwise the list of assigned city codes.
async function allowedCities(user) {
  if (user.role === 'admin') return null;
  const { rows } = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [user.id]);
  if (!rows.length) return null;
  return rows.map(function (r) { return (r.city_code || '').trim(); });
}
function cityOk(scope, code) {
  if (scope === null) return true;
  return scope.indexOf((code || '').trim()) !== -1;
}

function cleanShift(b) {
  const out = {};
  out.user_id = parseInt(b.user_id, 10) || null;
  out.shift_date = RE_DATE.test(b.shift_date) ? b.shift_date : null;
  out.start_time = RE_TIME.test(b.start_time) ? b.start_time : null;
  out.end_time = RE_TIME.test(b.end_time) ? b.end_time : null;
  out.position_id = b.position_id ? (parseInt(b.position_id, 10) || null) : null;
  out.city_code = b.city_code ? String(b.city_code).trim().slice(0, 3) : null;
  out.break_minutes = Math.max(0, parseInt(b.break_minutes, 10) || 0);
  out.notes = (b.notes || '').toString().trim() || null;
  return out;
}

// Compute warn-but-allow conflicts for a candidate shift.
async function computeConflicts(cand, excludeId) {
  const warnings = [];
  if (!cand.user_id || !cand.shift_date) return warnings;
  const u = await pool.query('SELECT name, role FROM users WHERE id = $1', [cand.user_id]);
  const role = u.rows.length ? u.rows[0].role : null;

  // Overlap on the same day
  const sameDay = await pool.query(
    'SELECT id, start_time, end_time, break_minutes FROM shifts WHERE user_id = $1 AND shift_date = $2 AND id <> $3',
    [cand.user_id, cand.shift_date, excludeId || 0]
  );
  let cs = timeToMin(cand.start_time), ce = timeToMin(cand.end_time); if (ce <= cs) ce += 1440;
  for (const r of sameDay.rows) {
    let rs = timeToMin(r.start_time), re = timeToMin(r.end_time); if (re <= rs) re += 1440;
    if (cs < re && rs < ce) { warnings.push('Overlaps another shift the same day (' + fmtTime(r.start_time) + '–' + fmtTime(r.end_time) + ').'); break; }
  }

  // Overtime — only for roles that have an OT restriction
  if (role && NO_OT_ROLES.indexOf(role) === -1) {
    const wkStart = mondayOf(cand.shift_date), wkEnd = addDays(wkStart, 6);
    const wk = await pool.query(
      'SELECT id, start_time, end_time, break_minutes FROM shifts WHERE user_id = $1 AND shift_date BETWEEN $2 AND $3 AND id <> $4',
      [cand.user_id, wkStart, wkEnd, excludeId || 0]
    );
    let total = shiftMinutes(cand);
    for (const r of wk.rows) total += shiftMinutes(r);
    if (total > 40 * 60) warnings.push('Puts this employee over 40 hrs this week (' + (total / 60).toFixed(1) + ' hrs).');
  }
  return warnings;
}

// ---- employee: my schedule -------------------------------------------------
router.get('/me', requireAuth, requirePermission('view_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.query.from) ? req.query.from : mondayOf(ymd(new Date()));
  const to = RE_DATE.test(req.query.to) ? req.query.to : addDays(from, 13);
  const { rows } = await pool.query(
    'SELECT s.*, p.name AS position_name, p.color AS position_color, c.name AS city_name, c.color AS city_color ' +
    'FROM shifts s LEFT JOIN shift_positions p ON p.id = s.position_id LEFT JOIN cities c ON c.code = s.city_code ' +
    "WHERE s.user_id = $1 AND s.status = 'published' AND s.shift_date BETWEEN $2 AND $3 " +
    'ORDER BY s.shift_date, s.start_time',
    [req.user.id, from, to]
  );
  res.json(rows);
});

// ---- employee: whole-city schedule ----------------------------------------
router.get('/city', requireAuth, requirePermission('view_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.query.from) ? req.query.from : mondayOf(ymd(new Date()));
  const to = RE_DATE.test(req.query.to) ? req.query.to : addDays(from, 13);
  const scope = await allowedCities(req.user); // null = all cities
  const reqCity = (req.query.city || '').toString().trim().slice(0, 3);

  // Cities this employee is allowed to view
  let cities;
  if (scope === null) {
    cities = (await pool.query('SELECT code, name, color FROM cities WHERE active IS NOT FALSE ORDER BY name ASC')).rows;
  } else if (scope.length) {
    cities = (await pool.query('SELECT code, name, color FROM cities WHERE TRIM(code) = ANY($1) AND active IS NOT FALSE ORDER BY name ASC', [scope])).rows;
  } else {
    cities = [];
  }

  // Which city codes to actually pull shifts for
  let codes;
  if (reqCity && (scope === null || scope.indexOf(reqCity) !== -1)) codes = [reqCity];
  else codes = cities.map(function (c) { return (c.code || '').trim(); });

  let shifts = [];
  if (codes.length) {
    const r = await pool.query(
      'SELECT s.*, p.name AS position_name, p.color AS position_color, c.name AS city_name, c.color AS city_color, u.name AS user_name ' +
      'FROM shifts s LEFT JOIN shift_positions p ON p.id = s.position_id LEFT JOIN cities c ON c.code = s.city_code ' +
      'JOIN users u ON u.id = s.user_id ' +
      "WHERE s.status = 'published' AND TRIM(s.city_code) = ANY($1) AND s.shift_date BETWEEN $2 AND $3 " +
      'AND COALESCE(u.hide_from_schedule, false) = false ' +
      'ORDER BY s.shift_date, s.start_time',
      [codes, from, to]
    );
    shifts = r.rows;
  }
  res.json({ cities: cities, shifts: shifts });
});

// ---- positions -------------------------------------------------------------
router.get('/positions', requireAuth, requirePermission('view_schedule'), async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM shift_positions ORDER BY active DESC, name ASC');
  res.json(rows);
});
router.post('/positions', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Position name is required' });
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : '#f97316';
  const { rows } = await pool.query('INSERT INTO shift_positions (name, color) VALUES ($1, $2) RETURNING *', [name.slice(0, 100), color]);
  res.status(201).json(rows[0]);
});
router.put('/positions/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Position name is required' });
  const color = /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : '#f97316';
  const active = req.body.active !== false;
  const { rows } = await pool.query('UPDATE shift_positions SET name=$1, color=$2, active=$3 WHERE id=$4 RETURNING *', [name.slice(0, 100), color, active, req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Position not found' });
  res.json(rows[0]);
});
router.delete('/positions/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  await pool.query('DELETE FROM shift_positions WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ---- shifts ----------------------------------------------------------------
router.get('/shifts', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.query.from) ? req.query.from : mondayOf(ymd(new Date()));
  const to = RE_DATE.test(req.query.to) ? req.query.to : addDays(from, 6);
  const scope = await allowedCities(req.user);
  const params = [from, to];
  let sql = 'SELECT s.*, p.name AS position_name, p.color AS position_color, c.color AS city_color, c.name AS city_name FROM shifts s ' +
    'LEFT JOIN shift_positions p ON p.id = s.position_id LEFT JOIN cities c ON c.code = s.city_code WHERE s.shift_date BETWEEN $1 AND $2';
  if (req.query.city && String(req.query.city).trim()) {
    params.push(String(req.query.city).trim()); sql += ' AND s.city_code = $' + params.length;
  }
  if (scope !== null) {
    if (!scope.length) return res.json([]);
    params.push(scope); sql += ' AND s.city_code = ANY($' + params.length + '::text[])';
  }
  sql += ' ORDER BY s.shift_date, s.start_time';
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

router.post('/shifts', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const c = cleanShift(req.body || {});
  if (!c.user_id || !c.shift_date || !c.start_time || !c.end_time) {
    return res.status(400).json({ error: 'Employee, date, start and end time are required' });
  }
  if (!c.position_id) return res.status(400).json({ error: 'A position is required' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, c.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [c.user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;
  const publish = !!(req.body && (req.body.publish === true || req.body.publish === 'true'));
  const { rows } = await pool.query(
    'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, status, published_at, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
    [c.user_id, uname, c.city_code, c.position_id, c.shift_date, c.start_time, c.end_time, c.break_minutes, c.notes, publish ? 'published' : 'draft', publish ? new Date() : null, req.user.id]
  );
  const conflicts = await computeConflicts(c, rows[0].id);
  res.status(201).json({ shift: rows[0], conflicts: conflicts });
});

router.put('/shifts/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const c = cleanShift(req.body || {});
  if (!c.user_id || !c.shift_date || !c.start_time || !c.end_time) {
    return res.status(400).json({ error: 'Employee, date, start and end time are required' });
  }
  if (!c.position_id) return res.status(400).json({ error: 'A position is required' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, c.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [c.user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;
  const params = [c.user_id, uname, c.city_code, c.position_id, c.shift_date, c.start_time, c.end_time, c.break_minutes, c.notes];
  let extra = '';
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'publish')) {
    const publish = (req.body.publish === true || req.body.publish === 'true');
    params.push(publish ? 'published' : 'draft'); extra += ', status=$' + params.length;
    params.push(publish ? new Date() : null); extra += ', published_at=$' + params.length;
  }
  params.push(req.params.id);
  const { rows } = await pool.query(
    'UPDATE shifts SET user_id=$1, user_name=$2, city_code=$3, position_id=$4, shift_date=$5, start_time=$6, end_time=$7, break_minutes=$8, notes=$9' + extra + ', updated_at=NOW() WHERE id=$' + params.length + ' RETURNING *',
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Shift not found' });
  const conflicts = await computeConflicts(c, rows[0].id);
  res.json({ shift: rows[0], conflicts: conflicts });
});

router.delete('/shifts/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  await pool.query('DELETE FROM shifts WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// ---- publish ---------------------------------------------------------------
router.post('/publish', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.body.from) ? req.body.from : null;
  const to = RE_DATE.test(req.body.to) ? req.body.to : null;
  if (!from || !to) return res.status(400).json({ error: 'A week range is required' });
  const scope = await allowedCities(req.user);
  const params = [from, to];
  let sql = "UPDATE shifts SET status='published', published_at=NOW() WHERE status='draft' AND shift_date BETWEEN $1 AND $2";
  if (req.body.city && String(req.body.city).trim()) { params.push(String(req.body.city).trim()); sql += ' AND city_code = $' + params.length; }
  if (scope !== null) {
    if (!scope.length) return res.json({ published: 0, notified: 0 });
    params.push(scope); sql += ' AND city_code = ANY($' + params.length + '::text[])';
  }
  sql += ' RETURNING user_id';
  const { rows } = await pool.query(sql, params);
  await logAudit({ entity_type: 'schedule', action: 'published', user_id: req.user.id, user_name: req.user.name, details: { from: from, to: to, shifts: rows.length } });
  res.json({ published: rows.length });
});

// ---- bulk action on a specific set of shift ids (grid multi-select) -------
router.post('/bulk-ids', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '').trim();
  let ids = Array.isArray(b.ids) ? b.ids.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return Number.isInteger(x) && x > 0; }) : [];
  ids = Array.from(new Set(ids));
  if (!ids.length) return res.status(400).json({ error: 'No shifts selected' });
  if (ids.length > 1000) return res.status(400).json({ error: 'Too many shifts selected (max 1000)' });
  const scope = await allowedCities(req.user);
  // Build the id (+ city-scope) guard, appended after any SET params.
  function guard(setParams) {
    const params = setParams.slice();
    params.push(ids); let clause = ' WHERE id = ANY($' + params.length + '::int[])';
    if (scope !== null) {
      if (!scope.length) return null; // assigned to no cities -> affects nothing
      params.push(scope); clause += ' AND TRIM(city_code) = ANY($' + params.length + '::text[])';
    }
    return { clause: clause, params: params };
  }

  if (action === 'delete') {
    const g = guard([]); if (!g) return res.json({ affected: 0 });
    const r = await pool.query('DELETE FROM shifts' + g.clause + ' RETURNING id', g.params);
    await logAudit({ entity_type: 'schedule', action: 'bulk_delete', user_id: req.user.id, user_name: req.user.name, details: { count: r.rows.length } });
    return res.json({ affected: r.rows.length });
  }

  if (action === 'publish' || action === 'unpublish') {
    const pub = action === 'publish';
    const g = guard([pub ? 'published' : 'draft', pub ? new Date() : null]); if (!g) return res.json({ affected: 0 });
    const r = await pool.query('UPDATE shifts SET status=$1, published_at=$2, updated_at=NOW()' + g.clause + ' RETURNING id', g.params);
    await logAudit({ entity_type: 'schedule', action: pub ? 'bulk_publish' : 'bulk_unpublish', user_id: req.user.id, user_name: req.user.name, details: { count: r.rows.length } });
    return res.json({ affected: r.rows.length });
  }

  if (action === 'update') {
    const sets = []; const vals = [];
    if (RE_TIME.test(b.start_time)) { vals.push(b.start_time); sets.push('start_time=$' + vals.length); }
    if (RE_TIME.test(b.end_time)) { vals.push(b.end_time); sets.push('end_time=$' + vals.length); }
    if (Object.prototype.hasOwnProperty.call(b, 'position_id')) { vals.push(b.position_id ? (parseInt(b.position_id, 10) || null) : null); sets.push('position_id=$' + vals.length); }
    if (b.break_minutes !== undefined && b.break_minutes !== '' && b.break_minutes !== null) { vals.push(Math.max(0, parseInt(b.break_minutes, 10) || 0)); sets.push('break_minutes=$' + vals.length); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    const g = guard(vals); if (!g) return res.json({ affected: 0 });
    const r = await pool.query('UPDATE shifts SET ' + sets.join(', ') + ', updated_at=NOW()' + g.clause + ' RETURNING id', g.params);
    return res.json({ affected: r.rows.length });
  }

  if (action === 'reassign') {
    const uid = parseInt(b.user_id, 10) || null;
    if (!uid) return res.status(400).json({ error: 'Pick an employee to reassign to' });
    const u = await pool.query('SELECT name FROM users WHERE id=$1', [uid]);
    if (!u.rows.length) return res.status(400).json({ error: 'Employee not found' });
    const g = guard([uid, u.rows[0].name]); if (!g) return res.json({ affected: 0 });
    const r = await pool.query('UPDATE shifts SET user_id=$1, user_name=$2, updated_at=NOW()' + g.clause + ' RETURNING id', g.params);
    return res.json({ affected: r.rows.length });
  }

  return res.status(400).json({ error: 'Unknown action' });
});

// ---- copy week -------------------------------------------------------------
router.post('/copy-week', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const src = RE_DATE.test(req.body.source_monday) ? req.body.source_monday : null;
  const tgt = RE_DATE.test(req.body.target_monday) ? req.body.target_monday : null;
  if (!src || !tgt) return res.status(400).json({ error: 'Source and target week are required' });
  function _u(ds) { const a = ds.split('-').map(Number); return Date.UTC(a[0], a[1] - 1, a[2]); }
  const offset = Math.round((_u(tgt) - _u(src)) / 86400000);
  const scope = await allowedCities(req.user);
  const params = [src, addDays(src, 6)];
  let sql = 'SELECT * FROM shifts WHERE shift_date BETWEEN $1 AND $2';
  if (req.body.city && String(req.body.city).trim()) { params.push(String(req.body.city).trim()); sql += ' AND city_code = $' + params.length; }
  if (scope !== null) {
    if (!scope.length) return res.json({ copied: 0 });
    params.push(scope); sql += ' AND city_code = ANY($' + params.length + '::text[])';
  }
  const { rows } = await pool.query(sql, params);
  let copied = 0;
  for (const s of rows) {
    const sd = s.shift_date instanceof Date ? ymd(new Date(Date.UTC(s.shift_date.getUTCFullYear(), s.shift_date.getUTCMonth(), s.shift_date.getUTCDate()))) : String(s.shift_date).slice(0, 10);
    const nd = addDays(sd, offset);
    await pool.query(
      'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, status, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)",
      [s.user_id, s.user_name, s.city_code, s.position_id, nd, s.start_time, s.end_time, s.break_minutes, s.notes, req.user.id]
    );
    copied++;
  }
  res.json({ copied: copied });
});

// ---- scope + per-user city membership (assignment lives in /api/users) -----
router.get('/my-scope', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const scope = await allowedCities(req.user);
  res.json({ cities: scope });
});
router.get('/user-cities', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const users = await pool.query('SELECT id, name, role FROM users WHERE active=true ORDER BY name');
  const map = await pool.query('SELECT user_id, city_code FROM user_cities');
  const byUser = {};
  map.rows.forEach(function (r) { (byUser[r.user_id] = byUser[r.user_id] || []).push((r.city_code || '').trim()); });
  res.json(users.rows.map(function (u) { return { user_id: u.id, name: u.name, role: u.role, city_codes: byUser[u.id] || [] }; }));
});

// Bulk recurring shifts: generate a draft shift on each selected weekday for N weeks.
router.post('/recurring', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const b = req.body || {};
  const user_id = parseInt(b.user_id, 10) || null;
  const start_date = RE_DATE.test(b.start_date) ? b.start_date : null;
  const start_time = RE_TIME.test(b.start_time) ? b.start_time : null;
  const end_time = RE_TIME.test(b.end_time) ? b.end_time : null;
  let weeks = parseInt(b.weeks, 10); if (isNaN(weeks) || weeks < 1) weeks = 1; if (weeks > 53) weeks = 53;
  let dows = Array.isArray(b.weekdays) ? b.weekdays.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x >= 0 && x <= 6; }) : [];
  dows = Array.from(new Set(dows));
  if (!user_id || !start_date || !start_time || !end_time || !dows.length) {
    return res.status(400).json({ error: 'Employee, start date, times, and at least one weekday are required' });
  }
  const position_id = b.position_id ? (parseInt(b.position_id, 10) || null) : null;
  if (!position_id) return res.status(400).json({ error: 'A position is required' });
  const city_code = b.city_code ? String(b.city_code).trim().slice(0, 3) : null;
  const break_minutes = Math.max(0, parseInt(b.break_minutes, 10) || 0);
  const notes = (b.notes || '').toString().trim() || null;
  const publish = !!(b.publish === true || b.publish === 'true');
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;
  let created = 0;
  const total = weeks * 7;
  for (let i = 0; i < total; i++) {
    const d = addDays(start_date, i);
    if (dows.indexOf(dowOf(d)) === -1) continue;
    await pool.query(
      'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, status, published_at, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [user_id, uname, city_code, position_id, d, start_time, end_time, break_minutes, notes, publish ? 'published' : 'draft', publish ? new Date() : null, req.user.id]
    );
    created++;
  }
  res.json({ created: created });
});

// Bulk delete or update an employee's shifts across a date range (e.g. vacation).
router.post('/bulk', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const b = req.body || {};
  const user_id = parseInt(b.user_id, 10) || null;
  const from = RE_DATE.test(b.from) ? b.from : null;
  const to = RE_DATE.test(b.to) ? b.to : null;
  if (!user_id || !from || !to) return res.status(400).json({ error: 'Employee and date range are required' });
  const action = b.action === 'update' ? 'update' : 'delete';
  const scope = await allowedCities(req.user);
  function cityClause(params) {
    let sql = '';
    if (b.city && String(b.city).trim()) { params.push(String(b.city).trim()); sql += ' AND city_code = $' + params.length; }
    if (scope !== null) { if (!scope.length) return null; params.push(scope); sql += ' AND city_code = ANY($' + params.length + '::text[])'; }
    return sql;
  }
  if (action === 'delete') {
    const params = [user_id, from, to];
    const cc = cityClause(params); if (cc === null) return res.json({ affected: 0 });
    const r = await pool.query('DELETE FROM shifts WHERE user_id=$1 AND shift_date BETWEEN $2 AND $3' + cc, params);
    return res.json({ affected: r.rowCount });
  }
  const sets = [], params = [];
  if (RE_TIME.test(b.start_time)) { params.push(b.start_time); sets.push('start_time=$' + params.length); }
  if (RE_TIME.test(b.end_time)) { params.push(b.end_time); sets.push('end_time=$' + params.length); }
  if (b.position_id !== undefined && b.position_id !== null && b.position_id !== '') { params.push(parseInt(b.position_id, 10) || null); sets.push('position_id=$' + params.length); }
  if (b.break_minutes !== undefined && b.break_minutes !== '' && b.break_minutes !== null) { params.push(Math.max(0, parseInt(b.break_minutes, 10) || 0)); sets.push('break_minutes=$' + params.length); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  params.push(user_id); const pu = params.length; params.push(from); const pf = params.length; params.push(to); const pt = params.length;
  let sql = 'UPDATE shifts SET ' + sets.join(', ') + ', updated_at=NOW() WHERE user_id=$' + pu + ' AND shift_date BETWEEN $' + pf + ' AND $' + pt;
  const cc = cityClause(params); if (cc === null) return res.json({ affected: 0 });
  sql += cc;
  const r = await pool.query(sql, params);
  res.json({ affected: r.rowCount });
});

// Each (user, day) scheduled in the range (for the per-day no-work comparison).
router.get('/scheduled-users', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.query.from) ? req.query.from : mondayOf(ymd(new Date()));
  const to = RE_DATE.test(req.query.to) ? req.query.to : addDays(from, 6);
  const scope = await allowedCities(req.user);
  const params = [from, to];
  let sql = 'SELECT DISTINCT s.user_id, COALESCE(u.name, s.user_name) AS name, u.pulsar_name, s.shift_date FROM shifts s LEFT JOIN users u ON u.id = s.user_id WHERE s.shift_date BETWEEN $1 AND $2 AND s.user_id IS NOT NULL';
  if (req.query.city && String(req.query.city).trim()) { params.push(String(req.query.city).trim()); sql += ' AND s.city_code = $' + params.length; }
  if (scope !== null) { if (!scope.length) return res.json([]); params.push(scope); sql += ' AND s.city_code = ANY($' + params.length + '::text[])'; }
  sql += ' ORDER BY name';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(function (r) {
    var sd = r.shift_date instanceof Date ? ymd(new Date(Date.UTC(r.shift_date.getUTCFullYear(), r.shift_date.getUTCMonth(), r.shift_date.getUTCDate()))) : String(r.shift_date).slice(0, 10);
    return { user_id: r.user_id, name: r.name, pulsar_name: r.pulsar_name || null, shift_date: sd };
  }));
});

module.exports = router;
