'use strict';
/*
 * Swoop (Agero) review surveys - end-to-end check against a REAL Postgres.
 *
 *   DATABASE_URL=postgres://.../empty_db JWT_SECRET=x node test-swoop.js
 *
 * Point it at an EMPTY scratch database: it seeds its own users and cities.
 *
 * Runs initDB() twice (idempotency), then drives the parser, the NPS maths, the
 * mailbox upsert, the low-score complaint filer and the HTTP routes behind the
 * real requireAuth with real JWTs. The AI classifier, email, SMS and push
 * senders are stubbed so nothing leaves the machine. Manual, like the other
 * test-*.js scripts: not wired to CI.
 *
 * House style: string concatenation only, no template literals.
 */
var Module = require('module');
var path = require('path');

// ---- stub the outbound side of utils/feedbackIntake before anything loads it
var sent = { email: 0, sms: 0, taskNotify: 0 };
var STUBS = {};
STUBS[path.join(__dirname, 'utils/email.js')] = {
  sendEmail: async function () { sent.email++; return { id: 'stub' }; },
  emailTemplate: function (o) { return '<html>' + (o && o.title) + '</html>'; }
};
STUBS[path.join(__dirname, 'utils/sms.js')] = { sendSms: async function () { sent.sms++; } };
STUBS[path.join(__dirname, 'utils/feedbackAI.js')] = {
  classifyFeedback: async function () { return { category: 'complaint', severity: 'medium', sentiment: 'negative', summary: 'stub summary' }; }
};
STUBS[path.join(__dirname, 'utils/notify.js')] = {
  broadcastRecipients: async function () { return { emails: [], phones: [] }; }
};
STUBS[path.join(__dirname, 'utils/taskFromEmail.js')] = { resolveAssignee: async function () { return null; } };
STUBS[path.join(__dirname, 'jobs/taskReminders.js')] = { notifyTaskAssigned: async function () { sent.taskNotify++; } };
var graphMessages = [];
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  // Resolve by path rather than through Node, so a stub works whether or not
  // the real file is present next to this script.
  if (parent && parent.filename && /^\.\.?\//.test(request)) {
    var target = path.resolve(path.dirname(parent.filename), request);
    if (!/\.js$/.test(target)) target += '.js';
    if (STUBS[target]) return STUBS[target];
  }
  return origLoad.apply(this, arguments);
};

var http = require('http');
var express = require('express');
var jwt = require('jsonwebtoken');
var db = require('./db');
var pool = db.pool;

// Graph is the one network call in the job; replace it after load.
var graph = require('./utils/graph');
graph.getMessagesBySubject = async function () { return graphMessages; };

var SW = require('./utils/swoopSurvey');
var J = require('./jobs/swoopSurveys');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function eq(a, b, label) { ok(JSON.stringify(a) === JSON.stringify(b), label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function section(t) { console.log('\n== ' + t); }

function email(job, score, opts) {
  opts = opts || {};
  var fb = opts.feedback == null ? '' : opts.feedback;
  var shape = opts.shape || 'inline';
  var body;
  if (shape === 'inline') {
    body = 'New Review for ID #' + job + '\n\nNPS Score: ' + score + '\nFeedback: ' + fb + '\nAccount: Swoop\nDriver: ' +
      (opts.driver || 'Beardshear Jesse') + '\nPickup Contact: Gene Davenport\nPickup Number: +16892361715\n\n' +
      'Agero Proprietary and Confidential\n© 2026 Agero, Inc.';
  } else {
    // Outlook flattening a two-column table onto separate lines, with an empty Feedback cell.
    body = 'SWOOP\r\nNew Review for ID #' + job + '\r\n\r\nNPS Score:\r\n' + score + '\r\nFeedback:\r\n' + fb + '\r\nAccount:\r\nSwoop\r\n' +
      'Driver:\r\n' + (opts.driver || 'Beardshear Jesse') + '\r\nPickup Contact:\r\nGene Davenport\r\nPickup Number:\r\n+1 689 236 1715\r\n' +
      '\r\nAgero Proprietary and Confidential\r\n© 2026 Agero, Inc.';
  }
  return {
    subject: 'New Review for ID #' + job,
    receivedDateTime: opts.received || new Date().toISOString(),
    internetMessageId: '<' + job + '@swoop>',
    bodyText: body
  };
}

function request(port, method, p, token, body) {
  return new Promise(function (resolve, reject) {
    var data = body ? JSON.stringify(body) : null;
    var req = http.request({ host: '127.0.0.1', port: port, method: method, path: p,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
      function (res) {
        var chunks = '';
        res.on('data', function (c) { chunks += c; });
        res.on('end', function () { var j = null; try { j = JSON.parse(chunks); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async function main() {
  section('initDB (twice, idempotent)');
  await db.initDB();
  await db.initDB();
  var cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'swoop_surveys'");
  ok(cols.rows.length >= 19, 'swoop_surveys has its columns (' + cols.rows.length + ')');
  var st = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'swoop_%' ORDER BY key");
  eq(st.rows.map(function (r) { return r.key + '=' + r.value; }),
    ['swoop_complaint_max_score=7', 'swoop_nps_detractor_max=5', 'swoop_nps_passive_max=8'], 'settings seeded');

  section('parser');
  var p1 = SW.parseSwoopEmail(email('115320408', 10));
  eq([p1.jobId, p1.score, p1.feedback, p1.account, p1.driver, p1.pickupContact, p1.pickupPhone],
    ['115320408', 10, '', 'Swoop', 'Beardshear Jesse', 'Gene Davenport', '+16892361715'], 'inline shape, empty feedback');
  var p2 = SW.parseSwoopEmail(email('115320409', 3, { shape: 'lines' }));
  eq([p2.jobId, p2.score, p2.feedback, p2.account, p2.driver, p2.pickupPhone],
    ['115320409', 3, '', 'Swoop', 'Beardshear Jesse', '+16892361715'], 'separate-lines shape, empty feedback does not swallow Account');
  var p3 = SW.parseSwoopEmail(email('115320410', 6, { shape: 'lines', feedback: 'Took forever.\r\nDriver was rude. Account: never again' }));
  eq([p3.score, p3.feedback, p3.account], [6, 'Took forever.\nDriver was rude. Account: never again', 'Swoop'], 'multi-line feedback containing "Account:"');
  eq(SW.parseSwoopEmail({ subject: 'Re: hello', bodyText: 'nothing' }).jobId, '', 'non-Swoop mail has no job id');
  eq([SW.parseScore(''), SW.parseScore('11'), SW.parseScore('0'), SW.parseScore(' 9 ')], [null, null, 0, 9], 'parseScore range');
  eq(SW.easternDate('2026-10-06T01:30:00Z'), '2026-10-05', '9:30 PM Eastern files under that Eastern day');

  section('NPS scale (Tony: 0-5 = -100, 6-8 = 0, 9-10 = 100)');
  var bands = await SW.npsBands();
  var want = [-100, -100, -100, -100, -100, -100, 0, 0, 0, 100, 100];
  var got = [];
  for (var s = 0; s <= 10; s++) got.push(SW.npsFor(s, bands));
  eq(got, want, 'JS scale 0..10');
  var sqlGot = await pool.query('SELECT array_agg(' + SW.npsSql('g', bands) + ' ORDER BY g) AS a FROM generate_series(0,10) g');
  eq(sqlGot.rows[0].a, want, 'SQL scale matches JS');
  eq(SW.npsFor(null, bands), null, 'no score -> no NPS');
  await pool.query("UPDATE settings SET value = '9' WHERE key = 'swoop_nps_detractor_max'");
  await pool.query("UPDATE settings SET value = '3' WHERE key = 'swoop_nps_passive_max'");
  eq(await SW.npsBands(), { detractorMax: 5, passiveMax: 8 }, 'nonsense bands fall back to defaults');
  await pool.query("UPDATE settings SET value = '5' WHERE key = 'swoop_nps_detractor_max'");
  await pool.query("UPDATE settings SET value = '8' WHERE key = 'swoop_nps_passive_max'");

  section('seed roster');
  await pool.query("INSERT INTO cities (code, name) VALUES ('ORL','Orlando'), ('JAX','Jacksonville') ON CONFLICT DO NOTHING");
  function mkUser(name, role, home) {
    return pool.query("INSERT INTO users (name, email, password_hash, role, active, home_city) VALUES ($1,$2,'x',$3,true,$4) RETURNING id",
      [name, name.toLowerCase().replace(/\s+/g, '.') + '@t.test', role, home]).then(function (r) { return r.rows[0].id; });
  }
  var adminId = await mkUser('Ada Admin', 'admin', null);
  var mgrOrl = await mkUser('Olly Manager', 'manager', 'ORL');
  var mgrJax = await mkUser('Jack Manager', 'manager', 'JAX');
  var jesse = await mkUser('Jesse Beardshear', 'roadside_technician', 'ORL');
  var chris = await mkUser('Chris Benson', 'roadside_technician', 'JAX');
  var lock = await mkUser('Larry Locksmith', 'locksmith', 'ORL');
  await pool.query("UPDATE cities SET manager_user_id = $1 WHERE code = 'ORL'", [mgrOrl]);
  await pool.query("UPDATE cities SET manager_user_id = $1 WHERE code = 'JAX'", [mgrJax]);

  section('ingest + complaint filing');
  var tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
  graphMessages = [
    email('115320408', 10),
    email('115320409', 3, { shape: 'lines', feedback: 'Waited two hours' }),
    email('115320410', 7, { driver: 'Nobody Known' }),
    email('115320411', 8),
    email('115320412', 2, { received: tenDaysAgo }),
    { subject: 'Your invoice', bodyText: 'not a review' }
  ];
  var pass1 = await J.runPassOnce();
  eq([pass1.ingest.fetched, pass1.ingest.inserted, pass1.ingest.skipped, pass1.ingest.matched], [6, 5, 1, 4], 'ingest counts');
  var row409 = (await pool.query("SELECT * FROM swoop_surveys WHERE job_id = '115320409'")).rows[0];
  eq([row409.score, row409.feedback, row409.employee_user_id, row409.employee_source, row409.city_code, row409.city_source],
    [3, 'Waited two hours', jesse, 'swoop', 'ORL', 'driver'], 'driver guess matched, city from home_city, NOT verified');
  var row410 = (await pool.query("SELECT * FROM swoop_surveys WHERE job_id = '115320410'")).rows[0];
  eq([row410.employee_user_id, row410.employee_source, row410.city_code], [null, null, null], 'unknown driver: nobody credited, no city');
  eq(pass1.filing.filed, 2, 'filed exactly the 3 and the 7 (8 and 10 do not file, 10-day-old 2 is outside the window)');
  var cf = (await pool.query("SELECT * FROM customer_feedback WHERE source = 'swoop_survey' ORDER BY external_ref")).rows;
  eq(cf.map(function (r) { return r.external_ref; }), ['115320409', '115320410'], 'complaints keyed on job id');
  var c409 = cf[0], c410 = cf[1];
  eq([c409.city_code, c409.assigned_to, c409.tech_user_id, c409.customer_name, c409.customer_phone],
    ['ORL', mgrOrl, null, 'Gene Davenport', '+16892361715'], '409 -> Orlando manager, tech left blank (unverified)');
  ok(/NOT verified/.test(c409.incident_text) && /Beardshear Jesse/.test(c409.incident_text) && /Waited two hours/.test(c409.incident_text), '409 text names Swoop driver as unverified and quotes the customer');
  ok(c409.task_id != null, '409 has a task');
  var t409 = (await pool.query('SELECT assigned_to, source FROM tasks WHERE id = $1', [c409.task_id])).rows[0];
  eq([t409.assigned_to, t409.source], [mgrOrl, 'feedback'], 'task belongs to the Orlando manager');
  ok(c410.assigned_to === adminId, '410 (no city) falls back to an admin');
  var act410 = (await pool.query('SELECT body FROM customer_feedback_activity WHERE feedback_id = $1', [c410.id])).rows.map(function (r) { return r.body; }).join(' | ');
  ok(/does not send a city/.test(act410), '410 activity explains why it went to the admins');

  section('second pass is a no-op');
  var pass2 = await J.runPassOnce();
  eq([pass2.ingest.inserted, pass2.filing.filed, pass2.filing.considered], [0, 0, 0], 'nothing new, nothing re-filed');
  var n = (await pool.query("SELECT COUNT(*)::int AS n FROM customer_feedback WHERE source = 'swoop_survey'")).rows[0].n;
  eq(n, 2, 'still 2 complaints');

  section('deleted complaint is not re-opened');
  await pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [c410.task_id]);
  await pool.query('DELETE FROM customer_feedback_activity WHERE feedback_id = $1', [c410.id]);
  await pool.query('DELETE FROM customer_feedback WHERE id = $1', [c410.id]);
  var pass3 = await J.runPassOnce();
  eq(pass3.filing.filed, 0, 'stamped row is not re-filed');

  section('HTTP routes behind the real requireAuth');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  var app = express();
  app.use(express.json());
  app.use('/api/swoop', require('./routes/swoop'));
  var server = app.listen(0);
  var port = server.address().port;
  function tok(id) { return jwt.sign({ id: id }, process.env.JWT_SECRET, { expiresIn: '1h' }); }
  var A = tok(adminId), M = tok(mgrOrl), L = tok(lock);

  var r = await request(port, 'GET', '/api/swoop', L);
  eq(r.status, 403, 'locksmith is refused');
  r = await request(port, 'GET', '/api/swoop', M);
  eq([r.status, r.body.length], [200, 5], 'manager (manage_geico by default) sees all 5');
  var by = {}; r.body.forEach(function (x) { by[x.job_id] = x; });
  eq([by['115320408'].nps, by['115320409'].nps, by['115320410'].nps, by['115320411'].nps], [100, -100, 0, 0], 'per-row NPS');
  eq(by['115320409'].complaint_id, c409.id, 'row links its complaint');

  r = await request(port, 'GET', '/api/swoop/stats', M);
  // scores 10, 3, 7, 8, 2 -> 100, -100, 0, 0, -100 -> avg -20
  eq([r.body.total.n, r.body.total.nps, r.body.total.promoters, r.body.total.passives, r.body.total.detractors, r.body.total.verified],
    [5, -20, 1, 2, 2, 0], 'overall NPS is the plain average');
  var orl = r.body.byCity.filter(function (c) { return c.k === 'Orlando'; })[0];
  ok(orl && orl.n === 4, 'Orlando has the 4 driver-matched surveys');

  r = await request(port, 'GET', '/api/swoop?band=detractor', M);
  eq(r.body.map(function (x) { return x.job_id; }).sort(), ['115320409', '115320412'], 'band=detractor filter');
  r = await request(port, 'GET', '/api/swoop?verified=no', M);
  eq(r.body.length, 5, 'verified=no before any verification');

  section('verification upload');
  r = await request(port, 'POST', '/api/swoop/import-employees', M, { rows: [
    { job_id: '115320409', employee_name: 'Benson, Chris' },   // Swoop said Jesse; it was really Chris
    { job_id: '#115320410', employee_name: 'Mystery Person' },  // nobody on the roster
    { job_id: '999', employee_name: 'Chris Benson' },          // not a survey
    { job_id: '', employee_name: 'x' }
  ] });
  eq([r.status, r.body.updated, r.body.matched, r.body.unmatched, r.body.notFound, r.body.skipped], [200, 2, 1, 1, 1, 1], 'import counts');
  var v409 = (await pool.query("SELECT * FROM swoop_surveys WHERE job_id = '115320409'")).rows[0];
  eq([v409.employee_user_id, v409.employee_source, v409.city_code, v409.city_source], [chris, 'import', 'JAX', 'employee'], 'verified to Chris, city corrected to his');
  var cf409 = (await pool.query('SELECT tech_user_id, tech_name_raw, assigned_to FROM customer_feedback WHERE id = $1', [c409.id])).rows[0];
  eq([cf409.tech_user_id, cf409.tech_name_raw, cf409.assigned_to], [chris, 'Chris Benson', mgrOrl], 'complaint gets the verified tech, assignment untouched');
  var v410 = (await pool.query("SELECT employee_name, employee_user_id, employee_source FROM swoop_surveys WHERE job_id = '115320410'")).rows[0];
  eq([v410.employee_name, v410.employee_user_id, v410.employee_source], ['Mystery Person', null, 'import'], 'unmatched name kept as text');

  section('manual pick wins and survives re-ingest + re-import');
  r = await request(port, 'PUT', '/api/swoop/assign-employee', M, { job_id: '115320408', user_id: jesse });
  eq([r.status, r.body.employee_source], [200, 'manual'], 'manual pick');
  r = await request(port, 'POST', '/api/swoop/import-employees', M, { rows: [{ job_id: '115320408', employee_name: 'Chris Benson' }] });
  eq(r.body.manualKept, 1, 'import leaves the manual pick alone');
  graphMessages = [email('115320408', 10, { driver: 'Benson Chris' })];
  await J.runPassOnce();
  var v408 = (await pool.query("SELECT employee_user_id, employee_source FROM swoop_surveys WHERE job_id = '115320408'")).rows[0];
  eq([v408.employee_user_id, v408.employee_source], [jesse, 'manual'], 're-ingest does not undo a verification');
  r = await request(port, 'GET', '/api/swoop/stats', M);
  eq(r.body.total.verified, 3, 'three verified now');
  r = await request(port, 'GET', '/api/swoop?verified=yes', M);
  eq(r.body.length, 3, 'verified=yes filter');

  section('manual File button for an older / higher score');
  r = await request(port, 'POST', '/api/swoop/file-complaint', M, { job_id: '115320412' });
  ok(r.status === 200 && r.body.id && !r.body.duplicate, 'manual file of the 10-day-old survey');
  r = await request(port, 'POST', '/api/swoop/file-complaint', M, { job_id: '115320412' });
  ok(r.status === 200 && r.body.duplicate, 'second click is the same record');
  r = await request(port, 'POST', '/api/swoop/file-complaint', L, { job_id: '115320411' });
  eq(r.status, 403, 'locksmith cannot file');

  section('check-now');
  graphMessages = [email('115320500', 4)];
  r = await request(port, 'POST', '/api/swoop/check-now', A, {});
  eq([r.status, r.body.fetched, r.body.inserted, r.body.filed], [200, 1, 1, 1], 'check-now ingests and files');

  server.close();
  await pool.end();
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
