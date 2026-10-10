// Company memos: schema, permission, lock-gate and PDF tests.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-memos.js
//
// Runs the real initDB() twice, then mounts the REAL memos router behind the
// REAL requireAuth (which carries the memo lock gate) and drives it over HTTP
// with real JWTs. R2, email, SMS and push are replaced with in-memory stand-ins
// so the test can see exactly what would have been stored and sent.
//
// The lock is the part that matters most, so most of the assertions are about
// it: who it catches, what stays open while it is on, and that one signature
// lifts it on the very next request.
//
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-memos';
process.env.APP_URL = 'https://nova.test';

// ---- stand-ins, installed BEFORE the router is required -------------------------
var r2 = require('./utils/r2');
var R2STORE = {};
r2.configured = function () { return true; };
r2.presignUpload = async function (key) { return 'https://r2.test/' + key; };
r2.getObjectBuffer = async function (key) { if (!R2STORE[key]) throw new Error('NoSuchKey'); return R2STORE[key]; };
var SENT = { email: [], sms: [], push: [] };
var emailMod = require('./utils/email');
emailMod.sendEmail = async function (to, subject) { SENT.email.push({ to: to, subject: subject }); return true; };
var smsMod = require('./utils/sms');
smsMod.sendSms = async function (to, body) { SENT.sms.push({ to: to, body: body }); return true; };
var pushMod = require('./utils/push');
pushMod.isReady = function () { return true; };
pushMod.sendPushToUsers = async function (ids, p) { SENT.push.push({ ids: ids, payload: p }); };

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { initDB, pool } = require('./db');
const { PDFDocument } = require('pdf-lib');
const { requireAuth } = require('./middleware/auth');
const memoLock = require('./utils/memoLock');

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
async function call(u, method, path, body, headers) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(u), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' },
      body === undefined ? {} : { 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

async function mkUser(name, role, extra) {
  extra = extra || {};
  const r = await pool.query(
    'INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, phone, receive_sms, receive_emails, onboarding_status, offboarding_restricted, extra_perms) ' +
    "VALUES ($1,$2,'x',$3,$4,0,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [name.toLowerCase().replace(/ /g, '.') + '@memotest.local', name, role,
      extra.active === false ? false : true, extra.city || 'ORL', extra.phone || null, !!extra.sms,
      extra.email === false ? false : true, extra.onboarding || 'complete', !!extra.offboarding, extra.perms || []]);
  return { id: r.rows[0].id, name: name, role: role, email: name.toLowerCase().replace(/ /g, '.') + '@memotest.local' };
}

async function samplePdf(pages) {
  var d = await PDFDocument.create();
  for (var i = 0; i < pages; i++) {
    var p = d.addPage([612, 792]);
    p.drawText('PTO Policy page ' + (i + 1), { x: 72, y: 700, size: 18 });
  }
  return Buffer.from(await d.save());
}

var SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function main() {
  console.log('Memos tests');
  console.log('-----------');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  section('schema');
  var REQUIRED = {
    memos: ['memo_no', 'type', 'title', 'note', 'body', 'effective_date', 'file_key', 'file_name', 'file_pages', 'file_sha256',
      'require_signature', 'lock_until_done', 'lock_starts_at', 'sign_by', 'audience', 'include_future_hires', 'exclude_sender',
      'notify_push', 'notify_sms', 'notify_email', 'remind_every_days', 'status', 'content_hash', 'supersedes_id', 'superseded_by_id',
      'sent_by', 'sent_by_name', 'sent_at', 'withdrawn_at', 'withdrawn_reason'],
    memo_recipients: ['memo_id', 'user_id', 'user_name', 'user_role', 'user_city', 'lock_exempt', 'delivered_at', 'delivered_via',
      'first_viewed_at', 'last_viewed_at', 'view_count', 'reached_end_at', 'completed_at', 'completion', 'signature_name',
      'signature_data', 'signature_ip', 'user_agent', 'signed_hash', 'reminder_count', 'last_reminded_at', 'excused_at',
      'excused_reason', 'added_late'],
    memo_events: ['memo_id', 'user_id', 'action', 'actor_name', 'detail', 'created_at']
  };
  for (var t in REQUIRED) {
    var have = (await pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [t])).rows.map(function (x) { return x.column_name; });
    var missing = REQUIRED[t].filter(function (c) { return have.indexOf(c) === -1; });
    ok(t + ' has every column the routes use', missing.length === 0, missing.join(', '));
  }
  var idx = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'memo_recipients_open_idx'");
  ok('the open-rows partial index exists', idx.rows.length === 1);

  // ---- fixtures ---------------------------------------------------------------
  await pool.query("DELETE FROM memos");
  await pool.query("DELETE FROM users WHERE email LIKE '%@memotest.local'");
  await pool.query("INSERT INTO cities (name, code) VALUES ('Orlando','ORL') ON CONFLICT (code) DO NOTHING");
  await pool.query("INSERT INTO cities (name, code) VALUES ('Tampa','TPA') ON CONFLICT (code) DO NOTHING");
  await pool.query("INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({ manager: ['view_users'], locksmith: [], roadside_technician: [], dispatcher: [] })]);
  await pool.query("DELETE FROM settings WHERE key = 'memo_lock_admins'");

  var owner = await mkUser('Tony Owner', 'owner', { city: 'ORL' });
  var admin2 = await mkUser('Second Admin', 'admin', { city: 'ORL' });
  var mgr = await mkUser('Mona Manager', 'manager', { city: 'TPA' });
  var mgrMemo = await mkUser('Max Granted', 'manager', { city: 'TPA', perms: ['manage_memos'] });
  var tech = await mkUser('Chris Tech', 'roadside_technician', { city: 'TPA', phone: '+15555550101', sms: true });
  var lock2 = await mkUser('Jordan Lock', 'locksmith', { city: 'ORL', phone: '+15555550102', sms: false });
  var disp = await mkUser('Alyssa Dispatch', 'dispatcher', { city: 'ORL', email: false });
  var inactive = await mkUser('Gone Person', 'locksmith', { active: false });
  var onboarding = await mkUser('New Hire', 'locksmith', { onboarding: 'in_progress' });
  var leaving = await mkUser('Leaving Soon', 'locksmith', { offboarding: true });

  // ---- server -------------------------------------------------------------------
  var app = express();
  app.use(express.json({ limit: '20mb' }));
  app.set('memosSyncDelivery', true);
  app.use('/api/memos', require('./routes/memos'));
  // Stand-ins for "the rest of Nova", behind the same real requireAuth.
  app.get('/api/tasks', requireAuth, function (req, res) { res.json({ ok: true }); });
  app.get('/api/timeclock/status', requireAuth, function (req, res) { res.json({ ok: true }); });
  app.post('/api/invoices/12/payments/3/reconcile', requireAuth, function (req, res) { res.json({ ok: true }); });
  app.put('/api/invoices/12', requireAuth, function (req, res) { res.json({ ok: true }); });
  app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ error: 'boom' }); });
  var server = await new Promise(function (resolve) { var s = app.listen(0, function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;

  try {
    section('permission: manage_memos ships dark');
    eq('a technician cannot open the Memos screen', (await call(tech, 'GET', '/api/memos')).status, 403);
    eq('a manager without the box cannot either', (await call(mgr, 'GET', '/api/memos')).status, 403);
    eq('the owner can', (await call(owner, 'GET', '/api/memos')).status, 200);
    eq('a manager granted manage_memos by name can', (await call(mgrMemo, 'GET', '/api/memos')).status, 200);
    eq('a technician cannot create a memo', (await call(tech, 'POST', '/api/memos', { title: 'x' })).status, 403);
    var meta = await call(owner, 'GET', '/api/memos/meta');
    eq('meta loads', meta.status, 200);
    ok('meta lists memo types', Array.isArray(meta.body.types) && meta.body.types.indexOf('PTO / Leave policy change') !== -1);
    var metaNames = meta.body.people.map(function (p) { return p.name; });
    ok('the people list leaves out inactive, mid-onboarding and offboarding people',
      metaNames.indexOf('Gone Person') === -1 && metaNames.indexOf('New Hire') === -1 && metaNames.indexOf('Leaving Soon') === -1 && metaNames.indexOf('Chris Tech') !== -1);
    eq('admins and owners are lock-exempt by default', meta.body.lock_exempt_roles, ['admin', 'owner']);

    section('draft + PDF attach');
    var c = await call(owner, 'POST', '/api/memos', { title: 'PTO Policy Change', type: 'PTO / Leave policy change', note: 'Here is the updated PTO policy.',
      effective_date: '2027-01-01', require_signature: true, lock_until_done: true, audience: { mode: 'all' }, sign_by: '2026-10-16' });
    eq('a draft is created', c.status, 200);
    var memoId = c.body.memo.id;
    eq('it starts as a draft', c.body.memo.status, 'draft');
    eq('with no memo number yet', c.body.memo.memo_no, null);
    var u = await call(owner, 'POST', '/api/memos/' + memoId + '/upload-url', { filename: 'PTO_Policy_2027.pdf', content_type: 'application/pdf', size: 2000 });
    eq('an upload URL is handed out', u.status, 200);
    ok('for a key under this memo', u.body.key.indexOf('memos/' + memoId + '/') === 0);
    eq('a non-PDF is refused up front', (await call(owner, 'POST', '/api/memos/' + memoId + '/upload-url', { filename: 'x.docx', content_type: 'application/msword' })).status, 400);
    eq('a key from somewhere else is refused', (await call(owner, 'POST', '/api/memos/' + memoId + '/file', { key: 'hr/secret.pdf' })).status, 400);
    R2STORE[u.body.key] = Buffer.from('not a pdf at all');
    eq('bytes that are not a PDF are refused', (await call(owner, 'POST', '/api/memos/' + memoId + '/file', { key: u.body.key, filename: 'PTO_Policy_2027.pdf' })).status, 400);
    var pdfBytes = await samplePdf(3);
    R2STORE[u.body.key] = pdfBytes;
    var fc = await call(owner, 'POST', '/api/memos/' + memoId + '/file', { key: u.body.key, filename: 'PTO_Policy_2027.pdf' });
    eq('a real PDF attaches', fc.status, 200);
    eq('its pages are counted', fc.body.memo.file_pages, 3);
    var pu = await call(owner, 'PUT', '/api/memos/' + memoId, { note: 'Here is the updated PTO policy.', exclude_sender: true });
    eq('the draft can still be edited', pu.status, 200);

    section('who it goes to');
    var pv = await call(owner, 'POST', '/api/memos/audience-preview', { audience: { mode: 'all' }, exclude_sender: true });
    // owner excluded; admin2, mgr, mgrMemo, tech, lock2, disp = 6 (+ any users other tests left behind)
    var pvNames = pv.body.people.map(function (p) { return p.name; });
    ok('Everyone means every active, onboarded person', ['Second Admin', 'Mona Manager', 'Max Granted', 'Chris Tech', 'Jordan Lock', 'Alyssa Dispatch'].every(function (n) { return pvNames.indexOf(n) !== -1; }));
    ok('and leaves the sender out', pvNames.indexOf('Tony Owner') === -1);
    ok('and leaves out inactive, onboarding and offboarding people', pvNames.indexOf('Gone Person') === -1 && pvNames.indexOf('New Hire') === -1 && pvNames.indexOf('Leaving Soon') === -1);
    ok('admins are counted as not locked', pv.body.exempt.indexOf('Second Admin') !== -1 && pv.body.lock_count === pv.body.count - pv.body.exempt.length);
    ok('people who will not get a text are named', pv.body.no_text.indexOf('Jordan Lock') !== -1 && pv.body.no_text.indexOf('Chris Tech') === -1);
    var pvc = await call(owner, 'POST', '/api/memos/audience-preview', { audience: { mode: 'cities', cities: ['TPA'] } });
    eq('By city uses home city', pvc.body.people.map(function (p) { return p.name; }).sort(), ['Chris Tech', 'Max Granted', 'Mona Manager']);
    var pvr = await call(owner, 'POST', '/api/memos/audience-preview', { audience: { mode: 'roles', roles: ['locksmith', 'dispatcher'] } });
    eq('By role', pvr.body.people.map(function (p) { return p.name; }).sort(), ['Alyssa Dispatch', 'Jordan Lock']);
    var pvp = await call(owner, 'POST', '/api/memos/audience-preview', { audience: { mode: 'people', user_ids: [tech.id, inactive.id] } });
    eq('Pick people never reaches an inactive person', pvp.body.people.map(function (p) { return p.name; }), ['Chris Tech']);

    // Keep the rest of the test to a known, small group.
    await call(owner, 'PUT', '/api/memos/' + memoId, { audience: { mode: 'people', user_ids: [tech.id, lock2.id, disp.id, admin2.id] } });

    section('send');
    var e1 = await call(owner, 'POST', '/api/memos', { title: '', audience: { mode: 'all' } });
    var bad = await call(owner, 'POST', '/api/memos/' + e1.body.memo.id + '/send');
    eq('a memo with no title and no content will not send', bad.status, 400);
    ok('and says why', /title/i.test(bad.body.error) && /PDF/i.test(bad.body.error));
    await call(owner, 'DELETE', '/api/memos/' + e1.body.memo.id);
    SENT.email = []; SENT.sms = []; SENT.push = [];
    var s = await call(owner, 'POST', '/api/memos/' + memoId + '/send');
    eq('the memo sends', s.status, 200);
    eq('to the four picked people', s.body.recipients, 4);
    ok('with a memo number', /^MEMO-\d{4}-001$/.test(s.body.memo.memo_no), s.body.memo.memo_no);
    ok('and a content fingerprint', /^[0-9a-f]{64}$/.test(s.body.memo.content_hash || ''));
    eq('everyone with email on gets an email (not Alyssa, who turned email off)', SENT.email.map(function (x) { return x.to; }).sort(),
      [admin2.email, lock2.email, tech.email].sort());
    eq('only people with texts on get a text', SENT.sms.map(function (x) { return x.to; }), ['+15555550101']);
    ok('the text carries a link straight to the memo', SENT.sms[0] && SENT.sms[0].body.indexOf('https://nova.test/?view=my-memo&id=' + memoId) !== -1);
    eq('everybody gets a push', SENT.push.length, 4);
    eq('sending twice is refused', (await call(owner, 'POST', '/api/memos/' + memoId + '/send')).status, 409);
    eq('a sent memo cannot be edited', (await call(owner, 'PUT', '/api/memos/' + memoId, { title: 'changed' })).status, 409);
    eq('or have its PDF swapped', (await call(owner, 'POST', '/api/memos/' + memoId + '/upload-url', { filename: 'b.pdf', content_type: 'application/pdf' })).status, 409);
    eq('or be deleted', (await call(owner, 'DELETE', '/api/memos/' + memoId)).status, 409);
    var dv = (await pool.query('SELECT delivered_via FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, tech.id])).rows[0];
    eq('delivery channels are recorded per person', dv.delivered_via, 'Nova, push, email, text');

    section('the lock');
    memoLock.invalidate();
    var g = await call(tech, 'GET', '/api/tasks');
    eq('a locked technician is stopped everywhere else', g.status, 403);
    ok('with memo_lock and the memo id', g.body && g.body.memo_lock === true && g.body.memo_id === memoId);
    eq('PUT on an invoice is held too (the editor autosaves)', (await call(tech, 'PUT', '/api/invoices/12', {})).status, 403);
    eq('but the time clock stays open', (await call(tech, 'GET', '/api/timeclock/status')).status, 200);
    eq('and a card payment already taken can still be recorded', (await call(tech, 'POST', '/api/invoices/12/payments/3/reconcile', {})).status, 200);
    var lk = await call(tech, 'GET', '/api/memos/me/lock');
    eq('the lock screen can find the memo', lk.status, 200);
    eq('it is this one', lk.body.memo && lk.body.memo.id, memoId);
    eq('an admin on the list is not locked', (await call(admin2, 'GET', '/api/tasks')).status, 200);
    eq('the sender is not on the list and not locked', (await call(owner, 'GET', '/api/tasks')).status, 200);
    var pend = await call(admin2, 'GET', '/api/memos/me/pending');
    ok('but the admin still sees it as waiting', pend.body.memos.length === 1 && pend.body.memos[0].my.locks_me === false);
    var mgrPath = await call(mgr, 'GET', '/api/tasks');
    eq('someone not on the list is untouched', mgrPath.status, 200);
    ok('pathIsOpen keeps /api/memos/meta CLOSED (only /me is open)', !memoLock.pathIsOpen('/api/memos/meta') && memoLock.pathIsOpen('/api/memos/me/12/sign'));

    section('reading and signing');
    var mine = await call(tech, 'GET', '/api/memos/me/' + memoId);
    eq('the recipient can open it', mine.status, 200);
    ok('with the acknowledgment wording, naming the effective date', /January 1, 2027/.test(mine.body.memo.ack_text));
    eq('someone not on the list cannot', (await call(mgr, 'GET', '/api/memos/me/' + memoId)).status, 404);
    var f = await call(tech, 'GET', '/api/memos/me/' + memoId + '/file');
    eq('the PDF loads for the recipient', f.status, 200);
    ok('byte for byte', Buffer.from(f.body.data, 'base64').equals(pdfBytes));
    var early = await call(tech, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Chris Tech', signature_data: SIG });
    eq('signing before reaching the end is refused', early.status, 409);
    ok('and says so', early.body.need_end === true);
    await call(tech, 'POST', '/api/memos/me/' + memoId + '/view');
    await call(tech, 'POST', '/api/memos/me/' + memoId + '/view');
    var vr = (await pool.query('SELECT view_count, first_viewed_at FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, tech.id])).rows[0];
    ok('views are counted', vr.view_count === 2 && !!vr.first_viewed_at);
    eq('reaching the end is recorded', (await call(tech, 'POST', '/api/memos/me/' + memoId + '/end')).status, 200);
    eq('acknowledging a memo that needs a signature is refused', (await call(tech, 'POST', '/api/memos/me/' + memoId + '/acknowledge')).status, 400);
    eq('a typed name is required', (await call(tech, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: '', signature_data: SIG })).status, 400);
    eq('a drawn signature is required', (await call(tech, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Chris Tech' })).status, 400);
    var sg = await call(tech, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Chris Tech', signature_data: SIG });
    eq('signing works', sg.status, 200);
    eq('and lifts the lock on the very next request', (await call(tech, 'GET', '/api/tasks')).status, 200);
    eq('signing twice is refused', (await call(tech, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Chris Tech', signature_data: SIG })).status, 409);
    var sr = (await pool.query('SELECT * FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, tech.id])).rows[0];
    eq('the signature is tied to the memo fingerprint', sr.signed_hash, s.body.memo.content_hash);
    ok('with the device', /Android/.test(sr.user_agent || ''));
    var aud = await pool.query("SELECT 1 FROM audit_logs WHERE entity_type = 'memo' AND entity_id = $1 AND action = 'memo_signed'", [memoId]);
    ok('and it is in the audit log', aud.rows.length === 1);

    section('excuse');
    eq('Jordan is locked', (await call(lock2, 'GET', '/api/tasks')).status, 403);
    eq('an excuse needs a reason', (await call(owner, 'POST', '/api/memos/' + memoId + '/recipients/' + lock2.id + '/excuse', {})).status, 400);
    eq('excusing works', (await call(owner, 'POST', '/api/memos/' + memoId + '/recipients/' + lock2.id + '/excuse', { reason: 'On leave until Nov 2' })).status, 200);
    eq('and releases the lock', (await call(lock2, 'GET', '/api/tasks')).status, 200);
    await call(owner, 'DELETE', '/api/memos/' + memoId + '/recipients/' + lock2.id + '/excuse');
    eq('undoing it locks again', (await call(lock2, 'GET', '/api/tasks')).status, 403);
    eq('a tech cannot excuse anybody', (await call(tech, 'POST', '/api/memos/' + memoId + '/recipients/' + lock2.id + '/excuse', { reason: 'x' })).status, 403);

    section('the tracker');
    var tr = await call(owner, 'GET', '/api/memos/' + memoId);
    eq('it loads', tr.status, 200);
    eq('counts', { total: tr.body.counts.total, viewed: tr.body.counts.viewed, completed: tr.body.counts.completed, locked: tr.body.counts.locked, not_opened: tr.body.counts.not_opened },
      { total: 4, viewed: 1, completed: 1, locked: 2, not_opened: 3 });
    var byName = {}; tr.body.recipients.forEach(function (r) { byName[r.user_name] = r; });
    eq('Chris shows signed', byName['Chris Tech'].status, 'signed');
    eq('Jordan shows not opened and locked', [byName['Jordan Lock'].status, byName['Jordan Lock'].locked], ['not_opened', true]);
    eq('the admin shows not locked', byName['Second Admin'].locked, false);
    ok('the event trail has the send and the signature', tr.body.events.some(function (e) { return e.action === 'sent'; }) && tr.body.events.some(function (e) { return e.action === 'signed'; }));
    var list = await call(owner, 'GET', '/api/memos');
    var row = list.body.memos.filter(function (m) { return m.id === memoId; })[0];
    eq('the list carries the same counts', [row.counts.total, row.counts.completed, row.counts.locked], [4, 1, 2]);
    ok('and the page totals', list.body.stats.locked_now >= 2 && list.body.stats.people_outstanding >= 3);

    section('PDFs');
    var cp = await call(owner, 'GET', '/api/memos/' + memoId + '/recipients/' + tech.id + '/pdf');
    eq('the signed copy builds', cp.status, 200);
    var cpDoc = await PDFDocument.load(Buffer.from(cp.body.data, 'base64'));
    eq('it is the signature page plus all 3 policy pages', cpDoc.getPageCount(), 4);
    ok('named after the memo and the person', /^MEMO-\d{4}-001-Chris-Tech\.pdf$/.test(cp.body.filename), cp.body.filename);
    eq('there is no signed copy for someone who has not signed', (await call(owner, 'GET', '/api/memos/' + memoId + '/recipients/' + lock2.id + '/pdf')).status, 409);
    eq('the employee can download their own copy', (await call(tech, 'GET', '/api/memos/me/' + memoId + '/pdf')).status, 200);
    eq('but not somebody else’s through /me', (await call(lock2, 'GET', '/api/memos/me/' + memoId + '/pdf')).status, 409);
    var rp = await call(owner, 'GET', '/api/memos/' + memoId + '/report');
    eq('the status report builds', rp.status, 200);
    ok('as a PDF', Buffer.from(rp.body.data, 'base64').slice(0, 5).toString() === '%PDF-');
    var all = await call(owner, 'GET', '/api/memos/' + memoId + '/signed-copies');
    eq('all signed copies build', all.status, 200);
    eq('as one file', (await PDFDocument.load(Buffer.from(all.body.data, 'base64'))).getPageCount(), 4);

    section('employee file');
    var uf = await call(owner, 'GET', '/api/memos/user/' + tech.id);
    eq('the owner sees the memo in Chris’s file', uf.status, 200);
    ok('signed', uf.body.memos.length === 1 && uf.body.memos[0].my.completion === 'signed');
    eq('and can download the copy from there', (await call(owner, 'GET', '/api/memos/user/' + tech.id + '/' + memoId + '/pdf')).status, 200);
    eq('a tech cannot open another tech’s memos', (await call(lock2, 'GET', '/api/memos/user/' + tech.id)).status, 403);
    eq('an admin cannot open a peer admin’s file (rank rule)', (await call(admin2, 'GET', '/api/memos/user/' + admin2.id)).status, 403);

    section('lock start date');
    var later = await call(owner, 'POST', '/api/memos', { title: 'Van camera policy', body: 'Cameras stay on.', require_signature: false, lock_until_done: true,
      lock_starts_at: new Date(Date.now() + 86400000).toISOString(), audience: { mode: 'people', user_ids: [disp.id] } });
    eq('a memo with a future lock start sends', (await call(owner, 'POST', '/api/memos/' + later.body.memo.id + '/send')).status, 200);
    memoLock.invalidate();
    // Alyssa is locked by the first memo; sign that one away first so this test reads only the second.
    await call(disp, 'POST', '/api/memos/me/' + memoId + '/end');
    await call(disp, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Alyssa Dispatch', signature_data: SIG });
    eq('before it starts, nobody is locked by it', (await call(disp, 'GET', '/api/tasks')).status, 200);
    await pool.query("UPDATE memos SET lock_starts_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [later.body.memo.id]);
    memoLock.invalidate();
    eq('once it starts, they are', (await call(disp, 'GET', '/api/tasks')).status, 403);
    eq('a sign-only call on an acknowledge memo is refused', (await call(disp, 'POST', '/api/memos/me/' + later.body.memo.id + '/sign', { typed_name: 'A', signature_data: SIG })).status, 400);
    eq('a written memo also needs reading to the end', (await call(disp, 'POST', '/api/memos/me/' + later.body.memo.id + '/acknowledge')).status, 409);
    await call(disp, 'POST', '/api/memos/me/' + later.body.memo.id + '/end');
    eq('then acknowledging works', (await call(disp, 'POST', '/api/memos/me/' + later.body.memo.id + '/acknowledge')).status, 200);
    eq('and unlocks', (await call(disp, 'GET', '/api/tasks')).status, 200);
    var ackPdf = await call(owner, 'GET', '/api/memos/' + later.body.memo.id + '/recipients/' + disp.id + '/pdf');
    eq('an acknowledged copy builds with no attachment (one page)', (await PDFDocument.load(Buffer.from(ackPdf.body.data, 'base64'))).getPageCount(), 1);

    section('revise');
    var rv = await call(owner, 'POST', '/api/memos/' + memoId + '/revise');
    eq('revise makes a new draft', rv.status, 200);
    var revId = rv.body.memo.id;
    eq('linked to the original', rv.body.memo.supersedes_id, memoId);
    ok('with the same PDF', rv.body.memo.file_name === 'PTO_Policy_2027.pdf' && rv.body.memo.file_pages === 3);
    eq('revising again returns the same draft', (await call(owner, 'POST', '/api/memos/' + memoId + '/revise')).body.memo.id, revId);
    await call(owner, 'PUT', '/api/memos/' + revId, { note: 'Here is the corrected PTO policy.' });
    var rs = await call(owner, 'POST', '/api/memos/' + revId + '/send');
    eq('the revision sends', rs.status, 200);
    ok('with a new, later number', rs.body.memo.memo_no > s.body.memo.memo_no, rs.body.memo.memo_no);
    ok('and a different fingerprint', rs.body.memo.content_hash !== s.body.memo.content_hash);
    var old = await call(owner, 'GET', '/api/memos/' + memoId);
    eq('the original is now superseded', old.body.memo.status, 'superseded');
    memoLock.invalidate();
    var lk2 = await call(lock2, 'GET', '/api/tasks');
    eq('Jordan is still locked - by the revision now', lk2.body && lk2.body.memo_id, revId);
    eq('signing the old one is refused', (await call(lock2, 'POST', '/api/memos/me/' + memoId + '/sign', { typed_name: 'Jordan Lock', signature_data: SIG })).status, 409);
    eq('Chris signed v1 and must sign the revision too', (await call(tech, 'GET', '/api/tasks')).status, 403);
    var tf = await call(owner, 'GET', '/api/memos/user/' + tech.id);
    ok('his file keeps the signed v1 and shows v2 waiting', tf.body.memos.length === 2 &&
      tf.body.memos.some(function (m) { return m.id === memoId && m.my.completion === 'signed'; }) &&
      tf.body.memos.some(function (m) { return m.id === revId && m.my.open; }));

    section('withdraw');
    eq('a withdraw needs a reason', (await call(owner, 'POST', '/api/memos/' + revId + '/withdraw', {})).status, 400);
    eq('withdraw works', (await call(owner, 'POST', '/api/memos/' + revId + '/withdraw', { reason: 'Sent to the wrong group' })).status, 200);
    memoLock.invalidate();
    eq('and releases everyone', (await call(lock2, 'GET', '/api/tasks')).status, 200);
    eq('signing a withdrawn memo is refused', (await call(lock2, 'POST', '/api/memos/me/' + revId + '/sign', { typed_name: 'Jordan Lock', signature_data: SIG })).status, 409);

    section('jobs');
    var jobs = require('./jobs/memos');
    var fh = await call(owner, 'POST', '/api/memos', { title: 'Uniform policy', body: 'Shirts tucked in.', require_signature: false, include_future_hires: true, audience: { mode: 'cities', cities: ['TPA'] } });
    await call(owner, 'POST', '/api/memos/' + fh.body.memo.id + '/send');
    var nh = await mkUser('Brand New', 'roadside_technician', { city: 'TPA' });
    var nhOther = await mkUser('Brand New Orlando', 'roadside_technician', { city: 'ORL' });
    var added = await jobs.runLateJoiners();
    ok('a new hire who matches is added', added >= 1);
    var nhRow = (await pool.query('SELECT added_late FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [fh.body.memo.id, nh.id])).rows[0];
    ok('and marked as added late', nhRow && nhRow.added_late === true);
    var nhO = (await pool.query('SELECT 1 FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [fh.body.memo.id, nhOther.id])).rows;
    eq('a new hire in another city is not', nhO.length, 0);
    var nhFirst = (await pool.query('SELECT 1 FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, nh.id])).rows;
    eq('and a memo without the option never picks anyone up', nhFirst.length, 0);
    eq('running it again adds nobody twice', await jobs.runLateJoiners(), 0);

    SENT.email = []; SENT.sms = [];
    await pool.query("UPDATE memo_recipients SET delivered_at = NOW() - INTERVAL '3 days', created_at = NOW() - INTERVAL '3 days' WHERE memo_id = $1", [fh.body.memo.id]);
    var reminded = await jobs.runMemoReminders();
    ok('the reminder sweep nudges everyone outstanding', reminded >= 3, 'reminded ' + reminded);
    ok('by email', SENT.email.some(function (x) { return /^Reminder: Uniform policy/.test(x.subject); }));
    eq('but not twice in one day', await jobs.runMemoReminders(), 0);
    var doneRow = (await pool.query('SELECT reminder_count FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, tech.id])).rows[0];
    eq('someone who already signed is never reminded', doneRow.reminder_count, 0);

    section('the lock fails open');
    memoLock.invalidate();
    var realQuery = pool.query;
    pool.query = function (sql) {
      if (typeof sql === 'string' && sql.indexOf('FROM memo_recipients r JOIN memos m') !== -1 && sql.indexOf('DISTINCT ON') !== -1) return Promise.reject(new Error('relation does not exist'));
      return realQuery.apply(pool, arguments);
    };
    var ff = await memoLock.lockedMemoFor(lock2.id);
    pool.query = realQuery;
    eq('a broken lock lookup locks nobody', ff, null);
  } finally {
    server.close();
  }

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
