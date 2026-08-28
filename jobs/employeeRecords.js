// Scheduled work for employee records.
//
// Three jobs, two of them deliberately dull:
//
//   the signature nudge  - a notice that has been sent but not signed gets a
//                          reminder every couple of days, and is marked expired
//                          when its window runs out. Expiry is NOT a refusal;
//                          it just stops the reminders and lets the manager
//                          record what actually happened.
//
//   the follow-up nag    - a write-up with a follow-up date that has arrived and
//                          no recorded outcome nags whoever issued it, every
//                          three days, until they record one. This is the whole
//                          reason the follow-up date is a required field: a
//                          write-up that nobody ever closes out teaches the
//                          employee that nothing was really at stake.
//
//   the wins digest      - one text on Friday afternoon with the week's
//                          recognition. The only outbound in this file that goes
//                          to people who are not party to the record itself, and
//                          the only one with a cost that scales with headcount.
const cron = require('node-cron');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');

var REMIND_EVERY_DAYS = 2;
var NAG_EVERY_DAYS = 3;

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + (path || '');
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function mail(u, subject, body, buttonText, buttonUrl) {
  if (!u || !u.email || u.receive_emails === false) return;
  try {
    await sendEmail(u.email, subject, emailTemplate({
      badge: 'Nova', title: subject, body: body,
      buttonText: buttonText || null, buttonUrl: buttonUrl || null
    }));
  } catch (e) { console.error('[employee-records job] email failed:', e.message); }
}

async function logEvent(recordId, action, note) {
  try {
    await pool.query(
      'INSERT INTO employee_record_events (record_id, action, note, user_name) VALUES ($1,$2,$3,$4)',
      [recordId, action, note || null, 'Nova']
    );
  } catch (e) {}
}

// ---- signature reminders + expiry -----------------------------------------
async function runSignatureSweep() {
  // Expire first, so nothing that has just run out also gets reminded.
  const expired = await pool.query(
    "UPDATE employee_records SET status='expired', updated_at=NOW() " +
    "WHERE status='sent' AND expires_at IS NOT NULL AND expires_at < NOW() RETURNING id, user_id, created_by",
    []
  );
  for (var i = 0; i < expired.rows.length; i++) {
    await logEvent(expired.rows[i].id, 'expired', 'The signature window closed with no signature.');
    const author = await pool.query('SELECT name, email, receive_emails FROM users WHERE id = $1', [expired.rows[i].created_by]);
    if (author.rows.length) {
      await mail(author.rows[0], 'A signature request expired',
        '<p>A notice you issued has passed its signature window without being signed. ' +
        'Open the record and record what actually happened - it does not resolve itself.</p>',
        'Open Nova', appUrl('/?view=employee-files'));
    }
  }

  const due = await pool.query(
    "SELECT r.id, r.level, u.id AS uid, u.name, u.email, u.phone, u.receive_emails, u.receive_sms " +
    'FROM employee_records r JOIN users u ON u.id = r.user_id ' +
    "WHERE r.status='sent' AND (r.reminded_at IS NULL OR r.reminded_at < NOW() - ($1 || ' days')::interval) " +
    "AND r.sent_at < NOW() - ($1 || ' days')::interval",
    [String(REMIND_EVERY_DAYS)]
  );
  for (var j = 0; j < due.rows.length; j++) {
    var d = due.rows[j];
    // 'my-documents' is the real view id. This carried '?view=my-file' from day
    // one, which matched nothing in app.js and fell through to the home screen,
    // so no reminder ever reached the file it was nagging about. See myFileBtn()
    // in routes/employeeRecords.js. Fixed 2026-08-26.
    await mail(d, 'Reminder: a notice needs your signature',
      '<p>A notice in your file is still waiting for your signature. Signing confirms you have read it. ' +
      'It does not mean you agree with it.</p>', 'Open your file', appUrl('/?view=my-documents'));
    try {
      if (d.phone && d.receive_sms) await sendSms(d.phone, 'Nova: a notice in your file is still waiting for your signature.');
    } catch (e) {}
    await pool.query('UPDATE employee_records SET reminded_at=NOW(), reminder_count=reminder_count+1 WHERE id=$1', [d.id]);
    await logEvent(d.id, 'reminded', 'Automatic reminder.');
  }
  if (expired.rows.length || due.rows.length) {
    console.log('[employee-records] signature sweep: ' + due.rows.length + ' reminded, ' + expired.rows.length + ' expired.');
  }
}

// ---- follow-up nag ---------------------------------------------------------
async function runFollowupSweep() {
  const due = await pool.query(
    'SELECT r.id, r.level, r.followup_on, r.user_id, e.name AS employee_name, ' +
    '       a.id AS author_id, a.name AS author_name, a.email, a.phone, a.receive_emails, a.receive_sms ' +
    'FROM employee_records r ' +
    'JOIN users e ON e.id = r.user_id ' +
    'LEFT JOIN users a ON a.id = r.created_by ' +
    "WHERE r.followup_on IS NOT NULL AND r.followup_outcome IS NULL " +
    "AND r.status NOT IN ('draft','pending_approval','returned','void') " +
    'AND r.followup_on <= CURRENT_DATE ' +
    "AND (r.followup_nagged_at IS NULL OR r.followup_nagged_at < NOW() - ($1 || ' days')::interval)",
    [String(NAG_EVERY_DAYS)]
  );
  for (var i = 0; i < due.rows.length; i++) {
    var d = due.rows[i];
    if (d.email) {
      await mail(d, 'Follow-up due: ' + d.employee_name,
        '<p>The follow-up on a notice you issued for ' + esc(d.employee_name) + ' was due on ' +
        esc(String(d.followup_on).slice(0, 10)) + ' and has no recorded outcome yet.</p>' +
        '<p>Corrected, not corrected, or extended - any of the three closes it. Leaving it open is the ' +
        'one option that teaches nobody anything.</p>',
        'Record the outcome', appUrl('/?view=employee-files'));
    }
    await pool.query('UPDATE employee_records SET followup_nagged_at=NOW() WHERE id=$1', [d.id]);
    await logEvent(d.id, 'followup_nag', 'Reminded ' + (d.author_name || 'the issuer') + ' that the follow-up is due.');
  }
  if (due.rows.length) console.log('[employee-records] follow-up sweep: ' + due.rows.length + ' nagged.');
}


// ---------------------------------------------------------------- weekly wins digest

// One text, Friday afternoon, listing the week's recognition.
//
// Tony picked this over texting every win individually, and the reasons are worth
// keeping written down because they are what the shape of this function is FOR:
//
//   * Cost is per segment per person. A message over 160 characters silently
//     becomes two segments and doubles the bill for no extra information, so the
//     builder below treats 160 as a hard ceiling and drops names to stay under it
//     rather than letting a long week cost double.
//   * Volume does not scale with how often managers recognise people. One text a
//     week, whether there was one win or nine.
//   * A per-win text arrives whenever a manager happens to hit approve. There are
//     no quiet hours anywhere in Nova, so that is a real 11pm-text risk. A fixed
//     Friday slot has none.
//
// A quiet week sends NOTHING. A text saying "0 wins this week" is worse than
// silence: it broadcasts that nobody was recognised.

var DIGEST_SMS_MAX = 160;          // one GSM-7 segment. Past this it bills as two.
var DIGEST_FALLBACK_DAYS = 7;      // how far back to look when there is no prior run

function digestUrl() {
  var u = (process.env.APP_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  return u || 'Nova';
}

// Builds the message and GUARANTEES it fits one segment.
//
// It adds names while they fit and turns the remainder into "and N more". If even
// the no-names form is too long (a very long APP_URL), the names go entirely. The
// caller gets back null only when there is nothing to send.
function buildDigestSms(names, url) {
  var n = names.length;
  if (!n) return null;
  var head = 'Lock & Roll: ' + n + ' win' + (n === 1 ? '' : 's') + ' this week';
  var tail = '. Read ' + (n === 1 ? 'it' : 'them') + ' in Nova: ' + url;

  var bare = head + tail;
  if (bare.length > DIGEST_SMS_MAX) {
    // Nothing we can trim except the names, and there are none left to trim.
    return bare.slice(0, DIGEST_SMS_MAX);
  }

  var shown = [];
  for (var i = 0; i < names.length; i++) {
    var trial = shown.concat([names[i]]);
    var left = n - trial.length;
    var candidate = head + ' - ' + joinNames(trial, left) + tail;
    if (candidate.length > DIGEST_SMS_MAX) break;
    shown = trial;
  }
  if (!shown.length) return bare;
  return head + ' - ' + joinNames(shown, n - shown.length) + tail;
}

function joinNames(list, more) {
  var s;
  if (list.length === 1) s = list[0];
  else s = list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  if (more > 0) s = list.join(', ') + ' and ' + more + ' more';
  return s;
}

// The window. Starts where the last run finished, so a week the job did not run
// (a deploy, an outage) is caught up on the next one instead of being dropped on
// the floor. Falls back to seven days the very first time.
//
// run_date < $1 matters and is not defensive padding: this runs AFTER the current
// day has already been claimed, so without it the query finds THIS run's own row,
// takes its own window_end as the start, and every digest reports an empty week.
async function digestWindow(runDate, now) {
  var prev = await pool.query(
    'SELECT window_end FROM win_digest_runs WHERE run_date < $1 AND window_end IS NOT NULL ' +
    'ORDER BY run_date DESC LIMIT 1',
    [runDate]
  );
  if (prev.rows.length && prev.rows[0].window_end) return new Date(prev.rows[0].window_end);
  return new Date(now.getTime() - DIGEST_FALLBACK_DAYS * 86400000);
}

async function runWinDigest(opts) {
  opts = opts || {};
  var now = opts.now ? new Date(opts.now) : new Date();
  var runDate = now.toISOString().slice(0, 10);

  // Claim the day BEFORE doing any work. ON CONFLICT DO NOTHING means a second
  // caller on the same date gets no row back and stops here, which is what makes
  // a redeploy or a hand-run safe.
  var claim = await pool.query(
    'INSERT INTO win_digest_runs (run_date, window_end) VALUES ($1, $2) ON CONFLICT (run_date) DO NOTHING RETURNING run_date',
    [runDate, now]
  );
  if (!claim.rows.length) {
    console.log('[win-digest] already ran for ' + runDate + '; skipping.');
    return { skipped: true, reason: 'already_ran' };
  }

  var since = await digestWindow(runDate, now);

  // Exactly what the Recent Wins card can show, over the window. show_in_wins is
  // the gate: a recognition the manager kept off the Home screen does not get
  // broadcast by text either.
  var wins = (await pool.query(
    'SELECT r.id, u.name AS employee_name FROM employee_records r JOIN users u ON u.id = r.user_id ' +
    "WHERE r.show_in_wins = true AND r.type = 'recognition' AND r.status = 'active' " +
    'AND u.active IS NOT FALSE AND r.created_at > $1 AND r.created_at <= $2 ' +
    'ORDER BY r.created_at ASC',
    [since, now]
  )).rows;

  await pool.query('UPDATE win_digest_runs SET window_start = $2, win_count = $3 WHERE run_date = $1',
    [runDate, since, wins.length]);

  if (!wins.length) {
    console.log('[win-digest] no wins between ' + since.toISOString() + ' and ' + now.toISOString() + '; sending nothing.');
    return { skipped: true, reason: 'no_wins', win_count: 0, sent_count: 0 };
  }

  // One name per person even if they were recognised twice, in the order they
  // were recognised.
  var names = [];
  for (var i = 0; i < wins.length; i++) {
    if (names.indexOf(wins[i].employee_name) === -1) names.push(wins[i].employee_name);
  }

  var msg = buildDigestSms(names, digestUrl());
  if (!msg) return { skipped: true, reason: 'no_message' };

  // BOTH switches have to be on. receive_sms is the standing "you may text me"
  // answer and this does not override it; receive_win_digest is the one somebody
  // can turn off without moving their login code to email.
  var people = (await pool.query(
    'SELECT id, name, phone FROM users ' +
    "WHERE active IS NOT FALSE AND receive_sms = true AND receive_win_digest IS NOT FALSE " +
    "AND phone IS NOT NULL AND TRIM(phone) <> ''"
  )).rows;

  var sent = 0;
  for (var j = 0; j < people.length; j++) {
    try { await sendSms(people[j].phone, msg); sent++; }
    catch (e) { console.error('[win-digest] SMS failed for ' + people[j].name + ':', e.message); }
  }

  await pool.query('UPDATE win_digest_runs SET sent_count = $2, message = $3 WHERE run_date = $1',
    [runDate, sent, msg]);
  console.log('[win-digest] ' + wins.length + ' win(s), ' + msg.length + ' chars, texted ' + sent + ' of ' + people.length + '.');
  return { win_count: wins.length, sent_count: sent, message: msg, window_start: since };
}

function startWinDigest() {
  // 4pm Eastern on Friday. The timezone is EXPLICIT: the other two crons in this
  // file run on server time, which is UTC on Railway, and for a job whose whole
  // point is landing at the end of the work day that would put it at noon.
  cron.schedule('0 16 * * 5', function () {
    runWinDigest().catch(function (e) { console.error('[win-digest] failed:', e.message); });
  }, { timezone: 'America/New_York' });
  console.log('Weekly wins digest scheduled (Fri 4:00pm America/New_York).');
}

function startEmployeeRecords() {
  // 9am and 3pm for signatures, 8am for follow-ups. Server time, same as every
  // other job in here.
  cron.schedule('0 9,15 * * *', function () {
    runSignatureSweep().catch(function (e) { console.error('[employee-records] signature sweep failed:', e.message); });
  });
  cron.schedule('15 8 * * *', function () {
    runFollowupSweep().catch(function (e) { console.error('[employee-records] follow-up sweep failed:', e.message); });
  });
  console.log('Employee records jobs scheduled (signatures 9am/3pm, follow-ups 8:15am).');
}

module.exports = {
  startEmployeeRecords: startEmployeeRecords,
  runSignatureSweep: runSignatureSweep,
  runFollowupSweep: runFollowupSweep,
  startWinDigest: startWinDigest,
  runWinDigest: runWinDigest,
  buildDigestSms: buildDigestSms,
  DIGEST_SMS_MAX: DIGEST_SMS_MAX
};
