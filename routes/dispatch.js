const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const duty = require('../utils/duty');
const permissions = require('../utils/permissions');
const push = require('../utils/push');
const pricing = require('../utils/pricing');
const geo = require('../utils/geocode');
const callLink = require('../utils/callLink');
const eta = require('../utils/eta');
const gotoLive = require('../utils/gotoLive');
const pay = require('../utils/pay');
const zones = require('../utils/zones');
const dispRec = require('../utils/dispatchRecordings');

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

// Adding a call (Tony 2026-10-13: "pretty much anyone can add a call" - dispatch,
// managers after hours, techs with a walk-up). add_dispatch_call is the small
// permission: create a call, put it on the board or take it yourself. Sending it
// to SOMEONE ELSE still needs assign_dispatch / manage_dispatch. Ships dark.
async function canCreate(req) {
  return (await canManage(req)) || (await hasPerm(req, 'add_dispatch_call'));
}
async function requireCreate(req, res, next) {
  if (await canCreate(req)) return next();
  return res.status(403).json({ error: 'You are not allowed to add calls.' });
}
// The reference lists (services, cities, accounts) are needed by anyone who can
// see the board OR add a call.
async function requireBoardOrCreate(req, res, next) {
  if ((await hasPerm(req, 'view_dispatch')) || (await canCreate(req))) return next();
  return res.status(403).json({ error: 'Access denied' });
}
// Last 10 digits, so (407) 555-0142, 407.555.0142 and +1 407 555 0142 match.
function phoneDigits(v) {
  const d = String(v || '').replace(/[^0-9]/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}
const PHONE_KEY_SQL = "RIGHT(regexp_replace(COALESCE(j.callback_phone, j.customer_phone, ''), '[^0-9]', '', 'g'), 10)";
const CREATED_VIA = ['board', 'new_call', 'walk_up', 'redispatch', 'goto'];

// Seeing WHO ELSE looked at a call is a supervisory fact, not a working one.
// Manager and up only; everyone else gets the same log with those rows absent -
// filtered on the SERVER, because a row that reaches the JSON has leaked no
// matter what the screen chooses to draw.
async function canSeeViews(req) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner' || req.user.role === 'manager') return true;
  return await hasPerm(req, 'view_call_views');
}

// Which categories of work this person is allowed to SEE. Fails closed: no rows
// means no calls, which is why db.js backfills a starting row set for everyone.
async function viewableCategories(userId) {
  const r = await pool.query(
    'SELECT category_code FROM user_service_categories WHERE user_id = $1 AND can_view = true', [userId]);
  return r.rows.map(function (x) { return x.category_code; });
}

// The SQL fragment that enforces it. An uncategorised call (service_type_id
// NULL) is visible to dispatch and managers only - it cannot be filtered
// safely, and it needs a human to fix it anyway.
function categoryClause(params, userId, isManager) {
  if (isManager) return '';
  params.push(userId);
  const p = '$' + params.length;
  return ' AND EXISTS (SELECT 1 FROM service_types st ' +
    'JOIN user_service_categories usc ON usc.category_code = st.category_code ' +
    'WHERE st.id = j.service_type_id AND usc.user_id = ' + p + ' AND usc.can_view = true)';
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
const STATUSES = ['scheduled', 'new', 'assigned', 'accepted', 'enroute', 'onscene', 'done', 'goa', 'cancelled'];
const OPEN_STATUSES = ['new', 'assigned', 'accepted', 'enroute', 'onscene'];
// A call booked for later (Tony 2026-10-15). Deliberately NOT in OPEN_STATUSES:
// every alert, the Who goes ranking, tech open-call counts and the live map read
// OPEN_STATUSES, and a call for tomorrow afternoon must trip none of them. The
// board and the repeat-caller lookup still show it. jobs/dispatch.js releases it
// to 'new' / 'assigned' dispatch_schedule_lead_minutes before the appointment.
const BOARD_STATUSES = ['scheduled'].concat(OPEN_STATUSES);
// GOA (Gone On Arrival) closes a call, but it is NOT 'done'. Rolling it into
// done would quietly inflate completed-job counts with calls nobody worked.
const CLOSED_STATUSES = ['done', 'goa', 'cancelled'];
const PRIORITIES = ['low', 'normal', 'urgent'];

function clean(b) {
  const s = function (v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null; };
  const i = function (v) { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : null; };
  const money = function (v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  };
  const edu = b.is_edu === true || b.is_edu === 'true' || b.is_edu === 1 || b.is_edu === '1';
  var pri = PRIORITIES.indexOf(String(b.priority || '').toLowerCase()) !== -1
    ? String(b.priority).toLowerCase() : 'normal';
  // An EDU call is a child or a pet locked in a vehicle. It is urgent whatever
  // the form said, and there is no reason to let anyone set it lower.
  if (edu) pri = 'urgent';
  return {
    service_type: s(b.service_type, 80),
    service_type_id: i(b.service_type_id),
    is_edu: edu,
    account_id: i(b.account_id),
    account_po: s(b.account_po, 255),
    business_name: s(b.business_name, 255),
    customer_name: s(b.customer_name, 255),
    customer_phone: s(b.customer_phone, 50),
    callback_phone: s(b.callback_phone, 50),
    caller_id: s(b.caller_id, 50),
    customer_email: s(b.customer_email, 255),
    address: s(b.address, 255),
    cross_street: s(b.cross_street, 255),
    city_state_zip: s(b.city_state_zip, 255),
    zip: s(b.zip, 12),
    city_code: b.city_code ? String(b.city_code).trim().slice(0, 3) : null,
    vehicle_year: s(b.vehicle_year, 8),
    vehicle_make: s(b.vehicle_make, 100),
    vehicle_model: s(b.vehicle_model, 100),
    vehicle_color: s(b.vehicle_color, 40),
    license_tag: s(b.license_tag, 40),
    tag_state: s(b.tag_state, 4),
    vin: s(b.vin, 20),
    vehicle_location: s(b.vehicle_location, 255),
    eta_minutes: (function () { const n = parseInt(b.eta_minutes, 10); return isFinite(n) && n >= 0 && n <= 1440 ? n : null; })(),
    quoted_price: money(b.quoted_price),
    notes: s(b.notes, 4000),
    priority: pri
  };
}

// The city has to be one Nova already knows about - it is the same city_code
// that drives assignment, pricing, pay and royalty, so free text here would
// quietly break all four.
async function validCity(code) {
  if (!code) return false;
  const r = await pool.query('SELECT 1 FROM cities WHERE TRIM(code) = TRIM($1) AND active = true', [code]);
  return !!r.rows.length;
}

// Snapshot the catalog NAME onto the row. service_type (text) is the historical
// record; renaming a service type later must not rewrite last year's calls.
async function serviceSnapshot(stId) {
  if (!stId) return { name: null, eta: null, category: null };
  const r = await pool.query('SELECT name, default_eta_minutes, category_code FROM service_types WHERE id = $1 AND active = true', [stId]);
  if (!r.rows.length) return { name: null, eta: null, category: null };
  return { name: r.rows[0].name, eta: r.rows[0].default_eta_minutes, category: r.rows[0].category_code };
}

async function accountSnapshot(accId) {
  if (!accId) return { name: null, po_required: false, notes: null };
  const r = await pool.query('SELECT name, po_required, dispatch_notes FROM vendors WHERE id = $1', [accId]);
  if (!r.rows.length) return { name: null, po_required: false, notes: null };
  return { name: r.rows[0].name, po_required: !!r.rows[0].po_required, notes: r.rows[0].dispatch_notes };
}

// eta_promised_at is stamped from the moment the customer was told, which is
// what makes "were we on time" answerable: arrived_at <= eta_promised_at.
function promisedAt(etaMinutes, from) {
  if (etaMinutes === null || etaMinutes === undefined) return null;
  return new Date((from ? new Date(from).getTime() : Date.now()) + etaMinutes * 60000);
}

// ---------------------------------------------------------------------------
//  Scheduled calls (Tony 2026-10-15)
// ---------------------------------------------------------------------------
// "2026-10-16T14:30" is the wall clock in the CALL's city, not the dispatcher's
// browser: Birmingham is an hour behind Orlando, and the customer was told their
// own local time. Postgres does the zone math so daylight saving lands right.
async function cityTz(cityCode) {
  try {
    const c = await pool.query('SELECT timezone FROM cities WHERE TRIM(code) = TRIM($1)', [cityCode || '']);
    if (c.rows.length && c.rows[0].timezone) return c.rows[0].timezone;
  } catch (e) {}
  return 'America/New_York';
}
function fmtWhen(at, tz) {
  try {
    return new Date(at).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short',
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return new Date(at).toISOString(); }
}
async function scheduleAt(raw, cityCode) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(raw || '').trim());
  if (!m) return { error: 'Pick a date and a time for the scheduled call.' };
  const tz = await cityTz(cityCode);
  var at;
  try {
    const r = await pool.query('SELECT ($1::timestamp AT TIME ZONE $2) AS at',
      [m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':00', tz]);
    at = r.rows[0].at;
  } catch (e) { return { error: 'That date or time is not valid.' }; }
  const mins = (new Date(at).getTime() - Date.now()) / 60000;
  if (mins < 5) return { error: 'That time has already passed or is only minutes away. Use Now instead.' };
  if (mins > 90 * 24 * 60) return { error: 'Calls can be scheduled up to 90 days ahead.' };
  return { at: new Date(at), tz: tz, label: fmtWhen(at, tz) };
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
      body: (j.address || 'Open Nova for details') + ' - tap to acknowledge',
      url: '/?view=dispatch',
      tag: 'dispatch-' + jobId,
      channel: 'calls'
    });
  } catch (e) { console.error('dispatch push failed:', e.message); }
}

// A heads-up, not a call to acknowledge: the real "New call" push goes out when
// the scheduled call is released.
async function notifyScheduled(jobId, userId) {
  try {
    const r = await pool.query(
      'SELECT j.job_number, j.service_type, j.address, j.scheduled_for, c.timezone FROM dispatch_jobs j ' +
      'LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) WHERE j.id = $1', [jobId]);
    if (!r.rows.length || !r.rows[0].scheduled_for) return;
    const j = r.rows[0];
    await push.sendPushToUsers([userId], {
      title: 'Scheduled call: ' + (j.service_type || j.job_number || 'Dispatch'),
      body: fmtWhen(j.scheduled_for, j.timezone) + ' - ' + (j.address || 'see Nova') + '. It comes to you as a live call before then.',
      url: '/?view=dispatch',
      tag: 'dispatch-sched-' + jobId,
      channel: 'calls'
    });
  } catch (e) { console.error('dispatch scheduled push failed:', e.message); }
}

// ---------------------------------------------------------------------------
//  The phone number is deliberately NOT on the board
// ---------------------------------------------------------------------------
// A tech taps Call and the phone dials, but the number never travels with the
// list. That means it cannot be read off the screen, copied, or kept, and every
// call to a customer leaves a record. Managers still see it, because dispatch
// reads numbers back to people all day.
// Pay figures get the same treatment as the customer phone number: they do not
// travel with the board payload unless the person asking is allowed to see
// them. view_own_pay narrows that to the calls they were the tech on - checked
// against assigned_to here, on the server, because a figure that reaches the
// JSON has leaked no matter what the screen chooses to draw.
const PAY_COLS = ['pay_row_id', 'pay_row_title', 'pay_labor_type', 'pay_basis_amount',
  'pay_total', 'pay_job_amount', 'pay_vehicle_amount', 'pay_split_pct',
  'pay_tip_amount', 'pay_note'];

// The ID photo's storage key never leaves the server; callers get a flag and
// fetch the image through GET /jobs/:id/id-image, which checks who is asking.
function stripPrivate(rows) {
  return rows.map(function (j) {
    if (!j || !('id_image_r2_key' in j)) return j;
    const out = Object.assign({}, j);
    out.has_id_image = !!out.id_image_r2_key;
    delete out.id_image_r2_key;
    delete out.id_image_mime;
    return out;
  });
}

function stripPay(rows, mode, userId) {
  rows = stripPrivate(rows);
  if (mode === 'all') return rows;
  return rows.map(function (j) {
    if (mode === 'own' && j.assigned_to === userId) return j;
    const out = Object.assign({}, j);
    PAY_COLS.forEach(function (c) { delete out[c]; });
    return out;
  });
}

// 'all' | 'own' | 'none'
async function payVisibility(req) {
  if (await hasPerm(req, 'view_pay_report')) return 'all';
  if (await hasPerm(req, 'manage_pay_grades')) return 'all';
  if (await hasPerm(req, 'view_own_pay')) return 'own';
  return 'none';
}

function stripPhone(rows) {
  return rows.map(function (j) {
    const out = Object.assign({}, j);
    out.has_phone = !!out.customer_phone;
    delete out.customer_phone;
    // The customer link opens a page with the customer's details on it.
    delete out.customer_token;
    return out;
  });
}

const JOB_SELECT =
  'SELECT j.*, u.name AS assigned_name, u.phone AS assigned_phone, ' +
  '       c.name AS city_name, c.color AS city_color, c.timezone AS city_tz, cb.name AS created_by_name, ' +
  '       st.name AS service_type_name, st.code AS service_type_code, ' +
  '       st.category_code AS service_category, st.default_eta_minutes, ' +
  '       v.name AS account_display_name, v.po_required AS account_po_required, ' +
  '       v.dispatch_notes AS account_dispatch_notes, v.dispatch_tier AS account_tier, ' +
  '       COALESCE((SELECT json_agg(json_build_object(' +
  "         'id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.sort, t.name) " +
  '         FROM dispatch_job_tags jt JOIN dispatch_tags t ON t.id = jt.tag_id ' +
  "         WHERE jt.job_id = j.id), '[]'::json) AS tags " +
  'FROM dispatch_jobs j ' +
  'LEFT JOIN users u ON u.id = j.assigned_to ' +
  'LEFT JOIN users cb ON cb.id = j.created_by ' +
  'LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) ' +
  'LEFT JOIN service_types st ON st.id = j.service_type_id ' +
  'LEFT JOIN vendors v ON v.id = j.account_id ';

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
    params.push(BOARD_STATUSES);
    where += 'j.status = ANY($1)';
  }
  where += categoryClause(params, req.user.id, !!req._dispatchManage);
  const r = await pool.query(
    JOB_SELECT + where + ' ORDER BY ' +
    'j.is_edu DESC, ' +
    "CASE j.priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, " +
    'j.created_at DESC LIMIT 300', params);
  var rows = r.rows;
  // Who has looked at each call, so dispatch can tell "never saw it" apart from
  // "saw it and did nothing".
  const seeViews = await canSeeViews(req);
  if (rows.length && seeViews) {
    const ids = rows.map(function (j) { return j.id; });
    const v = await pool.query(
      'SELECT v.job_id, v.user_id, v.first_at, v.last_at, v.views, u.name ' +
      'FROM dispatch_job_views v JOIN users u ON u.id = v.user_id WHERE v.job_id = ANY($1)', [ids]);
    const byJob = {};
    v.rows.forEach(function (x) { (byJob[x.job_id] = byJob[x.job_id] || []).push(x); });
    rows.forEach(function (j) { j.views = byJob[j.id] || []; });
  } else {
    rows.forEach(function (j) { delete j.views; });
  }
  // Who goes on the board (step 5, shadow mode only): the best-ETA tech for each
  // waiting call. Distance estimate only here (no paid traffic lookups on a
  // 20-second refresh). Roadside ones read "AI would send"; locksmith ones get a
  // one-tap Send.
  try {
    const cfg = await eta.config();
    if (cfg.mode === 'shadow' && (await canAssign(req))) {
      const waiting = rows.filter(function (j) { return j.status === 'new'; }).slice(0, 25);
      for (const j of waiting) {
        const rk = await eta.rank({ lat: j.lat, lon: j.lon, city_code: j.city_code, category: j.service_category,
          service_type_id: j.service_type_id, is_edu: j.is_edu, account_tier: j.account_tier }, { traffic: false, exclude_job_id: j.id });
        j.suggestion = suggestionOf(rk, j.service_category);
        if (!j.suggestion) j.suggestion_note = rk.why;
        await shadowRecord(j.id, rk, j.service_category);
      }
    }
  } catch (e) { console.error('board who goes failed:', e.message); }
  res.json({
    jobs: stripPay(req._dispatchManage ? rows : stripPhone(rows), await payVisibility(req), req.user.id),
    canManage: !!req._dispatchManage,
    canAssign: await canAssign(req),
    canSeeViews: seeViews,
    acceptTimeoutMinutes: await acceptTimeoutMinutes(),
    ageWarnMinutes: await ageWarnMinutes(),
    ageAlertMinutes: await ageAlertMinutes(),
    scheduleLeadMinutes: await scheduleLeadMinutes(),
    me: req.user.id
  });
});

router.get('/jobs/:id', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const params = [id];
  var where = 'WHERE j.id = $1';
  where += categoryClause(params, req.user.id, !!req._dispatchManage);
  const r = await pool.query(JOB_SELECT + where, params);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const ev = await pool.query('SELECT * FROM dispatch_job_events WHERE job_id = $1 ORDER BY at', [id]);
  const seeViews = await canSeeViews(req);
  var vws = [];
  if (seeViews) {
    const vw = await pool.query(
      'SELECT v.*, u.name FROM dispatch_job_views v JOIN users u ON u.id = v.user_id WHERE v.job_id = $1 ORDER BY v.first_at', [id]);
    vws = vw.rows;
  }
  await recordView(id, req.user.id);
  const job = stripPay([req._dispatchManage ? r.rows[0] : stripPhone([r.rows[0]])[0]],
    await payVisibility(req), req.user.id)[0];
  res.json({ job: job, events: ev.rows, views: vws, canSeeViews: seeViews, canManage: !!req._dispatchManage,
    scheduleLeadMinutes: await scheduleLeadMinutes() });
});

router.post('/jobs', requireAuth, requireCreate, async function (req, res) {
  const body = req.body || {};
  const b = clean(body);
  // One phone box on the New call screen: the callback number IS the number
  // dispatch dials (customer_phone, never shown to a tech).
  if (b.callback_phone && !b.customer_phone) b.customer_phone = b.callback_phone;
  if (!b.callback_phone && b.customer_phone) b.callback_phone = b.customer_phone;
  // Required (Tony 2026-10-13): callback phone, customer name, service type,
  // address, zip. Checked here, not only on the form.
  const missing = [];
  if (!b.callback_phone) missing.push('callback phone');
  if (!b.customer_name) missing.push('customer name');
  if (!b.service_type_id) missing.push('service type');
  if (!b.address) missing.push('address');
  if (!b.zip) missing.push('zip');
  if (missing.length) {
    return res.status(400).json({ error: 'Still needed: ' + missing.join(', ') + '.', missing: missing });
  }
  // City fills itself from the zip when the caller left it blank. The zip's
  // coverage zone knows which market it belongs to.
  if (!b.city_code) {
    try { const zz = await zones.zoneByZip(b.zip, null); if (zz && zz.city_code) b.city_code = String(zz.city_code).trim(); }
    catch (e) {}
  }
  // Who it goes to. "Take this call myself" is allowed for anyone who may add a
  // call; sending it to someone ELSE needs the assign permission.
  const takeMine = body.take_myself === true || body.take_myself === 'true';
  var assignTo = takeMine ? req.user.id : (body.assigned_to ? parseInt(body.assigned_to, 10) : null);
  if (!isFinite(assignTo) || assignTo <= 0) assignTo = null;
  if (assignTo && assignTo !== req.user.id && !(await canAssign(req))) {
    return res.status(403).json({ error: 'You can add this call and take it yourself, but not send it to someone else.' });
  }
  // Redispatch: a second call copied from a completed one, linked both ways.
  var parentId = body.redispatch_of ? parseInt(body.redispatch_of, 10) : null;
  var parent = null;
  if (parentId) {
    const pr = await pool.query('SELECT id, job_number FROM dispatch_jobs WHERE id = $1', [parentId]);
    parent = pr.rows[0] || null;
    if (!parent) return res.status(400).json({ error: 'The call being redispatched no longer exists.' });
  }
  var via = CREATED_VIA.indexOf(String(body.created_via || '')) !== -1 ? String(body.created_via) : 'board';
  if (parent) via = 'redispatch';
  else if (takeMine) via = 'walk_up';
  // A job with no city is unassignable to anyone (see the home-city rule on
  // /assign), so a silent NULL here would be a hole in that rule rather than a
  // convenience.
  if (!(await validCity(b.city_code))) {
    return res.status(400).json({ error: 'Pick a city. It has to be one of the cities set up in Nova.' });
  }
  // Scheduled for later (Tony 2026-10-15). The call is priced for the time it
  // will be worked (after-hours codes matter), holds no ETA in minutes, and its
  // promise IS the appointment, so Expire counts down to what the customer was told.
  var sched = null;
  if (body.scheduled_for) {
    if (b.is_edu) return res.status(400).json({ error: 'EDU calls go out now. They cannot be scheduled.' });
    sched = await scheduleAt(body.scheduled_for, b.city_code);
    if (sched.error) return res.status(400).json({ error: sched.error, reason: 'schedule' });
  }
  const svc = await serviceSnapshot(b.service_type_id);
  const acct = await accountSnapshot(b.account_id);
  // The time code covering RIGHT NOW, in that city's own clock, decides both
  // the price and the ETA - unless the dispatcher typed over either, in which
  // case what they told the customer wins.
  // Coordinates and the coverage zone, before pricing - the zone adjusts the
  // price, so it has to be known first. Every step here is allowed to come back
  // empty: dispatch worked without any of it for the whole of Phase 1, and a
  // geocoding outage must never be the reason a call cannot be taken.
  var point = null;
  try { point = await geo.geocode({ address: b.address, city_state_zip: b.city_state_zip, zip: b.zip }); }
  catch (e) { point = null; }
  var zoneHit = { zone: null, out_of_area: false, wrong_city: false, matched_by: null };
  try {
    zoneHit = await zones.resolve({
      zip: b.zip, city_code: b.city_code,
      lat: point && point.lat, lon: point && point.lon
    });
  } catch (e) { /* no zones configured yet is the normal case at first */ }

  const q = await pricing.quote({
    service_type_id: b.service_type_id, city_code: b.city_code,
    account_id: b.account_id, is_edu: b.is_edu, when: sched ? sched.at : new Date(),
    zone: zoneHit.zone, out_of_area: zoneHit.out_of_area
  });
  const eta = sched ? null : (b.eta_minutes !== null ? b.eta_minutes : (q.eta_minutes || null));
  const etaSrc = b.eta_minutes !== null ? 'manual' : (q.eta_source || null);
  const price = b.quoted_price !== null ? b.quoted_price : q.price;
  const priceSrc = b.quoted_price !== null ? 'manual' : q.price_source;
  const assign = assignTo;
  const r = await pool.query(
    'INSERT INTO dispatch_jobs (source, status, status_since, priority, service_type, service_type_id, is_edu, ' +
    'account_id, account_name, account_po, business_name, customer_name, customer_phone, callback_phone, ' +
    'caller_id, customer_email, address, cross_street, city_state_zip, zip, city_code, ' +
    'vehicle_year, vehicle_make, vehicle_model, vehicle_color, license_tag, tag_state, vin, vehicle_location, ' +
    'eta_minutes, eta_source, eta_promised_at, quoted_price, quoted_price_src, time_code_id, ' +
    'lat, lon, geocode_accuracy, zone_id, zone_price_adj, ' +
    'notes, assigned_to, assigned_at, created_by) ' +
    "VALUES ('manual', $1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, " +
    '$18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, ' +
    '$38, $39, $40, $41, $42) RETURNING id',
    [sched ? 'scheduled' : (assign ? 'assigned' : 'new'), b.priority,
      svc.name || b.service_type, b.service_type_id, b.is_edu,
      b.account_id, acct.name, b.account_po, b.business_name,
      b.customer_name, b.customer_phone, b.callback_phone, b.caller_id, b.customer_email,
      b.address, b.cross_street, b.city_state_zip, b.zip, b.city_code,
      b.vehicle_year, b.vehicle_make, b.vehicle_model, b.vehicle_color,
      b.license_tag, b.tag_state, b.vin, b.vehicle_location,
      eta, sched ? 'scheduled' : (eta === null ? null : etaSrc), sched ? sched.at : promisedAt(eta, null),
      price, price === null ? null : priceSrc, q.time_code_id,
      point ? point.lat : null, point ? point.lon : null, point ? point.accuracy_type : null,
      zoneHit.zone ? zoneHit.zone.id : null, q.zone_price_adj === undefined ? null : q.zone_price_adj,
      b.notes, assign, assign && !sched ? new Date() : null, req.user.id]
  );
  const id = r.rows[0].id;
  // Numbered from the id so two dispatchers creating at once can never collide.
  const num = 'D' + String(id).padStart(5, '0');
  await pool.query('UPDATE dispatch_jobs SET job_number = $1, parent_job_id = $3, created_via = $4, scheduled_for = $5 WHERE id = $2',
    [num, id, parent ? parent.id : null, via, sched ? sched.at : null]);
  await logEvent(id, 'created', req, svc.name || b.service_type || null);
  if (sched) await logEvent(id, 'scheduled', req, 'For ' + sched.label + ' (city time)');
  if (parent) {
    await logEvent(id, 'redispatch', req, 'Redispatch of ' + (parent.job_number || ('#' + parent.id)));
    await logEvent(parent.id, 'redispatched', req, 'Redispatched as ' + num);
  }
  if (b.is_edu) await logEvent(id, 'edu', req, 'Emergency Door Unlocking - child or pet in vehicle');
  if (acct.name) await logEvent(id, 'account_set', req, acct.name + (acct.po_required ? ' - PO required' : ''));
  if (zoneHit.zone) {
    await logEvent(id, 'zone', req, zoneHit.zone.name +
      (zoneHit.matched_by ? ' (by ' + zoneHit.matched_by + ')' : '') +
      (q.zone_price_adj ? ', ' + (q.zone_price_adj > 0 ? '+' : '') + '$' + q.zone_price_adj : ''));
  }
  if (zoneHit.wrong_city) {
    // Usually a typo in the zip, occasionally a genuine border job. Either way
    // it changes who gets paid for the call, so it is said out loud.
    await logEvent(id, 'zone_other_city', req,
      'That zip belongs to ' + (zoneHit.zone && zoneHit.zone.city_code) + ', not the city on this call.');
  }
  if (zoneHit.out_of_area) {
    await logEvent(id, 'out_of_area', req, b.zip ? 'Zip ' + b.zip + ' is not in any coverage zone.' : 'No zip on the call.');
    try {
      await pool.query(
        'INSERT INTO dispatch_job_tags (job_id, tag_id, added_by) ' +
        "SELECT $1, id, $2 FROM dispatch_tags WHERE name = 'Out of area' AND active = true " +
        'ON CONFLICT DO NOTHING', [id, req.user.id]);
    } catch (e) {}
  }
  if (price !== null) {
    await logEvent(id, 'priced', req,
      '$' + Number(price).toFixed(2) + ' (' + (priceSrc || 'unknown') +
      (q.time_code_title ? ', ' + q.time_code_title : '') + ')');
  } else if (q.reason) {
    await logEvent(id, 'price_missing', req, q.reason);
  }
  if (sched) {
    // Nobody acknowledges a call for tomorrow today. The person stays on it and
    // gets the real "New call" push when it is released.
    if (assign) {
      await logEvent(id, 'assigned', req, (takeMine ? 'Took the call themselves' : 'user ' + assign) + ', goes out when the call is released');
      if (!takeMine) await notifyScheduled(id, assign);
    }
  } else if (assign && takeMine) {
    // The tech is standing there: assigned and acknowledged in one step. They
    // still press On scene themselves, so the timeline stays honest.
    await pool.query("UPDATE dispatch_jobs SET status = 'accepted', status_since = NOW(), accepted_at = NOW() WHERE id = $1", [id]);
    await logEvent(id, 'assigned', req, 'Took the call themselves');
    await logEvent(id, 'accepted', req, null);
  } else if (assign) { await logEvent(id, 'assigned', req, 'user ' + assign); await notifyAssigned(id, assign); }
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, entity_number: num, action: 'create',
    user_id: req.user.id, user_name: req.user.name, details: { assigned_to: assign }, ip: req.ip });
  // Picked from "Calls on the line": that GoTo call is now this call.
  if (body.goto_call_id) {
    try {
      await pool.query('UPDATE goto_live_calls SET used_job_id = $1, used_by = $2 WHERE conversation_space_id = $3 AND used_job_id IS NULL',
        [id, req.user.id, String(body.goto_call_id).slice(0, 128)]);
    } catch (e) {}
  }
  // Who goes (step 5): what the AI would have picked, before this assignment.
  // Not for a scheduled call: who is closest right now says nothing about tomorrow.
  if (!sched) try {
    const rk = await rankForJob(id, { traffic: false });
    await shadowRecord(id, rk, svc.category);
    if (assign) {
      await shadowActual(id, assign, req);
      if (!takeMine) await logOverride(id, assign, body.suggested_user_id, req);
    }
  } catch (e) { console.error('who goes on create failed:', e.message); }
  // Customer call link (step 4). Only when the setting is on AND the person
  // creating the call left the box ticked.
  var linkResult = null;
  if ((body.send_customer_link === true || body.send_customer_link === 'true') && (await callLink.linkEnabled())) {
    linkResult = await callLink.sendLink(id);
    await logEvent(id, linkResult.ok ? 'link_sent' : 'link_failed', req,
      linkResult.ok ? 'Texted the customer their call link' : ('Call link not sent: ' + (linkResult.error || 'unknown')));
  }
  // Customer call recordings (Tony 2026-10-15): the call says from its very first
  // second that Nova is working on pulling them. No GoTo pull here - the dispatcher
  // is usually still ON that call - the 2-minute cron does the pulling.
  try {
    const jr = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
    if (jr.rows.length) await dispRec.evaluate(jr.rows[0]);
  } catch (e) { console.error('recordings on create failed:', e.message); }
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  const created = stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0];
  if (linkResult) created.customer_link = { sent: linkResult.ok, error: linkResult.error || null };
  res.json(created);
});

router.put('/jobs/:id', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = clean(req.body || {});
  const prevQ = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  if (!prevQ.rows.length) return res.status(404).json({ error: 'Not found' });
  const prev = prevQ.rows[0];
  if (!(await validCity(b.city_code))) {
    return res.status(400).json({ error: 'Pick a city. It has to be one of the cities set up in Nova.' });
  }
  const svc = await serviceSnapshot(b.service_type_id);
  const acct = await accountSnapshot(b.account_id);
  // Only re-stamp the promise when the ETA actually moved. Re-promising on
  // every save would quietly reset the clock the Expire column counts against.
  // A scheduled call's promise is its appointment; only Reschedule moves it.
  const etaChanged = !prev.scheduled_for && b.eta_minutes !== prev.eta_minutes;
  const r = await pool.query(
    'UPDATE dispatch_jobs SET service_type=$1, service_type_id=$2, is_edu=$3, account_id=$4, account_name=$5, ' +
    'account_po=$6, business_name=$7, customer_name=$8, customer_phone=$9, callback_phone=$10, caller_id=$11, ' +
    'customer_email=$12, address=$13, cross_street=$14, city_state_zip=$15, zip=$16, city_code=$17, ' +
    'vehicle_year=$18, vehicle_make=$19, vehicle_model=$20, vehicle_color=$21, license_tag=$22, tag_state=$23, ' +
    'vin=$24, vehicle_location=$25, eta_minutes=$26, ' +
    'eta_source = CASE WHEN $27::boolean THEN $28 ELSE eta_source END, ' +
    'eta_promised_at = CASE WHEN $27::boolean THEN $29 ELSE eta_promised_at END, ' +
    'quoted_price=$30, quoted_price_src = CASE WHEN $30::numeric IS NULL THEN NULL ELSE $31 END, ' +
    'notes=$32, priority=$33, updated_at=NOW() WHERE id=$34 RETURNING id',
    [svc.name || b.service_type, b.service_type_id, b.is_edu, b.account_id, acct.name,
      b.account_po, b.business_name, b.customer_name, b.customer_phone, b.callback_phone, b.caller_id,
      b.customer_email, b.address, b.cross_street, b.city_state_zip, b.zip, b.city_code,
      b.vehicle_year, b.vehicle_make, b.vehicle_model, b.vehicle_color, b.license_tag, b.tag_state,
      b.vin, b.vehicle_location, b.eta_minutes,
      etaChanged, b.eta_minutes === null ? null : 'manual', promisedAt(b.eta_minutes, null),
      b.quoted_price, 'manual',
      b.notes, b.priority, id]
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  // Field-level, because "edited" on its own ends no argument.
  const WATCH = [
    ['service_type', 'Service type'], ['account_name', 'Account'], ['account_po', 'Account PO'],
    ['customer_name', 'Customer'], ['address', 'Address'], ['city_code', 'City'],
    ['priority', 'Priority'], ['eta_minutes', 'ETA'], ['quoted_price', 'Price']
  ];
  const after = { service_type: svc.name || b.service_type, account_name: acct.name, account_po: b.account_po,
    customer_name: b.customer_name, address: b.address, city_code: b.city_code, priority: b.priority,
    eta_minutes: b.eta_minutes, quoted_price: b.quoted_price };
  const diffs = [];
  WATCH.forEach(function (w) {
    const a = prev[w[0]] === null || prev[w[0]] === undefined ? '' : String(prev[w[0]]).trim();
    const c = after[w[0]] === null || after[w[0]] === undefined ? '' : String(after[w[0]]).trim();
    if (a !== c) diffs.push(w[1] + ': ' + (a || '(blank)') + ' -> ' + (c || '(blank)'));
  });
  await logEvent(id, 'edited', req, diffs.length ? diffs.join(' | ') : null);
  if (!!prev.is_edu !== !!b.is_edu) {
    await logEvent(id, b.is_edu ? 'edu' : 'edu_cleared', req,
      b.is_edu ? 'Emergency Door Unlocking - child or pet in vehicle' : null);
  }
  // A changed phone number changes which calls belong to this job.
  if (['callback_phone', 'customer_phone', 'caller_id'].some(function (k) {
    return String(prev[k] || '') !== String(b[k] || ''); })) {
    try {
      const jr = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
      if (jr.rows.length) await dispRec.evaluate(jr.rows[0]);
    } catch (e) { console.error('recordings on edit failed:', e.message); }
  }
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

// Assigning to somebody who is not ready is allowed but ANSWERED honestly, so
// dispatch knows the job is going to a phone that is not reporting.
router.post('/jobs/:id/assign', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  if (!(await canAssign(req))) {
    return res.status(403).json({ error: 'You are not allowed to hand calls to other people.' });
  }
  const id = parseInt(req.params.id, 10);
  const uid = req.body && req.body.user_id ? parseInt(req.body.user_id, 10) : null;
  const cur = await pool.query(
    'SELECT j.status, TRIM(j.city_code) AS city_code, j.service_type_id, st.category_code ' +
    'FROM dispatch_jobs j LEFT JOIN service_types st ON st.id = j.service_type_id WHERE j.id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  if (cur.rows[0].status === 'done' || cur.rows[0].status === 'cancelled') {
    return res.status(409).json({ error: 'That job is already closed.' });
  }
  const job = cur.rows[0];
  var crossReason = null;
  if (uid) {
    const who = await pool.query(
      'SELECT id, name, TRIM(home_city) AS home_city, active FROM users WHERE id = $1', [uid]);
    if (!who.rows.length || who.rows[0].active === false) {
      return res.status(400).json({ error: 'That person is not an active user.' });
    }
    const tech = who.rows[0];

    // A call with no city cannot be assigned to anybody. Without this the
    // home-city rule below has a silent hole you could drive a truck through.
    if (!job.city_code) {
      return res.status(409).json({ error: 'Set the city on this call before assigning it.' });
    }

    if (String(tech.home_city || '') !== String(job.city_code)) {
      const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
      const wants = !!(req.body && (req.body.cross_city === true || req.body.cross_city === 'true' || req.body.cross_city === 1 || req.body.cross_city === '1'));
      crossReason = ((req.body && req.body.cross_city_reason) || '').toString().trim().slice(0, 300);
      if (!isAdmin) {
        return res.status(403).json({
          error: (tech.name || 'That tech') + ' is not assigned to this city. Only an admin can assign across cities.',
          reason: 'wrong_city'
        });
      }
      if (!wants || !crossReason) {
        return res.status(400).json({
          error: 'Assigning outside the city needs the override ticked and a reason.',
          reason: 'cross_city_reason_required'
        });
      }
    }

    // The category flags are two separate questions: a coordinator may need to
    // SEE roadside work without ever being handed a roadside call.
    if (job.category_code) {
      const cat = await pool.query(
        'SELECT can_be_assigned FROM user_service_categories WHERE user_id = $1 AND category_code = $2',
        [uid, job.category_code]);
      if (!cat.rows.length || cat.rows[0].can_be_assigned !== true) {
        return res.status(403).json({
          error: (tech.name || 'That tech') + ' is not set up to take ' + job.category_code + ' calls.',
          reason: 'wrong_category'
        });
      }
    }
  }
  // A scheduled call stays scheduled whoever is on it; the acknowledge clock
  // starts when it is released, not now.
  const isSched = job.status === 'scheduled';
  const nextStatus = isSched ? 'scheduled' : (uid ? (job.status === 'new' ? 'assigned' : job.status) : 'new');
  await pool.query(
    // $3 is cast explicitly: it is used both as the new status and inside the
    // CASE, and Postgres refuses to deduce one type for a parameter used in two
    // places (42P08). Same class of bug as the timeclock punch-edit 500.
    'UPDATE dispatch_jobs SET assigned_to=$1, assigned_at=$2, status=$3::varchar, ' +
    'status_since = CASE WHEN status <> $3::varchar THEN NOW() ELSE status_since END, ' +
    'updated_at=NOW() WHERE id=$4',
    [uid, uid && !isSched ? new Date() : null, nextStatus, id]
  );
  await logEvent(id, uid ? 'assigned' : 'unassigned', req, uid ? 'user ' + uid : null);
  if (uid) {
    await shadowActual(id, uid, req);
    await logOverride(id, uid, req.body && req.body.suggested_user_id, req);
  }
  var warn = null;
  if (uid) {
    if (crossReason) {
      const cityRow = await pool.query('SELECT name FROM cities WHERE TRIM(code) = $1', [job.city_code]);
      await logEvent(id, 'assigned_cross_city', req,
        'Assigned outside ' + ((cityRow.rows[0] && cityRow.rows[0].name) || job.city_code) +
        ' (reason: ' + crossReason + ')');
      await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'assign_cross_city',
        user_id: req.user.id, user_name: req.user.name,
        details: { assigned_to: uid, city_code: job.city_code, reason: crossReason }, ip: req.ip });
    }
    if (isSched) {
      await notifyScheduled(id, uid);
    } else {
      if (!(await duty.isReady(uid))) warn = 'That tech is not marked ready to accept calls.';
      await notifyAssigned(id, uid);
    }
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

  if (job.status === 'scheduled' && want !== 'cancelled') {
    return res.status(409).json({ error: 'This call is scheduled for later. Dispatch it now first.' });
  }

  if (!req._dispatchManage) {
    if (job.assigned_to !== req.user.id) return res.status(403).json({ error: 'That job is not assigned to you.' });
    if (want === 'cancelled') return res.status(403).json({ error: 'Only dispatch can cancel a job.' });
    if (want === 'goa') {
      if (GOA_FROM.indexOf(job.status) === -1) {
        return res.status(409).json({ error: 'Mark the call GOA once you have acknowledged it and are on your way.' });
      }
    } else if (FLOW[job.status] !== want) {
      return res.status(409).json({ error: 'That is not the next step for this job.' });
    }
  }

  // Close-out gate. po_required is read from the ACCOUNT row on the server and
  // is deliberately NOT taken from the request body - a client that posts
  // po_required:false is ignored. Same rule Invoice Setup already enforces for
  // signature_required.
  if (want === 'done' && job.account_id) {
    const acc = await pool.query('SELECT name, po_required FROM vendors WHERE id = $1', [job.account_id]);
    if (acc.rows.length && acc.rows[0].po_required &&
        !String(job.account_po || '').trim()) {
      return res.status(400).json({
        error: (acc.rows[0].name || 'This account') + ' requires a PO number on every call.',
        reason: 'po_required'
      });
    }
  }
  const stampCol = { accepted: 'accepted_at', enroute: 'enroute_at', onscene: 'arrived_at', done: 'completed_at', goa: 'goa_at' }[want];
  const note = ((req.body && req.body.note) || '').toString().trim().slice(0, 500) || null;
  var sql = 'UPDATE dispatch_jobs SET status=$1, updated_at=NOW(), status_since=NOW()';
  if (stampCol) sql += ', ' + stampCol + ' = COALESCE(' + stampCol + ', NOW())';
  if (want === 'goa') sql += ', goa_note = $3';
  sql += ' WHERE id=$2';
  await pool.query(sql, want === 'goa' ? [want, id, note] : [want, id]);
  await logEvent(id, want, req, note);

  // ---- freeze the pay ----------------------------------------------------
  // Computed ONCE, here, and stored with the title of the row that produced it.
  // A grade edit next month must never restate last month's payroll.
  //
  // Wrapped because a pay table that is not set up yet is not a reason a tech
  // cannot close their call. It fails to a flag on the report, which somebody
  // reads, rather than a 500 on a phone at 2am, which nobody can act on.
  if (want === 'done' || want === 'goa') {
    try {
      const paid = await pay.snapshotForJob(id, {
        labor_amount: req.body && req.body.labor_amount,
        tip_amount: req.body && req.body.tip_amount
      });
      if (paid && paid.ok && paid.flags && paid.flags.length) {
        await logEvent(id, 'pay_flag', req, 'Pay needs attention: ' + paid.flags.join(', '));
      } else if (paid && paid.ok) {
        await logEvent(id, 'pay_locked', req,
          (paid.pay.pay_row_title || 'no row') + ' - $' + Number(paid.pay.pay_total || 0).toFixed(2));
      }
    } catch (e) {
      console.error('pay snapshot failed for job ' + id + ':', e.message);
      try { await logEvent(id, 'pay_flag', req, 'Pay could not be calculated: ' + e.message); } catch (e2) {}
    }
  }

  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

router.post('/jobs/:id/cancel', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = ((req.body && req.body.reason) || '').toString().trim().slice(0, 500) || null;
  const r = await pool.query(
    "UPDATE dispatch_jobs SET status='cancelled', cancel_reason=$1, updated_at=NOW(), status_since=NOW() WHERE id=$2 RETURNING id",
    [reason, id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logEvent(id, 'cancelled', req, reason);
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'cancel',
    user_id: req.user.id, user_name: req.user.name, details: { reason: reason }, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Scheduled calls: book for later, move the time, or send it out now
// ---------------------------------------------------------------------------
// Released = a normal live call: 'new' (or 'assigned' if someone is already on
// it, with the acknowledge clock starting now). The promise stays the appointment
// time. released_at restarts the board's Age and the unassigned alert: a call
// booked yesterday has not been "waiting" since yesterday.
async function releaseJob(id, req, why) {
  const r = await pool.query(
    "UPDATE dispatch_jobs SET status = CASE WHEN assigned_to IS NULL THEN 'new' ELSE 'assigned' END, " +
    'status_since = NOW(), released_at = NOW(), ' +
    'assigned_at = CASE WHEN assigned_to IS NULL THEN NULL ELSE NOW() END, ' +
    'accept_reminder_at = NULL, unassigned_alert_at = NULL, updated_at = NOW() ' +
    "WHERE id = $1 AND status = 'scheduled' RETURNING id, assigned_to", [id]);
  if (!r.rows.length) return null;
  const j = r.rows[0];
  if (req) await logEvent(id, 'released', req, why || null);
  else {
    await pool.query("INSERT INTO dispatch_job_events (job_id, event, detail) VALUES ($1, 'released', $2)", [id, why || null]);
  }
  if (j.assigned_to) await notifyAssigned(id, j.assigned_to);
  return j;
}

// Called every minute by jobs/dispatch.js. The UPDATE in releaseJob is guarded
// on status, so two ticks (or a tick and a Dispatch now) can never double-send.
async function releaseDueScheduled() {
  const lead = await scheduleLeadMinutes();
  const due = await pool.query(
    "SELECT id FROM dispatch_jobs WHERE status = 'scheduled' AND scheduled_for IS NOT NULL " +
    "  AND scheduled_for - ($1 || ' minutes')::interval <= NOW() ORDER BY scheduled_for LIMIT 50", [String(lead)]);
  var n = 0;
  for (const row of due.rows) {
    try { if (await releaseJob(row.id, null, 'Went live ' + lead + ' min ahead of the appointment')) n++; }
    catch (e) { console.error('release scheduled call ' + row.id + ' failed:', e.message); }
  }
  return n;
}

// Book a call for later, or move the time of one already booked. A call nobody
// has acknowledged yet can still be pushed to later (the customer asked for
// tomorrow after all); once a tech has acknowledged it, it is theirs.
router.post('/jobs/:id/schedule', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const cur = await pool.query(
    'SELECT id, status, TRIM(city_code) AS city_code, is_edu, scheduled_for, assigned_to FROM dispatch_jobs WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  const job = cur.rows[0];
  if (['scheduled', 'new', 'assigned'].indexOf(job.status) === -1) {
    return res.status(409).json({ error: 'Only a call nobody has acknowledged yet can be scheduled for later.' });
  }
  if (job.is_edu) return res.status(400).json({ error: 'EDU calls go out now. They cannot be scheduled.' });
  const s = await scheduleAt(req.body && req.body.scheduled_for, job.city_code);
  if (s.error) return res.status(400).json({ error: s.error });
  const was = job.status === 'scheduled' && job.scheduled_for ? fmtWhen(job.scheduled_for, s.tz) : null;
  await pool.query(
    "UPDATE dispatch_jobs SET status = 'scheduled', " +
    "status_since = CASE WHEN status <> 'scheduled' THEN NOW() ELSE status_since END, " +
    "scheduled_for = $1, eta_promised_at = $1, eta_minutes = NULL, eta_source = 'scheduled', " +
    'assigned_at = NULL, accept_reminder_at = NULL, unassigned_alert_at = NULL, released_at = NULL, ' +
    'updated_at = NOW() WHERE id = $2', [s.at, id]);
  if (was) await logEvent(id, 'rescheduled', req, was + ' -> ' + s.label);
  else await logEvent(id, 'scheduled', req, 'Moved to later: ' + s.label + ' (city time)');
  if (job.assigned_to) await notifyScheduled(id, job.assigned_to);
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: was ? 'reschedule' : 'schedule',
    user_id: req.user.id, user_name: req.user.name, details: { scheduled_for: s.at, was: was }, ip: req.ip });
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

// "Dispatch now": the customer can be seen early, or a tech is free close by.
router.post('/jobs/:id/release', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const done = await releaseJob(id, req, 'Dispatched early by hand');
  if (!done) return res.status(409).json({ error: 'That call is not scheduled.' });
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

// Who this call can legally be handed to: home city, category-eligible, active.
// Off-duty techs are still listed (Phase 1 warns rather than blocks) and
// out-of-city techs only appear for an admin who asked for them.
router.get('/jobs/:id/assignable', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const j = await pool.query(
    'SELECT TRIM(j.city_code) AS city_code, st.category_code FROM dispatch_jobs j ' +
    'LEFT JOIN service_types st ON st.id = j.service_type_id WHERE j.id = $1', [id]);
  if (!j.rows.length) return res.status(404).json({ error: 'Not found' });
  const job = j.rows[0];
  const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
  const wantAll = isAdmin && String(req.query.all || '') === '1';
  const params = [];
  var sql =
    'SELECT u.id, u.name, TRIM(u.home_city) AS home_city, u.role, ' +
    '       COALESCE(d.ready,false) AS ready, ' +
    '       (SELECT COUNT(*)::int FROM dispatch_jobs oj WHERE oj.assigned_to = u.id ' +
    "        AND oj.status = ANY($1)) AS open_calls " +
    'FROM users u LEFT JOIN tech_duty d ON d.user_id = u.id WHERE u.active = true';
  params.push(OPEN_STATUSES);
  if (job.category_code) {
    params.push(job.category_code);
    sql += ' AND EXISTS (SELECT 1 FROM user_service_categories usc WHERE usc.user_id = u.id ' +
      'AND usc.category_code = $' + params.length + ' AND usc.can_be_assigned = true)';
  }
  if (!wantAll) {
    if (!job.city_code) return res.json({ people: [], city_code: null, crossCityAvailable: isAdmin });
    params.push(job.city_code);
    sql += ' AND TRIM(u.home_city) = $' + params.length;
  }
  sql += ' ORDER BY COALESCE(d.ready,false) DESC, u.name';
  const r = await pool.query(sql, params);
  var people = r.rows.map(function (p) {
    return { user_id: p.id, name: p.name, home_city: p.home_city, role: p.role,
      ready: p.ready, open_calls: p.open_calls,
      out_of_city: String(p.home_city || '') !== String(job.city_code || '') };
  });
  var rk = null;
  if (!wantAll) {
    try { rk = await rankForJob(id); people = mergeEta(people, rk); } catch (e) { console.error('who goes failed:', e.message); }
  }
  res.json({
    people: people,
    city_code: job.city_code,
    crossCityAvailable: isAdmin,
    best_user_id: rk && rk.pick ? rk.pick.user_id : null,
    why: rk ? rk.why : null
  });
});

// Tags. Adding or removing one writes an event row, so tags appear on the
// timeline instead of turning up by magic.
router.post('/jobs/:id/tags', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  if (!(await canManage(req))) return res.status(403).json({ error: 'Only dispatch can change tags.' });
  const id = parseInt(req.params.id, 10);
  const tagId = parseInt((req.body && req.body.tag_id) || 0, 10);
  if (!tagId) return res.status(400).json({ error: 'Pick a tag.' });
  const t = await pool.query('SELECT name FROM dispatch_tags WHERE id = $1 AND active = true', [tagId]);
  if (!t.rows.length) return res.status(404).json({ error: 'Unknown tag.' });
  const r = await pool.query(
    'INSERT INTO dispatch_job_tags (job_id, tag_id, added_by) VALUES ($1,$2,$3) ' +
    'ON CONFLICT (job_id, tag_id) DO NOTHING RETURNING job_id', [id, tagId, req.user.id]);
  if (r.rows.length) await logEvent(id, 'tag_added', req, t.rows[0].name);
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

router.delete('/jobs/:id/tags/:tagId', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  if (!(await canManage(req))) return res.status(403).json({ error: 'Only dispatch can change tags.' });
  const id = parseInt(req.params.id, 10);
  const tagId = parseInt(req.params.tagId, 10);
  const t = await pool.query('SELECT name FROM dispatch_tags WHERE id = $1', [tagId]);
  const r = await pool.query('DELETE FROM dispatch_job_tags WHERE job_id = $1 AND tag_id = $2 RETURNING job_id', [id, tagId]);
  if (r.rows.length) await logEvent(id, 'tag_removed', req, (t.rows[0] && t.rows[0].name) || null);
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(stripPay([out.rows[0]], await payVisibility(req), req.user.id)[0]);
});

// Reference data the board and the call editor need in one round trip.
router.get('/reference', requireAuth, requireBoardOrCreate, async function (req, res) {
  const cats = await pool.query('SELECT code, name, sort FROM service_categories WHERE active = true ORDER BY sort, name');
  const types = await pool.query(
    'SELECT id, code, name, category_code, default_eta_minutes FROM service_types WHERE active = true ORDER BY sort, name');
  const tags = await pool.query('SELECT id, name, color FROM dispatch_tags WHERE active = true ORDER BY sort, name');
  const cities = await pool.query('SELECT TRIM(code) AS code, name, timezone FROM cities WHERE active = true ORDER BY name');
  const accounts = await pool.query(
    'SELECT id, name, po_required, vehicle_required, dispatch_notes, dispatch_tier FROM vendors ' +
    'WHERE show_in_invoice = true ORDER BY name');
  // Which categories THIS person may be handed, so the editor can grey the rest.
  const mine = await pool.query(
    'SELECT category_code, can_view, can_be_assigned FROM user_service_categories WHERE user_id = $1',
    [req.user.id]);
  res.json({
    categories: cats.rows, service_types: types.rows, tags: tags.rows,
    cities: cities.rows, accounts: accounts.rows, my_categories: mine.rows,
    me: { id: req.user.id, name: req.user.name, role: req.user.role,
      can_manage: await canManage(req), can_assign: await canAssign(req), can_create: await canCreate(req) },
    geocode_ready: geo.isConfigured(),
    customer_link_enabled: await callLink.linkEnabled(),
    schedule_lead_minutes: await scheduleLeadMinutes(),
    goto_live: (await gotoLive.status()).connected
  });
});

// ---------------------------------------------------------------------------
//  NEW CALL helpers (Tony 2026-10-13, plan claude/nova-dispatch-new-call-plan.md)
// ---------------------------------------------------------------------------
// Repeat callers. Typing the callback number shows any call from that number
// already on the board (so nobody creates a duplicate) and the last completed
// calls (Open / Fill from last call / Redispatch).
router.get('/lookup', requireAuth, requireCreate, async function (req, res) {
  const digits = phoneDigits(req.query.phone);
  if (digits.length < 7) return res.json({ open: [], previous: [] });
  const cols = 'j.id, j.job_number, j.status, j.created_at, j.service_type, j.service_type_id, j.is_edu, ' +
    'j.customer_name, j.business_name, j.customer_email, j.address, j.cross_street, j.zip, TRIM(j.city_code) AS city_code, ' +
    'j.vehicle_year, j.vehicle_make, j.vehicle_model, j.vehicle_color, j.license_tag, j.tag_state, j.vehicle_location, ' +
    'j.account_id, j.account_name, u.name AS assigned_name, c.name AS city_name ';
  const from = 'FROM dispatch_jobs j LEFT JOIN users u ON u.id = j.assigned_to ' +
    'LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) WHERE ' + PHONE_KEY_SQL + ' = $1 ';
  const open = await pool.query('SELECT ' + cols + from + 'AND j.status = ANY($2) ORDER BY j.created_at DESC LIMIT 5',
    [digits, BOARD_STATUSES]);
  const prev = await pool.query('SELECT ' + cols + from + 'AND NOT (j.status = ANY($2)) ORDER BY j.created_at DESC LIMIT 5',
    [digits, BOARD_STATUSES]);
  res.json({ open: open.rows, previous: prev.rows });
});

// The price and ETA the dispatcher reads to the customer, BEFORE the call is
// saved. Same pricing code the create uses, zone by zip only (no paid lookup
// on every keystroke). Read-only.
router.get('/quote-preview', requireAuth, requireCreate, async function (req, res) {
  const q = req.query || {};
  const stId = parseInt(q.service_type_id, 10) || null;
  const accId = parseInt(q.account_id, 10) || null;
  const zip = String(q.zip || '').trim().slice(0, 10);
  var city = q.city_code ? String(q.city_code).trim().slice(0, 3) : null;
  var zone = null, zoneCity = null;
  if (zip) {
    try { zone = await zones.zoneByZip(zip, city); } catch (e) { zone = null; }
    if (zone && zone.city_code) zoneCity = String(zone.city_code).trim();
  }
  if (!city && zoneCity) city = zoneCity;
  var configured = false;
  try { configured = city ? await zones.hasZones(city) : false; } catch (e) {}
  const edu = q.is_edu === '1' || q.is_edu === 'true';
  var out = { city_code: city, city_from_zip: zoneCity, zone: zone ? { id: zone.id, name: zone.name } : null,
    out_of_area: !!(configured && zip && !zone), wrong_city: !!(zone && city && zoneCity && zoneCity !== city),
    price: null, price_source: null, eta_minutes: null, time_code_title: null, reason: null };
  if (!stId || !city) { out.reason = !stId ? 'no_service_type' : 'no_city'; return res.json(out); }
  // A scheduled call is priced for when it will be worked.
  var when = new Date();
  if (q.scheduled_for) {
    const s = await scheduleAt(q.scheduled_for, city);
    if (s.error) out.schedule_error = s.error;
    else { when = s.at; out.scheduled_label = s.label; }
  }
  try {
    const p = await pricing.quote({ service_type_id: stId, city_code: city, account_id: accId, is_edu: edu,
      when: when, zone: zone, out_of_area: out.out_of_area });
    out.price = p.price; out.price_source = p.price_source; out.eta_minutes = p.eta_minutes;
    out.time_code_title = p.time_code_title; out.reason = p.reason || null;
    out.shutdown_message = p.shutdown_message || null;
  } catch (e) { out.reason = 'pricing_failed'; }
  if (out.eta_minutes === null) { const svc = await serviceSnapshot(stId); out.eta_minutes = svc.eta || null; }
  res.json(out);
});

// "Use my location" for a tech at a walk-up: coordinates in, street address out.
router.get('/reverse-geocode', requireAuth, requireCreate, async function (req, res) {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  if (!isFinite(lat) || !isFinite(lon)) return res.status(400).json({ error: 'Bad position' });
  if (!geo.isConfigured()) return res.json({ found: false, reason: 'not_configured' });
  var hit = null;
  try { hit = await geo.reverse(lat, lon); } catch (e) { hit = null; }
  if (!hit) return res.json({ found: false });
  var city = null;
  try { const z = await zones.zoneByZip(hit.zip, null); if (z && z.city_code) city = String(z.city_code).trim(); } catch (e) {}
  res.json({ found: true, address: hit.address, zip: hit.zip, city_name: hit.city, city_code: city });
});

// Who could take a call that does not exist yet (the New call screen's Who goes
// list). Same rules as /jobs/:id/assignable: the call's city and people whose
// categories allow that kind of work. Best-ETA ranking comes in a later step.
router.get('/assignable-preview', requireAuth, requireCreate, async function (req, res) {
  if (!(await canAssign(req))) return res.json({ people: [], can_assign: false });
  const city = req.query.city_code ? String(req.query.city_code).trim().slice(0, 3) : null;
  const stId = parseInt(req.query.service_type_id, 10) || null;
  var cat = null;
  if (stId) { const s2 = await serviceSnapshot(stId); cat = s2.category; }
  if (!city) return res.json({ people: [], can_assign: true });
  const params = [OPEN_STATUSES, city];
  var sql =
    'SELECT u.id, u.name, TRIM(u.home_city) AS home_city, COALESCE(d.ready,false) AS ready, ' +
    '  (SELECT COUNT(*)::int FROM dispatch_jobs oj WHERE oj.assigned_to = u.id AND oj.status = ANY($1)) AS open_calls, ' +
    '  tl.recorded_at AS last_ping ' +
    'FROM users u LEFT JOIN tech_duty d ON d.user_id = u.id LEFT JOIN tech_locations tl ON tl.user_id = u.id ' +
    'WHERE u.active = true AND TRIM(u.home_city) = $2';
  if (cat) {
    params.push(cat);
    sql += ' AND EXISTS (SELECT 1 FROM user_service_categories usc WHERE usc.user_id = u.id ' +
      'AND usc.category_code = $' + params.length + ' AND usc.can_be_assigned = true)';
  }
  sql += ' ORDER BY COALESCE(d.ready,false) DESC, open_calls ASC, u.name LIMIT 25';
  const r = await pool.query(sql, params);
  var people = r.rows.map(function (p) {
    return { user_id: p.id, name: p.name, ready: p.ready, open_calls: p.open_calls, last_ping: p.last_ping };
  });
  // Best ETA (step 5). Needs a map point for the typed address.
  var rk = null;
  try {
    const point = await previewPoint(req.query);
    var tier = null;
    const accId = parseInt(req.query.account_id, 10);
    if (accId) { const a = await pool.query('SELECT dispatch_tier FROM vendors WHERE id = $1', [accId]); tier = a.rows[0] ? a.rows[0].dispatch_tier : null; }
    rk = await eta.rank({ lat: point ? point.lat : null, lon: point ? point.lon : null, city_code: city, category: cat,
      service_type_id: stId, is_edu: req.query.is_edu === '1' || req.query.is_edu === 'true', account_tier: tier });
    people = mergeEta(people, rk);
  } catch (e) { console.error('who goes preview failed:', e.message); }
  res.json({ can_assign: true, people: people, best_user_id: rk && rk.pick ? rk.pick.user_id : null,
    why: rk ? rk.why : null, reason_code: rk ? rk.reason_code : null });
});

// ---------------------------------------------------------------------------
//  GoTo screen pop (step 6)
// ---------------------------------------------------------------------------
// The pop opens /?view=dispatch-new&cnum=<caller>&cnam=<name>[&line=<dialed>].
// Which city: the line that was dialed (when the pop can pass it), else the
// caller's most recent call, else the area code. Both maps are plain text in
// Dispatch settings, one "number = CITY" per line.
var AREA_DEFAULTS = { Orlando: ['407', '321', '689'], Jacksonville: ['904'], Tampa: ['813', '656'], Clearwater: ['727'],
  Tallahassee: ['850', '448'], Savannah: ['912'], Columbus: ['706', '762'], Birmingham: ['205', '659'] };
async function defaultAreaCodes() {
  const c = await pool.query('SELECT TRIM(code) AS code, name FROM cities WHERE active = true');
  const lines = [];
  Object.keys(AREA_DEFAULTS).forEach(function (nm) {
    const hit = c.rows.filter(function (x) { return String(x.name || '').toLowerCase().indexOf(nm.toLowerCase()) !== -1; })[0];
    if (hit) AREA_DEFAULTS[nm].forEach(function (ac) { lines.push(ac + ' = ' + hit.code); });
  });
  return lines.join('\n');
}
function mapPairs(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach(function (ln) {
    const m = /^\s*\+?1?[\s().-]*([0-9][0-9\s().-]*?)\s*[=:,]\s*([A-Za-z]{3})\s*$/.exec(ln);
    if (!m) return;
    const digits = m[1].replace(/[^0-9]/g, '');
    if (digits) out.push([digits.length > 10 ? digits.slice(-10) : digits, m[2].toUpperCase()]);
  });
  return out;
}
function parseMap(text) {
  const out = {};
  mapPairs(text).forEach(function (p) { out[p[0]] = p[1]; });
  return out;
}
function cleanMap(text) {
  const seen = {};
  return mapPairs(text).filter(function (p) { if (seen[p[0]]) return false; seen[p[0]] = 1; return true; })
    .map(function (p) { return p[0] + ' = ' + p[1]; }).join('\n');
}
// Which city a caller is probably in: the line they dialed, else their last
// call, else the area code. Shared by the screen pop and the live calls list.
async function guessCity(caller, line) {
  caller = phoneDigits(caller); line = phoneDigits(line);
  const valid = (await pool.query('SELECT TRIM(code) AS code, name FROM cities WHERE active = true')).rows;
  function ok(code) { return valid.filter(function (c) { return c.code === code; })[0] || null; }
  if (line) {
    const lines = parseMap(await callLink.getSetting('dispatch_goto_lines', ''));
    const hit = ok(lines[line]);
    if (hit) return { city_code: hit.code, city_name: hit.name, source: 'line' };
  }
  if (caller.length >= 7) {
    const r = await pool.query('SELECT TRIM(city_code) AS city_code FROM dispatch_jobs j WHERE ' + PHONE_KEY_SQL +
      ' = $1 AND city_code IS NOT NULL ORDER BY created_at DESC LIMIT 1', [caller]);
    const hit = r.rows[0] && ok(r.rows[0].city_code);
    if (hit) return { city_code: hit.code, city_name: hit.name, source: 'last_call' };
  }
  if (caller.length === 10) {
    var text = await callLink.getSetting('dispatch_area_codes', '');
    if (!text || text === '0') text = await defaultAreaCodes();
    const hit = ok(parseMap(text)[caller.slice(0, 3)]);
    if (hit) return { city_code: hit.code, city_name: hit.name, source: 'area_code' };
  }
  return { city_code: null, source: null };
}
router.get('/pop-city', requireAuth, requireCreate, async function (req, res) {
  res.json(await guessCity(req.query.phone, req.query.line));
});

// "Calls on the line" for the New call screen (Tony 2026-10-14): the dispatcher
// picks the call they are on instead of a screen pop jumping in front of them.
function sameName(a, b) {
  const n = function (x) { return String(x || '').toLowerCase().replace(/[^a-z ]/g, '').trim().split(/\s+/).filter(Boolean); };
  const A = n(a), B = n(b);
  if (!A.length || !B.length) return false;
  return A[0] === B[0] && (A.length < 2 || B.length < 2 || A[A.length - 1].charAt(0) === B[B.length - 1].charAt(0));
}
router.get('/live-calls', requireAuth, requireCreate, async function (req, res) {
  const st = await gotoLive.status();
  if (!st.connected) return res.json({ connected: false, calls: [] });
  const rows = await gotoLive.recent();
  const cityCache = {};
  const out = [];
  for (const r of rows) {
    const key = r.caller_digits + '|' + (r.dialed_digits || '');
    if (!cityCache[key]) cityCache[key] = await guessCity(r.caller_digits, r.dialed_digits);
    const c = cityCache[key];
    out.push({
      id: r.conversation_space_id, digits: r.caller_digits, name: r.caller_name, state: r.state,
      dialed: r.dialed_digits, answered_name: r.answered_name, answered_ext: r.answered_ext, ringing: r.ringing,
      started_at: r.started_at, answered_at: r.answered_at, ended_at: r.ended_at,
      city_code: c.city_code, city_name: c.city_name || null, city_source: c.source,
      mine: sameName(r.answered_name, req.user.name)
    });
  }
  out.sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
  res.json({ connected: true, last_event_at: st.last_event_at, calls: out });
});
router.post('/goto-live/connect', requireAuth, async function (req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Admins only.' });
  try { res.json(await gotoLive.subscribe()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
//  Who goes: best ETA + AI shadow mode (step 5)
// ---------------------------------------------------------------------------
// New call previews have no saved point yet. A typed address is geocoded once
// and remembered for an hour, so a dispatcher typing does not cost a paid
// lookup per keystroke (the screen only asks once address + zip are filled).
var _pointCache = {};
async function previewPoint(q) {
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  if (isFinite(lat) && isFinite(lon)) return { lat: lat, lon: lon };
  const addr = String(q.address || '').trim(), zip = String(q.zip || '').trim();
  if (!addr || !zip || !geo.isConfigured()) return null;
  const key = (addr + '|' + zip).toLowerCase();
  const hit = _pointCache[key];
  if (hit && Date.now() - hit.at < 3600000) return hit.point;
  var point = null;
  try { point = await geo.geocode({ address: addr, zip: zip }); } catch (e) { point = null; }
  const keys = Object.keys(_pointCache);
  if (keys.length > 300) delete _pointCache[keys[0]];
  _pointCache[key] = { at: Date.now(), point: point ? { lat: point.lat, lon: point.lon } : null };
  return _pointCache[key].point;
}
async function rankForJob(jobId, opts) {
  const r = await pool.query(
    'SELECT j.id, j.lat, j.lon, TRIM(j.city_code) AS city_code, j.service_type_id, j.is_edu, st.category_code, v.dispatch_tier ' +
    'FROM dispatch_jobs j LEFT JOIN service_types st ON st.id = j.service_type_id LEFT JOIN vendors v ON v.id = j.account_id WHERE j.id = $1', [jobId]);
  if (!r.rows.length) return null;
  const j = r.rows[0];
  return eta.rank({ lat: j.lat, lon: j.lon, city_code: j.city_code, category: j.category_code, service_type_id: j.service_type_id,
    is_edu: j.is_edu, account_tier: j.dispatch_tier }, Object.assign({ exclude_job_id: j.id }, opts || {}));
}
function suggestionOf(rk, category) {
  if (!rk || !rk.pick) return null;
  return { user_id: rk.pick.user_id, name: rk.pick.name, eta_minutes: rk.pick.eta_minutes, miles: rk.pick.miles,
    why: rk.why, reason_code: rk.reason_code, ai: category === 'roadside' };
}
// What the AI would have done, written once per call while shadow mode is on,
// and what a person actually did, so the two can be compared before anything
// is ever switched to live.
async function shadowRecord(jobId, rk, category) {
  try {
    if (!rk || rk.mode !== 'shadow') return;
    await pool.query(
      'INSERT INTO dispatch_ai_shadow (job_id, category, suggested_user_id, suggested_name, eta_minutes, miles, reason_code, why) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (job_id) DO NOTHING',
      [jobId, category || null, rk.pick ? rk.pick.user_id : null, rk.pick ? rk.pick.name : null,
        rk.pick ? rk.pick.eta_minutes : null, rk.pick ? rk.pick.miles : null, rk.reason_code, rk.why]);
  } catch (e) { console.error('ai shadow record failed:', e.message); }
}
async function shadowActual(jobId, uid, req) {
  try {
    await pool.query('UPDATE dispatch_ai_shadow SET actual_user_id = $2, actual_at = NOW(), actual_by = $3 WHERE job_id = $1 AND actual_user_id IS NULL',
      [jobId, uid, req.user.id]);
  } catch (e) {}
}
// "Dispatcher can override; overrides are logged" (plan, Who goes).
async function logOverride(jobId, uid, suggestedId, req) {
  suggestedId = parseInt(suggestedId, 10);
  if (!uid || !isFinite(suggestedId) || suggestedId <= 0 || suggestedId === uid) return;
  const n = await pool.query('SELECT id, name FROM users WHERE id = ANY($1)', [[uid, suggestedId]]);
  const name = {}; n.rows.forEach(function (x) { name[x.id] = x.name; });
  await logEvent(jobId, 'override', req, 'Sent to ' + (name[uid] || ('user ' + uid)) + ' instead of the suggested ' + (name[suggestedId] || ('user ' + suggestedId)));
}
function mergeEta(people, rk) {
  const by = {};
  ((rk && rk.ranked) || []).forEach(function (r) { by[r.user_id] = r; });
  return people.map(function (p) {
    const r = by[p.user_id];
    if (r) {
      p.eta_minutes = r.eta_minutes; p.miles = r.miles; p.free_in = r.free_in; p.drive_minutes = r.drive_minutes;
      p.has_fix = r.has_fix; p.stale = r.stale; p.estimate = r.estimate;
    }
    return p;
  }).sort(function (a, b) {
    const ea = a.eta_minutes === undefined || a.eta_minutes === null ? 1e9 : a.eta_minutes;
    const eb = b.eta_minutes === undefined || b.eta_minutes === null ? 1e9 : b.eta_minutes;
    return (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || ea - eb || String(a.name).localeCompare(String(b.name));
  });
}

// How shadow mode is doing: how often a person sent the same tech the AI would have.
router.get('/ai-shadow', requireAuth, async function (req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Admins only.' });
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const r = await pool.query(
    "SELECT s.*, j.job_number, au.name AS actual_name FROM dispatch_ai_shadow s JOIN dispatch_jobs j ON j.id = s.job_id " +
    "LEFT JOIN users au ON au.id = s.actual_user_id WHERE s.at > NOW() - ($1 || ' days')::interval ORDER BY s.at DESC", [String(days)]);
  const rows = r.rows;
  const decided = rows.filter(function (x) { return x.suggested_user_id && x.actual_user_id; });
  const agreed = decided.filter(function (x) { return x.suggested_user_id === x.actual_user_id; });
  const byReason = {};
  rows.forEach(function (x) { byReason[x.reason_code || 'none'] = (byReason[x.reason_code || 'none'] || 0) + 1; });
  res.json({
    days: days, total: rows.length, roadside: rows.filter(function (x) { return x.category === 'roadside'; }).length,
    compared: decided.length, agreed: agreed.length,
    agree_pct: decided.length ? Math.round(agreed.length / decided.length * 100) : null,
    by_reason: byReason,
    recent: rows.slice(0, 15).map(function (x) {
      return { job_number: x.job_number, at: x.at, category: x.category, suggested: x.suggested_name, eta_minutes: x.eta_minutes,
        miles: x.miles, reason_code: x.reason_code, why: x.why, actual: x.actual_name || null,
        agreed: x.actual_user_id ? x.actual_user_id === x.suggested_user_id : null };
    })
  });
});

// ---------------------------------------------------------------------------
//  Customer call link + ID photo (step 4)
// ---------------------------------------------------------------------------
// Send (or resend) the link, or just get it to copy. Board managers only, and
// only while the feature is switched on.
router.post('/jobs/:id/customer-link', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  if (!req._dispatchManage) return res.status(403).json({ error: 'Only dispatch can send the customer link.' });
  if (!(await callLink.linkEnabled())) return res.status(403).json({ error: 'Customer call links are turned off in Dispatch settings.' });
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT id, status FROM dispatch_jobs WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  if (callLink.OPEN.indexOf(r.rows[0].status) === -1) return res.status(409).json({ error: 'This call is closed.' });
  if (req.body && req.body.send) {
    const sent = await callLink.sendLink(id);
    await logEvent(id, sent.ok ? 'link_sent' : 'link_failed', req, sent.ok ? 'Texted the customer their call link' : ('Call link not sent: ' + (sent.error || 'unknown')));
    return res.status(sent.ok ? 200 : 502).json({ url: sent.url || null, sent: sent.ok, error: sent.error || null });
  }
  const token = await callLink.ensureToken(id);
  res.json({ url: callLink.linkUrl(token), sent: false });
});

// The customer's ID photo: dispatch, or the tech the call is assigned to.
router.get('/jobs/:id/id-image', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT assigned_to, id_image_r2_key, id_image_mime, id_image_at FROM dispatch_jobs WHERE id = $1', [id]);
  if (!r.rows.length || !r.rows[0].id_image_r2_key) return res.status(404).json({ error: 'No ID photo on this call.' });
  if (!req._dispatchManage && r.rows[0].assigned_to !== req.user.id) return res.status(403).json({ error: 'Only dispatch or the tech on this call can see the ID.' });
  var buf;
  try { buf = await require('../utils/r2').getObjectBuffer(r.rows[0].id_image_r2_key); }
  catch (e) { return res.status(502).json({ error: 'The ID photo could not be loaded.' }); }
  await logEvent(id, 'viewed_id', req, null);
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, action: 'view_id_image', user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ mime: r.rows[0].id_image_mime || 'image/jpeg', data: buf.toString('base64'), uploaded_at: r.rows[0].id_image_at });
});

// Dispatch settings that have no other screen. Admin and owner only.
var DISPATCH_SETTING_KEYS = ['dispatch_customer_link', 'onboarding_require_customer_photos', 'customer_photo_roles',
  'dispatch_ai_mode', 'dispatch_ai_extra_eta_minutes', 'dispatch_ai_save_miles', 'dispatch_ai_tier1_fastest',
  'dispatch_onsite_roadside', 'dispatch_onsite_locksmith', 'dispatch_goto_lines', 'dispatch_area_codes',
  'dispatch_schedule_lead_minutes'];
var DISPATCH_SETTING_DEFAULTS = { customer_photo_roles: 'locksmith,roadside_technician', dispatch_ai_mode: 'off',
  dispatch_ai_extra_eta_minutes: '5', dispatch_ai_save_miles: '10', dispatch_ai_tier1_fastest: '1',
  dispatch_onsite_roadside: '25', dispatch_onsite_locksmith: '45', dispatch_schedule_lead_minutes: '60' };
var DISPATCH_SETTING_NUM = { dispatch_ai_extra_eta_minutes: [0, 60], dispatch_ai_save_miles: [0, 200],
  dispatch_onsite_roadside: [1, 480], dispatch_onsite_locksmith: [1, 480], dispatch_schedule_lead_minutes: [0, 720] };
router.get('/settings', requireAuth, async function (req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Admins only.' });
  const out = {};
  for (const k of DISPATCH_SETTING_KEYS) out[k] = await callLink.getSetting(k, DISPATCH_SETTING_DEFAULTS[k] !== undefined ? DISPATCH_SETTING_DEFAULTS[k] : '0');
  out.routing_ready = !!(await callLink.getSetting('dispatch_routing_key', '') || await callLink.getSetting('location_traffic_key', ''));
  out.geocode_ready = geo.isConfigured();
  if (!out.dispatch_area_codes || out.dispatch_area_codes === '0') out.dispatch_area_codes = await defaultAreaCodes();
  if (out.dispatch_goto_lines === '0') out.dispatch_goto_lines = '';
  out.goto_live = await gotoLive.status();
  out.sms_ready = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
  out.storage_ready = require('../utils/r2').configured();
  out.app_url = process.env.APP_URL || '';
  res.json(out);
});
router.post('/settings', requireAuth, async function (req, res) {
  if (req.user.role !== 'admin' && req.user.role !== 'owner') return res.status(403).json({ error: 'Admins only.' });
  const b = req.body || {};
  const changed = {};
  for (const k of DISPATCH_SETTING_KEYS) {
    if (b[k] === undefined) continue;
    var v;
    if (k === 'dispatch_goto_lines' || k === 'dispatch_area_codes') {
      v = cleanMap(b[k]);
    } else if (k === 'customer_photo_roles') {
      v = String(b[k]).split(',').map(function (x) { return x.trim().replace(/[^a-z_]/g, ''); }).filter(Boolean).join(',');
    } else if (k === 'dispatch_ai_mode') {
      // 'live' (AI actually assigning) is not built yet: shadow only suggests and logs.
      v = String(b[k]) === 'shadow' ? 'shadow' : 'off';
    } else if (DISPATCH_SETTING_NUM[k]) {
      var n = parseFloat(b[k]);
      if (!isFinite(n)) continue;
      v = String(Math.min(DISPATCH_SETTING_NUM[k][1], Math.max(DISPATCH_SETTING_NUM[k][0], n)));
    } else {
      v = (b[k] === true || b[k] === '1' || b[k] === 'true') ? '1' : '0';
    }
    await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, v]);
    changed[k] = v;
  }
  eta._reset();
  await logAudit({ entity_type: 'settings', entity_id: 0, action: 'dispatch_settings', user_id: req.user.id, user_name: req.user.name, details: changed, ip: req.ip });
  res.json({ ok: true, changed: changed });
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
//  Customer call recordings (Tony 2026-10-15, utils/dispatchRecordings.js)
// ---------------------------------------------------------------------------
// Same idea as the complaint panel: GoTo calls (and Judi) matched by the call's
// phone numbers, limited to the hours around this job. Metadata only here; the
// audio is a separate, permissioned, logged call.
//
// WHO: the dispatch manager side, or anyone holding play_call_recordings. A tech
// working the call does not get the list (they do not get the number either).
async function canSeeRecordings(req) {
  return !!req._dispatchManage || (await hasPerm(req, 'play_call_recordings'));
}

async function jobForRecordings(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!(await canSeeRecordings(req))) { res.status(403).json({ error: 'You cannot see call recordings.' }); return null; }
  const r = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [id]);
  if (!r.rows.length) { res.status(404).json({ error: 'Not found' }); return null; }
  return r.rows[0];
}

// The number itself never goes out; which field(s) it matched does.
function recRow(c, nums) {
  const n = nums.filter(function (x) { return x.digits === c.external_digits; })[0];
  return {
    call_id: c.id,
    direction: c.direction,
    started_at: c.call_started_at,
    ended_at: c.call_ended_at,
    duration_sec: c.duration_sec,
    matched: n ? n.labels.join(' / ') : null,
    has_recording: !!c.has_recording,
    has_transcript: !!c.transcript_id,
    archived: !!c.r2_key,
    hidden: c.hidden === true
  };
}

async function recordingsBody(req, job, refreshed) {
  const cfg = await dispRec.config();
  const ok = await dispRec.gotoReady();
  const idx = await dispRec.indexInfo();
  // Re-evaluating on read keeps the stored state, the pill on the call and the
  // event log in step with what this screen is about to say.
  const s = await dispRec.evaluate(job, { cfg: cfg, idx: idx, gotoOk: ok });
  const calls = await dispRec.findCalls(job, cfg);
  const nums = dispRec.numbersOf(job);
  const canPlay = await hasPerm(req, 'play_call_recordings');
  const body = {
    state: s.state, found: s.found, recorded: s.recorded, waiting: s.waiting, hidden: s.hidden,
    window_start: s.window_start, window_end: s.window_end, pull_until: s.pull_until, active: s.active,
    numbers: nums.map(function (n) { return n.labels.join(' / '); }),
    index: idx, gotoConnected: ok, canPlay: canPlay, canEdit: !!req._dispatchManage,
    checked_at: new Date().toISOString(),
    calls: calls.map(function (c) { return recRow(c, nums); })
  };
  if (refreshed) body.refreshed = refreshed;

  // Judi (the AI receptionist) is fetched live and never stored, exactly like the
  // complaint panel. Only for people allowed to open its content, and never able
  // to fail the GoTo half.
  body.judi = { configured: false, calls: [] };
  if (canPlay) {
    try {
      const judi = require('../utils/judi');
      if (judi.configured()) {
        body.judi.configured = true;
        const from = new Date(s.window_start).getTime(), to = new Date(s.window_end).getTime();
        for (const n of nums) {
          const out = await judi.callsForPhone(n.digits, { limit: 50 });
          (out.calls || []).forEach(function (c) {
            const t = new Date(c.started_at || 0).getTime();
            if (!(t >= from && t <= to)) return;
            const row = Object.assign({}, c);
            delete row.number;
            row.matched = n.labels.join(' / ');
            body.judi.calls.push(row);
          });
        }
      }
    } catch (e) { body.judi.error = e.message || 'Judi unavailable'; }
  }
  return body;
}

router.get('/jobs/:id/recordings', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  try {
    const job = await jobForRecordings(req, res);
    if (!job) return;
    res.json(await recordingsBody(req, job, null));
  } catch (e) {
    console.error('GET /dispatch/jobs/:id/recordings:', e.message);
    res.status(500).json({ error: 'Failed to load call recordings' });
  }
});

// Pull from GoTo NOW instead of waiting for the 2-minute pass. Shares one
// bounded, single-flight sync with the cron (see pullRecent).
router.post('/jobs/:id/recordings/refresh', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  try {
    const job = await jobForRecordings(req, res);
    if (!job) return;
    var refreshed;
    if (!dispRec.numbersOf(job).length) refreshed = { ran: false, reason: 'no_phone' };
    if (!refreshed) {
      if (!(await dispRec.gotoReady())) refreshed = { ran: false, reason: 'not_connected' };
      else refreshed = await dispRec.pullRecent(dispRec.hoursBackFor(job, await dispRec.config()), 20);
    }
    res.json(await recordingsBody(req, job, refreshed));
  } catch (e) {
    console.error('POST /dispatch/jobs/:id/recordings/refresh:', e.message);
    res.status(500).json({ error: 'Failed to refresh call recordings' });
  }
});

// Archives the audio into R2 on first use, then a 120-second URL. Every play is
// written into the call's own event log, the same rule as on a complaint.
router.get('/jobs/:id/recordings/:callId/play', requireAuth, requirePermission('play_call_recordings'), requireBoardAccess, async function (req, res) {
  try {
    const job = await jobForRecordings(req, res);
    if (!job) return;
    const callId = parseInt(req.params.callId, 10);
    const call = await pool.query('SELECT id, external_digits, call_started_at FROM goto_calls WHERE id = $1', [callId]);
    if (!call.rows.length) return res.status(404).json({ error: 'Call not found' });
    // The call must belong to one of THIS job's numbers, or this would play any
    // indexed recording to anyone who can open any call.
    const digits = dispRec.numbersOf(job).map(function (n) { return n.digits; });
    if (digits.indexOf(call.rows[0].external_digits) === -1) {
      return res.status(403).json({ error: 'That recording is not on this call' });
    }
    const play = await require('../utils/goto').playbackUrl(callId);
    if (!req.viewingAs && !(req.user.isOwner || req.user.role === 'owner')) {
      const when = call.rows[0].call_started_at ? fmtWhen(call.rows[0].call_started_at, await cityTz(job.city_code)) : 'an unknown time';
      await logEvent(job.id, 'rec_played', req, 'Played the customer call from ' + when);
    }
    res.json({ url: play.url, mime: play.mime, bytes: play.bytes });
  } catch (e) {
    console.error('GET /dispatch/jobs/:id/recordings/:callId/play:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// { hidden: true|false } - "not this customer" (a shared office or motor club line).
router.patch('/jobs/:id/recordings/:callId', requireAuth, requirePermission('manage_dispatch'), requireBoardAccess, async function (req, res) {
  try {
    const job = await jobForRecordings(req, res);
    if (!job) return;
    const callId = parseInt(req.params.callId, 10);
    const call = await pool.query('SELECT id, external_digits FROM goto_calls WHERE id = $1', [callId]);
    if (!call.rows.length) return res.status(404).json({ error: 'Call not found' });
    const digits = dispRec.numbersOf(job).map(function (n) { return n.digits; });
    if (digits.indexOf(call.rows[0].external_digits) === -1) {
      return res.status(403).json({ error: 'That recording is not on this call' });
    }
    const hidden = !!(req.body && req.body.hidden);
    await pool.query(
      'INSERT INTO dispatch_job_recordings (job_id, call_id, hidden, set_by, set_by_name) VALUES ($1,$2,$3,$4,$5)' +
      ' ON CONFLICT (job_id, call_id) DO UPDATE SET hidden = $3, set_by = $4, set_by_name = $5',
      [job.id, callId, hidden, req.user.id, req.user.name]);
    await logEvent(job.id, hidden ? 'rec_hidden' : 'rec_unhidden', req, null);
    const fresh = await pool.query('SELECT * FROM dispatch_jobs WHERE id = $1', [job.id]);
    await dispRec.evaluate(fresh.rows[0]);
    res.json({ success: true });
  } catch (e) {
    console.error('PATCH /dispatch/jobs/:id/recordings/:callId:', e.message);
    res.status(500).json({ error: 'Failed to update the recording' });
  }
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
async function ageWarnMinutes() { return settingNum('dispatch_age_warn_minutes', 20, 1, 1440); }
async function ageAlertMinutes() { return settingNum('dispatch_age_alert_minutes', 45, 1, 1440); }
async function unassignedAlertMinutes() { return settingNum('dispatch_unassigned_alert_minutes', 5, 1, 240); }
// How far ahead of the appointment a scheduled call goes live on the board.
async function scheduleLeadMinutes() { return settingNum('dispatch_schedule_lead_minutes', 60, 0, 720); }

module.exports.acceptTimeoutMinutes = acceptTimeoutMinutes;
module.exports.unassignedAlertMinutes = unassignedAlertMinutes;
module.exports.notifyAssigned = notifyAssigned;
module.exports.releaseDueScheduled = releaseDueScheduled;

