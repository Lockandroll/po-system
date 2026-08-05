const { pool } = require('../db');

// ---------------------------------------------------------------------------
//  Accounts Receivable
// ---------------------------------------------------------------------------
// ⚠️ Balance is DERIVED, never stored:
//
//     balance = total - refunded - applied payments - adjustments
//
// A stored balance column drifts the first time anything is edited out of
// band - a refund posted, a payment unapplied, an invoice corrected - and
// once the aging report and the ledger disagree by four dollars, nobody
// trusts either of them again. The `ar_invoice_balances` view in db.js is the
// single definition; everything in here reads it rather than recomputing.
// ---------------------------------------------------------------------------

const BUCKETS = [
  { key: 'current', label: 'Current', from: -100000, to: 0 },
  { key: 'd1_30', label: '1-30', from: 1, to: 30 },
  { key: 'd31_60', label: '31-60', from: 31, to: 60 },
  { key: 'd61_90', label: '61-90', from: 61, to: 90 },
  { key: 'd90p', label: '90+', from: 91, to: 1000000 }
];

const ADJUST_KINDS = ['writeoff', 'credit', 'short_pay', 'dispute'];
const METHODS = ['check', 'ach', 'card', 'square', 'other'];

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function bucketFor(daysLate) {
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return 'd1_30';
  if (daysLate <= 60) return 'd31_60';
  if (daysLate <= 90) return 'd61_90';
  return 'd90p';
}

// ---------------------------------------------------------------------------
//  Aging
// ---------------------------------------------------------------------------
/**
 * One row per A/R account with its balance split into buckets.
 * Only accounts with ar_enabled are included: an account nobody has set terms
 * for is not on terms, and showing it as 90 days late is a lie about somebody
 * who was always going to pay by card at the door.
 */
async function aging(opts) {
  const o = opts || {};
  const params = [];
  var where = 'WHERE v.ar_enabled = true';
  if (o.account_id) { params.push(parseInt(o.account_id, 10)); where += ' AND v.id = $' + params.length; }
  if (o.city_code) { params.push(String(o.city_code).trim()); where += ' AND TRIM(b.city_code) = TRIM($' + params.length + ')'; }

  const r = await pool.query(
    'SELECT v.id AS account_id, v.name, v.net_days, v.credit_limit, v.ar_contact_email, ' +
    '       b.invoice_id, b.invoice_number, b.invoice_date, b.due_on, b.balance, ' +
    '       GREATEST(0, (CURRENT_DATE - b.due_on))::int AS days_late ' +
    'FROM vendors v LEFT JOIN ar_invoice_balances b ON b.account_id = v.id AND b.balance > 0.004 ' +
    where + ' ORDER BY v.name, b.due_on', params);

  const byAccount = {};
  r.rows.forEach(function (x) {
    if (!byAccount[x.account_id]) {
      byAccount[x.account_id] = {
        account_id: x.account_id, name: x.name, net_days: x.net_days,
        credit_limit: x.credit_limit === null ? null : Number(x.credit_limit),
        ar_contact_email: x.ar_contact_email,
        current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0,
        total: 0, open_invoices: 0, oldest_days: 0
      };
    }
    if (!x.invoice_id) return;
    const a = byAccount[x.account_id];
    const bal = Number(x.balance);
    const late = Number(x.days_late || 0);
    a[bucketFor(late)] = r2(a[bucketFor(late)] + bal);
    a.total = r2(a.total + bal);
    a.open_invoices++;
    if (late > a.oldest_days) a.oldest_days = late;
  });

  const accounts = Object.keys(byAccount).map(function (k) {
    const a = byAccount[k];
    // Over the limit is worth SAYING, and never worth blocking on. Refusing to
    // dispatch because an account is over its limit is a business decision, and
    // it would happen at 2am to a customer standing in a parking lot.
    a.over_limit = !!(a.credit_limit !== null && a.total > a.credit_limit);
    return a;
  }).sort(function (x, y) { return y.total - x.total; });

  const totals = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, total: 0 };
  accounts.forEach(function (a) {
    BUCKETS.forEach(function (b) { totals[b.key] = r2(totals[b.key] + a[b.key]); });
    totals.total = r2(totals.total + a.total);
  });
  return { accounts: accounts, totals: totals, buckets: BUCKETS };
}

// ---------------------------------------------------------------------------
//  The ledger
// ---------------------------------------------------------------------------
/**
 * One date-ordered list per account - invoices, payments and adjustments -
 * with a running balance that closes on the same figure the aging row shows.
 * If those two ever disagree, one of them is computed from something other
 * than the view, and that is the bug.
 */
async function ledger(accountId, opts) {
  const o = opts || {};
  const id = parseInt(accountId, 10);
  if (!id) return { entries: [], closing: 0 };

  const params = [id];
  var dateFrom = '';
  if (o.from) { params.push(o.from); dateFrom = ' AND i.invoice_date >= $' + params.length + '::date'; }

  const inv = await pool.query(
    'SELECT b.invoice_id, b.invoice_number, b.invoice_date AS at, b.total, b.refunded, ' +
    '       b.applied, b.adjusted, b.balance, b.due_on, b.status ' +
    'FROM ar_invoice_balances b JOIN invoices i ON i.id = b.invoice_id ' +
    'WHERE b.account_id = $1' + dateFrom + ' ORDER BY b.invoice_date, b.invoice_id', params);

  const pay = await pool.query(
    'SELECT p.id, p.received_on AS at, p.amount, p.method, p.reference, p.notes, ' +
    '       p.voided_at, p.void_reason, p.import_batch_id, u.name AS created_by_name, ' +
    "       COALESCE((SELECT json_agg(json_build_object('invoice_id', l.invoice_id, " +
    "            'invoice_number', i2.invoice_number, 'amount', l.amount) ORDER BY l.invoice_id) " +
    "          FROM ar_payment_lines l JOIN invoices i2 ON i2.id = l.invoice_id " +
    "          WHERE l.payment_id = p.id), '[]'::json) AS lines, " +
    '       COALESCE((SELECT SUM(l2.amount) FROM ar_payment_lines l2 WHERE l2.payment_id = p.id), 0) AS applied ' +
    'FROM ar_payments p LEFT JOIN users u ON u.id = p.created_by ' +
    'WHERE p.account_id = $1 ORDER BY p.received_on, p.id', [id]);

  const adj = await pool.query(
    'SELECT a.id, a.created_at AS at, a.kind, a.amount, a.reason, i.invoice_number, ' +
    '       a.invoice_id, u.name AS created_by_name ' +
    'FROM ar_adjustments a JOIN invoices i ON i.id = a.invoice_id ' +
    'LEFT JOIN users u ON u.id = a.created_by ' +
    'WHERE i.account_id = $1 ORDER BY a.created_at, a.id', [id]);

  var entries = [];
  inv.rows.forEach(function (x) {
    entries.push({
      kind: 'invoice', at: x.at, ref: String(x.invoice_number),
      invoice_id: x.invoice_id, description: 'Invoice ' + x.invoice_number,
      debit: r2(x.total), credit: 0, due_on: x.due_on, status: x.status,
      invoice_balance: r2(x.balance)
    });
    if (Number(x.refunded) > 0) {
      entries.push({
        kind: 'refund', at: x.at, ref: String(x.invoice_number), invoice_id: x.invoice_id,
        description: 'Refund on invoice ' + x.invoice_number, debit: 0, credit: r2(x.refunded)
      });
    }
  });
  var unappliedCash = 0;
  pay.rows.forEach(function (x) {
    // ⚠️ The running balance credits what was APPLIED, not what arrived. Money
    // sitting unapplied is real, but it has not paid an invoice yet, so it does
    // not reduce what is chaseable. It is reported separately below instead of
    // being quietly netted off - otherwise the ledger and the aging disagree,
    // and there is no way to tell which one is wrong.
    const unapplied = x.voided_at ? 0 : r2(Number(x.amount) - Number(x.applied));
    unappliedCash = r2(unappliedCash + unapplied);
    entries.push({
      kind: 'payment', at: x.at, ref: x.reference || ('#' + x.id), payment_id: x.id,
      description: 'Payment' + (x.method ? ' (' + x.method + ')' : '') +
        (x.voided_at ? ' - VOIDED: ' + (x.void_reason || '') : '') +
        (unapplied ? ' - $' + unapplied.toFixed(2) + ' still unapplied' : ''),
      debit: 0, credit: x.voided_at ? 0 : r2(x.applied),
      amount: r2(x.amount),
      voided: !!x.voided_at, lines: x.lines, unapplied: unapplied
    });
  });
  adj.rows.forEach(function (x) {
    entries.push({
      kind: 'adjustment', at: x.at, ref: String(x.invoice_number), invoice_id: x.invoice_id,
      adjustment_id: x.id, adjust_kind: x.kind,
      description: x.kind.replace('_', ' ') + ' on invoice ' + x.invoice_number + ' - ' + x.reason,
      debit: Number(x.amount) < 0 ? r2(-x.amount) : 0,
      credit: Number(x.amount) > 0 ? r2(x.amount) : 0
    });
  });

  entries.sort(function (a, b) {
    const da = new Date(a.at).getTime(), db2 = new Date(b.at).getTime();
    if (da !== db2) return da - db2;
    // Invoices before the money that pays them on the same day, so a running
    // balance never dips negative for a line and then recovers.
    const order = { invoice: 0, refund: 1, adjustment: 2, payment: 3 };
    return (order[a.kind] || 9) - (order[b.kind] || 9);
  });

  var run = 0;
  entries.forEach(function (e) { run = r2(run + e.debit - e.credit); e.running = run; });
  return { entries: entries, closing: run, unapplied_cash: unappliedCash };
}

// The figure the aging row shows, computed the other way round. Used to prove
// the ledger closes on it rather than merely looking as though it does.
async function accountBalance(accountId) {
  const r = await pool.query(
    'SELECT COALESCE(SUM(balance),0) AS bal FROM ar_invoice_balances WHERE account_id = $1',
    [parseInt(accountId, 10)]);
  return r2(r.rows[0].bal);
}

async function openInvoices(accountId) {
  const r = await pool.query(
    'SELECT * FROM ar_invoice_balances WHERE account_id = $1 AND balance > 0.004 ORDER BY invoice_date, invoice_id',
    [parseInt(accountId, 10)]);
  return r.rows;
}

// ---------------------------------------------------------------------------
//  Import matching
// ---------------------------------------------------------------------------
// Four rules, in order, and nothing below "matched" is ever applied without a
// person looking at it:
//
//   1. exact invoice number on the line          -> matched
//   2. exact open amount, one candidate          -> matched
//   3. short of an open invoice                  -> review (needs a reason)
//   4. anything else                             -> unmatched
//
// An importer that guesses is worse than no importer. You find out three
// months later, when an account will not reconcile and nobody can say which
// guess was wrong.

function normNumber(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[^0-9]/g, '');
  return s || null;
}

function parseAmount(v) {
  if (v === undefined || v === null) return 0;
  var s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return r2(neg ? -n : n);
}

/**
 * @param {array} lines  [{invoice_number, amount, raw}]
 * @param {array} open   rows from openInvoices()
 * @returns the same lines with invoice_id / match_state / match_note filled in
 */
function matchLines(lines, open) {
  const byNumber = {};
  (open || []).forEach(function (i) { byNumber[String(i.invoice_number)] = i; });

  // How much of each invoice this FILE has already claimed. Without it, a
  // remittance listing the same invoice on two lines matches both against the
  // full balance and the batch total silently exceeds what is owed.
  const claimed = {};

  return (lines || []).map(function (l, idx) {
    const out = Object.assign({ line_no: idx + 1 }, l);
    out.amount = r2(l.amount);
    out.invoice_id = null;
    out.match_state = 'unmatched';
    out.match_note = null;

    const num = normNumber(l.invoice_number);
    var cand = null;
    if (num && byNumber[num]) cand = byNumber[num];

    if (!cand && out.amount > 0) {
      // Rule 2: exactly one open invoice for this amount. Two candidates is not
      // a match, it is a coin toss with somebody's money.
      const exact = (open || []).filter(function (i) {
        const remaining = r2(Number(i.balance) - (claimed[i.invoice_id] || 0));
        return Math.abs(remaining - out.amount) < 0.005;
      });
      if (exact.length === 1) { cand = exact[0]; out.match_note = 'Matched on amount, one open invoice for it.'; }
      else if (exact.length > 1) {
        out.match_note = exact.length + ' open invoices are for exactly this amount. Pick one.';
        out.match_state = 'review';
        return out;
      }
    }

    if (!cand) {
      out.match_note = num ? 'No open invoice ' + num + ' on this account.' : 'Nothing on this line matches an open invoice.';
      return out;
    }

    const remaining = r2(Number(cand.balance) - (claimed[cand.invoice_id] || 0));
    out.invoice_id = cand.invoice_id;
    out.invoice_number = String(cand.invoice_number);

    if (out.amount <= 0) {
      out.match_state = 'review';
      out.match_note = 'Zero or negative amount on a line naming invoice ' + cand.invoice_number + '.';
    } else if (Math.abs(out.amount - remaining) < 0.005) {
      out.match_state = 'matched';
      claimed[cand.invoice_id] = r2((claimed[cand.invoice_id] || 0) + out.amount);
    } else if (out.amount < remaining) {
      // Rule 3. A short pay is a decision - write off the difference, chase it,
      // or dispute it - so it stops here for a person and a reason.
      out.match_state = 'review';
      out.match_note = 'Short by $' + r2(remaining - out.amount).toFixed(2) +
        ' against invoice ' + cand.invoice_number + '. Needs a reason before it posts.';
      claimed[cand.invoice_id] = r2((claimed[cand.invoice_id] || 0) + out.amount);
    } else {
      out.match_state = 'review';
      out.match_note = 'Over by $' + r2(out.amount - remaining).toFixed(2) +
        ' against invoice ' + cand.invoice_number + '. Overpayment stays unapplied until somebody says where it goes.';
      claimed[cand.invoice_id] = r2((claimed[cand.invoice_id] || 0) + remaining);
    }
    return out;
  });
}

// Reads a delimited file into rows of objects. Deliberately small and
// dependency-free: a bank CSV is a bank CSV, and pulling in a parser for it
// would be more surface than the problem deserves.
function parseDelimited(text, delim) {
  const src = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const d = delim || (src.split('\n')[0].indexOf('\t') !== -1 ? '\t' : ',');
  const rows = [];
  var field = '', row = [], inQ = false;
  for (var i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  if (!clean.length) return { headers: [], rows: [] };
  const headers = clean[0].map(function (h) { return String(h).trim(); });
  return {
    headers: headers,
    rows: clean.slice(1).map(function (r) {
      const o = {};
      headers.forEach(function (h, i2) { o[h] = r[i2] === undefined ? '' : String(r[i2]).trim(); });
      return o;
    })
  };
}

// A first guess at which column is which, so the mapping screen starts filled
// in. It is a guess and it is editable - it is never applied silently.
function guessMap(headers) {
  const out = { invoice_number: null, amount: null, date: null, reference: null };
  (headers || []).forEach(function (h) {
    const k = String(h).toLowerCase();
    if (!out.invoice_number && /(invoice|inv)[ _]?(no|num|#)?|^inv$|reference number/.test(k)) out.invoice_number = h;
    if (!out.amount && /(amount|paid|payment|net|total)/.test(k)) out.amount = h;
    if (!out.date && /(date|posted|received)/.test(k)) out.date = h;
    if (!out.reference && /(check|cheque|ref|trace|eft|ach)/.test(k)) out.reference = h;
  });
  return out;
}

module.exports = {
  BUCKETS: BUCKETS,
  ADJUST_KINDS: ADJUST_KINDS,
  METHODS: METHODS,
  r2: r2,
  bucketFor: bucketFor,
  aging: aging,
  ledger: ledger,
  accountBalance: accountBalance,
  openInvoices: openInvoices,
  matchLines: matchLines,
  parseDelimited: parseDelimited,
  parseAmount: parseAmount,
  guessMap: guessMap
};
