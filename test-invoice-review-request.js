'use strict';
/*
 * Customer follow-up on invoice completion -- real Postgres, real db.js
 * initDB, real routes over HTTP (invoices, invoiceLink, followups, vendors), real
 * PDF. Plan: claude/nova-customer-follow-up-plan.md (Tony, 2026-10-11).
 *
 *   PGURL=postgres://... node test-invoice-review-request.js
 *
 * Covers: off by default and accounts default to Do not contact; the precedence
 * rules (account none / survey only / retail, billed backstop, Don't send,
 * automatic commercial and repeat surveys, the locksmith's pick + reason); one
 * link in the text, honest wording, no stars; the customer page per mode (Google
 * button vs survey vs survey-only with no invoice); PDF view/download; the
 * counted Google redirect; Email me a copy and its daily limit; the survey into
 * Customer Feedback (complaint + call-back task vs quiet praise), once only;
 * the Invoice finished email row; Send now / Send again rules; access; the
 * report math and the locksmith flag; vendors customer_contact save rules.
 */
var http = require('http');
var Module = require('module');
process.env.DATABASE_URL = process.env.PGURL;
process.env.APP_URL = 'https://www.popalockar.com/';
var realDb = require('./db');
var pool = realDb.pool;

var CURRENT_USER = null;
var MAILS = [], TEXTS = [], NOTIFY_MAILS = [];
var TWILIO_FAIL = false;
var NOOP = async function () {};
var origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db') return realDb;
  if (request === '../middleware/auth') return {
    requireAuth: function (req, res, next) { req.user = CURRENT_USER; next(); },
    requireRole: function () { return function (req, res, next) { next(); }; },
    requirePermission: function () { return function (req, res, next) { next(); }; }
  };
  if (request === '../utils/email' || request === './email') return {
    sendEmail: async function (to, subj, html) { NOTIFY_MAILS.push({ to: to, subject: subj, html: html }); return true; },
    sendEmailDetailed: async function (to, subj, html, cc, att, opts) { MAILS.push({ to: to, subject: subj, html: html, att: att, opts: opts }); return { ok: true, id: 'm' + MAILS.length }; },
    emailTemplate: function (o) { return JSON.stringify(o); }
  };
  if (request === '../utils/sms' || request === './sms') return {
    sendSms: NOOP,
    sendSmsDetailed: async function (to, body) { if (TWILIO_FAIL) return { ok: false, error: 'Twilio says the number is a landline' }; TEXTS.push({ to: to, body: body }); return { ok: true, sid: 'SM' + TEXTS.length }; }
  };
  if (request === '../utils/push' || request === './push') return { sendPushToUsers: NOOP };
  if (request === '../utils/r2' || request === './r2') return { configured: function () { return false; }, put: NOOP, get: NOOP, del: NOOP, presignPut: NOOP, presignGet: NOOP, head: NOOP, getObjectBuffer: NOOP };
  if (request === '../utils/disputePdf') return { buildDisputePdf: NOOP };
  if (request === '../utils/square') return { callbackUrl: function () { return ''; }, newNonce: function () { return 'n'; }, signState: function () { return 's'; }, configured: function () { return false; }, enabled: function () { return false; }, buildPosUrls: function () { return {}; } };
  if (request === '../jobs/taskReminders') return { notifyTaskAssigned: NOOP, notifyTaskCc: NOOP };
  if (request === './feedbackAI') return { classifyFeedback: async function () { return null; } };
  if (request === './emailLog' || request === '../utils/emailLog') return { recordOutbound: NOOP, latestForEntity: async function () { return null; } };
  return origLoad.apply(this, arguments);
};

var express = require('express');
var app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/followups', require('./routes/followups'));
app.use('/api/vendors', require('./routes/vendors'));
app.use('/i', require('./routes/invoiceLink'));
var { notifyInvoiceFinished } = require('./utils/invoiceNotify');
var fu = require('./utils/invoiceReviewRequest');

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } }
function eq(a, b, m) { ok(a === b, m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
var base;
function call(method, path, body) {
  return new Promise(function (resolve, reject) {
    var data = body == null ? null : Buffer.from(JSON.stringify(body));
    var req = http.request(base + path, { method: method, headers: Object.assign({ 'content-type': 'application/json' }, data ? { 'content-length': data.length } : {}) }, function (res) {
      var chunks = []; res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () { var b = Buffer.concat(chunks); var json = null; try { json = JSON.parse(b.toString()); } catch (e) { json = { _raw: b.toString() }; } resolve({ status: res.statusCode, body: json, buf: b, text: b.toString(), headers: res.headers }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const rowOf = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
async function settle(id) { for (var i = 0; i < 100; i++) { var r = await rowOf(id); if (r.review_send_status !== 'sending') return r; await new Promise(function (z) { setTimeout(z, 50); }); } return rowOf(id); }
async function wait(ms) { await new Promise(function (z) { setTimeout(z, ms); }); }
function lastText() { return TEXTS[TEXTS.length - 1]; }
function tokenIn(s) { var m = String(s).match(/\/i\/([A-Za-z0-9_-]{20,64})/); return m ? m[1] : null; }
function notifyDetail(label) { var m = NOTIFY_MAILS[NOTIFY_MAILS.length - 1]; if (!m) return undefined; var o = JSON.parse(m.html); var d = (o.details || []).filter(function (x) { return x.label === label; })[0]; return d ? d.value : undefined; }

let TECH, TECH2, ADMIN, MGR, ACC_NONE, ACC_SURVEY, ACC_RETAIL, ACC_NEW;
var LINE = [{ line_type: 'labor', description: 'Lockout, vehicle', quantity: 1, unit_price: 85 }];
var PHONE_N = 100;
function rawInv(extra) { PHONE_N++; return Object.assign({ status: 'draft', customer_name: 'Maria Lopez', phone: '(407) 555-0' + PHONE_N, email: 'maria' + PHONE_N + '@example.com', city_code: 'ORL', pay_type: 'Visa', line_items: LINE }, extra || {}); }
// The follow-up pick is required since 2026-10-12. Older scenarios below were
// written when Google was pre-selected and Don't send was the default, so inv()
// fills in the pick those scenarios meant: Google when a Text/Email is given,
// otherwise No survey. rawInv() is the untouched body.
function inv(extra) {
  var b = rawInv(extra);
  if (!extra || !Object.prototype.hasOwnProperty.call(extra, 'followup_kind')) {
    if (b.review_send_via === 'sms' || b.review_send_via === 'email') b.followup_kind = 'google';
    else if (!b.review_send_via || b.review_send_via === 'none') { b.review_send_via = 'none'; b.followup_kind = 'none'; }
  }
  return b;
}
async function finish(id, pay) { var r = await call('POST', '/api/invoices/' + id + '/complete', { pay_type: pay || 'Visa' }); return r; }

async function run() {
  await realDb.initDB();
  await realDb.initDB(); // re-runnable
  await pool.query('TRUNCATE invoices, invoice_line_items, users, settings, cities, audit_logs, vendors, customer_feedback, tasks, invoice_surveys, invoice_link_events RESTART IDENTITY CASCADE');
  ADMIN = (await pool.query("INSERT INTO users (name, email, role, password_hash) VALUES ('Tony','a@x.test','admin','x') RETURNING id")).rows[0].id;
  MGR = (await pool.query("INSERT INTO users (name, email, role, password_hash) VALUES ('Orlando Manager','m@x.test','manager','x') RETURNING id")).rows[0].id;
  TECH = (await pool.query("INSERT INTO users (name, email, role, password_hash, home_city) VALUES ('Mike Yonkman','t@x.test','locksmith','x','ORL') RETURNING id")).rows[0].id;
  TECH2 = (await pool.query("INSERT INTO users (name, email, role, password_hash, home_city) VALUES ('Chris Patel','o@x.test','locksmith','x','TPA') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO cities (code, name, active, invoice_prefix, manager_user_id) VALUES ('ORL','Orlando', true, 1, $1), ('JAX','Jacksonville', true, 2, NULL), ('TPA','Tampa', true, 3, NULL), ('CLW','Clearwater', true, 4, NULL)", [MGR]);
  ACC_NEW = (await pool.query("INSERT INTO vendors (name, show_in_invoice) VALUES ('Brand New Account', true) RETURNING id")).rows[0].id;
  ACC_NONE = (await pool.query("INSERT INTO vendors (name, show_in_invoice, customer_contact) VALUES ('Ross Dress For Less', true, 'none') RETURNING id")).rows[0].id;
  ACC_SURVEY = (await pool.query("INSERT INTO vendors (name, show_in_invoice, customer_contact) VALUES ('Lake Mary HOA', true, 'survey') RETURNING id")).rows[0].id;
  ACC_RETAIL = (await pool.query("INSERT INTO vendors (name, show_in_invoice, customer_contact) VALUES ('Orlando Property Mgmt', true, 'retail') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO settings (key, value) VALUES ('company_phone', '(407) 555-0100')");
  var srv = app.listen(0); base = 'http://127.0.0.1:' + srv.address().port;
  var tech = { id: TECH, name: 'Mike Yonkman', role: 'locksmith', email: 't@x.test' };
  var tech2 = { id: TECH2, name: 'Chris Patel', role: 'locksmith', email: 'o@x.test' };
  var admin = { id: ADMIN, name: 'Tony', role: 'admin', email: 'a@x.test' };
  var r, id, row, t;

  console.log('\n1. Defaults');
  eq((await pool.query('SELECT customer_contact FROM vendors WHERE id = $1', [ACC_NEW])).rows[0].customer_contact, 'none', 'a new account defaults to Do not contact');
  CURRENT_USER = tech;
  r = await call('POST', '/api/invoices', rawInv());
  eq(r.status, 201, 'draft created');
  id = r.body.id;
  row = await rowOf(id);
  eq(row.review_send_via, 'none', 'invoice defaults to nothing sent');
  eq(row.followup_kind, null, 'nothing is pre-selected (no Google default)');
  r = await call('GET', '/api/invoices/' + id);
  var _fg = (r.body.gates || []).filter(function (g) { return g.key === 'followup'; })[0];
  ok(_fg && !_fg.ok && r.body.can_complete === false, 'retail job: the follow-up pick is a gate and blocks Complete');
  r = await finish(id);
  eq(r.status, 400, 'Complete refused with no pick');
  ok(/customer follow-up/i.test(r.body.error || ''), 'and says why');
  r = await call('POST', '/api/invoices/' + id + '/waiting', { promised_date: '2099-01-01', note: 'x' });
  eq(r.status, 400, 'Waiting for Payment refused with no pick too');
  r = await call('PUT', '/api/invoices/' + id + '/review-request', { review_send_via: 'none', followup_kind: 'google' });
  eq(r.status, 400, 'Google with no Text/Email is not a pick');
  r = await call('PUT', '/api/invoices/' + id + '/review-request', { review_send_via: 'sms', review_send_to: '4075550111' });
  eq(r.status, 400, 'Text with no Google/survey is not a pick');
  r = await call('PUT', '/api/invoices/' + id + '/review-request', { review_send_via: 'sms', review_send_to: '4075550111', followup_kind: 'none' });
  eq(r.status, 200, 'No survey saves');
  row = await rowOf(id);
  ok(row.followup_kind === 'none' && row.review_send_via === 'none' && !row.review_send_to, 'No survey clears the destination');
  r = await finish(id);
  eq(r.status, 200, 'Complete allowed once No survey is picked');
  row = await settle(id);
  eq(TEXTS.length + MAILS.length, 0, 'nothing sent');
  eq(row.review_send_status, null, 'no send attempted');
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'none', followup_kind: 'none' });
  eq(r.status, 400, 'Send now with No survey refused');
  // Save-as-Completed in one go (the editor's Save with status Paid).
  r = await call('POST', '/api/invoices', rawInv({ status: 'paid', pay_method: 'card' }));
  eq(r.status, 400, 'create-as-Completed with no pick refused');
  ok(r.body.followup_required === true, 'flagged as the follow-up gate');
  r = await call('POST', '/api/invoices', rawInv());
  var _pid = r.body.id;
  r = await call('PUT', '/api/invoices/' + _pid, rawInv({ status: 'paid', review_send_via: 'none' }));
  eq(r.status, 400, 'save-as-Completed with no pick refused');
  r = await call('PUT', '/api/invoices/' + _pid, rawInv({ status: 'paid', review_send_via: 'none', followup_kind: 'none' }));
  eq(r.status, 200, 'save-as-Completed with No survey goes through');
  // Do not contact: no pick is asked for.
  r = await call('POST', '/api/invoices', rawInv({ account_id: ACC_NONE, account_name: 'Ross Dress For Less' }));
  r = await call('GET', '/api/invoices/' + r.body.id);
  ok(!(r.body.gates || []).some(function (g) { return g.key === 'followup'; }), 'Do not contact account: no follow-up gate');
  r = await call('POST', '/api/invoices', rawInv({ pay_type: 'Motor Club' }));
  r = await call('GET', '/api/invoices/' + r.body.id);
  ok(!(r.body.gates || []).some(function (g) { return g.key === 'followup'; }), 'billed pay type: no follow-up gate');
  r = await call('POST', '/api/invoices', rawInv({ account_id: ACC_SURVEY, account_name: 'Lake Mary HOA' }));
  r = await call('GET', '/api/invoices/' + r.body.id);
  ok((r.body.gates || []).some(function (g) { return g.key === 'followup' && !g.ok; }), 'Survey-only account: the pick is required');
  r = await call('GET', '/api/invoices/accounts');
  ok(r.body.some(function (a) { return a.id === ACC_SURVEY && a.customer_contact === 'survey'; }), 'accounts list carries customer_contact');
  r = await call('GET', '/api/invoices/config');
  ok(Array.isArray(r.body.followup_reasons) && r.body.followup_reasons.length === 5, 'config ships the 5 survey reasons');
  ok(r.body.followup_reasons.every(function (x) { return !/(happy|bad|unhappy|complain|angry|rating|star)/i.test(x.label); }), 'no reason is about how the job went');

  console.log('\n2. Review links');
  CURRENT_USER = admin;
  r = await call('PUT', '/api/invoices/review-links', { links: { ORL: 'http://g.page/x' } });
  eq(r.status, 400, 'http refused');
  r = await call('PUT', '/api/invoices/review-links', { links: { orl: 'https://g.page/r/ORLxyz/review', __default: 'https://g.page/r/DEF/review' } });
  eq(r.status, 200, 'saved');

  console.log('\n3. Retail walk-in, Google by text: one link, honest wording');
  CURRENT_USER = tech;
  r = await call('POST', '/api/invoices', inv({ review_send_via: 'sms', review_send_to: '(407) 555-0101' }));
  id = r.body.id;
  r = await call('GET', '/api/invoices/' + id);
  eq(r.body.followup_preview && r.body.followup_preview.mode, 'google', 'GET preview says Google');
  await finish(id);
  row = await settle(id);
  eq(row.review_send_status, 'sent', 'sent');
  eq(row.followup_mode, 'google', 'mode google recorded');
  t = lastText();
  eq(t.to, '+14075550101', 'to the chosen number');
  var TOKEN = tokenIn(t.body);
  ok(TOKEN && TOKEN === row.customer_link_token, 'the one link is the invoice page');
  eq((t.body.match(/https?:\/\//g) || []).length, 1, 'exactly one link in the text');
  ok(t.body.indexOf('g.page') === -1, 'no raw Google link in the text (the page counts the tap)');
  ok(/honest feedback on Google/.test(t.body), 'asks for honest feedback');
  ok(!/\b(5|five)\b|star/i.test(t.body.replace(/https?:\S+/g, '').replace(/#\d+/g, '')), 'no stars');
  ok(/^Hi Maria,/.test(t.body) && /Reply STOP/.test(t.body), 'greeting + opt-out');
  eq(notifyDetail('Customer follow-up'), 'Google review request, sent by text to (407) 555-0101', 'finish email row says what went out');
  var GOOGLE_ID = id;

  console.log('\n4. Customer page: Google mode');
  r = await call('GET', '/i/' + TOKEN);
  eq(r.status, 200, 'page opens');
  ok(/text\/html/.test(r.headers['content-type']), 'HTML');
  ok(r.text.indexOf('Leave a Google review') !== -1, 'Google button');
  ok(r.text.indexOf('id="survey"') === -1, 'no survey on a Google page');
  ok(r.text.indexOf('/pdf"') !== -1 && r.text.indexOf('/pdf?dl=1"') !== -1, 'View + Download');
  ok(r.text.indexOf('Email copy') !== -1 && r.text.indexOf('share-btn') !== -1, 'Email copy + Share');
  ok(r.text.indexOf('Invoice #') !== -1 && r.text.indexOf('$85.00') !== -1 && /Paid/.test(r.text), 'number, total, Paid');
  ok(r.text.indexOf('Mike Y.') !== -1 && r.text.indexOf('Yonkman') === -1, 'locksmith shown as first name + initial');
  ok(r.text.indexOf('tel:4075550100') !== -1, 'call link');
  ok(/noindex/.test(r.headers['x-robots-tag'] || ''), 'noindex');
  r = await call('GET', '/i/' + TOKEN + '/pdf');
  eq(r.buf.slice(0, 4).toString(), '%PDF', 'PDF opens');
  ok(/^inline/.test(r.headers['content-disposition']), 'inline view');
  r = await call('GET', '/i/' + TOKEN + '/pdf?dl=1');
  ok(/^attachment/.test(r.headers['content-disposition']), 'download is an attachment');
  r = await call('GET', '/i/' + TOKEN + '/google');
  eq(r.status, 302, 'Google redirect');
  eq(r.headers.location, 'https://g.page/r/ORLxyz/review', 'to the city link');
  var ev = (await pool.query('SELECT kind FROM invoice_link_events WHERE invoice_id = $1 ORDER BY id', [GOOGLE_ID])).rows.map(function (x) { return x.kind; });
  ok(ev.indexOf('page_open') !== -1 && ev.indexOf('google_click') !== -1 && ev.indexOf('pdf') !== -1, 'events counted: ' + ev.join(','));
  r = await call('GET', '/i/' + TOKEN.slice(0, -2) + 'zz');
  eq(r.status, 404, 'wrong token 404');

  console.log('\n5. Email me a copy');
  var before = MAILS.length;
  r = await call('POST', '/i/' + TOKEN + '/email-copy', { email: 'nope' });
  eq(r.status, 400, 'bad address refused');
  for (var k = 0; k < 3; k++) { r = await call('POST', '/i/' + TOKEN + '/email-copy', { email: 'boss@work.com' }); eq(r.status, 200, 'copy ' + (k + 1) + ' sent'); }
  eq(MAILS.length, before + 3, 'three emails');
  ok(MAILS[MAILS.length - 1].att[0].content_type === 'application/pdf', 'PDF attached');
  r = await call('POST', '/i/' + TOKEN + '/email-copy', { email: 'boss@work.com' });
  eq(r.status, 429, 'fourth in a day refused');

  console.log('\n6. Retail, survey by the locksmith (reason given)');
  r = await call('POST', '/api/invoices', inv({ review_send_via: 'sms', review_send_to: '407-555-0202', followup_kind: 'survey', followup_reason: 'no_google' }));
  id = r.body.id;
  await finish(id);
  row = await settle(id);
  eq(row.followup_mode, 'survey', 'survey sent');
  eq(row.followup_auto, null, 'not automatic');
  t = lastText();
  ok(/30-second survey/.test(t.body) && t.body.indexOf('Google') === -1, 'text invites the survey, no Google');
  ok(/Reason: Customer does not use Google \(picked by Mike Yonkman\)/.test(notifyDetail('Customer follow-up') || ''), 'finish email names the reason and who picked it: ' + notifyDetail('Customer follow-up'));
  var STOK = row.customer_link_token;
  r = await call('GET', '/i/' + STOK);
  ok(r.text.indexOf('id="survey"') !== -1 && r.text.indexOf('Leave a Google review') === -1, 'survey page, no Google link');
  ok(r.text.indexOf('/pdf"') !== -1, 'invoice buttons still there');
  r = await call('GET', '/i/' + STOK + '/google');
  eq(r.headers.location, '/i/' + STOK, 'Google route refuses to invent a link on a survey page');
  r = await call('POST', '/i/' + STOK + '/survey', {});
  eq(r.status, 400, 'overall is required');
  r = await call('POST', '/i/' + STOK + '/survey', { overall: 4, arrived: 'yes', price_explained: 'no', professional: 'yes', comment: 'Did not know about the key blank charge.', call_me: true });
  eq(r.status, 200, 'flagged survey accepted');
  var fb = (await pool.query("SELECT * FROM customer_feedback WHERE source = 'invoice_survey' AND external_ref = $1", ['invoice-' + id])).rows[0];
  ok(fb, 'filed in Customer Feedback');
  eq(fb && fb.category, 'complaint', 'as a complaint');
  eq(fb && fb.tech_user_id, TECH, 'tied to the locksmith');
  eq(fb && fb.city_code, 'ORL', 'and the city');
  eq(fb && fb.invoice_ref, String(row.invoice_number), 'and the invoice');
  ok(fb && /Was the price explained before work started\? No/.test(fb.incident_text), 'answers in the record');
  var task = fb && fb.task_id ? (await pool.query('SELECT * FROM tasks WHERE id = $1', [fb.task_id])).rows[0] : null;
  ok(task && task.assigned_to === MGR, 'task for the Orlando manager');
  ok(task && /^Call back: /.test(task.title) && task.due_date, 'call-back task with a due date');
  if (task) { var dd = new Date(task.due_date); ok(dd.getDay() !== 0 && dd.getDay() !== 6, 'due on a business day'); }
  r = await call('POST', '/i/' + STOK + '/survey', { overall: 1 });
  eq(r.body.already, true, 'second submit is a no-op');
  eq((await pool.query("SELECT COUNT(*)::int n FROM customer_feedback WHERE external_ref = $1", ['invoice-' + id])).rows[0].n, 1, 'still one feedback row');
  r = await call('GET', '/i/' + STOK);
  ok(r.text.indexOf('Thank you.') !== -1 && r.text.indexOf('sv-send') === -1, 'page shows thanks after submit');

  console.log('\n7. Positive survey: quiet praise, no task');
  r = await call('POST', '/api/invoices', inv({ review_send_via: 'email', review_send_to: 'happy@example.com', followup_kind: 'survey', followup_reason: 'asked_not' }));
  id = r.body.id;
  before = MAILS.length;
  await finish(id);
  row = await settle(id);
  eq(MAILS.length, before + 1, 'survey email');
  var m = MAILS[MAILS.length - 1];
  ok(m.att.length === 1 && /Take the survey/.test(m.html) && /View invoice online/.test(m.html) && m.html.indexOf('Google') === -1, 'email: PDF, invoice link, survey button, no Google');
  r = await call('POST', '/i/' + row.customer_link_token + '/survey', { overall: 5, arrived: 'yes', price_explained: 'yes', professional: 'yes', call_me: false });
  fb = (await pool.query("SELECT * FROM customer_feedback WHERE external_ref = $1", ['invoice-' + id])).rows[0];
  ok(fb && fb.category === 'praise' && fb.status === 'resolved' && fb.is_resolved === true && !fb.task_id, 'praise, resolved, no task');

  console.log('\n8. Survey with no reason');
  r = await call('POST', '/api/invoices', inv({ followup_kind: 'survey' }));
  id = r.body.id;
  r = await call('PUT', '/api/invoices/' + id + '/review-request', { review_send_via: 'sms', review_send_to: '4075550303', followup_kind: 'survey' });
  eq(r.status, 400, 'strict save needs a reason');
  r = await call('PUT', '/api/invoices/' + id + '/review-request', { review_send_via: 'sms', review_send_to: '4075550303', followup_kind: 'survey', followup_reason: 'made_up' });
  eq(r.status, 400, 'a reason not on the list is no reason');
  r = await call('PUT', '/api/invoices/' + id, inv({ review_send_via: 'sms', review_send_to: '4075550303', followup_kind: 'survey' }));
  await finish(id);
  row = await settle(id);
  eq(row.followup_mode, 'survey', 'editor-saved survey without a reason still goes out');
  ok(/No reason given/.test(notifyDetail('Customer follow-up') || ''), 'and the email says No reason given');

  console.log('\n9. Account rules');
  r = await call('POST', '/api/invoices', inv({ account_id: ACC_NONE, account_name: 'Ross', review_send_via: 'sms', review_send_to: '4075550404' }));
  id = r.body.id;
  r = await call('GET', '/api/invoices/' + id);
  eq(r.body.followup_preview.send, false, 'preview: Do not contact');
  before = TEXTS.length;
  await finish(id, 'Account / Invoice');
  row = await settle(id);
  eq(row.review_send_status, 'skipped', 'Do not contact account: skipped');
  ok(/Do not contact/.test(row.review_send_detail || ''), 'reason recorded');
  eq(TEXTS.length, before, 'no text');
  ok(/Not sent: Account is set to Do not contact/.test(notifyDetail('Customer follow-up') || ''), 'finish email says why');
  r = await call('POST', '/api/invoices', inv({ account_id: ACC_NEW, account_name: 'New' }));
  id = r.body.id;
  await finish(id, 'Visa');
  await wait(100);
  ok(/Do not contact/.test(notifyDetail('Customer follow-up') || ''), 'Don\'t send on a Do-not-contact account still reports the account reason');

  r = await call('POST', '/api/invoices', inv({ account_id: ACC_SURVEY, account_name: 'HOA', review_send_via: 'sms', review_send_to: '4075550505' }));
  id = r.body.id;
  await finish(id, 'Account / Invoice');
  row = await settle(id);
  eq(row.followup_mode, 'survey_only', 'Survey only account');
  t = lastText();
  ok(/out today/.test(t.body) && t.body.indexOf('invoice') === -1, 'text: no invoice mentioned');
  var OTOK = row.customer_link_token;
  r = await call('GET', '/i/' + OTOK);
  ok(r.text.indexOf('id="survey"') !== -1 && r.text.indexOf('/pdf"') === -1 && r.text.indexOf('$85.00') === -1, 'survey only: no invoice buttons or total');
  r = await call('GET', '/i/' + OTOK + '/pdf');
  eq(r.status, 409, 'PDF refused for survey only');
  r = await call('POST', '/i/' + OTOK + '/email-copy', { email: 'x@y.com' });
  eq(r.status, 409, 'email copy refused for survey only');
  r = await call('POST', '/i/' + OTOK + '/survey', { overall: 2 });
  eq(r.status, 200, 'survey works');
  r = await call('POST', '/api/invoices', inv({ account_id: ACC_SURVEY, account_name: 'HOA', review_send_via: 'email', review_send_to: 'hoa@example.com' }));
  id = r.body.id;
  await finish(id, 'Account / Invoice');
  row = await settle(id);
  m = MAILS[MAILS.length - 1];
  ok(m.att.length === 0 && /How did we do today/.test(m.subject) && m.html.indexOf('View invoice online') === -1, 'survey-only email: no attachment, no invoice link');

  r = await call('POST', '/api/invoices', inv({ account_id: ACC_RETAIL, account_name: 'OPM', review_send_via: 'sms', review_send_to: '4075550606' }));
  id = r.body.id;
  await finish(id, 'Visa');
  row = await settle(id);
  eq(row.followup_mode, 'google', 'Retail rules account: Google');

  r = await call('POST', '/api/invoices', inv({ pay_type: 'Motor Club', review_send_via: 'sms', review_send_to: '4075550707' }));
  id = r.body.id;
  await finish(id, 'Motor Club');
  row = await settle(id);
  eq(row.review_send_status, 'skipped', 'no account but billed pay type: skipped');

  console.log('\n10. Automatic surveys');
  r = await call('POST', '/api/invoices', inv({ account_type: 'commercial', review_send_via: 'sms', review_send_to: '4075550808' }));
  id = r.body.id;
  await finish(id);
  row = await settle(id);
  eq(row.followup_mode, 'survey', 'commercial job: survey');
  eq(row.followup_auto, 'commercial', 'marked automatic');
  ok(/automatic: Commercial job/.test(notifyDetail('Customer follow-up') || ''), 'email says automatic');
  r = await call('POST', '/api/invoices', inv({ phone: '(407) 555-0101', review_send_via: 'sms', review_send_to: '4075550101' }));
  id = r.body.id;
  await finish(id);
  row = await settle(id);
  eq(row.followup_auto, 'repeat', 'same customer asked for Google within a year: automatic survey');
  await pool.query("INSERT INTO settings (key, value) VALUES ('followup_repeat_days','0')");
  r = await call('POST', '/api/invoices', inv({ phone: '(407) 555-0101', review_send_via: 'sms', review_send_to: '4075550101' }));
  id = r.body.id;
  await finish(id);
  row = await settle(id);
  eq(row.followup_mode, 'google', 'repeat window 0 turns the rule off');
  await pool.query("DELETE FROM settings WHERE key = 'followup_repeat_days'");

  console.log('\n11. Once only, reopen, Send now / again, access');
  before = TEXTS.length;
  await notifyInvoiceFinished(GOOGLE_ID, tech); await wait(150);
  eq(TEXTS.length, before, 'second finish does not re-text');
  CURRENT_USER = admin;
  r = await call('POST', '/api/invoices/' + GOOGLE_ID + '/reopen', {});
  await finish(GOOGLE_ID); await wait(200);
  eq(TEXTS.length, before, 'reopen + complete does not re-text');
  CURRENT_USER = tech;
  r = await call('POST', '/api/invoices', inv());
  id = r.body.id;
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'sms', review_send_to: '4075550909', followup_kind: 'google' });
  eq(r.status, 409, 'Send now on a draft refused');
  await finish(id);
  CURRENT_USER = tech2;
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'sms', review_send_to: '4075550909' });
  eq(r.status, 403, 'another tech cannot send');
  CURRENT_USER = tech;
  TWILIO_FAIL = true;
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'sms', review_send_to: '4075550909', followup_kind: 'google' });
  eq(r.status, 502, 'Twilio failure surfaces');
  TWILIO_FAIL = false;
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'sms', review_send_to: '4075550909', followup_kind: 'survey', followup_reason: 'return_visit' });
  eq(r.status, 200, 'retry after failure sends (as a survey this time)');
  eq((await rowOf(id)).followup_mode, 'survey', 'mode follows the new pick');
  r = await call('POST', '/api/invoices/' + id + '/review-request/send', { review_send_via: 'sms', review_send_to: '4075550909', followup_kind: 'google' });
  eq(r.status, 429, 'double tap throttled');

  console.log('\n12. Concurrent finish callers send once');
  r = await call('POST', '/api/invoices', inv({ review_send_via: 'sms', review_send_to: '4075551010' }));
  id = r.body.id;
  await pool.query("UPDATE invoices SET status = 'paid' WHERE id = $1", [id]);
  before = TEXTS.length;
  await Promise.all([fu.sendOnFinish(id, tech), fu.sendOnFinish(id, tech), fu.sendOnFinish(id, tech)]);
  eq(TEXTS.length, before + 1, 'one text');

  console.log('\n13. Vendors customer_contact');
  CURRENT_USER = admin;
  r = await call('PUT', '/api/vendors/' + ACC_NEW, { name: 'Brand New Account', customer_contact: 'survey' });
  eq((await pool.query('SELECT customer_contact FROM vendors WHERE id = $1', [ACC_NEW])).rows[0].customer_contact, 'survey', 'saved (' + r.status + ' ' + JSON.stringify(r.body).slice(0, 80) + ')');
  r = await call('PUT', '/api/vendors/' + ACC_NEW, { name: 'Brand New Account', customer_contact: 'everyone!' });
  eq((await pool.query('SELECT customer_contact FROM vendors WHERE id = $1', [ACC_NEW])).rows[0].customer_contact, 'none', 'nonsense is stored as none');
  await pool.query("UPDATE vendors SET customer_contact = 'retail' WHERE id = $1", [ACC_NEW]);
  r = await call('PUT', '/api/vendors/' + ACC_NEW, { name: 'Brand New Account' });
  eq((await pool.query('SELECT customer_contact FROM vendors WHERE id = $1', [ACC_NEW])).rows[0].customer_contact, 'retail', 'a save without the key leaves it alone');

  console.log('\n14. Report');
  // Chris (TPA) sends mostly surveys; enough of his own choices to be judged.
  await pool.query("INSERT INTO settings (key, value) VALUES ('followup_flag_min','3'), ('followup_flag_points','15')");
  CURRENT_USER = tech2;
  for (var j = 0; j < 4; j++) {
    r = await call('POST', '/api/invoices', inv({ city_code: 'TPA', review_send_via: 'sms', review_send_to: '81355510' + (10 + j), followup_kind: j === 0 ? 'google' : 'survey', followup_reason: 'no_google' }));
    await finish(r.body.id);
    await settle(r.body.id);
  }
  CURRENT_USER = admin;
  r = await call('GET', '/api/followups/report');
  eq(r.status, 200, 'report loads');
  var c = r.body.company;
  var exp = (await pool.query(
    "SELECT COUNT(*) FILTER (WHERE followup_mode='google')::int g, COUNT(*) FILTER (WHERE followup_mode='survey' AND followup_auto IS NULL)::int st, " +
    "COUNT(*) FILTER (WHERE followup_mode='survey' AND followup_auto IS NOT NULL)::int sa, COUNT(*) FILTER (WHERE followup_mode='survey_only')::int so, COUNT(*)::int n " +
    "FROM invoices WHERE review_send_status='sent'")).rows[0];
  eq(c.sent, exp.n, 'sent count matches the database');
  eq(c.google, exp.g, 'Google count');
  eq(c.survey_tech, exp.st, 'locksmith surveys');
  eq(c.survey_auto, exp.sa, 'automatic surveys kept separate');
  eq(c.survey_only, exp.so, 'survey-only kept separate');
  eq(c.google_pct, Math.round(exp.g / (exp.g + exp.st) * 1000) / 10, 'Google % = google / (google + locksmith surveys)');
  ok(c.google_clicks >= 1 && c.opened >= 3, 'opens and Google taps counted');
  ok(c.surveys_done >= 3, 'completed surveys counted');
  eq(c.reviews_est, null, 'no review feed configured: estimate is null, not zero');
  var suncoast = r.body.areas.filter(function (a) { return a.area === 'Suncoast'; })[0];
  ok(suncoast && suncoast.sent === 4, 'Tampa reported inside Suncoast');
  var chris = r.body.locksmiths.filter(function (x) { return x.locksmith === 'Chris Patel'; })[0];
  var mike = r.body.locksmiths.filter(function (x) { return x.locksmith === 'Mike Yonkman'; })[0];
  eq(chris && chris.google_pct, 25, 'Chris 1 of 4');
  eq(chris && chris.flag, true, 'Chris flagged (company ' + c.google_pct + '%, flag at 15 points below)');
  eq(mike && mike.flag, false, 'Mike not flagged');
  ok(chris && chris.reasons[0] && chris.reasons[0].label === 'Customer does not use Google' && chris.reasons[0].count === 3, 'reasons labelled and counted');
  eq(r.body.weeks.length, 12, '12 weekly points');
  eq(r.body.weeks[11].google + r.body.weeks[11].survey_tech, exp.g + exp.st, 'this week holds every choice');
  CURRENT_USER = { id: MGR, name: 'Orlando Manager', role: 'manager' };
  await pool.query("INSERT INTO user_cities (user_id, city_code) VALUES ($1, 'ORL')", [MGR]);
  r = await call('GET', '/api/followups/report');
  ok(r.body.areas.length > 0 && r.body.areas.every(function (a) { return a.area === 'Orlando'; }), 'a manager sees only their cities');

  console.log('\n15. Nothing on the printed or emailed invoice');
  var pdfSrc = require('fs').readFileSync('./utils/invoicePdf.js', 'utf8');
  ok(!/review_send|followup|customer_link/.test(pdfSrc), 'PDF builder never reads follow-up fields');
  var appSrc = require('fs').readFileSync('./public/js/app.js', 'utf8');
  var pStart = appSrc.indexOf('async function printInvoice(');
  var pBody = appSrc.slice(pStart, appSrc.indexOf('\n}\n', pStart));
  ok(pStart > 0 && !/review|followup/i.test(pBody), 'printInvoice never mentions the follow-up');

  srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await pool.end();
  process.exit(fail ? 1 : 0);
}
run().catch(function (e) { console.error(e); process.exit(1); });
