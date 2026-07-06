const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { broadcastRecipients } = require('../utils/notify');
const push = require('../utils/push');

// Escalation recipients when vehicles go uninspected. Configurable in
// Settings -> Notifications under 'Vehicle inspection overdue'; falls back to
// all admins and managers.
const OVERDUE_EVENT = 'inspection_overdue';
const DEFAULT_WHERE = "role IN ('admin','manager')";

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + (path || '');
}

// Calendar info in America/New_York.
function etParts() {
  var s = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD, ...
  var date = s.slice(0, 10);
  var y = parseInt(date.slice(0, 4), 10);
  var m = parseInt(date.slice(5, 7), 10);
  var d = parseInt(date.slice(8, 10), 10);
  return { ymd: date, month: date.slice(0, 7), year: y, mon: m, day: d, lastDay: new Date(y, m, 0).getDate() };
}

async function getCutoffDay() {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'inspection_cutoff_day'");
    if (rows.length && rows[0].value) {
      var n = parseInt(rows[0].value, 10);
      if (n >= 1 && n <= 31) return n;
    }
  } catch (e) {}
  return 25;
}

// Vehicles that are active, not exempt, and have no inspection for the given month.
async function missingForMonth(month) {
  const { rows } = await pool.query(
    'SELECT v.id, v.year, v.make_model, v.license_plate, v.city_code, v.assigned_user_id, ' +
    'u.name as driver_name, u.email as driver_email, u.phone as driver_phone, ' +
    'u.receive_emails as driver_receive_emails, u.receive_sms as driver_receive_sms ' +
    'FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id ' +
    'WHERE v.active = true AND v.inspection_exempt = false ' +
    'AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = $1)',
    [month]
  );
  return rows;
}

// Nudge each assigned driver whose vehicle is still uninspected this month.
async function nudgeDrivers() {
  var p = etParts();
  var missing = await missingForMonth(p.month);
  for (const v of missing) {
    if (!v.assigned_user_id) continue;
    var label = v.year + ' ' + (v.make_model || 'vehicle') + (v.license_plate ? ' (' + v.license_plate + ')' : '');
    try { await push.sendPushToUsers([v.assigned_user_id], { title: 'Monthly vehicle inspection due', body: 'Please complete the inspection for ' + label + '.', url: '/' }); } catch (e) {}
    if (v.driver_receive_emails !== false && v.driver_email) {
      var html = emailTemplate({
        badge: 'Reminder',
        title: 'Monthly vehicle inspection due',
        body: 'Your assigned vehicle still needs its monthly inspection. Please complete it before the end of the month.',
        details: [
          { label: 'Vehicle', value: label },
          { label: 'City', value: v.city_code || '—' },
          { label: 'Month', value: p.month }
        ],
        buttonText: 'Start inspection',
        buttonUrl: appUrl('?view=inspection-form&id=' + v.id)
      });
      try { await sendEmail(v.driver_email, 'Reminder: monthly inspection due for ' + label, html); } catch (e) { console.error('inspection nudge email failed:', e.message); }
    }
    if (v.driver_receive_sms && v.driver_phone) {
      try { await sendSms(v.driver_phone, 'Lock & Roll: Monthly inspection due for ' + label + '. Complete it here: ' + appUrl('?view=inspection-form&id=' + v.id)); } catch (e) {}
    }
  }
  return missing.length;
}

// After a month closes, escalate the vehicles that were never inspected to managers.
async function escalateOverdue() {
  var p = etParts();
  // Previous month (YYYY-MM).
  var prevY = p.mon === 1 ? p.year - 1 : p.year;
  var prevM = p.mon === 1 ? 12 : p.mon - 1;
  var prevMonth = prevY + '-' + String(prevM).padStart(2, '0');
  var missing = await missingForMonth(prevMonth);
  if (!missing.length) return 0;
  const rec = await broadcastRecipients(OVERDUE_EVENT, DEFAULT_WHERE);
  var listRows = missing.map(function (v) {
    return '<tr>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + (v.year + ' ' + (v.make_model || '')) + (v.license_plate ? ' · ' + v.license_plate : '') + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + (v.city_code || '—') + '</td>' +
      '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + (v.driver_name || 'Unassigned') + '</td>' +
    '</tr>';
  }).join('');
  var html = emailTemplate({
    badge: 'Overdue',
    badgeColor: 'red',
    title: missing.length + ' vehicle' + (missing.length === 1 ? '' : 's') + ' were not inspected in ' + prevMonth,
    body: 'The following active vehicles have no completed inspection for ' + prevMonth + ':' +
      '<table style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr>' +
      '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">Vehicle</th>' +
      '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">City</th>' +
      '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">Responsible</th>' +
      '</tr></thead><tbody>' + listRows + '</tbody></table>',
    buttonText: 'Open compliance grid',
    buttonUrl: appUrl('?view=inspections')
  });
  if (rec.emails && rec.emails.length) {
    try { await sendEmail(rec.emails, 'Vehicle inspections overdue for ' + prevMonth, html); } catch (e) { console.error('inspection escalation email failed:', e.message); }
  }
  if (rec.userIds && rec.userIds.length) {
    try { await push.sendPushToUsers(rec.userIds, { title: 'Inspections overdue', body: missing.length + ' vehicles missed ' + prevMonth + ' inspection.', url: '/' }); } catch (e) {}
  }
  return missing.length;
}

async function runDaily() {
  try {
    var p = etParts();
    var cutoff = await getCutoffDay();
    // Escalate the previous month on the 1st.
    if (p.day === 1) { await escalateOverdue(); }
    // Nudge drivers on the cutoff day, then every 2 days until month end.
    if (p.day >= cutoff && ((p.day - cutoff) % 2 === 0 || p.day === p.lastDay)) {
      await nudgeDrivers();
    }
  } catch (err) {
    console.error('inspection reminder run failed:', err.message);
  }
}

function startInspectionReminders() {
  cron.schedule('0 8 * * *', function () {
    runDaily();
  }, { timezone: 'America/New_York' });
}

module.exports = { startInspectionReminders, runDaily, nudgeDrivers, escalateOverdue };
