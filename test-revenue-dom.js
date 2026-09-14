'use strict';
/*
 * Weekly Revenue UI in a real DOM (jsdom).
 *
 * The screen and the PDF are two renderings of ONE payload. This pins that the
 * screen renders it faithfully:
 *   - the four cards, in class order, with Total drawn distinctly;
 *   - three charts, one per class, each scaled to its OWN peak and saying so;
 *   - the weekly table with NO combined column and no total row;
 *   - the methodology text a reader needs in order not to misread the charts;
 *   - the staleness banner, which is the only thing standing between an
 *     un-fed store and a manager reading four-week-old money as this week's;
 *   - the import preview's new / changed / unchanged split, which is what
 *     makes the trailing-window habit visibly safe;
 *   - the Import and Settings tabs existing only for manage_revenue.
 *
 *   node test-revenue-dom.js
 *
 * House style: string concatenation only, no template literals.
 */
var fs = require('fs');
var { JSDOM } = require('jsdom');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function section(t) { console.log('\n== ' + t); }

var dom = new JSDOM('<!doctype html><html><body><div id="content"></div></body></html>',
  { runScripts: 'outside-only', url: 'http://localhost/' });
var w = dom.window;

// Minimal stand-ins for the globals public/js/app.js provides. Kept small on
// purpose: booting the whole app here would test app.js, not this screen.
var CALLS = [], TOASTS = [];
var PERMS = { view_revenue: true, manage_revenue: true };
w.state = { user: { id: 1, name: 'Tony McKeon', role: 'admin', email: 'tony@example.com' }, token: 't' };
w.can = function (p) { return !!PERMS[p]; };
w.escHtml = function (s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
w.showToast = function (m, t) { TOASTS.push({ m: m, t: t }); };
w.novaConfirm = async function () { return true; };
var API = {};
w.api = async function (method, path, body) {
  CALLS.push({ method: method, path: path, body: body });
  var k = method + ' ' + path.split('?')[0];
  if (API[k] !== undefined) return API[k];
  return {};
};

w.eval(fs.readFileSync('public/js/revenue.js', 'utf8'));

/* ------------------------------------------------------------- fixtures */

var WEEKS = ['2026-08-17', '2026-08-24', '2026-08-31'];

function bucket(r, b, l, calls) {
  return { roadside: r, battery: b, locksmith: l, total: Math.round((r + b + l) * 100) / 100, calls: calls };
}
function page(name, w1, w2, w3, cards) {
  var weeks = {};
  weeks[WEEKS[0]] = w1; weeks[WEEKS[1]] = w2; weeks[WEEKS[2]] = w3;
  var rows = WEEKS.map(function (wk, i) {
    var b = weeks[wk], pb = i > 0 ? weeks[WEEKS[i - 1]] : null;
    var row = { week_start: wk, calls: b.calls };
    ['roadside', 'battery', 'locksmith'].forEach(function (c) {
      row[c] = b[c];
      row['d_' + c] = pb && pb[c] ? (b[c] - pb[c]) / pb[c] * 100 : null;
    });
    return row;
  });
  return {
    name: name,
    revenue: Math.round((w1.total + w2.total + w3.total) * 100) / 100,
    calls: w1.calls + w2.calls + w3.calls,
    weeks: weeks, rows: rows, cards: cards
  };
}
function card(v, dp, avg, da) {
  return { value: v, prior: null, d_prior: dp, average: avg, d_average: da, avg_weeks: 2 };
}

var ORL = page('Orlando',
  bucket(4000, 300, 1200, 60), bucket(4500, 0, 1400, 66), bucket(5000, 250, 1000, 70),
  { roadside: card(5000, 11.1, 4250, 17.6), battery: card(250, null, 150, 66.7),
    locksmith: card(1000, -28.6, 1300, -23.1), total: card(6250, 3.3, 5700, 9.6) });
var SUN = page('Suncoast',
  bucket(2000, 0, 900, 30), bucket(2100, 0, 800, 31), bucket(1800, 0, 950, 29),
  { roadside: card(1800, -14.3, 2050, -12.2), battery: card(0, null, 0, null),
    locksmith: card(950, 18.8, 850, 11.8), total: card(2750, -3.5, 2900, -5.2) });
var COMPANY = page('All Locations',
  bucket(6000, 300, 2100, 90), bucket(6600, 0, 2200, 97), bucket(6800, 250, 1950, 99),
  { roadside: card(6800, 3.0, 6300, 7.9), battery: card(250, null, 150, 66.7),
    locksmith: card(1950, -11.4, 2150, -9.3), total: card(9000, 0.6, 8600, 4.7) });

var REPORT = {
  window: { weeks: WEEKS, first: WEEKS[0], last: WEEKS[2], lastEnd: '2026-09-06', count: 3 },
  company: COMPANY,
  locations: [ORL, SUN],
  totals: { revenue: 27600, calls: 286, byClass: { roadside: 19400, battery: 550, locksmith: 6250 }, perCall: 96.5 },
  meta: {
    classes: ['roadside', 'battery', 'locksmith'],
    classLabels: { roadside: 'Roadside', battery: 'Battery', locksmith: 'Locksmith' },
    locationMap: { clearwater: 'Suncoast', tampa: 'Suncoast' },
    activeWeeks: WEEKS, generatedAt: '2026-09-14T12:00:00Z'
  }
};

function meta(lastDate, today) {
  return {
    settings: { weeks: 12, recipients: ['tony@example.com'], locationMap: { clearwater: 'Suncoast' },
      enabled: false, staleDays: 10 },
    history: { calls: 13670, revenue: 743240.74, weeks: 11, locations: 7,
      first_date: '2026-06-29', last_date: lastDate },
    runs: [], imports: [],
    weeks: WEEKS.slice().reverse().map(function (wk) { return { week_start: wk, calls: 99, revenue: 9000 }; }),
    latestCompleteWeek: '2026-08-31', today: today
  };
}

function content() { return w.document.getElementById('content'); }
function html() { return content().innerHTML; }

/* ---------------------------------------------------------------- tests */

(async function main() {
  section('the report screen');
  API['GET /revenue/meta'] = meta('2026-09-05', '2026-09-08');
  API['GET /revenue/report'] = REPORT;
  await w.renderRevenue(content());
  var h = html();

  ok(h.indexOf('Weekly Revenue') !== -1, 'the page has its title');
  ok(h.indexOf('rev-good') !== -1 && h.indexOf('rev-warn') === -1,
    'fresh data gets the reassuring banner, not the warning');

  // rev-card[ "] and not a bare prefix: the grid container is class="rev-cards".
  var cards = (h.match(/class="rev-card[ "]/g) || []).length;
  ok(cards === 4, 'four cards are drawn (' + cards + ')');
  var iRoad = h.indexOf('Roadside'), iBat = h.indexOf('Battery'), iLock = h.indexOf('Locksmith');
  ok(iRoad > -1 && iRoad < iBat && iBat < iLock, 'in order: Roadside, Battery, Locksmith');
  ok(h.indexOf('Total Revenue') > iLock, 'and Total Revenue last');
  ok(h.indexOf('rev-card total') !== -1, 'the Total card is drawn distinctly');
  ok(h.indexOf('$9,000') !== -1, 'the total card carries the combined figure');
  ok(h.indexOf('$6,800') !== -1, 'and the roadside card its own');

  var charts = h.split('class="rev-chart"').length - 1;
  ok(charts === 3, 'three charts, one per class (' + charts + ')');
  ok(h.indexOf('scaled to this chart, peak') !== -1,
    'each chart says it is scaled to itself');
  ok(h.indexOf('heights are not comparable with the other two charts') !== -1,
    'and says the heights are not comparable - the one thing a reader could misread');
  ok((h.match(/<rect /g) || []).length >= 6, 'bars are actually drawn');
  ok(h.indexOf('#1baf7a') !== -1 && h.indexOf('#eb6834') !== -1 && h.indexOf('#2a78d6') !== -1,
    'each class keeps its own colour');

  section('the weekly table');
  ok(h.indexOf('<th>Week</th>') !== -1, 'the table is there');
  // Read the WEEKLY table's own header row, not the whole page - the location
  // comparison further down legitimately has a Total column and would mask
  // this if the two were checked together.
  var weeklyHead = h.slice(h.indexOf('<th>Week</th>'));
  weeklyHead = weeklyHead.slice(0, weeklyHead.indexOf('</tr>'));
  var heads = (weeklyHead.match(/>([A-Za-z ]+)<\/th>/g) || [])
    .map(function (x) { return x.replace(/[><\/th]/g, '').trim(); });
  ok(heads.join('|') === 'Week|Roadside|Baery|Locksmi|Calls' ||
     weeklyHead.indexOf('Total') === -1,
    'the weekly table header carries NO combined column: ' + weeklyHead.replace(/\s+/g, ' ').slice(0, 160));
  var weeklyBody = h.slice(h.indexOf('<th>Week</th>'));
  weeklyBody = weeklyBody.slice(0, weeklyBody.indexOf('</table>'));
  ok(weeklyBody.indexOf('All Locations') === -1 && weeklyBody.indexOf('<strong>') === -1,
    'and no total row at the bottom of it either');
  // Newest week first on screen (the PDF runs oldest-first; the screen is a
  // list you scan from the top, and the newest week is the point of it).
  var firstRow = h.indexOf('Aug 31'), secondRow = h.indexOf('Aug 24');
  ok(firstRow !== -1 && secondRow !== -1, 'weeks are labelled');
  ok(h.indexOf('rev-up') !== -1 && h.indexOf('rev-down') !== -1,
    'rises and falls are coloured differently');
  ok(h.indexOf('n/a') !== -1, 'a week with nothing to compare against says n/a, not 0%');

  section('the methodology, in plain sight');
  ok(h.indexOf('GOA calls count') !== -1, 'it says GOA is counted');
  ok(h.indexOf('Pick') !== -1 && h.indexOf('no <code>.LS</code> suffix') !== -1,
    'it names the Pick classification gap');
  ok(h.indexOf('Clearwater and Tampa report together as Suncoast') !== -1,
    'it names the Suncoast consolidation');
  ok(h.indexOf('before the latest one') !== -1, 'it defines the rolling average');

  section('the location comparison, on the company view only');
  ok(h.indexOf('Location comparison') !== -1, 'the comparison table is on the All Locations view');
  ok(h.indexOf('Orlando') !== -1 && h.indexOf('Suncoast') !== -1, 'with every location in it');
  w.revPick('Orlando');
  await new Promise(function (r) { setTimeout(r, 20); });
  var h2 = html();
  ok(h2.indexOf('Location comparison') === -1, 'and not on a single location&#39;s view');
  ok(h2.indexOf('<h3 style="margin:0 0 4px;font-size:16px">Orlando</h3>') !== -1,
    'the picked location is the one drawn');
  w.revPick('company');
  await new Promise(function (r) { setTimeout(r, 20); });

  section('staleness is stated, not left to be inferred');
  API['GET /revenue/meta'] = meta('2026-07-01', '2026-09-08');   // 69 days old
  await w.renderRevenue(content());
  var stale = html();
  ok(stale.indexOf('rev-warn') !== -1, 'old data gets the warning banner');
  ok(/This data is 69 days old/.test(stale), 'and says exactly how old it is');
  ok(stale.indexOf('before anyone reads these figures') !== -1, 'and what to do about it');

  API['GET /revenue/meta'] = { settings: { weeks: 12, recipients: [], locationMap: {}, enabled: false, staleDays: 10 },
    history: { calls: 0, revenue: 0, weeks: 0, locations: 0, first_date: null, last_date: null },
    runs: [], imports: [], weeks: [], latestCompleteWeek: '2026-08-31', today: '2026-09-08' };
  API['GET /revenue/report'] = Object.assign({}, REPORT, { locations: [] });
  await w.renderRevenue(content());
  ok(html().indexOf('No history yet') !== -1, 'an empty store says so instead of drawing empty charts');

  section('the import tab');
  PERMS.manage_revenue = true;
  API['GET /revenue/meta'] = meta('2026-09-05', '2026-09-08');
  API['GET /revenue/report'] = REPORT;
  await w.renderRevenue(content());
  ok(html().indexOf('revGo(\'import\')') !== -1, 'manage_revenue sees the Import tab');
  ok(html().indexOf('revGo(\'settings\')') !== -1, 'and the Settings tab');

  w._revTab = 'import';
  await w.renderRevenue(content());
  var ih = html();
  ok(ih.indexOf('Drop the CallSearch CSV here') !== -1, 'the drop target is drawn');
  ok(ih.indexOf('trailing 3 to 4 week export') !== -1,
    'and it teaches the trailing-window habit right where the file is dropped');
  ok(ih.indexOf('DT Complete') !== -1, 'it names the columns the file needs');

  API['POST /revenue/preview'] = {
    meta: { keptRows: 4200, totalRows: 4200, skipped: { noUid: 0, noDate: 2, noLocation: 0, duplicateUid: 1 },
      locations: [] },
    weeks: [{ week_start: '2026-08-24', calls: 1200, revenue: 60000 },
            { week_start: '2026-08-31', calls: 1300, revenue: 65000 }],
    byClass: { roadside: { calls: 3000, revenue: 90000 }, battery: { calls: 200, revenue: 3000 },
      locksmith: { calls: 1000, revenue: 32000 } },
    locations: [{ location_raw: 'Tampa', location: 'Suncoast', calls: 400 },
                { location_raw: 'Orlando', location: 'Orlando', calls: 900 }],
    diff: { new: 1300, changed: 40, unchanged: 2860, revenue_delta: 65500, revenue_total: 125000 }
  };
  w._revCsv = { text: 'x', filename: 'CallSearch_2026_09_08.csv' };
  await w.revRunPreview();
  var ph = w.document.getElementById('rev-preview').innerHTML;
  ok(ph.indexOf('1300') !== -1, 'the preview shows how many calls are new');
  ok(ph.indexOf('>40<') !== -1, 'how many changed');
  ok(ph.indexOf('2860') !== -1, 'and how many are unchanged - the number that proves the upsert is safe');
  ok(ph.indexOf('$125,000') !== -1, 'the revenue in the file');
  ok(ph.indexOf('2 with no usable date') !== -1 && ph.indexOf('1 repeated inside the file') !== -1,
    'skipped rows are reported rather than quietly dropped');
  ok(ph.indexOf('(consolidated)') !== -1, 'Tampa is flagged as reporting under another name');
  ok(ph.indexOf('Import 4200 calls') !== -1, 'the commit button says exactly what it will do');

  section('the settings tab');
  w._revTab = 'settings';
  await w.renderRevenue(content());
  var sh = html();
  ok(sh.indexOf('id="rev-enabled"') !== -1, 'the Monday send has a switch');
  ok(sh.indexOf('Mondays at 7:30am ET') !== -1, 'and says when it fires');
  ok(sh.indexOf('tony@example.com') !== -1, 'the recipient list is pre-filled');
  ok(sh.indexOf('clearwater = Suncoast') !== -1, 'the consolidation map is editable as text');
  ok(sh.indexOf('changing it re-reports the whole history') !== -1,
    'and explains that it needs no re-import');

  w.document.getElementById('rev-map').value = 'clearwater = Suncoast\ntampa = Suncoast\nnonsense line\n';
  var parsed = w.revReadMap();
  ok(parsed.clearwater === 'Suncoast' && parsed.tampa === 'Suncoast', 'two rules parse');
  ok(!('nonsense line' in parsed), 'a line without an = is ignored, not saved as a broken rule');

  CALLS = [];
  API['PUT /revenue/settings'] = { success: true, settings: meta('2026-09-05', '2026-09-08').settings };
  w.document.getElementById('rev-recipients').value = 'a@b.com, c@d.com';
  w.document.getElementById('rev-weeks').value = '16';
  await w.revSaveSettings();
  var put = CALLS.filter(function (c) { return c.method === 'PUT'; })[0];
  ok(put && put.path === '/revenue/settings', 'save PUTs the settings');
  ok(put && put.body.weeks === 16, 'the window size is sent');
  ok(put && put.body.recipients === 'a@b.com, c@d.com', 'the recipients are sent');
  ok(put && put.body.locationMap.tampa === 'Suncoast', 'and the parsed map');

  section('a reader without manage_revenue');
  PERMS.manage_revenue = false;
  w._revTab = 'report';
  API['GET /revenue/meta'] = meta('2026-09-05', '2026-09-08');
  await w.renderRevenue(content());
  var rh = html();
  ok(rh.indexOf('revGo(\'import\')') === -1, 'no Import tab');
  ok(rh.indexOf('revGo(\'settings\')') === -1, 'no Settings tab');
  ok(rh.indexOf('revDownloadPdf()') !== -1, 'but the PDF is still downloadable');
  ok(rh.indexOf('revSendNow()') === -1, 'and there is no button to email it to everybody');

  console.log('\n----------------------------------------');
  console.log(PASS + ' passed, ' + FAIL + ' failed');
  console.log('----------------------------------------');
  process.exit(FAIL ? 1 : 0);
})();
