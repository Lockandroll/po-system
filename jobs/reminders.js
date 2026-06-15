const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail } = require('../utils/email');

function buildReminderEmail(ordererName, pos, appUrl) {
  var rows = pos.map(function(po) {
    var deepLink = appUrl + '?view=view&id=' + po.id;
    var age = Math.floor((Date.now() - new Date(po.approved_at || po.created_at).getTime()) / 86400000);
    var ageStr = age === 0 ? 'today' : age === 1 ? '1 day ago' : age + ' days ago';
    return '<tr>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;font-weight:700;color:#111111">' + po.po_number + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #eeeeee;font-size:13px;color:#444444">' + (po.vendor_name || '—') + '</td>' +
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
    '<h1 style="font-size:20px;font-weight:700;color:#111111;margin:0 0 12px">Hi ' + ordererName + ',</h1>' +
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

async function sendOrderReminders() {
  try {
    const appUrl = process.env.APP_URL || 'http://localhost:3000';

    const { rows } = await pool.query(
      'SELECT po.id, po.po_number, po.vendor_name, po.total_amount, po.approved_at, po.created_at, ' +
      '       u.id AS orderer_id, u.name AS orderer_name, u.email AS orderer_email ' +
      'FROM purchase_orders po ' +
      'JOIN users u ON po.orderer_id = u.id ' +
      "WHERE po.status = 'approved' AND u.active = true AND u.receive_emails = true " +
      'ORDER BY u.id, po.created_at ASC'
    );

    if (!rows.length) {
      console.log('[reminders] No pending ordered POs — skipping.');
      return;
    }

    var byOrderer = {};
    rows.forEach(function(row) {
      if (!byOrderer[row.orderer_id]) {
        byOrderer[row.orderer_id] = { name: row.orderer_name, email: row.orderer_email, pos: [] };
      }
      byOrderer[row.orderer_id].pos.push(row);
    });

    for (var id in byOrderer) {
      var orderer = byOrderer[id];
      var subject = orderer.pos.length === 1
        ? 'Reminder: 1 PO needs to be ordered — ' + orderer.pos[0].po_number
        : 'Reminder: ' + orderer.pos.length + ' POs need to be ordered';
      var html = buildReminderEmail(orderer.name, orderer.pos, appUrl);
      await sendEmail(orderer.email, subject, html);
      console.log('[reminders] Sent reminder to ' + orderer.email + ' (' + orderer.pos.length + ' POs)');
    }
  } catch (err) {
    console.error('[reminders] Job failed:', err.message);
  }
}

function startReminders() {
  cron.schedule('0 8 * * *', function() {
    console.log('[reminders] Running daily order reminder job…');
    sendOrderReminders();
  });
  console.log('[reminders] Daily order reminder job scheduled (08:00 daily)');
}

module.exports = { startReminders, sendOrderReminders };
