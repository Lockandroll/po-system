'use strict';
/*
 * Schedule UI in a real DOM (jsdom): publishing controls gone, manager-only
 * notes drawn only for manager/admin/owner, "Delete this + all future", and the
 * recurring-schedule editor pre-filled from a series.
 *
 *   node test-schedule-dom.js
 */
var fs = require('fs');
var { JSDOM } = require('jsdom');
var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function section(t) { console.log('\n== ' + t); }

var html = '<!doctype html><html><body><div id="content"></div><div id="sched-modal"></div><div id="sched-selbar"></div><div id="sched-grid-wrap"></div></body></html>';
var dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
var w = dom.window;
w.localStorage.setItem('token', 'x');
var CALLS = [];
var API = {};
// Stub the network before app.js boots: render() runs on load.
w.fetch = function () { return Promise.resolve({ ok: true, status: 200, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); }, text: function () { return Promise.resolve('{}'); } }); };
w.matchMedia = w.matchMedia || function () { return { matches: false, addListener: function () {}, addEventListener: function () {} }; };
w.HTMLCanvasElement.prototype.getContext = function () { return null; };
var src = fs.readFileSync('public/js/app.js', 'utf8');
// keep the boot from rendering the whole app: we only need the schedule functions
src = src.replace("if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', novaBoot); }\nelse { novaBoot(); }", "");
src = src.replace(/^const state = \{/m, 'var state = {'); // top-level const is private to an indirect eval
w.eval(src);
w.api = async function (method, path, body) { CALLS.push({ method: method, path: path, body: body }); var k = method + ' ' + path; if (API[k]) return API[k]; return {}; };
w.novaConfirm = async function () { return true; };
w.novaAlert = function (m) { CALLS.push({ alert: m }); };
w.schedToast = function (m) { CALLS.push({ toast: m }); };
w.can = function () { return true; };

var POS = [{ id: 1, name: 'On Call', active: true }, { id: 2, name: 'Locksmith', active: true }];
var USERS = [{ id: 5, name: 'Marcus Hale', role: 'locksmith', home_city: 'CHS', active: true }, { id: 6, name: 'Rosa Lin', role: 'locksmith', home_city: 'ORL', active: true }];
var CITIES = [{ code: 'CHS', name: 'Charleston', active: true, color: '#f97316' }, { code: 'ORL', name: 'Orlando', active: true }];
w._schedPositions = POS; w._schedUsers = USERS; w._schedCities = CITIES; w._schedMonday = '2026-09-07';
w.schedVisibleUsers = function () { return USERS; };
w.schedLoadHistory = async function () {};
w.schedLoadAdmin = async function () {};

function asUser(u) { w.state.user = u; }
function modalHtml() { return w.document.getElementById('sched-modal').innerHTML; }
var SHIFT = { id: 41, user_id: 5, user_name: 'Marcus Hale', city_code: 'CHS', position_id: 1, shift_date: '2026-09-08', start_time: '09:00', end_time: '17:00', break_minutes: 0, notes: 'plain', manager_notes: 'called out', series_id: 7, status: 'published', updated_at: '2026-09-01T00:00:00Z', created_at: '2026-09-01T00:00:00Z' };

(async function main() {
  section('shift editor as manager');
  asUser({ id: 3, name: 'Dana', role: 'manager' });
  w.schedShiftForm(SHIFT);
  var h = modalHtml();
  ok(h.indexOf('sf-mgr-notes') !== -1, 'manager sees the Manager-only notes field');
  ok(w.document.getElementById('sf-mgr-notes').value === 'called out', 'field pre-filled with the note');
  ok(h.indexOf('sf-publish') === -1 && h.indexOf('Publish now') === -1, 'no Publish checkbox');
  ok(h.indexOf('schedDeleteFuture()') !== -1 && h.indexOf('Delete this + all future') !== -1, 'Delete this + all future button present');
  ok(h.indexOf('schedEditSeries(7)') !== -1, 'link to edit the recurring schedule');
  CALLS = [];
  await w.schedSaveShift();
  var put = CALLS.filter(function (c) { return c.method === 'PUT'; })[0];
  ok(put && put.path === '/schedule/shifts/41', 'save PUTs the shift');
  ok(put && put.body.manager_notes === 'called out', 'manager_notes sent on save');
  ok(put && !('publish' in put.body), 'publish no longer sent');

  section('shift editor as owner + admin');
  asUser({ id: 1, name: 'Tony', role: 'admin', isOwner: true });
  w.schedShiftForm(SHIFT); ok(modalHtml().indexOf('sf-mgr-notes') !== -1, 'owner sees it');
  asUser({ id: 2, name: 'Ava', role: 'admin' });
  w.schedShiftForm(SHIFT); ok(modalHtml().indexOf('sf-mgr-notes') !== -1, 'admin sees it');

  section('shift editor as coordinator (has manage_schedule, not a manager)');
  asUser({ id: 4, name: 'Kay', role: 'locksmith_coordinator' });
  var s2 = Object.assign({}, SHIFT); delete s2.manager_notes;
  w.schedShiftForm(s2);
  h = modalHtml();
  ok(h.indexOf('sf-mgr-notes') === -1 && h.indexOf('Manager-only') === -1, 'no manager notes field for coordinator');
  ok(h.indexOf('schedDeleteFuture()') !== -1, 'coordinator still gets Delete this + all future');
  CALLS = [];
  await w.schedSaveShift();
  put = CALLS.filter(function (c) { return c.method === 'PUT'; })[0];
  ok(put && !('manager_notes' in put.body), 'coordinator save does not send manager_notes at all');

  section('delete this + all future');
  asUser({ id: 3, name: 'Dana', role: 'manager' });
  w._schedShifts = [SHIFT];
  w.schedShiftForm(SHIFT);
  CALLS = []; API['POST /schedule/bulk'] = { affected: 12 };
  await w.schedDeleteFuture();
  var post = CALLS.filter(function (c) { return c.method === 'POST' && c.path === '/schedule/bulk'; })[0];
  ok(!!post, 'POSTs /schedule/bulk');
  ok(post && post.body.all_future === true && post.body.action === 'delete' && String(post.body.user_id) === '5' && post.body.from === '2026-09-08', 'body: user 5, from the shift date, all_future');
  ok(CALLS.some(function (c) { return c.toast && c.toast.indexOf('Removed 12') === 0; }), 'toast reports the count');
  ok(modalHtml() === '', 'modal closed');

  section('grid: no draft styling, manager-note marker');
  w._schedShifts = [SHIFT, Object.assign({}, SHIFT, { id: 42, shift_date: '2026-09-09', manager_notes: null })];
  w._schedSelMode = false;
  w.schedRenderGrid();
  var g = w.document.getElementById('sched-grid-wrap').innerHTML;
  ok(g.indexOf('dashed') === -1, 'no dashed (draft) border anywhere');
  ok((g.match(/Mgr note/g) || []).length === 1, 'exactly one Mgr note marker (the shift that has one)');
  ok(g.indexOf('Manager note: called out') !== -1, 'note in the hover title');
  asUser({ id: 4, name: 'Kay', role: 'locksmith_coordinator' });
  w.schedRenderGrid();
  ok(w.document.getElementById('sched-grid-wrap').innerHTML.indexOf('Mgr note') === -1, 'no marker for coordinator even if a note were present');

  section('select bar + toolbar: no publish');
  w._schedSelMode = true; w._schedSel = { 41: 1 };
  w.schedUpdateSelBar();
  var bar = w.document.getElementById('sched-selbar').innerHTML;
  ok(bar.indexOf('Publish') === -1 && bar.indexOf('Unpublish') === -1, 'select bar has no Publish/Unpublish');
  ok(bar.indexOf('schedBulkIdsDelete') !== -1, 'select bar still has Delete');
  ok(typeof w.schedPublishWeek === 'undefined' && typeof w.schedBulkIdsPublish === 'undefined', 'publish functions removed');
  w._schedSelMode = false; w._schedSel = {};
  asUser({ id: 3, name: 'Dana', role: 'manager' });
  w.schedLoadAdmin = async function () {};
  await w.renderScheduleAdmin(w.document.getElementById('content'));
  var page = w.document.getElementById('content').innerHTML;
  ok(page.indexOf('Publish Week') === -1, 'no Publish Week button');
  ok(page.indexOf('Dashed = draft') === -1, 'legend no longer mentions drafts');
  ok(page.indexOf('Add Shift') !== -1 && page.indexOf('Bulk edit') !== -1, 'other buttons intact');

  section('recurring editor: new');
  w.schedRecurringForm();
  h = modalHtml();
  ok(h.indexOf('Recurring Shift') !== -1 && h.indexOf('rc-applyfrom') === -1, 'new form: no Apply-from');
  ok(h.indexOf('rc-publish') === -1, 'no publish checkbox');
  ok(h.indexOf('rc-mgr-notes') !== -1 && h.indexOf('rc-notes') !== -1, 'notes + manager notes fields');
  ok(h.indexOf('Create shifts') !== -1, 'Create shifts button');
  CALLS = []; API['POST /schedule/recurring'] = { created: 20, series_id: 9 };
  await w.schedSaveRecurring();
  post = CALLS.filter(function (c) { return c.method === 'POST'; })[0];
  ok(post && post.path === '/schedule/recurring' && !('publish' in post.body) && 'manager_notes' in post.body, 'create body: no publish, has manager_notes');
  ok(CALLS.some(function (c) { return c.toast === 'Created 20 shift(s).'; }), 'toast no longer says drafts');

  section('recurring editor: edit a series');
  var SERIES = { id: 7, user_id: 6, city_code: 'ORL', position_id: 2, mode: 'rotation', weekdays: null, days_on: 4, days_off: 2, start_date: '2026-08-31', weeks: 10, start_time: '06:00', end_time: '18:00', break_minutes: 30, notes: 'rot', manager_notes: 'series note', future_shifts: 25 };
  API['GET /schedule/series/7'] = SERIES;
  await w.schedEditSeries(7);
  h = modalHtml();
  ok(h.indexOf('Update Recurring Schedule') !== -1, 'edit title');
  ok(w.document.getElementById('rc-applyfrom') && w.document.getElementById('rc-applyfrom').value === w.schedToday(), 'Apply-from defaults to today (start is in the past)');
  ok(h.indexOf('(25 upcoming)') !== -1, 'says how many upcoming shifts it touches');
  ok(w.document.getElementById('rc-user').value === '6', 'employee pre-selected');
  ok(w.document.getElementById('rc-city').value === 'ORL', 'city pre-selected from the series, not home_city default');
  ok(w.document.getElementById('rc-pos').value === '2', 'position pre-selected');
  ok(w.document.getElementById('rc-mode').value === 'rotation', 'mode pre-selected');
  ok(w.document.getElementById('rc-rot-block').style.display !== 'none' && w.document.getElementById('rc-dow-block').style.display === 'none', 'rotation block shown, weekday block hidden');
  ok(w.document.getElementById('rc-days-on').value === '4' && w.document.getElementById('rc-days-off').value === '2', 'days on/off pre-filled');
  ok(w.document.getElementById('rc-start').value === '06:00' && w.document.getElementById('rc-end').value === '18:00', 'times pre-filled');
  ok(w.document.getElementById('rc-startdate').value === '2026-08-31' && w.document.getElementById('rc-weeks').value === '10', 'start date + weeks');
  ok(w.document.getElementById('rc-break').value === '30' && w.document.getElementById('rc-notes').value === 'rot' && w.document.getElementById('rc-mgr-notes').value === 'series note', 'break, notes, manager notes');
  ok(h.indexOf('Update schedule') !== -1 && h.indexOf('schedSwitchType') === -1, 'Update button, no Single/Recurring toggle');
  w.document.getElementById('rc-start').value = '07:00';
  w.document.getElementById('rc-applyfrom').value = '2026-09-14';
  CALLS = []; API['PUT /schedule/series/7'] = { series_id: 7, apply_from: '2026-09-14', removed: 20, created: 20 };
  await w.schedSaveRecurring();
  put = CALLS.filter(function (c) { return c.method === 'PUT'; })[0];
  ok(put && put.path === '/schedule/series/7', 'PUTs the series');
  ok(put && put.body.apply_from === '2026-09-14' && put.body.start_time === '07:00' && put.body.mode === 'rotation' && String(put.body.days_on) === '4', 'body carries apply_from + the edited definition');
  ok(CALLS.some(function (c) { return c.toast && c.toast.indexOf('Recurring schedule updated: replaced 20') === 0; }), 'toast summarises');
  ok(w._schedSeriesId === null, 'series edit state cleared');
  // the weekly variant pre-checks the right days
  API['GET /schedule/series/8'] = Object.assign({}, SERIES, { id: 8, mode: 'weekly', weekdays: [1, 3, 5], days_on: null, days_off: null, start_date: '2027-01-04', future_shifts: 3 });
  await w.schedEditSeries(8);
  var checked = Array.prototype.map.call(w.document.querySelectorAll('.rc-dow:checked'), function (c) { return c.value; });
  ok(JSON.stringify(checked) === JSON.stringify(['1', '3', '5']), 'weekly: Mon/Wed/Fri pre-checked (got ' + checked.join(',') + ')');
  ok(w.document.getElementById('rc-applyfrom').value === '2027-01-04', 'Apply-from defaults to the start date when it is still ahead');
  ok(w.document.getElementById('rc-dow-block').style.display !== 'none', 'weekday block shown');

  section('history labels');
  ok(w.schedFieldLabel('manager_notes') === 'Manager notes', 'manager_notes label');
  ok(w.schedEventDetail({ details: { via: 'delete_future' } }).indexOf('Delete this + all future') !== -1, 'delete_future via label');
  ok(w.schedEventDetail({ details: { via: 'series_update' } }).indexOf('recurring-schedule update') !== -1, 'series_update via label');

  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(2); });
