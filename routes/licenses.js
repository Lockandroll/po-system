// Licensing & compliance: the things we have to hold, renew and pay for in
// order to keep operating in a territory -- business licences, city
// occupational tax registrations, sales-tax accounts, alarm and contractor
// licences, franchise registrations.
//
// Deliberately NOT part of routes/vendors.js. An account is somebody we buy
// from; a licence is permission to trade, granted by an authority, with a
// renewal date and a fee attached. Sharing the vendors table would mean a
// column set where half the columns are always null for one of the two -- which
// is exactly how the vendors table got the way it is.
//
// Shaped like Accounts on purpose: an authority, a number, a portal login and
// security questions, because renewing one of these means logging into a portal
// at 11pm the night before it lapses and being asked your mother's maiden name.
// What we actually DID once inside that portal is the ledger (routes/ledger.js).
//
// Ships dark behind view_licenses / manage_licenses (CLAUDE.md 1.5): on deploy
// only admin and owner can reach any of it.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');

const router = express.Router();
router.use(requireAuth);

const KINDS = ['business_license', 'occupational_tax', 'sales_tax', 'contractor',
  'alarm', 'franchise', 'vehicle', 'insurance', 'other'];
const INTERVALS = ['annual', 'biennial', 'quarterly', 'monthly', 'none'];

// A certificate is "expiring" this far out. Same 60 days the COI screen uses,
// so the two compliance surfaces do not disagree about what counts as soon.
const EXPIRING_DAYS = 60;

// Shared with the browser editor. The server REJECTS past these rather than
// trimming: a silently shortened security answer is a WRONG answer, and you
// only find that out when the portal locks the account.
const SQ_MAX_ROWS = 25;
const SQ_MAX_LEN = 300;

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (_) { return false; }
}

async function canManage(req) { return hasPerm(req, 'manage_licenses'); }

async function requireView(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    if (await hasPerm(req, 'manage_licenses')) return next();
    if (await hasPerm(req, 'view_licenses')) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

async function requireManage(req, res, next) {
  try {
    if (await canManage(req)) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) { return res.status(403).json({ error: 'Forbidden' }); }
}

function str(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  return s ? s.slice(0, max || 255) : null;
}

function dateOnly(v) {
  var s = str(v, 30);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// An unrecoverable secret gets the same undefined-guard the security answers
// get, and for the same reason. A key that is absent means "leave it alone";
// only an explicit null or empty string clears the stored password.
function passwordOf(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return String(v);
}

function kindOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return KINDS.indexOf(s) !== -1 ? s : 'other';
}

function intervalOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return INTERVALS.indexOf(s) !== -1 ? s : 'annual';
}

// Same allowlist contract as vendors.restricted_to: a de-duped array of
// positive int IDs, or null for "everyone who can see the module".
function cleanRestrictedTo(v) {
  if (!Array.isArray(v)) return null;
  var ids = Array.from(new Set(v.map(function (x) { return parseInt(x, 10); })
    .filter(function (n) { return Number.isInteger(n) && n > 0; })));
  return ids.length ? ids : null;
}

// Same undefined-guard contract as routes/vendors.js, and for the same reason:
// answers are unrecoverable secrets, so a payload we cannot make sense of must
// never be read as "delete them all". Only an explicit empty list clears them.
//   undefined      -> leave the column alone
//   null / '' / [] -> a real answer: this licence has no security questions
//   anything else  -> ALSO leave the column alone
function cleanSecurityQuestions(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (!Array.isArray(v)) return undefined;
  if (v.length > SQ_MAX_ROWS) {
    var e = new Error('A license can hold at most ' + SQ_MAX_ROWS + ' security questions.');
    e.status = 400;
    throw e;
  }
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var row = v[i];
    if (!row || typeof row !== 'object') continue;
    var q = String(row.q == null ? '' : row.q).trim();
    var a = String(row.a == null ? '' : row.a).trim();
    if (q.length > SQ_MAX_LEN || a.length > SQ_MAX_LEN) {
      var e2 = new Error('Security questions and answers are limited to ' + SQ_MAX_LEN + ' characters.');
      e2.status = 400;
      throw e2;
    }
    if (!q && !a) continue;
    out.push({ q: q, a: a });
  }
  return out.length ? out : null;
}

function readSecurityQuestions(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (_) { return []; }
  }
  return [];
}

function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// One place decides what a licence's standing is, so the row pill, the banner
// count and anything that later wants to email about it can never disagree.
// Mirrors the shape utils/coi.js returns (key / label / tone / note).
function statusOf(row, today) {
  if (row.active === false) return { key: 'inactive', label: 'Inactive', tone: 'grey', note: '' };
  var exp = ymd(row.expires_on);
  if (!exp) return { key: 'unknown', label: 'No date', tone: 'grey', note: 'No renewal date on file' };
  var days = Math.floor((Date.parse(exp + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days < 0) return { key: 'expired', label: 'Expired', tone: 'red', note: Math.abs(days) + ' day' + (Math.abs(days) === 1 ? '' : 's') + ' ago' };
  if (days <= EXPIRING_DAYS) return { key: 'expiring', label: 'Renew soon', tone: 'amber', note: 'in ' + days + ' day' + (days === 1 ? '' : 's') };
  return { key: 'current', label: 'Current', tone: 'green', note: '' };
}

function todayYmd() { return new Date().toISOString().slice(0, 10); }

// Active users for the per-licence restriction picker.
router.get('/pickable-users', requireManage, async function (req, res) {
  try {
    const { rows } = await pool.query('SELECT id, name, role FROM users WHERE active IS NOT false ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error('Licence pickable-users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Every licence the caller is allowed to see, each with its server-computed
// status and its ledger total. Credentials are STRIPPED for view-only callers
// exactly as vendors does it -- not hidden in the UI, absent from the response.
router.get('/', requireView, async function (req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT l.*, u.name AS responsible_name,' +
      '  (SELECT COALESCE(SUM(e.amount), 0) FROM account_ledger_entries e WHERE e.license_id = l.id) AS ledger_total,' +
      '  (SELECT COUNT(*)::int FROM account_ledger_entries e WHERE e.license_id = l.id) AS ledger_count,' +
      '  (SELECT MAX(e.entry_date) FROM account_ledger_entries e WHERE e.license_id = l.id) AS last_entry_on,' +
      "  (SELECT COUNT(*)::int FROM license_documents d WHERE d.license_id = l.id AND d.status = 'ready') AS doc_count" +
      ' FROM licenses l LEFT JOIN users u ON u.id = l.responsible_user_id' +
      ' ORDER BY l.active DESC, l.expires_on ASC NULLS LAST, l.name ASC'
    );
    const manage = await canManage(req);
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'owner');
    const uid = req.user && req.user.id;
    const today = todayYmd();
    const out = [];
    for (var i = 0; i < rows.length; i++) {
      var l = rows[i];
      var arr = Array.isArray(l.restricted_to) ? l.restricted_to : [];
      var restricted = arr.length > 0;
      var allowed = isAdmin || (uid != null && arr.indexOf(uid) !== -1);
      if (restricted && !allowed) continue; // whole licence hidden from non-permitted people
      var showCreds = manage || (restricted && allowed);
      var c = Object.assign({}, l);
      if (!manage) c.restricted_to = null; // only managers see or edit the allowlist
      c.security_questions = readSecurityQuestions(l.security_questions);
      if (!showCreds) { c.username = null; c.password = null; c.security_questions = []; }
      c.issued_on = ymd(l.issued_on);
      c.expires_on = ymd(l.expires_on);
      c.last_entry_on = ymd(l.last_entry_on);
      c.ledger_total = parseFloat(l.ledger_total || 0);
      c.status = statusOf(l, today);
      out.push(c);
    }
    res.json({ licenses: out, can_manage: manage, expiring_days: EXPIRING_DAYS });
  } catch (err) {
    console.error('Licences list error:', err);
    res.status(500).json({ error: 'Failed to load licenses' });
  }
});

function bodyFields(b) {
  return {
    name: str(b.name, 255),
    kind: kindOf(b.kind),
    authority: str(b.authority, 255),
    license_number: str(b.license_number, 255),
    city_code: str(b.city_code, 40),
    jurisdiction: str(b.jurisdiction, 160),
    website: str(b.website, 255),
    username: str(b.username, 255),
    issued_on: dateOnly(b.issued_on),
    expires_on: dateOnly(b.expires_on),
    renewal_interval: intervalOf(b.renewal_interval),
    renewal_fee: money(b.renewal_fee),
    responsible_user_id: (function () { var n = parseInt(b.responsible_user_id, 10); return Number.isInteger(n) && n > 0 ? n : null; })(),
    notes: str(b.notes, 8000),
    active: b.active === false ? false : true
  };
}

router.post('/', requireManage, async function (req, res) {
  const f = bodyFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'License name is required.' });
  const pw = passwordOf((req.body || {}).password);
  let sq;
  try { sq = cleanSecurityQuestions((req.body || {}).security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const { rows } = await pool.query(
      'INSERT INTO licenses (name, kind, authority, license_number, city_code, jurisdiction, website,' +
      ' username, password, security_questions, issued_on, expires_on, renewal_interval, renewal_fee,' +
      ' responsible_user_id, restricted_to, notes, active, created_by, created_by_name)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',
      [f.name, f.kind, f.authority, f.license_number, f.city_code, f.jurisdiction, f.website,
       f.username, pw === undefined ? null : pw, (sq === undefined || sq === null) ? null : JSON.stringify(sq),
       f.issued_on, f.expires_on, f.renewal_interval, f.renewal_fee, f.responsible_user_id,
       cleanRestrictedTo((req.body || {}).restricted_to), f.notes, f.active,
       req.user.id, req.user.name]
    );
    logAudit({ entity_type: 'license', entity_id: rows[0].id, action: 'created',
      user_id: req.user.id, user_name: req.user.name, details: { name: f.name, kind: f.kind }, ip: req.ip });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Licence create error:', err);
    res.status(500).json({ error: 'Failed to create the license' });
  }
});

router.put('/:id', requireManage, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  const f = bodyFields(req.body || {});
  if (!f.name) return res.status(400).json({ error: 'License name is required.' });
  const sets = ['name=$1', 'kind=$2', 'authority=$3', 'license_number=$4', 'city_code=$5',
    'jurisdiction=$6', 'website=$7', 'username=$8', 'issued_on=$9',
    'expires_on=$10', 'renewal_interval=$11', 'renewal_fee=$12', 'responsible_user_id=$13',
    'notes=$14', 'active=$15'];
  const params = [f.name, f.kind, f.authority, f.license_number, f.city_code, f.jurisdiction,
    f.website, f.username, f.issued_on, f.expires_on, f.renewal_interval,
    f.renewal_fee, f.responsible_user_id, f.notes, f.active];
  // password, restricted_to and security_questions are only touched when the
  // caller actually sent them, so a partial save from some future screen cannot
  // silently wipe a portal password, open a licence to everybody, or erase the
  // answers. The password guard is the one the licensing test caught: a save
  // that carried only a new renewal date was blanking the login.
  const pw = passwordOf((req.body || {}).password);
  if (pw !== undefined) { params.push(pw); sets.push('password=$' + params.length); }
  if ((req.body || {}).restricted_to !== undefined) {
    params.push(cleanRestrictedTo(req.body.restricted_to));
    sets.push('restricted_to=$' + params.length);
  }
  let sq;
  try { sq = cleanSecurityQuestions((req.body || {}).security_questions); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (sq !== undefined) {
    params.push(sq === null ? null : JSON.stringify(sq));
    sets.push('security_questions=$' + params.length);
  }
  params.push(id);
  try {
    const { rows } = await pool.query(
      'UPDATE licenses SET ' + sets.join(', ') + ', updated_at=NOW() WHERE id=$' + params.length + ' RETURNING *',
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'License not found' });
    logAudit({ entity_type: 'license', entity_id: id, action: 'updated',
      user_id: req.user.id, user_name: req.user.name, details: { name: f.name }, ip: req.ip });
    res.json(rows[0]);
  } catch (err) {
    console.error('Licence update error:', err);
    res.status(500).json({ error: 'Failed to update the license' });
  }
});

// Deleting takes the ledger with it (ON DELETE CASCADE), which is why the
// editor offers Inactive: a licence we no longer hold is still a licence we
// once paid for, and that history is the reason the ledger exists.
router.delete('/:id', requireManage, async function (req, res) {
  const id = parseInt(req.params.id, 10);
  try {
    const dr = await pool.query('SELECT name FROM licenses WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'License not found' });
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM account_ledger_entries WHERE license_id = $1', [id]);
    // The document ROWS go with the cascade; the stored files do not, so take
    // them out of R2 first. A failed R2 delete is logged, never fatal: an
    // orphaned object costs pennies, a licence you cannot delete costs a ticket.
    const docs = await pool.query('SELECT r2_key FROM license_documents WHERE license_id = $1', [id]);
    if (r2.configured()) {
      for (var di = 0; di < docs.rows.length; di++) {
        try { await r2.deleteObject(docs.rows[di].r2_key); }
        catch (e) { console.error('Licence doc R2 delete failed (row removed anyway):', e.message); }
      }
    }
    await pool.query('DELETE FROM licenses WHERE id = $1', [id]);
    logAudit({ entity_type: 'license', entity_id: id, action: 'deleted',
      user_id: req.user.id, user_name: req.user.name,
      details: { name: dr.rows[0].name, ledger_rows_removed: n.rows[0].n, documents_removed: docs.rows.length }, ip: req.ip });
    res.json({ success: true, ledger_rows_removed: n.rows[0].n });
  } catch (err) {
    console.error('Licence delete error:', err);
    res.status(500).json({ error: 'Failed to delete the license' });
  }
});

// ── License documents (PDFs) ─────────────────────────────────────────────────
//
// The certificate on the wall, the application, the paid receipt, the letter
// from the city. Same three-step R2 flow as routes/accountDocs.js: reserve the
// row and a presigned PUT, the browser sends the bytes straight to R2, then a
// confirm call HEAD-checks that the object really landed. Bytes never pass
// through the API (CLAUDE.md 9).
//
// Visibility follows the licence: anyone who can see the licence can open its
// files; only manage_licenses can add or remove them. A restricted licence's
// files answer 404 (never 403) to people off its allowlist, so nothing reveals
// that the licence exists -- the same rule accountDocs applies to accounts.

const DOC_KINDS = ['certificate', 'application', 'receipt', 'correspondence', 'other'];

function docKindOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return DOC_KINDS.indexOf(s) !== -1 ? s : 'certificate';
}

// PDFs are the point (Tony, 2026-10-05). Images are let through too, because
// half of these arrive as a phone photo of a certificate taped to a wall.
function allowedMime(m) {
  var s = String(m || '').toLowerCase();
  return s === 'application/pdf' || s.indexOf('image/') === 0;
}

function sanitizeName(name) {
  return String(name || 'license.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'license.pdf';
}

async function canSeeLicense(req, licenseId) {
  try {
    const r = await pool.query('SELECT restricted_to FROM licenses WHERE id = $1', [licenseId]);
    if (!r.rows.length) return false;
    if (req.user && (req.user.role === 'admin' || req.user.role === 'owner')) return true;
    const arr = Array.isArray(r.rows[0].restricted_to) ? r.rows[0].restricted_to : [];
    if (arr.length === 0) return true;
    return !!(req.user && arr.indexOf(req.user.id) !== -1);
  } catch (e) { return false; }
}

// The expiration-date path (Tony, 2026-10-05). Every document can carry its
// own expiry. When a License / Certificate is filed with a date LATER than the
// licence's current Renews / Expires date, the licence moves forward to match,
// so the status pill, the banner and the 60-day warning all follow the newest
// certificate without anybody retyping the date. It only ever moves FORWARD:
// filing last year's certificate for the record must never pull a current
// licence back into "Expired". Receipts, applications and letters never move
// it -- a receipt's date is when we paid, not when the licence lapses.
async function advanceLicenseExpiry(req, doc) {
  if (!doc || doc.status !== 'ready' || doc.kind !== 'certificate') return null;
  var docExp = ymd(doc.expires_on);
  if (!docExp) return null;
  const r = await pool.query(
    'UPDATE licenses SET expires_on = $1, updated_at = NOW()' +
    ' WHERE id = $2 AND (expires_on IS NULL OR expires_on < $1) RETURNING expires_on',
    [docExp, doc.license_id]
  );
  if (!r.rows.length) return null;
  logAudit({ entity_type: 'license', entity_id: doc.license_id, action: 'expiry_advanced',
    user_id: req.user.id, user_name: req.user.name,
    details: { expires_on: docExp, from_document: doc.id, file: doc.file_name }, ip: req.ip });
  return docExp;
}

function docOut(d, today) {
  var o = Object.assign({}, d);
  delete o.r2_key;
  o.expires_on = ymd(d.expires_on);
  o.exp_status = o.expires_on ? statusOf({ active: true, expires_on: o.expires_on }, today) : null;
  return o;
}

async function loadDoc(req, docId) {
  const dr = await pool.query('SELECT * FROM license_documents WHERE id = $1', [docId]);
  if (!dr.rows.length) return null;
  if (!(await canSeeLicense(req, dr.rows[0].license_id))) return null;
  return dr.rows[0];
}

router.get('/:id/documents', requireView, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!(await canSeeLicense(req, id))) return res.status(404).json({ error: 'License not found' });
    const { rows } = await pool.query(
      "SELECT id, license_id, kind, title, file_name, mime_type, size_bytes, expires_on, uploaded_by_name, created_at" +
      " FROM license_documents WHERE license_id = $1 AND status = 'ready' ORDER BY created_at DESC, id DESC", [id]
    );
    const today = todayYmd();
    res.json({ documents: rows.map(function (d) { return docOut(d, today); }), storage_ready: r2.configured(), can_manage: await canManage(req), kinds: DOC_KINDS });
  } catch (err) {
    console.error('Licence docs list error:', err);
    res.status(500).json({ error: 'Failed to load license documents' });
  }
});

router.post('/:id/documents/upload-url', requireManage, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.id, 10);
    if (!(await canSeeLicense(req, id))) return res.status(404).json({ error: 'License not found' });
    const b = req.body || {};
    const name = str(b.name, 255) || 'license.pdf';
    const mime = str(b.mime_type, 255) || 'application/pdf';
    if (!allowedMime(mime)) return res.status(400).json({ error: 'Upload a PDF (or a photo of the document).' });
    const key = 'license-docs/' + id + '/' + crypto.randomUUID() + '/' + sanitizeName(name);
    const { rows } = await pool.query(
      'INSERT INTO license_documents (license_id, kind, title, r2_key, file_name, mime_type, expires_on, status, uploaded_by, uploaded_by_name)' +
      " VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING id",
      [id, docKindOf(b.kind), str(b.title, 255), key, name, mime, dateOnly(b.expires_on), req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Licence doc upload-url error:', err);
    res.status(500).json({ error: 'Failed to start the upload' });
  }
});

router.post('/documents/:docId/confirm', requireManage, async function (req, res) {
  try {
    const d = await loadDoc(req, parseInt(req.params.docId, 10));
    if (!d) return res.status(404).json({ error: 'Document not found' });
    var size = Math.max(0, parseInt((req.body || {}).size_bytes, 10) || 0);
    if (r2.configured()) {
      var head;
      try { head = await r2.headObject(d.r2_key); }
      catch (e) { console.error('Licence doc head check failed:', e.message); return res.status(502).json({ error: 'Could not verify the upload with storage. Try again.' }); }
      if (!head) return res.status(400).json({ error: 'The upload did not complete. Try again.' });
      size = head.size || size;
    }
    await pool.query("UPDATE license_documents SET size_bytes = $1, status = 'ready', updated_at = NOW() WHERE id = $2", [size, d.id]);
    logAudit({ entity_type: 'license', entity_id: d.license_id, action: 'document_uploaded',
      user_id: req.user.id, user_name: req.user.name, details: { file: d.file_name, kind: d.kind, expires_on: ymd(d.expires_on) }, ip: req.ip });
    d.status = 'ready';
    const moved = await advanceLicenseExpiry(req, d);
    res.json({ success: true, license_expires_on: moved });
  } catch (err) {
    console.error('Licence doc confirm error:', err);
    res.status(500).json({ error: 'Failed to save the document' });
  }
});

// Fix a document's type, title or expiration date after the fact -- the usual
// case is a certificate uploaded before anyone read the date off it. Same
// forward-only rule as the upload.
router.put('/documents/:docId', requireManage, async function (req, res) {
  try {
    const d = await loadDoc(req, parseInt(req.params.docId, 10));
    if (!d || d.status !== 'ready') return res.status(404).json({ error: 'Document not found' });
    const b = req.body || {};
    const kind = b.kind === undefined ? d.kind : docKindOf(b.kind);
    const title = b.title === undefined ? d.title : str(b.title, 255);
    const exp = b.expires_on === undefined ? ymd(d.expires_on) : dateOnly(b.expires_on);
    const r = await pool.query(
      'UPDATE license_documents SET kind = $1, title = $2, expires_on = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [kind, title, exp, d.id]
    );
    logAudit({ entity_type: 'license', entity_id: d.license_id, action: 'document_updated',
      user_id: req.user.id, user_name: req.user.name, details: { file: d.file_name, kind: kind, expires_on: exp }, ip: req.ip });
    const moved = await advanceLicenseExpiry(req, r.rows[0]);
    res.json({ success: true, document: docOut(r.rows[0], todayYmd()), license_expires_on: moved });
  } catch (err) {
    console.error('Licence doc update error:', err);
    res.status(500).json({ error: 'Failed to update the document' });
  }
});

router.get('/documents/:docId/download', requireView, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
    const d = await loadDoc(req, parseInt(req.params.docId, 10));
    if (!d || d.status !== 'ready') return res.status(404).json({ error: 'Document not found' });
    const url = await r2.presignDownload(d.r2_key, d.file_name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Licence doc download error:', err);
    res.status(500).json({ error: 'Failed to open the document' });
  }
});

router.delete('/documents/:docId', requireManage, async function (req, res) {
  try {
    const d = await loadDoc(req, parseInt(req.params.docId, 10));
    if (!d) return res.status(404).json({ error: 'Document not found' });
    try { if (r2.configured()) await r2.deleteObject(d.r2_key); }
    catch (e) { console.error('Licence doc R2 delete failed (row removed anyway):', e.message); }
    await pool.query('DELETE FROM license_documents WHERE id = $1', [d.id]);
    logAudit({ entity_type: 'license', entity_id: d.license_id, action: 'document_deleted',
      user_id: req.user.id, user_name: req.user.name, details: { file: d.file_name }, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('Licence doc delete error:', err);
    res.status(500).json({ error: 'Failed to delete the document' });
  }
});

module.exports = router;
