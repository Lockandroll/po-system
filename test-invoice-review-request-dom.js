'use strict';
// jsdom check of the Customer Follow-Up UI (public/js/app.js slice), the report
// screen (public/js/followups.js) and the customer page script
// (public/js/customerPage.js). Plan: claude/nova-customer-follow-up-plan.md.
var fs = require('fs');
var { JSDOM } = require('jsdom');
var src = fs.readFileSync(__dirname + '/public/js/app.js', 'utf8');
var a = src.indexOf('// Customer Follow-Up (Tony, 2026-10-11). Server: utils/invoiceReviewRequest.js,');
var b = src.indexOf('async function saveInvSetupReviewLinks()');
b = src.indexOf('\n}\n', b) + 3;
var slice = src.slice(a, b);
var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  FAIL: ' + m); } }

var dom = new JSDOM('<!doctype html><body><div id="c"></div><div id="content"></div></body>', { runScripts: 'outside-only' });
var w = dom.window;
w.eval('var state={currentView:"view-invoice"}; var CALLS=[]; var _invoiceAccounts=[]; function escHtml(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
  'function formatDate(d){return "Oct 11, 2026";} function can(){return true;} var API_REPLY={}; async function api(m,p,b){CALLS.push([m,p,b]); return API_REPLY;} function showToast(){} function render(){CALLS.push(["render"]);} function apiBustCache(){} function novaAlert(){} function invSetupCapture(){}\n' + slice);
w.eval(fs.readFileSync(__dirname + '/public/js/followups.js', 'utf8'));
var d = w.document;
var c = d.getElementById('c');
var REASONS = [{ key: 'commercial', label: 'Commercial job' }, { key: 'repeat', label: 'Repeat customer' }, { key: 'asked_not', label: 'Customer asked not to be asked for reviews' }, { key: 'return_visit', label: 'Return visit needed to finish the job' }, { key: 'no_google', label: 'Customer does not use Google' }];
w._invFollowupReasons = REASONS;
w.eval('_invFollowupReasons = ' + JSON.stringify(REASONS) + '; _invReviewLinkCities = ["ORL"]; _invoiceAccounts = [{id:7,customer_contact:"none"},{id:8,customer_contact:"survey"},{id:9,customer_contact:"retail"}];');

function editor(extra) {
  c.innerHTML = '<select id="inv-account"><option value=""></option><option value="7">Ross</option><option value="8">HOA</option><option value="9">OPM</option></select>' +
    '<select id="inv-pay"><option>Visa</option><option>Motor Club</option></select><select id="inv-city-code"><option>ORL</option><option>JAX</option></select>' +
    '<select id="inv-account-type"><option value=""></option><option value="commercial">Commercial</option></select>' +
    '<input id="inv-phone" value="(407) 555-0101"><input id="inv-email" value="m@x.com">' + w.invReviewEditCardHtml(extra || {});
  w.invReviewInit();
}
function fire(id, type) { d.getElementById(id).dispatchEvent(new w.Event(type || 'change')); }
function vis(id) { var e = d.getElementById(id); return !!e && e.style.display !== 'none'; }
function note() { return d.getElementById('inv-review-note').textContent; }

// --- editor ---
function kindBtnOn(p, k) { return (d.getElementById(p + '-fu-' + k).getAttribute('style') || '').indexOf('var(--primary)') !== -1; }
editor();
ok(d.getElementById('inv-fu-kind').value === '', 'nothing pre-selected');
ok(!kindBtnOn('inv', 'google') && !kindBtnOn('inv', 'survey') && !kindBtnOn('inv', 'none'), 'no button lit');
ok(vis('inv-fu-seg-wrap') && vis('inv-fu-none'), 'three-way choice shown, with No survey');
ok(!vis('inv-fu-row') && !vis('inv-fu-reason-wrap'), 'send-by row hidden until Google or survey is picked');
ok(/Pick one before this invoice can be completed/.test(note()), 'note says a pick is required');
ok(/Pick Google review, Feedback survey or No survey/i.test(w.fuCheck('inv', true)), 'finishing with no pick is blocked');
ok(w.fuCheck('inv', false) === '', 'a plain draft save with no pick is fine');
ok(c.innerHTML.indexOf('Customer Follow-Up') !== -1, 'card is titled Customer Follow-Up');
ok(Array.prototype.map.call(d.getElementById('inv-review-via').options, function (o) { return o.value; }).join() === 'sms,email', 'Send by has no Don&#39;t send option');
w.fuSetKind('inv', 'google');
ok(kindBtnOn('inv', 'google') && vis('inv-fu-row'), 'Google picked: send-by row shows');
ok(d.getElementById('inv-review-to').value === '(407) 555-0101', 'Text prefills the phone');
ok(!vis('inv-fu-reason-wrap'), 'no reason box for Google');
ok(/Sends automatically/.test(note()), 'Google ready');
ok(w.fuCheck('inv', true) === '', 'Google + number passes');
var fv = w.fuValues('inv');
ok(fv.kind === 'google' && fv.via === 'sms' && fv.to === '(407) 555-0101', 'values: ' + JSON.stringify(fv));
w.fuSetKind('inv', 'survey');
ok(vis('inv-fu-reason-wrap'), 'survey shows the reason box');
var opts = Array.prototype.map.call(d.getElementById('inv-fu-reason').options, function (o) { return o.textContent; });
ok(opts.length === 6 && opts[0] === 'Choose a reason' && opts.indexOf('Customer does not use Google') !== -1, 'reasons listed: ' + opts.join('|'));
ok(/Pick why the survey/.test(note()), 'warns until a reason is picked');
ok(/pick why the survey/.test(w.fuCheck('inv', true)), 'survey with no reason blocked');
d.getElementById('inv-fu-reason').value = 'no_google'; w.fuRefresh('inv'); // the inline onchange (jsdom outside-only does not run inline handlers)
ok(/Sends automatically/.test(note()), 'ready once a reason is picked');
w.fuSetKind('inv', 'none');
ok(kindBtnOn('inv', 'none') && !vis('inv-fu-row') && !vis('inv-fu-reason-wrap'), 'No survey: nothing else to fill in');
ok(/Nothing will be sent/.test(note()), 'No survey note');
fv = w.fuValues('inv');
ok(fv.kind === 'none' && fv.via === 'none' && fv.to === '' && w.fuCheck('inv', true) === '', 'No survey posts via none and passes');
w.fuSetKind('inv', 'google');
d.getElementById('inv-review-to').value = '407'; ok(/10-digit/.test(w.fuCheck('inv', true)), 'bad number caught');
d.getElementById('inv-review-to').value = '(407) 555-0101';
d.getElementById('inv-city-code').value = 'JAX'; fire('inv-city-code');
ok(/No Google review link is set/.test(note()), 'warns when the city has no Google link');
d.getElementById('inv-city-code').value = 'ORL'; fire('inv-city-code');
d.getElementById('inv-account-type').value = 'commercial'; fire('inv-account-type');
ok(!vis('inv-fu-google') && vis('inv-fu-survey') && vis('inv-fu-none'), 'commercial: Google hidden, Survey / No survey left');
ok(d.getElementById('inv-fu-kind').value === 'survey' && /Commercial job/.test(note()), 'commercial: a Google pick shows as the survey');
ok(w.fuCheck('inv', true) === '', 'commercial survey needs no reason');
d.getElementById('inv-account-type').value = ''; fire('inv-account-type');
ok(vis('inv-fu-google'), 'Google back off commercial');
d.getElementById('inv-account').value = '7'; fire('inv-account');
ok(!vis('inv-review-card'), 'Do not contact account: whole card hidden');
d.getElementById('inv-account').value = '8'; fire('inv-account');
ok(vis('inv-review-card') && !vis('inv-fu-google') && vis('inv-fu-none') && /Survey only/.test(note()), 'Survey only account: Survey or No survey, says so');
d.getElementById('inv-account').value = '9'; fire('inv-account');
ok(vis('inv-fu-google'), 'Retail rules account: Google back');
d.getElementById('inv-account').value = ''; d.getElementById('inv-pay').value = 'Motor Club'; fire('inv-pay');
ok(!vis('inv-review-card'), 'no account + billed pay type: hidden');
d.getElementById('inv-pay').value = 'Visa'; fire('inv-pay');
// draft restore path
d.getElementById('inv-fu-kind').value = 'survey'; w.invReviewViaChange();
ok(vis('inv-fu-reason-wrap') && kindBtnOn('inv', 'survey'), 'restored survey choice redraws the buttons');
d.getElementById('inv-fu-kind').value = ''; w.invReviewViaChange();
ok(!kindBtnOn('inv', 'google') && !vis('inv-fu-row'), 'restored empty pick stays empty');
// a saved invoice with a sent status
editor({ review_send_via: 'sms', review_send_to: '+14075550101', followup_kind: 'survey', followup_reason: 'repeat', review_send_status: 'sent', review_sent_via: 'sms', review_sent_to: '+14075550101', followup_mode: 'survey', review_sent_at: '2026-10-11' });
ok(kindBtnOn('inv', 'survey'), 'stored survey pick lit');
ok(d.getElementById('inv-review-to').value === '(407) 555-0101', 'stored number shown formatted');
ok(d.getElementById('inv-fu-reason').value === 'repeat', 'stored reason selected');
ok(/Survey sent by text to \(407\) 555-0101/.test(c.textContent), 'sent line');
// an old row: the former 'google' default with Don't send is NOT a pick
editor({ review_send_via: 'none', followup_kind: 'google' });
ok(d.getElementById('inv-fu-kind').value === '' && !kindBtnOn('inv', 'google'), 'old default (google + Don&#39;t send) shows as not picked');
editor({ review_send_via: 'none', followup_kind: 'none' });
ok(kindBtnOn('inv', 'none'), 'stored No survey lit');

// --- invoice page card ---
var base = { id: 7, status: 'draft', pay_type: 'Visa', phone: '4075550101', email: 'm@x.com', city_code: 'ORL', review_link_ready: true, review_send_via: 'none', followup_kind: null, followup_reasons: REASONS, followup_preview: { send: true, mode: 'google', rule: 'retail' } };
c.innerHTML = w.invReviewViewCardHtml(base, true); w.fuRefresh('invv');
ok(d.getElementById('invv-review-btn').textContent === 'Save choice', 'draft: Save choice');
ok(d.getElementById('invv-fu-kind').value === '', 'view: nothing pre-selected');
c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { status: 'paid' }), true);
ok(d.getElementById('invv-review-btn').textContent === 'Send now', 'completed: Send now');
c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { status: 'paid', review_send_via: 'sms', review_send_to: '+14075550101', followup_kind: 'google', review_send_status: 'sent', followup_mode: 'google', review_sent_via: 'sms', review_sent_to: '+14075550101' }), true);
ok(d.getElementById('invv-review-btn').textContent === 'Send again' && /Google review request sent by text to \(407\) 555-0101/.test(c.textContent), 'sent: Send again + line');
ok(w.invReviewViewCardHtml(Object.assign({}, base, { followup_preview: { send: false, rule: 'none', why: 'Account is set to Do not contact.' } }), true) === '', 'Do not contact, nothing sent: no card');
c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { followup_preview: { send: false, rule: 'none', why: 'Account is set to Do not contact.' }, review_send_status: 'skipped', review_send_detail: 'Account is set to Do not contact.' }), true);
ok(/Not sent: Account is set to Do not contact/.test(c.textContent) && !d.getElementById('invv-review-btn'), 'Do not contact with a record: status only');
c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { followup_kind: 'none' }), false);
ok(/No survey \(locksmith/.test(c.textContent), 'read-only card says No survey');
c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { followup_preview: { send: true, mode: 'survey', rule: 'retail', auto: 'repeat' } }), true); w.fuRefresh('invv');
ok(!vis('invv-fu-google') && vis('invv-fu-none'), 'automatic repeat: Survey or No survey');
w.fuSetKind('invv', 'survey');
ok(/Customer was already asked for a Google review recently/.test(d.getElementById('invv-review-note').textContent), 'explains the repeat rule');

(async function () {
  c.innerHTML = w.invReviewViewCardHtml(base, true); w.fuRefresh('invv');
  await w.invReviewViewSubmit(7, false);
  ok(/Pick Google review, Feedback survey or No survey/i.test(d.getElementById('invv-review-msg').textContent), 'view: Save with no pick blocked');
  w.fuSetKind('invv', 'survey');
  ok(d.getElementById('invv-review-to').value === '4075550101', 'view: picking the survey prefills the phone');
  await w.invReviewViewSubmit(7, false);
  ok(/pick why the survey/.test(d.getElementById('invv-review-msg').textContent), 'survey without reason blocked');
  d.getElementById('invv-fu-reason').value = 'asked_not';
  await w.invReviewViewSubmit(7, false);
  var call = w.eval('CALLS').filter(function (x) { return x[0] === 'PUT'; }).pop();
  ok(call && call[1] === '/invoices/7/review-request' && call[2].followup_kind === 'survey' && call[2].followup_reason === 'asked_not' && call[2].review_send_via === 'sms', 'Save sends kind + reason');
  c.innerHTML = w.invReviewViewCardHtml(base, true); w.fuRefresh('invv');
  w.fuSetKind('invv', 'none');
  await w.invReviewViewSubmit(7, false);
  call = w.eval('CALLS').filter(function (x) { return x[0] === 'PUT'; }).pop();
  ok(call && call[2].followup_kind === 'none' && call[2].review_send_via === 'none', 'Save No survey posts kind none, via none');
  c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { status: 'paid', followup_kind: 'none' }), true); w.fuRefresh('invv');
  var before = w.eval('CALLS').length;
  await w.invReviewViewSubmit(7, true);
  ok(w.eval('CALLS').length === before && /nothing to send/.test(d.getElementById('invv-review-msg').textContent), 'Send now with No survey does not call the server');
  c.innerHTML = w.invReviewViewCardHtml(Object.assign({}, base, { status: 'paid', review_send_via: 'sms', review_send_to: '+14075550101', followup_kind: 'google' }), true); w.fuRefresh('invv');
  await w.invReviewViewSubmit(7, true);
  call = w.eval('CALLS').filter(function (x) { return x[0] === 'POST'; }).pop();
  ok(call && call[1] === '/invoices/7/review-request/send' && call[2].followup_kind === 'google' && call[2].followup_reason === null, 'Send now posts Google');

  // --- Invoice Setup Configure panel ---
  c.innerHTML = w.invSetupContactHtml(3, {});
  ok(d.getElementById('invset-contact-3').value === 'none', 'account with no setting shows Do not contact');
  ok(d.getElementById('invset-contact-3').options.length === 3, 'three choices');
  ok(w.invSetupContactPill(null) === '' && /Retail rules/.test(w.invSetupContactPill('retail')) && /Survey only/.test(w.invSetupContactPill('survey')), 'pills (none for Do not contact)');

  // --- report screen ---
  w.eval('API_REPLY = ' + JSON.stringify({
    from: '2026-07-14', to: '2026-10-11', reviews_feed: false, flag_points: 25, flag_min: 10,
    cities: [{ code: 'ORL', name: 'Orlando' }],
    company: { sent: 20, google: 12, survey_tech: 4, survey_auto: 3, survey_only: 1, google_pct: 75, google_clicks: 6, google_click_pct: 50, reviews_est: null, survey_done_pct: 62.5, surveys_done: 5, survey_sent: 8 },
    areas: [{ area: 'Suncoast', sent: 6, google: 2, survey_tech: 4, survey_auto: 0, survey_only: 0, google_pct: 33.3, google_click_pct: 50, reviews_est: null, survey_done_pct: 50 }],
    locksmiths: [{ locksmith: 'Chris <b>Patel</b>', area: 'Suncoast', google: 2, survey_tech: 4, survey_auto: 0, survey_only: 0, google_pct: 33.3, flag: true, reasons: [{ label: 'Customer does not use Google', count: 4 }] }],
    weeks: [{ start: '2026-10-05', end: '2026-10-11', google: 3, survey_tech: 1, google_pct: 75 }]
  }));
  var content = d.getElementById('content');
  await w.renderFollowupReport(content);
  var tx = content.textContent;
  ok(/Customer Follow-Ups/.test(tx) && /75%/.test(tx) && /Picked Google review/.test(tx), 'report tiles');
  ok(/Review feed not connected/.test(tx), 'says when the review feed is missing');
  ok(/Suncoast/.test(tx) && /33.3%/.test(tx) && /Check/.test(tx), 'city + flagged locksmith rows');
  ok(content.innerHTML.indexOf('<b>Patel</b>') === -1, 'names escaped');
  ok(/Customer does not use Google 4/.test(tx), 'reasons shown');
  d.getElementById('fu-city').value = 'ORL';
  w.fuApplyFilters();
  await new Promise(function (r) { setTimeout(r, 20); });
  var last = w.eval('CALLS').filter(function (x) { return x[0] === 'GET'; }).pop();
  ok(last && /city=ORL/.test(last[1]) && /from=2026-07-14/.test(last[1]), 'filters go to the server: ' + (last && last[1]));

  // --- customer page script ---
  var page = new JSDOM('<!doctype html><body data-token="tok123456789012345678901" data-title="Invoice #1">' +
    '<button id="ec-toggle"></button><div class="ec" id="ec"><input id="ec-email"><button id="ec-send"></button><div id="ec-msg"></div></div>' +
    '<button id="share-btn" style="display:none"></button>' +
    '<div class="sec" id="survey"><div class="faces" data-q="overall"><button class="f" data-v="1"></button><button class="f" data-v="4"></button></div>' +
    '<div class="ch" data-q="price_explained"><button class="c" data-v="yes"></button><button class="c" data-v="no"></button></div>' +
    '<div class="ch" data-q="call_me"><button class="c" data-v="yes"></button><button class="c" data-v="no"></button></div>' +
    '<textarea id="sv-comment">hi</textarea><button id="sv-send"></button><div id="sv-msg"></div></div></body>', { runScripts: 'outside-only', url: 'https://www.popalockar.com/i/tok123456789012345678901' });
  var pw = page.window, pd = pw.document;
  var POSTS = [];
  pw.fetch = function (url, o) { POSTS.push({ url: url, body: JSON.parse(o.body) }); return Promise.resolve({ ok: true, json: function () { return Promise.resolve({ ok: true }); } }); };
  pw.eval(fs.readFileSync(__dirname + '/public/js/customerPage.js', 'utf8'));
  ok(pd.getElementById('share-btn').style.display === 'none', 'no share sheet on a computer: Share stays hidden');
  pd.getElementById('ec-toggle').click();
  ok(/ on/.test(pd.getElementById('ec').className), 'Email copy opens the form');
  pd.getElementById('ec-email').value = 'bad'; pd.getElementById('ec-send').click();
  ok(/valid email/.test(pd.getElementById('ec-msg').textContent) && POSTS.length === 0, 'bad address caught before sending');
  pd.getElementById('ec-email').value = 'boss@work.com'; pd.getElementById('ec-send').click();
  await new Promise(function (r) { setTimeout(r, 20); });
  ok(POSTS[0] && POSTS[0].url === '/i/tok123456789012345678901/email-copy' && POSTS[0].body.email === 'boss@work.com', 'email copy posted');
  pd.getElementById('sv-send').click();
  ok(/overall/.test(pd.getElementById('sv-msg').textContent), 'overall required');
  pd.querySelector('[data-q="overall"] [data-v="4"]').click();
  pd.querySelector('[data-q="price_explained"] [data-v="no"]').click();
  pd.querySelector('[data-q="call_me"] [data-v="yes"]').click();
  ok(/ on/.test(pd.querySelector('[data-q="overall"] [data-v="4"]').className), 'choice highlights');
  pd.getElementById('sv-send').click();
  await new Promise(function (r) { setTimeout(r, 20); });
  var sv = POSTS[1];
  ok(sv && sv.url === '/i/tok123456789012345678901/survey' && sv.body.overall === '4' && sv.body.price_explained === 'no' && sv.body.call_me === true && sv.body.comment === 'hi', 'survey posted: ' + JSON.stringify(sv && sv.body));
  ok(/will call you within one business day/.test(pd.getElementById('survey').textContent), 'thank-you mentions the call back');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
