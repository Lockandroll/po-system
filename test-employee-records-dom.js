'use strict';
/*
 * Render harness for the employee-record form: the wording check, supporting
 * documentation, and the policy citation.
 *
 * public/js/employeeRecords.js is a classic script, so it is evaluated inside a
 * vm context holding the handful of globals app.js normally provides (api,
 * escHtml, can, showToast, state, formatDate) plus a hand-rolled document. No
 * jsdom - this checkout does not have it, and every render in this file writes
 * a string into innerHTML, so a string is all the harness has to catch.
 *
 * What it pins:
 *   - the wording check no longer fires while you type: rendering the form,
 *     blurring a field and taking a suggestion make ZERO calls to /check;
 *   - the Supporting documentation card, and the sentence warning that the
 *     employee can open whatever is attached;
 *   - upload is presign -> PUT -> confirm, in that order, with the key the
 *     server handed back and never one the browser made up;
 *   - files picked in the New Record modal are held and uploaded only once the
 *     note comes back with an id;
 *   - a file over 25MB is refused before any network call;
 *   - the documents show up on the timeline, on the approver's screen and on
 *     the employee's own My File, and not on a record that has none;
 *   - Policy or SOP violated is a dropdown off the SOP library with an Other
 *     fallback, and Suggest policy offers quoted clauses without ever selecting
 *     one for you.
 *
 *   node test-employee-records-dom.js
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

var SRC = fs.readFileSync('public/js/employeeRecords.js', 'utf8');

var DOCS = [
  { id: 12, record_id: 77, filename: 'door-damage.jpg', content_type: 'image/jpeg', size_bytes: 244000,
    uploaded_by_name: 'Manager', created_at: '2026-08-20T12:00:00Z' },
  { id: 13, record_id: 77, filename: 'SOP-14-signed.pdf', content_type: 'application/pdf', size_bytes: 91000,
    uploaded_by_name: 'Manager', created_at: '2026-08-20T12:05:00Z' }
];

function fixtures() {
  return {
    '/employee-records/meta': {
      levels: [
        { n: 1, label: 'Verbal Warning (documented)' }, { n: 2, label: 'First Written Warning' },
        { n: 3, label: 'Second Written Warning' }, { n: 4, label: 'Final Written Warning' },
        { n: 5, label: 'Termination' }
      ],
      categories: ['Attendance', 'Cash handling', 'Safety'],
      policies: [
        { value: 'sop:4', source: 'sop', id: 4, title: 'SOP-9 Dispatch and Enroute', group: 'SOP library' },
        { value: 'sop:7', source: 'sop', id: 7, title: 'SOP-14 Attendance and Punctuality', group: 'SOP library' },
        { value: 'doc:9', source: 'document', id: 9, title: 'Dispatch Policy.pdf', group: 'Policy folder' }
      ],
      consequences: { '1': 'Any further occurrence will result in a First Written Warning.' },
      default_escalation_days: 90
    },
    '/employee-records/employee/9': {
      user: { id: 9, name: 'Julia Nguyen', role: 'locksmith', home_city: 'VAB', has_email: true,
              supervisor: { id: 2, name: 'Julius Sherman' } },
      can_act: true,
      ladder: { highest_live: 0, suggested_next: 1, suggested_label: 'Verbal Warning (documented)', live_count: 0, priors: [] },
      late_deposits: { count: 0, available: true }, shortages: { count: 0, total: 0 },
      records: [
        { id: 77, type: 'disciplinary', level: 1, level_label: 'Verbal Warning (documented)', category: 'Attendance',
          status: 'draft', body: 'Arrived 40 minutes late on 08/18.', corrective_action: 'Be on shift at 08:00.',
          consequence: 'Any further occurrence will result in a First Written Warning.',
          occurred_on: '2026-08-18', followup_on: '2026-09-17', escalation_days: 90,
          created_by_name: 'Manager', visible_to_employee: false, attachments: DOCS },
        { id: 79, type: 'disciplinary', level: 1, level_label: 'Verbal Warning (documented)', category: 'Safety',
          status: 'draft', body: 'Left the van unlocked.', corrective_action: 'Lock the van.',
          consequence: 'Any further occurrence will result in a First Written Warning.',
          sop_id: 7, sop_label: 'SOP-14 Attendance and Punctuality', occurred_on: '2026-08-19',
          followup_on: '2026-09-18', created_by_name: 'Manager', visible_to_employee: false, attachments: [] },
        { id: 80, type: 'disciplinary', level: 1, level_label: 'Verbal Warning (documented)', category: 'Safety',
          status: 'draft', body: 'Older notice.', corrective_action: 'Do the thing.',
          consequence: 'Any further occurrence will result in a First Written Warning.',
          sop_id: null, sop_label: 'Unwritten shop rule about the gate', occurred_on: '2026-08-01',
          followup_on: '2026-09-01', created_by_name: 'Manager', visible_to_employee: false, attachments: [] },
        { id: 78, type: 'coaching', category: 'Safety', status: 'active', body: 'Talked through ladder safety.',
          occurred_on: '2026-08-10', created_by_name: 'Manager', visible_to_employee: true, attachments: [] }
      ]
    },
    '/employee-records/77/attachments': { attachments: DOCS },
    '/employee-records/approvals': [
      { id: 90, level_label: 'First Written Warning', employee_name: 'Julia Nguyen', category: 'Attendance',
        body: 'Second late arrival.', corrective_action: 'Be on shift at 08:00.',
        consequence: 'Any further occurrence...', submitted_at: '2026-08-24', created_by_name: 'Manager',
        ai_check: null, attachments: DOCS }
    ],
    '/employee-records/me': {
      records: [
        { id: 90, type: 'disciplinary', level_label: 'First Written Warning', status: 'sent', needs_signature: true,
          body: 'Second late arrival.', corrective_action: 'Be on shift at 08:00.', consequence: 'Any further...',
          created_by_name: 'Manager', approver_name: 'Julius Sherman', attachments: DOCS },
        { id: 78, type: 'coaching', status: 'active', body: 'Talked through ladder safety.',
          occurred_on: '2026-08-10', created_by_name: 'Manager', attachments: [] }
      ]
    },
    '/employee-records/attachments/12/download': { success: true, url: 'https://r2.test/signed/door-damage.jpg' },
    '/employee-records/policy-suggest': {
      available: true, reason: 'ok', searched: 6,
      candidates: [
        { source: 'sop', sop_id: 4, document_id: null, title: 'SOP-9 Dispatch and Enroute',
          quote: 'Technicians must enroute an assigned call within 10 minutes of acceptance.',
          why: 'The call sat 20 minutes after assignment.' },
        { source: 'document', sop_id: null, document_id: 9, title: 'Dispatch Policy.pdf',
          quote: 'Contact the customer before changing status to enroute.',
          why: 'Straight out of the policy folder.' }
      ]
    },
    '/employee-records/notes': { success: true, id: 501 },
    '/employee-records/disciplinary': { success: true, id: 77, record: { id: 77, level: 1, status: 'draft' } }
  };
}

function makeWin(tweak) {
  var FIX = fixtures();
  if (tweak) tweak(FIX);
  var els = {};
  var w = {};

  function mkEl(id) {
    return {
      id: id, innerHTML: '', value: '', textContent: '', className: '', disabled: false,
      style: {}, options: [], selectedIndex: 0, parentNode: null, files: null, onchange: null,
      setAttribute: function (k, v) { this['attr_' + k] = String(v); },
      getAttribute: function (k) { return this['attr_' + k] === undefined ? null : this['attr_' + k]; },
      appendChild: function () {}, removeChild: function () {},
      querySelectorAll: function () { return []; }, addEventListener: function () {},
      getBoundingClientRect: function () { return { left: 0, top: 0 }; },
      // A picked-file dialog: whatever the test staged is what the page sees.
      click: function () { this.files = w.__files || []; if (this.onchange) this.onchange(); }
    };
  }

  w.window = w;
  w.console = console;
  w.setTimeout = setTimeout;
  w.confirm = function () { return true; };
  w.prompt = function () { return 'because'; };
  w.alert = function () {};
  w.open = function (u) { w.opened.push(u); };
  w.opened = [];
  w.apiCalls = [];
  w.puts = [];
  w.toasts = [];
  w.__files = [];

  w.document = {
    head: { appendChild: function () {} },
    body: { appendChild: function (n) { w.lastModal = n; }, removeChild: function () {} },
    getElementById: function (id) { if (!els[id]) els[id] = mkEl(id); return els[id]; },
    createElement: function (tag) { var e = mkEl('created-' + tag); e.tagName = tag; return e; },
    addEventListener: function () {}
  };
  w.__els = els;
  w.addEventListener = function () {};

  w.api = function (method, path, body) {
    w.apiCalls.push({ method: method, path: path, body: body });
    if (method === 'GET' && FIX[path]) return Promise.resolve(JSON.parse(JSON.stringify(FIX[path])));
    if (method === 'POST' && FIX[path]) return Promise.resolve(JSON.parse(JSON.stringify(FIX[path])));
    if (/\/attachments\/upload-url$/.test(path)) {
      var recId = path.split('/')[2];
      return Promise.resolve({ success: true, url: 'https://r2.test/put/' + recId,
        key: 'employee-records/' + recId + '/1756000000000-file.bin' });
    }
    if (/\/attachments\/confirm$/.test(path)) return Promise.resolve({ success: true, attachment: DOCS[0] });
    return Promise.resolve({ success: true });
  };
  w.fetch = function (url, opts) { w.puts.push({ url: url, method: opts && opts.method }); return Promise.resolve({ ok: true, status: 200 }); };
  w.escHtml = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  w.showToast = function (m, t) { w.toasts.push({ msg: m, kind: t }); };
  w.can = function () { return true; };
  w.state = { user: { id: 2, name: 'Manager' } };
  w.formatDate = function (d) { return String(d).slice(0, 10); };

  vm.createContext(w);
  vm.runInContext(SRC, w);
  return w;
}

// The picked-file callbacks are async and their promises are dropped by the
// DOM contract (onchange returns nothing), so drain the queue instead.
function settle() {
  return new Promise(function (r) { setTimeout(r, 0); }).then(function () {
    return new Promise(function (r) { setTimeout(r, 0); });
  }).then(function () { return new Promise(function (r) { setTimeout(r, 0); }); })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); })
    .then(function () { return new Promise(function (r) { setTimeout(r, 0); }); });
}

function fakeFile(name, size, type) { return { name: name, size: size, type: type || 'application/octet-stream' }; }
function checkCalls(w) { return w.apiCalls.filter(function (c) { return /\/check$/.test(c.path); }); }

async function main() {
  console.log('Employee record form - rendering');
  console.log('-------------------------------');
  console.log('');
  console.log('The wording check waits to be asked');

  var w = makeWin();
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  var form = w.document.getElementById('content').innerHTML;

  eq(checkCalls(w).length, 0, 'opening the form runs no wording check');
  lacks(form, 'onblur', 'no field re-checks itself when you leave it');
  has(form, 'onclick="erCheckWording(true)"', 'the Check wording button is still the way in');
  has(form, 'Only runs when you click it', 'and the hint under it says exactly that');
  has(form, 'it does not run while you', 'the right-hand explainer agrees');
  has(form, 'Any further occurrence will result in a First Written Warning.',
      'the consequence is still pre-filled for the suggested level');

  // Taking a suggestion rewrites the box and stops there.
  w.document.getElementById('er-body').value = 'He is always late and does not care.';
  var before = checkCalls(w).length;
  await w.erCheckWording(true);
  eq(checkCalls(w).length, before + 1, 'asking for a check explicitly still runs one');

  console.log('');
  console.log('The Supporting documentation card');

  has(form, 'Supporting documentation', 'the card is on the disciplinary form');
  has(form, 'onclick="erAddAttachments()"', 'with a way to add files');
  has(form, 'id="er-attach-list"', 'and a list that can be refreshed in place');
  has(form, 'Up to 25MB each', 'the size limit is stated up front');
  has(form, 'Julia can open anything attached here', 'and so is the fact that the employee will see them');
  has(form, 'not for your working notes', 'which is the whole reason to say it');

  // Editing an existing draft shows what is already attached.
  w.erEditDisciplinary(77);
  var edit = w.document.getElementById('content').innerHTML;
  has(edit, 'door-damage.jpg', 'an attached photo is listed by name');
  has(edit, 'SOP-14-signed.pdf', 'so is the signed policy page');
  has(edit, 'erOpenAttachment(12)', 'clicking the name opens it');
  has(edit, 'erRemoveAttachment(13)', 'and there is a way to take one off');
  has(edit, '238 KB', 'the size is shown in something human');
  has(edit, 'JPG', 'the type tag comes off the extension');
  has(edit, 'PDF', 'for both of them');

  console.log('');
  console.log('Uploading is presign, PUT, confirm');

  w = makeWin();
  await w.erOpenFile(9);
  w.__files = [fakeFile('receipt.pdf', 120000, 'application/pdf')];
  w.erAttachTo(77);
  await settle();

  var upload = w.apiCalls.filter(function (c) { return /attachments/.test(c.path); });
  eq(upload.length >= 2, true, 'two API calls surround the upload');
  eq(upload[0].path, '/employee-records/77/attachments/upload-url', 'first, ask the server where to put it');
  eq(upload[0].body.filename, 'receipt.pdf', 'the real filename goes with the request');
  eq(upload[0].body.size_bytes, 120000, 'and the size, so an oversize file is refused server-side too');
  eq(w.puts.length, 1, 'the bytes go straight to storage');
  eq(w.puts[0].method, 'PUT', 'with a PUT');
  eq(w.puts[0].url, 'https://r2.test/put/77', 'to the presigned URL the server handed back');
  eq(upload[1].path, '/employee-records/77/attachments/confirm', 'then confirm it landed');
  eq(upload[1].body.key, 'employee-records/77/1756000000000-file.bin',
     'confirm echoes the SERVER key, never one the browser invented');

  console.log('');
  console.log('A file that is too big never reaches the network');

  w = makeWin();
  await w.erOpenFile(9);
  w.__files = [fakeFile('bodycam.mp4', 40 * 1024 * 1024, 'video/mp4')];
  w.erAttachTo(77);
  await settle();
  eq(w.apiCalls.filter(function (c) { return /attachments/.test(c.path); }).length, 0,
     'no presign is requested for a 40MB file');
  eq(w.puts.length, 0, 'and nothing is uploaded');
  has(JSON.stringify(w.toasts), '25MB', 'the person is told why');

  console.log('');
  console.log('Files picked on a record that does not exist yet');

  w = makeWin();
  await w.erOpenFile(9);
  w.erNewRecord('coaching');
  var modal = w.lastModal.innerHTML;
  has(modal, 'Supporting documentation', 'the New Record modal takes files too');
  has(modal, 'onclick="erQueueFiles()"', 'through a queue, because there is no record id yet');
  has(modal, 'If this record is shared, the files are shared with it', 'and it says what that means');

  w.__files = [fakeFile('timesheet.csv', 4000, 'text/csv')];
  w.erQueueFiles();
  await settle();
  has(w.document.getElementById('er-queue').innerHTML, 'timesheet.csv', 'a picked file shows in the queue');
  has(w.document.getElementById('er-queue').innerHTML, 'erUnqueue(0)', 'and can be taken back out');
  eq(w.apiCalls.filter(function (c) { return /attachments/.test(c.path); }).length, 0,
     'nothing is uploaded while the note is still being written');

  // Switching record type rebuilds the modal and must not drop the queue.
  w.erNewRecord('performance', true);
  has(w.lastModal.innerHTML, 'timesheet.csv',
      'switching the record type keeps the files you already picked');

  w.document.getElementById('er-body').value = 'Missed two shifts.';
  await w.erSaveNote('coaching');
  await settle();
  var seq = w.apiCalls.map(function (c) { return c.method + ' ' + c.path; });
  eq(seq.indexOf('POST /employee-records/notes') !== -1, true, 'the note is saved first');
  eq(seq.indexOf('POST /employee-records/501/attachments/upload-url') !== -1, true,
     'then the queue is uploaded against the id it came back with');
  ok(seq.indexOf('POST /employee-records/notes') < seq.indexOf('POST /employee-records/501/attachments/upload-url'),
     'in that order, never the other way round');

  // A fresh New Record starts empty.
  w.erNewRecord('recognition');
  has(w.lastModal.innerHTML, '<div id="er-queue"></div>', 'opening a new record starts with an empty queue');

  console.log('');
  console.log('Where the documents show up');

  w = makeWin();
  await w.erOpenFile(9);
  var timeline = w.document.getElementById('er-tabbody').innerHTML;
  has(timeline, 'door-damage.jpg', 'the timeline card shows what is attached');
  has(timeline, 'erOpenAttachment(12)', 'and each one opens');
  has(timeline, 'erAttachTo(77)', 'an existing record can take another file');
  var coachingCard = timeline.slice(timeline.indexOf('ladder safety'));
  lacks(coachingCard, 'er-chip', 'a record with nothing attached renders no chip row at all');

  await w.erOpenApprovals();
  var approvals = w.document.getElementById('content').innerHTML;
  has(approvals, 'Supporting documentation', 'the approver sees the evidence heading');
  has(approvals, 'door-damage.jpg', 'and the documents themselves');
  has(approvals, 'erOpenAttachment(13)', 'openable from the approval screen');

  w = makeWin();
  await w.renderMyFile(w.document.getElementById('content'));
  var mine = w.document.getElementById('er-mine').innerHTML;
  has(mine, 'Needs your signature', 'the employee still gets their notice');
  has(mine, 'door-damage.jpg', 'with the evidence attached to it');
  has(mine, 'erOpenAttachment(12)', 'which they can open');
  var shared = mine.slice(mine.indexOf('Shared with you'));
  lacks(shared, 'er-chip', 'and a shared note with no documents shows no chips');

  await w.erOpenAttachment(12);
  eq(w.opened[0], 'https://r2.test/signed/door-damage.jpg', 'opening one follows the short-lived signed URL');

  console.log('');
  console.log('Policy or SOP violated is a dropdown');

  w = makeWin();
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  form = w.document.getElementById('content').innerHTML;

  has(form, 'id="er-sop-id"', 'the policy field is a select');
  has(form, 'SOP-9 Dispatch and Enroute', 'listing the SOP library');
  has(form, 'SOP-14 Attendance and Punctuality', 'all of it');
  has(form, '>None cited<', 'with an explicit way to cite nothing');
  has(form, 'Other (type it in)', 'and a fallback for a policy that is not in either list');
  has(form, '<optgroup label="SOP library">', 'library entries are grouped');
  has(form, '<optgroup label="Policy folder">', 'and so are files out of the vault policy folder');
  has(form, 'Dispatch Policy.pdf', 'a vault policy document is offered by filename');
  has(form, 'value="doc:9"', 'carrying which source it came from');
  has(form, 'onclick="erSuggestPolicy()"', 'Suggest policy sits next to it');
  has(form, 'only clauses it can quote out of a real document', 'and the form says what that means');
  has(form, 'Document Vault folder marked as a policy source', 'naming both places a policy can live');
  var sopBox = form.slice(form.indexOf('id="er-sop"'), form.indexOf('id="er-sop"') + 220);
  has(sopBox, 'display:none', 'the free-text box is hidden until you ask for it');

  // A notice that already cites a library SOP comes back selected.
  w.erEditDisciplinary(79);
  var cited = w.document.getElementById('content').innerHTML;
  has(cited, '<option value="sop:7" selected>SOP-14', 'an existing citation is preselected');
  lacks(cited, '<option value="other" selected>', 'and does not fall through to Other');

  // A notice written before the library existed keeps its typed text.
  w.erEditDisciplinary(80);
  var typed = w.document.getElementById('content').innerHTML;
  has(typed, '<option value="other" selected>', 'a free-text citation selects Other');
  has(typed, 'Unwritten shop rule about the gate', 'and keeps what was typed');
  var typedBox = typed.slice(typed.indexOf('id="er-sop"'), typed.indexOf('id="er-sop"') + 220);
  lacks(typedBox, 'display:none', 'with the box visible so it can be edited');

  console.log('');
  console.log('Suggest policy reads the incident and quotes the SOP');

  w = makeWin();
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  await w.erSuggestPolicy();
  eq(w.apiCalls.filter(function (c) { return /policy-suggest/.test(c.path); }).length, 0,
     'with no incident written, nothing is sent');
  has(JSON.stringify(w.toasts), 'Describe the incident first', 'and the person is told why');

  w.document.getElementById('er-body').value =
    'On 08/25/2026 Austin did not enroute an assigned Geico call for 20 minutes.';
  await w.erSuggestPolicy();
  var sent = w.apiCalls.filter(function (c) { return /policy-suggest/.test(c.path); });
  eq(sent.length, 1, 'the incident goes to the suggester');
  has(sent[0].body.body, 'did not enroute an assigned Geico call', 'as written, not summarised');

  var out = w.document.getElementById('er-pol-out').innerHTML;
  has(out, 'SOP-9 Dispatch and Enroute', 'the best match is offered first');
  has(out, 'Technicians must enroute an assigned call within 10 minutes', 'with the clause quoted');
  has(out, 'The call sat 20 minutes after assignment.', 'and why it applies');
  has(out, 'erUsePolicy(0)', 'each one can be taken');
  has(out, 'erUsePolicy(1)', 'including the runner-up');
  has(out, 'could not quote out of a real document was dropped', 'and the panel says what was filtered out');
  eq(w.document.getElementById('er-sop-id').value, '', 'nothing is selected for you');

  w.erUsePolicy(0);
  eq(w.document.getElementById('er-sop-id').value, 'sop:4', 'clicking one selects that SOP');
  eq(w.document.getElementById('er-sop').value, 'SOP-9 Dispatch and Enroute',
     'and fills the printed label from its title');

  // The second candidate came out of the vault, and selecting it must set the
  // document citation rather than a SOP one.
  w.erUsePolicy(1);
  eq(w.document.getElementById('er-sop-id').value, 'doc:9', 'a vault policy selects the vault option');
  eq(w.document.getElementById('er-sop').value, 'Dispatch Policy.pdf', 'and prints the filename on the notice');
  await w.erSaveDraft(true);
  var vaultSave = w.apiCalls.filter(function (c) { return c.path === '/employee-records/disciplinary'; }).pop();
  eq(vaultSave.body.policy_document_id, 9, 'which saves as policy_document_id');
  eq(vaultSave.body.sop_id, null, 'and not as a SOP id');
  w.erUsePolicy(0);

  // The saved draft carries the id, not just the words.
  await w.erSaveDraft(true);
  var saved = w.apiCalls.filter(function (c) { return c.path === '/employee-records/disciplinary'; }).pop();
  eq(saved.body.sop_id, 4, 'the draft saves the SOP id');
  eq(saved.body.policy_document_id, null, 'and leaves the vault citation empty');
  eq(saved.body.sop_label, 'SOP-9 Dispatch and Enroute', 'and the label that gets printed on the notice');

  console.log('');
  console.log('An empty answer explains itself');

  w = makeWin(function (FIX) {
    FIX['/employee-records/policy-suggest'] = { available: true, reason: 'no_match', searched: 4, candidates: [] };
  });
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  w.document.getElementById('er-body').value = 'Something no SOP covers.';
  await w.erSuggestPolicy();
  has(w.document.getElementById('er-pol-out').innerHTML, 'Nothing in your policy documents covers what you described',
      'no match says so plainly');
  has(w.document.getElementById('er-pol-out').innerHTML, 'Settings &gt; SOPs', 'and points at the fix');

  w = makeWin(function (FIX) {
    FIX['/employee-records/policy-suggest'] = { available: false, reason: 'no_key', candidates: [] };
  });
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  w.document.getElementById('er-body').value = 'Anything.';
  await w.erSuggestPolicy();
  has(w.document.getElementById('er-pol-out').innerHTML, 'AI is not configured',
      'an unconfigured deployment is a different message from an empty library');

  w = makeWin(function (FIX) { FIX['/employee-records/meta'].policies = []; });
  await w.erOpenFile(9);
  w.erNewDisciplinary();
  has(w.document.getElementById('content').innerHTML, 'Nothing indexed yet',
      'with nothing indexed the field tells you to type it instead');

  console.log('');
  console.log(PASS + ' passed, ' + FAIL + ' failed');
  process.exit(FAIL ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
