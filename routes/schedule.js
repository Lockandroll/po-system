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

// ---- manager-only notes ------------------------------------------------------
// shifts.manager_notes is for call-outs and the like. Only a manager, admin or
// owner may read or write it (owner arrives here as role 'admin' + isOwner).
// It is gated by ROLE, not by manage_schedule, because that permission can be
// handed to other roles in Roles & Access and this must not travel with it.
const MGR_NOTE_ROLES = ['manager', 'admin'];
function canSeeMgrNotes(user) {
  return !!user && (user.isOwner === true || MGR_NOTE_ROLES.indexOf(user.role) !== -1);
}
// Drop manager_notes from rows going to anyone who may not see them. Mutates and
// returns the same array so it can wrap a res.json() argument.
function stripMgrNotes(rows, user) {
  if (canSeeMgrNotes(user)) return rows;
  for (const r of rows) { if (r && Object.prototype.hasOwnProperty.call(r, 'manager_notes')) delete r.manager_notes; }
  return rows;
}
function cleanMgrNotes(v) { return (v || '').toString().trim() || null; }
// Today's date for the shop (Eastern), as YYYY-MM-DD.
function todayLocal() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ---- recurring schedule (series) ---------------------------------------------
// Validate + normalize a series definition from a request body. Returns
// { def } or { error }.
function cleanSeries(b) {
  const def = {};
  def.user_id = parseInt(b.user_id, 10) || null;
  def.start_date = RE_DATE.test(b.start_date) ? b.start_date : null;
  def.start_time = RE_TIME.test(b.start_time) ? b.start_time : null;
  def.end_time = RE_TIME.test(b.end_time) ? b.end_time : null;
  let weeks = parseInt(b.weeks, 10); if (isNaN(weeks) || weeks < 1) weeks = 1; if (weeks > 53) weeks = 53;
  def.weeks = weeks;
  // Two patterns: 'weekly' repeats on fixed weekdays; 'rotation' rolls an X-on / Y-off
  // cycle from start_date (day 0 = first working day), which drifts across the week.
  def.mode = (b.mode === 'rotation') ? 'rotation' : 'weekly';
  let dows = Array.isArray(b.weekdays) ? b.weekdays.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x >= 0 && x <= 6; }) : [];
  def.weekdays = Array.from(new Set(dows));
  let daysOn = parseInt(b.days_on, 10); if (isNaN(daysOn) || daysOn < 1) daysOn = 0;
  let daysOff = parseInt(b.days_off, 10); if (isNaN(daysOff) || daysOff < 0) daysOff = 0;
  def.days_on = daysOn; def.days_off = daysOff;
  if (def.mode === 'rotation') {
    if (!def.user_id || !def.start_date || !def.start_time || !def.end_time || daysOn < 1 || (daysOn + daysOff) < 1) {
      return { error: 'Employee, start date, times, and a valid days-on / days-off rotation are required' };
    }
  } else if (!def.user_id || !def.start_date || !def.start_time || !def.end_time || !def.weekdays.length) {
    return { error: 'Employee, start date, times, and at least one weekday are required' };
  }
  def.position_id = b.position_id ? (parseInt(b.position_id, 10) || null) : null;
  if (!def.position_id) return { error: 'A position is required' };
  def.city_code = b.city_code ? String(b.city_code).trim().slice(0, 3) : null;
  def.break_minutes = Math.max(0, parseInt(b.break_minutes, 10) || 0);
  def.notes = (b.notes || '').toString().trim() || null;
  def.manager_notes = cleanMgrNotes(b.manager_notes);
  return { def: def };
}
// Every date the definition puts a shift on. `notBefore` (YYYY-MM-DD, optional)
// drops the days before it WITHOUT shifting the rotation: the cycle is always
// counted from start_date, so an edit applied mid-cycle keeps the same rhythm.
function seriesDates(def, notBefore) {
  const out = [];
  const cycleLen = (parseInt(def.days_on, 10) || 0) + (parseInt(def.days_off, 10) || 0);
  const daysOn = parseInt(def.days_on, 10) || 0;
  const dows = Array.isArray(def.weekdays) ? def.weekdays.map(Number) : [];
  const start = typeof def.start_date === 'string' ? def.start_date : sdstr(def.start_date);
  const total = (parseInt(def.weeks, 10) || 1) * 7;
  for (let i = 0; i < total; i++) {
    const d = addDays(start, i);
    if (def.mode === 'rotation') {
      if (cycleLen < 1 || (i % cycleLen) >= daysOn) continue; // in the "off" stretch of the cycle
    } else if (dows.indexOf(dowOf(d)) === -1) {
      continue;
    }
    if (notBefore && d < notBefore) continue;
    out.push(d);
  }
  return out;
}
// Insert one shift per date for a series. Returns the count.
async function insertSeriesShifts(def, seriesId, dates, uname, actor) {
  let created = 0;
  for (const d of dates) {
    const _ins = await pool.query(
      'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, manager_notes, status, published_at, created_by, series_id) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published',NOW(),$11,$12) RETURNING id",
      [def.user_id, uname, def.city_code, def.position_id, d, def.start_time, def.end_time, def.break_minutes, def.notes, def.manager_notes, actor.id, seriesId]
    );
    await logShiftEvent(pool, { shift_id: _ins.rows[0].id, employee_id: def.user_id, action: 'created', actor_id: actor.id, actor_name: actor.name, details: { via: 'recurring', shift_date: d, series_id: seriesId } });
    created++;
  }
  return created;
}
const SERIES_SELECT = 'SELECT ss.*, u.name AS user_name, p.name AS position_name FROM shift_series ss LEFT JOIN users u ON u.id = ss.user_id LEFT JOIN shift_positions p ON p.id = ss.position_id';
function seriesOut(row, user) {
  if (!row) return row;
  row.start_date = sdstr(row.start_date);
  if (!canSeeMgrNotes(user)) delete row.manager_notes;
  return row;
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

// ---- shift change history (best-effort audit trail) ------------------------
// A shift_date column comes back from pg as a Date; normalize it to YYYY-MM-DD.
function sdstr(v) {
  return v instanceof Date
    ? ymd(new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())))
    : String(v || '').slice(0, 10);
}
// Normalize one field for a stable from/to comparison (dates to YYYY-MM-DD,
// times to HH:MM) so we do not log spurious "changes".
function cmpVal(f, v) {
  if (v === null || v === undefined) return '';
  if (f === 'shift_date') return sdstr(v);
  if (f === 'start_time' || f === 'end_time') return String(v).slice(0, 5);
  if (f === 'city_code') return String(v).trim(); // CHAR(3) can be space-padded
  return String(v).slice(0, 80);
}
// { field: {from,to} } for every field that actually changed between two rows.
function shiftDiff(prev, next) {
  const out = {};
  const fields = ['user_id', 'city_code', 'position_id', 'shift_date', 'start_time', 'end_time', 'break_minutes', 'notes', 'manager_notes', 'status'];
  for (const f of fields) {
    const a = cmpVal(f, prev ? prev[f] : undefined);
    const b = cmpVal(f, next ? next[f] : undefined);
    if (a !== b) out[f] = { from: a, to: b };
  }
  return out;
}
// Write one history row. NEVER throws: a logging failure must not break a
// schedule write. Pass the pool (or a tx client) as db.
async function logShiftEvent(db, e) {
  try {
    await (db || pool).query(
      'INSERT INTO shift_events (shift_id, employee_id, action, actor_id, actor_name, details) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
      [e.shift_id || null, e.employee_id || null, e.action, e.actor_id || null, e.actor_name || null, e.details ? JSON.stringify(e.details) : null]
    );
  } catch (err) { console.error('[schedule] shift_event log failed:', err.message); }
}

// One shape for a shift row everywhere it is read, so the single-shift refetch the
// editor does returns exactly the same fields the week grid put in its cache.
const SHIFT_SELECT =
  'SELECT s.*, p.name AS position_name, p.color AS position_color, c.color AS city_color, c.name AS city_name, ' +
  'cb.name AS created_by_name, pp.name AS prev_position_name FROM shifts s ' +
  'LEFT JOIN shift_positions p ON p.id = s.position_id LEFT JOIN cities c ON c.code = s.city_code ' +
  'LEFT JOIN users cb ON cb.id = s.created_by LEFT JOIN shift_positions pp ON pp.id = s.prev_position_id';

// ---- optimistic concurrency for shift writes -------------------------------
// The editor loads a shift, the user sits on the modal, someone else moves the
// shift, then the first user saves. Because the form PUTs every field, that save
// silently reverted the other person's change - and the audit log recorded it as
// a deliberate date edit, which is how this was found. So the client sends back
// the updated_at it loaded with, and we refuse the write if the row moved on.
//
// A missing expected_updated_at skips the check on purpose: older clients, the
// bulk routes and the PTO job keep working exactly as before.
function isStale(expected, row) {
  if (!expected || !row) return false;
  const cur = row.updated_at || row.created_at;
  if (!cur) return false;
  const a = new Date(expected).getTime();
  const b = new Date(cur).getTime();
  if (!isFinite(a) || !isFinite(b)) return false;
  if (Math.abs(a - b) <= 1000) return false; // same row (tolerate ms/serialization drift)
  return a < b;                              // only block when the stored copy is NEWER
}
// Who touched it last, so the 409 can name them instead of saying "someone".
async function lastEditor(shiftId) {
  try {
    const r = await pool.query(
      "SELECT actor_name FROM shift_events WHERE shift_id = $1 AND action <> 'created' ORDER BY created_at DESC, id DESC LIMIT 1",
      [shiftId]
    );
    if (r.rows.length && r.rows[0].actor_name) return r.rows[0].actor_name;
  } catch (err) { console.error('[schedule] lastEditor lookup failed:', err.message); }
  return null;
}
function staleConflict(res, row) {
  return lastEditor(row.id).then(function (who) {
    return res.status(409).json({
      stale: true,
      error: (who || 'Someone else') + ' changed this shift after you opened it. Reload it before saving.',
      changed_by: who,
      changed_at: row.updated_at || row.created_at,
      shift_id: row.id
    });
  });
}
// Only these move sources are recorded; anything else is dropped rather than trusted.
function cleanVia(v) {
  return (v === 'drag' || v === 'drag_undo') ? v : null;
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
  res.json(stripMgrNotes(rows, req.user));
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
    shifts = stripMgrNotes(r.rows, req.user);
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
  // expects_calls is optional so older callers (colour/name-only edits) leave it alone.
  const ec = (req.body.expects_calls === undefined || req.body.expects_calls === null) ? null : (req.body.expects_calls !== false && req.body.expects_calls !== 'false' && req.body.expects_calls !== 0);
  const { rows } = await pool.query('UPDATE shift_positions SET name=$1, color=$2, active=$3, expects_calls=COALESCE($5, expects_calls) WHERE id=$4 RETURNING *', [name.slice(0, 100), color, active, req.params.id, ec]);
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
  let sql = SHIFT_SELECT + ' WHERE s.shift_date BETWEEN $1 AND $2';
  if (req.query.city && String(req.query.city).trim()) {
    params.push(String(req.query.city).trim()); sql += ' AND s.city_code = $' + params.length;
  }
  if (scope !== null) {
    if (!scope.length) return res.json([]);
    params.push(scope); sql += ' AND s.city_code = ANY($' + params.length + '::text[])';
  }
  sql += ' ORDER BY s.shift_date, s.start_time';
  const { rows } = await pool.query(sql, params);
  res.json(stripMgrNotes(rows, req.user));
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
  // No drafts any more: a shift on the schedule is live the moment it is saved.
  const mgrNotes = canSeeMgrNotes(req.user) ? cleanMgrNotes(req.body && req.body.manager_notes) : null;
  const { rows } = await pool.query(
    'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, manager_notes, status, published_at, created_by) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published',NOW(),$11) RETURNING *",
    [c.user_id, uname, c.city_code, c.position_id, c.shift_date, c.start_time, c.end_time, c.break_minutes, c.notes, mgrNotes, req.user.id]
  );
  await logShiftEvent(pool, { shift_id: rows[0].id, employee_id: c.user_id, action: 'created', actor_id: req.user.id, actor_name: req.user.name, details: { shift_date: c.shift_date, start_time: c.start_time, end_time: c.end_time, position_id: c.position_id, city_code: c.city_code } });
  const conflicts = await computeConflicts(c, rows[0].id);
  res.status(201).json({ shift: stripMgrNotes(rows, req.user)[0], conflicts: conflicts });
});

router.put('/shifts/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const c = cleanShift(req.body || {});
  if (!c.user_id || !c.shift_date || !c.start_time || !c.end_time) {
    return res.status(400).json({ error: 'Employee, date, start and end time are required' });
  }
  if (!c.position_id) return res.status(400).json({ error: 'A position is required' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, c.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  // Check the city the shift is in RIGHT NOW as well. Validating only the incoming
  // city_code let a city-scoped scheduler pull another market's shift into their own
  // by passing their own city in the body.
  const cur = await pool.query('SELECT * FROM shifts WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Shift not found' });
  if (!cityOk(scope, cur.rows[0].city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  // Refuse a write built on a copy of the row that is already out of date.
  if (isStale(req.body && req.body.expected_updated_at, cur.rows[0])) return staleConflict(res, cur.rows[0]);
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [c.user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;
  const params = [c.user_id, uname, c.city_code, c.position_id, c.shift_date, c.start_time, c.end_time, c.break_minutes, c.notes];
  let extra = '';
  // Manager-only notes: only a manager-level role may change them, and only when the
  // field was actually sent. A drag move or an older client PUTs without it and must
  // not wipe a call-out note somebody else wrote.
  let mgrNotes = cur.rows[0].manager_notes || null;
  if (canSeeMgrNotes(req.user) && req.body && Object.prototype.hasOwnProperty.call(req.body, 'manager_notes')) {
    mgrNotes = cleanMgrNotes(req.body.manager_notes);
    params.push(mgrNotes); extra += ', manager_notes=$' + params.length;
  }
  params.push(req.params.id);
  const { rows } = await pool.query(
    'UPDATE shifts SET user_id=$1, user_name=$2, city_code=$3, position_id=$4, shift_date=$5, start_time=$6, end_time=$7, break_minutes=$8, notes=$9' + extra + ', updated_at=NOW() WHERE id=$' + params.length + ' RETURNING *',
    params
  );
  if (!rows.length) return res.status(404).json({ error: 'Shift not found' });
  const _next = { user_id: c.user_id, city_code: c.city_code, position_id: c.position_id, shift_date: c.shift_date, start_time: c.start_time, end_time: c.end_time, break_minutes: c.break_minutes, notes: c.notes, manager_notes: mgrNotes, status: rows[0].status };
  const _changes = shiftDiff(cur.rows[0], _next);
  if (Object.keys(_changes).length) {
    // Record HOW it changed. A drag across the grid and a deliberate form edit
    // both land here as an identical PUT; without this the history cannot tell
    // an accidental drag from someone typing a new date.
    const _details = { changes: _changes };
    const _via = cleanVia(req.body && req.body.via);
    if (_via) _details.via = _via;
    await logShiftEvent(pool, { shift_id: rows[0].id, employee_id: c.user_id, action: 'updated', actor_id: req.user.id, actor_name: req.user.name, details: _details });
  }
  const conflicts = await computeConflicts(c, rows[0].id);
  res.json({ shift: stripMgrNotes(rows, req.user)[0], conflicts: conflicts });
});

router.delete('/shifts/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  // Create and update are city-scoped; delete was not, so any id could be deleted
  // from any market by anyone holding manage_schedule.
  const scope = await allowedCities(req.user);
  const ex = await pool.query('SELECT * FROM shifts WHERE id=$1', [req.params.id]);
  if (!ex.rows.length) return res.status(404).json({ error: 'Shift not found' });
  if (!cityOk(scope, ex.rows[0].city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  if (isStale(req.body && req.body.expected_updated_at, ex.rows[0])) return staleConflict(res, ex.rows[0]);
  await pool.query('DELETE FROM shifts WHERE id=$1', [req.params.id]);
  await logShiftEvent(pool, { shift_id: parseInt(req.params.id, 10) || null, employee_id: ex.rows[0].user_id, action: 'deleted', actor_id: req.user.id, actor_name: req.user.name, details: { shift_date: sdstr(ex.rows[0].shift_date), position_id: ex.rows[0].position_id, status: ex.rows[0].status } });
  res.json({ success: true });
});

// ---- one shift, read live --------------------------------------------------
// The editor calls this every time it opens a shift. Building the form from the
// week grid's cached array instead is what let a stale tab silently overwrite
// someone else's change on save.
router.get('/shifts/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const { rows } = await pool.query(SHIFT_SELECT + ' WHERE s.id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Shift not found' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, rows[0].city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  res.json(stripMgrNotes(rows, req.user)[0]);
});

// ---- per-shift change history (editor timeline) ---------------------------
router.get('/shifts/:id/history', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const ex = await pool.query('SELECT city_code FROM shifts WHERE id=$1', [id]);
  if (!ex.rows.length) return res.status(404).json({ error: 'Shift not found' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, ex.rows[0].city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const { rows } = await pool.query(
    'SELECT e.id, e.action, e.actor_id, e.actor_name, e.details, e.created_at, u.name AS actor_name_now ' +
    'FROM shift_events e LEFT JOIN users u ON u.id = e.actor_id ' +
    'WHERE e.shift_id = $1 ORDER BY e.created_at ASC, e.id ASC',
    [id]
  );
  if (!canSeeMgrNotes(req.user)) {
    for (const r of rows) {
      let d = r.details;
      if (d && typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
      if (d && d.changes && d.changes.manager_notes) { delete d.changes.manager_notes; r.details = d; }
    }
  }
  res.json(rows);
});

// ---- publish: REMOVED 2026-09-03 --------------------------------------------
// There is no draft/published distinction any more. If a shift is on the schedule
// it is live. Every writer in this file stamps status='published' directly.

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
    for (const _r of r.rows) { await logShiftEvent(pool, { shift_id: _r.id, action: 'deleted', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'bulk' } }); }
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
    for (const _r of r.rows) { await logShiftEvent(pool, { shift_id: _r.id, action: 'updated', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'bulk' } }); }
    return res.json({ affected: r.rows.length });
  }

  if (action === 'reassign') {
    const uid = parseInt(b.user_id, 10) || null;
    if (!uid) return res.status(400).json({ error: 'Pick an employee to reassign to' });
    const u = await pool.query('SELECT name FROM users WHERE id=$1', [uid]);
    if (!u.rows.length) return res.status(400).json({ error: 'Employee not found' });
    const g = guard([uid, u.rows[0].name]); if (!g) return res.json({ affected: 0 });
    const r = await pool.query('UPDATE shifts SET user_id=$1, user_name=$2, updated_at=NOW()' + g.clause + ' RETURNING id', g.params);
    for (const _r of r.rows) { await logShiftEvent(pool, { shift_id: _r.id, employee_id: uid, action: 'reassigned', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'bulk', to: u.rows[0].name } }); }
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
    const _ins = await pool.query(
      'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, status, published_at, created_by) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'published',NOW(),$10) RETURNING id",
      [s.user_id, s.user_name, s.city_code, s.position_id, nd, s.start_time, s.end_time, s.break_minutes, s.notes, req.user.id]
    );
    await logShiftEvent(pool, { shift_id: _ins.rows[0].id, employee_id: s.user_id, action: 'created', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'copy_week', shift_date: nd } });
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

// Recurring shifts: save the definition as a shift_series row and generate one
// shift per matching day - either on selected weekdays (weekly) or on a rolling
// X-on / Y-off rotation (e.g. 4 on, 2 off). Every generated shift carries the
// series id so the schedule can later be edited as one thing (PUT /series/:id).
router.post('/recurring', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const v = cleanSeries(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const def = v.def;
  if (!canSeeMgrNotes(req.user)) def.manager_notes = null;
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, def.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [def.user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;
  const ins = await pool.query(
    'INSERT INTO shift_series (user_id, city_code, position_id, mode, weekdays, days_on, days_off, start_date, weeks, start_time, end_time, break_minutes, notes, manager_notes, created_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id',
    [def.user_id, def.city_code, def.position_id, def.mode, def.mode === 'weekly' ? def.weekdays : null, def.mode === 'rotation' ? def.days_on : null, def.mode === 'rotation' ? def.days_off : null, def.start_date, def.weeks, def.start_time, def.end_time, def.break_minutes, def.notes, def.manager_notes, req.user.id]
  );
  const seriesId = ins.rows[0].id;
  const created = await insertSeriesShifts(def, seriesId, seriesDates(def, null), uname, req.user);
  await logAudit({ entity_type: 'schedule', action: 'series_created', user_id: req.user.id, user_name: req.user.name, details: { series_id: seriesId, employee_id: def.user_id, mode: def.mode, start_date: def.start_date, weeks: def.weeks, shifts: created } });
  res.json({ created: created, series_id: seriesId });
});

// ---- recurring schedule (series): read + update ------------------------------
router.get('/series/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const { rows } = await pool.query(SERIES_SELECT + ' WHERE ss.id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Recurring schedule not found' });
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, rows[0].city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  // How many of its shifts are still ahead, so the editor can say what an update touches.
  const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM shifts WHERE series_id = $1 AND shift_date >= $2', [id, todayLocal()]);
  const out = seriesOut(rows[0], req.user);
  out.future_shifts = cnt.rows[0].n;
  res.json(out);
});

// Update a recurring schedule. Shifts of the series dated on/after `apply_from`
// (default today) are removed and regenerated from the new definition; earlier
// shifts are left exactly as they were, so history already worked is untouched.
// A one-off edit someone made to a future shift of this series is replaced too -
// the series definition wins from apply_from forward, which is what "update the
// recurring schedule" means.
router.put('/series/:id', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const b = req.body || {};
  const ex = await pool.query('SELECT * FROM shift_series WHERE id = $1', [id]);
  if (!ex.rows.length) return res.status(404).json({ error: 'Recurring schedule not found' });
  const prev = ex.rows[0];
  const scope = await allowedCities(req.user);
  if (!cityOk(scope, prev.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  // Fields not sent keep their saved value, so a partial body is a safe edit.
  const merged = {
    user_id: b.user_id !== undefined ? b.user_id : prev.user_id,
    start_date: b.start_date !== undefined ? b.start_date : sdstr(prev.start_date),
    start_time: b.start_time !== undefined ? b.start_time : prev.start_time,
    end_time: b.end_time !== undefined ? b.end_time : prev.end_time,
    weeks: b.weeks !== undefined ? b.weeks : prev.weeks,
    mode: b.mode !== undefined ? b.mode : prev.mode,
    weekdays: b.weekdays !== undefined ? b.weekdays : (prev.weekdays || []),
    days_on: b.days_on !== undefined ? b.days_on : prev.days_on,
    days_off: b.days_off !== undefined ? b.days_off : prev.days_off,
    position_id: b.position_id !== undefined ? b.position_id : prev.position_id,
    city_code: b.city_code !== undefined ? b.city_code : prev.city_code,
    break_minutes: b.break_minutes !== undefined ? b.break_minutes : prev.break_minutes,
    notes: b.notes !== undefined ? b.notes : prev.notes,
    manager_notes: b.manager_notes !== undefined ? b.manager_notes : prev.manager_notes
  };
  const v = cleanSeries(merged);
  if (v.error) return res.status(400).json({ error: v.error });
  const def = v.def;
  if (!canSeeMgrNotes(req.user)) def.manager_notes = prev.manager_notes || null;
  if (!cityOk(scope, def.city_code)) return res.status(403).json({ error: 'You are not assigned to that city' });
  const applyFrom = RE_DATE.test(b.apply_from) ? b.apply_from : todayLocal();
  const u = await pool.query('SELECT name FROM users WHERE id=$1', [def.user_id]);
  const uname = u.rows.length ? u.rows[0].name : null;

  const client = await pool.connect();
  let removed = 0, created = 0;
  try {
    await client.query('BEGIN');
    const del = await client.query('DELETE FROM shifts WHERE series_id = $1 AND shift_date >= $2 RETURNING id, user_id, shift_date', [id, applyFrom]);
    removed = del.rows.length;
    await client.query(
      'UPDATE shift_series SET user_id=$1, city_code=$2, position_id=$3, mode=$4, weekdays=$5, days_on=$6, days_off=$7, start_date=$8, weeks=$9, start_time=$10, end_time=$11, break_minutes=$12, notes=$13, manager_notes=$14, updated_at=NOW() WHERE id=$15',
      [def.user_id, def.city_code, def.position_id, def.mode, def.mode === 'weekly' ? def.weekdays : null, def.mode === 'rotation' ? def.days_on : null, def.mode === 'rotation' ? def.days_off : null, def.start_date, def.weeks, def.start_time, def.end_time, def.break_minutes, def.notes, def.manager_notes, id]
    );
    const dates = seriesDates(def, applyFrom);
    for (const d of dates) {
      await client.query(
        'INSERT INTO shifts (user_id, user_name, city_code, position_id, shift_date, start_time, end_time, break_minutes, notes, manager_notes, status, published_at, created_by, series_id) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'published',NOW(),$11,$12)",
        [def.user_id, uname, def.city_code, def.position_id, d, def.start_time, def.end_time, def.break_minutes, def.notes, def.manager_notes, req.user.id, id]
      );
      created++;
    }
    await client.query('COMMIT');
    for (const _r of del.rows) { await logShiftEvent(pool, { shift_id: _r.id, employee_id: _r.user_id, action: 'deleted', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'series_update', series_id: id, shift_date: sdstr(_r.shift_date) } }); }
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    console.error('[schedule] series update failed:', err.message);
    return res.status(500).json({ error: 'Could not update the recurring schedule' });
  } finally { client.release(); }
  await logAudit({ entity_type: 'schedule', action: 'series_updated', user_id: req.user.id, user_name: req.user.name, details: { series_id: id, employee_id: def.user_id, apply_from: applyFrom, removed: removed, created: created } });
  res.json({ series_id: id, apply_from: applyFrom, removed: removed, created: created });
});

// Bulk delete or update an employee's shifts across a date range (e.g. vacation).
router.post('/bulk', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const b = req.body || {};
  const user_id = parseInt(b.user_id, 10) || null;
  const from = RE_DATE.test(b.from) ? b.from : null;
  // all_future: everything from `from` onward, no upper bound (the shift editor's
  // "Delete this + all future" button).
  const allFuture = (b.all_future === true || b.all_future === 'true');
  const to = RE_DATE.test(b.to) ? b.to : (allFuture ? '9999-12-31' : null);
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
    const r = await pool.query('DELETE FROM shifts WHERE user_id=$1 AND shift_date BETWEEN $2 AND $3' + cc + ' RETURNING id', params);
    for (const _r of r.rows) { await logShiftEvent(pool, { shift_id: _r.id, employee_id: user_id, action: 'deleted', actor_id: req.user.id, actor_name: req.user.name, details: { via: allFuture ? 'delete_future' : 'bulk_range', from: from } }); }
    if (allFuture) await logAudit({ entity_type: 'schedule', action: 'delete_future_shifts', user_id: req.user.id, user_name: req.user.name, details: { employee_id: user_id, from: from, count: r.rowCount } });
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
  const r = await pool.query(sql + ' RETURNING id', params);
  for (const _r of r.rows) { await logShiftEvent(pool, { shift_id: _r.id, employee_id: user_id, action: 'updated', actor_id: req.user.id, actor_name: req.user.name, details: { via: 'bulk_range' } }); }
  res.json({ affected: r.rowCount });
});

// Every shift in the range, with what the No-Work report needs to judge it:
// the user's Pulsar name / nickname / role (name matching + office-staff
// filter), the position and whether it expects calls (vacation, call-out and
// office positions are excused, not flagged), and start/end so an overnight
// shift can be credited with calls that Pulsar dates on the following day.
// One row per shift, not DISTINCT per day: the client groups by (user, day)
// and a day counts as worked if ANY of its shifts is.
router.get('/scheduled-users', requireAuth, requirePermission('manage_schedule'), async (req, res) => {
  const from = RE_DATE.test(req.query.from) ? req.query.from : mondayOf(ymd(new Date()));
  const to = RE_DATE.test(req.query.to) ? req.query.to : addDays(from, 6);
  const scope = await allowedCities(req.user);
  const params = [from, to];
  let sql = 'SELECT s.id, s.user_id, COALESCE(u.name, s.user_name) AS name, u.pulsar_name, u.nickname, u.role, s.city_code, s.shift_date, s.start_time, s.end_time, ' +
    'p.name AS position_name, COALESCE(p.expects_calls, true) AS expects_calls ' +
    'FROM shifts s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN shift_positions p ON p.id = s.position_id ' +
    'WHERE s.shift_date BETWEEN $1 AND $2 AND s.user_id IS NOT NULL';
  if (req.query.city && String(req.query.city).trim()) { params.push(String(req.query.city).trim()); sql += ' AND s.city_code = $' + params.length; }
  if (scope !== null) { if (!scope.length) return res.json([]); params.push(scope); sql += ' AND s.city_code = ANY($' + params.length + '::text[])'; }
  sql += ' ORDER BY name, s.shift_date, s.start_time';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(function (r) {
    var sd = r.shift_date instanceof Date ? ymd(new Date(Date.UTC(r.shift_date.getUTCFullYear(), r.shift_date.getUTCMonth(), r.shift_date.getUTCDate()))) : String(r.shift_date).slice(0, 10);
    return {
      shift_id: r.id, user_id: r.user_id, name: r.name, pulsar_name: r.pulsar_name || null, nickname: r.nickname || null,
      role: r.role || null, city_code: (r.city_code || '').trim() || null, shift_date: sd,
      start_time: r.start_time, end_time: r.end_time, position_name: r.position_name || null, expects_calls: r.expects_calls !== false
    };
  }));
});

module.exports = router;
