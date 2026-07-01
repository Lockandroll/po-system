const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// All timestamps are set by the SERVER (NOW()). The phone only sends the action,
// so the clock can't be tampered with. Worked-minutes math uses absolute
// timestamp differences; only "today" grouping and lateness use the app timezone.
const TZ = 'America/New_York';

// ---- time helpers ----------------------------------------------------------
function nyDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function nyMinutes(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  let h = 0, m = 0;
  parts.forEach(function (p) { if (p.type === 'hour') h = parseInt(p.value, 10) % 24; if (p.type === 'minute') m = parseInt(p.value, 10); });
  return h * 60 + m;
}
function ymd(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function addDays(dateStr, n) {
  const a = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
  dt.setUTCDate(dt.getUTCDate() + n);
  return ymd(dt);
}
// Monday of the week containing dateStr (pay week = Mon..Sun).
function mondayOf(dateStr) {
  const a = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(a[0], a[1] - 1, a[2]));
  const day = dt.getUTCDay(); // 0=Sun..6=Sat
  return addDays(dateStr, -(day === 0 ? 6 : day - 1));
}
function shiftStartMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}
function minsBetween(a, b) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000); }
function hhmm(mins) {
  mins = Math.max(0, Math.round(mins));
  return Math.floor(mins / 60) + ':' + String(mins % 60).padStart(2, '0');
}

// Worked minutes for a closed entry = gross - unpaid breaks (paid breaks count).
function workedMinutes(entry, breaks) {
  if (!entry.clock_out_at) return null;
  const gross = minsBetween(entry.clock_in_at, entry.clock_out_at);
  let unpaid = 0;
  (breaks || []).forEach(function (b) {
    if (b.type === 'unpaid' && b.break_end_at) unpaid += minsBetween(b.break_start_at, b.break_end_at);
  });
  return Math.max(0, gross - unpaid);
}

async function loadBreaks(entryId) {
  const r = await pool.query('SELECT * FROM time_breaks WHERE entry_id = $1 ORDER BY break_start_at', [entryId]);
  return r.rows;
}
async function openEntryFor(userId) {
  const r = await pool.query("SELECT * FROM time_entries WHERE user_id = $1 AND status = 'open' ORDER BY clock_in_at DESC LIMIT 1", [userId]);
  return r.rows[0] || null;
}
async function openBreakFor(entryId) {
  const r = await pool.query('SELECT * FROM time_breaks WHERE entry_id = $1 AND break_end_at IS NULL ORDER BY break_start_at DESC LIMIT 1', [entryId]);
  return r.rows[0] || null;
}
async function primaryCity(userId) {
  const r = await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1 ORDER BY city_code LIMIT 1', [userId]);
  return r.rows.length ? r.rows[0].city_code : null;
}
async function setting(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows.length && r.rows[0].value != null ? r.rows[0].value : fallback;
  } catch (e) { return fallback; }
}

// Approval is restricted to the employee's manager — anyone up their reports-to
// chain — or any admin/owner (owner is coerced to role 'admin' by middleware).
async function inChain(managerId, employeeId) {
  let cur = employeeId, depth = 0;
  while (cur && depth < 25) {
    const r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [cur]);
    const sup = r.rows.length ? r.rows[0].supervisor_id : null;
    if (!sup) return false;
    if (sup === managerId) return true;
    cur = sup; depth++;
  }
  return false;
}
async function canApprove(user, employeeId) {
  if (user.role === 'admin') return true;
  return inChain(user.id, employeeId);
}

// ============================================================================
//  EMPLOYEE — punch + own timesheet
// ============================================================================

// Current state for the punch UI. Drives everything.
router.get('/status', requireAuth, async function (req, res) {
  const uid = req.user.id;
  const entry = await openEntryFor(uid);
  let state = 'out', open = null, brk = null;
  if (entry) {
    open = entry;
    brk = await openBreakFor(entry.id);
    state = brk ? 'break' : 'in';
  }
  // Today's punches (in app TZ)
  const today = nyDateStr(new Date());
  const todays = await pool.query(
    "SELECT * FROM time_entries WHERE user_id = $1 AND (clock_in_at AT TIME ZONE $2)::date = $3 ORDER BY clock_in_at",
    [uid, TZ, today]
  );
  // Week total (worked minutes for current Mon..Sun)
  const wkStart = mondayOf(today);
  const wkEnd = addDays(wkStart, 6);
  const wk = await pool.query(
    "SELECT COALESCE(SUM(worked_minutes),0) AS mins FROM time_entries WHERE user_id = $1 AND status IN ('closed','auto_closed','flagged') AND (clock_in_at AT TIME ZONE $2)::date BETWEEN $3 AND $4",
    [uid, TZ, wkStart, wkEnd]
  );
  res.json({
    state: state,
    openEntry: open,
    openBreak: brk,
    breakType: brk ? brk.type : null,
    today: todays.rows,
    weekStart: wkStart,
    weekMinutes: parseInt(wk.rows[0].mins, 10) || 0
  });
});

router.post('/clock-in', requireAuth, async function (req, res) {
  const uid = req.user.id;
  if (await openEntryFor(uid)) return res.status(409).json({ error: 'You are already clocked in.' });
  const city = await primaryCity(uid);
  // Match a published shift for today to enable lateness + late alerts.
  const today = nyDateStr(new Date());
  const sh = await pool.query(
    "SELECT id, start_time FROM shifts WHERE user_id = $1 AND shift_date = $2 AND status = 'published' ORDER BY start_time LIMIT 1",
    [uid, today]
  );
  let shiftId = null, lateMin = null;
  if (sh.rows.length) {
    shiftId = sh.rows[0].id;
    lateMin = nyMinutes(new Date()) - shiftStartMin(sh.rows[0].start_time);
  }
  const r = await pool.query(
    "INSERT INTO time_entries (user_id, user_name, city_code, shift_id, clock_in_at, status, late_minutes, source) VALUES ($1,$2,$3,$4,NOW(),'open',$5,'pwa') RETURNING *",
    [uid, req.user.name, city, shiftId, lateMin]
  );
  res.json(r.rows[0]);
});

router.post('/clock-out', requireAuth, async function (req, res) {
  const uid = req.user.id;
  const entry = await openEntryFor(uid);
  if (!entry) return res.status(409).json({ error: 'You are not clocked in.' });
  // Auto-end any open break at clock-out.
  const ob = await openBreakFor(entry.id);
  if (ob) {
    await pool.query('UPDATE time_breaks SET break_end_at = NOW(), minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - break_start_at))/60) WHERE id = $1', [ob.id]);
  }
  await pool.query("UPDATE time_entries SET clock_out_at = NOW(), status = 'closed', updated_at = NOW() WHERE id = $1", [entry.id]);
  // Recompute worked_minutes from stored rows.
  const fresh = (await pool.query('SELECT * FROM time_entries WHERE id = $1', [entry.id])).rows[0];
  const breaks = await loadBreaks(entry.id);
  const worked = workedMinutes(fresh, breaks);
  await pool.query('UPDATE time_entries SET worked_minutes = $1 WHERE id = $2', [worked, entry.id]);
  fresh.worked_minutes = worked;
  res.json(fresh);
});

router.post('/break/start', requireAuth, async function (req, res) {
  const uid = req.user.id;
  const type = req.body && req.body.type === 'paid' ? 'paid' : 'unpaid';
  const entry = await openEntryFor(uid);
  if (!entry) return res.status(409).json({ error: 'Clock in before starting a break.' });
  if (await openBreakFor(entry.id)) return res.status(409).json({ error: 'You are already on a break.' });
  const r = await pool.query(
    "INSERT INTO time_breaks (entry_id, type, break_start_at) VALUES ($1,$2,NOW()) RETURNING *",
    [entry.id, type]
  );
  res.json(r.rows[0]);
});

router.post('/break/end', requireAuth, async function (req, res) {
  const uid = req.user.id;
  const entry = await openEntryFor(uid);
  if (!entry) return res.status(409).json({ error: 'You are not clocked in.' });
  const ob = await openBreakFor(entry.id);
  if (!ob) return res.status(409).json({ error: 'You are not on a break.' });
  const r = await pool.query(
    'UPDATE time_breaks SET break_end_at = NOW(), minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - break_start_at))/60) WHERE id = $1 RETURNING *',
    [ob.id]
  );
  res.json(r.rows[0]);
});

// Own timesheet for a date range, grouped by day with breaks.
router.get('/timesheet', requireAuth, async function (req, res) {
  const uid = req.user.id;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : mondayOf(nyDateStr(new Date()));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : addDays(from, 6);
  const rows = await timesheetRows(uid, from, to);
  const wk = await weekApproval(uid, mondayOf(from));
  res.json({ from: from, to: to, entries: rows, approval: wk });
});

async function timesheetRows(uid, from, to) {
  const er = await pool.query(
    "SELECT * FROM time_entries WHERE user_id = $1 AND (clock_in_at AT TIME ZONE $2)::date BETWEEN $3 AND $4 ORDER BY clock_in_at",
    [uid, TZ, from, to]
  );
  const out = [];
  for (const e of er.rows) {
    e.breaks = await loadBreaks(e.id);
    out.push(e);
  }
  return out;
}

// Employee approves their own week.
router.post('/week/approve', requireAuth, async function (req, res) {
  const wkStart = mondayOf(req.body && req.body.weekStart ? req.body.weekStart : nyDateStr(new Date()));
  await ensureWeek(req.user.id, wkStart);
  await pool.query(
    "UPDATE time_week_approvals SET employee_approved_at = NOW(), status = 'emp_approved' WHERE user_id = $1 AND week_start = $2 AND status IN ('open','reopened')",
    [req.user.id, wkStart]
  );
  res.json(await weekApproval(req.user.id, wkStart));
});

// ============================================================================
//  MANAGER — board, all timesheets, corrections, approvals, submit
// ============================================================================

// Who's clocked in right now + who's on break.
router.get('/board', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const rows = (await pool.query(
    "SELECT e.*, u.role AS user_role, b.type AS on_break_type, b.break_start_at AS on_break_since " +
    "FROM time_entries e JOIN users u ON u.id = e.user_id " +
    "LEFT JOIN time_breaks b ON b.entry_id = e.id AND b.break_end_at IS NULL " +
    "WHERE e.status = 'open' ORDER BY e.clock_in_at"
  )).rows;
  // Flags needing review
  const flags = (await pool.query(
    "SELECT * FROM time_entries WHERE status IN ('auto_closed','flagged') AND clock_in_at > NOW() - INTERVAL '30 days' ORDER BY clock_in_at DESC LIMIT 100"
  )).rows;
  res.json({ open: rows, flags: flags });
});

// All users' timesheets for a range (+ approval state).
router.get('/admin', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : mondayOf(nyDateStr(new Date()));
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : addDays(from, 6);
  const wkStart = mondayOf(from);
  const users = (await pool.query(
    "SELECT DISTINCT u.id, u.name, u.pay_type FROM users u " +
    "JOIN time_entries e ON e.user_id = u.id AND (e.clock_in_at AT TIME ZONE $1)::date BETWEEN $2 AND $3 " +
    "WHERE u.active = true ORDER BY u.name",
    [TZ, from, to]
  )).rows;
  const out = [];
  for (const u of users) {
    const rows = await timesheetRows(u.id, from, to);
    const mins = rows.reduce(function (s, e) { return s + (e.worked_minutes || 0); }, 0);
    out.push({ user: u, minutes: mins, approval: await weekApproval(u.id, wkStart), canApprove: await canApprove(req.user, u.id), entries: rows });
  }
  res.json({ from: from, to: to, weekStart: wkStart, users: out });
});

// Correct an entry (times/break). Requires a reason. Audited; original kept in details.
router.patch('/entry/:id', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = (req.body && req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A correction reason is required.' });
  const cur = (await pool.query('SELECT * FROM time_entries WHERE id = $1', [id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Entry not found.' });
  if (await weekLocked(cur.user_id, mondayOf(nyDateStr(new Date(cur.clock_in_at))))) {
    return res.status(423).json({ error: 'That week is submitted. Reopen it before editing.' });
  }
  const newIn = req.body.clock_in_at || cur.clock_in_at;
  const newOut = req.body.clock_out_at !== undefined ? req.body.clock_out_at : cur.clock_out_at;
  await pool.query(
    "UPDATE time_entries SET clock_in_at = $1, clock_out_at = $2, edited_by = $3, edited_at = NOW(), edit_reason = $4, status = CASE WHEN $2 IS NULL THEN 'open' ELSE 'closed' END, updated_at = NOW() WHERE id = $5",
    [newIn, newOut, req.user.id, reason, id]
  );
  const fresh = (await pool.query('SELECT * FROM time_entries WHERE id = $1', [id])).rows[0];
  const breaks = await loadBreaks(id);
  const worked = workedMinutes(fresh, breaks);
  await pool.query('UPDATE time_entries SET worked_minutes = $1 WHERE id = $2', [worked, id]);
  await logAudit({ entity_type: 'time_entry', entity_id: id, action: 'correct', user_id: req.user.id, user_name: req.user.name,
    details: { reason: reason, before: { in: cur.clock_in_at, out: cur.clock_out_at, worked: cur.worked_minutes }, after: { in: newIn, out: newOut, worked: worked } } });
  fresh.worked_minutes = worked;
  res.json(fresh);
});

// Manually add a missed entry for an employee (audited).
router.post('/entry', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const uid = parseInt(req.body.user_id, 10);
  const cin = req.body.clock_in_at, cout = req.body.clock_out_at || null;
  if (!uid || !cin) return res.status(400).json({ error: 'user_id and clock_in_at are required.' });
  const u = (await pool.query('SELECT name FROM users WHERE id = $1', [uid])).rows[0];
  const city = await primaryCity(uid);
  const r = await pool.query(
    "INSERT INTO time_entries (user_id, user_name, city_code, clock_in_at, clock_out_at, status, source, edited_by, edited_at, edit_reason) " +
    "VALUES ($1,$2,$3,$4,$5,$6,'manual',$7,NOW(),$8) RETURNING *",
    [uid, u ? u.name : null, city, cin, cout, cout ? 'closed' : 'open', req.user.id, (req.body.reason || 'Manual entry')]
  );
  const worked = workedMinutes(r.rows[0], []);
  await pool.query('UPDATE time_entries SET worked_minutes = $1 WHERE id = $2', [worked, r.rows[0].id]);
  await logAudit({ entity_type: 'time_entry', entity_id: r.rows[0].id, action: 'manual_add', user_id: req.user.id, user_name: req.user.name, details: { for: uid } });
  res.json(r.rows[0]);
});

// Manager approves an employee's week (employee must have approved first).
router.post('/week/mgr-approve', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const uid = parseInt(req.body.user_id, 10);
  if (!(await canApprove(req.user, uid))) return res.status(403).json({ error: 'Only this person\'s manager or an admin can approve their timesheet.' });
  const wkStart = mondayOf(req.body.weekStart || nyDateStr(new Date()));
  const wk = await ensureWeek(uid, wkStart);
  if (!wk.employee_approved_at) return res.status(409).json({ error: 'Employee has not approved this week yet.' });
  await pool.query(
    "UPDATE time_week_approvals SET manager_approved_by = $1, manager_approved_at = NOW(), status = 'mgr_approved' WHERE user_id = $2 AND week_start = $3",
    [req.user.id, uid, wkStart]
  );
  await logAudit({ entity_type: 'time_week', entity_id: uid, action: 'mgr_approve', user_id: req.user.id, user_name: req.user.name, details: { weekStart: wkStart } });
  res.json(await weekApproval(uid, wkStart));
});

// Submit an approved week: build the Excel sheet and email it to payroll.
router.post('/week/submit', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const uid = parseInt(req.body.user_id, 10);
  if (!(await canApprove(req.user, uid))) return res.status(403).json({ error: 'Only this person\'s manager or an admin can submit their timesheet.' });
  const wkStart = mondayOf(req.body.weekStart || nyDateStr(new Date()));
  const wk = await ensureWeek(uid, wkStart);
  if (wk.status !== 'mgr_approved') return res.status(409).json({ error: 'Both employee and manager must approve before submitting.' });
  const u = (await pool.query('SELECT name FROM users WHERE id = $1', [uid])).rows[0];
  const rows = await timesheetRows(uid, wkStart, addDays(wkStart, 6));
  const xml = buildTimesheetXls(u ? u.name : ('User ' + uid), wkStart, rows);
  const payrollTo = await setting('timeclock_payroll_email', process.env.PAYROLL_EMAIL || process.env.FROM_EMAIL);
  const total = rows.reduce(function (s, e) { return s + (e.worked_minutes || 0); }, 0);
  const html = emailTemplate({
    badge: 'PAYROLL', badgeColor: '#f97316',
    title: 'Timesheet — ' + (u ? u.name : uid),
    body: 'Approved timesheet for the week of ' + wkStart + '. Total worked: ' + hhmm(total) + '. The Excel sheet is attached.',
    footerNote: 'Submitted by ' + req.user.name + ' via Nova Time Clock.'
  });
  await sendEmail(
    payrollTo,
    'Timesheet — ' + (u ? u.name : uid) + ' — week of ' + wkStart,
    html, null,
    [{ filename: 'timesheet-' + (u ? u.name.replace(/[^a-z0-9]+/gi, '_') : uid) + '-' + wkStart + '.xls', content: Buffer.from(xml, 'utf8').toString('base64') }]
  );
  await pool.query("UPDATE time_week_approvals SET submitted_at = NOW(), status = 'submitted' WHERE user_id = $1 AND week_start = $2", [uid, wkStart]);
  await logAudit({ entity_type: 'time_week', entity_id: uid, action: 'submit', user_id: req.user.id, user_name: req.user.name, details: { weekStart: wkStart, to: payrollTo, total: total } });
  res.json(await weekApproval(uid, wkStart));
});

// Reopen a submitted/approved week for correction.
router.post('/week/reopen', requireAuth, requirePermission('manage_timeclock'), async function (req, res) {
  const uid = parseInt(req.body.user_id, 10);
  const wkStart = mondayOf(req.body.weekStart || nyDateStr(new Date()));
  await pool.query(
    "UPDATE time_week_approvals SET status = 'reopened', employee_approved_at = NULL, manager_approved_at = NULL, manager_approved_by = NULL, submitted_at = NULL WHERE user_id = $1 AND week_start = $2",
    [uid, wkStart]
  );
  await logAudit({ entity_type: 'time_week', entity_id: uid, action: 'reopen', user_id: req.user.id, user_name: req.user.name, details: { weekStart: wkStart } });
  res.json(await weekApproval(uid, wkStart));
});

// ---- approval helpers ------------------------------------------------------
async function ensureWeek(uid, wkStart) {
  await pool.query(
    "INSERT INTO time_week_approvals (user_id, week_start, status) VALUES ($1,$2,'open') ON CONFLICT (user_id, week_start) DO NOTHING",
    [uid, wkStart]
  );
  return weekApproval(uid, wkStart);
}
async function weekApproval(uid, wkStart) {
  const r = await pool.query('SELECT * FROM time_week_approvals WHERE user_id = $1 AND week_start = $2', [uid, wkStart]);
  return r.rows[0] || { user_id: uid, week_start: wkStart, status: 'open' };
}
async function weekLocked(uid, wkStart) {
  const wk = await weekApproval(uid, wkStart);
  return wk.status === 'submitted';
}

// ---- Excel (SpreadsheetML 2003) — zero-dependency, opens natively in Excel --
function xesc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function cellStr(v) { return '<Cell><Data ss:Type="String">' + xesc(v) + '</Data></Cell>'; }
function cellNum(v) { return '<Cell><Data ss:Type="Number">' + (v == null ? '' : v) + '</Data></Cell>'; }
function fmtClock(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ts));
}
function fmtDay(ts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ts));
}
function buildTimesheetXls(name, wkStart, rows) {
  let body = '';
  let total = 0;
  rows.forEach(function (e) {
    let unpaid = 0, paid = 0;
    (e.breaks || []).forEach(function (b) {
      const mins = b.break_end_at ? minsBetween(b.break_start_at, b.break_end_at) : 0;
      if (b.type === 'unpaid') unpaid += mins; else paid += mins;
    });
    const worked = e.worked_minutes || 0;
    total += worked;
    body += '<Row>' +
      cellStr(fmtDay(e.clock_in_at)) +
      cellStr(fmtClock(e.clock_in_at)) +
      cellStr(fmtClock(e.clock_out_at)) +
      cellNum(unpaid) +
      cellNum(paid) +
      cellNum((worked / 60).toFixed(2)) +
      cellStr(e.status) +
      '</Row>';
  });
  const header = '<Row>' + ['Day', 'Clock In', 'Clock Out', 'Unpaid min', 'Paid break min', 'Worked hrs', 'Status']
    .map(function (h) { return '<Cell><Data ss:Type="String">' + h + '</Data></Cell>'; }).join('') + '</Row>';
  const totalRow = '<Row>' + cellStr('WEEK TOTAL') + cellStr('') + cellStr('') + cellStr('') + cellStr('') + cellNum((total / 60).toFixed(2)) + cellStr('') + '</Row>';
  return '<?xml version="1.0"?>' +
    '<?mso-application progid="Excel.Sheet"?>' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Worksheet ss:Name="' + xesc(name).slice(0, 28) + '"><Table>' +
    '<Row><Cell><Data ss:Type="String">Timesheet: ' + xesc(name) + ' — week of ' + xesc(wkStart) + '</Data></Cell></Row><Row></Row>' +
    header + body + totalRow +
    '</Table></Worksheet></Workbook>';
}

module.exports = router;
