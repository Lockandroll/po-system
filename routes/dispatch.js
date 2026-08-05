const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const duty = require('../utils/duty');
const permissions = require('../utils/permissions');
const push = require('../utils/push');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Who is allowed to run the board vs who is allowed to work it
// ---------------------------------------------------------------------------
async function hasPerm(req, perm) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (e) {}
  const ep = req._userRow && req._userRow.extra_perms;
  return Array.isArray(ep) && ep.indexOf(perm) !== -1;
}

// Handing a call to someone else is a smaller thing than running the board, so
// it is a separate permission. manage_dispatch implies it.
async function canAssign(req) {
  return (await canManage(req)) || (await hasPerm(req, 'assign_dispatch'));
}

async function canManage(req) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try {
    if (await permissions.hasPermission(req.user.role, 'manage_dispatch')) return true;
  } catch (e) {}
  const ep = req._userRow && req._userRow.extra_perms;
  return Array.isArray(ep) && ep.indexOf('manage_dispatch') !== -1;
}

// THE GATE. A tech who is not ready to accept calls does not get the board.
// Enforced here, not only in the UI, so the answer is the same whether the
// request comes from the app, a browser, or anything else.
async function requireBoardAccess(req, res, next) {
  if (await canManage(req)) { req._dispatchManage = true; return next(); }
  if (await duty.isReady(req.user.id)) { req._dispatchManage = false; return next(); }
  return res.status(403).json({
    error: 'Mark yourself ready to accept calls to see the dispatch board.',
    reason: 'not_ready'
  });
}

// ---------------------------------------------------------------------------
//  DUTY
// ---------------------------------------------------------------------------
router.get('/duty', requireAuth, async function (req, res) {
  const d = await duty.getDuty(req.user.id);
  res.json({
    ready: !!d.ready,
    ready_since: d.ready_since,
    hours_on_duty: duty.hoursOnDuty(d),
    canManage: await canManage(req)
  });
});

router.post('/duty', requireAuth, async function (req, res) {
  const ready = !!(req.body && (req.body.ready === true || req.body.ready === 'true' || req.body.ready === 1 || req.body.ready === '1'));
  const d = await duty.setReady(req.user.id, ready, req.user.id, (req.body && req.body.note) || null);
  await logAudit({
    entity_type: 'tech_duty', entity_id: req.user.id, action: ready ? 'ready' : 'not_ready',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip
  });
  res.json({ ready: !!d.ready, ready_since: d.ready_since, hours_on_duty: duty.hoursOnDuty(d) });
});

// A dispatcher clearing someone who forgot. Deliberately one-way: a manager can
// take a tech OFF duty, never put them on. Being available is the tech's call,
// and marking someone ready from the office would start tracking a person who
// never agreed to it.
router.post('/duty/:userId/clear', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const uid = parseInt(req.params.userId, 10);
  if (!uid) return res.status(400).json({ error: 'Bad user' });
  const d = await duty.setReady(uid, false, req.user.id, (req.body && req.body.note) || 'Cleared by dispatch');
  await logAudit({
    entity_type: 'tech_duty', entity_id: uid, action: 'cleared_by_dispatch',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip
  });
  res.json({ ok: true, ready: !!d.ready });
});

// Everyone's duty state, for the board and the map.
router.get('/duty/all', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const r = await pool.query(
    'SELECT u.id, u.name, u.role, u.phone, TRIM(u.home_city) AS home_city, ' +
    '       COALESCE(d.ready,false) AS ready, d.ready_since, d.last_changed_at ' +
    'FROM users u LEFT JOIN tech_duty d ON d.user_id = u.id ' +
    "WHERE u.active = true AND u.role IN ('locksmith','roadside_technician','locksmith_coordinator','dispatcher','manager') " +
    'ORDER BY COALESCE(d.ready,false) DESC, u.name'
  );
  const now = Date.now();
  res.json({
    people: r.rows.map(function (p) {
      const h = p.ready && p.ready_since ? (now - new Date(p.ready_since).getTime()) / 3600000 : null;
      return {
        user_id: p.id, name: p.name, role: p.role, phone: p.phone, home_city: p.home_city,
        ready: p.ready, ready_since: p.ready_since, hours_on_duty: h === null ? null : Math.round(h * 10) / 10
      };
    })
  });
});

// ---------------------------------------------------------------------------
//  JOBS
// ---------------------------------------------------------------------------
const STATUSES = ['new', 'assigned', 'accepted', 'enroute', 'onscene', 'done', 'goa', 'cancelled'];
const OPEN_STATUSES = ['new', 'assigned', 'accepted', 'enroute', 'onscene'];
// GOA (Gone On Arrival) closes a call, but it is NOT 'done'. Rolling it into
// done would quietly inflate completed-job counts with calls nobody worked.
const CLOSED_STATUSES = ['done', 'goa', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'urgent'];

function clean(b) {
  const s = function (v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null; };
  return {
    service_type: s(b.service_type, 80),
    customer_name: s(b.customer_name, 255),
    customer_phone: s(b.customer_phone, 50),
    address: s(b.address, 255),
    city_state_zip: s(b.city_state_zip, 255),
    city_code: b.city_code ? String(b.city_code).trim().slice(0, 3) : null,
    notes: s(b.notes, 4000),
    priority: PRIORITIES.indexOf(String(b.priority || '').toLowerCase()) !== -1 ? String(b.priority).toLowerCase() : 'normal'
  };
}

async function logEvent(jobId, event, req, detail) {
  try {
    await pool.query(
      'INSERT INTO dispatch_job_events (job_id, event, user_id, user_name, detail) VALUES ($1,$2,$3,$4,$5)',
      [jobId, event, req.user.id, req.user.name, detail || null]
    );
  } catch (e) { console.error('dispatch event log failed:', e.message); }
}


// ---------------------------------------------------------------------------
//  Alerts
// ---------------------------------------------------------------------------
// A push survives a locked screen, which a web page's beep does not. This is
// the alert that actually reaches a tech under a dashboard.
async function notifyAssigned(jobId, userId) {
  try {
    const r = await pool.query('SELECT job_number, service_type, address, priority FROM dispatch_jobs WHERE id = $1', [jobId]);
    if (!r.rows.length) return;
    const j = r.rows[0];
    await push.sendPushToUsers([userId], {
      title: (j.priority === 'urgent' ? 'URGENT call: ' : 'New call: ') + (j.service_type || j.job_number || 'Dispatch'),
      body: (j.address || 'Open Nova for details') + ' - tap to accept',
      url: '/?view=dispatch',
      tag: 'dispatch-' + jobId
    });
  } catch (e) { console.error('dispatch push failed:', e.message); }
}

// ---------------------------------------------------------------------------
//  The phone number is deliberately NOT on the board
// ---------------------------------------------------------------------------
// A tech taps Call and the phone dials, but the number never travels with the
// list. That means it cannot be read off the screen, copied, or kept, and every
// call to a customer leaves a record. Managers still see it, because dispatch
// reads numbers back to people all day.
function stripPhone(rows) {
  return rows.map(function (j) {
    const out = Object.assign({}, j);
    out.has_phone = !!out.customer_phone;
    delete out.customer_phone;
    return out;
  });
}

const JOB_SELECT =
  'SELECT j.*, u.name AS assigned_name, u.phone AS assigned_phone, ' +
  '       c.name AS city_name, c.color AS city_color, cb.name AS created_by_name ' +
  'FROM dispatch_jobs j ' +
  'LEFT JOIN users u ON u.id = j.assigned_to ' +
  'LEFT JOIN users cb ON cb.id = j.created_by ' +
  'LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) ';

// The board. Tony's call for now: everyone sees everyone's jobs, so a tech can
// see what the rest of the crew is on. Narrowing this later is a WHERE clause,
// not a rewrite.
router.get('/jobs', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const showDone = String(req.query.done || '') === '1';
  const params = [];
  var where = 'WHERE ';
  if (showDone) {
    where += "j.created_at > NOW() - interval '7 days'";
  } else {
    params.push(OPEN_STATUSES);
    where += 'j.status = ANY($1)';
  }
  const r = await pool.query(
    JOB_SELECT + where + ' ORDER BY ' +
    "CASE j.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, " +
    'j.created_at DESC LIMIT 300', params);
  var rows = r.rows;
  // Who has looked at each call, so dispatch can tell "never saw it" apart from
  // "saw it and did nothing".
  if (rows.length) {
    const ids = rows.map(function (j) { return j.id; });
    const v = await pool.query(
      'SELECT v.job_id, v.user_id, v.first_at, v.last_at, v.views, u.name ' +
      'FROM dispatch_job_views v JOIN users u ON u.id = v.user_id WHERE v.job_id = ANY($1)', [ids]);
    const byJob = {};
    v.rows.forEach(function (x) { (byJob[x.job_id] = byJob[x.job_id] || []).push(x); });
    rows.forEach(function (j) { j.views = byJob[j.id] || []; });
  }
  res.json({
    jobs: req._dispatchManage ? rows : stripPhone(rows),
    canManage: !!req._dispatchManage,
    canAssign: await canAssign(req),
    acceptTimeoutMinutes: await acceptTimeoutMinutes(),
    me: req.user.id
  });
});

router.get('/jobs/:id', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const ev = await pool.query('SELECT * FROM dispatch_job_events WHERE job_id = $1 ORDER BY at', [id]);
  const vw = await pool.query(
    'SELECT v.*, u.name FROM dispatch_job_views v JOIN users u ON u.id = v.user_id WHERE v.job_id = $1 ORDER BY v.first_at', [id]);
  await recordView(id, req.user.id);
  const job = req._dispatchManage ? r.rows[0] : stripPhone([r.rows[0]])[0];
  res.json({ job: job, events: ev.rows, views: vw.rows, canManage: !!req._dispatchManage });
});

router.post('/jobs', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const b = clean(req.body || {});
  if (!b.customer_name && !b.address) {
    return res.status(400).json({ error: 'A job needs at least a customer name or an address.' });
  }
  const assign = req.body && req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
  const r = await pool.query(
    'INSERT INTO dispatch_jobs (source, status, priority, service_type, customer_name, customer_phone, ' +
    'address, city_state_zip, city_code, notes, assigned_to, assigned_at, created_by) ' +
    "VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id",
    [assign ? 'assigned' : 'new', b.priority, b.service_type, b.customer_name, b.customer_phone,
      b.address, b.city_state_zip, b.city_code, b.notes, assign, assign ? new Date() : null, req.user.id]
  );
  const id = r.rows[0].id;
  // Numbered from the id so two dispatchers creating at once can never collide.
  const num = 'D' + String(id).padStart(5, '0');
  await pool.query('UPDATE dispatch_jobs SET job_number = $1 WHERE id = $2', [num, id]);
  await logEvent(id, 'created', req, b.service_type || null);
  if (assign) { await logEvent(id, 'assigned', req, 'user ' + assign); await notifyAssigned(id, assign); }
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, entity_number: num, action: 'create',
    user_id: req.user.id, user_name: req.user.name, details: { assigned_to: assign }, ip: req.ip });
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
});

router.put('/jobs/:id', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = clean(req.body || {});
  const r = await pool.query(
    'UPDATE dispatch_jobs SET service_type=$1, customer_name=$2, customer_phone=$3, address=$4, ' +
    'city_state_zip=$5, city_code=$6, notes=$7, priority=$8, updated_at=NOW() WHERE id=$9 RETURNING id',
    [b.service_type, b.customer_name, b.customer_phone, b.address, b.city_state_zip, b.city_code, b.notes, b.priority, id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logEvent(id, 'edited', req, null);
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
});

// Assigning to somebody who is not ready is allowed but ANSWERED honestly, so
// dispatch knows the job is going to a phone that is not reporting.
router.post('/jobs/:id/assign', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  if (!(await canAssign(req))) {
    return res.status(403).json({ error: 'You are not allowed to hand calls to other people.' });
  }
  const id = parseInt(req.params.id, 10);
  const uid = req.body && req.body.user_id ? parseInt(req.body.user_id, 10) : null;
  const cur = await pool.query('SELECT status FROM dispatch_jobs WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  if (cur.rows[0].status === 'done' || cur.rows[0].status === 'cancelled') {
    return res.status(409).json({ error: 'That job is already closed.' });
  }
  const nextStatus = uid ? (cur.rows[0].status === 'new' ? 'assigned' : cur.rows[0].status) : 'new';
  await pool.query(
    'UPDATE dispatch_jobs SET assigned_to=$1, assigned_at=$2, status=$3, updated_at=NOW() WHERE id=$4',
    [uid, uid ? new Date() : null, nextStatus, id]
  );
  await logEvent(id, uid ? 'assigned' : 'unassigned', req, uid ? 'user ' + uid : null);
  var warn = null;
  if (uid) {
    if (!(await duty.isReady(uid))) warn = 'That tech is not marked ready to accept calls.';
    await notifyAssigned(id, uid);
  }
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json({ job: out.rows[0], warning: warn });
});

// Tech-side progress. A tech may only move their OWN job; dispatch may move any.
// Accept is its own step: it is the tech saying "I have read this and I am on
// it", which is a different fact from "I have left". Dispatch needs both.
const FLOW = { assigned: 'accepted', accepted: 'enroute', enroute: 'onscene', onscene: 'done' };
// A call can go GOA from the moment the tech is rolling: plenty of customers
// give up and drive off before anyone gets there.
const GOA_FROM = ['accepted', 'enroute', 'onscene'];
router.post('/jobs/:id/status', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const want = String((req.body && req.body.status) || '').toLowerCase();
  if (STATUSES.indexOf(want) === -1) return res.status(400).json({ error: 'Unknown status' });

  const cur = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  const job = cur.rows[0];

  if (!req._dispatchManage) {
    if (job.assigned_to !== req.user.id) return res.status(403).json({ error: 'That job is not assigned to you.' });
    if (want === 'cancelled') return res.status(403).json({ error: 'Only dispatch can cancel a job.' });
    if (want === 'goa') {
      if (GOA_FROM.indexOf(job.status) === -1) {
        return res.status(409).json({ error: 'Mark the call GOA once you have accepted it and are on your way.' });
      }
    } else if (FLOW[job.status] !== want) {
      return res.status(409).json({ error: 'That is not the next step for this job.' });
    }
  }

  const stampCol = { accepted: 'accepted_at', enroute: 'enroute_at', onscene: 'arrived_at', done: 'completed_at', goa: 'goa_at' }[want];
  const note = ((req.body && req.body.note) || '').toString().trim().slice(0, 500) || null;
  var sql = 'UPDATE dispatch_jobs SET status=$1, updated_at=NOW()';
  if (stampCol) sql += ', ' + stampCol + ' = COALESCE(' + stampCol + ', NOW())';
  if (want === 'goa') sql += ', goa_note = $3';
  sql += ' WHERE id=$2';
  await pool.query(sql, want === 'goa' ? [want, id, note] : [want, id]);
  await logEvent(id, want, req, note);

  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
});

router.post('/jobs/:id/cancel', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 500) || null;
  const r = await pool.query(
    "UPDATE dispatch_jobs SET status='cancelled', cancel_reason=$1, updated_at=NOW() WHERE id=$2 RETURNING id",
    [reason, id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logEvent(id, 'cancelled', req, reason);
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'cancel',
    user_id: req.user.id, user_name: req.user.name, details: { reason: reason }, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;
module.exports.canManage = canManage;
module.exports.canAssign = canAssign;
// ---------------------------------------------------------------------------
//  View log
// ---------------------------------------------------------------------------
// One row per person per job. A board refresh bumps last_at and the counter but
// never adds a row, so the log stays readable and first_at keeps its meaning.
async function recordView(jobId, userId) {
  try {
    await pool.query(
      'INSERT INTO dispatch_job_views (job_id, user_id) VALUES ($1,$2) ' +
      'ON CONFLICT (job_id, user_id) DO UPDATE SET last_at = NOW(), views = dispatch_job_views.views + 1',
      [jobId, userId]);
  } catch (e) { console.error('view log failed:', e.message); }
}

// The board tells us which calls it actually put on screen.
router.post('/viewed', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  var ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids)) ids = [];
  ids = ids.map(function (n) { return parseInt(n, 10); }).filter(Boolean).slice(0, 100);
  for (var i = 0; i < ids.length; i++) await recordView(ids[i], req.user.id);
  res.json({ ok: true, recorded: ids.length });
});

// ---------------------------------------------------------------------------
//  Calling the customer
// ---------------------------------------------------------------------------
// Returns the number ONCE, to the person who asked, and writes the fact down.
// The number is never part of the board payload, so this endpoint is the only
// way a tech can reach it - which is exactly what makes the log complete.
router.post('/jobs/:id/call', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT customer_phone, customer_name FROM dispatch_jobs WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  if (!r.rows[0].customer_phone) return res.status(404).json({ error: 'No phone number on this call.' });
  await logEvent(id, 'called', req, null);
  await recordView(id, req.user.id);
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'called_customer',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ phone: r.rows[0].customer_phone, name: r.rows[0].customer_name });
});

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
async function settingNum(key, dflt, min, max) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    var n = r.rows.length ? parseFloat(r.rows[0].value) : NaN;
    if (!isFinite(n)) n = dflt;
    return Math.min(max, Math.max(min, n));
  } catch (e) { return dflt; }
}
async function acceptTimeoutMinutes() { return settingNum('dispatch_accept_timeout_minutes', 2, 1, 120); }
async function unassignedAlertMinutes() { return settingNum('dispatch_unassigned_alert_minutes', 5, 1, 240); }

module.exports.acceptTimeoutMinutes = acceptTimeoutMinutes;
module.exports.unassignedAlertMinutes = unassignedAlertMinutes;
module.exports.notifyAssigned = notifyAssigned;

