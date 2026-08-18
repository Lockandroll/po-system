const cron = require('node-cron');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { sendEmail, emailTemplate } = require('../utils/email');
const { resolveDateTokens } = require('../utils/messageTokens');

const TZ = 'America/New_York';

// How late Nova is still willing to send a message it missed.
//
// This used to be an exact HH:MM string match, which meant the send existed for
// exactly one minute a week. A deploy, a Railway restart, a slow tick or a process
// that was not running at 09:00 dropped the whole week's reminder with no error,
// no log line and no way to tell afterwards that it had happened. That is half of
// how the 2026-08-18 SMS outage stayed invisible for days.
//
// Bounded on purpose: catching up a 9am reminder at 9:20 is helpful. Catching it
// up at 11pm is just confusing, and worse, it trains people to ignore it.
const CATCHUP_MINUTES = 180;

// 'HH:MM' (or 'HH:MM:SS' straight out of Postgres) -> minutes past midnight.
function hhmmToMin(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }
function applyTokens(text, user) { return resolveDateTokens(String(text || '').replace(/\{first_name\}/g, firstName(user && user.name))); }

// Current day-of-week (0=Sun..6=Sat), HH:MM and YYYY-MM-DD in America/New_York.
function nowParts() {
  const d = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const map = {};
  dtf.formatToParts(d).forEach(function (p) { map[p.type] = p.value; });
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hh = map.hour === '24' ? '00' : map.hour;
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const nowMin = parseInt(hh, 10) * 60 + parseInt(map.minute, 10);
  return { dow: dowMap[map.weekday], hhmm: hh + ':' + map.minute, nowMin: nowMin, dateStr: dateStr };
}

async function audienceUsers(roles) {
  if (!roles.length) return [];
  const { rows } = await pool.query(
    'SELECT name, phone, email, receive_sms, receive_emails FROM users WHERE active = true AND role = ANY($1::text[])',
    [roles]
  );
  return rows;
}

// Send one scheduled message. opts.testUser => deliver only to that user (ignores audience + opt-out).
async function runScheduledMessage(msg, opts) {
  opts = opts || {};
  let roles = [];
  try { roles = JSON.parse(msg.audience_roles || '[]'); } catch (e) { roles = []; }
  const users = opts.testUser ? [opts.testUser] : await audienceUsers(roles);
  const ignore = opts.testUser ? true : !!msg.ignore_opt_out;
  const wantSms = msg.channel === 'sms' || msg.channel === 'both';
  const wantEmail = msg.channel === 'email' || msg.channel === 'both';
  let smsCount = 0, emailCount = 0;

  if (wantSms) {
    for (let i = 0; i < users.length; i++) {
      const u = users[i];
      if (!u.phone) continue;
      if (!ignore && u.receive_sms === false) continue;
      try { await sendSms([u.phone], applyTokens(msg.message, u)); smsCount++; }
      catch (e) { console.error('[scheduled] sms failed:', e.message); }
    }
  }
  if (wantEmail) {
    for (let j = 0; j < users.length; j++) {
      const ue = users[j];
      if (!ue.email) continue;
      if (!ignore && ue.receive_emails === false) continue;
      try {
        const html = emailTemplate({
          badge: 'Reminder', badgeColor: 'orange',
          title: applyTokens(msg.subject || msg.name, ue),
          body: applyTokens(msg.message, ue).replace(/\n/g, '<br>'),
          footerNote: 'Automated scheduled message from Nova.'
        });
        await sendEmail(ue.email, applyTokens(msg.subject || msg.name, ue), html);
        emailCount++;
      } catch (e) { console.error('[scheduled] email failed:', e.message); }
    }
  }
  console.log('[scheduled] "' + msg.name + '" sent ' + smsCount + ' SMS, ' + emailCount + ' email' + (opts.testUser ? ' (test)' : ''));
  return { sms: smsCount, email: emailCount };
}

async function tick() {
  try {
    const t = nowParts();
    const { rows } = await pool.query('SELECT * FROM scheduled_messages WHERE enabled = true');
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i];
      if (m.day_of_week !== t.dow) continue;

      const due = hhmmToMin(m.send_time);
      if (due == null) continue;
      const late = t.nowMin - due;
      if (late < 0 || late > CATCHUP_MINUTES) continue;

      const lastStr = m.last_run_on
        ? (typeof m.last_run_on === 'string' ? m.last_run_on.slice(0, 10) : new Date(m.last_run_on).toISOString().slice(0, 10))
        : null;
      // The one and only guard against sending twice in a day. It carries more
      // weight now than it did under the exact-minute match, because the window
      // below gives the tick 180 chances to fire instead of one.
      if (lastStr === t.dateStr) continue;

      // Do not catch up a message that did not exist, or was rescheduled, when its
      // slot passed today. Saving a Tuesday 9am reminder at 2pm on a Tuesday would
      // otherwise fire it instantly, at everybody. Comparing updated_at against how
      // late we are needs no timezone maths: "the slot was N minutes ago" and "the row
      // changed less than N minutes ago" are measured against the same clock.
      if (late > 0 && m.updated_at && (Date.now() - new Date(m.updated_at).getTime()) < late * 60000) {
        console.log('[scheduled] "' + m.name + '" skipped catch-up: it was created or edited after ' +
          'today\'s ' + String(m.send_time).slice(0, 5) + ' ET slot.');
        continue;
      }

      // Mark first to avoid a double-send if delivery runs long.
      await pool.query('UPDATE scheduled_messages SET last_run_on = $1 WHERE id = $2', [t.dateStr, m.id]);
      if (late > 0) {
        console.log('[scheduled] "' + m.name + '" is ' + late + ' min late for its ' +
          String(m.send_time).slice(0, 5) + ' ET slot; sending now rather than losing the week.');
      }
      await runScheduledMessage(m, {});
    }
  } catch (err) {
    console.error('[scheduled] tick failed:', err.message);
  }
}

function startScheduledMessages() {
  cron.schedule('* * * * *', tick, { timezone: TZ });
  console.log('[scheduled] Scheduled-messages runner started (per-minute check, ' + TZ + ')');
}

module.exports = { startScheduledMessages, runScheduledMessage, tick, hhmmToMin, nowParts, CATCHUP_MINUTES };
