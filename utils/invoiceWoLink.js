'use strict';
/*
 * Invoice <-> work order linking  (Nova, Tony 2026-10-16)
 * -------------------------------------------------------
 * A work order finds its invoice through invoices.signoff_group_id = the trip
 * group of the WO's sign-off sheet. Only "+ Create Invoice" on the sign-off
 * sheet sets that. When a locksmith builds the invoice from the Invoices screen
 * instead, nothing ties it to the job, so Completion Paperwork shows "No
 * invoice" forever and the job cannot be sent to the account.
 *
 * This file closes that gap two ways:
 *   1. AUTO: match an unlinked invoice to a work order and link it.
 *      a) the sign-off sheet already names the invoice number (the tech typed
 *         it in the required Invoice # box when completing the sheet), or
 *      b) same ACCOUNT and the invoice's Customer PO / WO # equals the work
 *         order's PO # or WO # (case, spaces, dashes and a leading PO/WO/#
 *         ignored).
 *      Refuses to guess: links only when exactly ONE job matches, that job has
 *      no live invoice already, and the invoice is not already on a job.
 *   2. MANUAL: a "Link Invoice" picker on the work order page and on the
 *      Completion Paperwork job review, plus Unlink.
 *
 * An invoice somebody UNLINKS by hand is stamped wo_autolink_off so the sweep
 * never puts it back. Linking it by hand again clears the stamp.
 *
 * NOTE: no backtick/template-literal strings (Windows-safe per Nova rules).
 */

const { pool } = require('../db');

const DEAD = "('canceled')";
// How far back the sweep and the candidate lists look. A job older than this is
// almost certainly already billed some other way.
const LOOKBACK_DAYS = 120;

// "PO# 12-345" / "po12345" / "WO 12345" -> "12345". Two forms are compared:
// the plain alphanumeric form and the form with a leading PO/WO/WORKORDER word
// removed, so a PO that genuinely starts with letters still matches itself.
function normKeys(s) {
  const raw = String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return [];
  const out = [raw];
  const stripped = raw.replace(/^(PURCHASEORDER|WORKORDER|PO|WO)/, '');
  if (stripped && stripped !== raw && /[0-9]/.test(stripped)) out.push(stripped);
  return out;
}
function keysMatch(a, b) {
  const ka = normKeys(a), kb = normKeys(b);
  for (let i = 0; i < ka.length; i++) if (kb.indexOf(ka[i]) !== -1) return true;
  return false;
}

async function activity(woId, user, body) {
  try {
    await pool.query(
      'INSERT INTO work_order_activity (work_order_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)',
      [woId, user ? user.id : null, user ? user.name : 'System', 'event', body]
    );
  } catch (e) { console.error('[invoice-wo-link] activity failed:', e && e.message); }
}

async function groupOf(signoffId) {
  if (!signoffId) return null;
  const r = await pool.query('SELECT COALESCE(trip_group_id, id) AS gid FROM signoff_forms WHERE id = $1', [signoffId]);
  return r.rows.length ? r.rows[0].gid : null;
}

// The live invoice already on a trip group, if any.
async function liveInvoiceOnGroup(gid) {
  const r = await pool.query(
    'SELECT id, invoice_number, status FROM invoices WHERE signoff_group_id = $1 AND status NOT IN ' + DEAD + ' ORDER BY id DESC LIMIT 1', [gid]);
  return r.rows[0] || null;
}

// Do the link. Guarded in SQL so two sweeps (or a sweep and a click) cannot
// both win: the invoice must still be unlinked unless force is set.
async function applyLink(inv, wo, gid, user, how) {
  const upd = await pool.query(
    'UPDATE invoices SET signoff_group_id = $1, wo_autolink_off = false, updated_at = NOW() ' +
    'WHERE id = $2' + (how === 'manual' ? '' : ' AND signoff_group_id IS NULL AND wo_autolink_off IS NOT TRUE') +
    ' RETURNING id', [gid, inv.id]);
  if (!upd.rows.length) return false;
  // Same write-back the sign-off "+ Create Invoice" does: fill a blank Invoice #
  // on the job's sheets. A number somebody typed is left alone.
  try {
    await pool.query(
      "UPDATE signoff_forms SET invoice_number = $1, updated_at = NOW() WHERE (trip_group_id = $2 OR id = $2) AND (invoice_number IS NULL OR invoice_number = '')",
      [String(inv.invoice_number), gid]);
  } catch (e) { console.error('[invoice-wo-link] sheet write-back failed:', e && e.message); }
  const why = how === 'manual' ? 'linked' : ('auto-linked (' + how + ')');
  await activity(wo.id, how === 'manual' ? user : null, why + ' invoice #' + inv.invoice_number + ' to this work order');
  try {
    const { logAudit } = require('./audit');
    await logAudit({ entity_type: 'invoice', entity_id: inv.id, entity_number: String(inv.invoice_number), action: 'wo_link',
      user_id: user ? user.id : null, user_name: user ? user.name : 'System',
      details: { work_order_id: wo.id, wo_ref: wo.wo_ref || null, how: how, trip_group: gid } });
  } catch (e) {}
  return true;
}

// Work orders (with a sign-off sheet) that this invoice could belong to.
// Returns [{ wo, gid, how }] de-duplicated by trip group.
async function jobsMatchingInvoice(inv) {
  const found = {};
  // a) a sheet that already names this invoice number
  if (inv.invoice_number) {
    const r = await pool.query(
      'SELECT wo.id, wo.wo_ref, wo.account_id, wo.signoff_id, COALESCE(sf.trip_group_id, sf.id) AS gid ' +
      'FROM signoff_forms sf JOIN work_orders wo ON wo.signoff_id IN ' +
      '  (SELECT id FROM signoff_forms s2 WHERE COALESCE(s2.trip_group_id, s2.id) = COALESCE(sf.trip_group_id, sf.id)) ' +
      "WHERE regexp_replace(COALESCE(sf.invoice_number, ''), '[^0-9]', '', 'g') = $1", [String(inv.invoice_number)]);
    r.rows.forEach(function (w) {
      // A sheet number on a different account is a typo, not a match.
      if (inv.account_id && w.account_id && Number(w.account_id) !== Number(inv.account_id)) return;
      found[w.gid] = { wo: w, gid: w.gid, how: 'invoice # on sign-off' };
    });
  }
  // b) same account + PO / WO number
  if (inv.account_id && String(inv.customer_po_wo || '').trim()) {
    const r = await pool.query(
      'SELECT wo.id, wo.wo_ref, wo.account_id, wo.signoff_id, wo.po_number, wo.wo_number, COALESCE(sf.trip_group_id, sf.id) AS gid ' +
      'FROM work_orders wo JOIN signoff_forms sf ON sf.id = wo.signoff_id ' +
      'WHERE wo.account_id = $1 AND wo.revision_of_id IS NULL AND wo.created_at > NOW() - ($2 || \' days\')::interval',
      [inv.account_id, String(LOOKBACK_DAYS)]);
    r.rows.forEach(function (w) {
      if (found[w.gid]) return;
      if (keysMatch(inv.customer_po_wo, w.po_number) || keysMatch(inv.customer_po_wo, w.wo_number)) {
        found[w.gid] = { wo: w, gid: w.gid, how: 'PO / WO # match' };
      }
    });
  }
  return Object.keys(found).map(function (k) { return found[k]; });
}

// Try to auto-link ONE invoice. Returns { linked, reason, wo_id }.
async function autoLinkInvoice(invoiceId) {
  const r = await pool.query('SELECT id, invoice_number, account_id, customer_po_wo, status, signoff_group_id, wo_autolink_off FROM invoices WHERE id = $1', [invoiceId]);
  const inv = r.rows[0];
  if (!inv) return { linked: false, reason: 'not_found' };
  if (inv.signoff_group_id) return { linked: false, reason: 'already_linked' };
  if (inv.wo_autolink_off) return { linked: false, reason: 'unlinked_by_hand' };
  if (inv.status === 'canceled') return { linked: false, reason: 'canceled' };
  const jobs = await jobsMatchingInvoice(inv);
  if (!jobs.length) return { linked: false, reason: 'no_match' };
  // Prefer the strong signal: if exactly one job names this invoice number, take it.
  let pick = jobs.filter(function (j) { return j.how === 'invoice # on sign-off'; });
  if (pick.length !== 1) pick = jobs;
  if (pick.length !== 1) return { linked: false, reason: 'ambiguous', matches: pick.length };
  const j = pick[0];
  if (await liveInvoiceOnGroup(j.gid)) return { linked: false, reason: 'job_has_invoice' };
  const ok = await applyLink(inv, j.wo, j.gid, null, j.how);
  return { linked: ok, reason: ok ? j.how : 'raced', wo_id: j.wo.id };
}

// Try to auto-link a WORK ORDER that has no invoice. Returns { linked, ... }.
async function autoLinkWorkOrder(woId) {
  const r = await pool.query('SELECT id, wo_ref, account_id, signoff_id, po_number, wo_number FROM work_orders WHERE id = $1', [woId]);
  const wo = r.rows[0];
  if (!wo || !wo.signoff_id) return { linked: false, reason: 'no_signoff' };
  const gid = await groupOf(wo.signoff_id);
  if (!gid) return { linked: false, reason: 'no_signoff' };
  if (await liveInvoiceOnGroup(gid)) return { linked: false, reason: 'job_has_invoice' };
  const cands = [];
  // a) invoice numbers typed on this job's sheets
  const nums = (await pool.query(
    "SELECT DISTINCT regexp_replace(invoice_number, '[^0-9]', '', 'g') AS n FROM signoff_forms WHERE (trip_group_id = $1 OR id = $1) AND regexp_replace(COALESCE(invoice_number, ''), '[^0-9]', '', 'g') <> ''", [gid])).rows
    .map(function (x) { return x.n; });
  if (nums.length) {
    const q = await pool.query(
      'SELECT id, invoice_number, account_id, customer_po_wo, status FROM invoices ' +
      'WHERE invoice_number::text = ANY($1::text[]) AND signoff_group_id IS NULL AND wo_autolink_off IS NOT TRUE AND status NOT IN ' + DEAD, [nums]);
    q.rows.forEach(function (i) {
      if (wo.account_id && i.account_id && Number(i.account_id) !== Number(wo.account_id)) return;
      cands.push({ inv: i, how: 'invoice # on sign-off' });
    });
  }
  // b) same account + PO / WO number
  if (!cands.length && wo.account_id && (wo.po_number || wo.wo_number)) {
    const q = await pool.query(
      'SELECT id, invoice_number, account_id, customer_po_wo, status FROM invoices ' +
      'WHERE account_id = $1 AND signoff_group_id IS NULL AND wo_autolink_off IS NOT TRUE AND status NOT IN ' + DEAD +
      " AND TRIM(COALESCE(customer_po_wo, '')) <> '' AND created_at > NOW() - ($2 || ' days')::interval",
      [wo.account_id, String(LOOKBACK_DAYS)]);
    q.rows.forEach(function (i) {
      if (keysMatch(i.customer_po_wo, wo.po_number) || keysMatch(i.customer_po_wo, wo.wo_number)) cands.push({ inv: i, how: 'PO / WO # match' });
    });
  }
  if (cands.length !== 1) return { linked: false, reason: cands.length ? 'ambiguous' : 'no_match', matches: cands.length };
  // The reverse check: that invoice must not match some OTHER job too.
  const back = await jobsMatchingInvoice(cands[0].inv);
  if (back.length > 1 && cands[0].how !== 'invoice # on sign-off') return { linked: false, reason: 'ambiguous', matches: back.length };
  const ok = await applyLink(cands[0].inv, wo, gid, null, cands[0].how);
  return { linked: ok, reason: ok ? cands[0].how : 'raced', invoice_id: cands[0].inv.id };
}

// Background sweep: every unlinked, non-canceled invoice on an account from the
// look-back window. Cheap: a handful of rows a day.
let _lastSweep = 0;
async function sweep(opts) {
  opts = opts || {};
  const now = Date.now();
  if (opts.throttleMs && now - _lastSweep < opts.throttleMs) return { skipped: true };
  _lastSweep = now;
  const out = { checked: 0, linked: 0 };
  try {
    const r = await pool.query(
      'SELECT id FROM invoices WHERE signoff_group_id IS NULL AND wo_autolink_off IS NOT TRUE AND status NOT IN ' + DEAD +
      " AND created_at > NOW() - ($1 || ' days')::interval AND (account_id IS NOT NULL OR invoice_number IS NOT NULL) ORDER BY id DESC LIMIT 500",
      [String(LOOKBACK_DAYS)]);
    for (let i = 0; i < r.rows.length; i++) {
      out.checked++;
      try { const res = await autoLinkInvoice(r.rows[i].id); if (res.linked) out.linked++; }
      catch (e) { console.error('[invoice-wo-link] invoice ' + r.rows[i].id + ':', e && e.message); }
    }
  } catch (e) { console.error('[invoice-wo-link] sweep failed:', e && e.message); }
  if (out.linked) console.log('[invoice-wo-link] sweep linked ' + out.linked + ' invoice(s) to work orders');
  return out;
}

// Invoices a person could link to this work order by hand. Suggested ones
// (same account + PO/WO match, or named on the sheet) come first. q searches
// invoice #, PO and customer across ALL accounts, for the invoice that was
// put on the wrong account or none.
async function candidatesFor(woId, q) {
  const wo = (await pool.query('SELECT id, account_id, account_name, signoff_id, po_number, wo_number FROM work_orders WHERE id = $1', [woId])).rows[0];
  if (!wo) return null;
  const gid = await groupOf(wo.signoff_id);
  const sheetNums = gid ? (await pool.query(
    "SELECT DISTINCT regexp_replace(invoice_number, '[^0-9]', '', 'g') AS n FROM signoff_forms WHERE (trip_group_id = $1 OR id = $1) AND regexp_replace(COALESCE(invoice_number, ''), '[^0-9]', '', 'g') <> ''", [gid])).rows.map(function (x) { return x.n; }) : [];
  const params = [];
  let where = 'i.signoff_group_id IS NULL AND i.status NOT IN ' + DEAD;
  const term = String(q || '').trim();
  if (term) {
    params.push('%' + term + '%');
    where += ' AND (i.invoice_number::text ILIKE $1 OR i.customer_po_wo ILIKE $1 OR i.customer_name ILIKE $1 OR i.account_name ILIKE $1)';
  } else if (wo.account_id || sheetNums.length) {
    params.push(wo.account_id || 0);
    params.push(sheetNums);
    where += " AND (i.account_id = $1 OR i.invoice_number::text = ANY($2::text[])) AND i.created_at > NOW() - INTERVAL '" + LOOKBACK_DAYS + " days'";
  } else {
    where += " AND i.created_at > NOW() - INTERVAL '30 days'";
  }
  const r = await pool.query(
    'SELECT i.id, i.invoice_number, i.status, i.account_id, i.account_name, i.customer_po_wo, i.customer_name, i.grand_total, ' +
    '  i.invoice_date, i.created_at, i.wo_autolink_off, COALESCE(u.name, i.locksmith_name) AS locksmith ' +
    'FROM invoices i LEFT JOIN users u ON u.id = i.locksmith_id WHERE ' + where + ' ORDER BY i.id DESC LIMIT 60', params);
  const rows = r.rows.map(function (i) {
    const named = sheetNums.indexOf(String(i.invoice_number)) !== -1;
    const sameAcct = !!(wo.account_id && i.account_id && Number(i.account_id) === Number(wo.account_id));
    const poHit = sameAcct && (keysMatch(i.customer_po_wo, wo.po_number) || keysMatch(i.customer_po_wo, wo.wo_number));
    i.suggested = named || poHit;
    i.match = named ? 'Invoice # is on the sign-off sheet' : (poHit ? 'Same account and PO / WO #' : (sameAcct ? 'Same account' : ''));
    return i;
  });
  rows.sort(function (a, b) { return (b.suggested ? 1 : 0) - (a.suggested ? 1 : 0) || b.id - a.id; });
  const current = gid ? await liveInvoiceOnGroup(gid) : null;
  return { work_order: { id: wo.id, account_name: wo.account_name, po_number: wo.po_number, wo_number: wo.wo_number, has_signoff: !!gid }, current: current, invoices: rows };
}

// Manual link. Returns { ok } or { error, status }.
async function linkByHand(woId, invoiceId, user) {
  const wo = (await pool.query('SELECT id, wo_ref, status, signoff_id FROM work_orders WHERE id = $1', [woId])).rows[0];
  if (!wo) return { error: 'Work order not found', status: 404 };
  const gid = await groupOf(wo.signoff_id);
  if (!gid) return { error: 'This work order has no sign-off sheet yet, so there is nothing to attach an invoice to.', status: 400 };
  const inv = (await pool.query('SELECT id, invoice_number, status, signoff_group_id FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv) return { error: 'Invoice not found', status: 404 };
  if (inv.status === 'canceled') return { error: 'Invoice #' + inv.invoice_number + ' is canceled.', status: 400 };
  if (inv.signoff_group_id && Number(inv.signoff_group_id) !== Number(gid)) {
    return { error: 'Invoice #' + inv.invoice_number + ' is already on another work order. Unlink it there first.', status: 409 };
  }
  const live = await liveInvoiceOnGroup(gid);
  if (live && Number(live.id) !== Number(inv.id)) {
    return { error: 'This work order already has invoice #' + live.invoice_number + '. Unlink it first.', status: 409 };
  }
  if (live && Number(live.id) === Number(inv.id)) return { ok: true, already: true };
  const ok = await applyLink(inv, wo, gid, user, 'manual');
  return ok ? { ok: true } : { error: 'Could not link the invoice', status: 500 };
}

async function unlinkByHand(woId, user) {
  const wo = (await pool.query('SELECT id, status, signoff_id, paperwork_state FROM work_orders WHERE id = $1', [woId])).rows[0];
  if (!wo) return { error: 'Work order not found', status: 404 };
  if (wo.status === 'paperwork_sent' || wo.paperwork_state === 'sent') {
    return { error: 'The paperwork for this job was already sent. Reopen it in Completion Paperwork before changing the invoice.', status: 409 };
  }
  const gid = await groupOf(wo.signoff_id);
  if (!gid) return { error: 'No invoice is linked.', status: 400 };
  const live = await liveInvoiceOnGroup(gid);
  if (!live) return { error: 'No invoice is linked.', status: 400 };
  await pool.query('UPDATE invoices SET signoff_group_id = NULL, wo_autolink_off = true, updated_at = NOW() WHERE id = $1', [live.id]);
  // Clear the number off the sheets only where it is THIS invoice's number.
  try {
    await pool.query("UPDATE signoff_forms SET invoice_number = NULL, updated_at = NOW() WHERE (trip_group_id = $1 OR id = $1) AND TRIM(invoice_number) = $2 AND status = 'pending'",
      [gid, String(live.invoice_number)]);
  } catch (e) {}
  await activity(wo.id, user, 'unlinked invoice #' + live.invoice_number + ' from this work order');
  try {
    const { logAudit } = require('./audit');
    await logAudit({ entity_type: 'invoice', entity_id: live.id, entity_number: String(live.invoice_number), action: 'wo_unlink',
      user_id: user ? user.id : null, user_name: user ? user.name : null, details: { work_order_id: wo.id, trip_group: gid } });
  } catch (e) {}
  return { ok: true, invoice_number: live.invoice_number };
}

module.exports = {
  normKeys: normKeys, keysMatch: keysMatch,
  autoLinkInvoice: autoLinkInvoice, autoLinkWorkOrder: autoLinkWorkOrder, sweep: sweep,
  candidatesFor: candidatesFor, linkByHand: linkByHand, unlinkByHand: unlinkByHand
};
