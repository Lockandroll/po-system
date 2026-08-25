'use strict';
/*
 * Render harness for the inspection checklist editor's Retired items panel.
 *
 * The editor used to load with ?all=1, which returned deactivated items too, so
 * reopening the page showed every question ever created and saving from that
 * screen turned them all back on. These assertions pin the replacement: the
 * editor loads only the live checklist, and removed items appear once, at the
 * bottom, in a panel that can restore them or delete them for good.
 *
 *   node test-inspection-checklist-dom.js
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(c, l) { if (c) PASS++; else { FAIL++; console.error('  FAIL: ' + l); } }
function eq(a, b, l) { ok(a === b, l + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(h, n, l) { ok(String(h).indexOf(n) !== -1, l + '  (missing: ' + n + ')'); }
function lacks(h, n, l) { ok(String(h).indexOf(n) === -1, l + '  (unexpectedly present: ' + n + ')'); }

var SRC = fs.readFileSync('public/js/app.js', 'utf8');

// ---- the editor must not ask for retired items ------------------------------
lacks(SRC, "/inspections/checklist?all=1", 'nothing in app.js loads the checklist with ?all=1');
has(SRC, "await api('GET', '/inspections/checklist/archive')", 'the editor loads the retired list separately');
has(SRC, "'<div style=\"margin-top:6px\"><strong>Remove item</strong>", 'the explainer says what Remove item does');

// ---- load the retired-panel slice out of app.js -----------------------------
var start = SRC.indexOf('function inspClArchiveHtml() {');
var end = SRC.indexOf('function inspClRerender() {');
ok(start > 0 && end > start, 'found the retired-items slice in app.js');
var slice = SRC.slice(start, end);
ok(slice.indexOf('`') === -1, 'the slice is backtick-free (Windows-safe)');

var els = {};
function fakeEl(id) { return { id: id, innerHTML: '', style: {} }; }
var doc = { getElementById: function (id) { return els[id] || null; } };
var CALLS = [];
var API_THROWS = null;
function apiStub(method, path, body) {
  CALLS.push({ method: method, path: path, body: body });
  if (API_THROWS) return Promise.reject(new Error(API_THROWS));
  return Promise.resolve({ success: true });
}
var CONFIRMED = true, LAST_CONFIRM = null, RERENDERS = 0;
function confirmStub(msg) { LAST_CONFIRM = msg; return Promise.resolve(CONFIRMED); }
var WIN = {};

var m = new Function(
  'window', 'document', 'escHtml', 'formatDate', 'api', 'novaConfirm', 'renderInspectionChecklistAdmin',
  slice + '\nreturn { inspClArchiveHtml: inspClArchiveHtml, inspClRestore: inspClRestore, inspClPurge: inspClPurge, inspClMsg: inspClMsg };'
)(
  WIN, doc,
  function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  function (d) { return 'Aug 20, 2026'; },
  apiStub, confirmStub,
  function () { RERENDERS++; return Promise.resolve(); }
);

// ---- empty state -------------------------------------------------------------
WIN._inspClArchive = [];
eq(m.inspClArchiveHtml(), '', 'no retired items means no panel at all');
WIN._inspClArchive = undefined;
eq(m.inspClArchiveHtml(), '', 'an unloaded archive renders nothing rather than throwing');

// ---- populated ---------------------------------------------------------------
WIN._inspClArchive = [
  { id: 7, item_key: 'brakes', label: 'Brakes', type: 'dropdown', requires_photo: false,
    options: [{ label: 'OK', color: 'green' }, { label: 'Fail', color: 'red', followup: true }],
    retired_at: '2026-08-20T14:05:00.000Z', retired_by_name: 'Tony McKeon' },
  { id: 8, item_key: 'odometer', label: 'Odometer <reading>', type: 'dropdown', requires_photo: true,
    options: [{ label: 'OK', color: 'green' }], retired_at: null, retired_by_name: null },
  { id: 9, item_key: 'concerns', label: 'Other concerns', type: 'text', requires_photo: false, options: null,
    retired_at: '2026-08-20T14:05:00.000Z', retired_by_name: 'Tony McKeon' }
];
var html = m.inspClArchiveHtml();
has(html, 'Retired items (3)', 'the panel counts what is in it');
has(html, 'no longer asked on an inspection', 'the panel says these questions are not asked');
has(html, 'keep their answers either way', 'the panel reassures about submitted inspections');
has(html, '>Brakes<', 'a retired item is listed by label');
has(html, '2 answers', 'a dropdown item shows how many answers it had');
has(html, 'Write-in', 'a text item is described as a write-in');
has(html, 'retired Aug 20, 2026', 'the retirement date is shown');
has(html, 'by Tony McKeon', 'and who did it');
has(html, '&middot; photo', 'a photo-required item says so');
eq((html.match(/Restore</g) || []).length, 3, 'every retired item can be restored');
eq((html.match(/Delete forever</g) || []).length, 3, 'and deleted for good');
has(html, 'inspClRestore(7)', 'restore is wired to the archive row id');
has(html, 'inspClPurge(9)', 'delete is wired to the archive row id');
has(html, 'Odometer &lt;reading&gt;', 'labels are escaped, not injected');
lacks(html, '<reading>', 'no raw markup from a label reaches the page');
eq((html.match(/1 answers/g) || []).length, 0, 'a single answer is not pluralised');
has(html, '1 answer &middot; photo', 'and reads correctly on its own');

// ---- restore -----------------------------------------------------------------
CALLS.length = 0; RERENDERS = 0; CONFIRMED = false;
(async function () {
  await m.inspClRestore(7);
  eq(CALLS.length, 0, 'declining the confirm restores nothing');
  eq(RERENDERS, 0, 'and does not redraw the page');
  has(LAST_CONFIRM, 'bottom of the list', 'the confirm says where the item comes back');
  has(LAST_CONFIRM, 'unsaved edits', 'and warns that unsaved edits are reloaded');

  CONFIRMED = true;
  await m.inspClRestore(7);
  eq(CALLS.length, 1, 'confirming sends one request');
  eq(CALLS[0].method, 'POST', 'restore is a POST');
  eq(CALLS[0].path, '/inspections/checklist/archive/7/restore', 'to the archive row');
  eq(RERENDERS, 1, 'and the editor is redrawn from the server');

  // ---- delete forever --------------------------------------------------------
  CALLS.length = 0; RERENDERS = 0; CONFIRMED = false;
  await m.inspClPurge(9);
  eq(CALLS.length, 0, 'declining the confirm deletes nothing');
  has(LAST_CONFIRM, 'cannot be restored', 'the delete confirm says it is permanent');
  has(LAST_CONFIRM, 'keep their answers', 'and that history survives it');

  CONFIRMED = true;
  await m.inspClPurge(9);
  eq(CALLS[0].method, 'DELETE', 'delete is a DELETE');
  eq(CALLS[0].path, '/inspections/checklist/archive/9', 'to the archive row');
  eq(RERENDERS, 1, 'and the editor is redrawn');

  // ---- failures surface ------------------------------------------------------
  els['insp-cl-msg'] = fakeEl('insp-cl-msg');
  WIN.scrollTo = function () {};
  API_THROWS = 'A checklist item with that name is already active.';
  CALLS.length = 0; RERENDERS = 0;
  await m.inspClRestore(8);
  has(els['insp-cl-msg'].innerHTML, 'already active', 'a failed restore shows the reason');
  has(els['insp-cl-msg'].innerHTML, 'alert-error', 'as an error alert');
  eq(RERENDERS, 0, 'and does not pretend it worked');
  API_THROWS = null;

  console.log('\n  ' + PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
})();
