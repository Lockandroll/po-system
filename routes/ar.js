const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const permissions = require('../utils/permissions');
const ar = require('../utils/ar');

const router = express.Router();

// ---------------------------------------------------------------------------
//  Accounts Receivable
// ---------------------------------------------------------------------------
// The account itself is defined ONCE, on the Accounts tab. Everything here
// hangs off that row: terms, credit limit, statement day, and the invoices
// already in Nova. Nothing in this file writes an account into existence.
// ---------------------------------------------------------------------------

function s(v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n) || null; }
function money(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function ymd(v, fb) {
  const m = String(v || '').trim().match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : fb;
}
async function hasPerm(req, perm) {
  if (!req.user) return false;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (e) {}
  const ep = req._userRow && req._userRow.extra_perms;
  return Array.isArray(ep) && ep.indexOf(perm) !== -1;
}

// ---------------------------------------------------------------------------
//  Aging
// ---------------------------------------------------------------------------
router.get('/aging', requireAuth, requirePermission('view_ar'), async function (req, res) {
  const out = await ar.aging({ city_code: req.query.city || null });
  res.json(out);
});

// Terms live on the account. Editable from here as a convenience, but it is the
// same row the Accounts tab shows - there is no second copy to drift.
router.post('/accounts/:id/terms', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  var day = parseInt(b.ar_statement_day, 10);
  if (!isFinite(day) || day < 1 || day > 28) day = null;   // 29-31 does not exist every month
  const net = parseInt(b.net_days, 10);
  const r = await pool.query(
    'UPDATE vendors SET ar_enabled=$1, net_days=$2, credit_limit=$3, ar_contact_name=$4, ' +
    'ar_contact_email=$5, ar_statement_day=$6 WHERE id=$7 RETURNING name',
    [b.ar_enabled === true || b.ar_enabled === 'true',
      isFinite(net) && net >= 0 ? net : 30,
      money(b.credit_limit), s(b.ar_contact_name, 255), s(b.ar_contact_email, 255), day, id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  await logAudit({ entity_type: 'vendor', entity_id: id, action: 'ar_terms',
    user_id: req.user.id, user_name: req.user.name,
    details: { net_days: net, credit_limit: money(b.credit_limit), enabled: !!b.ar_enabled }, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Ledger
// ---------------------------------------------------------------------------
router.get('/accounts/:id/ledger', requireAuth, requirePermission('view_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const acct = await pool.query(
    'SELECT id, name, ar_enabled, net_days, credit_limit, ar_contact_name, ar_contact_email, ' +
    'ar_statement_day, ar_import_map FROM vendors WHERE id = $1', [id]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Not found' });
  const led = await ar.ledger(id, { from: ymd(req.query.from, null) });
  const bal = await ar.accountBalance(id);
  res.json({
    account: acct.rows[0],
    entries: led.entries,
    closing: led.closing,
    balance: bal,
    // Money in hand that has not been pointed at an invoice. Shown, never
    // netted off - an account owing $800 with $400 sitting unapplied is a
    // different conversation from one owing $400.
    unapplied_cash: led.unapplied_cash,
    // These two are computed from opposite ends. If they ever disagree, one of
    // them stopped reading the view - which is exactly the drift a stored
    // balance column would have hidden.
    reconciles: Math.abs(led.closing - bal) < 0.005,
    open: await ar.openInvoices(id)
  });
});

// ---------------------------------------------------------------------------
//  Payments
// ---------------------------------------------------------------------------
router.post('/payments', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const b = req.body || {};
  const accountId = parseInt(b.account_id, 10);
  const amount = money(b.amount);
  if (!accountId || amount === null || amount <= 0) {
    return res.status(400).json({ error: 'A payment needs an account and an amount above zero.' });
  }
  const lines = Array.isArray(b.lines) ? b.lines : [];
  const applied = lines.reduce(function (t, l) { return t + (money(l.amount) || 0); }, 0);
  // ⚠️ Over-applying is refused. Applying $600 of a $500 cheque leaves an
  // invoice reading as overpaid and an account that will not reconcile, and it
  // is always a typo rather than an intention.
  if (Math.round(applied * 100) > Math.round(amount * 100)) {
    return res.status(400).json({
      error: 'That applies $' + applied.toFixed(2) + ' of a $' + amount.toFixed(2) + ' payment.',
      reason: 'over_applied'
    });
  }

  const client = await pool.connect();
  var payId = null;
  try {
    await client.query('BEGIN');
    const p = await client.query(
      'INSERT INTO ar_payments (account_id, received_on, amount, method, reference, notes, import_batch_id, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [accountId, ymd(b.received_on, new Date().toISOString().slice(0, 10)), amount,
        ar.METHODS.indexOf(b.method) === -1 ? 'other' : b.method,
        s(b.reference, 120), s(b.notes, 2000), parseInt(b.import_batch_id, 10) || null, req.user.id]);
    payId = p.rows[0].id;
    for (var i = 0; i < lines.length; i++) {
      const invId = parseInt(lines[i].invoice_id, 10);
      const amt = money(lines[i].amount);
      if (!invId || !amt) continue;
      await client.query(
        'INSERT INTO ar_payment_lines (payment_id, invoice_id, amount) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = ar_payment_lines.amount + EXCLUDED.amount',
        [payId, invId, amt]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  await logAudit({ entity_type: 'ar_payment', entity_id: payId, action: 'create',
    user_id: req.user.id, user_name: req.user.name,
    details: { account_id: accountId, amount: amount, applied: applied, lines: lines.length }, ip: req.ip });
  res.json({ ok: true, id: payId, unapplied: Math.round((amount - applied) * 100) / 100 });
});

// Apply the unapplied part of a payment later - a customer sends money before
// the invoice exists more often than anyone expects.
router.post('/payments/:id/apply', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];
  const p = await pool.query(
    'SELECT p.*, COALESCE((SELECT SUM(amount) FROM ar_payment_lines WHERE payment_id = p.id),0) AS applied ' +
    'FROM ar_payments p WHERE p.id = $1', [id]);
  if (!p.rows.length) return res.status(404).json({ error: 'Not found' });
  if (p.rows[0].voided_at) return res.status(409).json({ error: 'That payment was voided.' });
  const room = Number(p.rows[0].amount) - Number(p.rows[0].applied);
  const want = lines.reduce(function (t, l) { return t + (money(l.amount) || 0); }, 0);
  if (Math.round(want * 100) > Math.round(room * 100)) {
    return res.status(400).json({
      error: 'Only $' + room.toFixed(2) + ' of that payment is unapplied.', reason: 'over_applied'
    });
  }
  for (var i = 0; i < lines.length; i++) {
    const invId = parseInt(lines[i].invoice_id, 10);
    const amt = money(lines[i].amount);
    if (!invId || !amt) continue;
    await pool.query(
      'INSERT INTO ar_payment_lines (payment_id, invoice_id, amount) VALUES ($1,$2,$3) ' +
      'ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = ar_payment_lines.amount + EXCLUDED.amount',
      [id, invId, amt]);
  }
  await logAudit({ entity_type: 'ar_payment', entity_id: id, action: 'apply',
    user_id: req.user.id, user_name: req.user.name, details: { applied: want }, ip: req.ip });
  res.json({ ok: true });
});

// Voided, never deleted. A deleted payment makes the running balance jump with
// nothing in the ledger to explain the jump.
router.post('/payments/:id/void', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const reason = s(req.body && req.body.reason, 500);
  if (!reason) return res.status(400).json({ error: 'Voiding a payment needs a reason.' });
  const r = await pool.query(
    'UPDATE ar_payments SET voided_at = NOW(), void_reason = $1 WHERE id = $2 AND voided_at IS NULL RETURNING amount',
    [reason, id]);
  if (!r.rows.length) return res.status(409).json({ error: 'Not found, or already voided.' });
  await logAudit({ entity_type: 'ar_payment', entity_id: id, action: 'void',
    user_id: req.user.id, user_name: req.user.name,
    details: { reason: reason, amount: r.rows[0].amount }, ip: req.ip });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  Adjustments
// ---------------------------------------------------------------------------
// ⚠️ A write-off is not data entry. It has its own permission, and it always
// carries a reason - it is the line an auditor asks about.
router.post('/adjustments', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const b = req.body || {};
  const invoiceId = parseInt(b.invoice_id, 10);
  const kind = ar.ADJUST_KINDS.indexOf(b.kind) === -1 ? null : b.kind;
  const amount = money(b.amount);
  const reason = s(b.reason, 2000);
  if (!invoiceId || !kind) return res.status(400).json({ error: 'Pick an invoice and a kind of adjustment.' });
  if (amount === null || amount === 0) return res.status(400).json({ error: 'An adjustment needs an amount.' });
  if (!reason) return res.status(400).json({ error: 'An adjustment needs a reason. It is the line somebody asks about.' });
  if (kind === 'writeoff' && !(await hasPerm(req, 'ar_writeoff'))) {
    return res.status(403).json({
      error: 'Writing off a balance needs the write-off permission.', reason: 'writeoff_perm'
    });
  }
  const inv = await pool.query('SELECT balance, invoice_number FROM ar_invoice_balances WHERE invoice_id = $1', [invoiceId]);
  if (!inv.rows.length) return res.status(404).json({ error: 'That invoice is not on an account, or is still a draft.' });
  if (amount > Number(inv.rows[0].balance) + 0.005) {
    return res.status(400).json({
      error: 'That is more than the $' + Number(inv.rows[0].balance).toFixed(2) + ' still open on invoice ' +
        inv.rows[0].invoice_number + '.', reason: 'over_balance'
    });
  }
  const r = await pool.query(
    'INSERT INTO ar_adjustments (invoice_id, kind, amount, reason, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [invoiceId, kind, amount, reason, req.user.id]);
  await logAudit({ entity_type: 'ar_adjust', entity_id: r.rows[0].id, action: kind,
    user_id: req.user.id, user_name: req.user.name,
    details: { invoice_id: invoiceId, amount: amount, reason: reason }, ip: req.ip });
  res.json({ ok: true, id: r.rows[0].id });
});

// ---------------------------------------------------------------------------
//  Import reconciliation
// ---------------------------------------------------------------------------
// Upload -> map columns -> Nova matches -> a person reviews -> Post.
// Nothing moves money until that last step.

router.post('/import/stage', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const b = req.body || {};
  const accountId = parseInt(b.account_id, 10);
  const text = String(b.text || '');
  const filename = s(b.filename, 255) || 'pasted.csv';
  if (!accountId) return res.status(400).json({ error: 'Pick the account this remittance is from.' });
  if (!text.trim()) return res.status(400).json({ error: 'Nothing to import.' });

  const parsed = ar.parseDelimited(text);
  if (!parsed.rows.length) return res.status(400).json({ error: 'No rows found. Is the first line the column headings?' });

  const map = b.map && b.map.amount ? b.map : ar.guessMap(parsed.headers);
  if (!map.amount) {
    return res.status(400).json({
      error: 'Could not tell which column is the amount.',
      reason: 'need_mapping', headers: parsed.headers, guess: ar.guessMap(parsed.headers)
    });
  }

  // ⚠️ The hash of the CONTENT, not the filename. Files get renamed; the money
  // inside them does not. This is the guard against posting the same remittance
  // twice, which is the single most common way A/R imports go wrong - and it is
  // silent, because the account simply reads as paid ahead.
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const dupe = await pool.query(
    'SELECT id, status, uploaded_at, posted_at FROM ar_import_batches WHERE account_id = $1 AND file_hash = $2',
    [accountId, hash]);
  // Already POSTED is checked first and is not overridable. A staged duplicate
  // is only a warning - somebody may be re-staging after a bad column map - but
  // re-posting money that already moved is never what anyone meant.
  if (dupe.rows.length && dupe.rows[0].status === 'posted') {
    return res.status(409).json({
      error: 'That file has already been posted, on ' +
        new Date(dupe.rows[0].posted_at || dupe.rows[0].uploaded_at).toISOString().slice(0, 10) +
        '. Re-posting it would pay every invoice on it twice.',
      reason: 'already_posted', batch_id: dupe.rows[0].id
    });
  }
  if (dupe.rows.length && !b.confirm_duplicate) {
    return res.status(409).json({
      error: 'This exact file is already staged, from ' +
        new Date(dupe.rows[0].uploaded_at).toISOString().slice(0, 10) + '.',
      reason: 'duplicate_file', batch_id: dupe.rows[0].id, status: dupe.rows[0].status
    });
  }

  const raw = parsed.rows.map(function (r) {
    return {
      invoice_number: map.invoice_number ? r[map.invoice_number] : null,
      amount: ar.parseAmount(map.amount ? r[map.amount] : 0),
      reference: map.reference ? r[map.reference] : null,
      raw: r
    };
  }).filter(function (r) { return r.amount !== 0 || r.invoice_number; });

  const open = await ar.openInvoices(accountId);
  const matched = ar.matchLines(raw, open);
  const staged = matched.reduce(function (t, l) { return t + l.amount; }, 0);

  const client = await pool.connect();
  var batchId = null;
  try {
    await client.query('BEGIN');
    if (dupe.rows.length) {
      await client.query('DELETE FROM ar_import_batches WHERE id = $1', [dupe.rows[0].id]);
    }
    const bt = await client.query(
      'INSERT INTO ar_import_batches (account_id, filename, file_hash, line_count, total_amount, uploaded_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [accountId, filename, hash, matched.length, Math.round(staged * 100) / 100, req.user.id]);
    batchId = bt.rows[0].id;
    for (var i = 0; i < matched.length; i++) {
      const l = matched[i];
      await client.query(
        'INSERT INTO ar_import_lines (batch_id, line_no, raw, invoice_number, invoice_id, amount, match_state, match_note) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [batchId, l.line_no, JSON.stringify(l.raw || {}), s(l.invoice_number, 60),
          l.invoice_id, l.amount, l.match_state, l.match_note]);
    }
    // Remember the mapping so nobody re-maps the same six columns every month
    // and eventually maps one of them wrong.
    await client.query('UPDATE vendors SET ar_import_map = $1 WHERE id = $2', [JSON.stringify(map), accountId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  res.json({ ok: true, batch_id: batchId, map: map, headers: parsed.headers });
});

router.get('/import/:id', requireAuth, requirePermission('view_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = await pool.query(
    'SELECT b.*, v.name AS account_name, u.name AS uploaded_by_name FROM ar_import_batches b ' +
    'LEFT JOIN vendors v ON v.id = b.account_id LEFT JOIN users u ON u.id = b.uploaded_by WHERE b.id = $1', [id]);
  if (!b.rows.length) return res.status(404).json({ error: 'Not found' });
  const l = await pool.query(
    'SELECT l.*, i.invoice_number AS matched_number, bal.balance ' +
    'FROM ar_import_lines l LEFT JOIN invoices i ON i.id = l.invoice_id ' +
    'LEFT JOIN ar_invoice_balances bal ON bal.invoice_id = l.invoice_id ' +
    'WHERE l.batch_id = $1 ORDER BY l.line_no', [id]);
  const counts = { matched: 0, review: 0, unmatched: 0, resolved: 0 };
  l.rows.forEach(function (x) { counts[x.match_state] = (counts[x.match_state] || 0) + 1; });
  res.json({ batch: b.rows[0], lines: l.rows, counts: counts, open: await ar.openInvoices(b.rows[0].account_id) });
});

// Resolve one reviewed line by hand: point it at an invoice, and say what
// happens to any shortfall.
router.post('/import/lines/:id', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const invoiceId = parseInt(b.invoice_id, 10) || null;
  const note = s(b.match_note, 1000);
  const cur = await pool.query(
    'SELECT l.*, bt.status FROM ar_import_lines l JOIN ar_import_batches bt ON bt.id = l.batch_id WHERE l.id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Not found' });
  if (cur.rows[0].status === 'posted') {
    return res.status(409).json({ error: 'That batch is already posted. Adjust the invoice instead.' });
  }
  if (b.skip === true) {
    await pool.query("UPDATE ar_import_lines SET match_state='unmatched', invoice_id=NULL, match_note=$1 WHERE id=$2",
      [note || 'Skipped by hand.', id]);
    return res.json({ ok: true, match_state: 'unmatched' });
  }
  if (!invoiceId) return res.status(400).json({ error: 'Pick the invoice this line pays.' });
  if (!note) return res.status(400).json({ error: 'Say why this line goes to that invoice. A guess with no note is what makes an account unreconcilable later.' });
  await pool.query("UPDATE ar_import_lines SET invoice_id=$1, match_state='resolved', match_note=$2 WHERE id=$3",
    [invoiceId, note, id]);
  res.json({ ok: true, match_state: 'resolved' });
});

// ⚠️ POST. The only thing in the whole module that moves money, and it only
// ever moves the lines a human already agreed to.
router.post('/import/:id/post', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const bt = await pool.query('SELECT * FROM ar_import_batches WHERE id = $1', [id]);
  if (!bt.rows.length) return res.status(404).json({ error: 'Not found' });
  if (bt.rows[0].status === 'posted') return res.status(409).json({ error: 'Already posted.' });
  if (bt.rows[0].status === 'discarded') return res.status(409).json({ error: 'That batch was discarded.' });

  const lines = await pool.query(
    "SELECT * FROM ar_import_lines WHERE batch_id = $1 AND match_state IN ('matched','resolved') AND invoice_id IS NOT NULL",
    [id]);
  if (!lines.rows.length) {
    return res.status(400).json({ error: 'Nothing on this batch is matched yet, so there is nothing to post.' });
  }
  const skipped = await pool.query(
    "SELECT COUNT(*)::int AS n FROM ar_import_lines WHERE batch_id = $1 AND match_state NOT IN ('matched','resolved')", [id]);

  const total = lines.rows.reduce(function (t, l) { return t + Number(l.amount); }, 0);
  const client = await pool.connect();
  var payId = null;
  try {
    await client.query('BEGIN');
    const p = await client.query(
      'INSERT INTO ar_payments (account_id, received_on, amount, method, reference, notes, import_batch_id, created_by) ' +
      "VALUES ($1, CURRENT_DATE, $2, 'ach', $3, $4, $5, $6) RETURNING id",
      [bt.rows[0].account_id, Math.round(total * 100) / 100,
        s(bt.rows[0].filename, 120), 'Posted from import batch #' + id, id, req.user.id]);
    payId = p.rows[0].id;
    for (var i = 0; i < lines.rows.length; i++) {
      await client.query(
        'INSERT INTO ar_payment_lines (payment_id, invoice_id, amount) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (payment_id, invoice_id) DO UPDATE SET amount = ar_payment_lines.amount + EXCLUDED.amount',
        [payId, lines.rows[i].invoice_id, lines.rows[i].amount]);
    }
    await client.query(
      "UPDATE ar_import_batches SET status='posted', posted_at=NOW(), posted_by=$1 WHERE id=$2",
      [req.user.id, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }

  await logAudit({ entity_type: 'ar_batch', entity_id: id, action: 'post',
    user_id: req.user.id, user_name: req.user.name,
    details: { payment_id: payId, lines: lines.rows.length, total: Math.round(total * 100) / 100,
      left_alone: skipped.rows[0].n }, ip: req.ip });
  res.json({
    ok: true, payment_id: payId, posted: lines.rows.length,
    total: Math.round(total * 100) / 100,
    // Said out loud rather than left for somebody to notice. A silent partial
    // post reads as a full one.
    left_alone: skipped.rows[0].n
  });
});

router.post('/import/:id/discard', requireAuth, requirePermission('manage_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const r = await pool.query(
    "UPDATE ar_import_batches SET status='discarded' WHERE id=$1 AND status='staged' RETURNING filename", [id]);
  if (!r.rows.length) return res.status(409).json({ error: 'Not found, or already posted.' });
  await logAudit({ entity_type: 'ar_batch', entity_id: id, action: 'discard',
    user_id: req.user.id, user_name: req.user.name, details: {}, ip: req.ip });
  res.json({ ok: true });
});

router.get('/import', requireAuth, requirePermission('view_ar'), async function (req, res) {
  const params = [];
  var where = '';
  if (req.query.account_id) { params.push(parseInt(req.query.account_id, 10)); where = ' WHERE b.account_id = $1'; }
  const r = await pool.query(
    'SELECT b.*, v.name AS account_name, u.name AS uploaded_by_name FROM ar_import_batches b ' +
    'LEFT JOIN vendors v ON v.id = b.account_id LEFT JOIN users u ON u.id = b.uploaded_by' +
    where + ' ORDER BY b.uploaded_at DESC LIMIT 100', params);
  res.json({ batches: r.rows });
});

// ---------------------------------------------------------------------------
//  Statement
// ---------------------------------------------------------------------------
// The data behind a statement. The PDF itself reuses the existing invoicePdf
// pattern rather than inventing a second document pipeline.
router.get('/accounts/:id/statement', requireAuth, requirePermission('view_ar'), async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const acct = await pool.query(
    'SELECT id, name, ar_contact_name, ar_contact_email, net_days, credit_limit FROM vendors WHERE id = $1', [id]);
  if (!acct.rows.length) return res.status(404).json({ error: 'Not found' });
  const open = await ar.openInvoices(id);
  const agingOne = await ar.aging({ account_id: id });
  res.json({
    account: acct.rows[0],
    as_of: new Date().toISOString().slice(0, 10),
    open: open,
    aging: agingOne.accounts[0] || null,
    balance: await ar.accountBalance(id)
  });
});

module.exports = router;
