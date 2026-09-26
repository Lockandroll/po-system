// Split tender: one invoice paid across two to four methods (two cards, card +
// cash, and so on). Tony's call, 2026-09-25. Plan: memory
// nova-invoice-split-payment-plan.
//
// The rules that make this safe:
//   1. Every tender carries a BASE: its share of the pre-surcharge total
//      (subtotal + tax + any tip already typed on the invoice). The bases must
//      add up to that figure to the cent, compared in integer cents.
//   2. The card surcharge is charged per CARD tender on that tender's own share,
//      so the cash half of a split is never surcharged. Tips are never
//      surcharged, same as the single-tender path.
//   3. The invoice's surcharge_amount, tip_amount and grand_total are REBUILT
//      from the tender rows by rollup(), from subtotal and tax_amount (the two
//      money columns nothing here writes). Running it twice gives the same
//      answer, which matters because a Square reconcile is re-entered routinely.
//   4. A tender collected in Square is money that moved. It is never edited or
//      dropped; the plan can only change around it, and the refund flow is the
//      way back.
//
// NOTE: this file must contain NO backtick characters. Windows corrupts them
// silently on this repo. Use string concatenation.

const { pool } = require('../db');
const { logAudit } = require('./audit');

const MIN_TENDERS = 2;
const MAX_TENDERS = 4;
const SETTLED = ['paid', 'partially_refunded', 'refunded'];

function cents(n) { return Math.round((Number(n) || 0) * 100); }
function dollars(c) { return Math.round(c) / 100; }

// Cash and check are never surcharged. Anything that names a card is. Pay types
// are editable in Invoice Setup, so this reads the name rather than a fixed list;
// "Other" and anything unrecognised is treated as NOT a card, which errs toward
// not surcharging.
function isCardType(payType) {
  return /visa|master|amex|american|discover|debit|credit|card/i.test(String(payType || ''));
}

function isBilled(payType, billedList) {
  const p = String(payType || '').trim().toLowerCase();
  if (!p) return false;
  const list = (billedList && billedList.length) ? billedList : ['Account / Invoice', 'Motor Club'];
  for (let i = 0; i < list.length; i++) {
    if (String(list[i]).trim().toLowerCase() === p) return true;
  }
  return false;
}

async function listTenders(invoiceId, db) {
  const r = await (db || pool).query(
    'SELECT * FROM invoice_tenders WHERE invoice_id = $1 ORDER BY seq', [invoiceId]
  );
  return r.rows;
}

// The pre-surcharge figure the bases have to add up to. tip_amount on an invoice
// with a split in progress already includes any tips Square added on collected
// tenders (rollup puts them there), so those are taken back out first.
function splitBaseCents(inv, existingTenders) {
  let squareTips = 0;
  (existingTenders || []).forEach(function (t) { squareTips += cents(t.tip_amount); });
  return cents(inv.subtotal) + cents(inv.tax_amount) + (cents(inv.tip_amount) - squareTips);
}

// Surcharge on one card tender. Charged on the tender's share of subtotal + tax
// only (never the tip), rounded to the cent here and nowhere else, so the figure
// stored, the figure shown and the figure sent to Square are identical.
function tenderSurchargeCents(baseC, salesC, splitC, rate) {
  const r = Number(rate) || 0;
  if (!(r > 0) || !(baseC > 0) || !(splitC > 0)) return 0;
  const share = salesC >= splitC ? baseC : (baseC * salesC / splitC);
  return Math.round(share * r / 100);
}

// Validate and price a proposed plan. rows: [{ pay_type, amount, card_last4,
// approval_code, collect_in_square }]. amount is the tender's BASE in dollars.
// existing: the tenders already on file (Square-collected ones must survive
// unchanged). Returns { ok, error, plan[] }.
function buildPlan(inv, rows, existing, rate, billedList) {
  if (!Array.isArray(rows)) return { ok: false, error: 'Send the payments as a list.' };
  if (rows.length < MIN_TENDERS) return { ok: false, error: 'A split needs at least ' + MIN_TENDERS + ' payments. Use a single payment instead.' };
  if (rows.length > MAX_TENDERS) return { ok: false, error: 'A split can have at most ' + MAX_TENDERS + ' payments.' };

  const locked = (existing || []).filter(function (t) { return t.collected_via === 'square' && t.status === 'collected'; });
  const splitC = splitBaseCents(inv, existing);
  const salesC = cents(inv.subtotal) + cents(inv.tax_amount);
  if (!(splitC > 0)) return { ok: false, error: 'There is nothing to collect on this invoice.' };

  const plan = [];
  let sumC = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const n = i + 1;
    const lockedHere = locked.filter(function (t) { return Number(t.seq) === n; })[0];
    if (lockedHere) {
      // Money that already moved in Square. The client may only echo it back.
      if (cents(row.amount) !== cents(lockedHere.base_amount) ||
          String(row.pay_type || '').trim() !== String(lockedHere.pay_type || '').trim()) {
        return { ok: false, error: 'Payment ' + n + ' was already charged in Square for ' + dollars(cents(lockedHere.amount)).toFixed(2) + ' and cannot be changed. Reopen the split and leave that line as it is.' };
      }
      plan.push({
        seq: n, pay_type: lockedHere.pay_type, base_c: cents(lockedHere.base_amount),
        surcharge_c: cents(lockedHere.surcharge_amount), tip_c: cents(lockedHere.tip_amount),
        card_last4: lockedHere.card_last4, approval_code: lockedHere.approval_code,
        collected_via: 'square', status: 'collected', invoice_payment_id: lockedHere.invoice_payment_id,
        collected_at: lockedHere.collected_at, keep: true
      });
      sumC += cents(lockedHere.base_amount);
      continue;
    }
    const payType = String(row.pay_type || '').trim().slice(0, 50);
    if (!payType) return { ok: false, error: 'Pick how payment ' + n + ' is being paid.' };
    if (isBilled(payType, billedList)) {
      return { ok: false, error: payType + ' is billed, not collected, so it cannot be part of a split. Use it as the only payment.' };
    }
    const baseC = cents(row.amount);
    if (!(baseC > 0)) return { ok: false, error: 'Payment ' + n + ' needs an amount greater than zero.' };
    const card = isCardType(payType);
    const viaSquare = !!row.collect_in_square && card;
    const surC = card ? tenderSurchargeCents(baseC, salesC, splitC, rate) : 0;
    plan.push({
      seq: n, pay_type: payType, base_c: baseC, surcharge_c: surC, tip_c: 0,
      card_last4: card ? (String(row.card_last4 || '').replace(/\D/g, '').slice(-4) || null) : null,
      approval_code: card ? (String(row.approval_code || '').trim().slice(0, 60) || null) : null,
      collected_via: viaSquare ? 'square' : 'manual',
      status: viaSquare ? 'pending' : 'collected',
      invoice_payment_id: null, collected_at: viaSquare ? null : new Date(), keep: false
    });
    sumC += baseC;
  }
  // A Square-collected tender that the new plan left out entirely.
  for (let j = 0; j < locked.length; j++) {
    if (Number(locked[j].seq) > rows.length) {
      return { ok: false, error: 'Payment ' + locked[j].seq + ' was already charged in Square and cannot be removed.' };
    }
  }
  if (sumC !== splitC) {
    const diff = splitC - sumC;
    return {
      ok: false,
      error: (diff > 0
        ? ('The payments are ' + dollars(diff).toFixed(2) + ' short of the ' + dollars(splitC).toFixed(2) + ' to collect.')
        : ('The payments are ' + dollars(-diff).toFixed(2) + ' over the ' + dollars(splitC).toFixed(2) + ' to collect.')),
      split_base: dollars(splitC)
    };
  }
  return { ok: true, plan: plan, split_base: dollars(splitC) };
}

// Replace the plan on file with a validated one, in the caller's transaction.
async function writePlan(client, invoiceId, plan, userId) {
  // Square-collected rows stay exactly as they are. Everything else is rewritten.
  await client.query(
    "DELETE FROM invoice_tenders WHERE invoice_id = $1 AND NOT (collected_via = 'square' AND status = 'collected')",
    [invoiceId]
  );
  for (let i = 0; i < plan.length; i++) {
    const t = plan[i];
    if (t.keep) continue;
    const amount = dollars(t.base_c + t.surcharge_c + t.tip_c);
    await client.query(
      'INSERT INTO invoice_tenders (invoice_id, seq, pay_type, base_amount, surcharge_amount, tip_amount, amount, ' +
      'card_last4, approval_code, collected_via, status, created_by, collected_at) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [invoiceId, t.seq, t.pay_type, dollars(t.base_c), dollars(t.surcharge_c), dollars(t.tip_c), amount,
       t.card_last4, t.approval_code, t.collected_via, t.status, userId || null, t.collected_at]
    );
  }
}

// Rebuild the invoice money columns from its tenders. Only surcharge_amount,
// tip_amount, grand_total and the pay_type summary move; subtotal and tax_amount
// are read, never written, so this is idempotent.
async function rollup(client, invoiceId, rate) {
  const db = client || pool;
  const inv = (await db.query('SELECT id, subtotal, tax_amount FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) return null;
  const ts = await listTenders(invoiceId, db);
  if (!ts.length) return null;
  let baseC = 0, surC = 0, tipC = 0;
  ts.forEach(function (t) { baseC += cents(t.base_amount); surC += cents(t.surcharge_amount); tipC += cents(t.tip_amount); });
  const salesC = cents(inv.subtotal) + cents(inv.tax_amount);
  const invTipC = (baseC - salesC) + tipC;
  const grandC = baseC + surC + tipC;
  const sets = ["pay_type = 'Split'", 'card_last4 = NULL', 'approval_code = NULL',
    'surcharge_amount = $1', 'tip_amount = $2', 'grand_total = $3', 'updated_at = NOW()'];
  const vals = [dollars(surC), dollars(invTipC), dollars(grandC)];
  if (rate != null) {
    sets.push('surcharge_rate = $' + (vals.length + 1));
    vals.push(surC > 0 ? (Number(rate) || 0) : 0);
  }
  vals.push(invoiceId);
  await db.query('UPDATE invoices SET ' + sets.join(', ') + ' WHERE id = $' + vals.length, vals);
  return { tenders: ts, base: dollars(baseC), surcharge: dollars(surC), tip: dollars(invTipC), grand_total: dollars(grandC) };
}

function summarize(tenders) {
  const out = { count: 0, collected: 0, pending: 0, collected_total: 0, remaining_to_collect: 0 };
  (tenders || []).forEach(function (t) {
    out.count++;
    if (t.status === 'collected') { out.collected++; out.collected_total += Number(t.amount) || 0; }
    else { out.pending++; out.remaining_to_collect += (Number(t.base_amount) || 0) + (Number(t.surcharge_amount) || 0); }
  });
  out.collected_total = Math.round(out.collected_total * 100) / 100;
  out.remaining_to_collect = Math.round(out.remaining_to_collect * 100) / 100;
  return out;
}

// Once every tender is collected, the invoice is paid. Guarded so two callers
// (the Complete button and a Square webhook, say) cannot both finish it.
// Returns true only for the call that actually moved it.
async function finalizeIfComplete(invoiceId, actorUserId, actorName) {
  const ts = await listTenders(invoiceId);
  if (ts.length < MIN_TENDERS) return false;
  if (ts.some(function (t) { return t.status !== 'collected'; })) return false;
  let preTipC = 0;
  ts.forEach(function (t) { preTipC += cents(t.base_amount) + cents(t.surcharge_amount); });
  const upd = await pool.query(
    "UPDATE invoices SET status = 'paid', completed_at = NOW(), completed_by = $2, waiting_since = NULL, " +
    'authorized_total = COALESCE(authorized_total, $3), updated_at = NOW() ' +
    "WHERE id = $1 AND status NOT IN ('paid', 'partially_refunded', 'refunded', 'canceled') " +
    'RETURNING id, invoice_number, grand_total, followup_task_id',
    [invoiceId, actorUserId || null, dollars(preTipC)]
  );
  const inv = upd.rows[0];
  if (!inv) return false;
  if (inv.followup_task_id) {
    try {
      await pool.query(
        "UPDATE tasks SET status = 'done', completed_at = NOW(), completed_by = $1, updated_at = NOW() " +
        "WHERE id = $2 AND status <> 'done'",
        [actorUserId || null, inv.followup_task_id]
      );
    } catch (e) { console.error('Could not close follow-up task ' + inv.followup_task_id + ':', e.message); }
  }
  try { await require('./invoiceNotify').notifyInvoiceFinished(inv.id, actorUserId ? { id: actorUserId, name: actorName } : null); } catch (e) {}
  try {
    await logAudit({
      entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number),
      action: 'completed', user_id: actorUserId || null, user_name: actorName || 'Split payment',
      details: {
        pay_type: 'Split', total: inv.grand_total,
        tenders: ts.map(function (t) { return { seq: t.seq, pay_type: t.pay_type, amount: Number(t.amount), via: t.collected_via }; })
      }
    });
  } catch (e) {}
  return true;
}

// Is there Square money on this plan? Anything that would change the invoice's
// money has to refuse while there is.
function hasSquareCollected(tenders) {
  return (tenders || []).some(function (t) { return t.collected_via === 'square' && t.status === 'collected'; });
}

module.exports = {
  MIN_TENDERS: MIN_TENDERS,
  MAX_TENDERS: MAX_TENDERS,
  SETTLED: SETTLED,
  isCardType: isCardType,
  isBilled: isBilled,
  listTenders: listTenders,
  splitBaseCents: splitBaseCents,
  tenderSurchargeCents: tenderSurchargeCents,
  buildPlan: buildPlan,
  writePlan: writePlan,
  rollup: rollup,
  summarize: summarize,
  finalizeIfComplete: finalizeIfComplete,
  hasSquareCollected: hasSquareCollected
};
