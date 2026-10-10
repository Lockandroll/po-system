// Policy versions - replace a Document Vault file or an SOP IN PLACE.
//
// Why this exists (Tony, 2026-10-09): the PTO policy changed, the memo went out
// with the new PDF, and onboarding kept showing new hires the OLD policy. Nova
// could only ever ADD a file next to the old one. Every onboarding read /
// acknowledge step points at one documents.id (config.document_id), every
// onboarding quiz at one sop_documents.id, and Nova AI reads whatever is
// active - so a "new" policy was invisible to all of them.
//
// The fix: a new version replaces the content on the SAME row id. Anything that
// points at the id follows automatically. The replaced version goes into a
// history table (document_versions / sop_document_versions) and its R2 object
// is KEPT, because an acknowledgment recorded against version 2 has to stay
// provable after version 3 lands.
//
// Also here: "where is this used" (so the blast radius is visible BEFORE you
// replace or delete), relinking every step from one file to another (cleans up
// a policy that was already uploaded as a separate file), and the onboarding
// link-health check that flags steps pointing at a missing or disabled file.
//
// No backticks in this file (Windows corrupts them in .js, CLAUDE.md 1.1).

var docText = require('./docText');
var sopIndex = require('./sopIndex');

function intId(v) { var n = parseInt(v, 10); return n > 0 ? n : 0; }

// ---- Vault files ------------------------------------------------------------

// Where a Vault file is used. Each source is wrapped on its own so a missing
// table (a module not migrated yet) never hides the others.
async function documentUsage(db, documentId) {
  var id = intId(documentId);
  var out = { onboarding_steps: [], memos: [], vehicles: 0, policy_folder: false };
  try {
    var s = await db.query(
      "SELECT id, title, type, phase FROM onboarding_steps WHERE active = true AND config->>'document_id' = $1::text ORDER BY position ASC, id ASC",
      [id]);
    out.onboarding_steps = s.rows;
  } catch (e) { console.error('[policy-versions] onboarding usage failed:', e.message); }
  try {
    var m = await db.query(
      'SELECT id, memo_no, title, status, sent_at FROM memos WHERE source_document_id = $1 ORDER BY id DESC LIMIT 25', [id]);
    out.memos = m.rows;
  } catch (e) { /* memos module not migrated yet */ }
  try {
    var v = await db.query('SELECT COUNT(*)::int AS n FROM vehicle_documents WHERE document_id = $1', [id]);
    out.vehicles = v.rows[0].n;
  } catch (e) { /* fleet links not migrated yet */ }
  try { out.policy_folder = await docText.isPolicyDocument(db, id); } catch (e) {}
  return out;
}

// Swap a new object in as the current version of a Vault file. newObj =
// { r2_key, name, mime_type, size_bytes }. The row id, folder, sharing,
// emailable flag and expiry all stay; only the bytes (and optionally the name)
// change. Returns the updated row.
async function replaceDocument(pool, documentId, newObj, user, note) {
  var id = intId(documentId);
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var cur = await client.query(
      "SELECT id, name, r2_key, mime_type, size_bytes, owner_name, created_at, version, version_by_name, version_at FROM documents WHERE id = $1 AND status = 'ready' FOR UPDATE",
      [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return null; }
    var d = cur.rows[0];
    var ver = parseInt(d.version, 10) || 1;
    await client.query(
      'INSERT INTO document_versions (document_id, version, name, r2_key, mime_type, size_bytes, uploaded_by_name, uploaded_at, replaced_by, replaced_by_name, note) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,(SELECT version_note FROM documents WHERE id = $1))',
      [id, ver, d.name, d.r2_key, d.mime_type, d.size_bytes || 0,
        d.version_by_name || d.owner_name || null, d.version_at || d.created_at || null,
        user ? user.id : null, user ? user.name : null]);
    var up = await client.query(
      'UPDATE documents SET r2_key = $2, name = $3, mime_type = $4, size_bytes = $5, version = $6, version_note = $7, ' +
      'version_by_name = $8, version_at = NOW(), pending_version_key = NULL, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id, newObj.r2_key, String(newObj.name || d.name).slice(0, 255), newObj.mime_type || d.mime_type,
        Math.max(0, parseInt(newObj.size_bytes, 10) || 0), ver + 1, note ? String(note).slice(0, 1000) : null,
        user ? user.name : null]);
    await client.query('COMMIT');
    var row = up.rows[0];
    // A policy file is re-read straight away, so Nova AI and the disciplinary
    // notice citations quote the new wording, not the old.
    try { if (await docText.isPolicyDocument(pool, id)) docText.indexInBackground(pool, id); }
    catch (e) { console.error('[policy-versions] reindex after replace failed:', e.message); }
    return row;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    throw e;
  } finally {
    client.release();
  }
}

async function documentVersions(db, documentId) {
  var id = intId(documentId);
  var cur = await db.query(
    "SELECT id, name, mime_type, size_bytes, version, version_note, version_by_name, version_at, owner_name, created_at FROM documents WHERE id = $1 AND status = 'ready'",
    [id]);
  if (!cur.rows.length) return null;
  var h = await db.query(
    'SELECT id, version, name, mime_type, size_bytes, uploaded_by_name, uploaded_at, replaced_by_name, replaced_at, note FROM document_versions WHERE document_id = $1 ORDER BY version DESC, id DESC',
    [id]);
  return { current: cur.rows[0], history: h.rows };
}

// Point every onboarding step that uses one Vault file at another. This is the
// one-click cleanup for a policy that was uploaded as a SEPARATE file.
async function relinkDocument(db, fromId, toId) {
  var r = await db.query(
    "UPDATE onboarding_steps SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{document_id}', to_jsonb($2::int)), updated_at = NOW() " +
    "WHERE config->>'document_id' = $1::text RETURNING id, title",
    [intId(fromId), intId(toId)]);
  return r.rows;
}

// ---- SOP library ------------------------------------------------------------

async function sopUsage(db, sopId) {
  var id = intId(sopId);
  var out = { onboarding_steps: [], active: false };
  try {
    var s = await db.query(
      'SELECT id, title, type, phase FROM onboarding_steps WHERE active = true AND sop_id = $1 ORDER BY position ASC, id ASC', [id]);
    out.onboarding_steps = s.rows;
  } catch (e) { console.error('[policy-versions] sop usage failed:', e.message); }
  try {
    var a = await db.query('SELECT active FROM sop_documents WHERE id = $1', [id]);
    out.active = !!(a.rows[0] && a.rows[0].active);
  } catch (e) {}
  return out;
}

// Replace an SOP's text in place. fields = { content, filename, title }.
async function replaceSop(pool, sopId, fields, user, note) {
  var id = intId(sopId);
  var text = String(fields.content || '').trim();
  var client = await pool.connect();
  var row;
  try {
    await client.query('BEGIN');
    var cur = await client.query('SELECT * FROM sop_documents WHERE id = $1 FOR UPDATE', [id]);
    if (!cur.rows.length) { await client.query('ROLLBACK'); return null; }
    var d = cur.rows[0];
    var ver = parseInt(d.version, 10) || 1;
    await client.query(
      'INSERT INTO sop_document_versions (sop_id, version, title, filename, content, char_count, uploaded_by_name, uploaded_at, replaced_by, replaced_by_name, note) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, ver, d.title, d.filename, d.content, d.char_count || 0,
        d.updated_by_name || d.uploaded_by_name || null, d.updated_at || d.created_at || null,
        user ? user.id : null, user ? user.name : null, d.version_note || null]);
    var title = (fields.title && String(fields.title).trim()) ? String(fields.title).trim().slice(0, 255) : d.title;
    var up = await client.query(
      'UPDATE sop_documents SET content = $2, char_count = $3, filename = $4, title = $5, version = $6, version_note = $7, ' +
      'updated_at = NOW(), updated_by_name = $8 WHERE id = $1 RETURNING id, title, filename, char_count, active, version, version_note, updated_at, updated_by_name',
      [id, text, text.length, String(fields.filename || d.filename || '').slice(0, 255), title, ver + 1,
        note ? String(note).slice(0, 1000) : null, user ? user.name : null]);
    row = up.rows[0];
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) {}
    throw e;
  } finally {
    client.release();
  }
  // Outside the transaction: a chunking hiccup must not undo the new version.
  try { await sopIndex.reindexSop(pool, id, text); } catch (e) { console.error('[policy-versions] SOP reindex failed:', e.message); }
  // The onboarding quiz bank is keyed by a hash of the SOP text and would
  // regenerate on its own, but dropping it now means no hire ever gets one
  // more round of questions written from the old wording.
  try { await pool.query('DELETE FROM onboarding_question_bank WHERE sop_id = $1', [id]); } catch (e) { /* table may not exist yet */ }
  return row;
}

async function sopVersions(db, sopId) {
  var id = intId(sopId);
  var cur = await db.query(
    'SELECT id, title, filename, char_count, active, version, version_note, updated_at, updated_by_name, uploaded_by_name, created_at FROM sop_documents WHERE id = $1', [id]);
  if (!cur.rows.length) return null;
  var h = await db.query(
    'SELECT id, version, title, filename, char_count, uploaded_by_name, uploaded_at, replaced_by_name, replaced_at, note FROM sop_document_versions WHERE sop_id = $1 ORDER BY version DESC, id DESC', [id]);
  return { current: cur.rows[0], history: h.rows };
}

async function relinkSop(db, fromId, toId) {
  var r = await db.query(
    'UPDATE onboarding_steps SET sop_id = $2, updated_at = NOW() WHERE sop_id = $1 RETURNING id, title', [intId(fromId), intId(toId)]);
  return r.rows;
}

// ---- Onboarding link health -------------------------------------------------
// Every ACTIVE onboarding step that would show a hire nothing, or something
// that has been switched off. Shown as a banner on the onboarding path builder.
async function onboardingLinkHealth(db) {
  var problems = [];
  var steps = (await db.query(
    "SELECT s.id, s.title, s.type, s.sop_id, s.config, d.title AS sop_title, d.active AS sop_active " +
    "FROM onboarding_steps s LEFT JOIN sop_documents d ON d.id = s.sop_id " +
    "WHERE s.active = true AND s.type IN ('sop_read','acknowledge','quiz') ORDER BY s.position ASC, s.id ASC")).rows;
  var docIds = [];
  steps.forEach(function (s) { var c = s.config || {}; var did = intId(c.document_id); if (did) docIds.push(did); });
  var docs = {};
  if (docIds.length) {
    (await db.query('SELECT id, name, status FROM documents WHERE id = ANY($1::int[])', [docIds])).rows
      .forEach(function (d) { docs[d.id] = d; });
  }
  steps.forEach(function (s) {
    var c = s.config || {};
    var did = intId(c.document_id);
    if (s.type === 'quiz') {
      if (!s.sop_id) problems.push({ step_id: s.id, title: s.title, problem: 'The quiz has no SOP to write questions from.' });
      else if (s.sop_active === false) problems.push({ step_id: s.id, title: s.title, problem: 'The quiz SOP "' + (s.sop_title || '') + '" is disabled.' });
      return;
    }
    if (did) {
      var d = docs[did];
      if (!d) problems.push({ step_id: s.id, title: s.title, problem: 'Its Vault file was deleted, so hires see a blank step.' });
      else if (d.status !== 'ready') problems.push({ step_id: s.id, title: s.title, problem: 'Its Vault file "' + d.name + '" never finished uploading.' });
    } else if (!s.sop_id) {
      problems.push({ step_id: s.id, title: s.title, problem: 'No document is linked to this step.' });
    }
    if (s.sop_id && s.sop_active === false) {
      problems.push({ step_id: s.id, title: s.title, problem: 'It still shows the disabled SOP "' + (s.sop_title || '') + '".' });
    }
  });
  return problems;
}

module.exports = {
  documentUsage: documentUsage,
  replaceDocument: replaceDocument,
  documentVersions: documentVersions,
  relinkDocument: relinkDocument,
  sopUsage: sopUsage,
  replaceSop: replaceSop,
  sopVersions: sopVersions,
  relinkSop: relinkSop,
  onboardingLinkHealth: onboardingLinkHealth
};
