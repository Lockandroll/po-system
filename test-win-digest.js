'use strict';
/*
 * The Friday wins digest, against a REAL Postgres.
 *
 * What it pins:
 *   - the message NEVER exceeds one SMS segment (160 chars), whatever the week
 *     looks like, because segment two doubles the bill for every person;
 *   - names degrade to "and N more" rather than the message spilling;
 *   - a quiet week sends NOTHING, not a text saying nobody was recognised;
 *   - the day is CLAIMED before any work, so a redeploy or a hand-run cannot
 *     text everybody twice;
 *   - a missed week is caught up on the next run instead of being dropped;
 *   - receive_win_digest mutes the digest WITHOUT touching receive_sms, which is
 *     the switch that also decides where somebody's 2FA login code goes;
 *   - only wins the manager put on Recent Wins are broadcast.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/digest_test node test-win-digest.js
 *
 * House style: string concatenation only, no template literals.
 */
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) PASS++; else { FAIL++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n== ' + t); }

process.env.DATABASE_URL = process.env.PGURL;
process.env.APP_URL = 'https://nova.lockandroll.com';
var pool = new Pool({ connectionString: process.env.PGURL });

var SMSES = [];
var orig = Module._load;
Module._load = function (r) {
  if (r === '../db') return require('./db.js');
  if (r === '../utils/sms') return { sendSms: async function (to, text) { SMSES.push({ to: to, text: text }); } };
  if (r === '../utils/email') return { sendEmail: async function () {}, emailTemplate: function () { return ''; } };
  if (r === 'node-cron') return { schedule: function () { return { stop: function () {} }; } };
  return orig.apply(this, arguments);
};

var db = require('./db.js');
var job = require('./jobs/employeeRecords.js');

async function seed() {
  var people = [
    [1, 'Tony McKeon', 'tony@x.com', '+18435550001', true, true],
    [2, 'Dana Reed', 'dana@x.com', '+18435550002', true, true],
    [3, 'Christopher Benson', 'chris@x.com', '+18435550003', true, true],
    [4, 'Marcus Hale', 'marcus@x.com', '+18435550004', true, true],
    [5, 'Rosa Lin', 'rosa@x.com', '+18435550005', true, true],
    // Opted out of the digest but still takes texts: 2FA must keep working.
    [6, 'Quiet Quinn', 'quinn@x.com', '+18435550006', true, false],
    // Takes no texts at all.
    [7, 'No Texts Nate', 'nate@x.com', '+18435550007', false, true],
    // No phone on file.
    [8, 'Phoneless Pat', 'pat@x.com', null, true, true]
  ];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, role, phone, active, receive_emails, receive_sms, receive_win_digest) ' +
      "VALUES ($1,$2,$3,'x','locksmith',$4,true,true,$5,$6) ON CONFLICT (id) DO NOTHING",
      [p[0], p[1], p[2], p[3], p[4], p[5]]);
  }
  await pool.query("SELECT setval('users_id_seq', 100, true)");
}

async function addWin(userId, when, inWins) {
  var r = await pool.query(
    'INSERT INTO employee_records (user_id, type, status, body, visible_to_employee, show_in_wins, created_by, created_by_name, created_at) ' +
    "VALUES ($1,'recognition','active','nice work',true,$2,1,'Tony McKeon',$3) RETURNING id",
    [userId, inWins !== false, when]);
  return r.rows[0].id;
}

(async function main() {
  await db.initDB();
  await seed();

  // ---------------------------------------------------------------------
  section('the message always fits one segment');
  var URL = 'nova.lockandroll.com';
  var one = job.buildDigestSms(['Christopher Benson'], URL);
  ok(one.length <= job.DIGEST_SMS_MAX, 'one name fits  (' + one.length + ')');
  ok(one.indexOf('1 win this week') !== -1, 'and reads "1 win", singular');
  ok(one.indexOf('Read it in Nova') !== -1, 'with singular wording in the tail');

  var three = job.buildDigestSms(['Christopher Benson', 'Rosa Lin', 'Marcus Hale'], URL);
  ok(three.length <= job.DIGEST_SMS_MAX, 'three names fit  (' + three.length + ')');
  ok(three.indexOf('3 wins this week') !== -1, 'plural count');
  ok(three.indexOf('Christopher Benson, Rosa Lin and Marcus Hale') !== -1, 'names read naturally');

  // The case that actually costs money: a good week with long names.
  var many = ['Christopher Benson', 'Alexandra Fitzgerald', 'Bartholomew Richardson',
    'Marcus Hale', 'Rosa Lin', 'Dana Reed', 'Jonathan Whitfield', 'Priya Raghunathan',
    'Sebastian Oyelaran-Whitmore'];
  var big = job.buildDigestSms(many, URL);
  ok(big.length <= job.DIGEST_SMS_MAX, 'nine long names STILL fit one segment  (' + big.length + ')');
  ok(big.indexOf('9 wins this week') !== -1, 'the true count survives the trim');
  ok(/and \d+ more/.test(big), 'the names that did not fit become "and N more"');
  var bigListed = many.filter(function (n) { return big.indexOf(n) !== -1; }).length;
  var bigMore = parseInt(/and (\d+) more/.exec(big)[1], 10);
  eq(bigListed + bigMore, many.length, 'names shown plus "and N more" accounts for everybody');

  // Degenerate input must not throw or spill.
  var absurd = job.buildDigestSms([new Array(400).join('X')], URL);
  ok(absurd.length <= job.DIGEST_SMS_MAX, 'a single absurd name cannot spill the segment  (' + absurd.length + ')');
  eq(job.buildDigestSms([], URL), null, 'no names, no message');

  // ---------------------------------------------------------------------
  section('a quiet week sends nothing');
  SMSES = [];
  var r0 = await job.runWinDigest({ now: new Date('2026-08-28T20:00:00Z') });
  eq(r0.reason, 'no_wins', 'the run reports a quiet week');
  eq(SMSES.length, 0, 'and NOBODY is texted that nobody was recognised');
  var row0 = (await pool.query("SELECT * FROM win_digest_runs WHERE run_date = '2026-08-28'")).rows[0];
  ok(!!row0, 'the run is still recorded, so the window advances');
  eq(row0.win_count, 0, 'with a zero count');
  eq(row0.sent_count, 0, 'and nothing sent');

  // ---------------------------------------------------------------------
  section('a normal week');
  await addWin(3, '2026-09-01T14:00:00Z');
  await addWin(5, '2026-09-02T14:00:00Z');
  await addWin(4, '2026-09-03T14:00:00Z');
  // Recognised twice: one name, not two.
  await addWin(3, '2026-09-04T14:00:00Z');
  // Kept OFF the wins card by the manager, so it must not be broadcast either.
  await addWin(2, '2026-09-04T15:00:00Z', false);

  SMSES = [];
  var r1 = await job.runWinDigest({ now: new Date('2026-09-04T20:00:00Z') });
  eq(r1.win_count, 4, 'four records in the window');
  ok(r1.message.indexOf('Christopher Benson') !== -1, 'names are listed');
  ok(r1.message.indexOf('Dana Reed') === -1, 'a win kept off the card is NOT broadcast');
  eq((r1.message.match(/Christopher Benson/g) || []).length, 1, 'somebody recognised twice is named once');
  ok(r1.message.length <= job.DIGEST_SMS_MAX, 'still one segment  (' + r1.message.length + ')');

  // THE invariant for this message: the number a reader sees must match the names
  // printed beside it. Four records but three people, so it says three - a text
  // reading "4 wins" over a list of three names reads as a bug to the person
  // holding the phone, and the run row keeps the raw record count anyway.
  ok(r1.message.indexOf('3 wins this week') !== -1, 'the count is PEOPLE recognised, not raw records');
  var listed = ['Christopher Benson', 'Rosa Lin', 'Marcus Hale'].filter(function (n) {
    return r1.message.indexOf(n) !== -1;
  }).length;
  var claimed = parseInt(/(\d+) wins? this week/.exec(r1.message)[1], 10);
  var more = /and (\d+) more/.exec(r1.message);
  eq(claimed, listed + (more ? parseInt(more[1], 10) : 0),
    'the number always equals the names shown plus any "and N more"');

  // ---------------------------------------------------------------------
  section('who gets it');
  var got = SMSES.map(function (m) { return m.to; }).sort();
  eq(got, ['+18435550001', '+18435550002', '+18435550003', '+18435550004', '+18435550005'],
    'everyone with SMS on and the digest on, and nobody else');
  eq(SMSES.filter(function (m) { return m.to === '+18435550006'; }).length, 0,
    'the digest opt-out is honoured');
  eq(SMSES.filter(function (m) { return m.to === '+18435550007'; }).length, 0,
    'somebody who takes no texts at all gets none');
  eq(SMSES.filter(function (m) { return m.to === null; }).length, 0, 'no phone, no send');
  eq(r1.sent_count, 5, 'the run records how many actually went');

  // The point of the separate flag: muting the digest must not touch the switch
  // that decides where a login code goes.
  var quinn = (await pool.query('SELECT receive_sms, receive_win_digest FROM users WHERE id = 6')).rows[0];
  eq(quinn.receive_sms, true, 'the opted-out person still has receive_sms ON');
  eq(quinn.receive_win_digest, false, 'only the digest flag is off');

  // ---------------------------------------------------------------------
  section('the claim');
  SMSES = [];
  var again = await job.runWinDigest({ now: new Date('2026-09-04T20:05:00Z') });
  eq(again.reason, 'already_ran', 'a second run on the same date claims nothing');
  eq(SMSES.length, 0, 'and texts nobody a second time');

  // ---------------------------------------------------------------------
  section('a missed week is caught up, not dropped');
  await addWin(4, '2026-09-08T14:00:00Z');
  await addWin(5, '2026-09-15T14:00:00Z');
  // No run on 09-11. The next one must cover BOTH weeks.
  SMSES = [];
  var r2 = await job.runWinDigest({ now: new Date('2026-09-18T20:00:00Z') });
  eq(r2.win_count, 2, 'both weeks are in the window');
  eq(new Date(r2.window_start).toISOString(), '2026-09-04T20:00:00.000Z',
    'the window starts where the last run ended, not seven days back');

  // ---------------------------------------------------------------------
  section('nothing already-broadcast is broadcast twice');
  SMSES = [];
  var r3 = await job.runWinDigest({ now: new Date('2026-09-25T20:00:00Z') });
  eq(r3.reason, 'no_wins', 'the wins from the previous window are not counted again');
  eq(SMSES.length, 0, 'and nothing goes out');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  await pool.end();
  await db.pool.end().catch(function () {});
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
