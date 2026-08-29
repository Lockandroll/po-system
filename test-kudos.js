'use strict';
/*
 * Kudos on Recent Wins, end to end against a REAL Postgres.
 *
 * What it pins:
 *   - initDB() creates kudos on a database that has never seen it, is safe to
 *     run twice, and carries the unique index that makes a double tap harmless;
 *   - anybody signed in can give one - there is deliberately no permission;
 *   - you cannot give yourself kudos, and the button is not drawn on your own
 *     win either;
 *   - a win older than KUDOS_WINDOW_DAYS is closed to new kudos;
 *   - THE COUNT GATE: kudos_count and kudos_from reach the person the win is
 *     about and holders of view_employee_records, and are ABSENT - not zero,
 *     not null - for everybody else. This is the assertion that stops Recent
 *     Wins turning into a public ranking of people;
 *   - the celebration is grouped per win, is never empty, and stops quoting a
 *     recognition that has been voided or un-shared;
 *   - seen_at is stamped by POST /kudos/seen and by nothing else - in
 *     particular NOT by the GET that fetches the celebration;
 *   - the push job batches one notification per person per win, stamps
 *     pushed_at, never re-announces the same batch, and holds during quiet
 *     hours;
 *   - no route anywhere returns a per-person lifetime total.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/kudos_test node test-kudos.js
 *
 * House style: string concatenation only, no template literals.
 */
var http = require('http');
var Module = require('module');
var { Pool } = require('pg');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) PASS++; else { FAIL++; console.error('  FAIL: ' + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n== ' + t); }

process.env.DATABASE_URL = process.env.PGURL;
var pool = new Pool({ connectionString: process.env.PGURL });

var CURRENT_USER = { id: 1, name: 'Admin', role: 'admin', isOwner: true };
// Role -> permissions. The count gate is the thing under test, so this has to
// be steerable rather than "everybody passes".
var PERMS = { admin: ['view_employee_records'], manager: [], locksmith: [] };
var PUSHES = [];

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return require('./db.js');
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/audit') return { logAudit: async function () {} };
  if (request === '../utils/org') return {
    teamIds: async function () { return []; },
    canOpenFile: async function (v) { return v.role === 'admin'; },
    isUpline: async function () { return false; }
  };
  if (request === '../utils/email') return {
    sendEmail: async function () {}, emailTemplate: function (o) { return String((o && o.body) || ''); }
  };
  if (request === '../utils/sms') return { sendSms: async function () {} };
  if (request === '../utils/notify') return { push: async function () {} };
  if (request === '../utils/permissions') return {
    hasPermission: async function (role, perm) { return (PERMS[role] || []).indexOf(perm) !== -1; },
    defaultHas: function () { return false; },
    ALL_PERMS: []
  };
  if (request === '../utils/recordCheck') return { checkRecord: async function () { return { available: false, fields: {} }; } };
  if (request === '../utils/r2') return { presignPut: async function () { return ''; }, presignGet: async function () { return ''; }, del: async function () {} };
  if (request === '../utils/policySuggest') return { suggest: async function () { return []; } };
  if (request === '../utils/docText') return { extract: async function () { return ''; } };
  if (request === '../utils/lateEvents') return { lateEvents: async function () { return []; } };
  if (request === '../utils/push') return {
    isReady: function () { return true; },
    publicKey: function () { return 'k'; },
    sendPushToUsers: async function (ids, payload) { PUSHES.push({ ids: ids, payload: payload }); }
  };
  return origLoad.apply(this, arguments);
};

var express = require('express');
var db = require('./db.js');
var router = require('./routes/employeeRecords.js');
var kudosJob = require('./jobs/kudosPush.js');
var app = express();
app.use(express.json());
app.use('/api/employee-records', router);
var server;

function req(method, path, body) {
  return new Promise(function (resolve, reject) {
    var payload = body === undefined ? null : JSON.stringify(body);
    var r = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: path,
      headers: { 'content-type': 'application/json' } }, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function as(u) { CURRENT_USER = u; }

var ADMIN = { id: 1, name: 'Tony McKeon', role: 'admin' };
var MGR   = { id: 2, name: 'Dana Reed', role: 'manager' };
var STAR  = { id: 3, name: 'Christopher Benson', role: 'locksmith' };   // the win is about him
var PEER1 = { id: 4, name: 'Marcus Hale', role: 'locksmith' };
var PEER2 = { id: 5, name: 'Rosa Lin', role: 'locksmith' };
var PEER3 = { id: 6, name: 'Dylan McLawhorn', role: 'locksmith' };

async function seed() {
  var people = [
    [1, 'Tony McKeon', 'admin', 'CHS'],
    [2, 'Dana Reed', 'manager', 'CHS'],
    [3, 'Christopher Benson', 'locksmith', 'ORL'],
    [4, 'Marcus Hale', 'locksmith', 'CHS'],
    [5, 'Rosa Lin', 'locksmith', 'COL'],
    [6, 'Dylan McLawhorn', 'locksmith', 'TPA']
  ];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, role, home_city, active) ' +
      "VALUES ($1,$2,$3,'x',$4,$5,true) ON CONFLICT (id) DO NOTHING",
      [p[0], p[1], 'u' + p[0] + '@example.com', p[2], p[3]]
    );
  }
  await pool.query("SELECT setval('users_id_seq', 100, true)");
}

// A recognition on the wins card. ageDays lets a test put one outside the window.
async function makeWin(userId, category, body, ageDays, opts) {
  opts = opts || {};
  const r = await pool.query(
    'INSERT INTO employee_records ' +
    '(user_id, type, category, body, status, visible_to_employee, show_in_wins, source, created_by, created_by_name, city_code, created_at) ' +
    "VALUES ($1,'recognition',$2,$3,'active',$4,$5,$6,1,$7,$8, NOW() - ($9 || ' days')::interval) RETURNING id",
    [userId, category, body,
     opts.visible === false ? false : true,
     opts.wins === false ? false : true,
     opts.source || 'manager',
     opts.by || 'Tony McKeon',
     opts.city || null,
     String(ageDays || 0)]
  );
  return r.rows[0].id;
}

function winById(payload, id) {
  var w = (payload.wins || []).filter(function (x) { return x.id === id; });
  return w.length ? w[0] : null;
}

(async function main() {
  section('initDB on a database that has never seen this schema');
  await db.initDB();
  var t = await pool.query("SELECT to_regclass('public.kudos') AS t");
  ok(t.rows[0].t === 'kudos', 'initDB created kudos');
  await db.initDB();
  ok(true, 'initDB ran twice without throwing (CLAUDE.md 1.4)');

  var cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='kudos'"))
    .rows.map(function (r) { return r.column_name; }).sort();
  eq(cols, ['created_at', 'from_name', 'from_user_id', 'id', 'pushed_at', 'record_id', 'seen_at', 'to_user_id'],
    'kudos carries exactly the columns the routes read');

  var idx = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename='kudos'"))
    .rows.map(function (r) { return r.indexname; });
  ok(idx.indexOf('kudos_one_each_idx') !== -1, 'the one-per-person-per-win unique index exists');
  ok(idx.indexOf('kudos_unseen_idx') !== -1, 'the partial unseen index exists');

  await seed();
  server = app.listen(0);

  var WIN = await makeWin(3, 'Customer service', 'Most Excellent Geico surveys in July.', 0, { city: 'ORL' });
  var OLD = await makeWin(3, 'Teamwork', 'Covered a route back in the spring.', 400, { city: 'ORL' });
  var MINE = await makeWin(4, 'Safety', 'Caught a bad tire before the run.', 1, { city: 'CHS' });

  // -----------------------------------------------------------------------
  section('anybody signed in can give one');
  as(PEER1);
  var g1 = await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});
  eq(g1.status, 200, 'a plain locksmith with no permissions at all can press it');
  eq(g1.body.kudos_mine, true, 'and is told their own button state');
  eq(g1.body.kudos_count, undefined, 'but is NOT handed the tally just for giving one');

  var n1 = await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1', [WIN]);
  eq(n1.rows[0].n, 1, 'one row landed');
  var row = (await pool.query('SELECT * FROM kudos WHERE record_id=$1', [WIN])).rows[0];
  eq(row.to_user_id, 3, 'to_user_id is copied off the record, not joined at read time');
  eq(row.from_name, 'Marcus Hale', 'the giver name is stored so the celebration needs no join');
  eq(row.seen_at, null, 'and it starts unseen');

  section('a second tap is the same intention, not an error');
  var g2 = await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});
  eq(g2.status, 200, 'the second tap answers cheerfully');
  var n2 = await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1', [WIN]);
  eq(n2.rows[0].n, 1, 'and still only one row exists');

  section('the guards');
  as(STAR);
  var self = await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});
  eq(self.status, 400, 'you cannot give yourself kudos');
  ok(String(self.body.error).indexOf('yourself') !== -1, 'and it says so in plain words');

  as(PEER1);
  var old = await req('POST', '/api/employee-records/wins/' + OLD + '/kudos', {});
  eq(old.status, 400, 'a win past KUDOS_WINDOW_DAYS is closed');
  var W = require('./routes/employeeRecords.js').KUDOS_WINDOW_DAYS;
  eq(typeof W, 'number', 'the window is exported so this test cannot drift from it');
  ok(String(old.body.error).indexOf(String(W)) !== -1, 'and the message names the actual window');

  var ghost = await req('POST', '/api/employee-records/wins/999999/kudos', {});
  eq(ghost.status, 404, 'an unknown win is refused');

  var unshared = await makeWin(3, 'Quiet', 'not on the card', 0, { wins: false });
  var uns = await req('POST', '/api/employee-records/wins/' + unshared + '/kudos', {});
  eq(uns.status, 404, 'a recognition that is not on the card cannot take a kudos');

  await pool.query("UPDATE employee_records SET status='void' WHERE id=$1", [MINE]);
  var voided = await req('POST', '/api/employee-records/wins/' + MINE + '/kudos', {});
  eq(voided.status, 404, 'nor can a voided one');
  await pool.query("UPDATE employee_records SET status='active' WHERE id=$1", [MINE]);

  // -----------------------------------------------------------------------
  section('THE COUNT GATE');
  as(PEER2);
  await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});
  as(PEER3);
  await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});

  // An ordinary coworker: button state, never a number.
  as(PEER2);
  var wPeer = winById((await req('GET', '/api/employee-records/wins')).body, WIN);
  eq(wPeer.kudos_mine, true, 'a giver sees their own button as pressed');
  ok(!('kudos_count' in wPeer), 'kudos_count is ABSENT for an ordinary coworker, not zero');
  ok(!('kudos_from' in wPeer), 'and so is the name list');
  eq(wPeer.kudos_open, true, 'the button is open on somebody else&#39;s recent win');

  // Somebody who has not pressed it.
  as(MGR);
  var wMgr = winById((await req('GET', '/api/employee-records/wins')).body, WIN);
  eq(wMgr.kudos_mine, false, 'a manager without view_employee_records sees an unpressed button');
  ok(!('kudos_count' in wMgr), 'and NO count - the gate is the permission, not the role');

  // The person it is about.
  as(STAR);
  var wStar = winById((await req('GET', '/api/employee-records/wins')).body, WIN);
  eq(wStar.is_me, true, 'the recipient is flagged');
  eq(wStar.kudos_count, 3, 'and IS given the count');
  eq(wStar.kudos_from.length, 3, 'with the names behind it');
  eq(wStar.kudos_open, false, 'and no button on their own win');

  // Somebody holding view_employee_records.
  PERMS.manager = ['view_employee_records'];
  as(MGR);
  var wPriv = winById((await req('GET', '/api/employee-records/wins')).body, WIN);
  eq(wPriv.kudos_count, 3, 'a holder of view_employee_records sees the count');
  eq(wPriv.kudos_open, true, 'and can still press the button themselves');
  var gm = await req('POST', '/api/employee-records/wins/' + WIN + '/kudos', {});
  eq(gm.body.kudos_count, 4, 'and gets the fresh count back on the press');
  PERMS.manager = [];

  section('no lifetime total exists anywhere');
  as(STAR);
  var payload = (await req('GET', '/api/employee-records/wins')).body;
  var keys = Object.keys(winById(payload, WIN)).sort();
  eq(keys.filter(function (k) { return /total|lifetime|rank|score/i.test(k); }), [],
    'nothing on a win row is a per-person aggregate');
  var oldRow = winById(payload, OLD);
  eq(oldRow.kudos_open, false, 'and an out-of-window win reports itself closed to the UI too');

  // -----------------------------------------------------------------------
  section('the celebration');
  as(STAR);
  var uns1 = await req('GET', '/api/employee-records/kudos/unseen');
  eq(uns1.status, 200, 'the recipient can read what is waiting');
  eq(uns1.body.batches.length, 1, 'grouped by win, not one entry per tap');
  eq(uns1.body.batches[0].count, 4, 'with the count on the batch');
  eq(uns1.body.batches[0].record_id, WIN, 'and the win it belongs to');
  eq(uns1.body.batches[0].category, 'Customer service', 'the celebration can name the win');
  eq(uns1.body.batches[0].names.length, 4, 'and everybody who pressed it');

  var stillUnseen = await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1 AND seen_at IS NULL', [WIN]);
  eq(stillUnseen.rows[0].n, 4, 'FETCHING the celebration does not mark it seen');

  as(PEER1);
  var none = await req('GET', '/api/employee-records/kudos/unseen');
  eq(none.body.batches.length, 0, 'somebody with nothing waiting gets an empty list, never a zero to render');

  section('dismissing is what stamps it');
  as(STAR);
  var seen = await req('POST', '/api/employee-records/kudos/seen', { record_ids: [WIN] });
  eq(seen.status, 200, 'the dismiss lands');
  var after = await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1 AND seen_at IS NULL', [WIN]);
  eq(after.rows[0].n, 0, 'every kudos in the batch is stamped');
  var again = await req('GET', '/api/employee-records/kudos/unseen');
  eq(again.body.batches.length, 0, 'and it never comes back');
  var twice = await req('POST', '/api/employee-records/kudos/seen', { record_ids: [WIN] });
  eq(twice.status, 200, 'dismissing twice is harmless');

  section('an un-shared win stops quoting itself');
  var WIN2 = await makeWin(3, 'Teamwork', 'Drove to Tampa on no notice.', 0, { city: 'ORL' });
  as(PEER1); await req('POST', '/api/employee-records/wins/' + WIN2 + '/kudos', {});
  as(STAR);
  eq((await req('GET', '/api/employee-records/kudos/unseen')).body.batches.length, 1, 'it is waiting');
  await pool.query('UPDATE employee_records SET visible_to_employee=false WHERE id=$1', [WIN2]);
  eq((await req('GET', '/api/employee-records/kudos/unseen')).body.batches.length, 0,
    'un-sharing the recognition stops the celebration quoting text they may no longer read');
  await pool.query('UPDATE employee_records SET visible_to_employee=true WHERE id=$1', [WIN2]);
  await pool.query("UPDATE employee_records SET status='void' WHERE id=$1", [WIN2]);
  eq((await req('GET', '/api/employee-records/kudos/unseen')).body.batches.length, 0, 'and so does voiding it');
  await pool.query("UPDATE employee_records SET status='active' WHERE id=$1", [WIN2]);

  section('kudos die with the record they hang on');
  var doomed = await makeWin(3, 'Gone', 'about to be deleted', 0);
  as(PEER1); await req('POST', '/api/employee-records/wins/' + doomed + '/kudos', {});
  eq((await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1', [doomed])).rows[0].n, 1, 'one landed');
  await pool.query('DELETE FROM employee_records WHERE id=$1', [doomed]);
  eq((await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE record_id=$1', [doomed])).rows[0].n, 0,
    'ON DELETE CASCADE takes them with it - no orphan pointing at a deleted record');

  // -----------------------------------------------------------------------
  section('the push job batches');
  PUSHES.length = 0;
  await pool.query('UPDATE kudos SET pushed_at = NULL');
  var r1 = await kudosJob.runKudosPush({ force: true });
  eq(PUSHES.length, 2, 'one push per (person, win) - four taps on one win are ONE notification');
  var toStar = PUSHES.filter(function (p) { return p.ids[0] === 3; });
  ok(toStar.length >= 1, 'the recipient is the one notified');
  ok(String(toStar[0].payload.body).indexOf('4 people') !== -1, 'the wording carries the batch size');
  ok(String(toStar[0].payload.body).indexOf('Customer service') !== -1, 'and names the win');

  PUSHES.length = 0;
  await kudosJob.runKudosPush({ force: true });
  eq(PUSHES.length, 0, 'a second sweep re-announces nothing');

  as(PEER2); await req('POST', '/api/employee-records/wins/' + WIN2 + '/kudos', {});
  PUSHES.length = 0;
  await kudosJob.runKudosPush({ force: true });
  eq(PUSHES.length, 1, 'but genuinely new kudos on the same win are new news');
  ok(String(PUSHES[0].payload.body).indexOf('Somebody gave you kudos') !== -1, 'and one kudos is not "1 people"');

  section('quiet hours');
  eq(kudosJob.inQuietHours(new Date('2026-08-29T02:00:00-04:00')), true, '2am Eastern is quiet');
  eq(kudosJob.inQuietHours(new Date('2026-08-29T22:30:00-04:00')), true, '10:30pm Eastern is quiet');
  eq(kudosJob.inQuietHours(new Date('2026-08-29T13:00:00-04:00')), false, '1pm Eastern is not');
  eq(kudosJob.inQuietHours(new Date('2026-08-29T07:30:00-04:00')), false, 'and 7:30am is the start of the day');
  as(PEER3); await req('POST', '/api/employee-records/wins/' + WIN2 + '/kudos', {});
  PUSHES.length = 0;
  // Unforced, so the real clock decides. Whatever it says, nothing may go out
  // during the quiet window and something must when it is open.
  var res2 = await kudosJob.runKudosPush();
  if (kudosJob.inQuietHours()) {
    eq(res2.skipped, 'quiet_hours', 'during quiet hours the sweep holds');
    eq(PUSHES.length, 0, 'and sends nothing');
    var held = await pool.query('SELECT COUNT(*)::int AS n FROM kudos WHERE pushed_at IS NULL');
    ok(held.rows[0].n > 0, 'the backlog is held, not dropped');
  } else {
    eq(PUSHES.length, 1, 'outside quiet hours it goes');
  }

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  server.close();
  await pool.end();
  await db.pool.end().catch(function () {});
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
