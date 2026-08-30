'use strict';
/*
 * Peer shout-outs, end to end against a REAL Postgres.
 *
 * What it pins:
 *   - initDB() creates shoutouts on a database that has never seen it, and is
 *     safe to run twice;
 *   - a peer can nominate somebody canActOn() would refuse them to document;
 *   - and a MANAGER's own shout-out skips the queue entirely, because they
 *     already hold the authority the queue was waiting for;
 *   - submitting one tells the people who can release it;
 *   - approving SPAWNS an employee_records recognition credited to the AUTHOR,
 *     with the approver stored separately, visible_to_employee forced true;
 *   - GET /wins reports the author, not the approver, and flags the peer source;
 *   - the approval queue only ever contains rows the viewer may actually clear;
 *   - declining writes nothing to employee_records and tells nobody but the author;
 *   - the pending cap, the one-pending-per-pair rule and the double-handle guard;
 *   - the one-time backfill releases the shout-outs that queued behind a
 *     manager BEFORE the rule changed, leaves everybody else's alone, and never
 *     runs twice.
 *
 *   PGURL=postgres://postgres@127.0.0.1:5433/shoutout_test node test-shoutouts.js
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

/* ---- who is calling, and what the org chart says ------------------------- */
var CURRENT_USER = { id: 1, name: 'Admin', role: 'admin', isOwner: true };
var MAILS = [];      // every tellEmployee() send, so "who was told" is assertable
var SMSES = [];
// scope + rank, driven per-test. teamIds is who a viewer may OPEN; canOpenFile
// is the rank rule on top of it.
var ORG = { team: {}, upline: {} };
// Who holds create_employee_note in this fixture. Ticked on for managers, dark
// for everybody else - which is how it ships.
var NOTE_ROLES = ['manager'];

function settle(ms) { return new Promise(function (r) { setTimeout(r, ms || 300); }); }

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return require('./db.js');
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; },
    userHasExtraPerm: async function () { return false; }
  };
  if (request === '../utils/audit') return { logAudit: async function (e) {
    await pool.query('INSERT INTO audit_logs (entity_type, entity_id, action, user_id, user_name, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.entity_type, String(e.entity_id), e.action, e.user_id, e.user_name, JSON.stringify(e.details || {})]);
  } };
  if (request === '../utils/org') return {
    teamIds: async function (id) { return ORG.team[id] || []; },
    canOpenFile: async function (viewer, target) {
      if (viewer.role === 'admin' || viewer.role === 'owner') return true;
      return (ORG.team[viewer.id] || []).indexOf(target.id) !== -1;
    },
    isUpline: async function (maybeBoss, ofUser) {
      return (ORG.upline[ofUser] || []).indexOf(maybeBoss) !== -1;
    },
    RANK: { owner: 4, admin: 3, manager: 2 },
    rankOf: function (u) {
      if (!u) return 0;
      if (u.isOwner === true) return 4;
      return ({ owner: 4, admin: 3, manager: 2 })[u.role] || 1;
    }
  };
  if (request === '../utils/email') return {
    sendEmail: async function (to, subject, html) { MAILS.push({ to: to, subject: subject, html: html }); },
    emailTemplate: function (o) { return '<html>' + (o.body || '') + '</html>'; }
  };
  if (request === '../utils/sms') return { sendSms: async function (to, text) { SMSES.push({ to: to, text: text }); } };
  if (request === '../utils/notify') return { push: async function () {} };
  if (request === '../utils/permissions') return {
    hasPermission: async function (role, perm) {
      if (role === 'admin' || role === 'owner') return true;
      if (perm === 'create_employee_note') return NOTE_ROLES.indexOf(role) !== -1;
      return true;
    },
    defaultHas: function (role, perm) {
      if (role === 'admin' || role === 'owner') return true;
      if (perm === 'create_employee_note') return NOTE_ROLES.indexOf(role) !== -1;
      return true;
    },
    ALL_PERMS: []
  };
  if (request === '../utils/recordCheck') return { checkRecord: async function () { return { available: false, fields: {} }; } };
  if (request === '../utils/r2') return { presignPut: async function () { return ''; }, presignGet: async function () { return ''; }, del: async function () {} };
  if (request === '../utils/policySuggest') return { suggest: async function () { return []; } };
  if (request === '../utils/docText') return { extract: async function () { return ''; } };
  if (request === '../utils/lateEvents') return { lateEvents: async function () { return []; } };
  return origLoad.apply(this, arguments);
};

var express = require('express');
var db = require('./db.js');
var router = require('./routes/employeeRecords.js');
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

var ADMIN = { id: 1, name: 'Tony McKeon', role: 'admin', isOwner: true };
var MGR   = { id: 2, name: 'Dana Reed', role: 'manager' };
var TECH  = { id: 3, name: 'Christopher Benson', role: 'locksmith' };
var PEER  = { id: 4, name: 'Marcus Hale', role: 'locksmith' };
var OTHER = { id: 5, name: 'Rosa Lin', role: 'locksmith' };   // another market

async function seed() {
  var people = [
    [1, 'Tony McKeon', 'tony@example.com', 'admin', 'CHS', null, '+18435550001'],
    [2, 'Dana Reed', 'dana@example.com', 'manager', 'CHS', 1, '+18435550002'],
    [3, 'Christopher Benson', 'chris@example.com', 'locksmith', 'CHS', 2, '+18435550003'],
    [4, 'Marcus Hale', 'marcus@example.com', 'locksmith', 'CHS', 2, '+18435550004'],
    [5, 'Rosa Lin', 'rosa@example.com', 'locksmith', 'COL', 1, '+18435550005']
  ];
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, role, home_city, supervisor_id, phone, active, receive_emails, receive_sms) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true,true) ON CONFLICT (id) DO NOTHING',
      [p[0], p[1], p[2], 'x', p[3], p[4], p[5], p[6]]
    );
  }
  await pool.query("SELECT setval('users_id_seq', 100, true)");
  // Dana manages Chris and Marcus. Nobody manages Rosa but the admin.
  ORG.team = { 2: [3, 4], 1: [2, 3, 4, 5] };
  ORG.upline = { 3: [2, 1], 4: [2, 1], 5: [1], 2: [1] };
}

(async function main() {
  section('initDB on a database that has never seen this schema');
  await db.initDB();
  var t = await pool.query("SELECT to_regclass('public.shoutouts') AS t");
  ok(t.rows[0].t === 'shoutouts', 'initDB created shoutouts');
  // Idempotent: §1.4 says every statement must survive a second boot.
  await db.initDB();
  ok(true, 'initDB ran twice without throwing');
  var cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='shoutouts'")).rows.map(function (r) { return r.column_name; }).sort();
  eq(cols.indexOf('record_id') !== -1 && cols.indexOf('decline_reason') !== -1 && cols.indexOf('reviewed_by') !== -1, true, 'shoutouts carries record_id, reviewed_by, decline_reason');

  await seed();
  server = app.listen(0);

  // -----------------------------------------------------------------------
  section('a peer may nominate somebody they could never document');
  as(PEER);
  // The premise: canActOn refuses Marcus writing a record about Chris.
  var direct = await req('POST', '/api/employee-records/notes', { type: 'recognition', user_id: 3, body: 'x', visible_to_employee: true });
  eq(direct.status, 403, 'POST /notes still refuses a peer outright');

  var sent = await req('POST', '/api/employee-records/shoutouts', {
    to_user_id: 3, category: 'Customer service',
    body: 'Stayed two hours past his shift to finish a lockout for a customer with a baby in the car.'
  });
  eq(sent.status, 200, 'the same peer CAN send a shout-out');
  var soId = sent.body.id;
  ok(soId > 0, 'the shout-out has an id');

  var recCount = await pool.query('SELECT COUNT(*)::int AS n FROM employee_records');
  eq(recCount.rows[0].n, 0, 'a pending shout-out writes NOTHING to employee_records');
  await settle();
  eq(MAILS.filter(function (m) { return m.to === 'chris@example.com'; }).length, 0,
    'and tells the person it is about nothing at all');
  eq(SMSES.length, 0, 'nor texts anybody');

  // Until 2026-08-30 nothing anywhere announced a pending shout-out: it was a
  // number on one button on one screen. That is how the first one ever written
  // sat unread.
  var toDana = MAILS.filter(function (m) { return m.to === 'dana@example.com'; });
  eq(toDana.length, 1, 'the manager who can release it is told it is waiting');
  ok(toDana[0].html.indexOf('Christopher Benson') !== -1, 'and it names who it is about');
  ok(toDana[0].html.indexOf('Marcus Hale') !== -1, 'and who wrote it');
  eq(MAILS.filter(function (m) { return m.to === 'marcus@example.com'; }).length, 0,
    'the author is not told about their own shout-out');
  eq(MAILS.filter(function (m) { return m.to === 'rosa@example.com'; }).length, 0,
    'and somebody with no authority over Chris is not pestered');
  MAILS = []; SMSES = [];

  // -----------------------------------------------------------------------
  //
  // 2026-08-30. A manager writing a shout-out is not asking permission: they
  // already hold create_employee_note, which is the authority the queue was
  // waiting for. It used to queue anyway - behind themselves - and sat there.
  section('a manager does not wait for a manager');
  MAILS = []; SMSES = [];
  as(MGR);
  var mgrSent = await req('POST', '/api/employee-records/shoutouts', {
    to_user_id: 4, category: 'Teamwork', body: 'Took the on-call weekend so somebody else could be at a wedding.'
  });
  eq(mgrSent.status, 200, 'the manager sends one');
  eq(mgrSent.body.posted, true, 'and it is posted, not queued');
  ok(mgrSent.body.record_id > 0, 'the response hands back the record it became');

  var mgrSo = (await pool.query('SELECT * FROM shoutouts WHERE id = $1', [mgrSent.body.id])).rows[0];
  eq(mgrSo.status, 'approved', 'the shout-out row is already resolved');
  eq(mgrSo.reviewed_by, 2, 'reviewed by the person who wrote it');
  ok(mgrSo.reviewed_at !== null, 'with a timestamp');

  var mgrRec = (await pool.query('SELECT * FROM employee_records WHERE id = $1', [mgrSent.body.record_id])).rows[0];
  eq(mgrRec.user_id, 4, 'the record is on the right person');
  eq(mgrRec.created_by, 2, 'credited to the manager who wrote it');
  eq(mgrRec.approver_id, 2, 'who is also the approver of record');
  eq(mgrRec.source, 'shoutout', 'it is still a shout-out, not a hand-written note');
  eq(mgrRec.visible_to_employee, true, 'and the person can see it');

  await settle();
  var mgrToMarcus = MAILS.filter(function (m) { return m.to === 'marcus@example.com'; });
  eq(mgrToMarcus.length, 1, 'the recipient is told, once');
  ok(mgrToMarcus[0].subject.indexOf('Dana Reed') !== -1, 'and it names the manager who wrote it');
  eq(MAILS.filter(function (m) { return m.to === 'dana@example.com'; }).length, 0,
    'nobody emails the author to tell her she approved herself');
  eq(MAILS.filter(function (m) { return m.to === 'tony@example.com'; }).length, 0,
    'and no approver is asked to look at something already posted');

  var mgrAud = (await pool.query(
    "SELECT action FROM audit_logs WHERE entity_type = 'shoutout' AND entity_id = $1 ORDER BY id",
    [String(mgrSent.body.id)])).rows.map(function (r) { return r.action; });
  eq(mgrAud, ['submitted', 'posted'], 'the trail says submitted then posted, not approved');

  // The owner too, and by rank alone - Tony holds every permission, but a
  // manager with the permission ticked off would still get here on rank.
  as(ADMIN);
  var admSent = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 5, body: 'Drove the spare van two markets over.' });
  eq(admSent.body.posted, true, 'the owner posts directly too');
  await pool.query('DELETE FROM employee_records WHERE id = $1', [admSent.body.record_id]);
  await pool.query('DELETE FROM shoutouts WHERE id = $1', [admSent.body.id]);

  // ...and a locksmith still does not, whatever else changed.
  as(OTHER);
  var peerSent = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 3, body: 'Talked me through a bad ignition on the phone.' });
  eq(peerSent.body.posted, false, 'a locksmith still waits for an approver');
  await pool.query('DELETE FROM shoutouts WHERE id = $1', [peerSent.body.id]);
  MAILS = []; SMSES = [];

  // -----------------------------------------------------------------------
  section('the guards on submitting');
  as(PEER);
  var self = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 4, body: 'me' });
  eq(self.status, 400, 'you cannot shout out yourself');
  var dup = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 3, body: 'again' });
  eq(dup.status, 409, 'one pending shout-out per pair');
  var empty = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 5, body: '   ' });
  eq(empty.status, 400, 'an empty body is refused');
  var ghost = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 999, body: 'who' });
  eq(ghost.status, 400, 'an unknown person is refused');

  // The pending cap. Marcus already has one pending; a pile of HANDLED ones must
  // not count toward it, and a pile of pending ones must.
  var MAXP = require('./routes/employeeRecords.js').SHOUTOUT_MAX_PENDING;
  eq(typeof MAXP, 'number', 'the cap is exported so this test cannot drift from it');
  // Filler targets, so the one-pending-per-pair index is never the thing under
  // test here. Ten spare bodies, none of them in anybody&#39;s scope.
  for (var k = 0; k < MAXP + 2; k++) {
    await pool.query(
      'INSERT INTO users (id, name, email, password_hash, role, active) ' +
      "VALUES ($1,$2,$3,'x','locksmith',true) ON CONFLICT (id) DO NOTHING",
      [200 + k, 'Filler ' + k, 'filler' + k + '@example.com']);
    await pool.query(
      "INSERT INTO shoutouts (to_user_id, from_user_id, from_name, body, status) VALUES ($1,4,'Marcus Hale','filler','approved')",
      [200 + k]);
  }
  var stillOk = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 5, body: 'Covered my route on no notice.' });
  eq(stillOk.status, 200, 'handled shout-outs do not count against the cap');
  await pool.query("UPDATE shoutouts SET status='pending' WHERE from_user_id=4 AND to_user_id >= 200");
  var capped = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 2, body: 'thanks' });
  eq(capped.status, 429, 'the pending cap holds');
  ok(String(capped.body.error).indexOf('waiting') !== -1, 'and it says why in plain words');
  await pool.query('DELETE FROM shoutouts WHERE to_user_id >= 200 OR to_user_id = 5');
  await pool.query('DELETE FROM users WHERE id >= 200');

  // -----------------------------------------------------------------------
  section('the queue only shows rows the viewer may clear');
  as(MGR);
  var q = await req('GET', '/api/employee-records/shoutouts/pending');
  eq(q.status, 200, 'the manager can read the queue');
  eq((q.body.shoutouts || []).length, 1, 'Dana sees the one for her own tech');
  eq(q.body.shoutouts[0].to_name, 'Christopher Benson', 'and it is the right row');
  eq(q.body.shoutouts[0].from_name, 'Marcus Hale', 'the queue names who wrote it');

  // A shout-out about Rosa, who Dana does not manage.
  as(PEER);
  await req('POST', '/api/employee-records/shoutouts', { to_user_id: 5, body: 'Drove the spare van up for us.' });
  as(MGR);
  var q2 = await req('GET', '/api/employee-records/shoutouts/pending');
  eq((q2.body.shoutouts || []).length, 1, 'the out-of-scope row is not in Dana&#39;s queue');
  as(ADMIN);
  var q3 = await req('GET', '/api/employee-records/shoutouts/pending');
  eq((q3.body.shoutouts || []).length, 2, 'the admin sees both');

  // The badge and the queue read the same helper, so they cannot disagree - a
  // count that says 1 over a screen that says none is how somebody concludes
  // the feature is broken and stops looking.
  var badge = await req('GET', '/api/employee-records/me/pending');
  eq(badge.body.shoutouts, 2, 'the sidebar count matches what the admin can clear');
  as(MGR);
  var badge2 = await req('GET', '/api/employee-records/me/pending');
  eq(badge2.body.shoutouts, 1, 'and is scoped for the manager exactly like the queue');
  as(TECH);
  var badge3 = await req('GET', '/api/employee-records/me/pending');
  eq(badge3.body.shoutouts, 0, 'somebody who cannot release one is never given a number');
  as(MGR);

  // A manager cannot approve one about somebody above them.
  as(PEER);
  await req('POST', '/api/employee-records/shoutouts', { to_user_id: 1, body: 'Answered the phone at 2am.' });
  as(MGR);
  var q4 = await req('GET', '/api/employee-records/shoutouts/pending');
  var forBoss = (q4.body.shoutouts || []).filter(function (x) { return x.to_user_id === 1; });
  eq(forBoss.length, 0, 'a shout-out about your own boss is not yours to approve');

  // -----------------------------------------------------------------------
  section('approving spawns a record credited to the AUTHOR');
  MAILS = []; SMSES = [];
  as(MGR);
  var appr = await req('POST', '/api/employee-records/shoutouts/' + soId + '/approve', { show_in_wins: true });
  eq(appr.status, 200, 'the manager approves it');
  var rec = (await pool.query('SELECT * FROM employee_records WHERE id = $1', [appr.body.record_id])).rows[0];
  eq(rec.type, 'recognition', 'the record is a recognition');
  eq(rec.user_id, 3, 'it is on the right person');
  eq(rec.created_by, 4, 'created_by is the COWORKER who wrote it');
  eq(rec.created_by_name, 'Marcus Hale', 'and so is created_by_name');
  eq(rec.approver_id, 2, 'the approver is recorded separately');
  eq(rec.approver_name, 'Dana Reed', 'by name');
  ok(rec.approved_at !== null, 'with a timestamp');
  eq(rec.source, 'shoutout', 'the source marks it as a peer shout-out');
  eq(rec.visible_to_employee, true, 'visible_to_employee is forced true');
  eq(rec.show_in_wins, true, 'and it is on Recent Wins');
  eq(rec.status, 'active', 'active, not pending_approval - approval already happened');

  var so = (await pool.query('SELECT * FROM shoutouts WHERE id = $1', [soId])).rows[0];
  eq(so.status, 'approved', 'the shout-out is marked approved');
  eq(so.record_id, rec.id, 'and points at what it spawned');
  eq(so.reviewed_by_name, 'Dana Reed', 'with the reviewer on it');

  var toChris = MAILS.filter(function (m) { return m.to === 'chris@example.com'; });
  var toMarcus = MAILS.filter(function (m) { return m.to === 'marcus@example.com'; });
  eq(toChris.length, 1, 'the recipient is told, once');
  ok(toChris[0].subject.indexOf('Marcus Hale') !== -1, 'and the subject names the coworker, not the manager');
  ok(toChris[0].subject.indexOf('Dana') === -1, 'the approver is not presented as the author');
  eq(toMarcus.length, 1, 'the author is told it landed');
  eq(SMSES.length, 1, 'one SMS, to the recipient');
  ok(SMSES[0].text.indexOf('Marcus Hale') !== -1, 'the SMS names the coworker too');

  var twice = await req('POST', '/api/employee-records/shoutouts/' + soId + '/approve', {});
  eq(twice.status, 409, 'a handled shout-out cannot be handled again');

  // -----------------------------------------------------------------------
  section('GET /wins reports the author, not the approver');
  as(TECH);
  var w = await req('GET', '/api/employee-records/wins');
  eq(w.status, 200, 'wins loads');
  var mine = (w.body.wins || []).filter(function (x) { return x.id === rec.id; })[0];
  ok(!!mine, 'the new win is on the card');
  eq(mine.name, 'Christopher Benson', 'the employee name is the recipient');
  eq(mine.by, 'Marcus Hale', 'the credit line names the coworker who wrote it');
  eq(mine.peer, true, 'and it is flagged as a peer shout-out');
  eq(mine.is_me, true, 'the recipient sees the YOU badge');
  eq(mine.category, 'Customer service', 'the category rides along');
  eq(mine.city, 'CHS', 'and the row carries its own market');

  // Company-wide since 2026-08-28. Rosa is in COL and Chris is in CHS; each must
  // see BOTH, or the card is back to being city-scoped without saying so.
  as(OTHER);
  var wOther = await req('GET', '/api/employee-records/wins');
  eq((wOther.body.wins || []).filter(function (x) { return x.id === rec.id; }).length, 1,
    'somebody in another market sees the Charleston win');
  eq(wOther.body.city, null, 'and the payload no longer stamps a single city on the list');

  // A manager-written recognition credits the manager and is NOT flagged peer.
  as(MGR);
  var note = await req('POST', '/api/employee-records/notes', {
    type: 'recognition', user_id: 4, category: 'Safety', body: 'Caught a bad tire before the run.',
    visible_to_employee: true, show_in_wins: true, notify: false
  });
  eq(note.status, 200, 'a manager can still write one directly');
  as(PEER);
  var w2 = await req('GET', '/api/employee-records/wins');
  var direct2 = (w2.body.wins || []).filter(function (x) { return x.id === note.body.id; })[0];
  eq(direct2.by, 'Dana Reed', 'a manager-written win credits the manager');
  eq(direct2.peer, false, 'and is not flagged as a shout-out');

  // A person with no Home City set must not break the row or invent one.
  await pool.query('UPDATE users SET home_city = NULL WHERE id = 4');
  var w2b = await req('GET', '/api/employee-records/wins');
  var noCity = (w2b.body.wins || []).filter(function (x) { return x.id === note.body.id; })[0];
  ok(!!noCity, 'the win still renders with no Home City on file');
  eq(noCity.city, 'CHS', 'and falls back to the city stamped on the record itself');
  await pool.query("UPDATE users SET home_city = 'CHS' WHERE id = 4");

  // -----------------------------------------------------------------------
  section('the approver may tidy the wording, and the original is kept');
  as(PEER);
  var s2 = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 3, body: 'he done real good on that job tuesday' });
  eq(s2.status, 200, 'a second shout-out for Chris is allowed once the first is handled');
  as(MGR);
  var a2 = await req('POST', '/api/employee-records/shoutouts/' + s2.body.id + '/approve', {
    body: 'Handled a difficult job on Tuesday start to finish without needing a second tech.',
    category: 'Ownership', show_in_wins: false
  });
  eq(a2.status, 200, 'approved with edited wording');
  var rec2 = (await pool.query('SELECT * FROM employee_records WHERE id = $1', [a2.body.record_id])).rows[0];
  ok(rec2.body.indexOf('difficult job on Tuesday') !== -1, 'the edited wording is what went on the file');
  eq(rec2.created_by_name, 'Marcus Hale', 'the edit does not steal the credit');
  eq(rec2.show_in_wins, false, 'show_in_wins off keeps it off the Home screen');
  eq(rec2.visible_to_employee, true, 'but the employee can still see it in their own file');
  var evs = (await pool.query('SELECT action, note FROM employee_record_events WHERE record_id = $1 ORDER BY id', [rec2.id])).rows;
  var edited = evs.filter(function (e) { return e.action === 'wording_edited'; });
  eq(edited.length, 1, 'the edit is on the event trail');
  ok(edited[0].note.indexOf('he done real good') !== -1, 'and the original wording is kept in it');

  as(TECH);
  var w3 = await req('GET', '/api/employee-records/wins');
  eq((w3.body.wins || []).filter(function (x) { return x.id === rec2.id; }).length, 0, 'and it is genuinely off the wins card');

  // -----------------------------------------------------------------------
  section('declining');
  MAILS = []; SMSES = [];
  as(PEER);
  var s3 = await req('POST', '/api/employee-records/shoutouts', { to_user_id: 3, body: 'lol chris is the best' });
  as(MGR);
  var before = (await pool.query('SELECT COUNT(*)::int AS n FROM employee_records')).rows[0].n;
  var dec = await req('POST', '/api/employee-records/shoutouts/' + s3.body.id + '/decline', { reason: 'Give me a specific example and I will post it.' });
  eq(dec.status, 200, 'the manager declines it');
  var after = (await pool.query('SELECT COUNT(*)::int AS n FROM employee_records')).rows[0].n;
  eq(after, before, 'a declined shout-out writes NOTHING to employee_records');
  eq(MAILS.filter(function (m) { return m.to === 'chris@example.com'; }).length, 0, 'the person it was about is never told');
  var authorMail = MAILS.filter(function (m) { return m.to === 'marcus@example.com'; });
  eq(authorMail.length, 1, 'only the author hears back');
  ok(authorMail[0].html.indexOf('specific example') !== -1, 'and the reason is passed through as written');
  eq(SMSES.length, 0, 'no SMS on a decline');

  var s3row = (await pool.query('SELECT * FROM shoutouts WHERE id = $1', [s3.body.id])).rows[0];
  eq(s3row.status, 'declined', 'the row is marked declined');
  eq(s3row.record_id, null, 'with no record behind it');

  // -----------------------------------------------------------------------
  section('what the author can see');
  as(PEER);
  var m = await req('GET', '/api/employee-records/shoutouts/mine');
  eq(m.status, 200, 'the author can list what they sent');
  var statuses = (m.body.shoutouts || []).map(function (x) { return x.status; }).sort();
  ok(statuses.indexOf('approved') !== -1 && statuses.indexOf('declined') !== -1, 'approved and declined both show');
  ok((m.body.shoutouts || []).every(function (x) { return x.to_name; }), 'each names who it was for');
  as(TECH);
  var m2 = await req('GET', '/api/employee-records/shoutouts/mine');
  eq((m2.body.shoutouts || []).length, 0, 'and it is scoped to the author, not the recipient');

  // -----------------------------------------------------------------------
  section('the people list carries no contact details');
  as(TECH);
  var pl = await req('GET', '/api/employee-records/shoutouts/people');
  eq(pl.status, 200, 'anybody who can submit can read it');
  var keys = Object.keys(pl.body.people[0]).sort();
  eq(keys, ['home_city', 'id', 'name', 'role'], 'name, role and city ONLY - no email, no phone, no supervisor');
  eq(pl.body.people.filter(function (p) { return p.id === 3; }).length, 0, 'you are not in your own list');

  // -----------------------------------------------------------------------
  section('nothing here leaks discipline');
  as(ADMIN);
  await req('POST', '/api/employee-records/notes', {
    type: 'coaching', user_id: 3, body: 'Late again.', visible_to_employee: true, show_in_wins: true, notify: false
  });
  as(PEER);
  var w4 = await req('GET', '/api/employee-records/wins');
  var kinds = [];
  for (var i = 0; i < (w4.body.wins || []).length; i++) {
    var r = (await pool.query('SELECT type FROM employee_records WHERE id = $1', [w4.body.wins[i].id])).rows[0];
    kinds.push(r.type);
  }
  eq(kinds.filter(function (x) { return x !== 'recognition'; }).length, 0, 'only recognition ever reaches the wins card');

  // -----------------------------------------------------------------------
  //
  // The rows that queued before 2026-08-30. They are not waiting on a decision -
  // the decision was made when their author was given the authority - so they go
  // out on the deploy that changes the rule rather than sitting somewhere nobody
  // had a reason to look. This is the part that actually clears Tony's queue.
  section('the one-time release of what already queued');
  MAILS = []; SMSES = [];
  await pool.query(
    "INSERT INTO shoutouts (id, to_user_id, from_user_id, from_name, category, body, status, city_code) " +
    "VALUES (901, 3, 2, 'Dana Reed', 'Ownership', 'Ran the whole board on his own when I was out.', 'pending', 'CHS')");
  await pool.query(
    "INSERT INTO shoutouts (id, to_user_id, from_user_id, from_name, body, status, city_code) " +
    "VALUES (902, 3, 5, 'Rosa Lin', 'Answered my questions all week.', 'pending', 'CHS')");

  var job = require('./jobs/employeeRecords.js');
  var ran = await job.runShoutoutRelease();
  eq(ran.released, 1, 'exactly the manager-written one goes out');
  // Everything still pending at this point was written by a locksmith - the two
  // left over from the queue section plus 902 - and every one of them stays put.
  ok(ran.left >= 1, 'the ones that genuinely need an approver are counted, not released');
  var selfFreedPeer = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM shoutouts WHERE status = 'approved' AND reviewed_by = from_user_id AND from_user_id NOT IN (1,2)"
  )).rows[0].n;
  eq(selfFreedPeer, 0, 'and no locksmith ever released their own');

  var freed = (await pool.query('SELECT * FROM shoutouts WHERE id = 901')).rows[0];
  eq(freed.status, 'approved', 'the manager-written row is released');
  eq(freed.reviewed_by, 2, 'by its own author, who had the authority all along');
  ok(freed.record_id > 0, 'and it spawned a record');
  var freedRec = (await pool.query('SELECT * FROM employee_records WHERE id = $1', [freed.record_id])).rows[0];
  eq(freedRec.user_id, 3, 'on the right person');
  eq(freedRec.created_by_name, 'Dana Reed', 'credited to whoever wrote it');
  eq(freedRec.type, 'recognition', 'as a recognition');
  eq(freedRec.visible_to_employee, true, 'the person can see it');

  var stillWaiting = (await pool.query('SELECT status FROM shoutouts WHERE id = 902')).rows[0];
  eq(stillWaiting.status, 'pending', "a locksmith's shout-out still waits for a manager");

  eq(MAILS.filter(function (m) { return m.to === 'chris@example.com'; }).length, 1,
    'the recipient is told, once, and only about the released one');

  // Runs once, ever. A restart loop must not re-notify the company.
  MAILS = [];
  await pool.query(
    "INSERT INTO shoutouts (id, to_user_id, from_user_id, from_name, body, status) " +
    "VALUES (903, 4, 2, 'Dana Reed', 'Second one, after the backfill already ran.', 'pending')");
  var again = await job.runShoutoutRelease();
  eq(again.skipped, true, 'the second call is a no-op');
  eq((await pool.query("SELECT status FROM shoutouts WHERE id = 903")).rows[0].status, 'pending',
    'and it does not touch anything new');
  eq(MAILS.length, 0, 'nobody is emailed twice');
  await pool.query('DELETE FROM shoutouts WHERE id = 903');

  // -----------------------------------------------------------------------
  section('audit trail');
  var aud = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'shoutout' ORDER BY id")).rows.map(function (r) { return r.action; });
  ok(aud.indexOf('submitted') !== -1, 'submitting is audited');
  ok(aud.indexOf('approved') !== -1, 'approving is audited');
  ok(aud.indexOf('declined') !== -1, 'declining is audited');
  ok(aud.indexOf('posted') !== -1, 'and a manager posting straight out is audited as its own action');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  server.close();
  await pool.end();
  await db.pool.end().catch(function () {});
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
