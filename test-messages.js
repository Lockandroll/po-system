// Memos & Messaging: messages, text replies, Unmatched texts and send_messages.
//
// Runs against a REAL Postgres. Point DATABASE_URL at a throwaway database:
//   DATABASE_URL=postgresql://postgres@localhost:5432/novatest node test-messages.js
//
// Runs the real initDB(), mounts the REAL memos, inbound (Twilio SMS webhook)
// and nav-count routers behind the REAL requireAuth, and drives them over HTTP
// with real JWTs. Texts IN arrive the way Twilio sends them (form-encoded POST
// to /api/inbound/sms). Texts OUT, push and email are caught by in-memory
// stand-ins so every assertion can read exactly what would have gone out.
//
// Plan: claude/nova-memos-messaging-plan.md (Tony, 2026-10-11).
// House style: string concatenation only, no template literals.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-messages';
process.env.APP_URL = 'https://nova.test';
delete process.env.TWILIO_AUTH_TOKEN;          // dev mode: inbound skips the Twilio signature
process.env.NODE_ENV = 'test';

// ---- stand-ins, installed BEFORE any router is required ---------------------------
var r2 = require('./utils/r2');
var R2STORE = {};
r2.configured = function () { return true; };
r2.getObjectBuffer = async function (key) { if (!R2STORE[key]) throw new Error('NoSuchKey'); return R2STORE[key]; };
r2.putObject = async function (key, body) { R2STORE[key] = Buffer.from(body); };
var SENT = { email: [], sms: [], push: [] };
var emailMod = require('./utils/email');
emailMod.sendEmail = async function (to, subject) { SENT.email.push({ to: to, subject: subject }); return true; };
var smsMod = require('./utils/sms');
smsMod.sendSms = async function (to, body) { SENT.sms.push({ to: to, body: body }); return true; };
var pushMod = require('./utils/push');
pushMod.isReady = function () { return true; };
pushMod.sendPushToUsers = async function (ids, p) { SENT.push.push({ ids: ids, payload: p }); };
var AGENT = [];
var aiMod = require('./routes/ai');
aiMod.runAgentForActor = async function (user, prompt) { AGENT.push({ user: user.name, prompt: prompt }); return { reply: 'Note saved.' }; };

const express = require('express');
require('express-async-errors');
const jwt = require('jsonwebtoken');
const { initDB, pool } = require('./db');
const { requireAuth } = require('./middleware/auth');
const permissions = require('./utils/permissions');
const smsReplies = require('./utils/smsReplies');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
}
function section(t) { console.log('== ' + t); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var base = '';
function tokenFor(u) {
  return jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role, se: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
async function call(u, method, path, body) {
  const res = await fetch(base + path, {
    method: method,
    headers: Object.assign({ Authorization: 'Bearer ' + tokenFor(u), 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' },
      body === undefined ? {} : { 'Content-Type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  var json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}
// A text arriving from Twilio. The handler answers 200 straight away and works
// after, so wait until it has written something (or a short timeout).
async function textIn(from, body, extra) {
  var p = Object.assign({ From: from, To: '+15550000000', Body: body, NumMedia: '0' }, extra || {});
  var res = await fetch(base + '/api/inbound/sms', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString()
  });
  await sleep(250);
  return res.status;
}
function lastSmsTo(phone) {
  for (var i = SENT.sms.length - 1; i >= 0; i--) if (SENT.sms[i].to === phone) return SENT.sms[i].body;
  return null;
}

async function mkUser(name, role, extra) {
  extra = extra || {};
  const r = await pool.query(
    'INSERT INTO users (email, name, password_hash, role, active, session_epoch, home_city, phone, receive_sms, receive_emails, onboarding_status, extra_perms) ' +
    "VALUES ($1,$2,'x',$3,true,0,$4,$5,$6,true,'complete',$7) RETURNING id",
    [name.toLowerCase().replace(/ /g, '.') + '@msgtest.local', name, role, extra.city || 'ORL', extra.phone || null,
      extra.sms === false ? false : !!extra.phone, extra.perms || []]);
  return { id: r.rows[0].id, name: name, role: role, email: name.toLowerCase().replace(/ /g, '.') + '@msgtest.local', phone: extra.phone || null };
}

async function newMessage(u, fields) {
  var c = await call(u, 'POST', '/api/memos', Object.assign({ kind: 'message' }, fields));
  return c;
}
async function sendMessage(u, fields) {
  var c = await newMessage(u, fields);
  if (c.status !== 200) return c;
  var s = await call(u, 'POST', '/api/memos/' + c.body.memo.id + '/send');
  s.id = c.body.memo.id;
  return s;
}
async function rcp(memoId, userId) {
  return (await pool.query('SELECT * FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memoId, userId])).rows[0];
}

async function main() {
  console.log('Messages tests');
  console.log('--------------');
  await initDB();
  await initDB();
  ok('initDB runs twice', true);

  section('schema');
  var cols = (await pool.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('memos','memo_recipients','memo_feedback','sms_reply_targets','sms_unmatched')")).rows;
  function has(t, c) { return cols.some(function (x) { return x.table_name === t && x.column_name === c; }); }
  ok('memos.kind / require_response / file_to_record', has('memos', 'kind') && has('memos', 'require_response') && has('memos', 'file_to_record'));
  ok('memo_recipients.completed_via / last_feedback_via', has('memo_recipients', 'completed_via') && has('memo_recipients', 'last_feedback_via'));
  ok('memo_feedback.via', has('memo_feedback', 'via'));
  ok('sms_reply_targets and sms_unmatched exist', has('sms_reply_targets', 'phone_key') && has('sms_unmatched', 'reason'));
  eq('an existing memo row reads as a memo', (await pool.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'memos' AND column_name = 'kind'")).rows[0].column_default, "'memo'::character varying");

  section('permission: send_messages ships dark');
  ok('send_messages is a known permission', permissions.ALL_PERMS.indexOf('send_messages') !== -1);
  var defaultsHave = Object.keys(permissions.DEFAULTS || {}).some(function (r) { var d = permissions.DEFAULTS[r]; return Array.isArray(d) && d.indexOf('send_messages') !== -1; });
  ok('it is in no role default', !defaultsHave);
  ok('and not an employee permission', (permissions.EMPLOYEE_PERMS || []).indexOf('send_messages') === -1);

  // ---- fixtures ---------------------------------------------------------------
  await pool.query("INSERT INTO cities (name, code) VALUES ('Orlando','ORL'),('Tampa','TPA'),('Clearwater','CLW') ON CONFLICT (code) DO NOTHING");
  await pool.query("INSERT INTO settings (key, value) VALUES ('role_permissions', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [JSON.stringify({ manager: ['view_users'], locksmith: [], roadside_technician: [], dispatcher: [] })]);
  var owner = await mkUser('Tony Owner', 'owner', { city: 'ORL' });
  var sam = await mkUser('Sam Manager', 'manager', { city: 'TPA', perms: ['send_messages'] });
  var mona = await mkUser('Mona Plain', 'manager', { city: 'TPA' });
  var jordan = await mkUser('Jordan Price', 'locksmith', { city: 'ORL', phone: '+14075550142' });
  var chris = await mkUser('Chris Delgado', 'roadside_technician', { city: 'TPA', phone: '+18135550101' });
  var ray = await mkUser('Ray Ortiz', 'roadside_technician', { city: 'CLW', phone: '+12055550103' });
  var marcus = await mkUser('Marcus Lee', 'roadside_technician', { city: 'TPA', phone: '(912) 555-0104' });
  var dana = await mkUser('Dana Quiet', 'locksmith', { city: 'ORL' });
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1,'TPA'),($1,'CLW')", [sam.id]);

  var app = express();
  app.use('/api/inbound', require('./routes/inbound'));     // before express.json, like server.js
  app.use(express.json({ limit: '20mb' }));
  app.set('memosSyncDelivery', true);
  app.use('/api/memos', require('./routes/memos'));
  app.use('/api/nav', require('./routes/navCounts'));
  app.use(function (err, req, res, next) { console.error(err); res.status(500).json({ error: 'boom' }); });
  var server = await new Promise(function (resolve) { var s = app.listen(0, function () { resolve(s); }); });
  base = 'http://127.0.0.1:' + server.address().port;
  var yr = new Date().getFullYear();

  try {
    section('a message: defaults, numbering, what goes out');
    var c = await newMessage(owner, { title: 'Background check', body: 'Hi Jordan, your background check link is in your email from Checkr. Please finish it by Friday.', audience: { mode: 'people', user_ids: [jordan.id] } });
    eq('a message draft is created', c.status, 200);
    eq('kind is message', c.body.memo.kind, 'message');
    eq('no signature by default', c.body.memo.require_signature, false);
    eq('Got it by default', c.body.memo.require_response, true);
    eq('no reminders by default', c.body.memo.remind_every_days, 0);
    eq('never email', c.body.memo.notify_email, false);
    eq('filed in the Employee File by default', c.body.memo.file_to_record, true);
    eq('type reads Message', c.body.memo.type, 'Message');
    SENT.email = []; SENT.sms = []; SENT.push = [];
    var s = await call(owner, 'POST', '/api/memos/' + c.body.memo.id + '/send');
    eq('it sends', s.status, 200);
    var msgId = c.body.memo.id;
    eq('numbered MSG-YYYY-001', s.body.memo.memo_no, 'MSG-' + yr + '-001');
    eq('nothing is emailed', SENT.email.length, 0);
    var txt = lastSmsTo(jordan.phone) || '';
    ok('the text carries the message itself', txt.indexOf('your background check link is in your email from Checkr') !== -1, txt);
    ok('and says who and the subject', txt.indexOf('Message from Tony Owner: Background check') === 0, txt);
    ok('and how to answer', txt.indexOf('Text back GOT IT, or reply with a question.') !== -1, txt);
    ok('and the link', txt.indexOf('https://nova.test/?view=my-memo&id=' + msgId) !== -1);
    ok('the push title says Message from', SENT.push.length === 1 && SENT.push[0].payload.title === 'Message from Tony Owner: Background check');
    var tg = (await pool.query("SELECT * FROM sms_reply_targets WHERE phone_key = '4075550142'")).rows;
    ok('the text is remembered as reply-able', tg.length === 1 && tg[0].kind === 'memo' && tg[0].target_id === msgId);
    var memoDraft = await call(owner, 'POST', '/api/memos', { title: 'A memo', body: 'Memo body', audience: { mode: 'people', user_ids: [dana.id] }, require_signature: false });
    var ms = await call(owner, 'POST', '/api/memos/' + memoDraft.body.memo.id + '/send');
    eq('a memo still numbers on its own count', ms.body.memo.memo_no, 'MEMO-' + yr + '-001');
    eq('and a memo still reads as a memo', ms.body.memo.kind, 'memo');

    section('send checks for a message');
    var e1 = await newMessage(owner, { title: 'No body', audience: { mode: 'people', user_ids: [jordan.id] } });
    var e1s = await call(owner, 'POST', '/api/memos/' + e1.body.memo.id + '/send');
    eq('a message with no text is refused', e1s.status, 400);
    ok('saying so', /Write the message/.test(e1s.body.error));
    await pool.query("UPDATE memos SET body = 'x', file_key = 'memos/1/x.pdf' WHERE id = $1", [e1.body.memo.id]);
    var e2s = await call(owner, 'POST', '/api/memos/' + e1.body.memo.id + '/send');
    ok('a message with a PDF is refused', e2s.status === 400 && /text only/.test(e2s.body.error));
    var e3 = await newMessage(owner, { title: 'Nobody', body: 'x' });
    eq('a message to nobody is refused', (await call(owner, 'POST', '/api/memos/' + e3.body.memo.id + '/send')).status, 400);
    var e4 = await newMessage(owner, { title: 'Lock read', body: 'x', require_response: false, lock_until_done: true, audience: { mode: 'people', user_ids: [jordan.id] } });
    var e4s = await call(owner, 'POST', '/api/memos/' + e4.body.memo.id + '/send');
    ok('a Just-read-it message cannot lock Nova', e4s.status === 400 && /cannot lock/.test(e4s.body.error));

    section('texting back GOT IT');
    SENT.sms = [];
    eq('Twilio gets a 200', await textIn('+14075550142', 'Got it!'), 200);
    var r1 = await rcp(msgId, jordan.id);
    ok('marked Got it', !!r1.completed_at && r1.completion === 'acknowledged', JSON.stringify(r1 && r1.completion));
    eq('by text', r1.completed_via, 'sms');
    eq('a text back is not counted as opening it in Nova', r1.first_viewed_at, null);
    ok('it counts as read to the end', !!r1.reached_end_at);
    ok('Jordan gets a short confirmation', /Thanks, Jordan\. Marked Got it for Tony Owner\./.test(lastSmsTo('+14075550142') || ''), lastSmsTo('+14075550142'));
    var ev = (await pool.query("SELECT detail FROM memo_events WHERE memo_id = $1 AND action = 'acknowledged'", [msgId])).rows;
    ok('the event says it came by text', ev.length === 1 && ev[0].detail.via === 'sms');
    SENT.sms = [];
    await textIn('+14075550142', 'ok');
    eq('a second ok says nothing back', SENT.sms.length, 0);

    section('texting back a question');
    SENT.push = []; SENT.sms = [];
    await textIn('+14075550142', 'I do not see the Checkr email though. Can you resend it?');
    var fb = (await pool.query('SELECT * FROM memo_feedback WHERE memo_id = $1 AND user_id = $2 ORDER BY id', [msgId, jordan.id])).rows;
    ok('it lands on his thread', fb.length === 1 && /Checkr email/.test(fb[0].body));
    eq('marked as by text', fb[0].via, 'sms');
    eq('the row remembers he wrote by text', (await rcp(msgId, jordan.id)).last_feedback_via, 'sms');
    ok('Tony is pushed about it', SENT.push.some(function (p) { return p.ids.indexOf(owner.id) !== -1 && /Jordan Price/.test(p.payload.body); }));
    ok('Jordan is told where it went', /^Sent to Tony Owner on MSG-/.test(lastSmsTo('+14075550142') || ''), lastSmsTo('+14075550142'));
    var tr = await call(owner, 'GET', '/api/memos/' + msgId);
    var jr = tr.body.recipients.filter(function (x) { return x.user_id === jordan.id; })[0];
    ok('the tracker shows the new reply', jr.feedback_unread === true && jr.completed_via === 'sms');
    var th = await call(owner, 'GET', '/api/memos/' + msgId + '/recipients/' + jordan.id + '/feedback');
    ok('the thread shows it came by text', th.body.thread.length === 1 && th.body.thread[0].via === 'sms');

    section('Tony replies in Nova, it goes back as a text');
    SENT.sms = []; SENT.email = [];
    var rp = await call(owner, 'POST', '/api/memos/' + msgId + '/recipients/' + jordan.id + '/feedback', { body: 'Resent it just now. Check again.' });
    eq('the reply saves', rp.status, 200);
    eq('and says it was texted', rp.body.texted, true);
    eq('Jordan gets it as a text, signed with the name', lastSmsTo('+14075550142'), 'Tony Owner: Resent it just now. Check again.');
    eq('never email for a message', SENT.email.length, 0);
    ok('the reply is marked by text in the thread', rp.body.thread[1].via === 'sms' && rp.body.thread[1].from_staff === true);
    // If he answers in Nova instead, the next reply stops texting.
    await call(jordan, 'POST', '/api/memos/me/' + msgId + '/feedback', { body: 'Found it, thanks.' });
    eq('answering in Nova resets the channel', (await rcp(msgId, jordan.id)).last_feedback_via, null);
    SENT.sms = [];
    var rp2 = await call(owner, 'POST', '/api/memos/' + msgId + '/recipients/' + jordan.id + '/feedback', { body: 'Great.' });
    ok('then a reply is push only', rp2.body.texted === false && SENT.sms.length === 0);

    section('GOT IT on a message that needs a signature');
    var sg = await sendMessage(owner, { title: 'Vehicle assignment sheet', body: 'Please sign the sheet for van 14.', require_signature: true, audience: { mode: 'people', user_ids: [marcus.id] } });
    eq('sent', sg.status, 200);
    ok('its text says it needs a signature in Nova', /This one needs your signature in Nova:/.test(lastSmsTo('(912) 555-0104') || ''));
    SENT.sms = [];
    await textIn('+19125550104', 'got it');
    ok('it does not count', !(await rcp(sg.id, marcus.id)).completed_at);
    ok('he gets the link to sign', /needs your signature, which only works in Nova: https:\/\/nova\.test\/\?view=my-memo&id=/.test(lastSmsTo('+19125550104') || ''), lastSmsTo('+19125550104'));

    section('Just read it');
    var jr2 = await sendMessage(owner, { title: 'Spare truck keys', body: 'The spare keys for truck 9 are at the Tampa office front desk.', require_response: false, file_to_record: false, audience: { mode: 'people', user_ids: [chris.id, ray.id] } });
    eq('sent to two', jr2.body.recipients, 2);
    ok('its text says reply with a question, not GOT IT', /Reply here with any question\./.test(lastSmsTo('+18135550101') || ''));
    var v = await call(chris, 'POST', '/api/memos/me/' + jr2.id + '/view');
    ok('opening it in Nova makes it read', !!v.body.completed_at);
    var rc = await rcp(jr2.id, chris.id);
    ok('as read, in Nova', rc.completion === 'read' && rc.completed_via === null);
    SENT.sms = [];
    await textIn('+12055550103', '👍');
    var rr = await rcp(jr2.id, ray.id);
    ok('a thumbs-up by text makes it read', rr.completion === 'read' && rr.completed_via === 'sms', JSON.stringify(rr.completion));
    ok('Ray is told', /Marked as read for Tony Owner/.test(lastSmsTo('+12055550103') || ''));
    var lst = await call(owner, 'GET', '/api/memos?kind=message');
    var row5 = lst.body.memos.filter(function (m) { return m.id === jr2.id; })[0];
    ok('the list shows 2 of 2 done, 1 by text', row5.counts.completed === 2 && row5.counts.by_text === 1);
    ok('and who it went to', row5.to_names === 'Chris Delgado, Ray Ortiz');
    var fileChris = await call(owner, 'GET', '/api/memos/user/' + chris.id);
    ok('"File in Employee File" off keeps it out of the file', fileChris.body.memos.every(function (m) { return m.id !== jr2.id; }));
    var mineChris = await call(chris, 'GET', '/api/memos/me');
    ok('but it is still in his own My File', mineChris.body.memos.some(function (m) { return m.id === jr2.id; }));
    var fileJordan = await call(owner, 'GET', '/api/memos/user/' + jordan.id);
    ok('a filed message is in the Employee File', fileJordan.body.memos.some(function (m) { return m.id === msgId; }));

    section('a photo, and a long message');
    SENT.sms = [];
    await textIn('+12055550103', '', { NumMedia: '1', MediaUrl0: 'https://api.twilio.com/x.jpg' });
    var pf = (await pool.query('SELECT body FROM memo_feedback WHERE memo_id = $1 AND user_id = $2', [jr2.id, ray.id])).rows;
    ok('a photo is noted on the thread, not saved', pf.length === 1 && pf[0].body === '[1 photo sent by text, not saved]', JSON.stringify(pf));
    ok('and he is told to add it in Nova', /Photos by text are not saved yet/.test(lastSmsTo('+12055550103') || ''));
    var longBody = new Array(40).join('Please read every part of this carefully. ');
    var lg = await sendMessage(owner, { title: 'Long one', body: longBody, audience: { mode: 'people', user_ids: [ray.id] } });
    ok('the long text says the full message is in Nova', /The full message is in Nova/.test(lastSmsTo('+12055550103') || ''));
    ok('and the text is trimmed', (lastSmsTo('+12055550103') || '').length < 520);
    SENT.sms = [];
    await textIn('+12055550103', 'got it');
    ok('GOT IT by text does not count when it did not all fit', !(await rcp(lg.id, ray.id)).completed_at);
    ok('he is asked to read it in Nova', /longer than a text/.test(lastSmsTo('+12055550103') || ''));

    section('routing: newest text wins, a tag always wins');
    // Marcus also manages a feedback record: the feedback text went out first.
    var fbRec = (await pool.query("INSERT INTO customer_feedback (customer_name, assigned_to, is_resolved) VALUES ('Smith', $1, false) RETURNING id", [marcus.id])).rows[0].id;
    await pool.query("INSERT INTO sms_reply_targets (phone_key, user_id, kind, target_id, sent_at) VALUES ('9125550104', $1, 'feedback', $2, NOW() - INTERVAL '2 hours')", [marcus.id, fbRec]);
    await pool.query("UPDATE sms_reply_targets SET sent_at = NOW() - INTERVAL '3 hours' WHERE phone_key = '9125550104' AND kind = 'memo'");
    var cov = await sendMessage(owner, { title: 'Thanksgiving coverage', body: 'Can you cover Clearwater Thursday? Text back.', audience: { mode: 'people', user_ids: [marcus.id] } });
    AGENT = [];
    await textIn('+19125550104', 'Yes I can cover it');
    var cf = (await pool.query('SELECT body FROM memo_feedback WHERE memo_id = $1 AND user_id = $2', [cov.id, marcus.id])).rows;
    ok('the newest text (the message) gets the reply', cf.length === 1 && cf[0].body === 'Yes I can cover it');
    eq('and the feedback record is left alone', AGENT.length, 0);
    await textIn('+19125550104', 'FB-' + fbRec + ' called the customer, she is fine now');
    var act = (await pool.query("SELECT body, channel FROM customer_feedback_activity WHERE feedback_id = $1", [fbRec])).rows;
    ok('a FB- tag goes to the feedback record', act.length === 1 && act[0].channel === 'sms' && /called the customer/.test(act[0].body));
    eq('the old feedback flow still runs', AGENT.length, 1);
    var cf2 = (await pool.query('SELECT COUNT(*)::int AS n FROM memo_feedback WHERE memo_id = $1 AND user_id = $2', [cov.id, marcus.id])).rows[0].n;
    eq('and that text did not land on the message', cf2, 1);
    await textIn('+19125550104', 'msg-' + yr + '-' + sg.body.memo.memo_no.split('-')[2] + ' which van is it?');
    var sgf = (await pool.query('SELECT body FROM memo_feedback WHERE memo_id = $1 AND user_id = $2', [sg.id, marcus.id])).rows;
    ok('a MSG tag goes to that message even though it is not the newest', sgf.length === 1 && /which van/.test(sgf[0].body));
    await smsReplies.noteOutbound('+19125550104', 'Nova: FB-' + fbRec + ' was reassigned to you.');
    AGENT = [];
    await textIn('+19125550104', 'on my way to her now');
    eq('a newer feedback text takes the next plain reply', AGENT.length, 1);

    section('unmatched texts are kept, not dropped');
    await textIn('+19045550199', 'This is Kim, new number. Got your message.');
    await pool.query("UPDATE sms_reply_targets SET sent_at = NOW() - INTERVAL '9 days' WHERE phone_key = '4075550142'");
    await textIn('+14075550142', 'Can I swap Saturday?');
    await textIn('+14075550142', 'ok');
    var um = await call(owner, 'GET', '/api/memos/texts/unmatched');
    eq('the owner can open Unmatched texts', um.status, 200);
    var unknown = um.body.texts.filter(function (t) { return t.from_number === '+19045550199'; })[0];
    ok('a number on no account is kept, with why', unknown && unknown.user_id === null && /not on any Nova account/.test(unknown.reason));
    var late = um.body.texts.filter(function (t) { return t.user_id === jordan.id && t.body === 'ok'; })[0];
    ok('a text past the 7-day window is kept for a person to look at', !!late && /last 7 days/.test(late.reason), JSON.stringify(late));
    ok('with his recent messages offered to attach it to', late.memos.some(function (m) { return m.id === msgId; }));
    eq('a manager with only send_messages cannot see the list', (await call(sam, 'GET', '/api/memos/texts/unmatched')).status, 403);
    var at = await call(owner, 'POST', '/api/memos/texts/unmatched/' + late.id + '/attach', { memo_id: msgId });
    eq('attaching it to a message works', at.status, 200);
    var jth = (await pool.query("SELECT body, via FROM memo_feedback WHERE memo_id = $1 AND user_id = $2 AND body = 'ok'", [msgId, jordan.id])).rows;
    ok('it is now on his thread, by text', jth.length === 1 && jth[0].via === 'sms');
    eq('attaching twice is refused', (await call(owner, 'POST', '/api/memos/texts/unmatched/' + late.id + '/attach', { memo_id: msgId })).status, 404);
    eq('attaching to a message he was not sent is refused', (await call(owner, 'POST', '/api/memos/texts/unmatched/' + um.body.texts.filter(function (t) { return t.body === 'Can I swap Saturday?'; })[0].id + '/attach', { memo_id: jr2.id })).status, 400);
    var kimU = await mkUser('Kim Baptiste', 'roadside_technician', { city: 'TPA' });
    eq('a new number can be put on the right person', (await call(owner, 'POST', '/api/memos/texts/unmatched/' + unknown.id + '/phone', { user_id: kimU.id })).status, 200);
    eq('the number is now on her account', (await pool.query('SELECT phone FROM users WHERE id = $1', [kimU.id])).rows[0].phone, '+19045550199');
    var um2 = await call(owner, 'GET', '/api/memos/texts/unmatched');
    ok('and the text now shows her name', um2.body.texts.some(function (t) { return t.id === unknown.id && t.user_name === 'Kim Baptiste'; }));
    await textIn('+19045550199', 'test');
    var um2b = await call(owner, 'GET', '/api/memos/texts/unmatched');
    var unk2 = um2b.body.texts.filter(function (t) { return t.id === unknown.id; })[0];
    var conflict = await call(owner, 'POST', '/api/memos/texts/unmatched/' + unk2.id + '/phone', { user_id: jordan.id });
    eq('moving a number that is already on someone is refused', conflict.status, 409);
    var dm = await call(owner, 'POST', '/api/memos/texts/unmatched/' + unknown.id + '/dismiss');
    eq('dismiss works', dm.status, 200);
    var um3 = await call(owner, 'GET', '/api/memos/texts/unmatched');
    ok('and it is gone from the list', um3.body.texts.every(function (t) { return t.id !== unknown.id; }));

    section('send_messages: a manager messages his own people only');
    eq('a manager without it cannot open Memos & Messaging', (await call(mona, 'GET', '/api/memos')).status, 403);
    var meta = await call(sam, 'GET', '/api/memos/meta');
    eq('Sam can load the people list', meta.status, 200);
    var names = meta.body.people.map(function (p) { return p.name; });
    ok('it lists only people in his cities (TPA, CLW)', names.indexOf('Chris Delgado') !== -1 && names.indexOf('Ray Ortiz') !== -1 && names.indexOf('Jordan Price') === -1);
    eq('and says he is scoped', meta.body.scope, { full: false, cities: ['TPA', 'CLW'] });
    var sm = await call(sam, 'POST', '/api/memos', { kind: 'memo', title: 'Try a memo', body: 'x', lock_until_done: true, require_signature: true, audience: { mode: 'all' } });
    eq('his draft is created', sm.status, 200);
    eq('but always as a message', sm.body.memo.kind, 'message');
    eq('never locking', sm.body.memo.lock_until_done, false);
    eq('never asking for a signature', sm.body.memo.require_signature, false);
    eq('and never to Everyone', sm.body.memo.audience.mode, 'people');
    await call(sam, 'PUT', '/api/memos/' + sm.body.memo.id, { audience: { mode: 'people', user_ids: [jordan.id] }, lock_until_done: true });
    var bad = await call(sam, 'POST', '/api/memos/' + sm.body.memo.id + '/send');
    ok('sending to someone outside his cities is refused', bad.status === 403 && /only message people in your cities/.test(bad.body.error), JSON.stringify(bad.body));
    eq('and the lock stayed off', (await pool.query('SELECT lock_until_done FROM memos WHERE id = $1', [sm.body.memo.id])).rows[0].lock_until_done, false);
    var pv = await call(sam, 'POST', '/api/memos/audience-preview', { audience: { mode: 'people', user_ids: [jordan.id] } });
    ok('the preview warns before he tries', pv.status === 200 && /only message people in your cities/.test(pv.body.problem || ''));
    await call(sam, 'PUT', '/api/memos/' + sm.body.memo.id, { audience: { mode: 'people', user_ids: [chris.id] }, title: 'Inspection photos', body: 'Chris, your van inspection is missing the tire photos.' });
    var goodS = await call(sam, 'POST', '/api/memos/' + sm.body.memo.id + '/send');
    eq('to his own tech it sends', goodS.status, 200);
    var samList = await call(sam, 'GET', '/api/memos');
    ok('his list shows only what he wrote', samList.body.memos.length === 1 && samList.body.memos[0].id === sm.body.memo.id);
    eq('he cannot open Tony\'s message', (await call(sam, 'GET', '/api/memos/' + msgId)).status, 404);
    eq('or reply on it', (await call(sam, 'POST', '/api/memos/' + msgId + '/recipients/' + jordan.id + '/feedback', { body: 'hi' })).status, 404);
    eq('or upload a PDF (memo-only)', (await call(sam, 'POST', '/api/memos/' + sm.body.memo.id + '/upload-url', { filename: 'a.pdf' })).status, 403);
    var ownerList = await call(owner, 'GET', '/api/memos');
    ok('the owner sees Sam\'s message too', ownerList.body.memos.some(function (m) { return m.id === sm.body.memo.id; }));
    eq('and can open it', (await call(owner, 'GET', '/api/memos/' + sm.body.memo.id)).status, 200);
    await textIn('+18135550101', 'Adding them now');
    var nav = await call(sam, 'GET', '/api/nav/counts?fresh=1');
    var samMemos = nav.body && nav.body.items ? nav.body.items.memos : (nav.body && nav.body.memos);
    ok('Sam gets a badge for the reply on his message', !!samMemos && samMemos.n === 1, JSON.stringify(nav.body));

    section('signed copy and badges');
    var pdf = await call(owner, 'GET', '/api/memos/' + msgId + '/recipients/' + jordan.id + '/pdf');
    ok('a message confirmed by text still makes a PDF copy', pdf.status === 200 && Buffer.from(pdf.body.data, 'base64').slice(0, 5).toString() === '%PDF-');
    var onav = await call(owner, 'GET', '/api/nav/counts?fresh=1');
    var om = onav.body && onav.body.items ? onav.body.items.memos : (onav.body && onav.body.memos);
    ok('the owner gets a Memos & Messaging badge (replies + unmatched texts)', !!om && om.n >= 1 && om.parts.some(function (p) { return p.key === 'texts'; }), JSON.stringify(om));
    var jnav = await call(marcus, 'GET', '/api/nav/counts?fresh=1');
    var jdocs = jnav.body && jnav.body.items ? jnav.body.items['my-documents'] : null;
    ok('a tech\'s My File badge counts messages waiting on him', !!jdocs && jdocs.parts.some(function (p) { return p.key === 'memos' && p.label === 'memo or message waiting'; }), JSON.stringify(jnav.body));

    section('memo fingerprints did not move');
    var internal = require('./routes/memos')._internal;
    var m0 = { title: 'T', type: 'Policy update', note: 'n', body: 'b', effective_date: '2027-01-01', file_sha256: 'abc', require_signature: true };
    eq('a memo fingerprint is the same with or without kind = memo', internal.contentHash(Object.assign({ kind: 'memo' }, m0)), internal.contentHash(m0));
    ok('a message fingerprint differs from the same text as a memo', internal.contentHash(Object.assign({ kind: 'message' }, m0)) !== internal.contentHash(m0));
    eq('message wording for the confirmation', internal.ackText({ kind: 'message', require_signature: false }), 'I confirm that I received and read this message.');

    section('helpers');
    ok('affirmations', ['Got it', 'got it!', 'OK', 'k', 'yes', '👍', '10-4', 'Liked “Background check”'].every(smsReplies.isAffirmation));
    ok('a question is not an affirmation', !smsReplies.isAffirmation('got it, but which link?') && !smsReplies.isAffirmation('Yes I can cover it'));
    eq('MSG 7 means this year', smsReplies.parseTag('re MSG 7 ok'), { kind: 'memo', memo_no: 'MSG-' + yr + '-007' });
    eq('a full number', smsReplies.parseTag('MEMO-2026-004 question'), { kind: 'memo', memo_no: 'MEMO-2026-004' });
    eq('a feedback tag', smsReplies.parseTag('fb 1182 done'), { kind: 'feedback', id: 1182 });
  } finally {
    server.close();
    await pool.end();
  }
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
