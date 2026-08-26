'use strict';
/*
 * Vault documents as searchable text.
 *
 * The promise Tony asked for is small and exact: a file uploaded to the policy
 * folder becomes words the AI can read, and deleting the file removes the words.
 * The parts of that worth testing without a database are:
 *
 *   - only PDFs and plain text are ever read, and the checks happen in an order
 *     where the cheap disqualifiers come first;
 *   - forgetting a document clears BOTH tables. document_text holds the body and
 *     document_chunks holds what is actually searched; they hang off documents
 *     independently, so deleting one and not the other would leave a folder
 *     quotable after its policy flag was switched off;
 *   - the policy tree is RECURSIVE, so a subfolder of Policies counts;
 *   - the migration keeps its cascade, which is what makes "delete the file and
 *     the words go" true at the database rather than in a job somebody has to
 *     remember to run.
 *
 *   node test-doc-text.js
 *
 * House style: string concatenation only, no template literals.
 */
var fs = require('fs');
var docText = require('./utils/docText');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, label) { ok(String(hay).indexOf(needle) !== -1, label + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, label) { ok(String(hay).indexOf(needle) === -1, label + '  (unexpected: ' + needle + ')'); }

// A pg-shaped stub that records every statement and answers from a script.
function fakeDb(answers) {
  var calls = [];
  return {
    calls: calls,
    query: function (sql, params) {
      calls.push({ sql: String(sql), params: params || [] });
      for (var i = 0; i < (answers || []).length; i++) {
        if (String(sql).indexOf(answers[i].match) !== -1) return Promise.resolve({ rows: answers[i].rows });
      }
      return Promise.resolve({ rows: [] });
    },
    sqlWith: function (needle) {
      return calls.filter(function (c) { return c.sql.indexOf(needle) !== -1; });
    }
  };
}

async function main() {
console.log('Vault documents as text');
console.log('-----------------------');
console.log('');
console.log('What is worth reading');

eq(docText.kindFor('application/pdf', 'policy.pdf'), 'pdf', 'a PDF by mime type');
eq(docText.kindFor('application/octet-stream', 'Dispatch Policy.PDF'), 'pdf', 'and by extension when the mime is useless');
eq(docText.kindFor('text/plain', 'notes.txt'), 'text', 'plain text');
eq(docText.kindFor('application/octet-stream', 'rules.md'), 'text', 'markdown');
eq(docText.kindFor('text/csv', 'x.csv'), 'text', 'csv');
eq(docText.kindFor('image/png', 'scan.png'), null, 'an image is not read');
eq(docText.kindFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'policy.docx'), null,
   'and neither is a Word file - it would need a converter Nova does not have');
eq(docText.kindFor('', ''), null, 'nothing at all is not read');

console.log('');
console.log('Only policy folders, and all the way down');

has(docText.POLICY_TREE_CTE, 'WITH RECURSIVE', 'the policy tree is recursive');
has(docText.POLICY_TREE_CTE, 'policy_source = true', 'rooted on the folder flag');
has(docText.POLICY_TREE_CTE, 'JOIN policy_tree t ON f.parent_id = t.id', 'and walks down into subfolders');

var db = fakeDb([{ match: 'FROM policy_tree', rows: [{ n: 1 }] }]);
await docText.isPolicyFolder(db, 12);
has(db.calls[0].sql, 'WITH RECURSIVE', 'a folder check uses the same tree');

db = fakeDb([]);
eq(await docText.isPolicyDocument(db, 5), false, 'a document outside the tree is not a policy document');
has(db.calls[0].sql, 'policy_tree', 'and the check is the tree, not the folder name');

db = fakeDb([{ match: 'SELECT d.id FROM documents', rows: [{ id: 3 }, { id: 9 }] }]);
var ids = await docText.policyDocumentIds(db);
eq(ids.join(','), '3,9', 'the bulk indexer takes every ready file under the tree');
has(db.calls[0].sql, "d.status = 'ready'", 'skipping uploads that never finished');

console.log('');
console.log('Forgetting a document clears BOTH tables');

db = fakeDb([]);
await docText.clearDocuments(db, [4, 5]);
eq(db.sqlWith('DELETE FROM document_chunks').length, 1, 'the searchable chunks go');
eq(db.sqlWith('DELETE FROM document_text').length, 1, 'and so does the extracted body');
ok(db.calls[0].sql.indexOf('document_chunks') !== -1,
   'chunks first, so a failure halfway leaves nothing searchable rather than the reverse');

db = fakeDb([{ match: 'SELECT id FROM documents WHERE folder_id', rows: [{ id: 7 }, { id: 8 }] }]);
var n = await docText.clearFolders(db, [2, 3]);
eq(n, 2, 'clearing a folder clears every document under it');
eq(db.sqlWith('DELETE FROM document_chunks').length, 1, 'chunks again');
eq(db.sqlWith('DELETE FROM document_text').length, 1, 'and text again');

eq(await docText.clearDocuments(fakeDb([]), []), 0, 'clearing nothing is not an error');
eq(await docText.clearFolders(fakeDb([]), []), 0, 'nor is clearing no folders');

console.log('');
console.log('Nothing is read that should not be');

db = fakeDb([]);
var r = await docText.indexDocument(db, 999);
eq(r.status, 'failed', 'a document that does not exist fails cleanly');
lacks(JSON.stringify(db.calls), 'INSERT INTO document_text', 'and writes no status row');

db = fakeDb([{ match: 'FROM documents WHERE id', rows: [{ id: 1, name: 'x.pdf', r2_key: 'k', mime_type: 'application/pdf', size_bytes: 10, status: 'pending' }] }]);
r = await docText.indexDocument(db, 1);
eq(r.status, 'pending', 'an unfinished upload is left alone');

db = fakeDb([{ match: 'FROM documents WHERE id', rows: [{ id: 2, name: 'photo.png', r2_key: 'k', mime_type: 'image/png', size_bytes: 10, status: 'ready' }] }]);
r = await docText.indexDocument(db, 2);
eq(r.status, 'unsupported', 'an image records why it cannot be read');
eq(db.sqlWith('FROM documents WHERE id').length, 1, 'and the file is never pulled out of storage');

db = fakeDb([{ match: 'FROM documents WHERE id', rows: [{ id: 3, name: 'huge.pdf', r2_key: 'k', mime_type: 'application/pdf', size_bytes: docText.MAX_BYTES + 1, status: 'ready' }] }]);
r = await docText.indexDocument(db, 3);
eq(r.status, 'too_large', 'an oversized file is refused before it is downloaded');
has(db.sqlWith('INSERT INTO document_text')[0].sql, 'ON CONFLICT (document_id) DO UPDATE',
    'the status row is an upsert, so re-reading a file replaces its old result');

// R2 is not configured in a checkout, which is exactly the next branch.
db = fakeDb([{ match: 'FROM documents WHERE id', rows: [{ id: 4, name: 'p.pdf', r2_key: 'k', mime_type: 'application/pdf', size_bytes: 100, status: 'ready' }] }]);
r = await docText.indexDocument(db, 4);
ok(['unavailable', 'failed', 'ok', 'no_text'].indexOf(r.status) !== -1,
   'with no storage configured it records a status rather than throwing  (got ' + r.status + ')');

console.log('');
console.log('The bulk re-read');

db = fakeDb([
  { match: 'SELECT d.id FROM documents', rows: [{ id: 11 }, { id: 12 }] },
  { match: "status = 'ok'", rows: [{ status: 'ok' }] }
]);
var bulk = await docText.reindexPolicyFolders(db, { onlyMissing: true });
eq(bulk.total, 2, 'it walks every policy document');
eq(bulk.skipped, 2, 'and skips the ones already read');
eq(bulk.files.length, 0, 'reporting nothing re-done');

console.log('');
console.log('The migration keeps the promise');

var DB = fs.readFileSync('db.js', 'utf8');
var i = DB.indexOf('CREATE TABLE IF NOT EXISTS document_text');
ok(i > 0, 'document_text is created');
var textBlock = DB.slice(i, DB.indexOf(');', i));
has(textBlock, 'REFERENCES documents(id) ON DELETE CASCADE', 'and dies with its document');
var j = DB.indexOf('CREATE TABLE IF NOT EXISTS document_chunks');
ok(j > 0, 'document_chunks is created');
var chunkBlock = DB.slice(j, DB.indexOf(');', j));
has(chunkBlock, 'REFERENCES documents(id) ON DELETE CASCADE', 'and so does the searchable half');
has(chunkBlock, "to_tsvector('english', content)", 'chunks are searchable the same way SOP chunks are');
has(DB, 'document_chunks_tsv_idx', 'with the GIN index that makes that fast');
has(DB, 'ALTER TABLE document_folders ADD COLUMN IF NOT EXISTS policy_source', 'folders carry the policy flag');
has(DB, "LOWER(TRIM(name)) IN ('policies','policy')", 'a folder already called Policies is flagged once');
has(DB, 'policy_folder_seeded', 'guarded by a settings key, so un-ticking it later sticks');

console.log('');
console.log('Wired into the vault');

var DOCS = fs.readFileSync('routes/documents.js', 'utf8');
lacks(DOCS, String.fromCharCode(96), 'routes/documents.js is backtick-free');
has(DOCS, 'docText.isPolicyDocument(pool, id)', 'a finished upload is checked against the policy tree');
has(DOCS, 'docText.indexInBackground(pool, id)', 'and read in the background rather than blocking the upload');
has(DOCS, 'docText.clearFolders(pool, descendantFolderIds(ctx, id))', 'un-ticking a folder deletes its words');
has(DOCS, 'docText.clearDocuments(pool, [id])', 'and so does moving a file out of one');
has(DOCS, "req.user.role !== 'admin'", 'the policy flag is admin-only');
has(DOCS, "router.post('/reindex-policies'", 'there is a way to read what is already uploaded');
has(DOCS, 'text_status', 'the listing says whether each file produced words');

var AI = fs.readFileSync('routes/ai.js', 'utf8');
has(AI, 'document_chunks dc JOIN documents doc', 'Neurolock searches the policy folders too');
has(AI, 'folder_id IN (SELECT id FROM policy_tree)', 'and only the policy folders');
has(AI, 'falling back to SOPs', 'with a fallback if that migration has not landed');

var PS = fs.readFileSync('utils/policySuggest.js', 'utf8');
has(PS, 'UNION ALL', 'the policy suggester searches both sources at once');
has(PS, "doc.status = 'ready'", 'ignoring half-finished uploads');
has(PS, 'perDoc[key]', 'and budgets excerpts per document rather than per id');

var ER = fs.readFileSync('routes/employeeRecords.js', 'utf8');
has(ER, "t.status = 'ok'", 'the dropdown only offers documents that actually produced text');
has(ER, 'policy_document_id', 'and a notice records which vault file it cited');

console.log('');
console.log(PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
