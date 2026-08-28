// Weekly leaderboards: browser rendering tests.
//
// public/js/leaderboard.js is a classic script, so it is evaluated inside a
// jsdom window holding the globals app.js normally provides (api, escHtml, can,
// showToast, state, navigate, render) as stubs. Every API call is answered from
// a fixture, so nothing here touches a network or a database.
//
// It also pulls renderHomeScreen straight out of public/js/app.js and runs it,
// which is what pins the Home layout change: Recent Activity gone, Recent Wins
// in its slot, the two leaderboards above My Tasks.
//
//   node test-leaderboard-dom.js
//
// House style: string concatenation only, no template literals.
const fs = require('fs');
const vm = require('vm');
const { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + name + (extra ? ('  -> ' + extra) : '')); }
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b));
}
function has(name, hay, needle) { ok(name, String(hay).indexOf(needle) !== -1, 'missing: ' + needle); }
function lacks(name, hay, needle) { ok(name, String(hay).indexOf(needle) === -1, 'unexpectedly present: ' + needle); }
function before(name, hay, a, b) {
  var s = String(hay), i = s.indexOf(a), j = s.indexOf(b);
  ok(name, i !== -1 && j !== -1 && i < j, 'a=' + i + ' b=' + j);
}

// Pull one top-level function out of app.js by brace matching. app.js is 31k
// lines; loading the whole thing would need every global it touches.
function extractFunction(src, signature) {
  var start = src.indexOf(signature);
  if (start === -1) throw new Error('not found: ' + signature);
  var i = src.indexOf('{', start), depth = 0;
  for (var k = i; k < src.length; k++) {
    var c = src.charAt(k);
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(start, k + 1); }
  }
  throw new Error('unbalanced: ' + signature);
}

const APP = fs.readFileSync('public/js/app.js', 'utf8');
const LBJS = fs.readFileSync('public/js/leaderboard.js', 'utf8');
const ERJS = fs.readFileSync('public/js/employeeRecords.js', 'utf8');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A window with the app.js globals the modules expect, plus a recorder for
// every api() call so the tests can assert on what was actually sent.
function makeWindow(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>',
    { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  w.calls = calls;
  w.__fixtures = opts.fixtures || {};
  w.api = function (method, path, body) {
    calls.push({ method: method, path: path, body: body });
    var key = method + ' ' + path;
    var f = w.__fixtures[key];
    if (f === undefined) f = w.__fixtures[path];
    if (f === undefined) return Promise.reject(new Error('no fixture for ' + key));
    if (f && f.__error) { var e = new Error(f.__error); return Promise.reject(e); }
    return Promise.resolve(typeof f === 'function' ? f(body) : f);
  };
  w.escHtml = esc;
  w.can = function (p) { return (opts.perms || []).indexOf(p) !== -1; };
  w.state = { user: { id: 7, name: 'Tony McKeon', role: opts.role || 'admin' }, currentView: 'home' };
  w.showToast = function (m, t) { w.toasts.push({ m: m, t: t }); };
  w.toasts = [];
  w.navigate = function (v) { w.navigated = v; };
  w.render = function () { w.rendered = (w.rendered || 0) + 1; };
  w.formatDate = function (d) { return String(d || '').slice(0, 10); };
  w.confirm = function () { return true; };
  w.console = console;
  const ctx = vm.createContext(w);
  return { dom: dom, w: w, ctx: ctx, calls: calls };
}

function loadLeaderboard(env) { vm.runInContext(LBJS, env.ctx); }

/* ============================ fixtures ================================== */

const HOME_BOARDS = {
  revenue: {
    week_id: 4, week_start: '2026-08-17', week_label: 'Aug 17 - Aug 23, 2026', row_count: 6,
    top: [
      { rank: 1, name: 'Chris Benson', user_id: 9001, is_me: false, value: 5110.55, city_code: 'VAB' },
      { rank: 2, name: 'Tony McKeon', user_id: 7, is_me: true, value: 3980, city_code: 'VAB' },
      { rank: 3, name: 'Donald Harris', user_id: 9003, is_me: false, value: 2100.1, city_code: 'CHE' },
      { rank: 4, name: 'Ghost <b>Nobody</b> & Co', user_id: null, is_me: false, value: 640, city_code: null },
      { rank: 5, name: 'Dana Harris', user_id: 9004, is_me: false, value: 120, city_code: 'CHE' }
    ]
  },
  batteries: {
    week_id: 5, week_start: '2026-08-17', week_label: 'Aug 17 - Aug 23, 2026', row_count: 6,
    top: [
      { rank: 1, name: 'Darrell Sawyer', user_id: 9002, is_me: false, value: 14, city_code: 'VAB' },
      { rank: 2, name: 'Chris Benson', user_id: 9001, is_me: false, value: 11, city_code: 'VAB' }
    ]
  }
};

const WEEK_LIST = {
  default_week: '2026-08-17',
  metrics: [{ key: 'revenue', label: 'Top Revenue', unit: 'money' },
            { key: 'batteries', label: 'Most Batteries Sold', unit: 'count' }],
  weeks: [
    { id: 4, metric: 'revenue', week_start: '2026-08-17', week_label: 'Aug 17 - Aug 23, 2026',
      file_name: 'week34.xlsx', row_count: 6, matched_count: 5, total_value: 11950.65,
      leader: 'Chris Benson', uploaded_by_name: 'Tony McKeon', created_at: '2026-08-24T09:00:00Z' },
    { id: 5, metric: 'batteries', week_start: '2026-08-17', week_label: 'Aug 17 - Aug 23, 2026',
      file_name: 'week34.xlsx', row_count: 6, matched_count: 6, total_value: 30,
      leader: 'Darrell Sawyer', uploaded_by_name: 'Tony McKeon', created_at: '2026-08-24T09:02:00Z' }
  ]
};

const WEEK_DETAIL = {
  week: { id: 4, metric: 'revenue', week_start: '2026-08-17', week_label: 'Aug 17 - Aug 23, 2026',
          file_name: 'week34.xlsx', sheet_name: 'Week 34', name_column: 'Tech ID',
          value_column: 'Revenue', city_column: 'Location', row_count: 3, matched_count: 2,
          total_value: 11950.65, uploaded_by_name: 'Tony McKeon' },
  entries: [
    { id: 41, rank: 1, user_id: 9001, raw_name: 'Benson, Chris', name: 'Chris Benson',
      matched: true, match_tier: 2, value: 5110.55, city_code: 'VAB' },
    { id: 42, rank: 2, user_id: 9002, raw_name: 'Darrell Sawyer', name: 'Darrell Sawyer',
      matched: true, match_tier: 1, value: 3980, city_code: 'VAB' },
    { id: 43, rank: 3, user_id: null, raw_name: 'Ghost, Nobody', name: 'Ghost, Nobody',
      matched: false, match_tier: null, value: 640, city_code: null }
  ],
  roster: [{ id: 9001, name: 'Chris Benson', home_city: 'VAB' },
           { id: 9002, name: 'Darrell Sawyer', home_city: 'VAB' },
           { id: 9004, name: 'Dana Harris', home_city: 'CHE' }]
};

const PREVIEW = {
  sheets: ['Week 34'], sheet: 'Week 34', header_row: 3,
  columns: [
    { index: 0, header: 'Tech ID', raw_header: 'Tech ID', filled: 5, numeric_ratio: 0, total: 0, samples: ['Benson, Chris'] },
    { index: 1, header: 'Location', raw_header: 'Location', filled: 5, numeric_ratio: 0, total: 0, samples: ['VAB'] },
    { index: 2, header: 'Calls', raw_header: 'Calls', filled: 5, numeric_ratio: 1, total: 82, samples: ['31'] },
    { index: 3, header: 'Revenue', raw_header: 'Revenue', filled: 5, numeric_ratio: 1, total: 11950.65, samples: ['$4,210.55'] },
    { index: 4, header: 'Batteries Sold', raw_header: 'Batteries Sold', filled: 5, numeric_ratio: 1, total: 30, samples: ['9'] }
  ],
  suggestion: { name: 0, value: 3, city: 1 },
  auto: { name: 0, value: 3, city: 1 },
  confident: true,
  preview: [], rows_found: 3, unmatched: 1,
  skipped: { no_name: 0, no_value: 1, total_row: 1 },
  resolved: [
    { rank: 1, raw_name: 'Benson, Chris', value: 5110.55, city_code: 'VAB', lines: 2, user_id: 9001, matched_name: 'Chris Benson', match_tier: 2 },
    { rank: 2, raw_name: 'Sawyer III, Darrell', value: 3980, city_code: 'VAB', lines: 1, user_id: 9002, matched_name: 'Darrell Sawyer', match_tier: 1 },
    { rank: 3, raw_name: 'Ghost, Nobody', value: 640, city_code: null, lines: 1, user_id: null, matched_name: null, match_tier: null }
  ]
};

/* ============================ the tests ================================= */

const DASH = {
  stats: { pending_vr: 2, open_po: 5, open_po_total: 1200.5, active_quotes: 3, quote_total: 900,
           fleet_count: 12, inspections_due: 1 },
  pendingVRs: [{ id: 1, vr_number: 'VR-1', vehicle: 'Van 4', shop_name: 'Shop', city_code: 'VAB', total_amount: 300 }],
  pendingPOs: [],
  myTasks: [{ id: 3, title: 'Order batteries', status: 'open', priority: 'high', due_date: '2026-08-30' }],
  activity: [{ entity_type: 'po', entity_number: 'PO-9', action: 'approved', user_name: 'Someone', created_at: '2026-08-27T10:00:00Z' }]
};

async function homeLayout() {
  console.log('Home layout (public/js/app.js)');
  const env = makeWindow({ perms: ['view_tasks', 'view_pos', 'view_quotes', 'view_vr', 'view_inspections'],
                           fixtures: { 'GET /dashboard': DASH } });
  const src = extractFunction(APP, 'async function renderHomeScreen(el)');
  const fn = vm.runInContext('(' + src + ')', env.ctx);
  const host = env.w.document.getElementById('content');
  await fn(host);
  const html = host.innerHTML;

  has('the two leaderboard slots exist', html, 'id="home-leaders"');
  has('the wins slot exists', html, 'id="home-wins"');
  has('the pair row is addressable', html, 'id="home-pair"');
  lacks('Recent Activity is gone from Home', html, 'Recent Activity');
  lacks('and so is its empty state', html, 'No recent activity');
  before('the notice sits above the leaderboards', html, 'id="home-notice"', 'id="home-leaders"');
  before('the leaderboards sit above My Tasks', html, 'id="home-leaders"', 'My Tasks');
  before('Needs Approval keeps the left of the pair', html, 'Needs Approval', 'id="home-wins"');
  before('and the pair is below My Tasks', html, 'My Tasks', 'id="home-pair"');
  has('the rest of Home is untouched: quick actions', html, 'Quick actions');
  has('the rest of Home is untouched: stat tiles', html, 'VRs Pending Approval');
  has('My Tasks still lists the task', html, 'Order batteries');
}

async function homeCards() {
  console.log('Home cards (public/js/leaderboard.js)');
  const env = makeWindow({ perms: [], fixtures: { 'GET /leaderboard/home': HOME_BOARDS } });
  const host = env.w.document.getElementById('content');
  var origRan = false;
  env.w.renderHomeScreen = async function (h) { origRan = true; h.innerHTML = '<div id="home-leaders"></div>'; };
  loadLeaderboard(env);
  await env.w.renderHomeScreen(host);
  ok('the original Home render still runs', origRan);
  const html = host.innerHTML;

  has('the revenue card is titled', html, 'Top Revenue');
  has('the battery card is titled', html, 'Most Batteries Sold');
  has('the week is named on the card', html, 'Aug 17 - Aug 23, 2026');
  has('money is formatted', html, '$5,110.55');
  has('a whole-dollar total still gets cents', html, '$3,980.00');
  has('batteries are a plain count, not money', html, '>14<');
  lacks('and carry no dollar sign', html, '$14');
  has('the viewer is flagged on their own row', html, 'lb-you');
  has('five rows on the revenue card', html, '>5<');
  has('an unmatched name is shown as unmatched', html, 'lb-unmatched');
  has('markup in a name is escaped', html, '&lt;b&gt;Nobody&lt;/b&gt;');
  lacks('and never lands as real markup', html, '<b>Nobody</b>');
  has('an ampersand in a name is escaped', html, '&amp; Co');
  eq('the name renders as text, not as an element',
     env.w.document.querySelectorAll('#home-leaders b').length, 0);
  has('first place is gold', html, '#f0b429');
  lacks('a plain employee is not offered the upload link', html, 'Upload this week');

  // A manager gets the way in.
  const env2 = makeWindow({ perms: ['manage_leaderboard'], fixtures: { 'GET /leaderboard/home': HOME_BOARDS } });
  const host2 = env2.w.document.getElementById('content');
  env2.w.renderHomeScreen = async function (h) { h.innerHTML = '<div id="home-leaders"></div>'; };
  loadLeaderboard(env2);
  await env2.w.renderHomeScreen(host2);
  has('a manager gets a link to the upload screen', host2.innerHTML, 'Upload this week');
}

async function homeCardsEdges() {
  console.log('Home cards: nothing uploaded yet');
  // Nobody has uploaded anything: an employee sees NOTHING, a manager sees one
  // prompt. An empty board on an employee's home screen is just clutter.
  const env = makeWindow({ perms: [], fixtures: { 'GET /leaderboard/home': { revenue: null, batteries: null } } });
  const host = env.w.document.getElementById('content');
  env.w.renderHomeScreen = async function (h) { h.innerHTML = '<div id="home-leaders"></div>'; };
  loadLeaderboard(env);
  await env.w.renderHomeScreen(host);
  eq('an employee gets nothing at all', env.w.document.getElementById('home-leaders').innerHTML, '');

  const env2 = makeWindow({ perms: ['manage_leaderboard'], fixtures: { 'GET /leaderboard/home': { revenue: null, batteries: null } } });
  const host2 = env2.w.document.getElementById('content');
  env2.w.renderHomeScreen = async function (h) { h.innerHTML = '<div id="home-leaders"></div>'; };
  loadLeaderboard(env2);
  await env2.w.renderHomeScreen(host2);
  has('a manager is invited to upload', host2.innerHTML, 'Weekly leaderboards');
  has('and the invitation goes to the right screen', host2.innerHTML, 'leaderboards');

  // One board uploaded, the other not: the missing one says so rather than
  // vanishing, so the pair stays a pair.
  const env3 = makeWindow({ perms: [], fixtures: { 'GET /leaderboard/home': { revenue: HOME_BOARDS.revenue, batteries: null } } });
  const host3 = env3.w.document.getElementById('content');
  env3.w.renderHomeScreen = async function (h) { h.innerHTML = '<div id="home-leaders"></div>'; };
  loadLeaderboard(env3);
  await env3.w.renderHomeScreen(host3);
  has('the missing board says so', host3.innerHTML, 'Nothing uploaded for this board yet.');
  has('the other one still renders', host3.innerHTML, '$5,110.55');

  // The endpoint failing must not take the home screen down with it.
  const env4 = makeWindow({ perms: [], fixtures: { 'GET /leaderboard/home': { __error: 'boom' } } });
  const host4 = env4.w.document.getElementById('content');
  env4.w.renderHomeScreen = async function (h) { h.innerHTML = '<div id="home-leaders"></div>MARKER'; };
  loadLeaderboard(env4);
  await env4.w.renderHomeScreen(host4);
  has('a failed fetch leaves the rest of Home alone', host4.innerHTML, 'MARKER');
}

async function adminScreen() {
  console.log('The Leaderboards screen');
  const env = makeWindow({ perms: ['manage_leaderboard'], fixtures: { 'GET /leaderboard': WEEK_LIST } });
  loadLeaderboard(env);
  const host = env.w.document.getElementById('content');
  await env.w.renderLeaderboards(host);
  const html = host.innerHTML;
  has('the page is titled', html, 'Leaderboards');
  has('there is a way to upload', html, 'lbUploadModal()');
  has('the revenue week is listed', html, 'Top Revenue');
  has('with its leader', html, 'Chris Benson');
  has('and its total', html, '$11,950.65');
  has('the battery week shows a count, not money', html, '>30<');
  has('a week with unmatched names says how many', html, '1 unmatched');
  lacks('a fully matched week says nothing about it', html, '0 unmatched');
  has('each week can be opened', html, 'lbOpen(4)');
  has('and removed', html, 'lbDelete(5)');

  // Without the permission the screen refuses, even though the nav would have
  // hidden it - the client gate is cosmetic, but it should still be right.
  const env2 = makeWindow({ perms: [], fixtures: { 'GET /leaderboard': WEEK_LIST } });
  loadLeaderboard(env2);
  const host2 = env2.w.document.getElementById('content');
  await env2.w.renderLeaderboards(host2);
  has('no permission, no screen', host2.innerHTML, 'Access denied');
  eq('and no call was made', env2.calls.length, 0);
}

async function weekDetail() {
  console.log('One week in detail');
  const env = makeWindow({
    perms: ['manage_leaderboard'],
    fixtures: { 'GET /leaderboard': WEEK_LIST, 'GET /leaderboard/week/4': WEEK_DETAIL,
                'POST /leaderboard/entry/43': { ok: true } }
  });
  loadLeaderboard(env);
  const host = env.w.document.getElementById('content');
  await env.w.renderLeaderboards(host);       // list first
  env.w.lbOpen(4);                            // then open the week
  await env.w.renderLeaderboards(host);
  const html = host.innerHTML;

  has('the week is named', html, 'Aug 17 - Aug 23, 2026');
  has('the file it came from is shown', html, 'week34.xlsx');
  has('so are the columns it was read from', html, 'Tech ID');
  has('unmatched names are called out at the top', html, '1 name');
  has('the matched row shows the roster name', html, 'Chris Benson');
  has('and what the sheet actually said', html, 'sheet said');
  has('the unmatched row is flagged', html, 'not matched to anyone in Nova');
  has('every row can be linked', html, 'lbLink(43)');

  // The selects are populated AFTER the markup lands, so a name with a quote in
  // it can never break a selected="" attribute.
  const sel41 = env.w.document.getElementById('lb-link-41');
  const sel43 = env.w.document.getElementById('lb-link-43');
  eq('a matched row is pre-selected to its person', sel41.value, '9001');
  eq('an unmatched row is pre-selected to nobody', sel43.value, '');

  // Linking sends the id, and nothing else.
  sel43.value = '9004';
  await env.w.lbLink(43);
  const call = env.calls[env.calls.length - 1];
  eq('linking posts to the row', call.path, '/leaderboard/entry/43');
  eq('and sends only who it is', call.body, { user_id: '9004' });

  // Unlinking sends null, not the empty string, so the server clears it.
  sel43.value = '';
  await env.w.lbLink(43);
  eq('unlinking sends null', env.calls[env.calls.length - 1].body, { user_id: null });
}

async function uploadFlow() {
  console.log('The upload');
  var imported = null;
  const env = makeWindow({
    perms: ['manage_leaderboard'],
    fixtures: {
      'GET /leaderboard': WEEK_LIST,
      'POST /leaderboard/preview': PREVIEW,
      'GET /leaderboard/week/4': WEEK_DETAIL,
      'POST /leaderboard/import': function (body) {
        imported = body;
        return { ok: true, week_id: 4, replaced: false, rows: 3, matched: 2, unmatched: 1, skipped: {} };
      }
    }
  });
  loadLeaderboard(env);
  const host = env.w.document.getElementById('content');
  await env.w.renderLeaderboards(host);
  env.w.lbUploadModal();
  const doc = env.w.document;
  has('the modal offers both boards', doc.body.innerHTML, 'Most Batteries Sold');
  eq('the week defaults to the one that just ended', doc.getElementById('lb-week').value, '2026-08-17');
  ok('import is refused until a file is read', doc.getElementById('lb-import-btn').disabled === true);

  // Stand in for the file picker: the module holds the base64 and asks the
  // server what it says.
  vm.runInContext('lbPickFileForTest = function(name, b64){ };', env.ctx);
  doc.getElementById('lb-metric').value = 'revenue';
  // Drive the same path the FileReader callback drives.
  vm.runInContext('(function(){ var f = { name: "week34.xlsx", size: 100 }; })();', env.ctx);
  env.w.__file = true;
  // lbPickFile needs a real File; use the module's own refresh with a planted file.
  const reader = new env.w.FileReader();
  ok('jsdom provides a FileReader', typeof reader.readAsDataURL === 'function');
  const blob = new env.w.Blob(['Name,Revenue\nChris,100\n'], { type: 'text/csv' });
  const file = new env.w.File([blob], 'week34.csv', { type: 'text/csv' });
  const input = doc.getElementById('lb-file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await new Promise(function (resolve) {
    env.w.lbPickFile(input);
    setTimeout(resolve, 60);
  });

  const prevCall = env.calls.filter(function (c) { return c.path === '/leaderboard/preview'; })[0];
  ok('the file was sent to the server to be read', !!prevCall);
  ok('as base64', !!(prevCall && prevCall.body.file_base64));
  eq('with the board it is for', prevCall && prevCall.body.metric, 'revenue');
  eq('and its name', prevCall && prevCall.body.filename, 'week34.csv');

  const step2 = doc.getElementById('lb-step2').innerHTML;
  has('the guessed columns are shown for confirmation', step2, 'Name column');
  has('with the metric named on the value picker', step2, 'Revenue column');
  eq('the city picker can be set to none',
     doc.querySelector('#lb-city-col option[value="-1"]') ? 'yes' : 'no', 'yes');
  has('the matched people are previewed', step2, 'Chris Benson');
  has('and the unmatched one is flagged before import', step2, 'not matched');
  has('rows that were folded together say so', step2, '2 rows added up');
  has('and the skipped lines are accounted for', step2, 'total row(s) ignored');
  eq('the name column defaults to the guess', doc.getElementById('lb-name-col').value, '0');
  eq('the value column defaults to the guess', doc.getElementById('lb-value-col').value, '3');
  ok('import is now allowed', doc.getElementById('lb-import-btn').disabled === false);

  await env.w.lbImport();
  ok('the import went through', !!imported);
  eq('it names the board', imported.metric, 'revenue');
  eq('and the week', imported.week_start, '2026-08-17');
  eq('and the columns a human confirmed', [imported.name_col, imported.value_col], ['0', '3']);
  ok('it sends the file again so the SERVER reads the numbers', !!imported.file_base64);
  eq('the browser never sends a single figure', imported.rows, undefined);
  eq('or a resolved person', imported.resolved, undefined);
  ok('the modal closed', !doc.getElementById('lb-modal'));
  has('and the result is reported', env.w.toasts[env.w.toasts.length - 1].m, '3 people');
}

async function winsInThePairSlot() {
  console.log('Recent Wins in the slot Recent Activity used to hold');
  const WINS = { city: 'VAB', wins: [
    { id: 1, name: 'Chris Benson', category: 'Customer save', body: 'Drove back out at 9pm.', is_me: false },
    { id: 2, name: 'Tony McKeon', category: null, body: 'Covered two markets.', is_me: true }
  ] };
  const env = makeWindow({
    perms: ['manage_leaderboard'],
    fixtures: { '/employee-records/wins': WINS, '/employee-records/me/pending': { count: 0 },
                'GET /leaderboard/home': HOME_BOARDS }
  });
  // The two modules load in the order index.html loads them, onto a base Home
  // render that emits the three slots app.js emits.
  env.w.renderHomeScreen = async function (h) {
    h.innerHTML = '<div id="home-notice"></div><div id="home-leaders"></div>' +
      '<div id="home-pair" style="display:grid;grid-template-columns:1fr 1fr">' +
      '<div class="card">Needs Approval</div><div id="home-wins"></div></div>';
  };
  vm.runInContext(ERJS, env.ctx);
  loadLeaderboard(env);
  const host = env.w.document.getElementById('content');
  await env.w.renderHomeScreen(host);

  const winsSlot = env.w.document.getElementById('home-wins');
  const pair = env.w.document.getElementById('home-pair');
  has('Recent Wins renders into the pair', winsSlot.innerHTML, 'Recent Wins');
  has('with the win itself', winsSlot.innerHTML, 'Drove back out at 9pm.');
  lacks('and no longer carries its own bottom margin inside the grid', winsSlot.innerHTML, 'margin-bottom:24px');
  eq('the pair stays two columns when there are wins', pair.style.gridTemplateColumns, '1fr 1fr');
  has('and the leaderboards filled too - both wrappers ran', env.w.document.getElementById('home-leaders').innerHTML, '$5,110.55');

  // A quiet week: no wins at all.
  const env2 = makeWindow({
    perms: [], fixtures: { '/employee-records/wins': { city: 'VAB', wins: [] },
                           '/employee-records/me/pending': { count: 0 },
                           'GET /leaderboard/home': HOME_BOARDS }
  });
  env2.w.renderHomeScreen = async function (h) {
    h.innerHTML = '<div id="home-notice"></div><div id="home-leaders"></div>' +
      '<div id="home-pair" style="display:grid;grid-template-columns:1fr 1fr">' +
      '<div class="card">Needs Approval</div><div id="home-wins"></div></div>';
  };
  vm.runInContext(ERJS, env2.ctx);
  loadLeaderboard(env2);
  const host2 = env2.w.document.getElementById('content');
  await env2.w.renderHomeScreen(host2);
  eq('a quiet week draws no wins card', env2.w.document.getElementById('home-wins').innerHTML, '');
  eq('and the pair collapses instead of leaving a hole',
     env2.w.document.getElementById('home-pair').style.gridTemplateColumns, '1fr');
}

async function main() {
  await homeLayout();
  await homeCards();
  await homeCardsEdges();
  await adminScreen();
  await weekDetail();
  await uploadFlow();
  await winsInThePairSlot();
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
