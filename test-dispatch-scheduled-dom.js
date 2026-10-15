'use strict';
/*
 * Scheduled dispatch calls (Tony 2026-10-15) - DOM test. Loads public/js/dispatch.js
 * and public/js/newCall.js into jsdom with api() answering from fixtures, then
 * drives the board (Scheduled list), the call screen (Dispatch now / Reschedule)
 * and New call (When: Now / Schedule for later).
 * Run: node test-dispatch-scheduled-dom.js   (no database needed)
 * No backticks anywhere in this file (Windows corrupts them in .js).
 */
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

var IN2H = new Date(Date.now() + 2 * 86400000);
IN2H.setUTCHours(19, 30, 0, 0);               // 2:30 PM Central (CDT) / 1:30 PM CST
var SCHED = IN2H.toISOString();

var REF = {
  categories: [{ code: 'locksmith', name: 'Locksmith' }],
  service_types: [{ id: 5, code: 'LOCK', name: 'Lockout', category_code: 'locksmith', default_eta_minutes: 30 }],
  tags: [], accounts: [], my_categories: [],
  cities: [{ code: 'ORL', name: 'Orlando', timezone: 'America/New_York' }, { code: 'BHM', name: 'Birmingham', timezone: 'America/Chicago' }],
  me: { id: 1, name: 'Admin', role: 'admin', can_manage: true, can_assign: true, can_create: true },
  geocode_ready: false, customer_link_enabled: false, schedule_lead_minutes: 60, goto_live: false
};
function job(o) {
  return Object.assign({ id: 1, job_number: 'D00001', status: 'new', service_type: 'Lockout', service_type_name: 'Lockout',
    city_code: 'ORL', city_name: 'Orlando', city_tz: 'America/New_York', address: '1 Main St', created_at: new Date().toISOString(),
    priority: 'normal', tags: [], assigned_to: null }, o || {});
}
var BOARD = [
  job({ id: 1, job_number: 'D00001', status: 'new' }),
  job({ id: 2, job_number: 'D00002', status: 'scheduled', city_code: 'BHM', city_name: 'Birmingham', city_tz: 'America/Chicago',
    scheduled_for: SCHED, eta_promised_at: SCHED, eta_source: 'scheduled', address: '9 Oak Ave' })
];

async function main() {
  var dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>',
    { runScripts: 'outside-only', url: 'http://localhost/' });
  var w = dom.window;
  var posts = [];
  w.state = { token: 't', user: { id: 1, role: 'admin' }, currentView: 'dispatch' };
  w.escHtml = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); };
  w.toasts = [];
  w.showToast = function (m, t) { w.toasts.push([m, t]); };
  w.apiBustCache = function () {};
  w.can = function () { return true; };
  w.navigate = function (v, p) { w._nav = [v, p]; };
  w.api = async function (method, p, body) {
    if (method !== 'GET') posts.push([method, p, body]);
    if (p === '/dispatch/reference') return REF;
    if (method === 'GET' && p === '/dispatch/jobs') return { jobs: BOARD, canManage: true, canAssign: true, me: 1, scheduleLeadMinutes: 45 };
    if (p === '/dispatch/duty/all') return { people: [] };
    if (p === '/dispatch/duty') return { ready: true };
    if (p === '/cities') return [];
    if (p === '/dispatch/jobs/2') return { job: BOARD[1], events: [], views: [], canSeeViews: true, canManage: true, scheduleLeadMinutes: 45 };
    if (p === '/dispatch/jobs/1') return { job: BOARD[0], events: [], views: [], canSeeViews: true, canManage: true, scheduleLeadMinutes: 45 };
    if (p.indexOf('/dispatch/quote-preview') === 0) {
      w._lastQuote = p;
      return { city_code: 'BHM', city_from_zip: null, price: 95, eta_minutes: 30,
        scheduled_label: /scheduled_for=/.test(p) ? 'Sat, Oct 17, 2:30 PM' : undefined };
    }
    if (p.indexOf('/dispatch/assignable-preview') === 0) return { people: [{ user_id: 7, name: 'Best Tech', eta_minutes: 9, ready: true }], best_user_id: 7 };
    if (p.indexOf('/dispatch/lookup') === 0) return { open: [], previous: [] };
    if (method === 'POST' && p === '/dispatch/jobs') {
      return Object.assign(job({ id: 9, job_number: 'D00009' }), body.scheduled_for
        ? { status: 'scheduled', scheduled_for: SCHED, city_tz: 'America/Chicago' } : {});
    }
    if (method === 'POST' && /\/schedule$/.test(p)) return Object.assign({}, BOARD[0], { status: 'scheduled', scheduled_for: SCHED });
    if (method === 'POST' && /\/release$/.test(p)) return Object.assign({}, BOARD[1], { status: 'new' });
    return {};
  };
  ['dispatch.js', 'newCall.js'].forEach(function (f) {
    w.eval(fs.readFileSync(path.join(__dirname, 'public', 'js', f), 'utf8'));
  });
  var d = w.document;
  var content = d.getElementById('content');

  // ---- board
  await w.renderDispatch(content);
  await sleep(50);
  var html = content.innerHTML;
  ok(/Scheduled \(1\)/.test(html), 'Scheduled section with one call');
  ok(/Waiting \(1\)/.test(html), 'Waiting does not count the scheduled call');
  ok(/goes live 45 min before/.test(html), 'lead minutes from the board payload');
  var mini = d.querySelector('.disp-minis [data-job="2"]');
  ok(!!mini, 'scheduled call has a clickable card');
  ok(mini && /PM/.test(mini.textContent) && /Birmingham/.test(mini.textContent), 'card shows time and city');
  var cnt = d.querySelector('.disp-counter .n');
  ok(cnt && cnt.textContent === '1', 'Waiting counter = 1 (got ' + (cnt && cnt.textContent) + ')');

  // ---- call screen, scheduled
  w.state.currentView = 'dispatch-call';
  await w.renderDispatchCall(content, 2);
  html = content.innerHTML;
  ok(/Dispatch now/.test(html) && /Reschedule/.test(html), 'Dispatch now + Reschedule on a scheduled call');
  ok(/Scheduled for \(Birmingham time\)/.test(html), 'time labelled in the city clock');
  ok(/Appointment/.test(html), 'Appointment row in Service');
  ok(!/Age of call/.test(html), 'no Age clock on a scheduled call');
  var expectBhm = new Date(SCHED).toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
  ok(html.indexOf(expectBhm) !== -1, 'shows Birmingham wall time ' + expectBhm);

  // Reschedule modal is prefilled in Birmingham time
  w.dispSchedule(2);
  var sd = d.getElementById('ds-sdate'), stt = d.getElementById('ds-stime');
  var parts = w.dispLocalParts(SCHED, 'America/Chicago');
  ok(sd && sd.value === parts.date && stt.value === parts.time, 'reschedule prefilled ' + (sd && sd.value) + ' ' + (stt && stt.value));
  w.dispCloseModal();

  // Dispatch now posts release
  w.dispReleaseNow(2);
  var okBtn = Array.prototype.filter.call(d.querySelectorAll('button'), function (b) { return b.textContent === 'Dispatch now' && b.closest('.modal, [class*=modal], #disp-modal'); })[0] ||
    Array.prototype.filter.call(d.querySelectorAll('button'), function (b) { return b.textContent === 'Dispatch now'; }).pop();
  okBtn.click();
  await sleep(30);
  ok(posts.some(function (p) { return p[1] === '/dispatch/jobs/2/release'; }), 'Dispatch now POSTs release');

  // ---- call screen, live call offers Schedule for later
  await w.renderDispatchCall(content, 1);
  ok(/Schedule for later/.test(content.innerHTML), 'live call offers Schedule for later');

  // ---- New call: When
  await w.renderDispatchNew(content, null);
  ok(!!d.getElementById('nc-when'), 'When card present');
  ok(d.getElementById('nc-sched').hidden, 'date/time hidden on Now');
  w.ncWhen('later');
  ok(!d.getElementById('nc-sched').hidden, 'date/time shown on later');
  ok(d.getElementById('nc-go').textContent === 'Schedule call', 'button reads Schedule call');
  ok(d.getElementById('nc-eta').disabled, 'ETA override disabled when scheduled');
  ok(/goes on the board 60 min before/.test(d.getElementById('nc-sched-note').textContent), 'note shows lead time');

  // fill the required fields, leave date blank
  function set(id, v) { var e = d.getElementById('nc-' + id); e.value = v; }
  set('cb', '2055550142'); set('name', 'Pat'); set('svc', '5'); set('addr', '9 Oak Ave'); set('zip', '35203'); set('city', 'BHM');
  await w.ncSubmit(false);
  ok(/scheduled date/.test(d.getElementById('nc-err').textContent), 'missing date flagged');
  ok(!posts.some(function (p) { return p[1] === '/dispatch/jobs'; }), 'nothing posted without a date');

  set('sdate', '2026-10-17'); set('stime', '14:30');
  w._ncS.quoteKey = '';
  await w.ncQuoteNow();
  ok(/scheduled_for=2026-10-17T14%3A30/.test(w._lastQuote || ''), 'quote preview asks for the scheduled time');
  ok(/Priced for/.test(d.getElementById('nc-quote').textContent), 'quote says Priced for the time');
  // Who goes does not pre-pick Best ETA for a later call
  w._ncS.whoKey = '';
  await w.ncWhoNow();
  var none = d.getElementById('nc-who-none');
  ok(none && none.checked, 'Nobody yet stays selected for a scheduled call');

  await w.ncSubmit(false);
  var created = posts.filter(function (p) { return p[1] === '/dispatch/jobs'; })[0];
  ok(created && created[2].scheduled_for === '2026-10-17T14:30', 'create posts scheduled_for');
  ok(created && created[2].eta_minutes === '', 'create sends no ETA minutes');
  ok(w.toasts.some(function (t) { return /scheduled for/.test(t[0]); }), 'toast says scheduled ' + JSON.stringify(w.toasts));

  // EDU forces Now
  await w.renderDispatchNew(content, null);
  w.ncWhen('later');
  var edu = d.getElementById('nc-edu');
  edu.checked = true;
  edu.dispatchEvent(new w.Event('change', { bubbles: true }));
  ok(w._ncS.when === 'now' && d.getElementById('nc-sched').hidden, 'EDU flips back to Now');
  w.ncWhen('later');
  ok(w._ncS.when === 'now', 'cannot pick later with EDU ticked');

  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
