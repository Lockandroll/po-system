'use strict';
/*
 * Peer shout-outs, end to end against a REAL Postgres.
 *
 * What it pins:
 *   - initDB() creates shoutouts on a database that has never seen it, and is
 *     safe to run twice;
 *   - a peer can nominate somebody canActOn() would refuse them to document;
 *   - approving SPAWNS an employee_records recognition credited to the AUTHOR,
 *     with the approver stored separately, visible_to_employee forced true;
 *   - GET /wins reports the author, not the approver, and flags the peer source;
 *   - the approval queue only ever contains rows the viewer may actually clear;
 *   - declining writes nothing to employee_records and tells nobody but the author;
 *   - the pending cap, the one-pending-per-pair rule and the double-handle guard.
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

var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return require('./db.js');
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = Object.assign({}, CURRENT_USER); next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
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
    }
  };
  if (request === '../utils/email') return {
    sendEmail: async function (to, subject, html) { MAILS.push({ to: to, subject: subject, html: html }); },
    emailTemplate: function (o) { return '<html>' + (o.body || '') + '</html>'; }
  };
  if (request === '../utils/sms') return { sendSms: async function (to, text) { SMSES.push({ to: to, text: text }); } };
  if (request === '../utils/notify') return { push: async function () {} };
  if (request === '../utils/permissions') return {
    hasPermission: async function () { return true; },
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
  eq(MAILS.length, 0, 'and tells the recipient nothing at all');

  // -----------------------------------------------------------------------
  section('the guards on submitting');
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
  section('audit trail');
  var aud = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'shoutout' ORDER BY id")).rows.map(function (r) { return r.action; });
  ok(aud.indexOf('submitted') !== -1, 'submitting is audited');
  ok(aud.indexOf('approved') !== -1, 'approving is audited');
  ok(aud.indexOf('declined') !== -1, 'declining is audited');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  server.close();
  await pool.end();
  await db.pool.end().catch(function () {});
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
