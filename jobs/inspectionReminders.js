const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { broadcastRecipients } = require('../utils/notify');
const push = require('../utils/push');
const org = require('../utils/org');
// The resolution order lives with the routes so the grid and these nudges can
// never drift apart: whoever the Responsible column names is who gets the email.
const { resolveInspector } = require('../routes/inspections');

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
    'u.name as driver_name, u.supervisor_id as manager_id, u.home_city as driver_home_city, ' +
    'mgr.name as manager_name, mgr.email as manager_email, mgr.phone as manager_phone, ' +
    'mgr.receive_emails as manager_receive_emails, mgr.receive_sms as manager_receive_sms, ' +
    'v.inspector_id, insp.name as inspector_name, insp.email as inspector_email, ' +
    'insp.phone as inspector_phone, insp.receive_emails as inspector_receive_emails, ' +
    'insp.receive_sms as inspector_receive_sms ' +
    'FROM vehicles v LEFT JOIN users u ON v.assigned_user_id = u.id ' +
    'LEFT JOIN users mgr ON u.supervisor_id = mgr.id ' +
    'LEFT JOIN users insp ON v.inspector_id = insp.id ' +
    'WHERE v.active = true AND v.inspection_exempt = false ' +
    "AND (u.role IS NULL OR u.role NOT IN ('admin','owner')) " +
    'AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = $1)',
    [month]
  );
  return rows;
}

// The one person nudged about a vehicle, resolved exactly the way the compliance
// grid resolves it. Returns null when nobody can be worked out at all, which the
// month-end escalation to admins then covers.
function recipientFor(v, cityMgr) {
  var r = resolveInspector({
    inspector_id: v.inspector_id,
    inspector_name: v.inspector_name,
    driver_home_city: v.driver_home_city,
    city_code: v.city_code,
    driver_supervisor_id: v.manager_id,
    manager_name: v.manager_name
  }, cityMgr);
  if (!r.effective_inspector_id) return null;
  if (r.effective_inspector_source === 'assigned') {
    return { id: v.inspector_id, name: v.inspector_name, email: v.inspector_email, phone: v.inspector_phone,
      receive_emails: v.inspector_receive_emails, receive_sms: v.inspector_receive_sms };
  }
  if (r.effective_inspector_source === 'city') {
    var cm = cityMgr[r.inspector_city];
    return { id: cm.id, name: cm.name, email: cm.email, phone: cm.phone,
      receive_emails: cm.receive_emails, receive_sms: cm.receive_sms };
  }
  return { id: v.manager_id, name: v.manager_name, email: v.manager_email, phone: v.manager_phone,
    receive_emails: v.manager_receive_emails, receive_sms: v.manager_receive_sms };
}

// Nudge each INSPECTOR about the vehicles still uninspected this month. One
// grouped message per inspector.
async function nudgeManagers() {
  var p = etParts();
  var missing = await missingForMonth(p.month);
  var cityMgr = await org.cityManagerMap();
  var byInspector = {};
  missing.forEach(function (v) {
    var rcp = recipientFor(v, cityMgr);
    if (!rcp || !rcp.id) return; // nobody resolves -> month-end escalation to admins covers it
    (byInspector[rcp.id] = byInspector[rcp.id] || { rcp: rcp, vehicles: [] }).vehicles.push(v);
  });
  var mgrIds = Object.keys(byInspector);
  for (var m = 0; m < mgrIds.length; m++) {
    var grp = byInspector[mgrIds[m]];
    var mgr = grp.rcp;
    var vs = grp.vehicles;
    var count = vs.length;
    try { await push.sendPushToUsers([mgr.id], { title: 'Vehicle inspections due', body: count + ' vehicle' + (count === 1 ? '' : 's') + ' you inspect need doing this month.', url: '/' }); } catch (e) {}
    var listRows = vs.map(function (v) {
      var label = v.year + ' ' + (v.make_model || 'vehicle') + (v.license_plate ? ' (' + v.license_plate + ')' : '');
      return '<tr>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + label + '</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + (v.driver_name || 'Unassigned') + '</td>' +
        '<td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:13px">' + (v.city_code || '—') + '</td>' +
      '</tr>';
    }).join('');
    if (mgr.receive_emails !== false && mgr.email) {
      var html = emailTemplate({
        badge: 'Reminder',
        title: count + ' vehicle inspection' + (count === 1 ? '' : 's') + ' due',
        body: 'These vehicles still need their ' + p.month + ' inspection. You are down as the inspector for them, so please complete them before month end.' +
          '<table style="width:100%;border-collapse:collapse;margin-top:12px"><thead><tr>' +
          '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">Vehicle</th>' +
          '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">Driver</th>' +
          '<th style="text-align:left;padding:8px 12px;font-size:12px;color:#888">City</th>' +
          '</tr></thead><tbody>' + listRows + '</tbody></table>',
        buttonText: 'Open inspections',
        buttonUrl: appUrl('?view=inspections')
      });
      try { await sendEmail(mgr.email, count + ' vehicle inspection' + (count === 1 ? '' : 's') + ' due', html); } catch (e) { console.error('inspection nudge email failed:', e.message); }
    }
    if (mgr.receive_sms && mgr.phone) {
      try { await sendSms(mgr.phone, 'Lock & Roll: ' + count + ' vehicle' + (count === 1 ? '' : 's') + ' you inspect need their ' + p.month + ' inspection. ' + appUrl('?view=inspections')); } catch (e) {}
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
      await nudgeManagers();
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

module.exports = { startInspectionReminders, runDaily, nudgeManagers, escalateOverdue };
