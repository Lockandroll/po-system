const cron = require('node-cron');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { sendEmail, emailTemplate } = require('../utils/email');

const TZ = 'America/New_York';
const APP = (process.env.APP_URL || '').replace(/\/$/, '');

function nyDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function nyMinutes(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d || new Date());
  let h = 0, m = 0;
  parts.forEach(function (p) { if (p.type === 'hour') h = parseInt(p.value, 10) % 24; if (p.type === 'minute') m = parseInt(p.value, 10); });
  return h * 60 + m;
}
function startMin(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 0;
}
function fmtTime(t) {
  const mm = startMin(t); let h = Math.floor(mm / 60), min = mm % 60;
  const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return h + ':' + String(min).padStart(2, '0') + ' ' + ap;
}
async function settingVal(key, fallback) {
  try { const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]); return r.rows.length && r.rows[0].value != null ? r.rows[0].value : fallback; }
  catch (e) { return fallback; }
}

// Who receives the manager copy of a late alert.
// City roles -> managers assigned to the shift's city. Locksmith coordinators ->
// their supervisor (managed outside a city). Fallback to admins.
async function managerRecipients(employee, cityCode) {
  if (employee.supervisor_id) {
    const r = await pool.query('SELECT id, name, phone, email, receive_sms FROM users WHERE id = $1 AND active = true', [employee.supervisor_id]);
    if (r.rows.length) return r.rows;
  }
  if (cityCode) {
    const r = await pool.query(
      "SELECT u.id, u.name, u.phone, u.email, u.receive_sms FROM users u JOIN user_cities uc ON uc.user_id = u.id " +
      "WHERE uc.city_code = $1 AND u.active = true AND u.role IN ('manager','admin','owner')",
      [cityCode]
    );
    if (r.rows.length) return r.rows;
  }
  const a = await pool.query("SELECT id, name, phone, email, receive_sms FROM users WHERE active = true AND role IN ('admin','owner')");
  return a.rows;
}

async function notify(person, msg, subject, html) {
  try {
    if (person.phone && person.receive_sms) await sendSms(person.phone, msg);
    else if (person.email) await sendEmail(person.email, subject, html);
  } catch (e) { console.error('timeclock notify failed:', e.message); }
}

// Fire once per late shift, grace minutes after start, for HOURLY users who
// have a published shift today but have not clocked in for it.
async function runLateAlerts() {
  try {
    const today = nyDateStr(new Date());
    const nowMin = nyMinutes(new Date());
    const grace = parseInt(await settingVal('timeclock_late_grace_min', '10'), 10) || 10;
    const target = await settingVal('timeclock_late_target', 'both'); // employee | manager | both
    const shifts = (await pool.query(
      "SELECT s.*, u.role, u.phone, u.email, u.receive_sms, u.supervisor_id, COALESCE(u.pay_type,'hourly') AS pay_type " +
      "FROM shifts s JOIN users u ON u.id = s.user_id " +
      "WHERE s.shift_date = $1 AND s.status = 'published' AND s.late_alerted_at IS NULL AND u.active = true",
      [today]
    )).rows;
    for (const s of shifts) {
      if (s.pay_type !== 'hourly') continue;
      if (nowMin < startMin(s.start_time) + grace) continue;
      // Did they clock in for this shift (or at all today)?
      const punched = await pool.query(
        "SELECT 1 FROM time_entries WHERE user_id = $1 AND (shift_id = $2 OR (clock_in_at AT TIME ZONE $3)::date = $4) LIMIT 1",
        [s.user_id, s.id, TZ, today]
      );
      if (punched.rows.length) continue;

      const late = nowMin - startMin(s.start_time);
      const empMsg = 'Nova: you have not clocked in for your ' + fmtTime(s.start_time) + ' shift (' + late + ' min late). Open Nova to clock in.';
      const mgrMsg = 'Nova: ' + s.user_name + ' has not clocked in for their ' + fmtTime(s.start_time) + ' shift (' + late + ' min late).';
      const empHtml = emailTemplate({ badge: 'CLOCK IN', badgeColor: '#eab308', title: 'You are not clocked in', body: empMsg, buttonText: APP ? 'Open Nova' : undefined, buttonUrl: APP || undefined });
      const mgrHtml = emailTemplate({ badge: 'LATE', badgeColor: '#ef4444', title: s.user_name + ' is not clocked in', body: mgrMsg });

      if (target === 'employee' || target === 'both') {
        await notify({ phone: s.phone, email: s.email, receive_sms: s.receive_sms }, empMsg, 'You are not clocked in', empHtml);
      }
      if (target === 'manager' || target === 'both') {
        const mgrs = await managerRecipients({ role: s.role, supervisor_id: s.supervisor_id }, s.city_code);
        for (const m of mgrs) await notify(m, mgrMsg, s.user_name + ' is not clocked in', mgrHtml);
      }
      await pool.query('UPDATE shifts SET late_alerted_at = NOW() WHERE id = $1', [s.id]);
    }
  } catch (e) { console.error('runLateAlerts error:', e.message); }
}

// Nightly: cap any entry left open past the max shift length so nobody is
// silently paid for a runaway punch. Capped + flagged for manager review.
async function runAutoClose() {
  try {
    const maxH = parseInt(await settingVal('timeclock_max_shift_hours', '16'), 10) || 16;
    const stale = (await pool.query(
      "SELECT * FROM time_entries WHERE status = 'open' AND clock_in_at < NOW() - ($1 || ' hours')::interval",
      [String(maxH)]
    )).rows;
    for (const e of stale) {
      // end any open break at the cap too
      const capTs = new Date(new Date(e.clock_in_at).getTime() + maxH * 3600000);
      await pool.query(
        "UPDATE time_breaks SET break_end_at = $1, minutes = ROUND(EXTRACT(EPOCH FROM ($1 - break_start_at))/60) WHERE entry_id = $2 AND break_end_at IS NULL",
        [capTs, e.id]
      );
      // worked = cap - unpaid breaks
      const br = (await pool.query('SELECT type, break_start_at, break_end_at FROM time_breaks WHERE entry_id = $1', [e.id])).rows;
      let unpaid = 0;
      br.forEach(function (b) { if (b.type === 'unpaid' && b.break_end_at) unpaid += Math.round((new Date(b.break_end_at) - new Date(b.break_start_at)) / 60000); });
      const worked = Math.max(0, maxH * 60 - unpaid);
      await pool.query(
        "UPDATE time_entries SET clock_out_at = $1, status = 'auto_closed', worked_minutes = $2, updated_at = NOW() WHERE id = $3",
        [capTs, worked, e.id]
      );
    }
    if (stale.length) console.log('Time clock: auto-closed ' + stale.length + ' forgotten punch(es).');
  } catch (e) { console.error('runAutoClose error:', e.message); }
}

function startTimeClock() {
  // Late alerts — every 5 minutes.
  cron.schedule('*/5 * * * *', runLateAlerts, { timezone: TZ });
  // Auto-close forgotten punches — nightly at 3:10am.
  cron.schedule('10 3 * * *', runAutoClose, { timezone: TZ });
  console.log('Time clock jobs scheduled (late alerts /5min, auto-close nightly).');
}

module.exports = { startTimeClock, runLateAlerts, runAutoClose };
