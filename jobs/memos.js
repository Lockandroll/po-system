// Scheduled work for company memos (routes/memos.js).
//
//   reminders     - once a day at 9:20am, anyone who has not signed (or
//                   acknowledged) a sent memo gets a nudge, every
//                   remind_every_days days (2 by default, 0 = never), counted
//                   from the later of when it was delivered and when they were
//                   last reminded. Nobody is reminded on the day it was sent.
//
//   scheduled     - every minute, any memo scheduled to send whose time has
//                   come goes out (routes/memos.js runScheduledSends), so a memo
//                   written at night can wait for the morning.
//
//   late joiners  - every 30 minutes between 8am and 7:30pm Eastern, a memo sent with "also send to people
//                   hired later" picks up anyone who has since finished
//                   onboarding and matches who the memo is for. They are added
//                   with added_late = true and told the same way everyone else
//                   was. users.created_at is the line: someone who already
//                   existed when the memo went out and was left off was left off
//                   on purpose.
//
// House style: string concatenation only, no template literals.
const cron = require('node-cron');
const { pool } = require('../db');
const memos = require('../routes/memos');
const memoLock = require('../utils/memoLock');

async function runMemoReminders() {
  var due = (await pool.query(
    'SELECT r.memo_id, r.user_id FROM memo_recipients r JOIN memos m ON m.id = r.memo_id ' +
    "WHERE m.status = 'sent' AND m.remind_every_days > 0 AND r.completed_at IS NULL AND r.excused_at IS NULL " +
    "  AND COALESCE(r.last_reminded_at, r.delivered_at, r.created_at) <= NOW() - (m.remind_every_days || ' days')::interval"
  )).rows;
  var byMemo = {};
  due.forEach(function (d) { (byMemo[d.memo_id] = byMemo[d.memo_id] || []).push(d.user_id); });
  var sent = 0;
  for (var mid in byMemo) {
    var memo = (await pool.query('SELECT * FROM memos WHERE id = $1', [mid])).rows[0];
    if (!memo) continue;
    var users = (await pool.query(
      'SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE active = true AND id = ANY($1::int[])',
      [byMemo[mid]])).rows;
    for (var i = 0; i < users.length; i++) {
      try { await memos._internal.notifyOne(memo, users[i], true); } catch (e) {}
      await pool.query('UPDATE memo_recipients SET reminder_count = reminder_count + 1, last_reminded_at = NOW() WHERE memo_id = $1 AND user_id = $2', [memo.id, users[i].id]);
      sent++;
    }
    try {
      await pool.query("INSERT INTO memo_events (memo_id, action, actor_name, detail) VALUES ($1,'reminded','Nova',$2)",
        [memo.id, JSON.stringify({ count: users.length, automatic: true })]);
    } catch (e) {}
  }
  return sent;
}

async function runLateJoiners() {
  var list = (await pool.query("SELECT * FROM memos WHERE status = 'sent' AND include_future_hires = true")).rows;
  var added = 0;
  var exemptRoles = await memos._internal.lockExemptRoles();
  for (var i = 0; i < list.length; i++) {
    var memo = list[i];
    var users = await memos._internal.resolveAudience(memo.audience, {
      excludeId: memo.exclude_sender !== false ? memo.sent_by : null,
      createdAfter: memo.sent_at
    });
    for (var j = 0; j < users.length; j++) {
      var u = users[j];
      var ins = await pool.query(
        'INSERT INTO memo_recipients (memo_id, user_id, user_name, user_role, user_city, lock_exempt, delivered_at, delivered_via, added_late) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,NOW(),'Nova',true) ON CONFLICT (memo_id, user_id) DO NOTHING RETURNING id",
        [memo.id, u.id, u.name, u.role, u.home_city, exemptRoles.indexOf(u.role) !== -1]);
      if (!ins.rows.length) continue;
      added++;
      try {
        var via = await memos._internal.notifyOne(memo, u, false);
        await pool.query('UPDATE memo_recipients SET delivered_via = $2 WHERE id = $1', [ins.rows[0].id, via.join(', ')]);
      } catch (e) {}
      try {
        await pool.query("INSERT INTO memo_events (memo_id, user_id, action, actor_name) VALUES ($1,$2,'added_late','Nova')", [memo.id, u.id]);
      } catch (e) {}
    }
  }
  if (added) memoLock.invalidate();
  return added;
}

// Every schedule here is pinned to Eastern time so nothing a person is texted
// about lands overnight (Tony, 2026-10-09). The scheduled-send tick runs all
// day, because the sender picked that time on purpose.
var TZ = { timezone: 'America/New_York' };
function startMemoJobs() {
  cron.schedule('* * * * *', function () {
    memos._internal.runScheduledSends().catch(function (e) { console.error('[memos] scheduled send failed:', e.message); });
  }, TZ);
  cron.schedule('20 9 * * *', function () {
    runMemoReminders().catch(function (e) { console.error('[memos] reminder sweep failed:', e.message); });
  }, TZ);
  cron.schedule('*/30 8-19 * * *', function () {
    runLateJoiners().catch(function (e) { console.error('[memos] late-joiner sweep failed:', e.message); });
  }, TZ);
  console.log('Memo jobs scheduled (scheduled sends every minute, reminders 9:20am ET, new-hire sweep every 30 min 8am-7:30pm ET).');
}

module.exports = { startMemoJobs: startMemoJobs, runMemoReminders: runMemoReminders, runLateJoiners: runLateJoiners, runScheduledSends: function () { return memos._internal.runScheduledSends(); } };
