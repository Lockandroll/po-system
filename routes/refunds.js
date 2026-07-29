const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');
const permissions = require('../utils/permissions');

const router = express.Router();

// ---------------------------------------------------------------------------
// Invoice refunds.
//
// A refund is NEVER an edit to the invoice. Every refund is an append-only row
// in invoice_refunds, so the signed original the customer agreed to stays byte
// for byte what it was — which is exactly what the Square dispute packet leans
// on. The invoice's own numbers are left alone; refunded_total is a derived
// running total and the customer-facing "net" is grand_total - refunded_total.
//
// Lifecycle (deliberately shaped like a purchase order):
//   requested -> approved -> processed
//        \-> rejected            \-> voided (reversal, admin only)
//
// Anyone who can create an invoice may REQUEST a refund on one; only a manager
// or above (approve_refund) may approve it. Money never moves inside Nova:
// Square is record-only for now, so 'processed' is the human step where someone
// issues the refund in Square and pastes the reference back here. An approved
// refund that is never processed shows up in its own queue rather than quietly
// disappearing.
//
// The invoice's refunded_total counts APPROVED and PROCESSED refunds (a manager
// saying yes is the moment the money is committed), while pending requests are
// still reserved against the invoice so two people cannot each request the last
// dollar. NO BACKTICKS in this file — Windows corrupts them (see CLAUDE notes).
// ---------------------------------------------------------------------------

var REASONS = [
  'overcharge',
  'service_not_completed',
  'warranty',
  'duplicate_charge',
  'goodwill',
  'chargeback_settled',
  'tax_correction'
];

var REASON_LABELS = {
  overcharge: 'Overcharge / price adjustment',
  service_not_completed: 'Service not completed',
  warranty: 'Warranty / comeback',
  duplicate_charge: 'Duplicate charge',
  goodwill: 'Customer goodwill',
  chargeback_settled: 'Chargeback settled',
  tax_correction: 'Tax correction'
};

var METHODS = ['card', 'cash', 'check', 'other'];

var METHOD_LABELS = {
  card: 'Back to card',
  cash: 'Cash',
  check: 'Check',
  other: 'Other'
};

// Statuses that hold money against the invoice.
var COMMITTED = ['approved', 'processed'];
// Statuses that reserve money (committed + still waiting on a manager).
var RESERVED = ['requested', 'approved', 'processed'];

function money(n) {
  var v = parseFloat(n);
  if (!isFinite(v)) v = 0;
  return Math.round(v * 100) / 100;
}

function fmt(n) {
  return '$' + money(n).toFixed(2);
}

function canSeeAll(role) {
  return role === 'admin' || role === 'manager' || role === 'owner';
}

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + (path || '');
}

function reasonLabel(code) {
  return REASON_LABELS[code] || code || '—';
}

function methodLabel(code) {
  return METHOD_LABELS[code] || code || '—';
}

var REFUND_SELECT =
  'SELECT r.*, ' +
  '       i.invoice_number, i.grand_total, i.customer_name, i.city_code, i.account_name, ' +
  '       i.pay_type, i.card_last4, i.email AS customer_email, i.invoice_date, ' +
  '       i.labor_amount, i.parts_amount, i.tax_amount, i.tip_amount, i.refunded_total, i.status AS invoice_status, ' +
  '       req.name AS requested_by_name, app.name AS approved_by_name, proc.name AS processed_by_name ' +
  'FROM invoice_refunds r ' +
  'JOIN invoices i ON r.invoice_id = i.id ' +
  'LEFT JOIN users req ON r.requested_by = req.id ' +
  'LEFT JOIN users app ON r.approved_by = app.id ' +
  'LEFT JOIN users proc ON r.processed_by = proc.id ';

// Recompute invoices.refunded_total + status from the refund ledger. Called
// inside the same transaction as every state change so the invoice can never
// drift from its refunds.
async function syncInvoice(client, invoiceId) {
  const inv = (await client.query('SELECT id, status, status_before_refund, grand_total FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
  if (!inv) return null;
  const sum = (await client.query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('approved', 'processed')",
    [invoiceId]
  )).rows[0];
  var refunded = money(sum.total);
  var grand = money(inv.grand_total);
  var status = inv.status;
  var before = inv.status_before_refund;

  if (refunded > 0) {
    // Remember what the invoice was before its first refund so a void can put
    // it back exactly, rather than guessing 'paid'.
    if (!before && ['partially_refunded', 'refunded'].indexOf(inv.status) === -1) before = inv.status;
    status = (refunded >= grand - 0.005) ? 'refunded' : 'partially_refunded';
  } else {
    status = before || (['partially_refunded', 'refunded'].indexOf(inv.status) !== -1 ? 'paid' : inv.status);
    before = null;
  }

  await client.query(
    'UPDATE invoices SET refunded_total = $1, status = $2, status_before_refund = $3, updated_at = NOW() WHERE id = $4',
    [refunded, status, before, invoiceId]
  );
  return { refunded_total: refunded, status: status, grand_total: grand };
}

// How much of this invoice is already spoken for (approved, processed, or still
// sitting in someone's approval queue).
async function reservedTotal(client, invoiceId, excludeRefundId) {
  var sql =
    "SELECT COALESCE(SUM(amount), 0) AS total FROM invoice_refunds " +
    "WHERE invoice_id = $1 AND status IN ('requested', 'approved', 'processed')";
  var params = [invoiceId];
  if (excludeRefundId) { sql += ' AND id <> $2'; params.push(excludeRefundId); }
  const r = await client.query(sql, params);
  return money(r.rows[0].total);
}

// Split a refund across labor / parts / tax / tip in the same proportion the
// invoice itself was built. Sales tax has to come back at the right rate or the
// monthly remittance is wrong, so this is the default rather than an option.
function autoAllocate(inv, amount) {
  var labor = money(inv.labor_amount);
  var parts = money(inv.parts_amount);
  var tax = money(inv.tax_amount);
  var tip = money(inv.tip_amount);
  var grand = labor + parts + tax + tip;
  var amt = money(amount);
  if (grand <= 0) return { labor: amt, parts: 0, tax: 0, tip: 0 };
  var share = amt / grand;
  var a = {
    labor: money(labor * share),
    parts: money(parts * share),
    tax: money(tax * share),
    tip: money(tip * share)
  };
  // Push any rounding crumb onto the largest bucket so the parts always add up.
  var diff = money(amt - (a.labor + a.parts + a.tax + a.tip));
  if (diff !== 0) {
    var biggest = 'labor';
    ['parts', 'tax', 'tip'].forEach(function (k) { if (a[k] > a[biggest]) biggest = k; });
    a[biggest] = money(a[biggest] + diff);
  }
  return a;
}

function pickAllocation(body, inv, amount) {
  var hasManual = ['labor_refunded', 'parts_refunded', 'tax_refunded', 'tip_refunded'].some(function (k) {
    return body[k] !== undefined && body[k] !== null && body[k] !== '';
  });
  if (!hasManual) return autoAllocate(inv, amount);
  return {
    labor: money(body.labor_refunded),
    parts: money(body.parts_refunded),
    tax: money(body.tax_refunded),
    tip: money(body.tip_refunded)
  };
}

// Refund numbers read as "the second refund on invoice 10432" at a glance.
async function nextRefundNumber(client, invoiceId, invoiceNumber) {
  const r = await client.query('SELECT COUNT(*)::int AS n FROM invoice_refunds WHERE invoice_id = $1', [invoiceId]);
  return String(invoiceNumber) + '-R' + (r.rows[0].n + 1);
}

function refundId(req, res) {
  var id = parseInt(req.params.id, 10);
  if (!id || String(id) !== String(req.params.id).trim()) {
    res.status(404).json({ error: 'Refund not found' });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// List refunds. Approvers see everything; everyone else sees only what they
// asked for themselves.
router.get('/', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const approver = await permissions.hasPermission(req.user.role, 'approve_refund');
    var where = [];
    var params = [];
    if (!approver && !canSeeAll(req.user.role)) {
      params.push(req.user.id);
      where.push('r.requested_by = $' + params.length);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push('r.status = $' + params.length);
    }
    if (req.query.invoice_id) {
      params.push(parseInt(req.query.invoice_id, 10));
      where.push('r.invoice_id = $' + params.length);
    }
    const sql = REFUND_SELECT + (where.length ? ('WHERE ' + where.join(' AND ') + ' ') : '') + 'ORDER BY r.created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(function (r) {
      r.reason_label = reasonLabel(r.reason_code);
      r.method_label = methodLabel(r.method);
      return r;
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch refunds' });
  }
});

// Rolled-up counters for the Refunds screen tiles.
router.get('/summary', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const q = await pool.query(
      "SELECT " +
      "  COUNT(*) FILTER (WHERE status = 'requested')::int AS pending_count, " +
      "  COUNT(*) FILTER (WHERE status = 'approved')::int AS awaiting_count, " +
      "  COALESCE(SUM(amount) FILTER (WHERE status IN ('approved','processed') AND refund_date >= date_trunc('month', CURRENT_DATE)), 0) AS month_amount " +
      "FROM invoice_refunds"
    );
    const inv = await pool.query(
      "SELECT COALESCE(SUM(grand_total), 0) AS total FROM invoices WHERE invoice_date >= date_trunc('month', CURRENT_DATE)"
    );
    var monthAmount = money(q.rows[0].month_amount);
    var invoiced = money(inv.rows[0].total);
    res.json({
      pending_count: q.rows[0].pending_count,
      awaiting_count: q.rows[0].awaiting_count,
      month_amount: monthAmount,
      month_invoiced: invoiced,
      month_rate: invoiced > 0 ? Math.round((monthAmount / invoiced) * 1000) / 10 : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build the refund summary' });
  }
});

router.get('/:id', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  const rid = refundId(req, res);
  if (!rid) return;
  try {
    const { rows } = await pool.query(REFUND_SELECT + 'WHERE r.id = $1', [rid]);
    if (!rows.length) return res.status(404).json({ error: 'Refund not found' });
    const r = rows[0];
    const approver = await permissions.hasPermission(req.user.role, 'approve_refund');
    if (!approver && !canSeeAll(req.user.role) && r.requested_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    r.reason_label = reasonLabel(r.reason_code);
    r.method_label = methodLabel(r.method);
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch refund' });
  }
});

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

router.post('/', requireAuth, requirePermission('request_refund'), async (req, res) => {
  const b = req.body || {};
  const invoiceId = parseInt(b.invoice_id, 10);
  if (!invoiceId) return res.status(400).json({ error: 'An invoice is required.' });

  const amount = money(b.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter a refund amount greater than zero.' });

  const reason = REASONS.indexOf(b.reason_code) !== -1 ? b.reason_code : null;
  if (!reason) return res.status(400).json({ error: 'Choose a reason for this refund.' });
  const notes = (b.reason_notes || '').trim();
  if (reason === 'goodwill' && !notes) {
    return res.status(400).json({ error: 'A goodwill refund needs a note explaining it.' });
  }
  const method = METHODS.indexOf(b.method) !== -1 ? b.method : 'card';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inv = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }

    // A tech may only request against their own invoice; managers can act on any.
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Access denied' });
    }
    if (inv.status === 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A draft invoice has not been paid, so there is nothing to refund. Delete or edit it instead.' });
    }

    const reserved = await reservedTotal(client, invoiceId);
    const room = money(money(inv.grand_total) - reserved);
    if (amount > room + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'That is more than is left on this invoice. ' + fmt(room) + ' of ' + fmt(inv.grand_total) + ' is still refundable' +
               (reserved > 0 ? (' (' + fmt(reserved) + ' is already refunded or waiting on approval).') : '.')
      });
    }

    const alloc = pickAllocation(b, inv, amount);
    const refundNumber = await nextRefundNumber(client, invoiceId, inv.invoice_number);
    const ins = await client.query(
      'INSERT INTO invoice_refunds (invoice_id, refund_number, amount, labor_refunded, parts_refunded, tax_refunded, tip_refunded, ' +
      'method, reason_code, reason_notes, status, requested_by, requested_at, refund_date) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',$11,NOW(),CURRENT_DATE) RETURNING *",
      [invoiceId, refundNumber, amount, alloc.labor, alloc.parts, alloc.tax, alloc.tip, method, reason, notes || null, req.user.id]
    );
    await client.query('COMMIT');
    const refund = ins.rows[0];

    try {
      await logAudit({
        entity_type: 'refund', entity_id: refund.id, entity_number: refundNumber, action: 'requested',
        user_id: req.user.id, user_name: req.user.name,
        details: { invoice: inv.invoice_number, amount: amount, reason: reason }
      });
    } catch (e) {}

    // Tell the approvers, the same way a submitted PO does.
    try {
      const _q = await notify.broadcastRecipients('refund_requested', "role IN ('admin', 'owner', 'manager')");
      await push.sendPushToUsers(_q.userIds, {
        title: 'Refund needs approval',
        body: req.user.name + ' requested ' + fmt(amount) + ' back on invoice #' + inv.invoice_number + '.',
        url: '/'
      });
      if (_q.emails && _q.emails.length) {
        const html = emailTemplate({
          badge: 'Refund requested',
          title: 'A refund is waiting on your approval',
          body: '<strong>' + req.user.name + '</strong> requested a refund of <strong>' + fmt(amount) + '</strong> on invoice #' + inv.invoice_number + '. No money moves until a manager approves it.',
          details: [
            { label: 'Refund #', value: refundNumber },
            { label: 'Invoice #', value: String(inv.invoice_number) },
            { label: 'Customer', value: inv.customer_name || '—' },
            { label: 'Invoice total', value: fmt(inv.grand_total) },
            { label: 'Refund amount', value: fmt(amount) },
            { label: 'Reason', value: reasonLabel(reason) },
            { label: 'Note', value: notes || '—' }
          ],
          buttonText: 'Review Refund',
          buttonUrl: appUrl('/?view=refunds')
        });
        await sendEmail(_q.emails, 'Refund approval needed: ' + refundNumber + ' (' + fmt(amount) + ')', html);
      }
      if (_q.phones && _q.phones.length) {
        await sendSms(_q.phones, 'Lock & Roll: ' + req.user.name + ' requested a ' + fmt(amount) + ' refund on invoice #' + inv.invoice_number + '. Needs approval. ' + appUrl('/?view=refunds'));
      }
    } catch (e) { console.error('Refund request notify failed:', e); }

    res.status(201).json(refund);
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to request the refund: ' + err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Approve / reject
// ---------------------------------------------------------------------------

router.post('/:id/approve', requireAuth, requirePermission('approve_refund'), async (req, res) => {
  const b = req.body || {};
  const rid = refundId(req, res);
  if (!rid) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query('SELECT * FROM invoice_refunds WHERE id = $1 FOR UPDATE', [rid])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Refund not found' }); }
    if (r.status !== 'requested') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That refund is no longer waiting for approval (it is ' + r.status + ').' });
    }
    const inv = (await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [r.invoice_id])).rows[0];
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }

    // A manager may approve for LESS than was asked, never for more.
    var amount = (b.amount === undefined || b.amount === null || b.amount === '') ? money(r.amount) : money(b.amount);
    if (!(amount > 0)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter an approved amount greater than zero.' }); }
    if (amount > money(r.amount) + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You can approve this for less than ' + fmt(r.amount) + ', but not for more. Ask for a new request instead.' });
    }
    const reserved = await reservedTotal(client, r.invoice_id, r.id);
    const room = money(money(inv.grand_total) - reserved);
    if (amount > room + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Only ' + fmt(room) + ' is still refundable on this invoice.' });
    }

    var alloc = pickAllocation(b, inv, amount);
    // Amount changed but the approver did not re-split it — re-derive so the
    // buckets keep adding up to the approved figure.
    var allocSum = money(alloc.labor + alloc.parts + alloc.tax + alloc.tip);
    if (Math.abs(allocSum - amount) > 0.005) alloc = autoAllocate(inv, amount);

    const upd = await client.query(
      "UPDATE invoice_refunds SET status = 'approved', amount = $1, labor_refunded = $2, parts_refunded = $3, tax_refunded = $4, " +
      'tip_refunded = $5, part_returned = $6, approver_note = $7, approved_by = $8, approved_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $9 AND status = 'requested' RETURNING *",
      [amount, alloc.labor, alloc.parts, alloc.tax, alloc.tip, b.part_returned === true, (b.approver_note || '').trim() || null, req.user.id, r.id]
    );
    if (!upd.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'That refund was just updated by someone else. Reload and try again.' });
    }
    const synced = await syncInvoice(client, r.invoice_id);
    await client.query('COMMIT');

    try {
      await logAudit({
        entity_type: 'refund', entity_id: r.id, entity_number: r.refund_number, action: 'approved',
        user_id: req.user.id, user_name: req.user.name,
        details: { invoice: inv.invoice_number, requested: money(r.amount), approved: amount, net: money(money(inv.grand_total) - synced.refunded_total) }
      });
    } catch (e) {}

    try {
      const _ch = await notify.requesterChannels('refund_approved');
      await push.sendPushToUsers([r.requested_by], {
        title: 'Refund approved',
        body: 'Refund ' + r.refund_number + ' for ' + fmt(amount) + ' was approved.',
        url: '/'
      });
      const reqUser = (await pool.query('SELECT name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1', [r.requested_by])).rows[0];
      if (reqUser && _ch.email && reqUser.email && reqUser.receive_emails !== false) {
        const html = emailTemplate({
          badge: 'Refund approved', badgeColor: 'green',
          title: 'Your refund request was approved',
          body: '<strong>' + req.user.name + '</strong> approved refund <strong>' + r.refund_number + '</strong>' +
                (amount < money(r.amount) ? (' for ' + fmt(amount) + ' (you asked for ' + fmt(r.amount) + ')') : '') +
                '. It still has to be issued in Square before the customer sees it.',
          details: [
            { label: 'Refund #', value: r.refund_number },
            { label: 'Invoice #', value: String(inv.invoice_number) },
            { label: 'Approved amount', value: fmt(amount) },
            { label: 'Invoice net after refund', value: fmt(money(inv.grand_total) - synced.refunded_total) }
          ],
          buttonText: 'View Invoice',
          buttonUrl: appUrl('/?view=view-invoice&id=' + inv.id)
        });
        await sendEmail(reqUser.email, 'Refund approved: ' + r.refund_number, html);
      }
      if (reqUser && _ch.sms && reqUser.phone && reqUser.receive_sms) {
        await sendSms(reqUser.phone, 'Lock & Roll: refund ' + r.refund_number + ' (' + fmt(amount) + ') was approved by ' + req.user.name + '.');
      }
    } catch (e) { console.error('Refund approve notify failed:', e); }

    res.json(Object.assign({}, upd.rows[0], { invoice: synced }));
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to approve the refund: ' + err.message });
  } finally {
    client.release();
  }
});

router.post('/:id/reject', requireAuth, requirePermission('approve_refund'), async (req, res) => {
  const rid = refundId(req, res);
  if (!rid) return;
  const reason = ((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Tell the requester why this refund was not approved.' });
  try {
    const r = (await pool.query('SELECT * FROM invoice_refunds WHERE id = $1', [rid])).rows[0];
    if (!r) return res.status(404).json({ error: 'Refund not found' });
    if (r.status !== 'requested') return res.status(409).json({ error: 'That refund is no longer waiting for approval (it is ' + r.status + ').' });

    const upd = await pool.query(
      "UPDATE invoice_refunds SET status = 'rejected', rejection_reason = $1, approved_by = $2, approved_at = NOW(), updated_at = NOW() " +
      "WHERE id = $3 AND status = 'requested' RETURNING *",
      [reason, req.user.id, r.id]
    );
    if (!upd.rowCount) return res.status(409).json({ error: 'That refund was just updated by someone else. Reload and try again.' });

    const inv = (await pool.query('SELECT id, invoice_number FROM invoices WHERE id = $1', [r.invoice_id])).rows[0] || {};
    try {
      await logAudit({
        entity_type: 'refund', entity_id: r.id, entity_number: r.refund_number, action: 'rejected',
        user_id: req.user.id, user_name: req.user.name, details: { invoice: inv.invoice_number, amount: money(r.amount), reason: reason }
      });
    } catch (e) {}

    try {
      const _ch = await notify.requesterChannels('refund_rejected');
      await push.sendPushToUsers([r.requested_by], { title: 'Refund not approved', body: 'Refund ' + r.refund_number + ' was not approved.', url: '/' });
      const reqUser = (await pool.query('SELECT name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1', [r.requested_by])).rows[0];
      if (reqUser && _ch.email && reqUser.email && reqUser.receive_emails !== false) {
        const html = emailTemplate({
          badge: 'Not approved', badgeColor: 'red',
          title: 'Your refund request was not approved',
          body: '<strong>' + req.user.name + '</strong> did not approve refund <strong>' + r.refund_number + '</strong>.',
          details: [
            { label: 'Refund #', value: r.refund_number },
            { label: 'Invoice #', value: String(inv.invoice_number || '') },
            { label: 'Amount', value: fmt(r.amount) },
            { label: 'Reason', value: reason }
          ],
          buttonText: 'View Invoice',
          buttonUrl: appUrl('/?view=view-invoice&id=' + r.invoice_id)
        });
        await sendEmail(reqUser.email, 'Refund not approved: ' + r.refund_number, html);
      }
      if (reqUser && _ch.sms && reqUser.phone && reqUser.receive_sms) {
        await sendSms(reqUser.phone, 'Lock & Roll: refund ' + r.refund_number + ' was not approved by ' + req.user.name + '. Reason: ' + reason);
      }
    } catch (e) { console.error('Refund reject notify failed:', e); }

    res.json(upd.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject the refund' });
  }
});

// ---------------------------------------------------------------------------
// Mark as issued in Square (record-only phase 1)
// ---------------------------------------------------------------------------

router.post('/:id/processed', requireAuth, requirePermission('approve_refund'), async (req, res) => {
  const b = req.body || {};
  const rid = refundId(req, res);
  if (!rid) return;
  const ref = (b.external_ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'Paste the Square refund ID (or the check number) so Nova and Square agree.' });
  try {
    const r = (await pool.query('SELECT * FROM invoice_refunds WHERE id = $1', [rid])).rows[0];
    if (!r) return res.status(404).json({ error: 'Refund not found' });
    if (r.status !== 'approved') return res.status(409).json({ error: 'Only an approved refund can be marked as issued (this one is ' + r.status + ').' });

    var issuedOn = b.refund_date || null;
    const upd = await pool.query(
      "UPDATE invoice_refunds SET status = 'processed', external_ref = $1, processed_by = $2, processed_at = NOW(), " +
      'refund_date = COALESCE($3::date, refund_date), updated_at = NOW() ' +
      "WHERE id = $4 AND status = 'approved' RETURNING *",
      [ref, req.user.id, issuedOn, r.id]
    );
    if (!upd.rowCount) return res.status(409).json({ error: 'That refund was just updated by someone else. Reload and try again.' });

    const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [r.invoice_id])).rows[0] || {};
    try {
      await logAudit({
        entity_type: 'refund', entity_id: r.id, entity_number: r.refund_number, action: 'processed',
        user_id: req.user.id, user_name: req.user.name, details: { invoice: inv.invoice_number, amount: money(r.amount), reference: ref }
      });
    } catch (e) {}

    // Optional customer-facing receipt.
    if (b.email_receipt === true && inv.email) {
      try {
        var net = money(money(inv.grand_total) - money(inv.refunded_total));
        const html = emailTemplate({
          badge: 'Refund issued', badgeColor: 'green',
          title: 'A refund has been issued',
          body: 'A refund of <strong>' + fmt(r.amount) + '</strong> has been issued against invoice #' + inv.invoice_number + '. Depending on your bank, a card refund can take a few business days to appear.',
          details: [
            { label: 'Invoice #', value: String(inv.invoice_number) },
            { label: 'Original total', value: fmt(inv.grand_total) },
            { label: 'Refunded', value: fmt(r.amount) },
            { label: 'Net after refunds', value: fmt(net) },
            { label: 'Method', value: methodLabel(r.method) + (inv.card_last4 && r.method === 'card' ? (' ending ' + inv.card_last4) : '') }
          ],
          footerNote: 'Questions about this refund? Reply to this email and we will help.'
        });
        await sendEmail(inv.email, 'Refund issued on invoice #' + inv.invoice_number, html);
      } catch (e) { console.error('Refund receipt email failed:', e); }
    }

    res.json(upd.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record the refund' });
  }
});

// ---------------------------------------------------------------------------
// Void (reversal)
// ---------------------------------------------------------------------------
// Refund rows are immutable by design. Voiding does not delete anything: it
// flips the row to 'voided' with a reason, releases the money back to the
// invoice, and leaves the whole history readable. Admin only.
router.post('/:id/void', requireAuth, async (req, res) => {
  if (['admin', 'owner'].indexOf(req.user.role) === -1) {
    return res.status(403).json({ error: 'Only an admin can void a refund.' });
  }
  const rid = refundId(req, res);
  if (!rid) return;
  const reason = ((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A void needs a reason for the audit trail.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = (await client.query('SELECT * FROM invoice_refunds WHERE id = $1 FOR UPDATE', [rid])).rows[0];
    if (!r) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Refund not found' }); }
    if (['approved', 'processed'].indexOf(r.status) === -1) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Only an approved or issued refund can be voided (this one is ' + r.status + ').' });
    }
    await client.query(
      "UPDATE invoice_refunds SET status = 'voided', void_reason = $1, voided_by = $2, voided_at = NOW(), updated_at = NOW() WHERE id = $3",
      [reason, req.user.id, r.id]
    );
    const synced = await syncInvoice(client, r.invoice_id);
    await client.query('COMMIT');

    try {
      await logAudit({
        entity_type: 'refund', entity_id: r.id, entity_number: r.refund_number, action: 'voided',
        user_id: req.user.id, user_name: req.user.name, details: { amount: money(r.amount), reason: reason }
      });
    } catch (e) {}

    res.json({ ok: true, invoice: synced });
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    console.error(err);
    res.status(500).json({ error: 'Failed to void the refund' });
  } finally {
    client.release();
  }
});

module.exports = router;