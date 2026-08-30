'use strict';
/*
 * Render harness for peer shout-outs and the Recent Wins card.
 *
 * public/js/employeeRecords.js is a classic script, so it is evaluated inside a
 * vm context holding the handful of globals app.js normally provides (api,
 * escHtml, can, showToast, state, formatDate) plus a hand-rolled document. No
 * jsdom - this checkout does not have it, and every render here writes a string
 * into innerHTML, so a string is all the harness has to catch.
 *
 * What it pins:
 *   - Recent Wins labels the person "Employee:" and carries a credit line;
 *   - the credit line names whoever WROTE the recognition. On a peer shout-out
 *     that is the coworker ("Shout-out from Marcus Hale"), NOT the manager who
 *     approved it. This is the one thing on the card that is easy to get wrong
 *     and impossible to notice once it is wrong;
 *   - the card collapses the Home pair to one column when there is nothing to
 *     show AND the viewer cannot send a shout-out, and stays put when they can;
 *   - the compose modal names the coworker, refuses to send with no person or
 *     no body, and tells the sender the truth about what happens next: an
 *     employee is told a manager reads it, a manager is told it posts on send;
 *   - the confirmation follows the SERVER's answer, not the client's guess;
 *   - a waiting shout-out puts a number on the Employee Files row;
 *   - the approval queue never offers an approve button for a row the server
 *     did not return, and approving posts the EDITED wording and the wins flag;
 *   - declining says out loud that the person it was about is never told;
 *   - My File shows what you sent and what happened to it.
 *
 *   node test-shoutouts-dom.js
 *
 * House style: string concatenation only, no template literals.
 */
var fs = require('fs');
var vm = require('vm');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, label) { ok(String(hay).indexOf(needle) !== -1, label + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, label) { ok(String(hay).indexOf(needle) === -1, label + '  (unexpected: ' + needle + ')'); }
function section(t) { console.log('\n== ' + t); }

var SRC = fs.readFileSync('public/js/employeeRecords.js', 'utf8');

var PEER_WIN = {
  id: 501, name: 'Christopher Benson', category: 'Customer service',
  body: 'Stayed two hours past his shift to finish a lockout.',
  city: 'CHS', by: 'Marcus Hale', peer: true, is_me: false
};
var BOSS_WIN = {
  id: 502, name: 'Marcus Hale', category: 'Safety',
  body: 'Caught a bad tire before the run.',
  city: 'COL', by: 'Dana Reed', peer: false, is_me: true
};

function fixtures() {
  return {
    '/employee-records/wins': { city: null, wins: [PEER_WIN, BOSS_WIN] },
    '/employee-records/me': { records: [] },
    '/employee-records/me/pending': { count: 0 },
    '/employee-records/shoutouts/people': { people: [
      { id: 3, name: 'Christopher Benson', role: 'locksmith', home_city: 'CHS' },
      { id: 5, name: 'Rosa Lin', role: 'locksmith', home_city: 'COL' }
    ] },
    '/employee-records/shoutouts/mine': { shoutouts: [
      { id: 9, status: 'approved', body: 'Covered my route.', category: 'Teamwork',
        to_name: 'Rosa Lin', created_at: '2026-08-24T10:00:00Z' },
      { id: 10, status: 'declined', body: 'lol chris is the best', category: null,
        to_name: 'Christopher Benson', created_at: '2026-08-26T10:00:00Z',
        decline_reason: 'Give me a specific example and I will post it.' },
      { id: 11, status: 'pending', body: 'Stayed late again.', category: null,
        to_name: 'Christopher Benson', created_at: '2026-08-27T10:00:00Z' }
    ] },
    '/employee-records/shoutouts/pending': { shoutouts: [
      { id: 21, to_user_id: 3, to_name: 'Christopher Benson', to_role: 'locksmith', to_city: 'CHS',
        from_name: 'Marcus Hale', category: 'Customer service',
        body: 'Stayed two hours past his shift to finish a lockout.',
        created_at: '2026-08-27T10:00:00Z' }
    ] },
    '/employee-records/shoutouts': { success: true, id: 44 }
  };
}

function makeWin(opts) {
  opts = opts || {};
  var FIX = fixtures();
  if (opts.tweak) opts.tweak(FIX);
  var els = {};
  var w = {};

  function mkEl(id) {
    return {
      id: id, innerHTML: '', value: '', textContent: '', className: '', disabled: false,
      style: {}, options: [], selectedIndex: 0, parentNode: null,
      setAttribute: function (k, v) { this['attr_' + k] = String(v); },
      getAttribute: function (k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
      appendChild: function () {}, removeChild: function () {},
      querySelectorAll: function () { return []; }, addEventListener: function () {}
    };
  }

  w.window = w;
  w.console = console;
  w.setTimeout = setTimeout;
  w.confirm = function () { return true; };
  w.alert = function () {};
  w.apiCalls = [];
  w.toasts = [];

  w.document = {
    head: { appendChild: function () {} },
    body: { appendChild: function (n) { w.lastModal = n; }, removeChild: function () { w.lastModal = null; } },
    getElementById: function (id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
    createElement: function (tag) { var e = mkEl('created-' + tag); e.tagName = tag; return e; },
    addEventListener: function () {}
  };
  w.__els = els;
  w.addEventListener = function () {};

  w.api = function (method, path, body) {
    w.apiCalls.push({ method: method, path: path, body: body });
    if (FIX[path] !== undefined) return Promise.resolve(JSON.parse(JSON.stringify(FIX[path])));
    return Promise.resolve({ success: true });
  };
  w.escHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  w.showToast = function (m, t) { w.toasts.push({ msg: m, kind: t }); };
  // can() is what decides whether the employee half of this feature exists at
  // all. Every test states its own answer.
  w.can = function (p) { return opts.perms ? opts.perms.indexOf(p) !== -1 : true; };
  w.state = { user: { id: 4, name: 'Marcus Hale' }, token: 't', currentView: 'home' };
  w.formatDate = function (d) { return String(d).slice(0, 10); };
  // renderHomeScreen / renderMyFile are wrapped by the module, so they have to
  // exist BEFORE it is evaluated, exactly as app.js and onboarding.js provide
  // them at load time.
  w.renderHomeScreen = function () { return Promise.resolve(); };
  w.renderMyFile = function () { return Promise.resolve(); };
  w.navModel = function () {
    return (opts.nav || []).map(function (n) { return { view: n.view, label: n.label }; });
  };

  vm.createContext(w);
  vm.runInContext(SRC, w);
  return w;
}

function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

(async function main() {

  // -----------------------------------------------------------------------
  section('the Recent Wins card');
  var w = makeWin({ perms: ['submit_shoutout'] });
  await w.renderHomeScreen(w.document.getElementById('content'));
  await settle();
  var card = w.document.getElementById('home-wins').innerHTML;

  has(card, 'Recent Wins', 'the card renders');
  has(card, 'Employee:', 'the employee is labelled');
  has(card, 'Employee:</span> <span class="who">Christopher Benson', 'the label sits immediately before the name');
  eq((card.match(/Employee:/g) || []).length, 2, 'every win carries the label, not just the first');

  has(card, 'Shout-out from <b>Marcus Hale</b>', 'a peer win credits the coworker who wrote it');
  lacks(card, 'Shout-out from <b>Dana Reed</b>', 'and never the manager who approved it');
  has(card, 'Recognized by <b>Dana Reed</b>', 'a manager-written win reads Recognized by');
  lacks(card, 'Recognized by <b>Marcus Hale</b>', 'the two wordings do not cross over');
  has(card, 'Customer service', 'the category still renders');
  has(card, 'YOU', 'the YOU badge still renders');

  // The card went company-wide on 2026-08-28, so each row says which market it
  // came from and the header no longer stamps one city over the whole list.
  has(card, '<span class="er-city">CHS</span>', 'a Charleston win is tagged CHS');
  has(card, '<span class="er-city">COL</span>', 'a Columbia win is tagged COL');
  eq((card.match(/er-city/g) || []).length, 2, 'one city tag per win, not a header stamp');

  // -----------------------------------------------------------------------
  section('the credit line degrades quietly');
  var w2 = makeWin({ perms: [], tweak: function (F) {
    F['/employee-records/wins'] = { city: 'CHS', wins: [
      { id: 9, name: 'Old Record', category: null, body: 'from before this shipped', city: null, by: null, peer: false, is_me: false }
    ] };
  } });
  await w2.renderHomeScreen(w2.document.getElementById('content'));
  await settle();
  var card2 = w2.document.getElementById('home-wins').innerHTML;
  has(card2, 'Employee:', 'a win with no author still gets the label');
  lacks(card2, 'Recognized by', 'and no empty credit line');
  lacks(card2, 'class="by"', 'the credit element is not emitted at all');
  lacks(card2, 'er-city', 'and somebody with no Home City set gets no empty tag');

  // -----------------------------------------------------------------------
  section('the empty card');
  var w3 = makeWin({ perms: [], tweak: function (F) { F['/employee-records/wins'] = { city: 'CHS', wins: [] }; } });
  await w3.renderHomeScreen(w3.document.getElementById('content'));
  await settle();
  eq(w3.document.getElementById('home-wins').innerHTML, '', 'nothing to show and nothing to do: the slot empties');
  eq(w3.document.getElementById('home-wins').getAttribute('style'), null,
    'and the empty slot carries no margin, so it leaves no gap above My Tasks');

  var w4 = makeWin({ perms: ['submit_shoutout'], tweak: function (F) { F['/employee-records/wins'] = { city: 'CHS', wins: [] }; } });
  await w4.renderHomeScreen(w4.document.getElementById('content'));
  await settle();
  var card4 = w4.document.getElementById('home-wins').innerHTML;
  has(card4, 'erShoutout()', 'a quiet week still carries the shout-out button');
  has(card4, 'Send them a shout-out', 'and says what to do with it');
  has(card4, 'margin:0 0 24px', 'the card carries the spacing itself');

  // The button is the whole employee-facing entry point, so its gate matters.
  lacks(w3.document.getElementById('home-wins').innerHTML, 'erShoutout()',
    'without submit_shoutout there is no button anywhere');
  var w5 = makeWin({ perms: [] });
  await w5.renderHomeScreen(w5.document.getElementById('content'));
  await settle();
  lacks(w5.document.getElementById('home-wins').innerHTML, 'erShoutout()',
    'not even on a card that does have wins on it');

  // -----------------------------------------------------------------------
  section('the compose modal');
  var w6 = makeWin({ perms: ['submit_shoutout'] });
  await w6.erShoutout();
  await settle();
  var m = w6.lastModal.innerHTML;
  has(m, 'Send a shout-out', 'the modal opens');
  has(m, 'Christopher Benson', 'coworkers are listed');
  has(m, 'Rosa Lin', 'including other markets');
  has(m, 'value="3"', 'by id');
  has(m, 'A manager reads it before it goes anywhere', 'it says a manager reads it first');
  has(m, '<b>your</b> name on it', 'and that the credit stays with the sender');
  has(m, 'er-so-body', 'there is a body field');
  eq(w6.apiCalls.filter(function (c) { return c.path === '/employee-records/shoutouts/people'; }).length, 1,
    'the people list is fetched once');

  await w6.erShoutout();
  await settle();
  eq(w6.apiCalls.filter(function (c) { return c.path === '/employee-records/shoutouts/people'; }).length, 1,
    'and cached for the second open');

  // -----------------------------------------------------------------------
  section('the compose modal refuses to send junk');
  w6.document.getElementById('er-so-to').value = '';
  w6.document.getElementById('er-so-body').value = 'Something nice.';
  await w6.erShoutoutSend();
  eq(w6.apiCalls.filter(function (c) { return c.method === 'POST'; }).length, 0, 'no person, no request');
  has(w6.toasts[w6.toasts.length - 1].msg, 'Pick a coworker', 'and it says so');

  w6.document.getElementById('er-so-to').value = '3';
  w6.document.getElementById('er-so-body').value = '   ';
  await w6.erShoutoutSend();
  eq(w6.apiCalls.filter(function (c) { return c.method === 'POST'; }).length, 0, 'no body, no request');

  w6.document.getElementById('er-so-body').value = '  Stayed two hours past his shift.  ';
  w6.document.getElementById('er-so-cat').value = 'Customer service';
  await w6.erShoutoutSend();
  await settle();
  var post = w6.apiCalls.filter(function (c) { return c.method === 'POST' && c.path === '/employee-records/shoutouts'; })[0];
  ok(!!post, 'a complete one is sent');
  eq(post.body.to_user_id, 3, 'with the person as a number');
  eq(post.body.body, 'Stayed two hours past his shift.', 'and the body trimmed');
  eq(post.body.category, 'Customer service', 'and the category');
  has(w6.toasts[w6.toasts.length - 1].msg, 'manager will take a look', 'the confirmation sets the expectation');

  // -----------------------------------------------------------------------
  //
  // 2026-08-30. A manager used to be shown the same "a manager reads it" copy
  // as everybody else and then watched their own shout-out sit in a queue. The
  // form now says which of the two is about to happen - and the toast reports
  // what the SERVER did, so a client whose permissions have gone stale cannot
  // promise something that then queues.
  section('a manager is told it posts, and the toast follows the server');
  var w6b = makeWin({ perms: ['submit_shoutout', 'create_employee_note'], tweak: function (F) {
    F['/employee-records/shoutouts'] = { success: true, id: 44, posted: true, record_id: 88 };
  } });
  await w6b.erShoutout();
  await settle();
  var mb = w6b.lastModal.innerHTML;
  has(mb, 'posts as soon as you send it', 'the manager is told it goes straight out');
  lacks(mb, 'A manager reads it before it goes anywhere', 'and is not told somebody reads it first');
  has(mb, '<b>your</b> name on it', 'the credit line is the same either way');

  w6b.document.getElementById('er-so-to').value = '3';
  w6b.document.getElementById('er-so-body').value = 'Took the on-call weekend.';
  await w6b.erShoutoutSend();
  await settle();
  has(w6b.toasts[w6b.toasts.length - 1].msg, 'Posted', 'and the confirmation says it is posted');
  lacks(w6b.toasts[w6b.toasts.length - 1].msg, 'manager will take a look', 'not that it is waiting on anybody');

  // The other direction: a manager by permission whose request the server still
  // queued (stale permissions, a role changed mid-session) must not be told it
  // posted. The response is the authority.
  var w6c = makeWin({ perms: ['submit_shoutout', 'create_employee_note'], tweak: function (F) {
    F['/employee-records/shoutouts'] = { success: true, id: 45, posted: false };
  } });
  await w6c.erShoutout();
  await settle();
  w6c.document.getElementById('er-so-to').value = '3';
  w6c.document.getElementById('er-so-body').value = 'Took the on-call weekend.';
  await w6c.erShoutoutSend();
  await settle();
  has(w6c.toasts[w6c.toasts.length - 1].msg, 'manager will take a look',
    'a queued one says so even when the form promised otherwise');

  // -----------------------------------------------------------------------
  //
  // The queue used to be a number on a button on a screen you had to already be
  // looking at. It now rides the count the sidebar asks for on first paint.
  section('the Employee Files row carries the waiting count');
  var w6d = makeWin({
    perms: ['view_employee_records', 'create_employee_note'],
    nav: [{ view: 'my-documents', label: 'My File' }, { view: 'employee-files', label: 'Employee Files' }],
    tweak: function (F) { F['/employee-records/me/pending'] = { count: 0, shoutouts: 3 }; }
  });
  var nav0 = w6d.navModel();
  eq(nav0[1].label, 'Employee Files', 'the harness nav starts clean');
  await settle(); await settle();
  var nav1 = w6d.navModel();
  has(nav1[1].label, 'er-nav-count">3<', 'the Employee Files row gets the waiting count');
  lacks(nav1[0].label, 'er-nav-count', 'and the My File row is left alone at zero notices');
  var nav2 = w6d.navModel();
  eq((String(nav2[1].label).match(/er-nav-count/g) || []).length, 1, 'a second paint does not stack a second badge');

  // -----------------------------------------------------------------------
  section('the approval queue');
  var w7 = makeWin({ perms: ['view_employee_records', 'create_employee_note'] });
  await w7.erOpenShoutouts();
  await settle();
  var q = w7.document.getElementById('content').innerHTML;
  has(q, 'Christopher Benson', 'the queue names who it is about');
  has(q, 'Written by <b style="color:var(--text-dim)">Marcus Hale', 'and who wrote it');
  has(q, 'erSoApprove(21)', 'with an approve button');
  has(q, 'erSoDecline(21)', 'and a decline button');
  has(q, 'credits whoever wrote it, not you', 'the header says where the credit goes');

  var w8 = makeWin({ perms: ['create_employee_note'], tweak: function (F) {
    F['/employee-records/shoutouts/pending'] = { shoutouts: [] };
  } });
  await w8.erOpenShoutouts();
  await settle();
  has(w8.document.getElementById('content').innerHTML, 'No shout-outs waiting', 'an empty queue says so');
  lacks(w8.document.getElementById('content').innerHTML, 'erSoApprove(', 'and offers nothing to approve');

  // -----------------------------------------------------------------------
  section('approving');
  await w7.erSoApprove(21);
  var am = w7.lastModal.innerHTML;
  has(am, 'Stayed two hours past his shift', 'the wording is prefilled and editable');
  has(am, 'Show on Recent Wins', 'with a wins toggle');
  has(am, 'The original is kept on the record history', 'and it says the original is kept');
  has(am, 'written by Marcus Hale', 'the author is named on the confirm');

  has(am, 'id="er-so-awins" data-on="1"', 'the wins toggle is emitted switched on');

  // The harness writes strings into innerHTML and never parses them, so the
  // toggle element it hands back has no state on it. Mirror what a browser
  // would have after parsing the markup asserted above, then drive it.
  var tgl = w7.document.getElementById('er-so-awins');
  tgl.className = 'er-sw on'; tgl.setAttribute('data-on', '1');

  w7.document.getElementById('er-so-abody').value = 'Stayed two hours past his shift to finish a lockout for a customer.';
  w7.document.getElementById('er-so-acat').value = 'Ownership';
  await w7.erSoApproveGo(21);
  await settle();
  var ap = w7.apiCalls.filter(function (c) { return /\/shoutouts\/21\/approve$/.test(c.path); })[0];
  ok(!!ap, 'approve is posted');
  has(ap.body.body, 'for a customer.', 'the EDITED wording is what goes, not the original');
  eq(ap.body.category, 'Ownership', 'and the edited category');
  eq(ap.body.show_in_wins, true, 'an untouched toggle sends show_in_wins true');

  // Toggle it off and the flag follows.
  await w7.erSoApprove(21);
  w7.erToggle('er-so-awins');
  eq(w7.document.getElementById('er-so-awins').getAttribute('data-on'), '0', 'the toggle flipped off');
  await w7.erSoApproveGo(21);
  await settle();
  var ap2 = w7.apiCalls.filter(function (c) { return /\/shoutouts\/21\/approve$/.test(c.path); }).pop();
  eq(ap2.body.show_in_wins, false, 'turning the toggle off is carried through');

  // A row the server never returned cannot be approved by id alone.
  w7.apiCalls.length = 0;
  await w7.erSoApprove(9999);
  eq(w7.apiCalls.length, 0, 'an unknown id opens nothing');

  // -----------------------------------------------------------------------
  section('declining');
  var w9 = makeWin({ perms: ['create_employee_note'] });
  await w9.erOpenShoutouts();
  await settle();
  await w9.erSoDecline(21);
  var dm = w9.lastModal.innerHTML;
  has(dm, 'was never told this existed and will not be told now', 'the modal says the subject never hears about it');
  has(dm, 'Only Marcus Hale hears back', 'and who does');
  w9.document.getElementById('er-so-dr').value = 'Give me a specific example and I will post it.';
  await w9.erSoDeclineGo(21);
  await settle();
  var dec = w9.apiCalls.filter(function (c) { return /\/shoutouts\/21\/decline$/.test(c.path); })[0];
  ok(!!dec, 'decline is posted');
  has(dec.body.reason, 'specific example', 'with the reason as written');

  // -----------------------------------------------------------------------
  section('My File shows what you sent');
  var w10 = makeWin({ perms: ['submit_shoutout'] });
  await w10.renderMyFile(w10.document.getElementById('content'));
  await settle();
  var sent = w10.document.getElementById('er-sent').innerHTML;
  has(sent, 'Shout-outs you sent', 'the card is there');
  has(sent, 'For Rosa Lin', 'each one names who it was for');
  has(sent, 'Posted', 'an approved one reads Posted');
  has(sent, 'With a manager', 'a pending one reads With a manager');
  has(sent, 'Not posted', 'a declined one reads Not posted');
  has(sent, 'Give me a specific example', 'and carries the reason back');
  has(sent, 'erShoutout()', 'with a button to send another');

  var w11 = makeWin({ perms: [] });
  await w11.renderMyFile(w11.document.getElementById('content'));
  await settle();
  eq(w11.document.getElementById('er-sent').innerHTML, '', 'without the permission the card is not there at all');
  eq(w11.apiCalls.filter(function (c) { return /shoutouts/.test(c.path); }).length, 0,
    'and nothing is even fetched');

  // -----------------------------------------------------------------------
  section('the roster header');
  var w12 = makeWin({ perms: ['view_employee_records', 'create_employee_note'], tweak: function (F) {
    F['/employee-records/roster'] = { employees: [], stats: { people: 0 }, no_city: 0 };
  } });
  await w12.renderEmployeeFiles(w12.document.getElementById('content'));
  await settle();
  var roster = w12.document.getElementById('content').innerHTML;
  has(roster, 'erOpenShoutouts()', 'the roster header links to the queue');
  has(roster, 'Shout-outs (1)', 'with the pending count on it');

  var w13 = makeWin({ perms: ['view_employee_records', 'create_employee_note'], tweak: function (F) {
    F['/employee-records/roster'] = { employees: [], stats: { people: 0 }, no_city: 0 };
    F['/employee-records/shoutouts/pending'] = { shoutouts: [] };
  } });
  await w13.renderEmployeeFiles(w13.document.getElementById('content'));
  await settle();
  var roster13 = w13.document.getElementById('content').innerHTML;
  has(roster13, 'erOpenShoutouts()', 'the button stays at zero so the queue is findable');
  lacks(roster13, 'Shout-outs (', 'but carries no count');

  // A queue that will not load must not take the roster down with it.
  var w14 = makeWin({ perms: ['view_employee_records', 'create_employee_note'], tweak: function (F) {
    F['/employee-records/roster'] = { employees: [], stats: { people: 0 }, no_city: 0 };
    delete F['/employee-records/shoutouts/pending'];
  } });
  w14.api = (function (orig) {
    return function (method, path, body) {
      if (/shoutouts\/pending/.test(path)) return Promise.reject(new Error('boom'));
      return orig(method, path, body);
    };
  })(w14.api);
  await w14.renderEmployeeFiles(w14.document.getElementById('content'));
  await settle();
  has(w14.document.getElementById('content').innerHTML, 'Employee Files', 'the roster still renders');
  lacks(w14.document.getElementById('content').innerHTML, 'Could not load', 'and shows no error');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})();
