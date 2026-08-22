'use strict';
/*
 * DOM harness for the PTO approvals screen: the Balance column and the
 * row-click detail dialog. Loads the real public/js/pto.js into jsdom with
 * stubbed app.js globals and a canned API.
 *
 *   node test-pto-dom.js
 */
var fs = require('fs');
var path = require('path');
var { JSDOM } = require('jsdom');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, l) { ok(String(hay).indexOf(needle) !== -1, l + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, l) { ok(String(hay).indexOf(needle) === -1, l + '  (unexpectedly present: ' + needle + ')'); }

function d(off) { var t = new Date(2026, 8, 7); t.setDate(t.getDate() + off); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); }

var APPROVALS = [
  { id: 10, user_name: 'Kayleigh Young', pay_type: 'hourly', status: 'pending', start_date: d(2), end_date: d(3),
    hours: 16, business_days: 2, paid: true, paid_days: 2, unpaid_days: 0, off_days: 0, type: 'Vacation',
    balance_hours: 6, cost_hours: 16, balance_after: -10, insufficient: true,
    coverage_city: 'ATL', coverage_used: 2, coverage_cap: 1, coverage_over: true },
  { id: 11, user_name: 'Benjamin Albright', pay_type: 'commission', status: 'pending', start_date: d(4), end_date: d(4),
    hours: 0, business_days: 1, paid: false, paid_days: 0, unpaid_days: 0, off_days: 1, type: 'Vacation',
    balance_hours: 80, cost_hours: 0, balance_after: 80, insufficient: false,
    coverage_city: 'ATL', coverage_used: 1, coverage_cap: 1, coverage_over: false },
  { id: 12, user_name: 'Steven Lamberson', pay_type: 'commission', status: 'pending', start_date: d(30), end_date: d(34),
    hours: 40, business_days: 5, paid: true, paid_days: 5, unpaid_days: 0, off_days: 0, type: 'Vacation',
    balance_hours: 120, cost_hours: 40, balance_after: 80, insufficient: false,
    coverage_used: 1, coverage_cap: null, coverage_over: false }
];

var CONTEXT = {
  request: { id: 10, user_id: 2, start_date: d(2), end_date: d(3), type: 'Vacation', paid: true, status: 'pending',
    hours: 16, business_days: 2, paid_days: 2, unpaid_days: 0, off_days: 0, created_at: d(-5),
    days: [{ date: d(2), kind: 'paid' }, { date: d(3), kind: 'unpaid' }], tier_label: 'Direct supervisor' },
  employee: { id: 2, name: 'Kayleigh Young', title: 'Tech', pay_type: 'hourly', hire_date: '2023-03-01',
    tenure_years: 3, exempt: false, accrues: true, employment_type: 'full_time',
    accrual_monthly_hours: 10, accrual_days_per_year: 15, eligible_date: '2023-05-30', eligible_now: true },
  balance: { current_hours: 6, cost_hours: 16, after_hours: -10, insufficient: true },
  history: { window_from: d(-365), window_to: d(0), used_hours: 24,
    requests: [
      { id: 7, start_date: d(-60), end_date: d(-60), business_days: 1, hours: 8, type: 'Vacation', paid: true,
        status: 'denied', paid_days: 1, unpaid_days: 0, off_days: 0, retroactive: false, coverage_override: false, approver_name: 'Ada Admin' },
      { id: 6, start_date: d(-120), end_date: d(-118), business_days: 3, hours: 16, type: 'Sick', paid: true,
        status: 'approved', paid_days: 2, unpaid_days: 1, off_days: 0, retroactive: true, coverage_override: true,
        override_reason: 'Short-staffed but she had the days', approver_name: 'Ada Admin' }
    ],
    ledger: [ { id: 3, entry_date: d(-120), kind: 'usage', amount_hours: -16, description: 'PTO spring' },
              { id: 2, entry_date: d(-90), kind: 'accrual', amount_hours: 10, description: 'monthly accrual' } ],
    upcoming: [ { id: 30, start_date: d(60), end_date: d(64), business_days: 5, hours: 40, type: 'Vacation',
                  paid: true, status: 'approved', paid_days: 5, unpaid_days: 0, off_days: 0, approver_name: 'Ada Admin' } ] },
  coverage: { city_code: 'ATL', city_name: 'Atlanta', scoped: true, cap: 1, used: 2, over: true, names_truncated: false,
    others_off: [ { user_id: 3, name: 'Christopher Benson', start_date: d(2), end_date: d(2), status: 'approved' } ],
    others_pending: [ { user_id: 4, name: 'Benjamin Albright', start_date: d(2), end_date: d(4), status: 'pending' } ] },
  schedule: { from: d(-7), to: d(13), requested_to: d(13), truncated: false, shifts_truncated: false, city_code: 'ATL', city_name: 'Atlanta',
    shifts: [
      { id: 1, user_id: 2, user_name: 'Kayleigh Young', shift_date: d(-6), start_time: '06:00', end_time: '18:00', position_name: 'Tech', position_color: '#3b82f6', city_code: 'ATL' },
      { id: 2, user_id: 3, user_name: 'Christopher Benson', shift_date: d(2), start_time: '18:00', end_time: '06:00', position_name: 'Tech', position_color: '#3b82f6', city_code: 'ATL' },
      { id: 3, user_id: 2, user_name: 'Kayleigh Young', shift_date: d(9), start_time: '06:30', end_time: '18:00', position_name: 'Tech', position_color: '#3b82f6', city_code: 'ATL' }
    ] }
};

var API_LOG = [];
var API_FAIL = null;

async function run() {
  var dom = new JSDOM('<!doctype html><html><head></head><body><div id="content"></div></body></html>',
    { url: 'https://nova.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  var w = dom.window;

  // ---- app.js globals the module leans on
  w.state = { user: { id: 1, name: 'Ada Admin', role: 'admin', isOwner: true } };
  w.can = function () { return true; };
  w.escHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  w.showToast = function (m, k) { w.__toast = { m: m, k: k }; };
  w.api = async function (method, url, body) {
    API_LOG.push(method + ' ' + url);
    if (API_FAIL && url.indexOf(API_FAIL) !== -1) throw new Error('boom');
    if (url === '/pto/approvals') return JSON.parse(JSON.stringify(APPROVALS));
    if (url.indexOf('/pto/approved') === 0) return { rows: [], total: 0, page: 1, page_size: 10, pages: 1 };
    if (/^\/pto\/requests\/\d+\/context$/.test(url)) return JSON.parse(JSON.stringify(CONTEXT));
    throw new Error('unstubbed ' + url);
  };
  w.__approveCalls = []; w.__denyCalls = [];

  var src = fs.readFileSync(path.join(__dirname, 'public/js/pto.js'), 'utf8');
  w.eval(src);

  // The module registers its own ptoApprove/ptoDeny; spy on them so the dialog
  // footer can be verified without a network round trip.
  var realApprove = w.ptoApprove;
  w.ptoApprove = function (id, over, days) { w.__approveCalls.push([id, over, days === undefined ? null : days]); };
  w.ptoDeny = function (id) { w.__denyCalls.push(id); };
  ok(typeof realApprove === 'function', 'module exposes ptoApprove');
  ok(typeof w.ptoDetail === 'function', 'module exposes ptoDetail');

  // ---- render the approvals tab
  var host = w.document.getElementById('content');
  ok(typeof w.renderPto === 'function', 'module exposes renderPto');
  // Drive it the way the nav does: ptoGo sets the tab and re-renders.
  w.ptoGo('approvals');
  for (var t = 0; t < 6; t++) await new Promise(function (r) { setTimeout(r, 0); });

  var html = host.innerHTML;

  console.log('\n== Balance column ==');
  has(html, '<th>Balance</th>', 'Balance header present');
  var ths = Array.prototype.map.call(host.querySelector('table.pto-table').querySelectorAll('thead th'), function (t) { return t.textContent; });
  eq(ths.join('|'), 'Employee|Dates|Days|Amount|Balance|Coverage|Actions', 'column order');

  var rows = host.querySelectorAll('tbody tr[data-pto-open]');
  eq(rows.length, 3, 'three clickable pending rows');
  var r10 = host.querySelector('tr[data-pto-open="10"]');
  var balCell = r10.children[4];
  has(balCell.innerHTML, '6.0 hrs', 'hourly balance shown in hours');
  has(balCell.innerHTML, '-10.0 hrs', 'after-balance shown');
  has(balCell.innerHTML, 'pto-neg', 'negative styling applied');
  has(balCell.textContent, '⚠', 'warning glyph on an insufficient row');

  var r11 = host.querySelector('tr[data-pto-open="11"]');
  has(r11.children[4].textContent, 'no charge', 'off-day request reads no charge');
  lacks(r11.children[4].innerHTML, 'pto-neg', 'no-charge row is not flagged negative');
  has(r11.children[4].textContent, '10.0 days', 'commission balance shown in days');

  var r12 = host.querySelector('tr[data-pto-open="12"]');
  has(r12.children[4].textContent, '15.0 days', 'commission current balance');
  has(r12.children[4].textContent, '10.0 days after', 'commission after balance');
  lacks(r12.children[4].innerHTML, 'pto-neg', 'sufficient row not flagged');

  console.log('== row click vs buttons ==');
  // A click on the Approve button must NOT open the dialog.
  var approveBtn = r10.querySelector('button.ok');
  approveBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.document.querySelectorAll('.pto-mask').length, 0, 'clicking Approve does not open the dialog');

  // A click on the row body does.
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.document.querySelectorAll('.pto-mask').length, 1, 'clicking the row opens the dialog');
  has(w.document.querySelector('.pto-dlg').className, 'wide', 'dialog uses the wide variant');
  await new Promise(function (r) { setTimeout(r, 0); });

  var dlg = w.document.querySelector('.pto-mask');
  var dh = dlg.innerHTML;

  console.log('== dialog: header + balance ==');
  has(dh, 'Kayleigh Young', 'employee name');
  has(dh, 'Direct supervisor', 'approval tier');
  has(dh, '2 paid', 'day breakdown');
  has(dh, 'Available now', 'balance card');
  has(dh, 'After approval', 'after card');
  has(dh, '\u2212 16.0 hrs', 'cost rendered as a deduction');
  has(dh, 'takes them negative', 'negative warning shown');
  has(dh, '1.25 days/mo', 'accrual rate rendered from monthly hours');
  has(dh, '15 days/yr', 'accrual band shown');

  console.log('== dialog: history ==');
  has(dh, 'Previous PTO', 'history section');
  has(dh, 'last 12 months', 'window labelled');
  has(dh, '24.0 hrs', 'used total');
  has(dh, 'denied', 'a denied request is listed');
  has(dh, '>logged<', 'retroactive tag');
  has(dh, '>override<', 'override tag');
  has(dh, 'Ledger detail (2 entries)', 'collapsible ledger with a count');
  has(dh, 'PTO spring', 'ledger line rendered');

  console.log('== dialog: coverage ==');
  has(dh, '2 of 1', 'coverage count');
  has(dh, 'in Atlanta', 'market named');
  has(dh, 'Christopher Benson', 'who else is off, by name');
  has(dh, 'still pending', 'pending overlaps section');
  has(dh, 'Benjamin Albright', 'pending overlap named');

  console.log('== dialog: schedule ==');
  has(dh, 'Atlanta schedule', 'schedule section titled by market');
  var weeks = dlg.querySelectorAll('.pto-wk');
  eq(weeks.length, 3, 'three weeks: before, of, after');
  var dayCols = weeks[0].querySelectorAll('.pto-day');
  eq(dayCols.length, 7, 'seven day columns per week');
  var reqDays = dlg.querySelectorAll('.pto-day.req');
  eq(reqDays.length, 2, 'both requested days highlighted');
  // The whole column must carry the highlight, not just the header text —
  // header-only tinting was too easy to scroll straight past.
  ok(dlg.querySelector('.pto-day.req .pto-day-hd') !== null, 'header still marked');
  // The request is pending, so each requested column is an editable classifier
  // rather than a static badge (see the re-tag section further down).
  var tags = dlg.querySelectorAll('.pto-day-sel');
  eq(tags.length, 2, 'every requested column is labelled');
  eq(tags[0].value, 'paid', 'the paid day says so');
  eq(tags[1].value, 'unpaid', 'the unpaid day says so');
  ok(tags[0].className.indexOf('k-paid') !== -1, 'and is coloured by kind');
  has(dh, 'pto-reqline', 'the dates are spelled out above the grid');
  has(dh, 'Requesting', 'in plain words');
  has(dh, 'those days are the highlighted columns below'.replace('those', 'Those'), 'pointing at the highlight');
  has(dh, '1 paid, 1 unpaid', 'with the day mix');
  has(dh, 'pto-key', 'a colour key is present');
  console.log('== week blocks name their role ==');
  var hds = Array.prototype.map.call(dlg.querySelectorAll('.pto-wk-hd'), function (x) { return x.textContent; });
  eq(hds.length, 3, 'three week blocks');
  ok(hds[0].indexOf('Week before') === 0, 'the first is labelled Week before  (got ' + hds[0] + ')');
  ok(hds[1].indexOf('Requested') === 0, 'the middle is labelled Requested  (got ' + hds[1] + ')');
  ok(hds[2].indexOf('Week after') === 0, 'the last is labelled Week after  (got ' + hds[2] + ')');
  ok(hds[0].indexOf(String(d(-7)).slice(5) ) !== -1 || hds[0].indexOf('Aug') !== -1 || hds[0].indexOf('Sep') !== -1, 'and still carries its dates');
  var mine = dlg.querySelectorAll('.pto-chip.me');
  eq(mine.length, 2, 'the requester own two shifts are outlined');
  has(dh, 'Christopher Benson', 'a colleague shift appears in the grid');
  has(dh, '6a', 'times rendered in short 12h form');
  var reqLabels = Array.prototype.filter.call(dlg.querySelectorAll('.pto-wk-hd'), function (x) { return x.className.indexOf('is-req') !== -1; });
  eq(reqLabels.length, 1, 'only the week containing the request is marked');

  console.log('== a multi-week request numbers its requested weeks ==');
  var savedDays = CONTEXT.request.days, savedEnd = CONTEXT.request.end_date;
  CONTEXT.request.days = [{ date: d(2), kind: 'paid' }, { date: d(3), kind: 'paid' },
                          { date: d(8), kind: 'paid' }, { date: d(9), kind: 'unpaid' }];
  CONTEXT.request.end_date = d(9);
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var mw = w.document.querySelector('.pto-mask');
  var hds2 = Array.prototype.map.call(mw.querySelectorAll('.pto-wk-hd'), function (x) { return x.textContent; });
  ok(hds2[0].indexOf('Week before') === 0, 'still a week before  (got ' + hds2[0] + ')');
  ok(hds2[1].indexOf('Requested \u00b7 week 1 of 2') === 0, 'first requested week numbered  (got ' + hds2[1] + ')');
  ok(hds2[2].indexOf('Requested \u00b7 week 2 of 2') === 0, 'second requested week numbered  (got ' + hds2[2] + ')');
  eq(mw.querySelectorAll('.pto-day.req').length, 4, 'all four requested days highlighted across both weeks');
  CONTEXT.request.days = savedDays; CONTEXT.request.end_date = savedEnd;
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  dlg = w.document.querySelector('.pto-mask');

  console.log('== dialog: footer + close ==');
  var ok2 = dlg.querySelector('#pto-dt-ok');
  ok(!!ok2, 'Approve button in the footer');
  ok2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.document.querySelectorAll('.pto-mask').length, 0, 'approving from the dialog closes it');
  eq(JSON.stringify(w.__approveCalls.map(function (c) { return [c[0], c[1]]; })), JSON.stringify([[10, true]]), 'approve called with the live over-cap flag');

  // Escape closes.
  r10.children[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(w.document.querySelectorAll('.pto-mask').length, 1, 'reopened');
  eq(w.document.body.style.overflow, 'hidden', 'page scroll locked while open');
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  eq(w.document.querySelectorAll('.pto-mask').length, 0, 'Escape closes the dialog');
  eq(w.document.body.style.overflow, '', 'page scroll restored');

  // Keyboard open.
  var ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
  r10.dispatchEvent(ev);
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(w.document.querySelectorAll('.pto-mask').length, 1, 'Enter on a focused row opens it');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.document.querySelectorAll('.pto-mask').length, 0, 'Close button closes it');

  console.log('== dialog: degraded cases ==');
  // No market resolved -> no grid, and it says why.
  var saved = JSON.parse(JSON.stringify(CONTEXT));
  CONTEXT.coverage.city_code = null; CONTEXT.coverage.city_name = null; CONTEXT.coverage.scoped = false;
  CONTEXT.coverage.others_off = []; CONTEXT.coverage.others_pending = [];
  CONTEXT.schedule.city_code = null; CONTEXT.schedule.shifts = [];
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var dh2 = w.document.querySelector('.pto-mask').innerHTML;
  has(dh2, 'no market on file for this employee', 'unresolved market is stated, not hidden');
  has(dh2, 'no city grid to show', 'explains the missing grid');
  has(dh2, 'Nobody else is off', 'empty coverage reads cleanly');
  eq(w.document.querySelectorAll('.pto-wk').length, 0, 'no week blocks without a market');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // Empty history.
  CONTEXT.coverage = saved.coverage; CONTEXT.schedule = saved.schedule;
  CONTEXT.history.requests = []; CONTEXT.history.ledger = []; CONTEXT.history.used_hours = 0;
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'No PTO in the last 12 months', 'empty history message');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  // API failure surfaces instead of hanging on the spinner.
  API_FAIL = '/context';
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'Could not load the detail', 'load failure is reported');
  ok(!!w.document.querySelector('#pto-dt-close'), 'still closable after a failure');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  API_FAIL = null;

  console.log('== booked ahead ==');
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var dh3 = w.document.querySelector('.pto-mask').innerHTML;
  has(dh3, 'Already booked ahead', 'upcoming PTO gets its own section');
  ok(dh3.indexOf('Already booked ahead') > dh3.indexOf('Previous PTO'), 'and it sits under the history, not inside it');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));

  console.log('== truncated schedule says so ==');
  CONTEXT.schedule.truncated = true; CONTEXT.schedule.requested_to = d(70);
  CONTEXT.request.end_date = d(64);
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'The grid stops at', 'truncation is disclosed to the approver');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.schedule.truncated = false; CONTEXT.request.end_date = d(3);

  console.log('== position colour cannot break out of the style attribute ==');
  var evil = '" onclick=alert(1) x="';
  CONTEXT.schedule.shifts[0].position_color = evil;
  CONTEXT.schedule.shifts[1].position_color = 'javascript:alert(1)';
  CONTEXT.schedule.shifts[2].position_color = '#22c55e';
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var mask = w.document.querySelector('.pto-mask');
  var chips = mask.querySelectorAll('.pto-chip');
  ok(chips.length >= 3, 'chips rendered');
  var anyHandler = false, anyJs = false;
  Array.prototype.forEach.call(chips, function (c) {
    if (c.getAttribute('onclick')) anyHandler = true;
    if (String(c.getAttribute('style') || '').indexOf('javascript:') !== -1) anyJs = true;
  });
  eq(anyHandler, false, 'no event handler smuggled in through the colour');
  eq(anyJs, false, 'no javascript: URL in the style attribute');
  lacks(mask.innerHTML, 'onclick=alert', 'the payload never reaches the DOM');
  has(mask.innerHTML, '#3b82f6', 'a rejected colour falls back to the default swatch');
  has(mask.innerHTML, '#22c55e', 'a valid colour is still honoured');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.schedule.shifts[0].position_color = '#3b82f6';
  CONTEXT.schedule.shifts[1].position_color = '#3b82f6';

  console.log('== dialog does not outlive the screen ==');
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(w.document.querySelectorAll('.pto-mask').length, 1, 'open before navigating');
  eq(w.document.body.style.overflow, 'hidden', 'scroll locked');
  // Simulate the app navigating: #content is rebuilt underneath the dialog.
  w.document.getElementById('content').innerHTML = '<div>some other screen</div>';
  await new Promise(function (r) { setTimeout(r, 0); });
  eq(w.document.querySelectorAll('.pto-mask').length, 0, 'navigating away closes the dialog');
  eq(w.document.body.style.overflow, '', 'and releases the page scroll');

  console.log('== a company-wide count is not passed off as a market count ==');
  CONTEXT.coverage.scoped = false;
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var dhS = w.document.querySelector('.pto-mask').innerHTML;
  has(dhS, 'counted company-wide', 'says the count is company-wide');
  has(dhS, 'no cap is set for Atlanta', 'and why');
  lacks(dhS, '2 of 1</span> <span class="pto-sub">in Atlanta', 'does not claim an Atlanta breach');
  has(dhS, 'overlapping days (company-wide)', 'the names list is labelled honestly too');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.coverage.scoped = true;

  console.log('== partial name list is disclosed ==');
  CONTEXT.coverage.names_truncated = true;
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'the count above is complete', 'partial name list disclosed');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.coverage.names_truncated = false;

  console.log('== truncated shift list is disclosed ==');
  CONTEXT.schedule.shifts_truncated = true;
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'more shifts in the window than the grid will show', 'shift cap disclosed');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.schedule.shifts_truncated = false;

  console.log('== shorthand hex survives the alpha suffix ==');
  CONTEXT.schedule.shifts[0].position_color = '#f00';
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var chip0 = w.document.querySelector('.pto-mask .pto-chip');
  var st0 = String(chip0.getAttribute('style') || '');
  has(st0, '#ff000014', 'shorthand expanded to 6 digits so the tint stays valid CSS');
  lacks(st0, '#f0014', 'never emits the 5-digit mess');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.schedule.shifts[0].position_color = '#3b82f6';

  console.log('== an empty market grid still says so ==');
  var savedShifts = CONTEXT.schedule.shifts;
  CONTEXT.schedule.shifts = [];
  r10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  has(w.document.querySelector('.pto-mask').innerHTML, 'Nothing published in this window', 'empty grid is called out');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  CONTEXT.schedule.shifts = savedShifts;

  console.log('== a cancellation row gets its own actions ==');
  APPROVALS[0].status = 'cancel_requested';
  w.ptoGo('approvals');
  for (var t2 = 0; t2 < 6; t2++) await new Promise(function (r) { setTimeout(r, 0); });
  var host2 = w.document.getElementById('content');
  var rc = host2.querySelector('tr[data-pto-open="10"]');
  rc.children[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  ok(!!w.document.querySelector('#pto-dt-cok'), 'Approve cancellation offered');
  ok(!!w.document.querySelector('#pto-dt-ckeep'), 'Keep approved offered');
  ok(!w.document.querySelector('#pto-dt-ok'), 'and not the plain Approve button');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  APPROVALS[0].status = 'pending';

  console.log('== approver can re-tag a day in the dialog ==');
  w.__approveCalls = [];
  w.document.querySelectorAll('.pto-mask').forEach(function (x) { x.remove(); });
  w.document.body.style.overflow = '';
  w.ptoGo('approvals');
  for (var t3 = 0; t3 < 6; t3++) await new Promise(function (r) { setTimeout(r, 0); });
  var host3 = w.document.getElementById('content');
  var rr10 = host3.querySelector('tr[data-pto-open="10"]');
  rr10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var md = w.document.querySelector('.pto-mask');
  var sels = md.querySelectorAll('[data-retag]');
  eq(sels.length, 2, 'one selector per requested day');
  eq(sels[0].value, 'paid', 'seeded from what was submitted');
  eq(sels[1].value, 'unpaid', 'including the unpaid one');
  eq(Array.prototype.map.call(sels[0].options, function (o) { return o.value; }).join(','), 'paid,unpaid,off',
     'all three classifications offered, in both directions');
  eq(md.querySelector('#pto-retag-note').textContent.indexOf('No changes'), 0, 'starts clean');
  eq(md.querySelector('#pto-dt-ok').textContent, 'Approve', 'button is the plain one');

  // Flip the paid day to off.
  sels[0].value = 'off';
  sels[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  var note = md.querySelector('#pto-retag-note').textContent;
  has(note, '1 day re-classified', 'the change is counted');
  has(note, 'paid', 'naming what it was');
  has(note, 'off', 'and what it became');
  has(note, '16.0 hrs', 'the old cost is shown');
  has(note, '0.0 hrs', 'and the new one');
  has(note, 'told what changed', 'and that the employee will be notified');
  eq(md.querySelector('#pto-dt-ok').textContent, 'Approve with changes', 'the button says the approval is not as-submitted');
  ok(sels[0].className.indexOf('k-off') !== -1, 'the selector recolours to match');
  ok(sels[0].className.indexOf('moved') !== -1, 'and is marked as moved');
  // The visible label must follow the value, not stay on what was submitted.
  eq(sels[0].options[sels[0].selectedIndex].textContent, 'DAY OFF', 'and the label the approver reads changes too');
  eq(sels[0].selectedIndex, 2, 'the off option is the selected one');
  var col0 = sels[0].closest('.pto-day');
  ok(col0.className.indexOf('moved') !== -1, 'the whole column is marked as changed');

  // Put it back; the dialog should forget the change entirely.
  sels[0].value = 'paid';
  sels[0].dispatchEvent(new w.Event('change', { bubbles: true }));
  eq(md.querySelector('#pto-retag-note').textContent.indexOf('No changes'), 0, 'reverting clears the change');
  eq(md.querySelector('#pto-dt-ok').textContent, 'Approve', 'and the button goes back');
  ok(sels[0].className.indexOf('moved') === -1, 'moved marker cleared');

  // Change it again and approve.
  sels[1].value = 'off';
  sels[1].dispatchEvent(new w.Event('change', { bubbles: true }));
  md.querySelector('#pto-dt-ok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.__approveCalls.length, 1, 'approve fired');
  var call = w.__approveCalls[0];
  eq(call[0], 10, 'for the right request');
  ok(Array.isArray(call[2]), 'and it carries the day tags');
  eq(call[2].length, 2, 'all days sent, not just the changed one');
  eq(call[2][0].kind, 'paid', 'untouched day keeps its kind');
  eq(call[2][1].kind, 'off', 'changed day carries the new kind');

  console.log('== approving as submitted sends no override ==');
  w.__approveCalls = [];
  rr10.children[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  w.document.querySelector('#pto-dt-ok').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  eq(w.__approveCalls.length, 1, 'approve fired');
  eq(w.__approveCalls[0][2], null, 'no days payload when nothing was changed');

  console.log('== a decided request is read-only ==');
  APPROVALS[0].status = 'cancel_requested';
  w.ptoGo('approvals');
  for (var t4 = 0; t4 < 6; t4++) await new Promise(function (r) { setTimeout(r, 0); });
  w.document.getElementById('content').querySelector('tr[data-pto-open="10"]').children[0]
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  var mro = w.document.querySelector('.pto-mask');
  eq(mro.querySelectorAll('[data-retag]').length, 0, 'no selectors on a non-pending request');
  eq(mro.querySelectorAll('.pto-day-tag').length, 2, 'the days are still labelled, just not editable');
  eq(mro.querySelector('#pto-retag-note'), null, 'and no change summary');
  w.document.querySelector('#pto-dt-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  APPROVALS[0].status = 'pending';

  console.log('== no backticks in the shipped file ==');
  eq(src.indexOf('`'), -1, 'public/js/pto.js contains no backtick');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}
run().catch(function (e) { console.error(e); process.exit(1); });
