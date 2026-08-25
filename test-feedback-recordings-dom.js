'use strict';
/*
 * Render harness for the complaint call-recordings panel.
 *
 * The panel used to answer "No calls found for this number in the last 90
 * days" about a call that was sitting in GoTo the whole time, three minutes
 * old - and there was no 90-day filter anywhere in the query. These assertions
 * pin the replacement:
 *
 *   - "not indexed yet" and "this customer never called" must never render the
 *     same way. They lead a manager to opposite decisions on a critical
 *     complaint.
 *   - the freshness caveat appears ABOVE THE ROWS too, because a list of three
 *     old calls missing the one from four minutes ago reads as complete.
 *   - Judi rows share the timeline with GoTo rows and are NEVER deduped.
 *   - a broken source is stated out loud, never rendered as an absence.
 *
 *   node test-feedback-recordings-dom.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

// ---- lift the real slice out of app.js ------------------------------------
var SRC = fs.readFileSync('public/js/app.js', 'utf8');
var start = SRC.indexOf('function fbRecFmtDur(sec) {');
var end = SRC.indexOf('function fbRecBytes(n) {');
ok(start > 0 && end > start, 'found the complaint-recordings slice in app.js');
var slice = SRC.slice(start, end);
var BT = String.fromCharCode(96); // never a literal backtick in a .js file here
ok(slice.indexOf(BT) === -1, 'the slice is backtick-free (Windows clipboard safety)');
lacks(slice, 'last 90 days.<', 'the false "last 90 days" claim is gone from the rendered copy');

var els = {};
function fakeEl(id) { return { id: id, innerHTML: '', style: {}, _attrs: {},
  getAttribute: function (k) { return this._attrs[k] || null; },
  setAttribute: function (k, v) { this._attrs[k] = v; },
  removeAttribute: function (k) { delete this._attrs[k]; },
  appendChild: function () {} }; }
var doc = { getElementById: function (id) { return els[id] || null; }, createElement: function () { return fakeEl('made'); } };

var PERMS = { manage_feedback: true, play_call_recordings: true };
var API = { calls: [], reply: {}, fail: {} };
function apiStub(method, path, body) {
  API.calls.push({ method: method, path: path, body: body });
  for (var k in API.fail) { if (path.indexOf(k) !== -1) return Promise.reject(new Error(API.fail[k])); }
  for (var k2 in API.reply) { if (path.indexOf(k2) !== -1) return Promise.resolve(API.reply[k2]); }
  return Promise.resolve({});
}
var TOASTS = [];

var M = new Function(
  'document', 'escHtml', 'api', 'can', 'showToast', 'clSrcBadge', 'formatDateTime',
  'judiDetailInto', 'judiPlayInto',
  slice + '\nreturn { fbRecLag:fbRecLag, fbRecMerged:fbRecMerged, fbRecordingsHtml:fbRecordingsHtml,' +
  ' fbRecNovaRow:fbRecNovaRow, fbRecJudiRow:fbRecJudiRow, fbRecWantsJudi:fbRecWantsJudi,' +
  ' fbRecAbsorb:fbRecAbsorb, fbRecRender:fbRecRender, fbLoadRecordings:fbLoadRecordings,' +
  ' fbRecRefresh:fbRecRefresh, fbRecOpenJudi:fbRecOpenJudi, fbRecPlayJudi:fbRecPlayJudi,' +
  ' state:function(){ return _fbRecState; }, setState:function(s){ for (var k in s) _fbRecState[k] = s[k]; } };'
)(
  doc,
  function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  apiStub,
  function (p) { return !!PERMS[p]; },
  function (m, t) { TOASTS.push({ m: m, t: t }); },
  function (l, c) { return '<span data-badge="' + l + '">' + l + '</span>'; },
  function (iso) { return 'AT[' + iso + ']'; },
  function (slotId, c) { LAST_JUDI_DETAIL = { slotId: slotId, c: c }; return Promise.resolve(); },
  function (slotId, c) { LAST_JUDI_PLAY = { slotId: slotId, c: c }; return Promise.resolve(); }
);
var LAST_JUDI_DETAIL = null, LAST_JUDI_PLAY = null;

// ---- fixtures --------------------------------------------------------------
function ago(min) { return new Date(Date.now() - min * 60000).toISOString(); }
function novaCall(o) {
  return Object.assign({ call_id: 11, direction: 'INBOUND', started_at: ago(8), duration_sec: 208,
    number: '+19046510393', has_recording: true, is_primary: false, hidden: false }, o || {});
}
function payload(o) {
  return Object.assign({
    calls: [], canPlay: true, indexed: 5,
    index: { empty: false, newest: ago(40), last_sync: ago(2) },
    complaint_at: ago(5), storageReady: true, gotoConnected: true
  }, o || {});
}

// ===== 1. the lag detector ==================================================
// The whole fix hangs off this function telling the truth.
ok(M.fbRecLag(payload()) !== null, 'lag: newest indexed call older than the complaint = lagging');
ok(M.fbRecLag(payload({ index: { empty: false, newest: ago(1), last_sync: ago(1) } })) === null,
  'lag: an index that has seen a call SINCE the complaint is not lagging');
ok(M.fbRecLag(payload({ complaint_at: ago(60 * 24) })) === null,
  'lag: a day-old complaint gets no caveat - the index long since caught up');
ok(M.fbRecLag(payload({ complaint_at: null })) === null, 'lag: no complaint time, no claim');
ok(M.fbRecLag(payload({ index: null })) === null, 'lag: no index block, no claim');
ok(M.fbRecLag(null) === null, 'lag: no payload, no claim');
var lagEmpty = M.fbRecLag(payload({ index: { empty: true, newest: null, last_sync: null } }));
ok(lagEmpty !== null, 'lag: an empty index against a fresh complaint is lagging');
eq(lagEmpty.newest, null, 'lag: an empty index reports a null high-water mark');

// ===== 2. the empty state no longer lies ====================================
var h = M.fbRecordingsHtml(1, payload(), null, {});
lacks(h, 'last 90 days', 'THE BUG: the "last 90 days" claim is gone');
has(h, 'current through', 'a lagging index says what it is current through');
has(h, 'AT[' + payload().complaint_at.slice(0, 4), 'the note names when the complaint arrived');
has(h, 'may not be here yet', 'the note says a recent call may be missing');
has(h, 'fbRecRefresh(1)', 'the lagging empty state offers a refresh');
lacks(h, 'No calls to or from this number', 'a lagging index does NOT render the flat denial');

// Caught up, still nothing: now the flat statement is fair, and it is accurate.
var caught = payload({ index: { empty: false, newest: ago(1), last_sync: ago(1) } });
var h2 = M.fbRecordingsHtml(1, caught, null, {});
has(h2, 'No calls to or from this number', 'a caught-up index states it plainly');
has(h2, 'as far as the last backfill', 'and names what actually bounds the search');
lacks(h2, '90 days', 'still no 90-day claim');
has(h2, 'fbRecRefresh(1)', 'even the caught-up empty state offers a refresh');

// Empty index is its own message with its own action.
var h3 = M.fbRecordingsHtml(1, payload({ index: { empty: true, newest: null, last_sync: null }, indexed: 0 }), null, {});
has(h3, 'No calls have been indexed yet', 'an empty index says so');
has(h3, 'backfill', 'and points at the backfill, which is the actual fix');

// No phone at all.
var h4 = M.fbRecordingsHtml(1, payload({ reason: 'no_phone' }), null, {});
has(h4, 'nothing to match calls against', 'no phone gets its own message');
lacks(h4, 'fbRecRefresh', 'no phone means no point offering a refresh');

// ===== 3. the caveat rides ABOVE THE ROWS ==================================
// A list of old calls missing the recent one reads as complete history.
var withOld = payload({ calls: [novaCall({ started_at: ago(3000) })] });
var h5 = M.fbRecordingsHtml(1, withOld, null, {});
has(h5, 'current through', 'a lagging index is flagged even when rows ARE showing');
has(h5, 'Play', 'and the rows still render');
ok(h5.indexOf('current through') < h5.indexOf('Play'), 'the caveat comes BEFORE the rows');

// ===== 4. rows =============================================================
var h6 = M.fbRecordingsHtml(1, payload({ calls: [novaCall()] }), null, {});
has(h6, 'fbRecPlay(1,11)', 'a recorded call gets a Play button');
has(h6, '&#9734;', 'a manager can mark the complaint call');
has(h6, 'fbRecHide(1,11)', 'a manager can hide an unrelated call');
has(h6, '1 contact for this number', 'the footer counts contacts');
lacks(h6, 'data-badge', 'no source badges when only one source is in play');

var h7 = M.fbRecordingsHtml(1, payload({ calls: [novaCall({ has_recording: false })] }), null, {});
has(h7, 'No recording yet', 'an unrecorded call says "yet" - GoTo attaches audio later');
lacks(h7, 'fbRecPlay', 'and offers no Play button');

var h8 = M.fbRecordingsHtml(1, payload({ calls: [novaCall()], canPlay: false }), null, {});
has(h8, 'Locked', 'without the play permission the button is Locked');
lacks(h8, 'fbRecPlay', 'and no play handler is wired');

PERMS.manage_feedback = false;
var h9 = M.fbRecordingsHtml(1, payload({ calls: [novaCall()] }), null, {});
lacks(h9, 'fbRecHide', 'a non-manager gets no Hide');
lacks(h9, '&#9734;', 'a non-manager gets no star');
PERMS.manage_feedback = true;

// Hidden rows drop out but are counted.
var hHid = M.fbRecordingsHtml(1, payload({ calls: [novaCall(), novaCall({ call_id: 12, hidden: true })] }), null, {});
has(hHid, '1 hidden', 'hidden calls are counted, not silently dropped');
has(hHid, 'fbRecUnhideAll(1)', 'and can be brought back');

// ===== 5. Judi shares the timeline =========================================
var judi = { configured: true, calls: [
  { short_code: 'tc_call_a7b018', started_at: ago(10), duration_sec: 96, channel: 'phone',
    outcome: 'transferred_to_human', quote_amount: 189.5, eta_minutes: 35, grade_score: 4.2, has_recording: true },
  { short_code: 'tc_chat_9', started_at: ago(300), duration_sec: 0, channel: 'chat', has_recording: false }
] };
var hJ = M.fbRecordingsHtml(1, payload({ calls: [novaCall()] }), judi, {});
has(hJ, 'data-badge="JUDI"', 'Judi rows appear on the complaint panel');
has(hJ, 'data-badge="GOTO"', 'and GoTo rows are badged once there are two sources');
has(hJ, 'fbRecOpenJudi(0)', 'a Judi row opens its detail');
has(hJ, 'fbRecPlayJudi(0)', 'a Judi row with audio can be played');
has(hJ, 'transferred to human', 'the Judi outcome is shown in words');
has(hJ, '$189.50', 'the quote amount is shown');
has(hJ, '35 min ETA', 'the ETA is shown');
has(hJ, 'Chat, no audio', 'a chat row says it has no audio');
has(hJ, '3 contacts for this number', 'the footer counts BOTH sources');
has(hJ, '1 GoTo, 2 Judi', 'and breaks the count down by source');
lacks(hJ, 'fbRecSetPrimary(1,undefined', 'a Judi row never wires the complaint-scoped star');

// Interleaving is by time, newest first, with NO dedup.
var merged = M.fbRecMerged([novaCall({ started_at: ago(9) })], [{ started_at: ago(10), short_code: 'x' }]);
eq(merged.length, 2, 'a Judi leg and a GoTo leg of the SAME contact are both kept');
eq(merged[0].src, 'nova', 'newest first across sources');
eq(merged[1].src, 'judi', 'the older Judi leg follows');
eq(merged[1].idx, 0, 'the Judi index points into the UNFILTERED judi array');

// ===== 6. a broken source is stated, never rendered as absence =============
var hE = M.fbRecordingsHtml(1, payload({ calls: [novaCall()] }), null, { judi: 'Judi unavailable (503)' });
has(hE, 'Judi unavailable', 'a Judi outage is said out loud');
has(hE, 'GoTo calls are still listed below', 'and the GoTo rows still render');
has(hE, 'fbRecPlay(1,11)', 'the surviving source is fully usable');

var hE2 = M.fbRecordingsHtml(1, payload(), null, { nova: 'index down' });
has(hE2, 'Nova call index unavailable', 'a Nova failure is said out loud');

// A Judi that is simply not configured is NOT an error and makes no claim.
var hNC = M.fbRecordingsHtml(1, caught, { configured: false, calls: [] }, {});
lacks(hNC, 'Judi has none either', 'an unconfigured Judi never claims to have looked');
var hC = M.fbRecordingsHtml(1, caught, { configured: true, calls: [] }, {});
has(hC, 'Judi has none either', 'a configured Judi that found nothing says so');

// ===== 6b. WHY Judi is absent must name the right reason ===================
// This started as ONE sentence covering three situations, and it told a manager
// the complaint had no usable phone number when the truth was that Judi has no
// API key. Same class of bug as the 90-day line: an inference stated as fact.
M.setState({ phone: '(904) 651-0393' });
var gNo = M.fbRecordingsHtml(1, caught, { configured: false, calls: [] }, {});
has(gNo, 'JUDI_API_KEY', 'an unconfigured Judi names the API key, not the phone number');
lacks(gNo, 'no full one', 'and never blames the complaint phone for it');

M.setState({ phone: '904' });
var gFrag = M.fbRecordingsHtml(1, caught, null, {});
has(gFrag, 'called FROM', 'a complaint with no full number says THAT is why Judi was skipped');
lacks(gFrag, 'JUDI_API_KEY', 'and does not blame the API key for it');

M.setState({ phone: '(904) 651-0393' });
var gErr = M.fbRecordingsHtml(1, caught, null, { judi: 'timed out' });
has(gErr, 'timed out', 'a Judi outage is reported as an outage');
lacks(gErr, 'was not searched', 'an outage never doubles up as "not searched"');
lacks(gErr, 'JUDI_API_KEY', 'and never as "not configured"');

PERMS.play_call_recordings = false;
var gPerm = M.fbRecordingsHtml(1, caught, null, {});
lacks(gPerm, 'Judi', 'a viewer who cannot see Judi is never told about Judi at all');
PERMS.play_call_recordings = true;

// The gap line shows even when GoTo rows ARE present - otherwise a full-looking
// list silently hides that half the sources were never consulted.
M.setState({ phone: '904' });
var gRows = M.fbRecordingsHtml(1, payload({ calls: [novaCall()], index: { empty: false, newest: ago(1), last_sync: ago(1) } }), null, {});
has(gRows, 'called FROM', 'the Judi gap is stated even when GoTo rows are showing');
has(gRows, 'fbRecPlay(1,11)', 'and the rows still render');
M.setState({ phone: '(904) 651-0393' });

// ===== 7. who gets asked about Judi ========================================
M.setState({ phone: '(904) 651-0393' });
eq(M.fbRecWantsJudi(), true, 'a full number and the permission means Judi is asked');
M.setState({ phone: '904' });
eq(M.fbRecWantsJudi(), false, 'a fragment is never sent - it would pull other people');
M.setState({ phone: '904.651.0393 x22' });
eq(M.fbRecWantsJudi(), true, 'an extension still counts as a full number (server normalises)');
PERMS.play_call_recordings = false;
eq(M.fbRecWantsJudi(), false, 'without play_call_recordings Judi is never even asked');
PERMS.play_call_recordings = true;

// ===== 7b. the Call Lookup page must not have been broken by the refactor ===
// judiDetailInto / judiPlayInto were split OUT of clOpenJudi / clPlayJudi so
// the complaint panel could reuse them. That refactor touched working code on
// a page nothing else here covers, so it gets pinned.
(function () {
  var cs = SRC.indexOf('async function clOpenJudi(i) {');
  var ce = SRC.indexOf('// Invoice refunds');
  ok(cs > 0 && ce > cs, 'found the Call Lookup Judi slice in app.js');
  var cslice = SRC.slice(cs, ce);
  ok(cslice.indexOf(BT) === -1, 'the Call Lookup Judi slice is backtick-free');

  var seen = null;
  var CL = new Function(
    'document', 'api', 'escHtml', 'fbRecBytes', 'fetch', 'state', 'URL', '_clState',
    cslice + '\nreturn { clOpenJudi:clOpenJudi, clPlayJudi:clPlayJudi,' +
    ' judiDetailInto:judiDetailInto, judiPlayInto:judiPlayInto };'
  )(
    { getElementById: function (id) { seen = id; return null; }, createElement: function () { return fakeEl('x'); } },
    function () { return Promise.resolve({}); },
    function (x) { return String(x); },
    function (n) { return n + ' B'; },
    function () { return Promise.resolve({ ok: true, blob: function () { return Promise.resolve({ type: 'audio/mpeg', size: 1 }); } }); },
    { token: 't', viewAsId: null },
    { createObjectURL: function () { return 'blob:x'; }, revokeObjectURL: function () {} },
    { judi: { calls: [{ short_code: 'zz', has_recording: true }] } }
  );

  ok(typeof CL.judiDetailInto === 'function', 'judiDetailInto exists as a shared helper');
  ok(typeof CL.judiPlayInto === 'function', 'judiPlayInto exists as a shared helper');
  CL.clOpenJudi(0);
  eq(seen, 'cl-judi-0', 'clOpenJudi still targets its own Call Lookup slot');
  seen = null;
  CL.clPlayJudi(0);
  eq(seen, 'cl-judiplay-0', 'clPlayJudi still targets its own Call Lookup slot');
})();

// ===== 8. load and refresh wiring ==========================================
(async function () {
  els['fb-recordings'] = fakeEl('fb-recordings');

  API.calls = []; API.reply = {}; API.fail = {};
  API.reply['/recordings'] = payload({ calls: [novaCall()] });
  API.reply['/judi/lookup'] = judi;
  await M.fbLoadRecordings(1, '(904) 651-0393');
  eq(API.calls.length, 2, 'a load asks BOTH sources');
  eq(API.calls[0].method, 'GET', 'the index read is a GET');
  ok(API.calls[1].path.indexOf('/judi/lookup?phone=') === 0, 'Judi is asked with the complaint phone');
  has(els['fb-recordings'].innerHTML, 'data-badge="JUDI"', 'both sources reached the DOM');

  // A Judi outage must degrade the panel, never empty it.
  API.calls = []; API.fail['/judi/lookup'] = 'Judi timed out';
  await M.fbLoadRecordings(1, '(904) 651-0393');
  has(els['fb-recordings'].innerHTML, 'Judi timed out', 'a Judi rejection is surfaced');
  has(els['fb-recordings'].innerHTML, 'fbRecPlay(1,11)', 'and the GoTo rows survive it');
  delete API.fail['/judi/lookup'];

  // A Nova outage must not be swallowed either.
  API.fail['/recordings'] = 'index down';
  await M.fbLoadRecordings(1, '(904) 651-0393');
  has(els['fb-recordings'].innerHTML, 'index down', 'a Nova rejection is surfaced');
  delete API.fail['/recordings'];

  // Refresh: POSTs, re-asks Judi, re-renders, and reports what happened.
  API.calls = []; TOASTS = [];
  API.reply['/recordings'] = payload({ calls: [novaCall()], refreshed: { ran: true, reason: null, inserted: 2, updated: 0, attached: 0 } });
  await M.fbRecRefresh(1);
  eq(API.calls[0].method, 'POST', 'refresh POSTs, so it is never served from a GET cache');
  has(API.calls[0].path, '/recordings/refresh', 'refresh hits the refresh route');
  eq(API.calls.length, 2, 'refresh re-asks Judi too, since Judi is live-fetched');
  eq(TOASTS[0].t, 'success', 'pulling new calls is a success toast');
  has(TOASTS[0].m, '2 new calls', 'and says how many');

  TOASTS = [];
  API.reply['/recordings'] = payload({ calls: [novaCall()], refreshed: { ran: false, reason: 'cooldown', inserted: 0, updated: 0, attached: 0 } });
  await M.fbRecRefresh(1);
  eq(TOASTS[0].t, 'info', 'a cooldown is information, not an error');
  has(TOASTS[0].m, 'checked moments ago', 'and explains itself');

  TOASTS = [];
  API.reply['/recordings'] = payload({ calls: [], refreshed: { ran: false, reason: 'not_connected', inserted: 0, updated: 0, attached: 0 } });
  await M.fbRecRefresh(1);
  eq(TOASTS[0].t, 'error', 'a disconnected GoTo is an error the user must see');

  TOASTS = [];
  API.reply['/recordings'] = payload({ calls: [novaCall()], refreshed: { ran: true, reason: null, inserted: 0, updated: 0, attached: 0 } });
  await M.fbRecRefresh(1);
  has(TOASTS[0].m, 'nothing new', 'an empty pull says nothing new rather than staying silent');

  TOASTS = [];
  API.fail['/recordings/refresh'] = 'network is down';
  await M.fbRecRefresh(1);
  eq(TOASTS[0].t, 'error', 'a failed refresh raises an error toast');
  has(els['fb-recordings'].innerHTML, 'network is down', 'and the failure is on screen, not only in a toast');
  delete API.fail['/recordings/refresh'];

  // Judi row handlers reach the shared helpers with the right slot and call.
  API.reply['/recordings'] = payload({ calls: [novaCall()] });
  await M.fbLoadRecordings(1, '(904) 651-0393');
  await M.fbRecOpenJudi(0);
  eq(LAST_JUDI_DETAIL.slotId, 'fb-judi-0', 'the detail opens into the complaint panel slot');
  eq(LAST_JUDI_DETAIL.c.short_code, 'tc_call_a7b018', 'and carries the right Judi call');
  await M.fbRecPlayJudi(0);
  eq(LAST_JUDI_PLAY.slotId, 'fb-judiplay-0', 'the player opens into its own slot');

  // Switching complaints must not leave the previous customer's Judi rows up.
  M.setState({ id: 1, judi: judi });
  API.fail['/judi/lookup'] = 'boom';
  await M.fbLoadRecordings(2, '(205) 555-0134');
  ok(!M.state().judi, 'moving to another complaint drops the previous one Judi calls');
  delete API.fail['/judi/lookup'];

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})();
