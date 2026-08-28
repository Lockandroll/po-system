const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');

function signLink(token) { return (process.env.APP_URL || '').replace(/\/$/, '') + '/sign/' + token; }
function releaseLink(token) { return (process.env.APP_URL || '').replace(/\/$/, '') + '/release/' + token; }

// Daily: (1) expire any sent request past its expires_at, (2) nudge every still-pending
// signer of an active request. Parallel signing, so all pending signers get reminded.
async function runSignatureReminders() {
  try {
    const overdue = (await pool.query(
      "SELECT id FROM signature_requests WHERE status IN ('sent','partially_signed') AND expires_at IS NOT NULL AND expires_at < NOW()"
    )).rows;
    for (var i = 0; i < overdue.length; i++) {
      await pool.query("UPDATE signature_requests SET status = 'expired', updated_at = NOW() WHERE id = $1", [overdue[i].id]);
      await pool.query("UPDATE signature_signers SET token = NULL WHERE request_id = $1", [overdue[i].id]);
      await pool.query("INSERT INTO signature_events (request_id, event_type, actor) VALUES ($1, 'expired', 'system')", [overdue[i].id]);
    }

    const rows = (await pool.query(
      "SELECT s.id, s.request_id, s.name, s.email, s.phone, s.token, r.title, r.request_number " +
      "FROM signature_signers s JOIN signature_requests r ON r.id = s.request_id " +
      "WHERE r.status IN ('sent','partially_signed') AND s.status IN ('pending','viewed') AND s.token IS NOT NULL " +
      "AND (s.token_expires_at IS NULL OR s.token_expires_at > NOW())"
    )).rows;
    if (!rows.length) { console.log('[sigReminders] Nothing due. Expired ' + overdue.length + ' request(s).'); return; }

    var n = 0;
    for (var j = 0; j < rows.length; j++) {
      var s = rows[j];
      if (!s.email) continue;
      var link = signLink(s.token);
      var html = emailTemplate({
        badge: 'Reminder', badgeColor: 'orange',
        title: 'Reminder: please sign ' + s.title,
        body: 'Hi ' + (s.name || 'there') + ',<br><br>This is a friendly reminder that a document is waiting for your signature.',
        details: [{ label: 'Document', value: s.title }, { label: 'Reference', value: s.request_number }],
        buttonText: 'Review & sign', buttonUrl: link,
        footerNote: 'Secure, single-use signing link. Do not forward it.'
      });
      try { await sendEmail(s.email, 'Reminder: ' + s.title, html); n++; } catch (e) { console.error('[sigReminders] email failed:', e.message); }
      if (s.phone) { try { await sendSms(s.phone, 'Reminder: please sign ' + s.title + ' ' + link); } catch (e) {} }
      try { await pool.query("INSERT INTO signature_events (request_id, signer_id, event_type, actor) VALUES ($1, $2, 'reminder_sent', 'system')", [s.request_id, s.id]); } catch (e) {}
    }
    console.log('[sigReminders] Reminded ' + n + ' signer(s); expired ' + overdue.length + ' request(s).');
  } catch (err) {
    console.error('[sigReminders] Job failed:', err.message);
  }
}

// Releases of liability ride on the same 9am pass rather than a second cron:
// the shape of the work is identical (expire what is stale, nudge what is
// live), and one job means one place to look when a customer says they never
// got the link. Its own try/catch, so a release failure cannot stop the
// signature reminders above from running - or the reverse.
async function runReleaseReminders() {
  try {
    const overdue = (await pool.query(
      "SELECT id FROM release_forms WHERE status = 'sent' AND customer_token_expires_at IS NOT NULL AND customer_token_expires_at < NOW()"
    )).rows;
    for (var i = 0; i < overdue.length; i++) {
      await pool.query("UPDATE release_forms SET status = 'expired', customer_token = NULL, updated_at = NOW() WHERE id = $1", [overdue[i].id]);
      await pool.query("INSERT INTO release_events (release_id, event_type, actor) VALUES ($1, 'expired', 'system')", [overdue[i].id]);
    }

    // Nudge on days 3, 7 and 11 of a 14-day link rather than every morning. A
    // release is a request for someone's signature on a legal document; a daily
    // email about it reads as harassment, not a reminder.
    const rows = (await pool.query(
      "SELECT id, release_number, claimant_name, claimant_email, claimant_phone, customer_token, settlement_amount " +
      "FROM release_forms WHERE status = 'sent' AND customer_token IS NOT NULL " +
      "AND (customer_token_expires_at IS NULL OR customer_token_expires_at > NOW()) " +
      "AND sent_at IS NOT NULL AND FLOOR(EXTRACT(EPOCH FROM (NOW() - sent_at)) / 86400) IN (3, 7, 11)"
    )).rows;
    if (!rows.length) { console.log('[releaseReminders] Nothing due. Expired ' + overdue.length + ' release(s).'); return; }

    var n = 0;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var link = releaseLink(r.customer_token);
      if (r.claimant_email) {
        var html = emailTemplate({
          badge: 'Reminder', badgeColor: 'orange',
          title: 'Reminder: your release is waiting for a signature',
          body: 'Hi ' + (String(r.claimant_name || 'there').split(' ')[0]) + ',<br><br>' +
                'Your release of liability is still waiting to be signed. It only takes a minute on your phone.',
          details: [{ label: 'Reference', value: r.release_number }],
          buttonText: 'Review and sign', buttonUrl: link,
          footerNote: 'Secure, single-use link. Please do not forward it.'
        });
        try { await sendEmail(r.claimant_email, 'Reminder: release of liability ' + r.release_number, html); n++; }
        catch (e) { console.error('[releaseReminders] email failed:', e.message); }
      }
      if (r.claimant_phone) {
        try { await sendSms(r.claimant_phone, 'Reminder: your release of liability is waiting for your signature. ' + link); } catch (e) {}
      }
      try { await pool.query("INSERT INTO release_events (release_id, event_type, actor) VALUES ($1, 'reminder_sent', 'system')", [r.id]); } catch (e) {}
    }
    console.log('[releaseReminders] Reminded ' + n + ' claimant(s); expired ' + overdue.length + ' release(s).');
  } catch (err) {
    console.error('[releaseReminders] Job failed:', err.message);
  }
}

function startSignatureReminders() {
  cron.schedule('0 9 * * *', function () {
    console.log('[sigReminders] Running daily signature reminder job…');
    runSignatureReminders();
    runReleaseReminders();
  }, { timezone: 'America/New_York' });
  console.log('[sigReminders] Daily signature + release reminder job scheduled (09:00 America/New_York)');
}

module.exports = { startSignatureReminders, runSignatureReminders, runReleaseReminders };
