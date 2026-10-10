// Policy versions: Vault + SOP new-version-in-place, where-used, relink,
// delete guards, onboarding link health, and memo -> Vault publishing.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-policy-versions.js
//
// Runs the real initDB() twice, mounts the REAL documents, sops, onboarding and
// memos routers behind the REAL requireAuth, and drives them over HTTP with
// real JWTs. R2 is an in-memory stand-in so the test sees exactly which bytes
// end up current.
//
// The scenario is the one that started this (Tony, 2026-10-09): a PTO policy
// in the Vault, an onboarding Acknowledge step pointing at it, then a new
// policy. The new version must reach the step WITHOUT anyone touching the step.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pv';
process.env.APP_URL = 'https://nova.test';

var r2 = require('./utils/r2');
var R2STORE = {};
r2.configured = function () { return true; };
r2.presignUpload = async function (key) { return 'https://r2.test/' + key; };
r2.presignDownload = async function (key) { return 'https://r2.test/get/' + key; };
r2.getObjectBuffer = async function (key) { if (!R2STORE[key]) throw new Error('NoSuchKey'); return R2STORE[key]; };
r2.putObject = async function (key, body) { R2STORE[key] = Buffer.from(body); };
r2.headObject = async function (key) { return R2STORE[key] ? { size: R2STORE[key].length, contentType: null } : null; };
r2.deleteObject = async function (key) { delete R2STORE[key]; };
var emailMod = require('./utils/email');
emailMod.sendEmail = async function () { return true; };
var smsMod = require('./utils/sms');
smsMod.sendSms = async function () { return true; };
var pushMod = require('./utils/push');
pushMod.isReady = function () { return false; };
pushMod.sendPushToUsers = async function () {};
// The policy-folder text extraction runs in the background after a new version;
// it is covered by test-doc-text.js. Record that it was asked for, nothing more.
var docText = require('./utils/docText');
var REINDEXED = [];
docText.indexInBackground = function (db, id) { REINDEXED.push(id); };

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { initDB, pool } = require('./db');
const { PDFDocument } = require('pdf-lib');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('== ' + t); }

var base = '';
function tokenFor(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function call(u, method, path, body) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(u) }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
async function mkUser(name, role, extra) {
  extra = extra || {};
  const r = await pool.query(
    'INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, onboarding_status, extra_perms) ' +
    "VALUES ($1,$2,'x',$3,true,0,'ORL','complete',$4) RETURNING id",
    [name.toLowerCase().replace(/ /g, '.') + '@pvtest.local', name, role, extra.perms || []]);
  return { id: r.rows[0].id, name: name, role: role, email: name.toLowerCase().replace(/ /g, '.') + '@pvtest.local' };
}
async function pdf(label) {
  var d = await PDFDocument.create();
  d.addPage([612, 792]).drawText(label, { x: 72, y: 700, size: 18 });
  return Buffer.from(await d.save());
}
async function mkDoc(owner, folderId, name, bytes) {
  var key = 'documents/fixture-' + Math.random().toString(36).slice(2) + '/' + name;
  R2STORE[key] = bytes;
  var r = await pool.query(
    "INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) VALUES ($1,$2,$3,'application/pdf',$4,'ready',$5,$6) RETURNING id",
    [name, folderId, key, bytes.length, owner.id, owner.name]);
  return { id: r.rows[0].id, key: key };
}
async function mkStep(type, title, sopId, docId, pos) {
  var r = await pool.query(
    'INSERT INTO onboarding_steps (position, type, title, sop_id, config, phase) VALUES ($1,$2,$3,$4,$5,1) RETURNING id',
    [pos, type, title, sopId || null, JSON.stringify(docId ? { document_id: docId } : {})]);
  return r.rows[0].id;
}

async function main() {
  console.log('Policy versions tests');
  console.log('---------------------');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  section('schema');
  var REQUIRED = {
    documents: ['version', 'pending_version_key', 'version_note', 'version_by_name', 'version_at'],
    document_versions: ['document_id', 'version', 'name', 'r2_key', 'mime_type', 'size_bytes', 'uploaded_by_name', 'uploaded_at', 'replaced_by', 'replaced_by_name', 'replaced_at', 'note'],
    sop_documents: ['version', 'version_note', 'updated_at', 'updated_by_name'],
    sop_document_versions: ['sop_id', 'version', 'title', 'filename', 'content', 'char_count', 'replaced_by_name', 'replaced_at', 'note']
  };
  for (var t in REQUIRED) {
    var have = (await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [t])).rows.map(function (x) { return x.column_name; });
    var missing = REQUIRED[t].filter(function (c) { return have.indexOf(c) === -1; });
    ok(t + ' has every column the routes use', missing.length === 0, missing.join(', '));
  }

  // ---- fixtures ----
  await pool.query('DELETE FROM onboarding_steps');
  await pool.query('DELETE FROM memos');
  await pool.query('DELETE FROM documents');
  await pool.query('DELETE FROM document_folders');
  await pool.query('DELETE FROM sop_documents');
  await pool.query("DELETE FROM users WHERE email LIKE '%@pvtest.local'");
  await pool.query("INSERT INTO cities (name, code) VALUES ('Orlando','ORL') ON CONFLICT (code) DO NOTHING");
  var owner = await mkUser('Tony Owner', 'owner');
  var admin = await mkUser('Ada Admin', 'admin');
  var mgr = await mkUser('Mona Manager', 'manager', { perms: ['manage_onboarding'] });
  var tech = await mkUser('Chris Tech', 'locksmith');

  var pol = (await pool.query("INSERT INTO document_folders (name, owner_id, owner_name, policy_source) VALUES ('Policies',$1,$2,true) RETURNING id", [owner.id, owner.name])).rows[0].id;
  var v1 = await pdf('PTO policy 2026: 1 hour per 40');
  var pto = await mkDoc(owner, pol, 'PTO Policy.pdf', v1);
  var handbook = await mkDoc(owner, pol, 'Employee Handbook.pdf', await pdf('Handbook'));
  var ptoDup = await mkDoc(owner, pol, 'PTO Policy 2027 (new).pdf', await pdf('PTO policy 2027 uploaded as a separate file'));

  var sopOld = (await pool.query("INSERT INTO sop_documents (title, filename, content, char_count, uploaded_by_name) VALUES ('PTO SOP','pto.pdf',$1,$2,'Tony Owner') RETURNING id",
    ['Old PTO rule: employees accrue one hour for every forty hours worked.', 70])).rows[0].id;
  var sopOther = (await pool.query("INSERT INTO sop_documents (title, filename, content, char_count) VALUES ('Lockout SOP','lockout.pdf','Lockout procedure text goes here for the test.',46) RETURNING id")).rows[0].id;
  var sopDup = (await pool.query("INSERT INTO sop_documents (title, filename, content, char_count) VALUES ('PTO SOP 2027','pto27.pdf','New PTO rule uploaded separately, accrue one and a half hours.',62) RETURNING id")).rows[0].id;
  await require('./utils/sopIndex').reindexSop(pool, sopOld, 'Old PTO rule: employees accrue one hour for every forty hours worked.');
  try { await pool.query("INSERT INTO onboarding_question_bank (sop_id, source_hash, questions) VALUES ($1,'h','[]')", [sopOld]); } catch (e) {}

  var stepAck = await mkStep('acknowledge', 'Acknowledge the PTO policy', null, pto.id, 1);
  var stepRead = await mkStep('sop_read', 'Read the handbook', null, handbook.id, 2);
  var stepQuiz = await mkStep('quiz', 'PTO quiz', sopOld, null, 3);
  var stepDupAck = await mkStep('acknowledge', 'Old copy step', null, ptoDup.id, 4);

  var app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/documents', require('./routes/documents'));
  app.use('/api/sops', require('./routes/sops'));
  app.use('/api/onboarding', require('./routes/onboarding'));
  app.use('/api/memos', require('./routes/memos'));
  app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ error: 'boom' }); });
  var server = await new Promise(function (resolve) { var s = app.listen(0, function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;

  try {
    section('Vault: where used');
    var u = await call(owner, 'GET', '/api/documents/' + pto.id + '/usage');
    eq('usage loads for the owner', u.status, 200);
    eq('it names the onboarding step that shows the PTO policy', u.body.onboarding_steps.map(function (s) { return s.title; }), ['Acknowledge the PTO policy']);
    eq('and says it is in a policy folder', u.body.policy_folder, true);
    eq('a technician cannot see usage', (await call(tech, 'GET', '/api/documents/' + pto.id + '/usage')).status, 403);

    section('Vault: upload a new version in place');
    eq('a technician cannot start a new version', (await call(tech, 'POST', '/api/documents/' + pto.id + '/version-url', { name: 'x.pdf' })).status, 403);
    var vu = await call(owner, 'POST', '/api/documents/' + pto.id + '/version-url', { name: 'PTO Policy 2027.pdf', mime_type: 'application/pdf' });
    eq('the owner gets an upload URL', vu.status, 200);
    ok('for a fresh documents/ key', /^documents\//.test(vu.body.key) && vu.body.key !== pto.key);
    eq('confirming before the bytes arrive is refused', (await call(owner, 'POST', '/api/documents/' + pto.id + '/version', { key: vu.body.key })).status, 400);
    var v2 = await pdf('PTO policy 2027: 1.5 hours per 40');
    R2STORE[vu.body.key] = v2;
    eq('confirming some other key is refused', (await call(owner, 'POST', '/api/documents/' + pto.id + '/version', { key: handbook.key })).status, 400);
    REINDEXED = [];
    var done = await call(owner, 'POST', '/api/documents/' + pto.id + '/version', { key: vu.body.key, name: 'PTO Policy 2027.pdf', mime_type: 'application/pdf', note: 'Accrual is now 1.5 hrs per 40', keep_name: true });
    eq('the new version is saved', done.status, 200);
    eq('as version 2', done.body.version, 2);
    eq('keeping the name the steps know it by', done.body.name, 'PTO Policy.pdf');
    eq('and the reply says which steps now show it', done.body.usage.onboarding_steps.map(function (s) { return s.id; }), [stepAck]);
    var row = (await pool.query('SELECT id, r2_key, version, size_bytes, version_note, version_by_name, pending_version_key FROM documents WHERE id = $1', [pto.id])).rows[0];
    eq('SAME row id', row.id, pto.id);
    eq('pointing at the new bytes', row.r2_key, vu.body.key);
    eq('with the size from storage', Number(row.size_bytes), v2.length);
    eq('the note is kept', row.version_note, 'Accrual is now 1.5 hrs per 40');
    eq('the pending key is cleared', row.pending_version_key, null);
    ok('the old bytes are still in storage', !!R2STORE[pto.key]);
    var hist = (await pool.query('SELECT version, r2_key, uploaded_by_name, replaced_by_name FROM document_versions WHERE document_id = $1', [pto.id])).rows;
    eq('one history row', hist.length, 1);
    eq('holding version 1 and its old key', [hist[0].version, hist[0].r2_key], [1, pto.key]);
    eq('who replaced it', hist[0].replaced_by_name, 'Tony Owner');
    eq('a policy-folder file is re-read for Nova AI', REINDEXED, [pto.id]);
    eq('the same key cannot be confirmed twice', (await call(owner, 'POST', '/api/documents/' + pto.id + '/version', { key: vu.body.key })).status, 400);
    var stepCfg = (await pool.query('SELECT config FROM onboarding_steps WHERE id = $1', [stepAck])).rows[0].config;
    eq('THE POINT: the onboarding step was never touched and still points at the same id', stepCfg.document_id, pto.id);

    var vh = await call(owner, 'GET', '/api/documents/' + pto.id + '/versions');
    eq('history loads', vh.status, 200);
    eq('current is v2', vh.body.current.version, 2);
    eq('history lists v1', vh.body.history.map(function (h) { return h.version; }), [1]);
    eq('the owner can edit', vh.body.can_edit, true);
    var od = await call(owner, 'GET', '/api/documents/' + pto.id + '/versions/' + vh.body.history[0].id + '/download?inline=1');
    ok('an old version can still be opened', od.status === 200 && od.body.url.indexOf(pto.key) !== -1);
    eq('a tech without vault access cannot read history', (await call(tech, 'GET', '/api/documents/' + pto.id + '/versions')).status, 403);
    eq('nor an old version', (await call(tech, 'GET', '/api/documents/' + pto.id + '/versions/' + vh.body.history[0].id + '/download')).status, 403);
    eq('an admin without a share cannot start a version (vault rules: only owners see all)', (await call(admin, 'POST', '/api/documents/' + pto.id + '/version-url', { name: 'x.pdf' })).status, 403);

    // Third version, to check the history keeps the note of the version it archived.
    var vu3 = await call(owner, 'POST', '/api/documents/' + pto.id + '/version-url', { name: 'PTO Policy.pdf', mime_type: 'application/pdf' });
    R2STORE[vu3.body.key] = await pdf('PTO policy v3');
    var d3 = await call(owner, 'POST', '/api/documents/' + pto.id + '/version', { key: vu3.body.key, note: 'typo fix' });
    eq('v3 saved', d3.body.version, 3);
    var h3 = (await pool.query('SELECT version, note FROM document_versions WHERE document_id = $1 ORDER BY version', [pto.id])).rows;
    eq('history v2 carries the note it was uploaded with', h3.map(function (h) { return [h.version, h.note]; }), [[1, null], [2, 'Accrual is now 1.5 hrs per 40']]);

    section('Vault: listing shows the version');
    var list = await call(owner, 'GET', '/api/documents?folder=' + pol);
    var listed = (list.body.files || []).filter(function (f) { return f.id === pto.id; })[0];
    ok('the folder listing carries version 3', listed && listed.version === 3, JSON.stringify(listed && listed.version));

    section('Vault: delete guard');
    var del = await call(owner, 'DELETE', '/api/documents/' + handbook.id);
    eq('deleting a file onboarding reads is refused', del.status, 409);
    ok('naming the step', del.body.error.indexOf('Read the handbook') !== -1);
    var hbKey = handbook.key;
    eq('force=1 deletes it anyway', (await call(owner, 'DELETE', '/api/documents/' + handbook.id + '?force=1')).status, 200);
    ok('its bytes are gone', !R2STORE[hbKey]);
    eq('deleting the PTO file removes every version from storage too', (await call(owner, 'DELETE', '/api/documents/' + pto.id + '?force=1')).status, 200);
    ok('v1 and v2 objects deleted', !R2STORE[pto.key] && !R2STORE[vu.body.key] && !R2STORE[vu3.body.key]);
    eq('history rows cascade', (await pool.query('SELECT COUNT(*)::int AS n FROM document_versions WHERE document_id = $1', [pto.id])).rows[0].n, 0);

    section('onboarding link health');
    var lh = await call(mgr, 'GET', '/api/onboarding/admin/link-health');
    eq('a manager with manage_onboarding can run it', lh.status, 200);
    var titles = lh.body.problems.map(function (p) { return p.title; }).sort();
    eq('it flags the two steps whose file was deleted', titles, ['Acknowledge the PTO policy', 'Read the handbook']);
    eq('a tech cannot', (await call(tech, 'GET', '/api/onboarding/admin/link-health')).status, 403);

    section('Vault: relink (cleanup for a policy uploaded as a separate file)');
    var pto27 = await mkDoc(owner, pol, 'PTO Policy 2027.pdf', await pdf('2027 replacement'));
    eq('a tech cannot relink', (await call(tech, 'POST', '/api/documents/' + ptoDup.id + '/relink', { to_document_id: pto27.id })).status, 403);
    eq('relinking to itself is refused', (await call(owner, 'POST', '/api/documents/' + ptoDup.id + '/relink', { to_document_id: ptoDup.id })).status, 400);
    var rl = await call(owner, 'POST', '/api/documents/' + ptoDup.id + '/relink', { to_document_id: pto27.id });
    eq('the owner can relink', rl.status, 200);
    eq('one step moved', rl.body.moved.map(function (x) { return x.id; }), [stepDupAck]);
    var moved = (await pool.query('SELECT config FROM onboarding_steps WHERE id = $1', [stepDupAck])).rows[0].config;
    eq('the step now points at the new file', moved.document_id, pto27.id);
    eq('the old copy can now be deleted without force', (await call(owner, 'DELETE', '/api/documents/' + ptoDup.id)).status, 200);

    section('SOP: new version in place');
    var su = await call(owner, 'GET', '/api/sops/' + sopOld + '/usage');
    eq('SOP usage names the quiz', su.body.onboarding_steps.map(function (s) { return s.title; }), ['PTO quiz']);
    eq('a tech cannot post a version', (await call(tech, 'POST', '/api/sops/' + sopOld + '/version', { content: 'x'.repeat(40) })).status, 403);
    eq('empty text is refused', (await call(owner, 'POST', '/api/sops/' + sopOld + '/version', { content: 'short' })).status, 400);
    var sv = await call(owner, 'POST', '/api/sops/' + sopOld + '/version', { content: 'New PTO rule: employees accrue one and a half hours for every forty hours worked, starting January.', filename: 'pto-2027.pdf', note: '2027 policy' });
    eq('the new SOP version saves', sv.status, 200);
    eq('as version 2', sv.body.sop.version, 2);
    eq('same id', sv.body.sop.id, sopOld);
    var srow = (await pool.query('SELECT content, filename, title FROM sop_documents WHERE id = $1', [sopOld])).rows[0];
    ok('the text is the new text', srow.content.indexOf('one and a half') !== -1);
    eq('title kept', srow.title, 'PTO SOP');
    var chunks = (await pool.query('SELECT content FROM sop_chunks WHERE sop_id = $1', [sopOld])).rows;
    ok('Nova AI chunks were rebuilt from the new text', chunks.length > 0 && chunks.every(function (c) { return c.content.indexOf('Old PTO rule') === -1; }));
    var bank = 0;
    try { bank = (await pool.query('SELECT COUNT(*)::int AS n FROM onboarding_question_bank WHERE sop_id = $1', [sopOld])).rows[0].n; } catch (e) {}
    eq('the onboarding quiz question bank for it was dropped', bank, 0);
    eq('the quiz step still points at the same SOP', (await pool.query('SELECT sop_id FROM onboarding_steps WHERE id = $1', [stepQuiz])).rows[0].sop_id, sopOld);
    var svh = await call(owner, 'GET', '/api/sops/' + sopOld + '/versions');
    eq('SOP history lists v1', svh.body.history.map(function (h) { return h.version; }), [1]);
    var oldText = await call(owner, 'GET', '/api/sops/' + sopOld + '/versions/' + svh.body.history[0].id);
    ok('and v1 text can be read back', oldText.status === 200 && oldText.body.content.indexOf('Old PTO rule') !== -1);
    var sl = await call(owner, 'GET', '/api/sops');
    var listedSop = sl.body.filter(function (x) { return x.id === sopOld; })[0];
    ok('SOP list shows version 2 and that 1 step uses it', listedSop && listedSop.version === 2 && listedSop.used_by_steps === 1, JSON.stringify(listedSop));

    section('SOP: delete guard + relink');
    var sd = await call(owner, 'DELETE', '/api/sops/' + sopOld);
    eq('deleting an SOP a quiz uses is refused', sd.status, 409);
    eq('a free SOP deletes fine', (await call(owner, 'DELETE', '/api/sops/' + sopOther)).status, 200);
    var sr = await call(owner, 'POST', '/api/sops/' + sopOld + '/relink', { to_sop_id: sopDup });
    eq('relink works', sr.status, 200);
    eq('the quiz moved', (await pool.query('SELECT sop_id FROM onboarding_steps WHERE id = $1', [stepQuiz])).rows[0].sop_id, sopDup);
    eq('and the old SOP was disabled so Nova AI stops quoting it', (await pool.query('SELECT active FROM sop_documents WHERE id = $1', [sopOld])).rows[0].active, false);
    await pool.query('UPDATE sop_documents SET active = false WHERE id = $1', [sopDup]);
    var lh2 = await call(owner, 'GET', '/api/onboarding/admin/link-health');
    ok('link health flags a quiz on a disabled SOP', lh2.body.problems.some(function (p) { return p.step_id === stepQuiz && /disabled/.test(p.problem); }), JSON.stringify(lh2.body.problems));
    await pool.query('UPDATE sop_documents SET active = true WHERE id = $1', [sopDup]);

    section('memo -> Vault');
    await pool.query("INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ manager: ['manage_onboarding'] })]);
    var c = await call(owner, 'POST', '/api/memos', { title: 'PTO Policy Change', type: 'Policy update', note: 'Here is the updated PTO policy.', audience: { mode: 'all' }, require_signature: true });
    eq('a memo draft is created', c.status, 200);
    var memoId = c.body.memo.id;
    eq('publishing with no PDF is refused', (await call(owner, 'POST', '/api/memos/' + memoId + '/publish-to-vault', { document_id: pto27.id })).status, 400);
    var up = await call(owner, 'POST', '/api/memos/' + memoId + '/upload-url', { filename: 'PTO_2027_final.pdf', content_type: 'application/pdf', size: 1000 });
    var memoPdf = await pdf('PTO policy 2027 FINAL, sent by memo');
    R2STORE[up.body.key] = memoPdf;
    eq('PDF attached', (await call(owner, 'POST', '/api/memos/' + memoId + '/file', { key: up.body.key, filename: 'PTO_2027_final.pdf' })).status, 200);
    eq('a tech cannot publish', (await call(tech, 'POST', '/api/memos/' + memoId + '/publish-to-vault', { document_id: pto27.id })).status, 403);
    eq('an admin without vault access to the file cannot publish onto it', (await call(admin, 'POST', '/api/memos/' + memoId + '/publish-to-vault', { document_id: pto27.id })).status, 403);
    var pub = await call(owner, 'POST', '/api/memos/' + memoId + '/publish-to-vault', { document_id: pto27.id });
    eq('the owner publishes the memo PDF as the new version', pub.status, 200);
    eq('v2', pub.body.version, 2);
    var cur = (await pool.query('SELECT r2_key, version_note FROM documents WHERE id = $1', [pto27.id])).rows[0];
    ok('the Vault file now holds exactly the memo bytes', R2STORE[cur.r2_key] && R2STORE[cur.r2_key].equals(memoPdf));
    ok('with a note saying where it came from', /memo/i.test(cur.version_note || ''), cur.version_note);
    ok('the memo still has its own copy', !!R2STORE[up.body.key]);
    eq('the onboarding step that now uses this file is listed', pub.body.usage.onboarding_steps.map(function (s) { return s.id; }), [stepDupAck]);
    var ev = (await pool.query("SELECT COUNT(*)::int AS n FROM memo_events WHERE memo_id = $1 AND action = 'published_to_vault'", [memoId])).rows[0].n;
    eq('the memo log records it', ev, 1);

    section('onboarding: an acknowledgment records which version was read');
    await pool.query('UPDATE onboarding_steps SET active = false');
    var ackDoc = await mkDoc(owner, pol, 'Attendance Policy.pdf', await pdf('attendance v1'));
    var ackStep = (await pool.query(
      "INSERT INTO onboarding_steps (position, type, title, config, phase) VALUES (1,'acknowledge','Acknowledge attendance',$1,1) RETURNING id",
      [JSON.stringify({ document_id: ackDoc.id, min_seconds: 0 })])).rows[0].id;
    var avu = await call(owner, 'POST', '/api/documents/' + ackDoc.id + '/version-url', { name: 'Attendance Policy.pdf', mime_type: 'application/pdf' });
    R2STORE[avu.body.key] = await pdf('attendance v2');
    eq('attendance policy moved to v2', (await call(owner, 'POST', '/api/documents/' + ackDoc.id + '/version', { key: avu.body.key })).body.version, 2);
    var hireR = await pool.query(
      "INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, onboarding_status, onboarding_phase) VALUES ('hire@pvtest.local','Hana Hire','x','locksmith',true,0,'ORL','in_progress',1) RETURNING id");
    var hire = { id: hireR.rows[0].id, name: 'Hana Hire', role: 'locksmith', email: 'hire@pvtest.local' };
    var me = await call(hire, 'GET', '/api/onboarding/me');
    ok('the hire is served the acknowledge step', me.status === 200 && me.body.current && me.body.current.id === ackStep, JSON.stringify(me.body && me.body.current));
    var cmp = await call(hire, 'POST', '/api/onboarding/steps/' + ackStep + '/complete', {});
    eq('the hire acknowledges it', cmp.status, 200);
    var evr = (await pool.query("SELECT document_id, document_version FROM onboarding_events WHERE user_id = $1 AND event_type = 'acknowledged'", [hire.id])).rows;
    eq('the event names the file AND the version they acknowledged', evr.map(function (e) { return [e.document_id, e.document_version]; }), [[ackDoc.id, 'v2']]);
  } finally {
    server.close();
    // Leave nobody active behind: the memos test counts active people by name.
    await pool.query("UPDATE users SET active = false WHERE email LIKE '%@pvtest.local'");
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
