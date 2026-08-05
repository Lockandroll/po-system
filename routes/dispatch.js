const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const duty = require('../utils/duty');
const permissions = require('../utils/permissions');
const push = require('../utils/push');
const pricing = require('../utils/pricing');

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
const STATUSES = ['new', 'assigned', 'accepted', 'enroute', 'onscene', 'done', 'goa', 'cancelled'];
const OPEN_STATUSES = ['new', 'assigned', 'accepted', 'enroute', 'onscene'];
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
  '       c.name AS city_name, c.color AS city_color, cb.name AS created_by_name, ' +
  '       st.name AS service_type_name, st.code AS service_type_code, ' +
  '       st.category_code AS service_category, st.default_eta_minutes, ' +
  '       v.name AS account_display_name, v.po_required AS account_po_required, ' +
  '       v.dispatch_notes AS account_dispatch_notes, ' +
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
    params.push(OPEN_STATUSES);
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
  res.json({
    jobs: req._dispatchManage ? rows : stripPhone(rows),
    canManage: !!req._dispatchManage,
    canAssign: await canAssign(req),
    canSeeViews: seeViews,
    acceptTimeoutMinutes: await acceptTimeoutMinutes(),
    ageWarnMinutes: await ageWarnMinutes(),
    ageAlertMinutes: await ageAlertMinutes(),
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
  const job = req._dispatchManage ? r.rows[0] : stripPhone([r.rows[0]])[0];
  res.json({ job: job, events: ev.rows, views: vws, canSeeViews: seeViews, canManage: !!req._dispatchManage });
});

router.post('/jobs', requireAuth, requirePermission('manage_dispatch'), async function (req, res) {
  const b = clean(req.body || {});
  if (!b.customer_name && !b.address) {
    return res.status(400).json({ error: 'A job needs at least a customer name or an address.' });
  }
  // A job with no city is unassignable to anyone (see the home-city rule on
  // /assign), so a silent NULL here would be a hole in that rule rather than a
  // convenience.
  if (!(await validCity(b.city_code))) {
    return res.status(400).json({ error: 'Pick a city. It has to be one of the cities set up in Nova.' });
  }
  const svc = await serviceSnapshot(b.service_type_id);
  const acct = await accountSnapshot(b.account_id);
  // The time code covering RIGHT NOW, in that city's own clock, decides both
  // the price and the ETA - unless the dispatcher typed over either, in which
  // case what they told the customer wins.
  const q = await pricing.quote({
    service_type_id: b.service_type_id, city_code: b.city_code,
    account_id: b.account_id, is_edu: b.is_edu, when: new Date()
  });
  const eta = b.eta_minutes !== null ? b.eta_minutes : (q.eta_minutes || null);
  const etaSrc = b.eta_minutes !== null ? 'manual' : (q.eta_source || null);
  const price = b.quoted_price !== null ? b.quoted_price : q.price;
  const priceSrc = b.quoted_price !== null ? 'manual' : q.price_source;
  const assign = req.body && req.body.assigned_to ? parseInt(req.body.assigned_to, 10) : null;
  const r = await pool.query(
    'INSERT INTO dispatch_jobs (source, status, status_since, priority, service_type, service_type_id, is_edu, ' +
    'account_id, account_name, account_po, business_name, customer_name, customer_phone, callback_phone, ' +
    'caller_id, customer_email, address, cross_street, city_state_zip, zip, city_code, ' +
    'vehicle_year, vehicle_make, vehicle_model, vehicle_color, license_tag, tag_state, vin, vehicle_location, ' +
    'eta_minutes, eta_source, eta_promised_at, quoted_price, quoted_price_src, time_code_id, ' +
    'notes, assigned_to, assigned_at, created_by) ' +
    "VALUES ('manual', $1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, " +
    '$18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37) RETURNING id',
    [assign ? 'assigned' : 'new', b.priority,
      svc.name || b.service_type, b.service_type_id, b.is_edu,
      b.account_id, acct.name, b.account_po, b.business_name,
      b.customer_name, b.customer_phone, b.callback_phone, b.caller_id, b.customer_email,
      b.address, b.cross_street, b.city_state_zip, b.zip, b.city_code,
      b.vehicle_year, b.vehicle_make, b.vehicle_model, b.vehicle_color,
      b.license_tag, b.tag_state, b.vin, b.vehicle_location,
      eta, eta === null ? null : etaSrc, promisedAt(eta, null),
      price, price === null ? null : priceSrc, q.time_code_id,
      b.notes, assign, assign ? new Date() : null, req.user.id]
  );
  const id = r.rows[0].id;
  // Numbered from the id so two dispatchers creating at once can never collide.
  const num = 'D' + String(id).padStart(5, '0');
  await pool.query('UPDATE dispatch_jobs SET job_number = $1 WHERE id = $2', [num, id]);
  await logEvent(id, 'created', req, svc.name || b.service_type || null);
  if (b.is_edu) await logEvent(id, 'edu', req, 'Emergency Door Unlocking - child or pet in vehicle');
  if (acct.name) await logEvent(id, 'account_set', req, acct.name + (acct.po_required ? ' - PO required' : ''));
  if (price !== null) {
    await logEvent(id, 'priced', req,
      '$' + Number(price).toFixed(2) + ' (' + (priceSrc || 'unknown') +
      (q.time_code_title ? ', ' + q.time_code_title : '') + ')');
  } else if (q.reason) {
    await logEvent(id, 'price_missing', req, q.reason);
  }
  if (assign) { await logEvent(id, 'assigned', req, 'user ' + assign); await notifyAssigned(id, assign); }
  await logAudit({ entity_type: 'dispatch_job', entity_id: id, entity_number: num, action: 'create',
    user_id: req.user.id, user_name: req.user.name, details: { assigned_to: assign }, ip: req.ip });
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
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
  const etaChanged = b.eta_minutes !== prev.eta_minutes;
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
  const nextStatus = uid ? (job.status === 'new' ? 'assigned' : job.status) : 'new';
  await pool.query(
    // $3 is cast explicitly: it is used both as the new status and inside the
    // CASE, and Postgres refuses to deduce one type for a parameter used in two
    // places (42P08). Same class of bug as the timeclock punch-edit 500.
    'UPDATE dispatch_jobs SET assigned_to=$1, assigned_at=$2, status=$3::varchar, ' +
    'status_since = CASE WHEN status <> $3::varchar THEN NOW() ELSE status_since END, ' +
    'updated_at=NOW() WHERE id=$4',
    [uid, uid ? new Date() : null, nextStatus, id]
  );
  await logEvent(id, uid ? 'assigned' : 'unassigned', req, uid ? 'user ' + uid : null);
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

  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
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
  res.json({
    people: r.rows.map(function (p) {
      return { user_id: p.id, name: p.name, home_city: p.home_city, role: p.role,
        ready: p.ready, open_calls: p.open_calls,
        out_of_city: String(p.home_city || '') !== String(job.city_code || '') };
    }),
    city_code: job.city_code,
    crossCityAvailable: isAdmin
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
  res.json(out.rows[0]);
});

router.delete('/jobs/:id/tags/:tagId', requireAuth, requirePermission('view_dispatch'), requireBoardAccess, async function (req, res) {
  if (!(await canManage(req))) return res.status(403).json({ error: 'Only dispatch can change tags.' });
  const id = parseInt(req.params.id, 10);
  const tagId = parseInt(req.params.tagId, 10);
  const t = await pool.query('SELECT name FROM dispatch_tags WHERE id = $1', [tagId]);
  const r = await pool.query('DELETE FROM dispatch_job_tags WHERE job_id = $1 AND tag_id = $2 RETURNING job_id', [id, tagId]);
  if (r.rows.length) await logEvent(id, 'tag_removed', req, (t.rows[0] && t.rows[0].name) || null);
  const out = await pool.query(JOB_SELECT + 'WHERE j.id = $1', [id]);
  res.json(out.rows[0]);
});

// Reference data the board and the call editor need in one round trip.
router.get('/reference', requireAuth, requirePermission('view_dispatch'), async function (req, res) {
  const cats = await pool.query('SELECT code, name, sort FROM service_categories WHERE active = true ORDER BY sort, name');
  const types = await pool.query(
    'SELECT id, code, name, category_code, default_eta_minutes FROM service_types WHERE active = true ORDER BY sort, name');
  const tags = await pool.query('SELECT id, name, color FROM dispatch_tags WHERE active = true ORDER BY sort, name');
  const cities = await pool.query('SELECT TRIM(code) AS code, name FROM cities WHERE active = true ORDER BY name');
  const accounts = await pool.query(
    'SELECT id, name, po_required, vehicle_required, dispatch_notes FROM vendors ' +
    'WHERE show_in_invoice = true ORDER BY name');
  // Which categories THIS person may be handed, so the editor can grey the rest.
  const mine = await pool.query(
    'SELECT category_code, can_view, can_be_assigned FROM user_service_categories WHERE user_id = $1',
    [req.user.id]);
  res.json({
    categories: cats.rows, service_types: types.rows, tags: tags.rows,
    cities: cities.rows, accounts: accounts.rows, my_categories: mine.rows
  });
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
async function ageWarnMinutes() { return settingNum('dispatch_age_warn_minutes', 20, 1, 1440); }
async function ageAlertMinutes() { return settingNum('dispatch_age_alert_minutes', 45, 1, 1440); }
async function unassignedAlertMinutes() { return settingNum('dispatch_unassigned_alert_minutes', 5, 1, 240); }

module.exports.acceptTimeoutMinutes = acceptTimeoutMinutes;
module.exports.unassignedAlertMinutes = unassignedAlertMinutes;
module.exports.notifyAssigned = notifyAssigned;

