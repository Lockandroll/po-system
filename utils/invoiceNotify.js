const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('./email');
const notify = require('./notify');
const push = require('./push');

// "New invoice" notification, sent when an invoice is FINISHED, not when the
// row is first inserted.
//
// It used to fire from the create handler. Almost every invoice is created as
// a $0 draft (the sign-off route makes one with only the account's standard
// lines; the editor lets a tech save a described-but-unpriced line), and the
// real labor and parts land on a later PUT, which never notified anyone. So the
// email that reached the owners said "Grand Total $0.00" for a $165 job.
//
// There are four ways an invoice reaches 'paid', and every one of them calls
// this: POST / with status paid, PUT /:id moving to paid, POST /:id/complete,
// and the Square narrow writer in utils/square.js. Each call reads the row
// FRESH, so whatever total is on the invoice at the finish line is what goes
// out, tip and surcharge included.
//
// Sent at most once per completion. notified_complete_at is claimed in the same
// UPDATE that checks it, so two callers racing over the same finish (a Square
// webhook and a Re-check Square click, say) cannot both send. Reopen clears it,
// so an invoice that is reopened, corrected and finished again notifies again
// with the corrected total, which is the one people need to see.
//
// Fire and forget from the caller's point of view: nothing here throws. A
// notification failing must never fail the finish that triggered it.
//
// The rule key stays 'invoice_created' so every recipient list already
// configured under Settings keeps working.
function money(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }

function payTypeLabel(inv) {
  var t = String(inv.pay_type || '').trim();
  if (!t) return '—';
  if (inv.card_last4) t += ' •••• ' + inv.card_last4;
  return t;
}

async function notifyInvoiceFinished(invoiceId, actor) {
  try {
    const claim = await pool.query(
      "UPDATE invoices SET notified_complete_at = NOW() " +
      "WHERE id = $1 AND status IN ('paid', 'partially_refunded', 'refunded') AND notified_complete_at IS NULL RETURNING *",
      [invoiceId]
    );
    if (!claim.rows.length) return false;
    const inv = claim.rows[0];
    const who = (actor && actor.name) ? actor.name : (inv.locksmith_name || 'A technician');
    const num = String(inv.invoice_number || inv.id);

    const _q = await notify.broadcastRecipients('invoice_created', "role IN ('admin', 'owner')");
    try {
      await push.sendPushToUsers(_q.userIds, {
        title: 'Invoice finished',
        body: who + ' finished invoice #' + num + ' for ' + money(inv.grand_total) + '.',
        url: '/?view=view-invoice&id=' + inv.id
      });
    } catch (e) { console.error('Invoice finished push failed:', e); }

    if (!(_q.emails && _q.emails.length)) return true;
    const details = [
      { label: 'Invoice #', value: num },
      { label: 'Customer', value: inv.customer_name || '—' },
      { label: 'Account', value: inv.account_name || '—' },
      { label: 'Customer PO / WO', value: inv.customer_po_wo || '—' },
      { label: 'Locksmith', value: inv.locksmith_name || '—' },
      { label: 'Labor', value: money(inv.labor_amount) },
      { label: 'Parts', value: money(inv.parts_amount) },
      { label: 'Tax', value: money(inv.tax_amount) }
    ];
    if ((parseFloat(inv.surcharge_amount) || 0) > 0) details.push({ label: 'Card surcharge', value: money(inv.surcharge_amount) });
    if ((parseFloat(inv.tip_amount) || 0) > 0) details.push({ label: 'Tip', value: money(inv.tip_amount) });
    details.push({ label: 'Grand Total', value: money(inv.grand_total) });
    details.push({ label: 'Pay type', value: payTypeLabel(inv) });
    details.push({ label: 'Finished by', value: who });

    const html = emailTemplate({
      badge: 'Invoice finished', badgeColor: 'green', title: 'An invoice was finished',
      body: '<strong>' + esc(who) + '</strong> finished invoice #' + esc(num) + ' for <strong>' + money(inv.grand_total) + '</strong>.',
      details: details,
      buttonText: 'View Invoice',
      buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-invoice&id=' + inv.id
    });
    await sendEmail(_q.emails, 'Invoice #' + num + ' finished: ' + money(inv.grand_total), html);
    return true;
  } catch (e) {
    console.error('Invoice finished notify failed:', e);
    return false;
  }
}

function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

module.exports = { notifyInvoiceFinished: notifyInvoiceFinished };
