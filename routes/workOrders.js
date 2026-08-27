const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const perms = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { parseWorkOrderEmail, saveCheckinRequirement } = require('../utils/workOrderParser');
const woJob = require('../jobs/workOrders');
const signoffTrips = require('../utils/signoffTrips');

const router = express.Router();

const STATUSES = ['received', 'in_process', 'job_completed', 'paperwork_sent', 'rejected', 'error'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === 'unknown') return null;
  return s;
}
function dateOrNull(v) {
  const s = strOrNull(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function moneyOrNull(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  return woJob.moneyOrNull(v);
}
async function canManage(req) { return perms.hasPermission(req.user.role, 'manage_work_orders'); }
// Only 'vehicle' or 'site' are ever stored. Anything else falls back to 'site'.
function jobTypeIn(b) {
  const v = String((b && b.job_type) || '').toLowerCase();
  return v === 'vehicle' ? 'vehicle' : 'site';
}

// Shared-secret guard for the cron/manual ingest endpoint (matches geico pattern)
function keyAuth(req, res, next) {
  const expected = process.env.REPORT_API_KEY;
  if (!expected) return res.status(500).json({ error: 'REPORT_API_KEY is not configured' });
  if (req.headers['x-report-key'] !== expected) return res.status(401).json({ error: 'Invalid or missing report key' });
  next();
}

// POST /api/work-orders/ingest — trigger a mailbox poll (key-protected, for cron/manual)
router.post('/ingest', keyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const summary = await woJob.runIngest({ force: b.force === true, sinceIso: b.sinceIso, lookbackHours: b.lookbackHours, top: b.top, paginate: b.paginate === true });
    res.json({ ok: true, summary: summary });
  } catch (err) {
    console.error('POST /api/work-orders/ingest failed:', err);
    res.status(500).json({ error: err.message || 'Ingest failed' });
  }
});

// GET /api/work-orders/health - is the mailbox poll actually running?
// A dead Azure secret or a flipped-off setting used to look exactly like a quiet week.
router.get('/health', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    res.json(await woJob.ingestHealth());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to read intake health' }); }
});

// POST /api/work-orders/catch-up - re-scan the mailbox over a wider window.
// The scheduled poll only looks back 72 hours, so anything missed during an outage
// longer than that is never picked up again on its own. Dedup on email_message_id plus
// the deleted-email tombstones make this safe to run as often as you like.
router.post('/catch-up', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const raw = parseInt((req.body && req.body.lookbackHours), 10);
    const hours = Math.min(Math.max(isNaN(raw) ? 168 : raw, 1), 720);
    const summary = await woJob.runIngest({ lookbackHours: hours, top: 100, paginate: true });
    try {
      await logAudit({ entity_type: 'work_order', entity_id: null, entity_number: null, action: 'catch_up_scan',
        user_id: req.user.id, user_name: req.user.name, details: { lookback_hours: hours, summary: summary } });
    } catch (e) {}
    res.json({ ok: true, lookbackHours: hours, summary: summary });
  } catch (err) {
    console.error('POST /api/work-orders/catch-up failed:', err);
    res.status(500).json({ error: err.message || 'Catch-up scan failed' });
  }
});

// GET /api/work-orders/counts — per-status counts (scoped to what the user can see)
router.get('/counts', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    const manage = await canManage(req);
    const params = [];
    let where = '';
    // Superseded stubs are revision emails already folded into their original work
    // order — they are bookkeeping, never a queue item.
    where = "WHERE status <> 'superseded'";
    if (!manage) { where += ' AND assigned_to = $1'; params.push(req.user.id); }
    const { rows } = await pool.query('SELECT status, COUNT(*)::int AS n FROM work_orders ' + where + ' GROUP BY status', params);
    const counts = {};
    rows.forEach(function (r) { counts[r.status] = r.n; });
    res.json(counts);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load counts' }); }
});

// GET /api/work-orders — list with filters, search, pagination
router.get('/', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    const manage = await canManage(req);
    const where = [];
    const params = [];
    function add(cond, val) { params.push(val); where.push(cond.replace('$$', '$' + params.length)); }

    where.push("status <> 'superseded'");   // revision stubs live on their original WO
    if (!manage) add('assigned_to = $$', req.user.id);
    if (req.query.status && STATUSES.indexOf(req.query.status) !== -1) add('status = $$', req.query.status);
    if (req.query.account_id) add('account_id = $$', parseInt(req.query.account_id, 10));
    if (req.query.assigned_to) add('assigned_to = $$', parseInt(req.query.assigned_to, 10));
    if (req.query.city_code) add('city_code = $$', req.query.city_code);
    if (req.query.from) add('created_at >= $$', req.query.from);
    if (req.query.to) add('created_at < $$', req.query.to);
    if (req.query.q) {
      // A tech pastes a VIN off the form, sometimes with the spaces still in it.
      const rawQ = String(req.query.q).trim();
      const vinish = /^[A-Za-z0-9 \-]{11,25}$/.test(rawQ) ? rawQ.replace(/[ \-]/g, '') : rawQ;
      const like = '%' + vinish + '%';
      params.push(like);
      const p = '$' + params.length;
      where.push('(account_name ILIKE ' + p + ' OR store_name ILIKE ' + p + ' OR store_number ILIKE ' + p +
        ' OR service_requested ILIKE ' + p + ' OR po_number ILIKE ' + p + ' OR wo_number ILIKE ' + p + ' OR wo_ref ILIKE ' + p +
        ' OR vin ILIKE ' + p + ' OR claim_id ILIKE ' + p + ' OR yard_name ILIKE ' + p + ' OR bay_location ILIKE ' + p +
        ' OR email_subject ILIKE ' + p + ' OR email_from ILIKE ' + p + ')');
    }
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const totalQ = await pool.query('SELECT COUNT(*)::int AS n FROM work_orders ' + whereSql, params);
    const total = totalQ.rows[0].n;

    const listSql =
      'SELECT w.id, w.wo_ref, w.source, w.status, w.priority, w.account_name, w.store_name, w.store_number, ' +
      '       w.wo_number, w.po_number, w.city_code, ' +
      '       w.job_type, w.vin, w.vehicle_year, w.vehicle_make, w.vehicle_model, w.yard_name, w.bay_location, ' +
      '       w.service_requested, w.needed_by, w.confidence, w.assigned_to, a.name AS assignee_name, ' +
      '       w.nte_amount, w.revision_count, w.last_revision_at, ' +
      '       w.signoff_id, w.email_received_at, w.created_at, ' +
      '       w.email_subject, w.email_from, w.parse_error, ' +
      "       (SELECT COUNT(*) FROM work_order_attachments x WHERE x.work_order_id = w.id)::int AS attachment_count " +
      'FROM work_orders w LEFT JOIN users a ON w.assigned_to = a.id ' +
      whereSql +
      " ORDER BY CASE w.status WHEN 'received' THEN 0 WHEN 'in_process' THEN 1 WHEN 'job_completed' THEN 2 ELSE 3 END, " +
      '         w.needed_by NULLS LAST, w.created_at DESC ' +
      'LIMIT ' + limit + ' OFFSET ' + offset;
    const { rows } = await pool.query(listSql, params);
    res.json({ items: rows, total: total, limit: limit, offset: offset });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load work orders' }); }
});

async function loadWorkOrder(id) {
  const { rows } = await pool.query(
    'SELECT w.*, a.name AS assignee_name, r.name AS reviewed_by_name, c.name AS created_by_name ' +
    'FROM work_orders w LEFT JOIN users a ON w.assigned_to = a.id LEFT JOIN users r ON w.reviewed_by = r.id ' +
    'LEFT JOIN users c ON w.created_by = c.id WHERE w.id = $1',
    [id]
  );
  if (!rows.length) return null;
  const wo = rows[0];
  const att = await pool.query('SELECT id, filename, mime_type, size_bytes FROM work_order_attachments WHERE work_order_id = $1 ORDER BY id', [id]);
  const act = await pool.query('SELECT * FROM work_order_activity WHERE work_order_id = $1 ORDER BY created_at ASC, id ASC', [id]);
  wo.attachments = att.rows;
  wo.activity = act.rows;
  const nte = await pool.query(
    'SELECT h.*, u.name AS changed_by_user FROM work_order_nte_history h LEFT JOIN users u ON h.changed_by = u.id ' +
    'WHERE h.work_order_id = $1 ORDER BY h.created_at DESC, h.id DESC',
    [id]
  );
  wo.nte_history = nte.rows;
  // The revision emails that were folded into this work order (kept as superseded stubs).
  const revs = await pool.query(
    'SELECT id, wo_ref, email_from, email_subject, email_received_at, nte_amount FROM work_orders ' +
    'WHERE revision_of_id = $1 ORDER BY id ASC',
    [id]
  );
  wo.revisions = revs.rows;
  if (wo.signoff_id) {
    // The WO points at the live sheet; load the whole trip series so the detail page can show
    // every visit on the job. wo.signoff stays the latest trip for backward compatibility.
    const so = await pool.query(
      'SELECT s.id, s.form_number, s.status, s.trip_number, s.work_complete, s.completed_at, s.trip_reason, u.name AS completed_by_name ' +
      'FROM signoff_forms s LEFT JOIN users u ON s.completed_by = u.id ' +
      'WHERE s.trip_group_id = (SELECT COALESCE(trip_group_id, id) FROM signoff_forms WHERE id = $1) ' +
      'ORDER BY s.trip_number ASC',
      [wo.signoff_id]
    );
    wo.signoffs = so.rows;
    wo.signoff = so.rows.length ? so.rows[so.rows.length - 1] : null;
    // Can this job take another sign-off sheet right now? True only when every trip on it is
    // finished — one live sheet per job. This is what draws the "+ Add Sign-Off Sheet" tile and
    // pre-ticks the box in the reopen dialog, so the UI never offers a trip the API would refuse.
    wo.can_add_signoff_trip = !!(so.rows.length && so.rows.every(function (t) { return t.status === 'completed'; }));
    // The job's invoice, if one exists. Looked up by trip group so any trip on
    // the job finds the invoice an earlier trip created. Best-effort: a lookup
    // failure must not break the work order detail page.
    wo.invoice_link = null;
    try {
      const inv = await pool.query(
        'SELECT id, invoice_number, status FROM invoices WHERE signoff_group_id = ' +
        '(SELECT COALESCE(trip_group_id, id) FROM signoff_forms WHERE id = $1) ' +
        'ORDER BY id DESC LIMIT 1',
        [wo.signoff_id]
      );
      if (inv.rows.length) {
        wo.invoice_link = {
          id: inv.rows[0].id,
          invoice_number: String(inv.rows[0].invoice_number),
          status: inv.rows[0].status
        };
      }
    } catch (e) { console.error('Work order invoice link lookup failed:', e && e.message); }
  }
  return wo;
}

// GET /api/work-orders/:id
router.get('/assignees', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE active IS NOT FALSE ORDER BY name ASC');
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch assignees' }); }
});

router.get('/:id', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    const wo = await loadWorkOrder(req.params.id);
    if (!wo) return res.status(404).json({ error: 'Work order not found' });
    if (!(await canManage(req)) && wo.assigned_to !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(wo);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load work order' }); }
});

// GET /api/work-orders/:id/attachments/:aid — raw image data for the detail viewer
router.get('/:id/attachments/:aid', requireAuth, requirePermission('view_work_orders'), async (req, res) => {
  try {
    // Apply the same ownership check GET /:id enforces before handing back raw image data.
    const woRows = await pool.query('SELECT assigned_to FROM work_orders WHERE id = $1', [req.params.id]);
    if (!woRows.rows.length) return res.status(404).json({ error: 'Work order not found' });
    if (!(await canManage(req)) && woRows.rows[0].assigned_to !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await pool.query('SELECT image_data, mime_type FROM work_order_attachments WHERE id = $1 AND work_order_id = $2', [req.params.aid, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    res.json({ image_data: rows[0].image_data, mime_type: rows[0].mime_type });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load attachment' }); }
});

// POST /api/work-orders — manual create
router.post('/', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!strOrNull(b.service_requested) && !strOrNull(b.account_name) && !strOrNull(b.store_name)) {
      return res.status(400).json({ error: 'Enter at least an account, store, or the service requested.' });
    }
    const woRef = await woJob.genWoRef();
    const acct = await resolveAccountId(b.account_number, b.account_name);
    const { rows } = await pool.query(
      'INSERT INTO work_orders (wo_ref, source, status, priority, account_id, account_name, account_number, city_code, po_number, wo_number, ' +
      'store_name, store_number, address, city_state_zip, service_requested, service_requested_by, contact_name, contact_phone, needed_by, notes, created_by, assigned_to, ' +
      'job_type, claim_id, vin, vehicle_year, vehicle_make, vehicle_model, vehicle_mileage, repair_code, yard_name, bay_location, special_instructions, nte_amount) ' +
      "VALUES ($1,'manual','received',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) RETURNING id",
      [woRef, PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : 'normal', acct.account_id, strOrNull(b.account_name), strOrNull(b.account_number), acct.city_code,
       strOrNull(b.po_number), strOrNull(b.wo_number), strOrNull(b.store_name), strOrNull(b.store_number), strOrNull(b.address), strOrNull(b.city_state_zip),
       strOrNull(b.service_requested), strOrNull(b.service_requested_by), strOrNull(b.contact_name), strOrNull(b.contact_phone), dateOrNull(b.needed_by), strOrNull(b.notes), req.user.id,
       (b.assigned_to ? parseInt(b.assigned_to, 10) : null),
       jobTypeIn(b), strOrNull(b.claim_id), woJob.normalizeVin(b.vin), strOrNull(b.vehicle_year), strOrNull(b.vehicle_make),
       strOrNull(b.vehicle_model), strOrNull(b.vehicle_mileage), strOrNull(b.repair_code), strOrNull(b.yard_name),
       strOrNull(b.bay_location), strOrNull(b.special_instructions), moneyOrNull(b.nte_amount)]
    );
    const id = rows[0].id;
    await woJob.addActivity(id, req.user, 'event', 'created this work order manually');
    try { await logAudit({ entity_type: 'work_order', entity_id: id, entity_number: woRef, action: 'created', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.status(201).json(await loadWorkOrder(id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create work order' }); }
});

async function resolveAccountId(accountNumber, accountName) {
  const acct = strOrNull(accountNumber), name = strOrNull(accountName);
  try {
    if (acct) {
      const { rows } = await pool.query('SELECT id, city_code FROM vendors WHERE UPPER(TRIM(account_number)) = UPPER(TRIM($1)) LIMIT 1', [acct]);
      if (rows.length) return { account_id: rows[0].id, city_code: rows[0].city_code || null };
    }
    if (name) {
      const { rows } = await pool.query('SELECT id, city_code FROM vendors WHERE name ILIKE $1 ORDER BY id LIMIT 1', ['%' + name + '%']);
      if (rows.length) return { account_id: rows[0].id, city_code: rows[0].city_code || null };
    }
  } catch (e) {}
  return { account_id: null, city_code: null };
}

// PUT /api/work-orders/:id — edit fields
router.put('/:id', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const ex = (await pool.query('SELECT * FROM work_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Work order not found' });
    const b = req.body || {};
    function pick(k, cur) { return b[k] !== undefined ? strOrNull(b[k]) : cur; }
    const acct = await resolveAccountId(b.account_number !== undefined ? b.account_number : ex.account_number, b.account_name !== undefined ? b.account_name : ex.account_name);
    // City: a manual edit to the city wins. Otherwise keep what is already there —
    // never let re-resolving the vendor stomp a city that was derived from the
    // service address (Fenkell is a Michigan dispatcher sending jobs nationwide).
    const cityCode = (b.city_code !== undefined) ? strOrNull(b.city_code) : (ex.city_code || acct.city_code);
    const newJobType = (b.job_type !== undefined) ? jobTypeIn(b) : (ex.job_type || 'site');
    // NTE: a manager can set or correct the limit by hand. Every move is written to
    // work_order_nte_history so "who raised it, and to what" is never a guess.
    const oldNte = (ex.nte_amount === null || ex.nte_amount === undefined) ? null : parseFloat(ex.nte_amount);
    const newNte = (b.nte_amount !== undefined) ? moneyOrNull(b.nte_amount) : oldNte;
    const nteChanged = (b.nte_amount !== undefined) && (newNte !== oldNte);

    await pool.query(
      'UPDATE work_orders SET account_id=$1, account_name=$2, account_number=$3, city_code=$4, po_number=$5, wo_number=$6, store_name=$7, store_number=$8, ' +
      'address=$9, city_state_zip=$10, service_requested=$11, service_requested_by=$12, contact_name=$13, contact_phone=$14, needed_by=$15, notes=$16, ' +
      'priority=$17, assigned_to=$18, ' +
      'job_type=$19, claim_id=$20, vin=$21, vehicle_year=$22, vehicle_make=$23, vehicle_model=$24, vehicle_mileage=$25, ' +
      'repair_code=$26, yard_name=$27, bay_location=$28, special_instructions=$29, nte_amount=$30, ' +
      // A manager correcting the check-in line by hand. The parser is good but a
      // number it read off a fax is exactly the sort of thing a person should be
      // able to fix without waiting for anybody.
      'checkin_phone=$32, checkin_reference=$33, checkin_instructions=$34, checkin_tracking=$35, updated_at=NOW() WHERE id=$31',
      [acct.account_id, pick('account_name', ex.account_name), pick('account_number', ex.account_number), cityCode,
       pick('po_number', ex.po_number), pick('wo_number', ex.wo_number), pick('store_name', ex.store_name), pick('store_number', ex.store_number),
       pick('address', ex.address), pick('city_state_zip', ex.city_state_zip), pick('service_requested', ex.service_requested), pick('service_requested_by', ex.service_requested_by),
       pick('contact_name', ex.contact_name), pick('contact_phone', ex.contact_phone), b.needed_by !== undefined ? dateOrNull(b.needed_by) : ex.needed_by, pick('notes', ex.notes),
       (b.priority !== undefined && PRIORITIES.indexOf(b.priority) !== -1) ? b.priority : ex.priority,
       b.assigned_to !== undefined ? (b.assigned_to ? parseInt(b.assigned_to, 10) : null) : ex.assigned_to,
       newJobType, pick('claim_id', ex.claim_id),
       b.vin !== undefined ? woJob.normalizeVin(b.vin) : ex.vin,
       pick('vehicle_year', ex.vehicle_year), pick('vehicle_make', ex.vehicle_make), pick('vehicle_model', ex.vehicle_model),
       pick('vehicle_mileage', ex.vehicle_mileage), pick('repair_code', ex.repair_code), pick('yard_name', ex.yard_name),
       pick('bay_location', ex.bay_location), pick('special_instructions', ex.special_instructions), newNte, req.params.id,
       pick('checkin_phone', ex.checkin_phone), pick('checkin_reference', ex.checkin_reference), pick('checkin_instructions', ex.checkin_instructions),
       pick('checkin_tracking', ex.checkin_tracking)]
    );
    // A person overruling the parser on whether this job needs a check-in.
    // Setting it by hand also CLEARS the disagreement note, because the note
    // exists to get somebody to look and somebody just did.
    var ciTouched = ['checkin_required', 'checkout_required', 'checkin_method'].some(function (k) { return b[k] !== undefined; });
    if (ciTouched) {
      var triOf = function (v, cur) {
        if (v === undefined) return cur;
        var t = String(v == null ? '' : v).toLowerCase();
        return (t === 'yes' || t === 'no') ? t : 'unknown';
      };
      var METHOD_OK = ['phone', 'app', 'portal', 'phone_or_app', 'unknown'];
      var mIn = b.checkin_method === undefined ? ex.checkin_method
        : (METHOD_OK.indexOf(String(b.checkin_method || '').toLowerCase()) === -1 ? 'unknown' : String(b.checkin_method).toLowerCase());
      await pool.query(
        'UPDATE work_orders SET checkin_required = $2, checkout_required = $3, checkin_method = $4, ' +
        'checkin_ai_note = NULL, updated_at = NOW() WHERE id = $1',
        [req.params.id, triOf(b.checkin_required, ex.checkin_required),
          triOf(b.checkout_required, ex.checkout_required), mIn]
      );
      await woJob.addActivity(req.params.id, req.user, 'event',
        'set check-in required to ' + triOf(b.checkin_required, ex.checkin_required) +
        ' and check-out required to ' + triOf(b.checkout_required, ex.checkout_required));
    }
    if (nteChanged) {
      await pool.query(
        "INSERT INTO work_order_nte_history (work_order_id, old_amount, new_amount, source, changed_by, changed_by_name, note) VALUES ($1,$2,$3,'manual',$4,$5,$6)",
        [req.params.id, oldNte, newNte, req.user.id, req.user.name, 'Set by hand in Nova']
      );
      await woJob.addActivity(req.params.id, req.user, 'event',
        'set the NTE to ' + woJob.money(newNte) + (oldNte !== null ? ' (was ' + woJob.money(oldNte) + ')' : ''));
      try { await logAudit({ entity_type: 'work_order', entity_id: parseInt(req.params.id), entity_number: ex.wo_ref, action: 'nte_changed', user_id: req.user.id, user_name: req.user.name, details: { old_nte: oldNte, new_nte: newNte } }); } catch (e) {}
    }
    if (b.job_type !== undefined && newJobType !== (ex.job_type || 'site')) {
      await woJob.addActivity(req.params.id, req.user, 'event', 'changed the job type from ' + (ex.job_type || 'site') + ' to ' + newJobType);
    }
    await woJob.addActivity(req.params.id, req.user, 'event', 'edited the work order');
    try { await logAudit({ entity_type: 'work_order', entity_id: parseInt(req.params.id), entity_number: ex.wo_ref, action: 'edited', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json(await loadWorkOrder(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update work order' }); }
});

// opts (all optional):
//   new_trip    — the caller is REOPENING a finished job (the account added work after sign-off)
//                 and wants the next sign-off sheet created for the return visit.
//   trip_reason — why, in the tech's words. Lands on the new sheet and in the WO activity trail.
//   note        — extra words appended to the activity line (the reopen reason, today).
async function setStatus(req, id, status, assignTo, opts) {
  opts = opts || {};
  const ex = (await pool.query('SELECT * FROM work_orders WHERE id = $1', [id])).rows[0];
  if (!ex) return { error: 'Work order not found', code: 404 };
  if (STATUSES.indexOf(status) === -1) return { error: 'Invalid status', code: 400 };

  const reopening = (status === 'in_process' && (ex.status === 'job_completed' || ex.status === 'paperwork_sent'));
  let signoffNote = '';
  // Moving into 'in_process' = an employee approved Claude's info: stamp reviewer + ensure a sign-off exists.
  if (status === 'in_process' && ex.status !== 'in_process') {
    await pool.query('UPDATE work_orders SET reviewed_by=$1, reviewed_at=NOW() WHERE id=$2', [req.user.id, id]);
    if (!ex.signoff_id) {
      try {
        const woRow = (await pool.query('SELECT * FROM work_orders WHERE id=$1', [id])).rows[0];
        const effectiveAssignee = (assignTo !== undefined) ? (assignTo ? parseInt(assignTo, 10) : null) : (woRow.assigned_to || null);
        const sid = await woJob.createSignoffForWO(woRow, req.user.id, effectiveAssignee);
        await pool.query('UPDATE work_orders SET signoff_id=$1 WHERE id=$2', [sid, id]);
        signoffNote = ' (pending sign-off created)';
      } catch (e) { console.error('signoff create on approve failed:', e.message); }
    } else if (opts.new_trip) {
      // Reopening a job that already has sheets. The one the WO points at is signed and locked,
      // so the tech needs a fresh one for the added work.
      //
      // Best-effort on purpose: if the trip cannot be created the STATUS CHANGE MUST STILL
      // HAPPEN. A manager who reopened a job and got a 500 back would have no idea whether the
      // job moved. The activity line says what went wrong instead.
      try {
        const series = await signoffTrips.seriesForSheet(ex.signoff_id);
        if (series && series.open) {
          // A sheet is somehow already open on this job. Don't make a second live one — point
          // the work order at the open sheet and say so.
          await pool.query('UPDATE work_orders SET signoff_id=$1 WHERE id=$2', [series.open.id, id]);
          signoffNote = ' (sign-off ' + series.open.form_number + ' was already open, so no new trip was created)';
        } else {
          const srcId = (series && series.latest) ? series.latest.id : ex.signoff_id;
          const r = await signoffTrips.createNextTrip(srcId, {
            userId: req.user.id,
            userName: req.user.name,
            assignedTo: (assignTo !== undefined) ? (assignTo ? parseInt(assignTo, 10) : null) : undefined,
            trip_reason: opts.trip_reason || null,
            via: 'work_order'
          });
          if (r.error) signoffNote = ' (sign-off trip NOT created: ' + r.error + ')';
          else signoffNote = ' and created sign-off Trip ' + r.trip.trip_number + ' (' + r.trip.form_number + ')';
        }
      } catch (e) { console.error('reopen trip create failed:', e && e.message); signoffNote = ' (sign-off trip NOT created: ' + (e && e.message) + ')'; }
    }
  }
  const fields = ['status=$1', 'updated_at=NOW()'];
  const params = [status];
  if (assignTo !== undefined) { params.push(assignTo ? parseInt(assignTo, 10) : null); fields.splice(1, 0, 'assigned_to=$' + params.length); }
  params.push(id);
  await pool.query('UPDATE work_orders SET ' + fields.join(', ') + ' WHERE id=$' + params.length, params);
  const verb = reopening ? ('reopened this work order to in_process (was ' + ex.status + ')') : ('set status to ' + status);
  const why = (reopening && opts.trip_reason) ? (' - "' + String(opts.trip_reason).trim() + '"') : '';
  await woJob.addActivity(id, req.user, 'event', verb + signoffNote + why);
  try { await logAudit({ entity_type: 'work_order', entity_id: parseInt(id), entity_number: ex.wo_ref, action: reopening ? 'reopened' : status, user_id: req.user.id, user_name: req.user.name, details: reopening ? { from: ex.status, reason: opts.trip_reason || null, new_trip: !!opts.new_trip } : undefined }); } catch (e) {}
  return { ok: true };
}

// PATCH /api/work-orders/:id/status
router.patch('/:id/status', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await setStatus(req, req.params.id, b.status, b.assigned_to, {
      new_trip: b.new_trip === true || b.new_trip === 'true',
      trip_reason: b.trip_reason || null
    });
    if (r.error) return res.status(r.code).json({ error: r.error });
    res.json(await loadWorkOrder(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update status' }); }
});

// POST /api/work-orders/bulk — { ids:[], status?, assigned_to? }
router.post('/bulk', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : [];
    if (!ids.length) return res.status(400).json({ error: 'No work orders selected' });
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
      if (b.status) { const r = await setStatus(req, ids[i], b.status, b.assigned_to); if (r.ok) done++; }
      else if (b.assigned_to !== undefined) {
        await pool.query('UPDATE work_orders SET assigned_to=$1, updated_at=NOW() WHERE id=$2', [b.assigned_to ? parseInt(b.assigned_to, 10) : null, ids[i]]);
        await woJob.addActivity(ids[i], req.user, 'event', 'reassigned (bulk)');
        done++;
      }
    }
    res.json({ ok: true, updated: done });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Bulk update failed' }); }
});

// POST /api/work-orders/:id/reparse — re-run the AI parser on the stored email + attachments
router.post('/:id/reparse', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const ex = (await pool.query('SELECT * FROM work_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Work order not found' });
    const att = await pool.query('SELECT filename, mime_type, image_data FROM work_order_attachments WHERE work_order_id = $1', [req.params.id]);
    const attachments = att.rows.map(function (a) { return { filename: a.filename, mime: a.mime_type, contentBytes: a.image_data }; });
    const accRows = await pool.query("SELECT name FROM vendors WHERE name IS NOT NULL AND TRIM(name) <> '' ORDER BY name");
    const knownAccounts = accRows.rows.map(function (r) { return r.name; });
    let parsed;
    try { parsed = await parseWorkOrderEmail(ex.email_body || '', attachments, knownAccounts, ex.email_subject || ''); }
    catch (e) { return res.status(502).json({ error: 'AI parse failed: ' + e.message }); }
    const acct = await resolveAccountId(parsed.account_number, parsed.account_name);
    const cityCode = await woJob.deriveCityCode(parsed, acct);
    const jobType = woJob.jobTypeOf(parsed);
    await pool.query(
      'UPDATE work_orders SET account_id=$1, account_name=$2, account_number=$3, city_code=$4, po_number=$5, wo_number=$6, store_name=$7, store_number=$8, ' +
      'address=$9, city_state_zip=$10, service_requested=$11, service_requested_by=$12, contact_name=$13, contact_phone=$14, needed_by=$15, notes=$16, ' +
      'parsed=$17, confidence=$18, ' +
      'job_type=$19, claim_id=$20, vin=$21, vehicle_year=$22, vehicle_make=$23, vehicle_model=$24, vehicle_mileage=$25, ' +
      'repair_code=$26, yard_name=$27, bay_location=$28, special_instructions=$29, nte_amount=$30, ' +
      // Re-parsing an old work order is how the back catalogue grows check-in
      // data without anybody retyping anything.
      'checkin_phone=$32, checkin_reference=$33, checkin_instructions=$34, checkin_tracking=$35, updated_at=NOW() WHERE id=$31',
      [acct.account_id, strOrNull(parsed.account_name), strOrNull(parsed.account_number), cityCode, strOrNull(parsed.po_number), strOrNull(parsed.wo_number),
       strOrNull(parsed.store_name), strOrNull(parsed.store_number), strOrNull(parsed.address), strOrNull(parsed.city_state_zip), strOrNull(parsed.service_requested),
       strOrNull(parsed.service_requested_by), strOrNull(parsed.contact_name), strOrNull(parsed.contact_phone), dateOrNull(parsed.needed_by), strOrNull(parsed.notes),
       JSON.stringify(parsed), strOrNull(parsed.confidence),
       jobType, strOrNull(parsed.claim_id), woJob.normalizeVin(parsed.vin), strOrNull(parsed.vehicle_year),
       strOrNull(parsed.vehicle_make), strOrNull(parsed.vehicle_model), strOrNull(parsed.vehicle_mileage),
       strOrNull(parsed.repair_code), strOrNull(parsed.yard_name), strOrNull(parsed.bay_location),
       strOrNull(parsed.special_instructions),
       // A re-parse re-reads the SAME form, so it may only fill an empty NTE — it must never
       // stomp a limit a manager set by hand or one a later revision raised.
       (ex.nte_amount !== null && ex.nte_amount !== undefined) ? ex.nte_amount : woJob.moneyOrNull(parsed.nte_amount),
       req.params.id,
       strOrNull(parsed.checkin_phone), strOrNull(parsed.checkin_reference), strOrNull(parsed.checkin_instructions),
       strOrNull(parsed.checkin_tracking)]
    );
    // Re-parsing the back catalogue is how the required / not-required answer
    // gets filled in for jobs that arrived before the parser knew to ask.
    try { await saveCheckinRequirement(pool, req.params.id, parsed, ex.email_body || ''); }
    catch (e) { console.error('[work-orders] check-in requirement: ' + e.message); }
    // A re-parse that works has to lift the row back out of the hole it fell into.
    // Leaving it stamped 'error' meant a fixed work order still never reached the queue.
    if (ex.status === 'error' || ex.status === 'rejected') {
      await pool.query("UPDATE work_orders SET status='received', parse_error=NULL, updated_at=NOW() WHERE id=$1", [req.params.id]);
      await woJob.addActivity(req.params.id, req.user, 'event', 'moved back to Received after a successful re-parse (was ' + ex.status + ')');
    }
    await woJob.addActivity(req.params.id, req.user, 'event', 're-parsed with AI as a ' + jobType + ' job');
    if (jobType === 'vehicle' && !woJob.normalizeVin(parsed.vin)) {
      await woJob.addActivity(req.params.id, req.user, 'event', 'no VIN could be read from this work order — check the attached form');
    }
    res.json(await loadWorkOrder(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to reparse' }); }
});

// DELETE /api/work-orders/:id (manage)
router.delete('/:id', requireAuth, requirePermission('manage_work_orders'), async (req, res) => {
  try {
    const ex = (await pool.query('SELECT wo_ref, email_message_id FROM work_orders WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Work order not found' });
    // Remember the email, or the next mailbox poll simply recreates the row: dedup keys
    // on email_message_id, and the message is still sitting in the lookback window.
    if (ex.email_message_id) {
      try {
        await pool.query(
          "INSERT INTO work_order_dead_emails (email_message_id, wo_ref, reason, deleted_by, deleted_by_name) " +
          "VALUES ($1,$2,'deleted',$3,$4) ON CONFLICT (email_message_id) DO NOTHING",
          [ex.email_message_id, ex.wo_ref || null, req.user.id, req.user.name]
        );
      } catch (e) { console.error('[work-orders] tombstone write failed:', e.message); }
    }
    await pool.query('DELETE FROM work_orders WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'work_order', entity_id: parseInt(req.params.id), entity_number: ex.wo_ref, action: 'deleted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete work order' }); }
});

module.exports = router;
