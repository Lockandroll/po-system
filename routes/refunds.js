const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');
const permissions = require('../utils/permissions');
const square = require('../utils/square');

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
// or above (approve_refund) may approve it. An approved refund that is never
// issued shows up in its own queue rather than quietly disappearing.
//
// There are two ways an approved refund becomes 'processed':
//
//   POST /:id/send-to-square  -> Nova calls the Square Refunds API and the money
//                                actually moves. Card refunds on invoices that
//                                were settled through Square in Nova.
//   POST /:id/processed       -> a human issued it somewhere else (cash, check,
//                                the Square dashboard, a refund Square refused)
//                                and pastes the reference in.
//
// Both routes exist on purpose and neither replaces the other. The manual path
// is the fallback for every case the API cannot cover, so a failed API call can
// never strand a customer's money.
//
// Once Square has accepted a refund it CANNOT be undone, which is why the void
// route below refuses to touch one.
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
  '       req.name AS requested_by_name, app.name AS approved_by_name, proc.name AS processed_by_name, ' +
  '       sp.square_payment_id AS settled_square_payment_id, sp.card_last4 AS settled_card_last4, ' +
  // Square puts the refund on the PAYMENT's receipt, so fall back to the
  // payment row when the refund did not capture its own copy (webhook-settled
  // rows, and every refund issued before square_receipt_url existed).
  '       COALESCE(r.square_receipt_url, sp.receipt_url) AS square_receipt_url_eff, ' +
  '       sp.total_cents AS settled_total_cents, sp.tip_cents AS settled_tip_cents ' +
  'FROM invoice_refunds r ' +
  'JOIN invoices i ON r.invoice_id = i.id ' +
  'LEFT JOIN users req ON r.requested_by = req.id ' +
  'LEFT JOIN users app ON r.approved_by = app.id ' +
  'LEFT JOIN users proc ON r.processed_by = proc.id ' +
  // The Square payment this invoice was actually settled with, if any. Drives
  // whether the screen offers "Refund in Square" at all — showing that button on
  // an invoice that was never paid through Square just produces a dead end.
  'LEFT JOIN LATERAL (' +
  '  SELECT square_payment_id, card_last4, total_cents, tip_cents, receipt_url FROM invoice_payments ' +
  "  WHERE invoice_id = i.id AND status = 'reconciled' AND square_payment_id IS NOT NULL " +
  '  ORDER BY id DESC LIMIT 1' +
  ') sp ON true ';

// Money is with the customer (or on its way) and cannot be pulled back.
function squareMoneyMoved(r) {
  return !!(r && r.square_refund_id && square.refundLive(r.square_status));
}

// Everything the UI needs to decide what to offer, computed once so the queue,
// the invoice screen and the modal never disagree with each other.
function decorate(r) {
  r.reason_label = reasonLabel(r.reason_code);
  r.method_label = methodLabel(r.method);
  r.square_money_moved = squareMoneyMoved(r);
  r.square_enabled = square.configured();
  r.can_send_to_square =
    r.status === 'approved' &&
    r.method === 'card' &&
    !r.square_money_moved &&
    !!r.settled_square_payment_id &&
    r.square_enabled;
  // Why the button is not there. A manager who expects it and does not see it
  // should not have to guess.
  r.square_blocked_reason = r.can_send_to_square ? null
    : (r.square_money_moved ? null
    : (r.status !== 'approved' ? null
    : (!r.square_enabled ? 'Square is not connected to Nova yet, so this has to be refunded by hand.'
    : (r.method !== 'card' ? ('This refund gives the money back as ' + methodLabel(r.method).toLowerCase() + ', so Square cannot process it.')
    : 'This invoice was not paid through Square in Nova, so there is no Square payment to refund against.'))));
  return r;
}

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
  // The card surcharge is a fifth bucket. It has to be here or the denominator
  // is smaller than what was actually charged, and a full refund would then
  // allocate MORE labor and tax than the invoice ever had — overstating refunded
  // SALES, which is the figure that nets against Pulsar and the tax remittance.
  var surcharge = money(inv.surcharge_amount);
  var grand = labor + parts + tax + tip + surcharge;
  var amt = money(amount);
  if (grand <= 0) return { labor: amt, parts: 0, tax: 0, tip: 0, surcharge: 0 };
  var share = amt / grand;
  var a = {
    labor: money(labor * share),
    parts: money(parts * share),
    tax: money(tax * share),
    tip: money(tip * share),
    surcharge: money(surcharge * share)
  };
  // Push any rounding crumb onto the largest bucket so the parts always add up.
  var diff = money(amt - (a.labor + a.parts + a.tax + a.tip + a.surcharge));
  if (diff !== 0) {
    var biggest = 'labor';
    ['parts', 'tax', 'tip', 'surcharge'].forEach(function (k) { if (a[k] > a[biggest]) biggest = k; });
    a[biggest] = money(a[biggest] + diff);
  }
  return a;
}

function pickAllocation(body, inv, amount) {
  var hasManual = ['labor_refunded', 'parts_refunded', 'tax_refunded', 'tip_refunded', 'surcharge_refunded'].some(function (k) {
    return body[k] !== undefined && body[k] !== null && body[k] !== '';
  });
  if (!hasManual) return autoAllocate(inv, amount);
  return {
    labor: money(body.labor_refunded),
    parts: money(body.parts_refunded),
    tax: money(body.tax_refunded),
    tip: money(body.tip_refunded),
    surcharge: money(body.surcharge_refunded)
  };
}


var MODES = ['line', 'category', 'flat'];

// ---------------------------------------------------------------------------
// Line-item and category refunds
// ---------------------------------------------------------------------------
// Three ways to build a refund, one record at the end of it:
//   line     -> tick actual invoice lines; tax is recomputed on the TAXABLE
//               lines only, which is the whole point (a fob is taxable, the
//               labor to program it is not, so a proportional guess is wrong).
//   category -> give back labor, parts, or both as buckets. Tax follows the
//               taxable share of whatever bucket is refunded.
//   flat     -> one figure split proportionally, for goodwill and price
//               adjustments that do not map to any line.
// Whichever route is used, the stored allocation (labor/parts/tax/tip) has the
// same shape, so the ledger, the queue and the PDFs never need to care.

// Invoice lines plus how much of each has already been given back on a refund
// that is still live (requested, approved or processed).
async function invoiceLinesWithRefunded(client, invoiceId, excludeRefundId) {
  var sql =
    'SELECT li.*, COALESCE(rl.refunded_qty, 0) AS refunded_qty ' +
    'FROM invoice_line_items li ' +
    'LEFT JOIN ( ' +
    '  SELECT l.invoice_line_item_id, SUM(l.quantity) AS refunded_qty ' +
    '  FROM invoice_refund_lines l ' +
    '  JOIN invoice_refunds r ON r.id = l.refund_id ' +
    "  WHERE r.status IN ('requested', 'approved', 'processed')" +
    (excludeRefundId ? ' AND r.id <> $2' : '') +
    '  GROUP BY l.invoice_line_item_id ' +
    ') rl ON rl.invoice_line_item_id = li.id ' +
    'WHERE li.invoice_id = $1 ORDER BY li.position, li.id';
  var params = excludeRefundId ? [invoiceId, excludeRefundId] : [invoiceId];
  const r = await client.query(sql, params);
  return r.rows;
}

// What is left in each bucket after every live refund on this invoice.
async function remainingByBucket(client, inv, excludeRefundId) {
  var sql =
    'SELECT COALESCE(SUM(labor_refunded), 0) AS labor, COALESCE(SUM(parts_refunded), 0) AS parts, ' +
    'COALESCE(SUM(tax_refunded), 0) AS tax, COALESCE(SUM(tip_refunded), 0) AS tip, ' +
    'COALESCE(SUM(surcharge_refunded), 0) AS surcharge ' +
    "FROM invoice_refunds WHERE invoice_id = $1 AND status IN ('requested', 'approved', 'processed')";
  var params = [inv.id];
  if (excludeRefundId) { sql += ' AND id <> $2'; params.push(excludeRefundId); }
  const used = (await client.query(sql, params)).rows[0];
  return {
    labor: money(money(inv.labor_amount) - money(used.labor)),
    parts: money(money(inv.parts_amount) - money(used.parts)),
    tax: money(money(inv.tax_amount) - money(used.tax)),
    tip: money(money(inv.tip_amount) - money(used.tip)),
    surcharge: money(money(inv.surcharge_amount) - money(used.surcharge))
  };
}

// Taxable share of each category, straight off the invoice lines. Used so a
// category refund charges tax back only on the portion that was taxed.
function taxableShares(lines) {
  var tot = { labor: 0, part: 0 };
  var taxed = { labor: 0, part: 0 };
  (lines || []).forEach(function (li) {
    var key = li.line_type === 'labor' ? 'labor' : 'part';
    var ext = (parseFloat(li.quantity) || 0) * (parseFloat(li.unit_price) || 0);
    tot[key] += ext;
    if (li.taxable) taxed[key] += ext;
  });
  return {
    labor: tot.labor > 0 ? (taxed.labor / tot.labor) : 0,
    parts: tot.part > 0 ? (taxed.part / tot.part) : 0
  };
}

// Validate a line-by-line refund against the invoice itself. Quantities and
// prices come from the DB, never from the client, and a line cannot be given
// back twice.
async function buildLineRefund(client, inv, requested, excludeRefundId) {
  const lines = await invoiceLinesWithRefunded(client, inv.id, excludeRefundId);
  const byId = {};
  lines.forEach(function (li) { byId[String(li.id)] = li; });
  var out = [];
  var labor = 0, parts = 0, taxableBase = 0;

  for (var i = 0; i < (requested || []).length; i++) {
    var req = requested[i] || {};
    var li = byId[String(req.invoice_line_item_id)];
    if (!li) return { error: 'One of those lines is not on this invoice any more. Reload the invoice and try again.' };
    var qty = money(req.quantity === undefined || req.quantity === null || req.quantity === '' ? li.quantity : req.quantity);
    if (qty <= 0) continue;
    var available = money(money(li.quantity) - money(li.refunded_qty));
    if (qty > available + 0.005) {
      return {
        error: (li.description || 'A line') + ': only ' + available + ' of ' + money(li.quantity) +
               ' is left to refund' + (money(li.refunded_qty) > 0 ? ' (the rest is already refunded or waiting on approval).' : '.')
      };
    }
    var unit = money(li.unit_price);
    var amount = money(qty * unit);
    if (li.line_type === 'labor') labor += amount; else parts += amount;
    if (li.taxable) taxableBase += amount;
    out.push({
      invoice_line_item_id: li.id,
      line_type: li.line_type === 'labor' ? 'labor' : 'part',
      item_number: li.item_number || null,
      description: li.description,
      quantity: qty,
      unit_price: unit,
      amount: amount,
      taxable: li.taxable === true,
      restock: (li.line_type !== 'labor') && req.restock === true
    });
  }
  if (!out.length) return { error: 'Pick at least one line to refund.' };

  var rate = parseFloat(inv.tax_rate) || 0;
  var tax = inv.tax_exempt === true ? 0 : money(taxableBase * (rate / 100));
  // Never hand back more tax than was collected and not yet returned.
  const room = await remainingByBucket(client, inv, excludeRefundId);
  if (tax > room.tax) tax = room.tax < 0 ? 0 : room.tax;

  return {
    lines: out,
    // Line mode refunds specific line items, so it never returns the tip or the
    // card surcharge. Stated explicitly so alloc.surcharge is never undefined.
    alloc: { labor: money(labor), parts: money(parts), tax: tax, tip: 0, surcharge: 0 },
    amount: money(money(labor) + money(parts) + tax)
  };
}

// Labor / parts buckets, with tax following the taxable share of each.
async function buildCategoryRefund(client, inv, body, excludeRefundId) {
  const room = await remainingByBucket(client, inv, excludeRefundId);
  var labor = money(body.labor_refunded);
  var parts = money(body.parts_refunded);
  var tip = money(body.tip_refunded);
  var surcharge = money(body.surcharge_refunded);
  if (labor < 0 || parts < 0 || tip < 0 || surcharge < 0) return { error: 'A refund amount cannot be negative.' };
  if (labor + parts + tip + surcharge <= 0) return { error: 'Enter a labor amount, a parts amount, or both.' };
  if (labor > room.labor + 0.005) return { error: 'Only ' + fmt(room.labor) + ' of labor is left to refund on this invoice.' };
  if (parts > room.parts + 0.005) return { error: 'Only ' + fmt(room.parts) + ' of parts is left to refund on this invoice.' };
  if (tip > room.tip + 0.005) return { error: 'Only ' + fmt(room.tip) + ' of the tip is left to refund.' };
  if (surcharge > room.surcharge + 0.005) return { error: 'Only ' + fmt(room.surcharge) + ' of the card surcharge is left to refund.' };

  const lines = await invoiceLinesWithRefunded(client, inv.id, excludeRefundId);
  const share = taxableShares(lines);
  var rate = parseFloat(inv.tax_rate) || 0;
  var tax = inv.tax_exempt === true ? 0 : money((labor * share.labor + parts * share.parts) * (rate / 100));
  if (tax > room.tax) tax = room.tax < 0 ? 0 : room.tax;

  return {
    lines: [],
    alloc: { labor: labor, parts: parts, tax: tax, tip: tip, surcharge: surcharge },
    amount: money(labor + parts + tax + tip + surcharge),
    restock_parts: body.restock_parts === true
  };
}

// One entry point: hand it the body, get back a validated amount + allocation
// (+ line rows) whatever mode the user picked.
async function buildRefund(client, inv, body, excludeRefundId) {
  var mode = MODES.indexOf(body.mode) !== -1 ? body.mode : 'flat';
  if (mode === 'line') {
    var built = await buildLineRefund(client, inv, body.lines, excludeRefundId);
    if (built.error) return built;
    built.mode = 'line';
    return built;
  }
  if (mode === 'category') {
    var cat = await buildCategoryRefund(client, inv, body, excludeRefundId);
    if (cat.error) return cat;
    cat.mode = 'category';
    return cat;
  }
  var amount = money(body.amount);
  if (!(amount > 0)) return { error: 'Enter a refund amount greater than zero.' };
  return { mode: 'flat', lines: [], alloc: pickAllocation(body, inv, amount), amount: amount };
}

async function insertRefundLines(client, refundId, lines) {
  for (var i = 0; i < (lines || []).length; i++) {
    var l = lines[i];
    await client.query(
      'INSERT INTO invoice_refund_lines (refund_id, invoice_line_item_id, line_type, item_number, description, quantity, unit_price, amount, taxable, restock) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [refundId, l.invoice_line_item_id, l.line_type, l.item_number, l.description, l.quantity, l.unit_price, l.amount, l.taxable, l.restock]
    );
  }
}

async function loadRefundLines(runner, refundId) {
  try {
    const r = await runner.query('SELECT * FROM invoice_refund_lines WHERE refund_id = $1 ORDER BY id', [refundId]);
    return r.rows;
  } catch (e) { return []; }
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
    const counts = {};
    try {
      const cr = await pool.query('SELECT refund_id, COUNT(*)::int AS n FROM invoice_refund_lines GROUP BY refund_id');
      cr.rows.forEach(function (x) { counts[String(x.refund_id)] = x.n; });
    } catch (e) { /* table may not exist yet on first deploy */ }
    res.json(rows.map(function (r) {
      decorate(r);
      r.line_count = counts[String(r.id)] || 0;
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
    decorate(r);
    r.lines = await loadRefundLines(pool, r.id);
    // What is still refundable per line / per bucket, so the approver's screen
    // can show the same limits the request screen had.
    try {
      const client2 = await pool.connect();
      try {
        const inv = (await client2.query('SELECT * FROM invoices WHERE id = $1', [r.invoice_id])).rows[0];
        if (inv) {
          r.invoice_lines = await invoiceLinesWithRefunded(client2, r.invoice_id, r.id);
          r.remaining = await remainingByBucket(client2, inv, r.id);
        }
      } finally { client2.release(); }
    } catch (e) { /* non-fatal: the modal falls back to the stored values */ }
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

    // By line, by category, or one flat figure — all three come back as the same
    // validated { amount, alloc, lines } shape.
    const built = await buildRefund(client, inv, b);
    if (built.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: built.error }); }
    const amount = built.amount;
    const alloc = built.alloc;

    const reserved = await reservedTotal(client, invoiceId);
    const room = money(money(inv.grand_total) - reserved);
    if (amount > room + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'That is more than is left on this invoice. ' + fmt(room) + ' of ' + fmt(inv.grand_total) + ' is still refundable' +
               (reserved > 0 ? (' (' + fmt(reserved) + ' is already refunded or waiting on approval).') : '.')
      });
    }

    // A category refund carries one restock answer for all the parts in it; a
    // line refund carries the answer per line (held on the line rows).
    const partReturned = built.mode === 'category'
      ? built.restock_parts === true
      : (built.mode === 'line'
          ? built.lines.some(function (l) { return l.restock === true; })
          : b.part_returned === true);

    const refundNumber = await nextRefundNumber(client, invoiceId, inv.invoice_number);
    const ins = await client.query(
      'INSERT INTO invoice_refunds (invoice_id, refund_number, amount, labor_refunded, parts_refunded, tax_refunded, tip_refunded, surcharge_refunded, ' +
      'method, reason_code, reason_notes, mode, part_returned, status, requested_by, requested_at, refund_date) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'requested',$14,NOW(),CURRENT_DATE) RETURNING *",
      [invoiceId, refundNumber, amount, alloc.labor, alloc.parts, alloc.tax, alloc.tip, alloc.surcharge || 0, method, reason, notes || null, built.mode, partReturned, req.user.id]
    );
    await insertRefundLines(client, ins.rows[0].id, built.lines);
    await client.query('COMMIT');
    const refund = ins.rows[0];
    refund.lines = built.lines;

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

    // The approver works in whatever mode the refund was built in. Send nothing
    // and the request is approved exactly as submitted; send the mode's own
    // fields (lines, or labor/parts) and it is re-validated against the invoice.
    var mode = MODES.indexOf(r.mode) !== -1 ? r.mode : 'flat';
    var amount, alloc, newLines = null, partReturned = r.part_returned === true;

    if (mode === 'line' && Array.isArray(b.lines)) {
      var rebuilt = await buildLineRefund(client, inv, b.lines, r.id);
      if (rebuilt.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: rebuilt.error }); }
      amount = rebuilt.amount; alloc = rebuilt.alloc; newLines = rebuilt.lines;
      partReturned = rebuilt.lines.some(function (l) { return l.restock === true; });
    } else if (mode === 'category' && (b.labor_refunded !== undefined || b.parts_refunded !== undefined)) {
      var reCat = await buildCategoryRefund(client, inv, b, r.id);
      if (reCat.error) { await client.query('ROLLBACK'); return res.status(400).json({ error: reCat.error }); }
      amount = reCat.amount; alloc = reCat.alloc;
      partReturned = b.restock_parts === true;
    } else if (mode === 'flat') {
      amount = (b.amount === undefined || b.amount === null || b.amount === '') ? money(r.amount) : money(b.amount);
      alloc = pickAllocation(b, inv, amount);
      // Amount changed but the approver did not re-split it — re-derive so the
      // buckets keep adding up to the approved figure.
      var allocSum = money(alloc.labor + alloc.parts + alloc.tax + alloc.tip + (alloc.surcharge || 0));
      if (Math.abs(allocSum - amount) > 0.005) alloc = autoAllocate(inv, amount);
      if (b.part_returned !== undefined) partReturned = b.part_returned === true;
    } else {
      // Approved exactly as requested (a line or category refund the approver
      // did not touch). The stored allocation is already validated.
      amount = money(r.amount);
      alloc = { labor: money(r.labor_refunded), parts: money(r.parts_refunded), tax: money(r.tax_refunded), tip: money(r.tip_refunded), surcharge: money(r.surcharge_refunded) };
      if (mode === 'category' && b.restock_parts !== undefined) partReturned = b.restock_parts === true;
    }

    // A manager may approve for LESS than was asked, never for more.
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

    if (newLines) {
      await client.query('DELETE FROM invoice_refund_lines WHERE refund_id = $1', [r.id]);
      await insertRefundLines(client, r.id, newLines);
    }

    const upd = await client.query(
      "UPDATE invoice_refunds SET status = 'approved', amount = $1, labor_refunded = $2, parts_refunded = $3, tax_refunded = $4, " +
      'tip_refunded = $5, surcharge_refunded = $10, part_returned = $6, approver_note = $7, approved_by = $8, approved_at = NOW(), updated_at = NOW() ' +
      "WHERE id = $9 AND status = 'requested' RETURNING *",
      [amount, alloc.labor, alloc.parts, alloc.tax, alloc.tip, partReturned, (b.approver_note || '').trim() || null, req.user.id, r.id, alloc.surcharge || 0]
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
// Send the refund to Square for real
// ---------------------------------------------------------------------------
// This is the only route in Nova that moves money OUT. It is gated on
// approve_refund, the same permission that approves the refund in the first
// place, and it only ever acts on a refund a manager has already approved --
// approving and refunding stay two deliberate actions.
//
// All the hard parts (idempotency, the tip-inclusive ceiling, the failure
// branches) live in utils/square.js issueRefund(). This route's job is
// permissions, the customer receipt, and turning the result into something a
// human can read.
//
// A Square refusal comes back as HTTP 200 with ok:false rather than an error
// status. It is an answer, not a fault, and the screen needs the message plus
// the row's new state to tell the manager what to do next.
router.post('/:id/send-to-square', requireAuth, requirePermission('approve_refund'), async (req, res) => {
  const b = req.body || {};
  const rid = refundId(req, res);
  if (!rid) return;
  try {
    const pre = (await pool.query(REFUND_SELECT + 'WHERE r.id = $1', [rid])).rows[0];
    if (!pre) return res.status(404).json({ error: 'Refund not found' });
    if (squareMoneyMoved(pre)) {
      return res.status(409).json({
        error: 'Refund ' + pre.refund_number + ' has already been refunded in Square as ' + pre.square_refund_id + '. Sending it again would refund the customer twice.'
      });
    }
    if (pre.status !== 'approved') {
      return res.status(409).json({ error: 'Only an approved refund can be sent to Square (refund ' + pre.refund_number + ' is ' + pre.status + ').' });
    }

    const result = await square.issueRefund(rid, req.user.id);
    const after = (await pool.query(REFUND_SELECT + 'WHERE r.id = $1', [rid])).rows[0];
    if (after) decorate(after);

    if (!result.ok) {
      try {
        await logAudit({
          entity_type: 'refund', entity_id: rid, entity_number: pre.refund_number, action: 'square_refund_refused',
          user_id: req.user.id, user_name: req.user.name,
          details: { invoice: pre.invoice_number, amount: money(pre.amount), reason: result.reason, message: result.message }
        });
      } catch (e) {}
      // money_moved means Square DID refund the customer and only Nova's record
      // failed. That is the opposite of a refusal and must never read like one:
      // the screen has to stop offering a retry, because a retry against a fresh
      // idempotency key would refund the customer a second time.
      return res.json({
        ok: false,
        reason: result.reason,
        money_moved: result.money_moved === true,
        square_refund_id: result.square_refund_id || null,
        error: result.message,
        refund: after
      });
    }

    // Customer receipt. Sent only for a refund Square actually took, and only
    // when asked for, so a manager retrying a failed send never emails the
    // customer twice about money that has not moved.
    const inv = (await pool.query('SELECT * FROM invoices WHERE id = $1', [pre.invoice_id])).rows[0] || {};
    if (b.email_receipt === true && inv.email && !result.already) {
      try {
        var net = money(money(inv.grand_total) - money(inv.refunded_total));
        const html = emailTemplate({
          badge: 'Refund issued', badgeColor: 'green',
          title: 'A refund has been issued',
          body: 'A refund of <strong>' + fmt(pre.amount) + '</strong> has been sent back to the card used on invoice #' + inv.invoice_number +
                '. Depending on your bank, a card refund can take a few business days to appear on your statement.',
          details: [
            { label: 'Invoice #', value: String(inv.invoice_number) },
            { label: 'Original total', value: fmt(inv.grand_total) },
            { label: 'Refunded', value: fmt(pre.amount) },
            { label: 'Net after refunds', value: fmt(net) },
            { label: 'Back to', value: 'Card ending ' + (pre.settled_card_last4 || inv.card_last4 || '----') }
          ],
          footerNote: 'Questions about this refund? Reply to this email and we will help.'
        });
        await sendEmail(inv.email, 'Refund issued on invoice #' + inv.invoice_number, html);
      } catch (e) { console.error('Refund receipt email failed:', e); }
    }

    // Tell whoever asked for it that the money is on the way.
    if (!result.already && pre.requested_by && pre.requested_by !== req.user.id) {
      try {
        await push.sendPushToUsers([pre.requested_by], {
          title: 'Refund issued',
          body: fmt(pre.amount) + ' was refunded to the customer on invoice #' + pre.invoice_number + '.',
          url: '/'
        });
      } catch (e) { console.error('Refund issued push failed:', e); }
    }

    res.json({
      ok: true,
      already: result.already === true,
      square_status: result.status,
      square_refund_id: (result.refund && result.refund.id) || (after && after.square_refund_id) || null,
      message: result.message,
      refund: after
    });
  } catch (err) {
    console.error(err);
    // Before calling this a failure, check whether the money actually moved.
    // issueRefund records the Square refund id even when its own write fails, so
    // if that id is on the row now, the customer HAS been paid and the only thing
    // that broke was somewhere after the money. Saying "failed to send" here
    // invites a retry that would refund the customer twice.
    try {
      const now = (await pool.query('SELECT square_refund_id, square_status FROM invoice_refunds WHERE id = $1', [rid])).rows[0];
      if (now && now.square_refund_id) {
        return res.status(200).json({
          ok: false,
          reason: 'write_failed_after_send',
          money_moved: true,
          square_refund_id: now.square_refund_id,
          error: 'Square refunded the customer (' + now.square_refund_id + '), but something went wrong on Nova\'s side afterwards. THE MONEY HAS LEFT THE ACCOUNT. Do not send this refund again. Check the invoice and the Square dashboard.'
        });
      }
    } catch (e) { /* fall through to the plain error below */ }
    res.status(500).json({ error: 'Failed to send the refund to Square: ' + err.message });
  }
});

// Poll Square for a refund that came back PENDING. Read-only from Nova's point
// of view -- it asks Square and applies whatever Square says, so it can be
// called as often as a screen likes.
router.get('/:id/square-status', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  const rid = refundId(req, res);
  if (!rid) return;
  try {
    const before = (await pool.query('SELECT id, square_refund_id, square_status FROM invoice_refunds WHERE id = $1', [rid])).rows[0];
    if (!before) return res.status(404).json({ error: 'Refund not found' });
    if (before.square_refund_id && String(before.square_status).toUpperCase() === 'PENDING') {
      try { await square.refreshRefund(rid); } catch (e) { /* Square being down is not an error here */ }
    } else if (!before.square_refund_id && String(before.square_status || '').toUpperCase() === 'SENDING') {
      // Stuck: Square was asked, the answer never got written, and the webhook
      // never landed either. This used to require a manual retry from a manager
      // while the ledger claimed the customer had not been paid. Read-only
      // against Square — it adopts an existing refund, it can never issue one.
      try { await square.recoverStuckRefund(rid); } catch (e) { /* same */ }
    }
    const after = (await pool.query(REFUND_SELECT + 'WHERE r.id = $1', [rid])).rows[0];
    res.json(decorate(after));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check the refund status' });
  }
});

// ---------------------------------------------------------------------------
// Mark as issued by hand (cash, check, the Square dashboard, or a refund the
// API refused). Kept deliberately: this is the fallback for everything the
// Refunds API cannot do.
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
    // Checked BEFORE the status guard on purpose. A refund Nova already pushed
    // through the API is 'processed' already, so the generic "only an approved
    // refund" message would be technically true and completely unhelpful -- it
    // would not tell the manager that the customer has in fact been paid.
    if (squareMoneyMoved(r)) {
      return res.status(409).json({
        error: 'Refund ' + r.refund_number + ' was already refunded through Square as ' + r.square_refund_id + ', so there is nothing to record. Reload the page.'
      });
    }
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
//
// A void means "that refund never happened", and Nova is only entitled to say
// that while the money is still in the account. Once Square has accepted a
// refund it cannot be reversed -- there is no un-refund in the card networks --
// so voiding one would leave the invoice claiming it collected money that is
// sitting in the customer's bank. The block below is the whole reason this
// feature is safe to ship.
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
    if (squareMoneyMoved(r)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Refund ' + r.refund_number + ' of ' + fmt(r.amount) + ' was already refunded through Square (' + r.square_refund_id + ', ' +
               String(r.square_status).toLowerCase() + '). A card refund cannot be reversed, so voiding this record would leave the invoice claiming money the customer already has. ' +
               'If it was refunded in error, charge the customer again on a new invoice.'
      });
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