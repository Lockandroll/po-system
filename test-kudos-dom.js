'use strict';
/*
 * Render harness for kudos on the Recent Wins card.
 *
 * public/js/employeeRecords.js is a classic script, so it is evaluated inside a
 * vm context holding the globals app.js normally provides (api, escHtml, can,
 * showToast, state, formatDate) plus a hand-rolled document. No jsdom - this
 * checkout does not have it, and every render here writes a string into
 * innerHTML, so a string is all the harness has to catch.
 *
 * What it pins:
 *   - A ZERO IS NEVER DRAWN. No "0 kudos" on a card, no empty celebration. This
 *     is the assertion the whole feature rests on: a win nobody pressed must
 *     look exactly like a win nobody scrolled to;
 *   - the button only appears where the server said kudos_open, so the rule
 *     about your own win and about stale wins lives in one place;
 *   - the tally only appears when the server sent a count, so no client-side
 *     mistake can publish a ranking of people;
 *   - the lock chip says WHO can see the number, and says something different
 *     to the recipient and to a manager;
 *   - pressing posts to the right win, flips the pill, and tells an ordinary
 *     coworker that it landed even though they get no number;
 *   - a failed press gives the button back rather than leaving a dead pill;
 *   - the celebration is fetched but NOT marked seen until it is dismissed;
 *   - the celebration never opens while an admin is previewing with View As.
 *
 *   node test-kudos-dom.js
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

// A win as an ORDINARY coworker receives it: button state, no number.
var PLAIN = {
  id: 501, name: 'Christopher Benson', category: 'Customer service',
  body: 'Most Excellent Geico surveys in July.', city: 'ORL',
  by: 'Tony McKeon', peer: false, is_me: false,
  kudos_mine: false, kudos_open: true
};

function fixtures() {
  return {
    // Deep copy. Every test tweaks its own win, and a shared reference here
    // would leak one test&#39;s kudos_count into the next one&#39;s assertions.
    '/employee-records/wins': { city: null, wins: [JSON.parse(JSON.stringify(PLAIN))] },
    '/employee-records/me/pending': { count: 0 },
    '/employee-records/kudos/unseen': { batches: [] }
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
      style: {}, options: [], selectedIndex: 0, parentNode: null, children: [],
      setAttribute: function (k, v) { this['attr_' + k] = String(v); },
      getAttribute: function (k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
      appendChild: function (n) { this.children.push(n); return n; },
      removeChild: function () {},
      querySelector: function () { return null; },
      querySelectorAll: function () { return []; },
      addEventListener: function () {}
    };
  }

  w.window = w;
  w.console = console;
  w.setTimeout = setTimeout;
  w.apiCalls = [];
  w.toasts = [];
  w.appended = [];

  w.document = {
    head: { appendChild: function () {} },
    body: {
      appendChild: function (n) { w.appended.push(n); return n; },
      removeChild: function () {}
    },
    getElementById: function (id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
    createElement: function (tag) { var e = mkEl('created-' + tag); e.tagName = tag; return e; },
    // The celebration refuses to open on top of another dialog, so the harness
    // has to be able to answer this question.
    querySelector: function (sel) { return (opts.openDialogs || []).indexOf(sel) !== -1 ? {} : null; },
    addEventListener: function () {}
  };
  w.__els = els;
  w.addEventListener = function () {};

  w.api = function (method, path, body) {
    w.apiCalls.push({ method: method, path: path, body: body });
    if (opts.fail && opts.fail(method, path)) {
      var e = new Error('Could not send the kudos.');
      return Promise.reject(e);
    }
    if (FIX[path] !== undefined) return Promise.resolve(JSON.parse(JSON.stringify(FIX[path])));
    return Promise.resolve(opts.postReply || { success: true });
  };
  w.escHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  w.showToast = function (m, t) { w.toasts.push({ msg: m, kind: t }); };
  w.can = function (p) { return opts.perms ? opts.perms.indexOf(p) !== -1 : false; };
  w.state = {
    user: { id: 4, name: 'Marcus Hale' }, token: 't', currentView: 'home',
    viewAsId: opts.viewAsId || null
  };
  w.formatDate = function (d) { return String(d).slice(0, 10); };
  w.renderHomeScreen = function () { return Promise.resolve(); };
  w.renderMyFile = function () { return Promise.resolve(); };
  w.navModel = function () { return []; };

  vm.createContext(w);
  vm.runInContext(SRC, w);
  return w;
}

function settle() { return new Promise(function (r) { setTimeout(r, 0); }); }

async function cardFor(opts) {
  var w = makeWin(opts);
  await w.renderHomeScreen(w.document.getElementById('content'));
  await settle(); await settle();
  return { w: w, html: w.document.getElementById('home-wins').innerHTML };
}

function fakeButton() {
  var row = {
    appended: [],
    querySelector: function (sel) { return this._tally && sel === '.er-ktally' ? this._tally : null; },
    appendChild: function (n) { this.appended.push(n); return n; }
  };
  return {
    disabled: false, className: 'er-kud', innerHTML: '&#128079; Send kudos',
    parentNode: row,
    getBoundingClientRect: function () { return { left: 10, top: 10, width: 40, height: 20 }; }
  };
}

(async function main() {

  // -----------------------------------------------------------------------
  section('what an ordinary coworker sees');
  var a = await cardFor({});
  has(a.html, 'er-kud', 'the pill renders');
  has(a.html, 'erGiveKudos(501,this)', 'and it posts against the right win');
  has(a.html, 'Send kudos', 'with the inviting wording');
  lacks(a.html, 'er-ktally', 'no tally');
  lacks(a.html, 'er-klock', 'no lock chip');
  lacks(a.html, 'kudos</b>', 'and above all NO NUMBER');

  section('already pressed');
  var b = await cardFor({ tweak: function (F) { F['/employee-records/wins'].wins[0].kudos_mine = true; } });
  has(b.html, 'You gave kudos', 'the pill remembers');
  has(b.html, 'disabled', 'and is dead to a second press');
  lacks(b.html, 'erGiveKudos', 'with no handler left on it');

  section('your own win');
  var c = await cardFor({ tweak: function (F) {
    var wn = F['/employee-records/wins'].wins[0];
    wn.is_me = true; wn.kudos_open = false; wn.kudos_count = 0; wn.kudos_from = [];
  } });
  has(c.html, 'YOU', 'it is flagged as yours');
  lacks(c.html, 'er-kud"', 'and carries no button - nobody congratulates themselves');
  lacks(c.html, 'erGiveKudos', 'not even a dead one');

  section('THE ZERO RULE');
  lacks(c.html, '0 kudos', 'a win with no kudos never says so');
  lacks(c.html, 'er-ktally', 'the tally element is not emitted at all');
  lacks(c.html, 'er-klock', 'and neither is the lock chip');

  section('what the recipient sees once people have pressed it');
  var d = await cardFor({ tweak: function (F) {
    var wn = F['/employee-records/wins'].wins[0];
    wn.is_me = true; wn.kudos_open = false;
    wn.kudos_count = 7;
    wn.kudos_from = ['Dylan McLawhorn', 'Marcus Reyes', 'Jodi Sylvest', 'Hanna Whitfield', 'Russ Beechly'];
  } });
  has(d.html, '<b>7 kudos</b>', 'the count');
  has(d.html, 'from Dylan, Marcus, Jodi, Hanna +3', 'first names, four of them, and an honest +n for the rest');
  has(d.html, 'ONLY YOU &amp; MANAGERS SEE THIS', 'and it says out loud who else can see the number');
  lacks(d.html, 'erGiveKudos', 'still no button on your own win');

  section('what a manager sees');
  var e = await cardFor({ tweak: function (F) {
    var wn = F['/employee-records/wins'].wins[0];
    wn.kudos_count = 7; wn.kudos_from = ['Dylan McLawhorn', 'Marcus Reyes'];
  } });
  has(e.html, '<b>7 kudos</b>', 'the count is there');
  has(e.html, 'NOT SHOWN TO EVERYONE', 'and the chip reads differently for somebody who is not the subject');
  has(e.html, 'erGiveKudos(501,this)', 'a manager can still press it');

  // The gate is the presence of kudos_count in the payload and nothing else -
  // if the server withholds it, no client rule can put it back.
  section('the client cannot invent a count the server withheld');
  var f = await cardFor({ perms: ['view_employee_records', 'manage_employee_records'] });
  lacks(f.html, 'er-ktally', 'holding every permission in the browser does not produce a tally');

  // -----------------------------------------------------------------------
  section('pressing it');
  var g = makeWin({ postReply: { success: true, kudos_mine: true } });
  var btn = fakeButton();
  await g.erGiveKudos(501, btn);
  await settle();
  var posts = g.apiCalls.filter(function (c2) { return c2.method === 'POST'; });
  eq(posts.length, 1, 'one POST');
  eq(posts[0].path, '/employee-records/wins/501/kudos', 'to the win that was pressed');
  eq(btn.className, 'er-kud sent', 'the pill flips to sent');
  has(btn.innerHTML, 'Kudos sent', 'and says so');
  eq(btn.disabled, true, 'and cannot be pressed twice');
  eq(btn.parentNode.appended.length, 1, 'somebody with no tally gets a line of reassurance instead');
  has(btn.parentNode.appended[0].textContent, 'next time they open Nova', 'which says what happens next');
  eq(g.toasts.length, 0, 'and no toast - the confetti is the acknowledgement');

  section('pressing it as somebody entitled to the number');
  var h = makeWin({ postReply: { success: true, kudos_mine: true, kudos_count: 8 } });
  var btn2 = fakeButton();
  btn2.parentNode._tally = { innerHTML: '' };
  await h.erGiveKudos(501, btn2);
  await settle();
  has(btn2.parentNode._tally.innerHTML, '<b>8 kudos</b>', 'the tally updates in place');
  eq(btn2.parentNode.appended.length, 0, 'and no duplicate reassurance line');

  section('a press that fails gives the button back');
  var i = makeWin({ fail: function (m, p) { return m === 'POST' && p.indexOf('/kudos') !== -1; } });
  var btn3 = fakeButton();
  await i.erGiveKudos(501, btn3);
  await settle();
  eq(btn3.disabled, false, 'the button is pressable again');
  eq(btn3.className, 'er-kud', 'and does not lie about having sent anything');
  eq(i.toasts.length, 1, 'the person is told');

  // -----------------------------------------------------------------------
  section('the celebration');
  var CEL = { batches: [{
    record_id: 501, body: 'Most Excellent Geico surveys in July.', category: 'Customer service',
    city: 'ORL', by: 'Tony McKeon', peer: false, count: 7,
    names: ['Dylan McLawhorn', 'Marcus Reyes', 'Jodi Sylvest', 'Hanna Whitfield', 'Russ Beechly', 'Sid Golphin', 'Nick Alvarez']
  }] };
  var j = await cardFor({ tweak: function (F) { F['/employee-records/kudos/unseen'] = JSON.parse(JSON.stringify(CEL)); } });
  var ov = j.w.appended.filter(function (n) { return n.className === 'er-cel-ov'; });
  eq(ov.length, 1, 'the dialog opens');
  var cel = ov[0].innerHTML;
  has(cel, '7 people gave you kudos', 'the headline is the count');
  has(cel, 'Most Excellent Geico surveys in July.', 'the win itself is quoted');
  has(cel, 'Customer service', 'with its category');
  has(cel, 'Recognized by Tony McKeon', 'and who wrote it');
  has(cel, '<b>Dylan McLawhorn</b>', 'every giver is named');
  has(cel, '<b>Nick Alvarez</b>', 'including the seventh');
  has(cel, 'erCelDone()', 'and there is a way out of it');

  section('fetching it does NOT mark it seen');
  var seenCalls = j.w.apiCalls.filter(function (c2) { return c2.path.indexOf('/kudos/seen') !== -1; });
  eq(seenCalls.length, 0, 'nothing was stamped just by drawing the dialog');

  section('dismissing does');
  await j.w.erCelDone();
  await settle();
  seenCalls = j.w.apiCalls.filter(function (c2) { return c2.path.indexOf('/kudos/seen') !== -1; });
  eq(seenCalls.length, 1, 'one POST on dismiss');
  eq(JSON.stringify(seenCalls[0].body), JSON.stringify({ record_ids: [501] }), 'scoped to the batch that was shown');
  await j.w.erCelDone();
  await settle();
  eq(j.w.apiCalls.filter(function (c2) { return c2.path.indexOf('/kudos/seen') !== -1; }).length, 1,
    'and a second dismiss posts nothing - there is nothing left to stamp');

  section('one kudos is not "1 people"');
  var k = await cardFor({ tweak: function (F) {
    F['/employee-records/kudos/unseen'] = { batches: [{
      record_id: 501, body: 'x', category: null, city: null, by: null, peer: false,
      count: 1, names: ['Rosa Lin']
    }] };
  } });
  var celK = k.w.appended.filter(function (n) { return n.className === 'er-cel-ov'; })[0].innerHTML;
  has(celK, 'Somebody gave you kudos', 'the singular reads like a person, not a row count');
  lacks(celK, '1 people', 'and never like this');

  section('nothing waiting means no dialog');
  eq(a.w.appended.filter(function (n) { return n.className === 'er-cel-ov'; }).length, 0,
    'an empty batch list draws no celebration at all');

  section('not while previewing somebody else');
  var l = await cardFor({
    viewAsId: 3,
    tweak: function (F) { F['/employee-records/kudos/unseen'] = JSON.parse(JSON.stringify(CEL)); }
  });
  eq(l.w.appended.filter(function (n) { return n.className === 'er-cel-ov'; }).length, 0,
    'View As never opens the celebration');
  eq(l.w.apiCalls.filter(function (c2) { return c2.path.indexOf('/kudos/unseen') !== -1; }).length, 0,
    'and does not even look - spending somebody else&#39;s confetti from a preview is the bug this prevents');

  section('not on top of another dialog');
  var m = await cardFor({
    openDialogs: ['.modal-overlay'],
    tweak: function (F) { F['/employee-records/kudos/unseen'] = JSON.parse(JSON.stringify(CEL)); }
  });
  eq(m.w.appended.filter(function (n) { return n.className === 'er-cel-ov'; }).length, 0,
    'it waits rather than landing over something the person was doing');

  section('and only once per home screen');
  var n = makeWin({ tweak: function (F) { F['/employee-records/kudos/unseen'] = JSON.parse(JSON.stringify(CEL)); } });
  await n.renderHomeScreen(n.document.getElementById('content'));
  await settle(); await settle();
  await n.renderHomeScreen(n.document.getElementById('content'));
  await settle(); await settle();
  eq(n.appended.filter(function (x) { return x.className === 'er-cel-ov'; }).length, 1,
    'navigating home twice does not re-open it');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
