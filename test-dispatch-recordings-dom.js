'use strict';
/*
 * Customer call recordings on a dispatch call - the screen, in jsdom.
 * Run: node test-dispatch-recordings-dom.js   (needs: npm install jsdom)
 * Loads the real public/js/dispatch.js against stubbed api()/can() and fixture payloads.
 * No backticks anywhere in this file (Windows corrupts them in .js).
 */
var fs = require('fs');
var path = require('path');
var JSDOM = require('jsdom').JSDOM;

var pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } }

var dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>', { runScripts: 'outside-only' });
var w = dom.window;
var calls = [];
var perms = {};
var responses = {};
w.eval(
  'var state = { currentView: "dispatch-call", currentParam: 7 };' +
  'function escHtml(s) { return String(s === null || s === undefined ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }' +
  'function navigate() {}' +
  'function formatDateTime(d) { return String(d); }' +
  'function apiBustCache() {}' +
  'var __toasts = [];' +
  'function showToast(m, t) { __toasts.push([m, t]); }' +
  'function fbRecFmtDur(s) { return s ? Math.floor(s / 60) + "m" : ""; }' +
  'function clSrcBadge(l) { return "<b class=\\"badge\\">" + l + "</b>"; }'
);
w.can = function (p) { return !!perms[p]; };
w.api = async function (method, p) {
  calls.push(method + ' ' + p);
  var key = method + ' ' + p.replace(/\?.*$/, '');
  if (responses[key] instanceof Error) throw responses[key];
  return JSON.parse(JSON.stringify(responses[key] || {}));
};
w.eval(fs.readFileSync(path.join(__dirname, 'public/js/dispatch.js'), 'utf8'));
w.setTimeout = function () { return 1; };
w.clearTimeout = function () {};   // the 60s self-refresh is checked by flag, not waited on

function job(extra) {
  return Object.assign({ id: 7, job_number: 'D-7', status: 'new', city_name: 'Birmingham', city_tz: 'America/Chicago',
    created_at: new Date().toISOString(), rec_status: 'pulling', tags: [] }, extra || {});
}
function recBody(extra) {
  return Object.assign({ state: 'pulling', found: 0, recorded: 0, waiting: 0, hidden: 0,
    window_start: new Date(Date.now() - 6 * 3600000).toISOString(), window_end: new Date().toISOString(),
    pull_until: null, active: true, numbers: ['Call back'], index: {}, gotoConnected: true,
    canPlay: true, canEdit: true, checked_at: new Date().toISOString(), calls: [], judi: { configured: false, calls: [] } }, extra || {});
}
function tick() { return new Promise(function (r) { setTimeout(r, 15); }); }
async function open(j, rec, canManage) {
  responses['GET /dispatch/jobs/7'] = { job: j, events: [], views: [], canManage: canManage !== false };
  responses['GET /dispatch/reference'] = { tags: [] };
  responses['GET /dispatch/jobs/7/recordings'] = rec;
  calls = [];
  await w.renderDispatchCall(w.document.getElementById('content'), 7);
  await tick(); await tick();
  return w.document.getElementById('content');
}
function text(el) { return el ? el.textContent.replace(/\s+/g, ' ') : ''; }

async function main() {
  // ---- pulling, nothing yet: the call SAYS it is working on it
  var c = await open(job(), recBody());
  var card = w.document.getElementById('disp-rec');
  ok(!!card, 'recordings card on the call for a dispatch manager');
  ok(/We are working on pulling the customer calls/.test(text(card)), 'banner says we are working on pulling the calls');
  ok(/Nothing has come back from GoTo yet/.test(text(card)), 'says nothing has come back yet');
  ok(/never called/.test(text(card)), 'warns not to read empty as never called');
  ok(/Pulling customer calls/.test(text(w.document.getElementById('disp-rec-pill'))), 'pill under the status says pulling');
  ok(!!card.querySelector('.disp-rec-spin'), 'spinner shown while pulling');
  ok(/Check GoTo now/.test(text(card)), 'Check GoTo now button');
  ok(calls.indexOf('GET /dispatch/jobs/7/recordings') !== -1, 'card loads its own data');
  ok(w.eval('_dispRec.timer') !== null, 'self-refresh armed while pulling');

  // ---- pulling with a call found, recording not posted
  var t1 = new Date(Date.now() - 5 * 60000).toISOString();
  c = await open(job(), recBody({ found: 1, waiting: 1, calls: [{ call_id: 11, direction: 'INBOUND', started_at: t1, duration_sec: 130, matched: 'Call back', has_recording: false }] }));
  card = w.document.getElementById('disp-rec');
  ok(/1 call found so far, 0 with the recording/.test(text(card)), 'counts what has come back');
  ok(/Recording not posted yet/.test(text(card)), 'row says recording not posted yet');
  ok(!/Play/.test(text(card)), 'no Play until the recording exists');
  ok(/Call back/.test(text(card)), 'row shows which number matched');

  // ---- complete + Play + Hide + Judi interleaved
  var t2 = new Date(Date.now() - 2 * 60000).toISOString();
  c = await open(job({ rec_status: 'complete' }), recBody({ state: 'complete', found: 1, recorded: 1,
    calls: [{ call_id: 11, direction: 'INBOUND', started_at: t1, duration_sec: 130, matched: 'Call back', has_recording: true },
            { call_id: 12, direction: 'INBOUND', started_at: t1, duration_sec: 30, matched: 'Caller ID', has_recording: true, hidden: true }],
    hidden: 1,
    judi: { configured: true, calls: [{ short_code: 'J1', started_at: t2, has_recording: true, outcome: 'transferred', matched: 'Call back' }] } }));
  card = w.document.getElementById('disp-rec');
  ok(/customer call recording is in/.test(text(card)), 'complete banner');
  ok(/Customer calls in/.test(text(w.document.getElementById('disp-rec-pill'))), 'pill says calls in');
  ok(!card.querySelector('.disp-rec-banner .disp-rec-spin'), 'no spinner when complete');
  var btns = Array.prototype.slice.call(card.querySelectorAll('button')).map(function (b) { return b.textContent; });
  ok(btns.filter(function (b) { return /Play/.test(b); }).length === 2, 'Play for GoTo + Judi (hidden row not drawn)');
  ok(/JUDI/.test(text(card)) && /GOTO/.test(text(card)), 'source badges when Judi is in play');
  var rowsText = text(card);
  ok(rowsText.indexOf('JUDI') < rowsText.indexOf('GOTO'), 'newest first across sources');
  ok(/1 hidden/.test(rowsText) && /Show hidden/.test(rowsText), 'hidden count + Show hidden');
  ok(/Hide/.test(rowsText), 'Hide offered to a manager');
  ok(w.eval('_dispRec.timer') === null, 'no self-refresh once complete');

  // Play goes to the dispatch play route and builds an audio element.
  responses['GET /dispatch/jobs/7/recordings/11/play'] = { url: 'https://r2.example/a.mp3', mime: 'audio/mpeg', bytes: 10 };
  w.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  await w.dispRecPlay(7, 11);
  ok(!!w.document.querySelector('#disp-rec-player-11 audio'), 'audio player appears in place');
  ok(calls.indexOf('GET /dispatch/jobs/7/recordings/11/play') !== -1, 'played through the dispatch route');

  // ---- partial / none / not connected / no phone
  c = await open(job({ status: 'done', rec_status: 'partial' }), recBody({ state: 'partial', found: 2, recorded: 1, waiting: 1, active: false, pull_until: new Date().toISOString() }));
  ok(/1 of 2 calls never got a recording/.test(text(w.document.getElementById('disp-rec'))), 'partial banner');
  c = await open(job({ status: 'done', rec_status: 'none' }), recBody({ state: 'none', active: false }));
  ok(/No customer calls found/.test(text(w.document.getElementById('disp-rec'))), 'none banner');
  ok(/walk-up/.test(text(w.document.getElementById('disp-rec'))), 'none banner explains what that can mean');
  c = await open(job({ rec_status: 'not_connected' }), recBody({ state: 'not_connected' }));
  ok(/GoTo is not connected/.test(text(w.document.getElementById('disp-rec'))), 'not connected banner');
  ok(/GoTo not connected/.test(text(w.document.getElementById('disp-rec-pill'))), 'not connected pill');

  // ---- an old job with no state yet still says pulling until the card answers
  responses['GET /dispatch/jobs/7/recordings'] = new Error('boom');
  responses['GET /dispatch/jobs/7'] = { job: job({ rec_status: null }), events: [], views: [], canManage: true };
  await w.renderDispatchCall(w.document.getElementById('content'), 7);
  await tick();
  ok(/Pulling customer calls/.test(text(w.document.getElementById('disp-rec-pill'))), 'no stored state: pill defaults to pulling');
  ok(/Could not load the customer calls: boom/.test(text(w.document.getElementById('disp-rec'))), 'load failure is said out loud');

  // ---- event log labels
  responses['GET /dispatch/jobs/7'] = { job: job(), canManage: true, views: [], events: [
    { at: new Date().toISOString(), event: 'rec_pulling', detail: 'Working on pulling the customer call recordings from GoTo.' },
    { at: new Date().toISOString(), event: 'rec_found', detail: '1 customer call recording pulled from GoTo.' }] };
  responses['GET /dispatch/jobs/7/recordings'] = recBody();
  await w.renderDispatchCall(w.document.getElementById('content'), 7);
  var log = text(w.document.querySelector('.disp-log'));
  ok(/Pulling calls/.test(log) && /Working on pulling/.test(log), 'event log shows Pulling calls line');
  ok(/Calls pulled/.test(log), 'event log shows Calls pulled line');

  // ---- a tech without the permission sees no card and no pill
  perms = {};
  c = await open(job(), recBody(), false);
  ok(!w.document.getElementById('disp-rec'), 'tech without play permission: no card');
  ok(!w.document.getElementById('disp-rec-pill'), 'tech without play permission: no pill');
  ok(calls.indexOf('GET /dispatch/jobs/7/recordings') === -1, 'and no request for it');
  perms = { play_call_recordings: true };
  c = await open(job(), recBody({ canEdit: false, calls: [{ call_id: 11, direction: 'INBOUND', started_at: t1, has_recording: true, matched: 'Call back' }], found: 1, recorded: 1 }), false);
  ok(!!w.document.getElementById('disp-rec'), 'anyone with play permission gets the card');
  ok(!/Hide/.test(text(w.document.getElementById('disp-rec'))), 'no Hide without manage');

  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
