// Vault documents, turned into words the AI can read.
//
// The Document Vault keeps bytes in R2 and only a pointer row in Postgres, so
// nothing in Nova has ever been able to read what is INSIDE a vault file. This
// module is the bridge: pull the object back, extract its text, chunk it, and
// index it the same way SOP documents are indexed, so one query can search both.
//
// THREE RULES THAT ARE LOAD-BEARING
//
//  1. ONLY policy-source folders are indexed. The vault is share-scoped - a file
//     is visible to its owner and to whoever it was shared with - but a policy
//     quoted onto a disciplinary notice is shown to whoever is writing the
//     notice, which is wider. So indexing is opt-in per folder, ticked by an
//     admin, and the toggle says out loud what it means. Nothing else in the
//     vault is ever extracted.
//
//  2. THE TEXT DIES WITH THE FILE. document_text and document_chunks both hang
//     off documents with ON DELETE CASCADE, so deleting a file - or the folder
//     above it - removes the words in the same statement. There is no cleanup
//     job to forget to run, and no way for a deleted policy to keep being quoted.
//
//  3. IT NEVER THROWS. A PDF that will not open, a missing library, an R2 blip:
//     each records a status against the document and returns. An upload must
//     never fail because the indexer had a bad day, and a manager must never see
//     a stack trace because somebody put a .heic in the Policies folder.
//
// status values, which the vault screen shows verbatim:
//   ok           - text extracted and indexed
//   no_text      - opened fine, produced (almost) nothing. A scan with no text
//                  layer. This is the one worth telling somebody about: it looks
//                  uploaded and it is unsearchable.
//   unsupported  - not a PDF or a plain-text file
//   too_large    - past the size we are willing to pull back out of R2
//   unavailable  - storage or the pdf library is not configured here
//   failed       - it threw; detail carries the message
const { chunkSopText } = require('./sopIndex');
const r2 = require('./r2');

var MAX_BYTES = 40 * 1024 * 1024;   // do not drag anything bigger back out of R2
var MAX_TEXT = 400000;              // characters stored per document
var MIN_TEXT = 40;                  // below this it is a scan, not a document

// Every folder marked as a policy source, plus everything nested under it. A
// subfolder of Policies is policy too, and saying so once here means the search
// query and the bulk indexer can never disagree about which files are in scope.
var POLICY_TREE_CTE =
  'WITH RECURSIVE policy_tree AS (' +
  '  SELECT id FROM document_folders WHERE policy_source = true' +
  '  UNION ALL' +
  '  SELECT f.id FROM document_folders f JOIN policy_tree t ON f.parent_id = t.id' +
  ')';

function kindFor(mime, name) {
  var m = String(mime || '').toLowerCase();
  var n = String(name || '').toLowerCase();
  if (m.indexOf('pdf') !== -1 || /\.pdf$/.test(n)) return 'pdf';
  if (m.indexOf('text/') === 0 || /\.(txt|md|markdown|csv|tsv|log|json)$/.test(n)) return 'text';
  return null;
}

// pdfjs-dist is required lazily and inside a try. A checkout without it (or a
// deploy where the install failed) must still boot and still serve the vault -
// documents simply come back 'unavailable' until it is there.
function loadPdfjs() {
  try {
    return require('pdfjs-dist/legacy/build/pdf.js');
  } catch (e) {
    return null;
  }
}

// Text out of a PDF, page by page, keeping the line breaks pdfjs reports. Line
// structure matters: the chunker prefers paragraph boundaries, and a wall of
// undifferentiated text chunks badly.
async function extractPdf(buf) {
  var pdfjs = loadPdfjs();
  if (!pdfjs) {
    return { status: 'unavailable', detail: 'pdfjs-dist is not installed on this deployment.', text: '', pages: null };
  }
  var doc = null;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      useSystemFonts: true,
      isEvalSupported: false,
      // Nothing here renders a page, so the font machinery is dead weight.
      disableFontFace: true
    }).promise;
    var pages = doc.numPages;
    var out = [];
    for (var p = 1; p <= pages; p++) {
      var page = await doc.getPage(p);
      var tc = await page.getTextContent();
      var line = '', lines = [];
      for (var i = 0; i < tc.items.length; i++) {
        var it = tc.items[i];
        if (typeof it.str !== 'string') continue;
        line += it.str;
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      out.push(lines.join('\n'));
      try { page.cleanup(); } catch (e) {}
      if (out.join('\n\n').length > MAX_TEXT) break;
    }
    return { status: 'ok', text: out.join('\n\n'), pages: pages, detail: null };
  } catch (e) {
    return { status: 'failed', detail: String((e && e.message) || e).slice(0, 400), text: '', pages: null };
  } finally {
    if (doc) { try { await doc.destroy(); } catch (e) {} }
  }
}

async function writeStatus(db, documentId, status, detail, text, pages) {
  var body = String(text || '').slice(0, MAX_TEXT);
  await db.query(
    'INSERT INTO document_text (document_id, content, char_count, page_count, status, detail, extracted_at) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,NOW()) ' +
    'ON CONFLICT (document_id) DO UPDATE SET content = EXCLUDED.content, char_count = EXCLUDED.char_count, ' +
    'page_count = EXCLUDED.page_count, status = EXCLUDED.status, detail = EXCLUDED.detail, extracted_at = NOW()',
    [documentId, body || null, body.length, pages || null, status, detail || null]
  );
  return { document_id: documentId, status: status, chars: body.length, pages: pages || null, detail: detail || null };
}

// Extract and index ONE document. Resolves a status object, never rejects.
async function indexDocument(db, documentId) {
  var id = parseInt(documentId, 10) || 0;
  if (!id) return { document_id: 0, status: 'failed', detail: 'No document id.' };
  try {
    const dr = await db.query(
      'SELECT id, name, r2_key, mime_type, size_bytes, status FROM documents WHERE id = $1', [id]
    );
    if (!dr.rows.length) return { document_id: id, status: 'failed', detail: 'No such document.' };
    var doc = dr.rows[0];
    if (doc.status !== 'ready') {
      return { document_id: id, status: 'pending', detail: 'The upload has not finished.' };
    }

    var kind = kindFor(doc.mime_type, doc.name);
    if (!kind) return await writeStatus(db, id, 'unsupported', 'Only PDFs and plain text files can be read.', '', null);
    if (Number(doc.size_bytes || 0) > MAX_BYTES) {
      return await writeStatus(db, id, 'too_large', 'Larger than ' + Math.round(MAX_BYTES / 1048576) + 'MB.', '', null);
    }
    if (!r2.configured()) return await writeStatus(db, id, 'unavailable', 'File storage is not configured.', '', null);

    var buf;
    try {
      buf = await r2.getObjectBuffer(doc.r2_key);
    } catch (e) {
      return await writeStatus(db, id, 'failed',
        'Could not read the file back: ' + String((e && e.message) || e).slice(0, 200), '', null);
    }

    var res;
    if (kind === 'pdf') res = await extractPdf(buf);
    else res = { status: 'ok', text: buf.toString('utf8'), pages: null, detail: null };

    if (res.status !== 'ok') return await writeStatus(db, id, res.status, res.detail, '', res.pages);

    // Non-breaking spaces are common in PDF text and break a verbatim quote
    // check against anything the model retyped, so they are normalised here,
    // once, before the text is stored or chunked.
    var text = String(res.text || '').replace(/\u00a0/g, ' ').trim();
    if (text.length < MIN_TEXT) {
      // The important failure. It uploaded, it opens, it looks fine in the
      // viewer, and it is invisible to every search in the building.
      await db.query('DELETE FROM document_chunks WHERE document_id = $1', [id]);
      return await writeStatus(db, id, 'no_text',
        'No text layer, so this looks like a scan. Re-save it as a searchable PDF.', '', res.pages);
    }

    var stored = text.slice(0, MAX_TEXT);
    await writeStatus(db, id, 'ok', null, stored, res.pages);
    await db.query('DELETE FROM document_chunks WHERE document_id = $1', [id]);
    var chunks = chunkSopText(stored);
    for (var i = 0; i < chunks.length; i++) {
      await db.query('INSERT INTO document_chunks (document_id, chunk_index, content) VALUES ($1,$2,$3)',
        [id, i, chunks[i]]);
    }
    return { document_id: id, status: 'ok', chars: stored.length, pages: res.pages, chunks: chunks.length, detail: null };
  } catch (e) {
    console.error('[doc-text] index failed for ' + id + ':', e.message);
    try { return await writeStatus(db, id, 'failed', String((e && e.message) || e).slice(0, 400), '', null); }
    catch (e2) { return { document_id: id, status: 'failed', detail: e.message }; }
  }
}

// Forget the words for these documents. TWO tables, always both: document_text
// holds the extracted body and document_chunks holds what is actually searched,
// and they hang off documents independently rather than off each other. Deleting
// only the first would leave a folder quotable after its policy flag was turned
// off, which is the exact thing the flag is supposed to control.
async function clearDocuments(db, ids) {
  if (!ids || !ids.length) return 0;
  await db.query('DELETE FROM document_chunks WHERE document_id = ANY($1::int[])', [ids]);
  await db.query('DELETE FROM document_text WHERE document_id = ANY($1::int[])', [ids]);
  return ids.length;
}

// Forget the words for every document under these folders.
async function clearFolders(db, folderIds) {
  if (!folderIds || !folderIds.length) return 0;
  const r = await db.query('SELECT id FROM documents WHERE folder_id = ANY($1::int[])', [folderIds]);
  var ids = r.rows.map(function (x) { return x.id; });
  await clearDocuments(db, ids);
  return ids.length;
}

// Is this document somewhere under a policy-source folder? Uploads outside one
// are never extracted, so the confirm hook asks this before doing any work.
async function isPolicyDocument(db, documentId) {
  try {
    const r = await db.query(
      POLICY_TREE_CTE + ' SELECT 1 FROM documents d WHERE d.id = $1 AND d.folder_id IN (SELECT id FROM policy_tree)',
      [parseInt(documentId, 10) || 0]
    );
    return r.rows.length > 0;
  } catch (e) { return false; }
}

// Is this folder itself inside a policy tree? Inherited, so a subfolder of a
// flagged folder answers true.
async function isPolicyFolder(db, folderId) {
  try {
    const r = await db.query(
      POLICY_TREE_CTE + ' SELECT 1 FROM policy_tree WHERE id = $1',
      [parseInt(folderId, 10) || 0]
    );
    return r.rows.length > 0;
  } catch (e) { return false; }
}

// Fire and forget, for the upload path. Somebody uploading a 15-page handbook
// should not sit and watch a spinner while it is parsed.
function indexInBackground(db, documentId) {
  setImmediate(function () {
    indexDocument(db, documentId).then(function (r) {
      if (r && r.status !== 'ok') {
        console.log('[doc-text] ' + documentId + ' -> ' + r.status + (r.detail ? (': ' + r.detail) : ''));
      }
    }).catch(function (e) { console.error('[doc-text] background index failed:', e.message); });
  });
}

// Every ready document under a policy-source folder. Used by the Re-index button
// so files already sitting in Policies get read without being re-uploaded.
async function policyDocumentIds(db) {
  const r = await db.query(
    POLICY_TREE_CTE +
    " SELECT d.id FROM documents d WHERE d.status = 'ready' AND d.folder_id IN (SELECT id FROM policy_tree) ORDER BY d.id"
  );
  return r.rows.map(function (x) { return x.id; });
}

// Index them one at a time. Sequential on purpose: this pulls whole files back
// out of R2 and parses them, and doing thirty at once is how one button press
// takes the app down. onlyMissing skips anything already indexed successfully.
async function reindexPolicyFolders(db, opts) {
  opts = opts || {};
  var ids = await policyDocumentIds(db);
  var out = { total: ids.length, ok: 0, no_text: 0, unsupported: 0, failed: 0, skipped: 0, files: [] };
  for (var i = 0; i < ids.length; i++) {
    if (opts.onlyMissing) {
      const ex = await db.query("SELECT status FROM document_text WHERE document_id = $1 AND status = 'ok'", [ids[i]]);
      if (ex.rows.length) { out.skipped++; continue; }
    }
    var r = await indexDocument(db, ids[i]);
    if (out[r.status] === undefined) out[r.status] = 0;
    out[r.status]++;
    out.files.push({ id: ids[i], status: r.status, chars: r.chars || 0, detail: r.detail || null });
  }
  return out;
}

module.exports = {
  POLICY_TREE_CTE: POLICY_TREE_CTE,
  MAX_BYTES: MAX_BYTES,
  MAX_TEXT: MAX_TEXT,
  MIN_TEXT: MIN_TEXT,
  kindFor: kindFor,
  extractPdf: extractPdf,
  indexDocument: indexDocument,
  indexInBackground: indexInBackground,
  isPolicyDocument: isPolicyDocument,
  isPolicyFolder: isPolicyFolder,
  clearDocuments: clearDocuments,
  clearFolders: clearFolders,
  policyDocumentIds: policyDocumentIds,
  reindexPolicyFolders: reindexPolicyFolders
};
