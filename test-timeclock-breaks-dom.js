'use strict';
/*
 * Render harness for the time-clock break sub-rows.
 *
 * The timesheet used to collapse every lunch and break into one "Unpaid: 70m"
 * cell. These assertions pin the replacement: an indented row per break under
 * its day, showing which kind it was, when it started and ended, and what it
 * did to the day's worked total — plus the manager's edit controls, the week
 * Lunch/Breaks chips, and (the easy thing to break) the column counts.
 *
 *   node test-timeclock-breaks-dom.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

// ---- load the real time-clock slice out of app.js --------------------------
var SRC = fs.readFileSync('public/js/app.js', 'utf8');
var start = SRC.indexOf('function tcInjectStyles(){');
var end = SRC.indexOf('function tcInjectOrgStyles(){');
ok(start > 0 && end > start, 'found the time-clock slice in app.js');
var slice = SRC.slice(start, end);
ok(slice.indexOf('`') === -1, 'the time-clock slice is backtick-free (Windows-safe)');

var els = {};
function fakeEl(id) {
  return { id: id, value: '', innerHTML: '', textContent: '', style: {}, appendChild: function () {}, contains: function () { return false; } };
}
var doc = {
  getElementById: function (id) { return els[id] || null; },
  createElement: function () { return fakeEl('created'); },
  head: { appendChild: function () {} },
  body: { contains: function () { return false; } },
  querySelectorAll: function () { return []; }
};
var CALLS = [];
function apiStub(method, path, body) { CALLS.push({ method: method, path: path, body: body }); return Promise.resolve(API_REPLY); }
var API_REPLY = {};

var tc = new Function(
  'window', 'document', 'escHtml', 'api', 'novaAlert', 'novaPrompt', 'setInterval', 'clearInterval', 'alert', 'confirm',
  slice + '\nreturn {' +
  ' tcBreakMins:tcBreakMins, tcBreakUnpaid:tcBreakUnpaid, tcBreakLabel:tcBreakLabel,' +
  ' tcSortedBreaks:tcSortedBreaks, tcEntryUnpaid:tcEntryUnpaid, tcEntryPaidBreak:tcEntryPaidBreak,' +
  ' tcBreakRowsHtml:tcBreakRowsHtml, tcBreakdownHtml:tcBreakdownHtml, tcMgrDetailHtml:tcMgrDetailHtml,' +
  ' tcRenderMySheet:tcRenderMySheet, tcSaveBreak:tcSaveBreak, tcDeleteBreak:tcDeleteBreak,' +
  ' tcCreateBreak:tcCreateBreak, tcClock:tcClock, tcHM:tcHM,' +
  ' setAddRow:function(v){_tcAddBrkEntry=v;}, getAddRow:function(){return _tcAddBrkEntry;} };'
)(
  { _tcHost: null }, doc,
  function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  apiStub,
  function (m) { LAST_ALERT = m; return Promise.resolve(); },
  function () { return Promise.resolve(PROMPT_REPLY); },
  function () { return 0; }, function () {}, function () {}, function () { return true; }
);
var LAST_ALERT = null, PROMPT_REPLY = 'fixing a bad punch';

// ---- fixtures --------------------------------------------------------------
// Wed Aug 19 from the screenshot: 8:59a-1:00p with a 70-minute lunch.
function iso(h, m) { return new Date(2026, 7, 19, h, m, 0).toISOString(); }
var ENTRY = {
  id: 77, status: 'closed', clock_in_at: iso(8, 59), clock_out_at: iso(13, 0), worked_minutes: 171,
  breaks: [
    { id: 501, type: 'paid', break_start_at: iso(11, 0), break_end_at: iso(11, 15) },
    { id: 500, type: 'unpaid', break_start_at: iso(9, 30), break_end_at: iso(10, 40) }
  ]
};
var OPEN_ENTRY = {
  id: 78, status: 'open', clock_in_at: iso(14, 0), clock_out_at: null, worked_minutes: null,
  breaks: [{ id: 502, type: 'unpaid', break_start_at: iso(15, 0), break_end_at: null }]
};
var BARE = { id: 79, status: 'closed', clock_in_at: iso(6, 30), clock_out_at: iso(13, 0), worked_minutes: 390, breaks: [] };

// Count the columns a row spans, honouring colspan — a sub-row that miscounts
// silently shears the table.
function rowWidths(html) {
  return (html.match(/<tr[\s\S]*?<\/tr>/g) || []).map(function (tr) {
    var w = 0, m, re = /<td([^>]*)>/g;
    while ((m = re.exec(tr))) { var c = /colspan="(\d+)"/.exec(m[1]); w += c ? parseInt(c[1], 10) : 1; }
    return w;
  });
}

console.log('\n--- break math -------------------------------------------------');
eq(tc.tcBreakMins(ENTRY.breaks[1]), 70, 'unpaid lunch is 70 minutes');
eq(tc.tcBreakMins(ENTRY.breaks[0]), 15, 'paid break is 15 minutes');
eq(tc.tcBreakMins(OPEN_ENTRY.breaks[0]), 0, 'a running break contributes 0 until it ends');
eq(tc.tcBreakMins(null), 0, 'a missing break is 0, not NaN');
eq(tc.tcEntryUnpaid(ENTRY), 70, 'only the unpaid break lands in the entry unpaid total');
eq(tc.tcEntryPaidBreak(ENTRY), 15, 'the paid break totals separately');
eq(tc.tcEntryUnpaid(BARE), 0, 'a day with no breaks totals 0 unpaid');
ok(tc.tcBreakUnpaid({ type: 'unpaid' }), 'type unpaid reads as unpaid');
ok(!tc.tcBreakUnpaid({ type: 'paid' }), 'type paid reads as paid');
ok(tc.tcBreakUnpaid({}), 'an unknown break type is treated as unpaid (never silently free time)');
eq(tc.tcBreakLabel({ type: 'unpaid' }), 'Lunch (unpaid)', 'unpaid is labelled the way the punch screen labels it');
eq(tc.tcBreakLabel({ type: 'paid' }), 'Break (paid)', 'paid is labelled the way the punch screen labels it');
eq(tc.tcSortedBreaks(ENTRY).map(function (b) { return b.id; }).join(','), '500,501', 'breaks render in the order they happened, not the order the API returned');

console.log('\n--- read-only sub-rows -----------------------------------------');
var ro = tc.tcBreakRowsHtml(ENTRY, 5, false);
has(ro, 'Lunch (unpaid)', 'read-only row names the lunch');
has(ro, 'Break (paid)', 'read-only row names the paid break');
has(ro, '&#8627;', 'sub-rows are visually indented under their day');
has(ro, tc.tcClock(ENTRY.breaks[1].break_start_at), 'lunch start time is shown');
has(ro, tc.tcClock(ENTRY.breaks[1].break_end_at), 'lunch end time is shown');
has(ro, '>70m<', 'the lunch duration is shown, not just a week total');
has(ro, '&minus;' + tc.tcHM(70), 'the unpaid row states what it took off the day');
has(ro, '15m paid', 'the paid row states it was not deducted');
lacks(ro, '<input', 'read-only rows carry no inputs');
lacks(ro, 'tcSaveBreak', 'read-only rows carry no save button');
lacks(ro, 'Add lunch or break', 'read-only rows carry no add link');
eq(rowWidths(ro).join(','), '5,5', 'read-only rows are 5 columns wide in the 5-column table');
eq(rowWidths(tc.tcBreakRowsHtml(ENTRY, 6, false)).join(','), '6,6', 'read-only rows are 6 columns wide in the 6-column table');
eq(tc.tcBreakRowsHtml(BARE, 5, false), '', 'a day with no breaks adds no sub-rows');

var roOpen = tc.tcBreakRowsHtml(OPEN_ENTRY, 5, false);
has(roOpen, 'running', 'a break in progress shows as running rather than 0m');
has(roOpen, 'on break now', 'a break in progress says so in the worked column');
lacks(roOpen, '&minus;0:00', 'a break in progress does not claim to have deducted anything yet');

console.log('\n--- editable sub-rows ------------------------------------------');
tc.setAddRow(null);
var ed = tc.tcBreakRowsHtml(ENTRY, 6, true);
has(ed, 'id="tcbs-500"', 'lunch start is editable');
has(ed, 'id="tcbe-500"', 'lunch end is editable');
has(ed, 'id="tcbt-500"', 'the paid/unpaid type is changeable');
has(ed, '<option value="unpaid" selected>', 'the unpaid break preselects unpaid');
has(ed, '<option value="paid" selected>', 'the paid break preselects paid');
has(ed, 'tcSaveBreak(500)', 'each break has its own Save');
has(ed, 'tcDeleteBreak(500)', 'each break can be removed');
has(ed, 'tcAddBreakRow(77)', 'a day offers to add a forgotten break');
eq(rowWidths(ed).join(','), '6,6,6', 'editable rows plus the add link are all 6 columns wide');
eq(rowWidths(tc.tcBreakRowsHtml(BARE, 6, true)).join(','), '6', 'a break-less day still offers the add link, at full width');

tc.setAddRow(77);
var adding = tc.tcBreakRowsHtml(ENTRY, 6, true);
has(adding, 'id="tcnbs-77"', 'the add form has a start field');
has(adding, 'id="tcnbe-77"', 'the add form has an end field');
has(adding, 'tcCreateBreak(77)', 'the add form submits');
has(adding, 'tcCancelAddBreak()', 'the add form can be dismissed');
lacks(adding, 'tcAddBreakRow(77)', 'the add link is replaced by the form, not shown alongside it');
eq(rowWidths(adding).join(','), '6,6,6', 'the add form row is 6 columns wide');
eq(rowWidths(tc.tcBreakRowsHtml(BARE, 6, true)).join(','), '6', 'a different day keeps its add link while another is being edited');
tc.setAddRow(null);

console.log('\n--- week summary chips -----------------------------------------');
var bd = { regular: 2400, overtime: 0, holiday: 0, vacation: 0 };
var chips = tc.tcBreakdownHtml(bd, [ENTRY, OPEN_ENTRY, BARE]);
has(chips, '>Lunch<', 'the week summary gained a Lunch chip');
has(chips, '>Breaks<', 'the week summary gained a paid Breaks chip');
has(chips, '>' + tc.tcHM(70) + '<', 'the Lunch chip totals the unpaid breaks');
has(chips, '>' + tc.tcHM(15) + '<', 'the Breaks chip totals the paid breaks');
has(chips, '>Regular<', 'the existing Regular chip survived');
has(chips, '>Vacation<', 'the existing Vacation chip survived');
var chipsNoEntries = tc.tcBreakdownHtml(bd);
lacks(chipsNoEntries, '>Lunch<', 'without entries the break chips are omitted rather than showing 0:00');
eq(tc.tcBreakdownHtml(null, [ENTRY]), '', 'no breakdown still renders nothing');

console.log('\n--- manager detail table ---------------------------------------');
var U = { user: { id: 4, name: 'Joseph Lyttle' }, entries: [ENTRY, BARE], approval: { status: 'emp_approved' }, canApprove: true, breakdown: bd, minutes: 2400 };
var det = tc.tcMgrDetailHtml(U, '2026-08-17');
has(det, 'Lunch (unpaid)', 'the manager detail lists the lunch by name');
has(det, 'tcSaveBreak(500)', 'the manager can correct a break from the detail table');
has(det, '>Lunch<', 'the manager detail shows the week Lunch chip');
var detRows = rowWidths(det.slice(det.indexOf('<tbody>'), det.indexOf('</tbody>')));
eq(detRows.filter(function (w) { return w !== 6; }).length, 0, 'every manager detail row is 6 columns wide  (' + detRows.join(',') + ')');

var LOCKED = { user: { id: 4, name: 'Joseph Lyttle' }, entries: [ENTRY], approval: { status: 'submitted' }, canApprove: true, breakdown: bd, minutes: 2400 };
var lock = tc.tcMgrDetailHtml(LOCKED, '2026-08-17');
has(lock, 'Lunch (unpaid)', 'a submitted week still SHOWS the break detail');
lacks(lock, 'tcSaveBreak(', 'a submitted week offers no break editing');
lacks(lock, 'tcDeleteBreak(', 'a submitted week offers no break removal');
lacks(lock, 'tcAddBreakRow(', 'a submitted week offers no break adding');
var lockRows = rowWidths(lock.slice(lock.indexOf('<tbody>'), lock.indexOf('</tbody>')));
eq(lockRows.filter(function (w) { return w !== 6; }).length, 0, 'every locked detail row is 6 columns wide  (' + lockRows.join(',') + ')');

console.log('\n--- my timesheet -----------------------------------------------');
var host = fakeEl('tc-body');
API_REPLY = { from: '2026-08-17', to: '2026-08-23', entries: [ENTRY, BARE], approval: { status: 'open' }, breakdown: bd, holidays: [] };
var done = tc.tcRenderMySheet(host).then(function () {
  has(host.innerHTML, 'Lunch (unpaid)', 'the employee sees the lunch broken out too');
  has(host.innerHTML, '15m paid', 'the employee sees the paid break, marked as paid');
  lacks(host.innerHTML, 'tcSaveBreak(', 'the employee cannot edit breaks from their own sheet');
  var myRows = rowWidths(host.innerHTML.slice(host.innerHTML.indexOf('<tbody>'), host.innerHTML.indexOf('</tbody>')));
  eq(myRows.filter(function (w) { return w !== 5; }).length, 0, 'every My Timesheet row is 5 columns wide  (' + myRows.join(',') + ')');

  console.log('\n--- break edit actions -----------------------------------------');
  els['tcbs-500'] = fakeEl('tcbs-500'); els['tcbs-500'].value = '2026-08-19T09:35';
  els['tcbe-500'] = fakeEl('tcbe-500'); els['tcbe-500'].value = '2026-08-19T10:40';
  els['tcbt-500'] = fakeEl('tcbt-500'); els['tcbt-500'].value = 'paid';
  CALLS = []; PROMPT_REPLY = 'employee clocked back early';
  return tc.tcSaveBreak(500);
}).then(function () {
  eq(CALLS.length, 1, 'saving a break makes exactly one request');
  eq(CALLS[0].method, 'PATCH', 'a break correction is a PATCH');
  eq(CALLS[0].path, '/timeclock/break/500', 'it targets the break, not the entry');
  eq(CALLS[0].body.type, 'paid', 'the chosen type is sent');
  eq(CALLS[0].body.reason, 'employee clocked back early', 'the reason is sent');
  ok(CALLS[0].body.break_start_at && CALLS[0].body.break_end_at, 'both times are sent as ISO');

  // End before start must never reach the server.
  els['tcbe-500'].value = '2026-08-19T09:00';
  CALLS = []; LAST_ALERT = null;
  return tc.tcSaveBreak(500);
}).then(function () {
  eq(CALLS.length, 0, 'a break ending before it starts is refused client-side');
  has(LAST_ALERT, 'after the break start', 'and the refusal says why');

  // Cancelling the reason prompt cancels the whole edit.
  els['tcbe-500'].value = '2026-08-19T10:40';
  CALLS = []; PROMPT_REPLY = null;
  return tc.tcSaveBreak(500);
}).then(function () {
  eq(CALLS.length, 0, 'backing out of the reason prompt sends nothing');
  CALLS = []; PROMPT_REPLY = '   ';
  return tc.tcSaveBreak(500);
}).then(function () {
  eq(CALLS.length, 0, 'a blank reason sends nothing');

  CALLS = []; PROMPT_REPLY = 'break was punched twice';
  return tc.tcDeleteBreak(501);
}).then(function () {
  eq(CALLS.length, 1, 'removing a break makes exactly one request');
  eq(CALLS[0].method, 'DELETE', 'removal is a DELETE');
  eq(CALLS[0].path, '/timeclock/break/501', 'removal targets the break');
  eq(CALLS[0].body.reason, 'break was punched twice', 'removal carries its reason');

  els['tcnbs-77'] = fakeEl('tcnbs-77'); els['tcnbs-77'].value = '2026-08-19T09:30';
  els['tcnbe-77'] = fakeEl('tcnbe-77'); els['tcnbe-77'].value = '2026-08-19T10:40';
  els['tcnbt-77'] = fakeEl('tcnbt-77'); els['tcnbt-77'].value = 'unpaid';
  CALLS = []; PROMPT_REPLY = 'forgot to punch lunch';
  return tc.tcCreateBreak(77);
}).then(function () {
  eq(CALLS.length, 1, 'adding a break makes exactly one request');
  eq(CALLS[0].method, 'POST', 'adding is a POST');
  eq(CALLS[0].path, '/timeclock/entry/77/break', 'adding hangs off the entry');
  eq(CALLS[0].body.type, 'unpaid', 'the added break carries its type');

  els['tcnbs-77'].value = '';
  CALLS = []; LAST_ALERT = null;
  return tc.tcCreateBreak(77);
}).then(function () {
  eq(CALLS.length, 0, 'adding a break with no start time is refused client-side');
  eq(tc.getAddRow(), null, 'the add form closes itself after a successful add');
});

done.then(function () {
  console.log('\n' + PASS + ' passed, ' + FAIL + ' failed\n');
  process.exit(FAIL ? 1 : 0);
}, function (e) { console.error(e); process.exit(1); });
