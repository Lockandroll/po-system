const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail } = require('../utils/email');
const { sendSms } = require('../utils/sms');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildReminderEmail(ordererName, pos, appUrl) {
  var rows = pos.map(function(po) {
    var deepLink = appUrl + '?view=view&id=' + po.id;
    var age = Math.floor((Date.now() - new Date(po.approved_at || po.created_at).getTime()) / 86400000);
    var ageStr = age === 0 ? 'today' : age === 1 ? '1 day ago' : age + ' days ago';
    return '<tr>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;font-weight:700;color:#111111">' + esc(po.po_number) + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;color:#444444">' + esc(po.vendor_name || '—') + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;color:#444444">$' + parseFloat(po.total_amount || 0).toFixed(2) + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;color:#888888">' + ageStr + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;text-align:center">' +
        '<a href="' + deepLink + '" style="display:inline-block;background:#f97316;color:#ffffff;font-size:12px;font-weight:700;padding:6px 14px;border-radius:4px;text-decoration:none">View PO</a>' +
      '</td>' +
    '</tr>';
  }).join('');

  var count = pos.length;
  var plural = count === 1 ? 'PO' : 'POs';

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body style="margin:0;padding:0;background:#e5e5e5;font-family:-apple-system,Helvetica Neue,Arial,sans-serif">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:32px 16px">' +
  '<table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden">' +

  '<tr><td style="background:#111111;padding:20px 28px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="background:#f97316;width:36px;height:36px;border-radius:6px;text-align:center;vertical-align:middle;font-size:18px;line-height:36px">🔒</td>' +
      '<td style="padding-left:12px;color:#ffffff;font-size:16px;font-weight:700;vertical-align:middle">Lock and Roll LLC</td>' +
    '</tr></table>' +
  '</td></tr>' +

  '<tr><td style="padding:32px 28px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:16px"><tr>' +
      '<td style="background:#fff3e8;color:#c2520a;font-size:11px;font-weight:700;padding:4px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">Order Reminder</td>' +
    '</tr></table>' +
    '<h1 style="font-size:20px;font-weight:700;color:#111111;margin:0 0 12px">Hi ' + esc(ordererName) + ',</h1>' +
    '<p style="font-size:14px;color:#555555;line-height:1.6;margin:0 0 24px">You have <strong>' + count + ' approved ' + plural + '</strong> waiting to be ordered. Please place the order and mark ' + (count === 1 ? 'it' : 'them') + ' as ordered in the system.</p>' +

    '<table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #eeeeee;border-radius:6px;overflow:hidden;margin-bottom:28px">' +
      '<thead><tr style="background:#f7f7f7">' +
        '<th style="padding:10px 12px;font-size:12px;color:#888888;font-weight:700;text-align:left;border-bottom:1px solid #eeeeee">PO #</th>' +
        '<th style="padding:10px 12px;font-size:12px;color:#888888;font-weight:700;text-align:left;border-bottom:1px solid #eeeeee">Vendor</th>' +
        '<th style="padding:10px 12px;font-size:12px;color:#888888;font-weight:700;text-align:left;border-bottom:1px solid #eeeeee">Total</th>' +
        '<th style="padding:10px 12px;font-size:12px;color:#888888;font-weight:700;text-align:left;border-bottom:1px solid #eeeeee">Approved</th>' +
        '<th style="padding:10px 12px;font-size:12px;color:#888888;font-weight:700;text-align:center;border-bottom:1px solid #eeeeee"></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +

    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #eeeeee;padding-top:20px">' +
      '<p style="font-size:12px;color:#aaaaaa;line-height:1.6;margin:0">You\'re receiving this daily reminder because you are assigned as the orderer on these POs. Notification preferences can be updated in your account settings.</p>' +
    '</td></tr></table>' +
  '</td></tr>' +

  '</table></td></tr></table>' +
  '</body></html>';
}

const OVERSIGHT_EMAIL = 'rbeechly@popalockar.com';

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'Someone';
}

async function sendOrderReminders() {
  try {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    const { rows } = await pool.query(
      'SELECT po.id, po.po_number, po.vendor_name, po.total_amount, po.approved_at, po.created_at, ' +
      '       u.id AS orderer_id, u.name AS orderer_name, u.email AS orderer_email, u.phone AS orderer_phone, ' +
      '       u.receive_emails AS orderer_receive_emails, u.receive_sms AS orderer_receive_sms ' +
      'FROM purchase_orders po ' +
      'JOIN users u ON po.orderer_id = u.id ' +
      "WHERE po.status = 'approved' AND u.active = true " +
      'ORDER BY u.id, po.created_at ASC'
    );

    if (!rows.length) {
      console.log('[reminders] No approved-unordered POs — skipping.');
      return;
    }

    var byOrderer = {};
    var allPos = [];
    rows.forEach(function (row) {
      if (!byOrderer[row.orderer_id]) {
        byOrderer[row.orderer_id] = {
          name: row.orderer_name, email: row.orderer_email, phone: row.orderer_phone,
          receive_emails: row.orderer_receive_emails, receive_sms: row.orderer_receive_sms, pos: []
        };
      }
      byOrderer[row.orderer_id].pos.push(row);
      allPos.push(row);
    });

    var oversightTexts = [];

    for (var id in byOrderer) {
      var orderer = byOrderer[id];
      var fn = firstName(orderer.name);
      var subject = orderer.pos.length === 1
        ? 'Reminder: 1 PO needs to be ordered — ' + orderer.pos[0].po_number
        : 'Reminder: ' + orderer.pos.length + ' POs need to be ordered';
      if (orderer.receive_emails !== false && orderer.email) {
        try {
          await sendEmail(orderer.email, subject, buildReminderEmail(orderer.name, orderer.pos, appUrl));
          console.log('[reminders] Emailed ' + orderer.email + ' (' + orderer.pos.length + ' POs)');
        } catch (e) { console.error('[reminders] orderer email failed:', e.message); }
      }
      if (orderer.receive_sms && orderer.phone) {
        try { await sendSms([orderer.phone], fn + ' has a PO that has been approved, but not marked as ordered.'); } catch (e) { console.error('[reminders] orderer sms failed:', e.message); }
      }
      oversightTexts.push(fn + ' has a PO that has been approved, but not marked as ordered.');
    }

    // Oversight: Russ gets an email summary of all pending POs + a text per orderer
    try {
      const { rows: ov } = await pool.query('SELECT name, email, phone FROM users WHERE LOWER(email) = $1 LIMIT 1', [OVERSIGHT_EMAIL]);
      if (ov.length) {
        const russ = ov[0];
        if (russ.email) {
          const subj = allPos.length === 1 ? 'Oversight: 1 PO approved but not ordered' : 'Oversight: ' + allPos.length + ' POs approved but not ordered';
          await sendEmail(russ.email, subj, buildReminderEmail(firstName(russ.name), allPos, appUrl));
          console.log('[reminders] Oversight email sent to ' + russ.email);
        }
        if (russ.phone && oversightTexts.length) {
          await sendSms([russ.phone], oversightTexts.join(' '));
          console.log('[reminders] Oversight text sent to ' + russ.phone);
        }
      } else {
        console.log('[reminders] Oversight user ' + OVERSIGHT_EMAIL + ' not found — skipping oversight.');
      }
    } catch (e) { console.error('[reminders] oversight notify failed:', e.message); }
  } catch (err) {
    console.error('[reminders] Job failed:', err.message);
  }
}

function startReminders() {
  cron.schedule('0 8 * * *', function () {
    console.log('[reminders] Running daily order reminder job…');
    sendOrderReminders();
  }, { timezone: 'America/New_York' });
  console.log('[reminders] Daily order reminder job scheduled (08:00 America/New_York)');
}

module.exports = { startReminders, sendOrderReminders };
