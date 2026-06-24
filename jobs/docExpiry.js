const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { broadcastRecipients } = require('../utils/notify');

// Recipients for expiry alerts are configured in Settings -> Notifications under
// 'Document expiration reminder' (Nova users + a distribution list). When no rule
// is set, fall back to all admins and managers.
const DOC_EXPIRY_EVENT = 'document_expiring';
const DEFAULT_WHERE = "role IN ('admin','manager')";

function etToday() {
  // Calendar date in America/New_York (matches the cron timezone), as YYYY-MM-DD.
  var s = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' });
  return s.slice(0, 10);
}

function leadDate(expISO, num, unit) {
  var d = new Date(expISO + 'T00:00:00');
  num = parseInt(num, 10) || 0;
  if (unit === 'days') d.setDate(d.getDate() - num);
  else if (unit === 'weeks') d.setDate(d.getDate() - num * 7);
  else if (unit === 'months') d.setMonth(d.getMonth() - num);
  return d;
}

function fmtDate(expISO) {
  var d = new Date(expISO + 'T00:00:00');
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

async function sendExpiryReminders() {
  try {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const todayISO = etToday();
    const today = new Date(todayISO + 'T00:00:00');

    const { rows } = await pool.query(
      "SELECT id, name, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, " +
      '       reminder_lead_num, reminder_lead_unit, reminder_sent_at, expiry_notice_sent_at ' +
      "FROM documents WHERE status = 'ready' AND expires_on IS NOT NULL"
    );
    if (!rows.length) { console.log('[docExpiry] No documents with expiration dates.'); return; }

    var expiring = [];
    var expired = [];
    rows.forEach(function (d) {
      var exp = new Date(d.expires_on + 'T00:00:00');
      if (today.getTime() >= exp.getTime()) {
        if (!d.expiry_notice_sent_at) expired.push(d);
      } else {
        var lead = leadDate(d.expires_on, d.reminder_lead_num, d.reminder_lead_unit);
        if (today.getTime() >= lead.getTime() && !d.reminder_sent_at) expiring.push(d);
      }
    });

    if (!expiring.length && !expired.length) { console.log('[docExpiry] Nothing due today.'); return; }

    const recips = await broadcastRecipients(DOC_EXPIRY_EVENT, DEFAULT_WHERE);
    const emails = recips.emails || [];
    if (!emails.length) {
      console.log('[docExpiry] No recipients configured — marking as notified to avoid pile-up.');
    }

    const vaultUrl = appUrl + '/?view=documents';

    if (emails.length && expiring.length) {
      var details = expiring.map(function (d) { return { label: d.name, value: 'Expires ' + fmtDate(d.expires_on) }; });
      var body = 'The following document' + (expiring.length === 1 ? ' is' : 's are') + ' approaching ' +
        (expiring.length === 1 ? 'its' : 'their') + ' expiration date. Please review and renew or replace as needed.';
      var html = emailTemplate({
        badge: 'Expiring Soon', badgeColor: 'orange',
        title: expiring.length + ' document' + (expiring.length === 1 ? '' : 's') + ' expiring soon',
        body: body, details: details,
        buttonText: 'Open Document Vault', buttonUrl: vaultUrl,
        footerNote: 'You\'re receiving this because you are on the document expiration distribution list. Update recipients under Settings &rarr; Notifications.'
      });
      var subj = expiring.length === 1
        ? 'Document expiring soon: ' + expiring[0].name
        : expiring.length + ' documents expiring soon';
      try { await sendEmail(emails, subj, html); console.log('[docExpiry] Sent expiring-soon digest (' + expiring.length + ') to ' + emails.length + ' recipient(s).'); }
      catch (e) { console.error('[docExpiry] expiring email failed:', e.message); }
    }

    if (emails.length && expired.length) {
      var detailsX = expired.map(function (d) { return { label: d.name, value: 'Expired ' + fmtDate(d.expires_on) }; });
      var bodyX = 'The following document' + (expired.length === 1 ? ' has' : 's have') + ' reached ' +
        (expired.length === 1 ? 'its' : 'their') + ' expiration date.';
      var htmlX = emailTemplate({
        badge: 'Expired', badgeColor: 'red',
        title: expired.length + ' document' + (expired.length === 1 ? '' : 's') + ' expired',
        body: bodyX, details: detailsX,
        buttonText: 'Open Document Vault', buttonUrl: vaultUrl,
        footerNote: 'You\'re receiving this because you are on the document expiration distribution list. Update recipients under Settings &rarr; Notifications.'
      });
      var subjX = expired.length === 1
        ? 'Document expired: ' + expired[0].name
        : expired.length + ' documents expired';
      try { await sendEmail(emails, subjX, htmlX); console.log('[docExpiry] Sent expired digest (' + expired.length + ') to ' + emails.length + ' recipient(s).'); }
      catch (e) { console.error('[docExpiry] expired email failed:', e.message); }
    }

    // Mark as notified so each phase only fires once (also when no recipients, to avoid pile-up).
    if (expiring.length) {
      await pool.query('UPDATE documents SET reminder_sent_at = NOW() WHERE id = ANY($1::int[])', [expiring.map(function (d) { return d.id; })]);
    }
    if (expired.length) {
      await pool.query('UPDATE documents SET expiry_notice_sent_at = NOW() WHERE id = ANY($1::int[])', [expired.map(function (d) { return d.id; })]);
    }
  } catch (err) {
    console.error('[docExpiry] Job failed:', err.message);
  }
}

function startDocExpiry() {
  cron.schedule('0 8 * * *', function () {
    console.log('[docExpiry] Running daily document expiration job\u2026');
    sendExpiryReminders();
  }, { timezone: 'America/New_York' });
  console.log('[docExpiry] Daily document expiration job scheduled (08:00 America/New_York)');
}

module.exports = { startDocExpiry, sendExpiryReminders };
