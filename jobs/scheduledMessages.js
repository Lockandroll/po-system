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

// ---------------------------------------------------------------------------
//  Calendar helpers for the shift-end trigger
// ---------------------------------------------------------------------------
// Everything below works in whole days since the epoch rather than Date objects.
// A shift that runs 2pm-2am belongs to the day it STARTED, so "two hours before
// it ends" can legitimately land on the following calendar day; day indexes make
// that arithmetic ordinary addition instead of a timezone puzzle.

// pg hands back DATE columns as JS Date objects parsed at LOCAL midnight, so
// this must use local getters, not getUTC*. See the deposits/PTO date gotcha.
function ymdOf(v) {
  if (v instanceof Date) {
    const p = function (n) { return (n < 10 ? '0' : '') + n; };
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return String(v || '').slice(0, 10);
}

function dayIndex(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymdOf(v));
  if (!m) return null;
  return Math.round(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) / 86400000);
}

function dayStr(idx) { return new Date(idx * 86400000).toISOString().slice(0, 10); }

// Monday of the week containing this day index. 1970-01-01 was a Thursday, so
// (idx + 4) % 7 gives 0=Sunday.
function mondayIndex(idx) {
  const dow = ((idx + 4) % 7 + 7) % 7;
  return idx - ((dow + 6) % 7);
}

// Minutes past the shift's OWN midnight at which the shift ends. An end time at
// or before the start time means the shift crosses midnight (2pm-2am = 1560).
function shiftEndMinutes(start, end) {
  const s = hhmmToMin(start);
  const e = hhmmToMin(end);
  if (s == null || e == null) return null;
  return e > s ? e : e + 1440;
}

// When to text, in minutes past the shift date's midnight. Clamped to the shift
// start so a lead time longer than the shift itself does not fire before the
// person has even clocked on.
function shiftSendOffset(start, end, leadMin) {
  const s = hhmmToMin(start);
  const endAbs = shiftEndMinutes(start, end);
  if (s == null || endAbs == null) return null;
  const off = endAbs - Math.max(0, leadMin || 0);
  return off < s ? s : off;
}

// The person's LAST shift of one Mon-Sun week, ranked by when it ends rather
// than which day it starts, so a Sunday 2pm-2am shift still beats a Sunday 9-5.
function lastShiftOfWeek(rows, weekStartIdx, leadMin) {
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const di = dayIndex(r.shift_date);
    if (di == null || di < weekStartIdx || di > weekStartIdx + 6) continue;
    const endAbs = shiftEndMinutes(r.start_time, r.end_time);
    const off = shiftSendOffset(r.start_time, r.end_time, leadMin);
    if (endAbs == null || off == null) continue;
    const cand = { row: r, dayIdx: di, endAbs: di * 1440 + endAbs, sendAbs: di * 1440 + off };
    if (!best || cand.endAbs > best.endAbs) best = cand;
  }
  return best;
}

async function audienceUsers(roles) {
  if (!roles.length) return [];
  const { rows } = await pool.query(
    'SELECT id, name, phone, email, receive_sms, receive_emails FROM users WHERE active = true AND role = ANY($1::text[])',
    [roles]
  );
  return rows;
}

function rolesOf(msg) {
  try { const r = JSON.parse(msg.audience_roles || '[]'); return Array.isArray(r) ? r : []; }
  catch (e) { return []; }
}

// Deliver one message to one person. Returns how many of each channel went out,
// so both the weekly and the shift-end path can report the same numbers.
async function deliverToUser(msg, u, ignoreOptOut) {
  const wantSms = msg.channel === 'sms' || msg.channel === 'both';
  const wantEmail = msg.channel === 'email' || msg.channel === 'both';
  let sms = 0, email = 0;
  if (wantSms && u.phone && (ignoreOptOut || u.receive_sms !== false)) {
    try { await sendSms([u.phone], applyTokens(msg.message, u)); sms = 1; }
    catch (e) { console.error('[scheduled] sms failed:', e.message); }
  }
  if (wantEmail && u.email && (ignoreOptOut || u.receive_emails !== false)) {
    try {
      const html = emailTemplate({
        badge: 'Reminder', badgeColor: 'orange',
        title: applyTokens(msg.subject || msg.name, u),
        body: applyTokens(msg.message, u).replace(/\n/g, '<br>'),
        footerNote: 'Automated scheduled message from Nova.'
      });
      await sendEmail(u.email, applyTokens(msg.subject || msg.name, u), html);
      email = 1;
    } catch (e) { console.error('[scheduled] email failed:', e.message); }
  }
  return { sms: sms, email: email };
}

// Send one scheduled message. opts.testUser => deliver only to that user (ignores audience + opt-out).
async function runScheduledMessage(msg, opts) {
  opts = opts || {};
  const users = opts.testUser ? [opts.testUser] : await audienceUsers(rolesOf(msg));
  const ignore = opts.testUser ? true : !!msg.ignore_opt_out;
  let smsCount = 0, emailCount = 0;
  for (let i = 0; i < users.length; i++) {
    const sent = await deliverToUser(msg, users[i], ignore);
    smsCount += sent.sms; emailCount += sent.email;
  }
  console.log('[scheduled] "' + msg.name + '" sent ' + smsCount + ' SMS, ' + emailCount + ' email' + (opts.testUser ? ' (test)' : ''));
  return { sms: smsCount, email: emailCount };
}

// Has this person already turned in the deposit that covers this week?
//
// The period the cash is FOR is what matters, not when the slip was dropped off:
// a Monday deposit for last week must not silence this week's reminder. Rows
// saved without a period fall back to the deposit date.
async function hasDepositForWeek(userId, weekStart, weekEnd) {
  const { rows } = await pool.query(
    'SELECT 1 FROM deposits WHERE user_id = $1 AND (' +
    '(period_end IS NOT NULL AND period_end >= $2::date AND COALESCE(period_start, period_end) <= $3::date) ' +
    'OR (period_end IS NULL AND deposit_date BETWEEN $2::date AND $3::date)' +
    ') LIMIT 1',
    [userId, weekStart, weekEnd]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
//  Shift-end trigger
// ---------------------------------------------------------------------------
// One message, one send per person per Mon-Sun week, timed off THEIR schedule:
// N minutes before the end of the last shift they are published to work that
// week. Mon-Fri 6a-6p with a 120 minute lead = Friday 4:00pm.
//
// Two weeks are always considered, because a shift that starts Sunday and ends
// after midnight puts its own send time inside the following week.
async function shiftEndPass(msg, t) {
  const leadMin = Math.max(0, parseInt(msg.lead_minutes, 10) || 0);
  const users = await audienceUsers(rolesOf(msg));
  if (!users.length) return 0;
  const ids = users.map(function (u) { return u.id; });

  const todayIdx = dayIndex(t.dateStr);
  const thisMon = mondayIndex(todayIdx);
  const weeks = [thisMon - 7, thisMon];

  const { rows: shifts } = await pool.query(
    "SELECT user_id, shift_date, start_time, end_time FROM shifts " +
    "WHERE user_id = ANY($1::int[]) AND status = 'published' AND shift_date BETWEEN $2::date AND $3::date",
    [ids, dayStr(thisMon - 7), dayStr(thisMon + 6)]
  );
  if (!shifts.length) return 0;

  const byUser = {};
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    if (!byUser[s.user_id]) byUser[s.user_id] = [];
    byUser[s.user_id].push(s);
  }

  const nowAbs = todayIdx * 1440 + t.nowMin;
  let delivered = 0;

  for (let ui = 0; ui < users.length; ui++) {
    const u = users[ui];
    const mine = byUser[u.id];
    if (!mine || !mine.length) continue;

    for (let wi = 0; wi < weeks.length; wi++) {
      const wk = weeks[wi];
      const best = lastShiftOfWeek(mine, wk, leadMin);
      if (!best) continue;

      const late = nowAbs - best.sendAbs;
      if (late < 0 || late > CATCHUP_MINUTES) continue;

      // Same guard the weekly path uses: do not let saving or enabling a message
      // this afternoon instantly fire this morning's missed slot at everybody.
      if (late > 0 && msg.updated_at && (Date.now() - new Date(msg.updated_at).getTime()) < late * 60000) {
        console.log('[scheduled] "' + msg.name + '" skipped catch-up for ' + u.name + ': created or edited after the slot.');
        continue;
      }

      const wkStart = dayStr(wk), wkEnd = dayStr(wk + 6);
      if (msg.skip_if_deposited && await hasDepositForWeek(u.id, wkStart, wkEnd)) continue;

      // Claim the week BEFORE sending. The unique index is what makes this safe:
      // three minutes of ticks, or two processes, cannot text the same person
      // twice for the same week even if delivery runs long.
      const claim = await pool.query(
        'INSERT INTO scheduled_message_sends (message_id, user_id, week_start) VALUES ($1,$2,$3::date) ' +
        'ON CONFLICT (message_id, user_id, week_start) DO NOTHING RETURNING id',
        [msg.id, u.id, wkStart]
      );
      if (!claim.rows.length) continue;

      const sent = await deliverToUser(msg, u, !!msg.ignore_opt_out);
      delivered += sent.sms + sent.email;
      console.log('[scheduled] "' + msg.name + '" -> ' + u.name + ' (week of ' + wkStart +
        ', last shift ' + ymdOf(best.row.shift_date) + ' ' + best.row.start_time + '-' + best.row.end_time +
        (late > 0 ? ', ' + late + ' min late' : '') + '): ' + sent.sms + ' SMS, ' + sent.email + ' email');
    }
  }
  return delivered;
}

async function tick() {
  try {
    const t = nowParts();
    const { rows } = await pool.query('SELECT * FROM scheduled_messages WHERE enabled = true');
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i];

      if (m.trigger_type === 'shift_end') {
        try {
          const n = await shiftEndPass(m, t);
          if (n > 0) await pool.query('UPDATE scheduled_messages SET last_run_on = $1 WHERE id = $2', [t.dateStr, m.id]);
        } catch (e) {
          console.error('[scheduled] shift-end pass failed for "' + m.name + '":', e.message);
        }
        continue;
      }

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

module.exports = {
  startScheduledMessages, runScheduledMessage, deliverToUser, tick, hhmmToMin, nowParts, CATCHUP_MINUTES,
  ymdOf, dayIndex, dayStr, mondayIndex, shiftEndMinutes, shiftSendOffset, lastShiftOfWeek, shiftEndPass
};
