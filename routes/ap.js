const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const ap = require('../utils/ap');
const r2 = require('../utils/r2');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Accounts Payable
// ---------------------------------------------------------------------------
// Bills WE owe. A bill is entered, tracked to a due date, and marked paid; a job
// (jobs/ap.js) raises a normal task a few days before each one is due, so the
// place people chase a payment is the same task list they already live in.
//
// Mirrors routes/ar.js in shape and house style: string concatenation, the same
// tiny money/date coercers, requireAuth + requirePermission on every route, and
// logAudit on anything that touches money or a due date. Ships dark behind
// view_ap / manage_ap (utils/permissions.js) until an admin turns it on.
// ---------------------------------------------------------------------------

const s = ap.s;
const money = ap.money;
const ymd = ap.ymd;

// Every knob goes in the settings table, not a constant (CLAUDE.md 9), so the
// reminder lead time and who unassigned reminders land on can change without a
// deploy. Lead days is clamped 0-30: 0 means "the morning it is due", and a
// month of lead is already absurd.
async function getApSettings() {
  const r = await pool.query(
    "SELECT key, value FROM settings WHERE key IN ('ap_reminder_user_id','ap_reminder_lead_days')");
  const map = {};
  r.rows.forEach(function (x) { map[x.key] = x.value; });
  var lead = parseInt(map.ap_reminder_lead_days, 10);
  if (!isFinite(lead) || lead < 0 || lead > 30) lead = 3;
  var uid = parseInt(map.ap_reminder_user_id, 10);
  if (!isFinite(uid)) uid = null;
  return { reminder_user_id: uid, reminder_lead_days: lead };
}
async function setSetting(key, value) {
  await pool.query(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()', [key, value]);
}

// ---------------------------------------------------------------------------
//  Meta - one call the screen uses to fill its dropdowns
// ---------------------------------------------------------------------------
// A payee can be an existing vendor OR free text, and a bill can be assigned to
// any active user. Both lists are returned here rather than making the AP screen
// depend on the vendors/users modules (whose own permissions an AP clerk may not
// have).
router.get('/meta', requireAuth, requirePermission('view_ap'), async function (req, res) {
  const users = await pool.query('SELECT id, name FROM users WHERE active = true ORDER BY name');
  const vendors = await pool.query('SELECT id, name FROM vendors ORDER BY name');
  res.json({
    users: users.rows,
    vendors: vendors.rows,
    settings: await getApSettings(),
    categories: ap.CATEGORIES,
    methods: ap.METHODS
  });
});

// ---------------------------------------------------------------------------
//  List + summary
// ---------------------------------------------------------------------------
router.get('/bills', requireAuth, requirePermission('view_ap'), async function (req, res) {
  const today = (await pool.query('SELECT CURRENT_DATE::text AS d')).rows[0].d;
  const status = String(req.query.status || 'open').toLowerCase();
  const params = [];
  const where = [];

  if (status === 'open') where.push("b.status IN ('unpaid','review')");
  else if (status === 'overdue') { where.push("b.status = 'unpaid'"); where.push('b.due_date < CURRENT_DATE'); }
  else if (['unpaid', 'paid', 'review', 'void'].indexOf(status) !== -1) {
    params.push(status); where.push('b.status = $' + params.length);
  } else if (status !== 'all') where.push("b.status <> 'void'");

  if (req.query.vendor_id) { params.push(parseInt(req.query.vendor_id, 10) || -1); where.push('b.vendor_id = $' + params.length); }
  if (req.query.q && String(req.query.q).trim()) {
    params.push('%' + String(req.query.q).trim() + '%');
    const p = '$' + params.length;
    where.push('(b.payee ILIKE ' + p + ' OR b.bill_number ILIKE ' + p + ' OR b.description ILIKE ' + p + ' OR v.name ILIKE ' + p + ')');
  }
  const from = ymd(req.query.from, null);
  if (from) { params.push(from); where.push('b.due_date >= $' + params.length + '::date'); }
  const to = ymd(req.query.to, null);
  if (to) { params.push(to); where.push('b.due_date <= $' + params.length + '::date'); }

  const sql =
    'SELECT b.*, v.name AS vendor_name, u.name AS assignee_name, COALESCE(ac.n,0) AS attachment_count ' +
    'FROM ap_bills b ' +
    'LEFT JOIN vendors v ON v.id = b.vendor_id ' +
    'LEFT JOIN users u ON u.id = b.assigned_to ' +
    'LEFT JOIN (SELECT bill_id, COUNT(*)::int AS n FROM ap_bill_attachments GROUP BY bill_id) ac ON ac.bill_id = b.id ' +
    (where.length ? ('WHERE ' + where.join(' AND ') + ' ') : '') +
    "ORDER BY CASE b.status WHEN 'review' THEN 0 WHEN 'unpaid' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END, " +
    'b.due_date ASC NULLS LAST, b.id DESC LIMIT 1000';
  const rows = (await pool.query(sql, params)).rows;

  // The summary is over EVERY live bill, not just the filtered page - the point
  // of the top bar is "what do we owe", and that does not change when you filter
  // the list to one vendor.
  const sumRows = (await pool.query("SELECT status, amount, due_date, paid_amount FROM ap_bills WHERE status <> 'void'")).rows;
  const summary = ap.computeSummary(sumRows, { today: today, dueSoonDays: 7 });

  res.json({ bills: rows, summary: summary, today: today, categories: ap.CATEGORIES, methods: ap.METHODS });
});

router.get('/bills/:id', requireAuth, requirePermission('view_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    'SELECT b.*, v.name AS vendor_name, u.name AS assignee_name FROM ap_bills b ' +
    'LEFT JOIN vendors v ON v.id = b.vendor_id LEFT JOIN users u ON u.id = b.assigned_to WHERE b.id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const att = await pool.query(
    'SELECT id, filename, content_type, size_bytes, created_at FROM ap_bill_attachments WHERE bill_id = $1 ORDER BY id', [id]);
  res.json({ bill: r.rows[0], attachments: att.rows });
});

// ---------------------------------------------------------------------------
//  Create
// ---------------------------------------------------------------------------
router.post('/bills', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const b = req.body || {};
  const vendorId = parseInt(b.vendor_id, 10) || null;
  const payee = s(b.payee, 255);
  if (!vendorId && !payee) return res.status(400).json({ error: 'A bill needs a payee, or pick a vendor.' });
  const amount = money(b.amount);
  if (amount === null || amount <= 0) return res.status(400).json({ error: 'A bill needs an amount above zero.' });
  const due = ymd(b.due_date, null);
  if (!due) return res.status(400).json({ error: 'A bill needs a due date - that is the whole point of tracking it.' });

  const recurring = b.recurring === true || b.recurring === 'true';
  const recurrence = recurring ? 'monthly' : null;
  const recDay = recurring ? (ap.clampDom(b.recurrence_day) || ap.clampDom(due.slice(8, 10))) : null;
  const assignedTo = parseInt(b.assigned_to, 10) || null;

  const ins = await pool.query(
    'INSERT INTO ap_bills (vendor_id, payee, bill_number, category, description, amount, bill_date, due_date, ' +
    'status, assigned_to, recurring, recurrence, recurrence_day, source, created_by) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unpaid',$9,$10,$11,$12,'manual',$13) RETURNING id",
    [vendorId, payee, s(b.bill_number, 120), s(b.category, 40), s(b.description, 4000), amount,
      ymd(b.bill_date, null), due, assignedTo, recurring, recurrence, recDay, req.user.id]);
  const id = ins.rows[0].id;
  // A recurring bill is the head of its own chain until proven otherwise.
  if (recurring) await pool.query('UPDATE ap_bills SET series_id = $1 WHERE id = $1 AND series_id IS NULL', [id]);

  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: 'create', user_id: req.user.id, user_name: req.user.name,
    details: { payee: payee || ('vendor#' + vendorId), amount: amount, due: due, recurring: recurring }, ip: req.ip });
  res.json({ ok: true, id: id });
});

// ---------------------------------------------------------------------------
//  Edit (also how an email review-draft is confirmed live)
// ---------------------------------------------------------------------------
router.put('/bills/:id', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const cur = await pool.query('SELECT * FROM ap_bills WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  const bill = cur.rows[0];
  // A paid bill is a record. Editing it silently would rewrite what was paid, so
  // it has to be marked unpaid first.
  if (bill.status === 'paid') return res.status(409).json({ error: 'This bill is marked paid. Mark it unpaid first if you need to change it.' });

  const vendorId = b.vendor_id === undefined ? bill.vendor_id : (parseInt(b.vendor_id, 10) || null);
  const payee = b.payee === undefined ? bill.payee : s(b.payee, 255);
  const amount = b.amount === undefined ? Number(bill.amount) : money(b.amount);
  const due = b.due_date === undefined ? (bill.due_date ? String(bill.due_date).slice(0, 10) : null) : ymd(b.due_date, null);
  const recurring = b.recurring === undefined ? bill.recurring : (b.recurring === true || b.recurring === 'true');
  const recurrence = recurring ? 'monthly' : null;
  const recDay = recurring ? (ap.clampDom(b.recurrence_day) || ap.clampDom(bill.recurrence_day) || (due ? ap.clampDom(due.slice(8, 10)) : null)) : null;
  const assignedTo = b.assigned_to === undefined ? bill.assigned_to : (parseInt(b.assigned_to, 10) || null);

  // Confirming a draft (or any save that asks to go live) has to meet the same
  // bar a manual bill does: a real amount and a real due date.
  const goingLive = bill.status === 'review' && (b.status === 'unpaid' || b.confirm === true);
  const newStatus = goingLive ? 'unpaid' : bill.status;
  if (newStatus === 'unpaid') {
    if (amount === null || amount <= 0) return res.status(400).json({ error: 'A bill needs an amount above zero before it goes live.' });
    if (!due) return res.status(400).json({ error: 'A bill needs a due date before it goes live.' });
    if (!vendorId && !payee) return res.status(400).json({ error: 'A bill needs a payee, or pick a vendor.' });
  }

  // Merge: a field that was not sent keeps its stored value; a field sent empty
  // clears it. The frontend sends the whole set, but this keeps the API honest
  // for partial updates too.
  const billNumber = b.bill_number === undefined ? bill.bill_number : s(b.bill_number, 120);
  const category = b.category === undefined ? bill.category : s(b.category, 40);
  const description = b.description === undefined ? bill.description : s(b.description, 4000);
  const billDate = b.bill_date === undefined ? (bill.bill_date ? String(bill.bill_date).slice(0, 10) : null) : ymd(b.bill_date, null);

  await pool.query(
    'UPDATE ap_bills SET vendor_id=$1, payee=$2, bill_number=$3, category=$4, description=$5, amount=$6, ' +
    'bill_date=$7, due_date=$8, assigned_to=$9, recurring=$10, recurrence=$11, recurrence_day=$12, status=$13, updated_at=NOW() ' +
    'WHERE id=$14',
    [vendorId, payee, billNumber, category, description, amount === null ? 0 : amount,
      billDate, due, assignedTo, recurring, recurrence, recDay, newStatus, id]);
  if (recurring) await pool.query('UPDATE ap_bills SET series_id = $1 WHERE id = $1 AND series_id IS NULL', [id]);

  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: goingLive ? 'confirm' : 'update', user_id: req.user.id, user_name: req.user.name,
    details: { amount: amount, due: due, status: newStatus }, ip: req.ip });
  res.json({ ok: true, status: newStatus });
});

// ---------------------------------------------------------------------------
//  Mark paid  (and spawn the next one if this bill recurs)
// ---------------------------------------------------------------------------
router.post('/bills/:id/pay', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const client = await pool.connect();
  var nextId = null;
  var paidAmt = null;
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT * FROM ap_bills WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const bill = cur.rows[0];
    if (bill.status === 'paid') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That bill is already marked paid.' }); }
    if (bill.status === 'void') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That bill was voided.' }); }

    const amtIn = money(b.amount);
    paidAmt = amtIn === null ? Number(bill.amount) : amtIn;
    const method = ap.METHODS.indexOf(b.method) === -1 ? 'other' : b.method;

    await client.query(
      "UPDATE ap_bills SET status='paid', paid_on=COALESCE($1::date, CURRENT_DATE), paid_amount=$2, " +
      'paid_method=$3, paid_reference=$4, updated_at=NOW() WHERE id=$5',
      [ymd(b.paid_on, null), paidAmt, method, s(b.reference, 120), id]);

    // Recurring: the next month's bill appears the moment this one is paid, so it
    // is already on the board before it comes due. spawned_next makes this happen
    // exactly once even if the bill is later un-paid and paid again.
    if (bill.recurring && !bill.spawned_next && bill.due_date) {
      const nd = ap.nextMonthlyDue(String(bill.due_date).slice(0, 10), bill.recurrence_day);
      if (nd) {
        const seriesId = bill.series_id || bill.id;
        const ins = await client.query(
          'INSERT INTO ap_bills (vendor_id, payee, bill_number, category, description, amount, due_date, ' +
          'status, assigned_to, recurring, recurrence, recurrence_day, series_id, source, created_by) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid',$8,true,$9,$10,$11,'manual',$12) RETURNING id",
          [bill.vendor_id, bill.payee, bill.bill_number, bill.category, bill.description, bill.amount, nd,
            bill.assigned_to, bill.recurrence || 'monthly', bill.recurrence_day, seriesId, req.user.id]);
        nextId = ins.rows[0].id;
        await client.query('UPDATE ap_bills SET spawned_next=true, series_id=COALESCE(series_id,$2) WHERE id=$1', [id, seriesId]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: 'pay', user_id: req.user.id, user_name: req.user.name,
    details: { amount: paidAmt, next_bill_id: nextId }, ip: req.ip });
  res.json({ ok: true, next_bill_id: nextId });
});

// Undo a mark-paid. Deliberately leaves spawned_next alone: the next month's
// bill has already been created and may have its own history, so re-paying must
// not create a second one.
router.post('/bills/:id/unpay', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "UPDATE ap_bills SET status='unpaid', paid_on=NULL, paid_amount=NULL, paid_method=NULL, paid_reference=NULL, " +
    "updated_at=NOW() WHERE id=$1 AND status='paid' RETURNING id", [id]);
  if (!r.rows.length) return res.status(409).json({ error: 'That bill is not marked paid.' });
  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: 'unpay', user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

// Void keeps the record; only an unpaid bill or a draft can be voided (a paid one
// is unpaid first). A reason is asked for because a voided bill is a question
// somebody asks later.
router.post('/bills/:id/void', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = s(req.body && req.body.reason, 500);
  const r = await pool.query(
    "UPDATE ap_bills SET status='void', updated_at=NOW() WHERE id=$1 AND status IN ('unpaid','review') RETURNING payee, amount", [id]);
  if (!r.rows.length) return res.status(409).json({ error: 'Not found, or it is already paid - mark it unpaid before voiding.' });
  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: 'void', user_id: req.user.id, user_name: req.user.name,
    details: { reason: reason, amount: r.rows[0].amount }, ip: req.ip });
  res.json({ ok: true });
});

// Hard delete is only for a draft or an unpaid bill entered in error. A paid bill
// is a record and is voided, never deleted, so the ledger never jumps with
// nothing to explain it.
router.delete('/bills/:id', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT status, reminder_task_id FROM ap_bills WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  if (['review', 'unpaid'].indexOf(r.rows[0].status) === -1) {
    return res.status(409).json({ error: 'Only a draft or an unpaid bill can be deleted. Void a paid bill instead so the record stays.' });
  }
  const keys = await pool.query('SELECT r2_key FROM ap_bill_attachments WHERE bill_id = $1', [id]);
  for (var i = 0; i < keys.rows.length; i++) {
    try { if (r2.configured()) await r2.deleteObject(keys.rows[i].r2_key); } catch (e) { /* orphan object is harmless */ }
  }
  // Take the "please pay this" task with it, so a deleted bill leaves no ghost task.
  if (r.rows[0].reminder_task_id) { try { await pool.query('DELETE FROM tasks WHERE id = $1', [r.rows[0].reminder_task_id]); } catch (e) {} }
  await pool.query('DELETE FROM ap_bills WHERE id = $1', [id]); // ON DELETE CASCADE clears attachment rows
  await logAudit({ entity_type: 'ap_bill', entity_id: id, action: 'delete', user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Attachments (bytes go browser<->R2 direct via presigned URLs)
// ---------------------------------------------------------------------------
router.post('/bills/:id/attachments/upload-url', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const exists = await pool.query('SELECT id FROM ap_bills WHERE id = $1', [id]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Not found' });
  if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
  const b = req.body || {};
  const fname = s(b.filename, 255) || 'bill';
  const ctype = s(b.content_type, 120) || 'application/octet-stream';
  const key = 'ap-bills/' + id + '/' + Date.now() + '-' + fname.replace(/[^A-Za-z0-9._-]/g, '_');
  const url = await r2.presignUpload(key, ctype);
  res.json({ ok: true, url: url, key: key, filename: fname, content_type: ctype });
});

router.post('/bills/:id/attachments/confirm', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const key = s(b.key, 500);
  // The key must be one WE handed out for THIS bill - never trust a client to
  // name where a file lives.
  if (!key || key.indexOf('ap-bills/' + id + '/') !== 0) return res.status(400).json({ error: 'Bad upload key.' });
  const ins = await pool.query(
    'INSERT INTO ap_bill_attachments (bill_id, r2_key, filename, content_type, size_bytes, uploaded_by) ' +
    'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, filename, content_type, size_bytes, created_at',
    [id, key, s(b.filename, 255), s(b.content_type, 120), parseInt(b.size_bytes, 10) || null, req.user.id]);
  res.json({ ok: true, attachment: ins.rows[0] });
});

router.get('/attachments/:id/download', requireAuth, requirePermission('view_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT r2_key, filename, content_type FROM ap_bill_attachments WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
  const url = await r2.presignDownload(r.rows[0].r2_key, r.rows[0].filename || 'bill', true, 300, r.rows[0].content_type || undefined);
  res.json({ ok: true, url: url });
});

router.delete('/attachments/:id', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query('SELECT bill_id, r2_key, filename FROM ap_bill_attachments WHERE id = $1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  try { if (r2.configured()) await r2.deleteObject(r.rows[0].r2_key); } catch (e) { /* orphan object is harmless */ }
  await pool.query('DELETE FROM ap_bill_attachments WHERE id = $1', [id]);
  await logAudit({ entity_type: 'ap_bill', entity_id: r.rows[0].bill_id, action: 'attachment_delete', user_id: req.user.id, user_name: req.user.name,
    details: { filename: r.rows[0].filename }, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Settings
// ---------------------------------------------------------------------------
router.post('/settings', requireAuth, requirePermission('manage_ap'), async function (req, res) {
  const b = req.body || {};
  var lead = parseInt(b.reminder_lead_days, 10);
  if (!isFinite(lead) || lead < 0 || lead > 30) lead = 3;
  var uid = parseInt(b.reminder_user_id, 10);
  const uidVal = isFinite(uid) ? String(uid) : '';
  await setSetting('ap_reminder_lead_days', String(lead));
  await setSetting('ap_reminder_user_id', uidVal);
  await logAudit({ entity_type: 'settings', entity_id: 0, action: 'ap_settings', user_id: req.user.id, user_name: req.user.name,
    details: { reminder_lead_days: lead, reminder_user_id: uidVal || null }, ip: req.ip });
  res.json({ ok: true, settings: { reminder_user_id: uidVal ? parseInt(uidVal, 10) : null, reminder_lead_days: lead } });
});

module.exports = router;
