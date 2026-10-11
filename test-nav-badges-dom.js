// Sidebar badges, client side (public/js/navBadges.js), in jsdom against the
// REAL app.js navModel/buildNavHtml and the real employeeRecords.js wrapper.
//
//   node test-nav-badges-dom.js
//
// Proves: rows carry their own count, section headers carry the SUM of the
// rows this person can see (a count for a row they cannot see never reaches a
// header), the hamburger carries the total, the old employee-records stamp no
// longer double-draws, a write triggers a fresh read, and a different user
// never inherits the last person's numbers.
//
// House style: string concatenation only, no template literals.
const fs = require('fs');
const { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

async function main() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', { runScripts: 'outside-only', url: 'https://nova.test/' });
  const w = dom.window;
  w.fetch = async function () { return { ok: true, status: 200, headers: { get: function () { return null; } }, json: async function () { return {}; } }; };
  // One eval: app.js's top-level const state is script-scoped, and separate
  // vm scripts here do not share that scope the way browser <script> tags do.
  var setter = '\nwindow.__set = function (code) { eval(code); };\n';
  w.eval(['app.js', 'employeeRecords.js', 'navBadges.js'].map(function (f) { return fs.readFileSync('public/js/' + f, 'utf8'); }).join('\n;\n') + setter);

  var calls = [];
  var RESP = {
    items: {
      pto: { n: 2, parts: [{ key: 'approve', label: 'to approve', n: 2 }] },
      'employee-files': { n: 1, parts: [{ key: 'wording', label: 'write-up wording to approve', n: 1 }] },
      'onboarding-admin': { n: 1, parts: [{ key: 'review', label: 'Phase 1 to review', n: 1 }] },
      dashboard: { n: 3, parts: [{ key: 'approve', label: 'to approve', n: 2 }, { key: 'order', label: 'to order', n: 1 }] },
      // This user has no view_invoices, so the Refunds row is not in their
      // menu; this count must never surface anywhere.
      refunds: { n: 5, parts: [{ key: 'approve', label: 'to approve', n: 5 }] }
    },
    total: 12
  };
  w._apiFetch = async function (method, path) { calls.push(method + ' ' + path); return JSON.parse(JSON.stringify(RESP)); };

  w.__set("state.token = 't'; state.user = { id: 7, name: 'Julius', role: 'manager' }; " +
    "state.permissions = { manager: ['view_pto', 'manage_onboarding', 'view_pos', 'view_schedule'] }; state._permsLoaded = true;");
  w.document.body.innerHTML = '<button class="hamburger"></button><nav class="sidebar-nav"></nav>';

  w.navModel();                    // first paint kicks the fetch
  await tick(20);
  eq('one fetch on first paint', calls.length, 1);
  ok('first fetch is not forced fresh', calls[0] === 'GET /nav/counts', calls[0]);

  // Collapsed: headers only
  w.__set("state.sidebarSection = '';");
  var html = w.buildNavHtml();
  var d = w.document.createElement('div'); d.innerHTML = html;
  function headerBadge(label) {
    var hs = Array.prototype.slice.call(d.querySelectorAll('.nav-section-header'));
    var h = hs.filter(function (x) { return x.textContent.indexOf(label) !== -1; })[0];
    if (!h) return 'no-header';
    var b = h.querySelector('.nb-count');
    return b ? b.textContent : null;
  }
  eq('People header = 2 + 1 + 1', headerBadge('People'), '4');
  eq('Purchasing header = 3', headerBadge('Purchasing'), '3');
  eq('Sales header absent or unbadged (refunds row not visible)', [null, 'no-header'].indexOf(headerBadge('Sales')) !== -1, true);
  ok('header badges use the softer sum style', d.querySelector('.nav-section-header .nb-count.nb-sum') !== null);
  ok('no leftover employee-records badge', html.indexOf('er-nav-count') === -1);

  // Open People: rows
  w.__set("state.sidebarSection = 'people';");
  d.innerHTML = w.buildNavHtml();
  function rowBadge(label) {
    var rs = Array.prototype.slice.call(d.querySelectorAll('.nav-sub'));
    var r = rs.filter(function (x) { return x.textContent.indexOf(label) !== -1; })[0];
    if (!r) return 'no-row';
    var b = r.querySelector('.nb-count');
    return b ? b.textContent : null;
  }
  eq('Time Off row 2', rowBadge('Time Off'), '2');
  eq('Onboarding row 1', rowBadge('Onboarding'), '1');
  eq('Employee Files row 1', rowBadge('Employee Files'), '1');
  eq('Org Chart row unbadged', rowBadge('Org Chart'), null);
  var tf = Array.prototype.slice.call(d.querySelectorAll('.nav-sub')).filter(function (x) { return x.textContent.indexOf('Time Off') !== -1; })[0];
  eq('row tooltip lists the parts', tf.querySelector('.nb-count').getAttribute('title'), '2 to approve');

  // Hamburger total = visible rows only (2+1+1+3), not the server total 12
  w.navModel();
  await tick(5);
  var ham = w.document.querySelector('.hamburger .nb-ham');
  eq('hamburger shows visible total', ham && ham.textContent, '7');

  // A write triggers a fresh read after the debounce
  calls.length = 0;
  w.api = w.api; // already wrapped
  try { await w.api('POST', '/pto/requests/1/approve', {}); } catch (e) {}
  await tick(1400);
  ok('write triggers a fresh read', calls.indexOf('GET /nav/counts?fresh=1') !== -1, JSON.stringify(calls));

  // Clearing: server says nothing waits -> badges go away
  RESP = { items: {}, total: 0 };
  await w.navBadgesRefresh();
  w.navModel(); await tick(5);
  d.innerHTML = w.buildNavHtml();
  ok('no badges once cleared', d.querySelector('.nb-count') === null);
  ok('hamburger badge removed', w.document.querySelector('.hamburger .nb-ham') === null);

  // A different user on the same tab starts from nothing
  RESP = { items: { tasks: { n: 1, parts: [{ key: 'overdue', label: 'overdue', n: 1 }] } }, total: 1 };
  await w.navBadgesRefresh();
  w.__set("state.user = { id: 8, name: 'Lou', role: 'locksmith' }; state.permissions.locksmith = ['view_tasks'];");
  RESP = { items: {}, total: 0 };
  calls.length = 0;
  var m = w.navModel();
  ok('switching user refetches', calls.length === 1, JSON.stringify(calls));
  d.innerHTML = w.buildNavHtml();
  ok('switched user does not see previous badges', d.querySelector('.nb-count') === null);

  // 99+ cap
  await tick(10);
  RESP = { items: { tasks: { n: 250, parts: [{ key: 'overdue', label: 'overdue', n: 250 }] } }, total: 250 };
  await w.navBadgesRefresh();
  d.innerHTML = w.buildNavHtml();
  var tb = d.querySelector('.nav-item .nb-count');
  eq('caps at 99+', tb && tb.textContent, '99+');

  // Logged out: no fetch
  calls.length = 0;
  w.__set('state.token = null;');
  await w.navBadgesRefresh();
  eq('no fetch when signed out', calls.length, 0);

  console.log((fail ? 'FAILED ' : 'OK ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
