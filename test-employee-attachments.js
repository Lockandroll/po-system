'use strict';
/*
 * Supporting documentation on an employee record: the gates and the migration.
 *
 * There is no Postgres in this checkout, so this does not exercise SQL. What it
 * does exercise is the part that is actually dangerous:
 *
 *   1. canReadAttachments() - the ONLY thing standing between a photo attached
 *      to a disciplinary notice and somebody who should not see it. It has four
 *      doors (manager in scope, the record's author on their own draft, the
 *      approver while it is with them, the employee once it is shared) and the
 *      failure that matters is a door being wider than it looks.
 *   2. canWriteAttachments() - who may add and remove.
 *   3. attachKey() - a client never gets to name where a file lives.
 *   4. The db.js migration obeys CLAUDE.md 1.4: every column in the CREATE has a
 *      matching ALTER TABLE ... ADD COLUMN IF NOT EXISTS, because CREATE TABLE
 *      IF NOT EXISTS adds nothing to a table that already exists.
 *
 * The two gate functions are lifted out of routes/employeeRecords.js by text and
 * run against stubs, so the test reads the real shipped source rather than a
 * copy that can drift.
 *
 *   node test-employee-attachments.js
 *
 * House style: string concatenation only, no template literals.
 */
var fs = require('fs');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, label) { ok(String(hay).indexOf(needle) !== -1, label + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, label) { ok(String(hay).indexOf(needle) === -1, label + '  (unexpected: ' + needle + ')'); }

var ROUTES = fs.readFileSync('routes/employeeRecords.js', 'utf8');
var DB = fs.readFileSync('db.js', 'utf8');
var FRONT = fs.readFileSync('public/js/employeeRecords.js', 'utf8');

// ---- lift a function out of the real source -------------------------------
function fnSrc(src, signature) {
  var i = src.indexOf(signature);
  if (i === -1) return null;
  var open = src.indexOf('{', i);
  var depth = 0;
  for (var k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}

async function main() {
console.log('Employee record attachments');
console.log('---------------------------');
console.log('');
console.log('Source shape');

lacks(ROUTES, '`', 'routes/employeeRecords.js is backtick-free (CLAUDE.md 1.1)');
lacks(FRONT, '`', 'public/js/employeeRecords.js is backtick-free');

var readSrc = fnSrc(ROUTES, 'async function canReadAttachments(req, rec) {');
var writeSrc = fnSrc(ROUTES, 'async function canWriteAttachments(req, rec) {');
var keySrc = fnSrc(ROUTES, 'function attachKey(recordId, filename) {');
ok(!!readSrc, 'canReadAttachments() found in the shipped route file');
ok(!!writeSrc, 'canWriteAttachments() found in the shipped route file');
ok(!!keySrc, 'attachKey() found in the shipped route file');

// Constants come out of the source too, so editing the list in db-land breaks
// this test rather than silently widening the gate.
var mHidden = ROUTES.match(/var EMPLOYEE_HIDDEN_STATUSES = (\[[^\]]*\]);/);
ok(!!mHidden, 'EMPLOYEE_HIDDEN_STATUSES is declared');
var HIDDEN = JSON.parse(mHidden[1].replace(/'/g, '"'));
var mPrefix = ROUTES.match(/var ATTACH_PREFIX = '([^']+)';/);
ok(!!mPrefix, 'ATTACH_PREFIX is declared');
var PREFIX = mPrefix[1];

['draft', 'pending_approval', 'returned', 'void'].forEach(function (st) {
  ok(HIDDEN.indexOf(st) !== -1, 'an employee never sees status "' + st + '"');
});

// GET /me filters on the same four. If these two lists ever disagree, one of
// them is letting something through.
var meQuery = ROUTES.slice(ROUTES.indexOf("router.get('/me'"), ROUTES.indexOf("router.get('/me'") + 900);
HIDDEN.forEach(function (st) {
  has(meQuery, "'" + st + "'", 'GET /me hides the same status: ' + st);
});

console.log('');
console.log('Routes are mounted');

has(ROUTES, "router.post('/:id/attachments/upload-url', requireAuth, requirePermission('create_employee_note')", 'upload-url is gated on create_employee_note');
has(ROUTES, "router.post('/:id/attachments/confirm', requireAuth, requirePermission('create_employee_note')", 'confirm is gated on create_employee_note');
has(ROUTES, "router.get('/:id/attachments', requireAuth, async", 'the list route uses the hand-written gate, not requirePermission');
has(ROUTES, "router.get('/attachments/:aid/download', requireAuth, async", 'download uses the hand-written gate (the employee holds no record permission)');
has(ROUTES, "router.delete('/attachments/:aid', requireAuth, requirePermission('create_employee_note')", 'delete is gated on create_employee_note');
has(ROUTES, "if (!key || key.indexOf(ATTACH_PREFIX + rec.id + '/') !== 0)", 'confirm refuses a key it did not hand out for THIS record');
has(ROUTES, 'r2.headObject(key)', 'confirm asks R2 whether the object actually arrived');
has(ROUTES, "logEvent(rec.id, 'attachment_added'", 'adding a document lands in the record history');
has(ROUTES, "logEvent(rec.id, 'attachment_removed'", 'removing one lands there too');
has(ROUTES, 'attachmentsByRecord(rows.map', 'the file, My File and approvals load attachments in one query, not per row');
eq((ROUTES.match(/attachmentsByRecord\(rows\.map/g) || []).length, 3, 'all three list endpoints carry the documents');

console.log('');
console.log('Who may READ a record\'s documents');

function gates(stub) {
  var make = new Function('viewerHasPerm', 'inScope', 'canActOn', 'EMPLOYEE_HIDDEN_STATUSES', 'ATTACH_PREFIX',
    readSrc + '\n' + writeSrc + '\n' + keySrc + '\n' +
    'return { read: canReadAttachments, write: canWriteAttachments, key: attachKey };');
  return make(stub.viewerHasPerm, stub.inScope, stub.canActOn, HIDDEN, PREFIX);
}

var MANAGER = { user: { id: 2, name: 'Manager' } };
var STRANGER = { user: { id: 3, name: 'Stranger' } };
var EMPLOYEE = { user: { id: 7, name: 'Employee' } };
var APPROVER = { user: { id: 4, name: 'Approver' } };

function rec(over) {
  return Object.assign({
    id: 55, user_id: 7, created_by: 2, approver_id: 4,
    status: 'signed', visible_to_employee: true, type: 'disciplinary'
  }, over || {});
}

// The manager door: view_employee_records AND in scope.
var inScopeAll = gates({
  viewerHasPerm: async function (req, perm) { return perm === 'view_employee_records' && req.user.id === 2; },
  inScope: async function () { return true; },
  canActOn: async function () { return { ok: true }; }
});
eq(await (inScopeAll.read(MANAGER, rec())), true, 'a manager in scope can read them');
eq(await (inScopeAll.read(STRANGER, rec())), false, 'somebody without view_employee_records cannot');
eq(await (inScopeAll.read(MANAGER, rec({ status: 'draft', created_by: 2 }))), true, 'the author can read their own draft\'s files');
eq(await (inScopeAll.read(MANAGER, rec({ status: 'draft', created_by: 99 }))), false, 'nobody else can read another manager\'s draft - not even an admin');
eq(await (inScopeAll.read(MANAGER, null)), false, 'a missing record reads as no');

// Same permission, out of scope. This is the one that leaks a whole company.
var outOfScope = gates({
  viewerHasPerm: async function (req, perm) { return perm === 'view_employee_records'; },
  inScope: async function () { return false; },
  canActOn: async function () { return { ok: true }; }
});
eq(await (outOfScope.read(MANAGER, rec())), false, 'the permission alone is not enough - scope still decides');

// The employee's own door.
var employeeOnly = gates({
  viewerHasPerm: async function () { return false; },
  inScope: async function () { return false; },
  canActOn: async function () { return { ok: true }; }
});
eq(await (employeeOnly.read(EMPLOYEE, rec({ status: 'signed', visible_to_employee: true }))), true,
   'the employee can open the evidence on their own signed notice');
eq(await (employeeOnly.read(EMPLOYEE, rec({ visible_to_employee: false }))), false,
   'an internal record keeps its files internal');
for (var hi = 0; hi < HIDDEN.length; hi++) {
  eq(await employeeOnly.read(EMPLOYEE, rec({ status: HIDDEN[hi], visible_to_employee: true })), false,
     'the employee sees nothing on a ' + HIDDEN[hi] + ' record, even one flagged visible');
}
eq(await (employeeOnly.read(STRANGER, rec())), false, 'a colleague with no permission gets nothing');

// The approver's door, which exists because an approver may hold
// approve_discipline and nothing else.
var approverOnly = gates({
  viewerHasPerm: async function (req, perm) { return perm === 'approve_discipline' && req.user.id === 4; },
  inScope: async function () { return false; },
  canActOn: async function () { return { ok: true }; }
});
eq(await (approverOnly.read(APPROVER, rec({ status: 'pending_approval' }))), true,
   'the approver can open the evidence while it is sitting with them');
eq(await (approverOnly.read(APPROVER, rec({ status: 'signed' }))), false,
   'and that door closes once the notice is no longer theirs to decide');
eq(await (approverOnly.read(APPROVER, rec({ status: 'pending_approval', approver_id: 999 }))), false,
   'being an approver of something else is not a door');

console.log('');
console.log('Who may ADD or REMOVE');

var writeOk = gates({
  viewerHasPerm: async function () { return true; },
  inScope: async function () { return true; },
  canActOn: async function () { return { ok: true }; }
});
eq((await writeOk.write(MANAGER, rec())).ok, true, 'a manager who may write the record may attach to it');
eq((await writeOk.write(MANAGER, rec({ status: 'void' }))).ok, false, 'nothing is attached to a void record');
eq((await writeOk.write(MANAGER, rec({ status: 'draft', created_by: 99 }))).ok, false, 'and not to somebody else\'s draft');
eq((await writeOk.write(MANAGER, null)).ok, false, 'a missing record refuses');
eq((await writeOk.write(MANAGER, rec({ status: 'sent' }))).ok, true,
   'attaching to an already-issued notice is allowed - evidence arrives late');

var writeDenied = gates({
  viewerHasPerm: async function () { return true; },
  inScope: async function () { return true; },
  canActOn: async function () { return { ok: false, why: 'You cannot write a record about someone you report to.' }; }
});
var denied = await writeDenied.write(MANAGER, rec());
eq(denied.ok, false, 'canActOn still decides - you cannot attach to your own boss\'s file');
has(denied.why, 'report to', 'and the real reason comes back, not a generic Forbidden');

console.log('');
console.log('The upload key');

var k = writeOk.key(55, 'my photo (1).jpg');
eq(k.indexOf(PREFIX + '55/'), 0, 'the key is prefixed with the record it belongs to');
eq(k.split('/').length, 3, 'a filename cannot add path segments of its own');
lacks(k.slice((PREFIX + '55/').length), ' ', 'spaces are stripped out of the stored key');
var nasty = writeOk.key(55, '../../other-employee/evidence.pdf');
eq(nasty.indexOf(PREFIX + '55/'), 0, 'a traversal-shaped filename still lands under this record');
eq(nasty.split('/').length, 3, 'and cannot climb out of it');

console.log('');
console.log('The migration (CLAUDE.md 1.4)');

var createStart = DB.indexOf("'CREATE TABLE IF NOT EXISTS employee_record_attachments ('");
ok(createStart > 0, 'the CREATE TABLE exists in db.js');
var createBlock = DB.slice(createStart, DB.indexOf(');', createStart));
var alterStart = DB.indexOf('var _eraCols = [');
ok(alterStart > 0, 'the matching ALTER TABLE column list exists');
var alterBlock = DB.slice(alterStart, DB.indexOf('];', alterStart));

var cols = [];
createBlock.split('\n').forEach(function (line) {
  var m = line.match(/'\s{2}([a-z0-9_]+) /);
  if (m && m[1] !== 'id') cols.push(m[1]);
});
ok(cols.length >= 8, 'parsed the column list out of the CREATE  (got ' + cols.length + ')');
cols.forEach(function (c) {
  has(alterBlock, "'" + c + " ", 'column "' + c + '" also has an ADD COLUMN IF NOT EXISTS');
});
has(DB, 'CREATE INDEX IF NOT EXISTS employee_record_attachments_rec_idx', 'the record_id index is created');
has(createBlock, 'REFERENCES employee_records(id) ON DELETE CASCADE', 'deleting a record takes its attachment rows with it');

console.log('');
console.log('The wording check no longer runs on every edit');

lacks(FRONT, 'onblur="erCheckWording()"', 'no textarea re-checks itself on blur');
has(FRONT, "onclick=\"erCheckWording(true)\"", 'the explicit Check wording button is still there');
has(FRONT, 'Only runs when you click it', 'and the form says so');
has(ROUTES, 'check.available && check.reds > 0', 'submit still refuses a notice with red flags');

console.log('');
console.log(PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
