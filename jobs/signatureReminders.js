const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');

function signLink(token) { return (process.env.APP_URL || '').replace(/\/$/, '') + '/sign/' + token; }

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

function startSignatureReminders() {
  cron.schedule('0 9 * * *', function () {
    console.log('[sigReminders] Running daily signature reminder job…');
    runSignatureReminders();
  }, { timezone: 'America/New_York' });
  console.log('[sigReminders] Daily signature reminder job scheduled (09:00 America/New_York)');
}

module.exports = { startSignatureReminders, runSignatureReminders };
