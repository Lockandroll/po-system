// Account paperwork: the signed agreement, and anything else that belongs to an
// account as a FILE rather than as structured data.
//
// Deliberately separate from routes/coi.js. A certificate of insurance is a set
// of numbers Nova checks against requirements; an agreement is a document you
// read. Sharing a table would mean nullable columns that only ever apply to one
// of them, which is how the vendors table got the way it is.
//
// Storage is the same three-step R2 flow the document vault uses: reserve the
// row and a presigned PUT, the browser sends the bytes straight to R2, then a
// confirm call HEAD-checks that the object really landed.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const r2 = require('../utils/r2');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// Agreements are account paperwork, so they ride on the Accounts permissions
// rather than on manage_coi.
const KINDS = ['agreement', 'w9', 'rate_sheet', 'other'];

async function hasPerm(req, perm) {
  if (!req.user) return false;
  try { if (await permissions.hasPermission(req.user.role, perm)) return true; } catch (_) {}
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (_) { return false; }
}

async function canManage(req) { return hasPerm(req, 'manage_vendors'); }

async function requireView(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    var perms = ['manage_vendors', 'view_vendors', 'manage_coi'];
    for (var i = 0; i < perms.length; i++) { if (await hasPerm(req, perms[i])) return next(); }
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

function kindOf(v) {
  var s = String(v || '').trim().toLowerCase();
  return KINDS.indexOf(s) !== -1 ? s : 'agreement';
}

function sanitizeName(name) {
  return String(name || 'agreement.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'agreement.pdf';
}

function rowDates(d) {
  ['effective_on', 'expires_on'].forEach(function (k) {
    if (d[k] instanceof Date) d[k] = d[k].toISOString().slice(0, 10);
    else if (d[k]) d[k] = String(d[k]).slice(0, 10);
  });
  return d;
}

router.get('/account/:accountId', requireView, async function (req, res) {
  try {
    const id = parseInt(req.params.accountId, 10);
    const { rows } = await pool.query(
      "SELECT * FROM account_documents WHERE account_id = $1 AND status <> 'pending' " +
      'ORDER BY created_at DESC, id DESC', [id]
    );
    res.json({ documents: rows.map(rowDates), storage_ready: r2.configured(), can_manage: await canManage(req) });
  } catch (err) {
    console.error('Account docs list error:', err);
    res.status(500).json({ error: 'Failed to load account documents' });
  }
});

router.post('/account/:accountId/upload-url', requireManage, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.accountId, 10);
    const av = await pool.query('SELECT id FROM vendors WHERE id = $1', [id]);
    if (!av.rows.length) return res.status(404).json({ error: 'Account not found' });
    const name = str(req.body.name, 255) || 'agreement.pdf';
    const mime = str(req.body.mime_type, 255) || 'application/pdf';
    const key = 'account-docs/' + id + '/' + crypto.randomUUID() + '/' + sanitizeName(name);
    const { rows } = await pool.query(
      'INSERT INTO account_documents (account_id, kind, title, r2_key, file_name, mime_type, status, uploaded_by, uploaded_by_name) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING id",
      [id, kindOf(req.body.kind), str(req.body.title, 255), key, name, mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Account doc upload-url error:', err);
    res.status(500).json({ error: 'Failed to start the upload' });
  }
});

router.post('/:id/confirm', requireManage, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT * FROM account_documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'Document not found' });
    var size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    if (r2.configured()) {
      var head;
      try { head = await r2.headObject(dr.rows[0].r2_key); }
      catch (e) { console.error('Account doc head check failed:', e.message); return res.status(502).json({ error: 'Could not verify the upload with storage. Try again.' }); }
      if (!head) return res.status(400).json({ error: 'The upload did not complete. Try again.' });
      size = head.size || size;
    }
    await pool.query(
      "UPDATE account_documents SET size_bytes = $1, status = 'ready', kind = $2, title = $3, " +
      'effective_on = $4, expires_on = $5, notes = $6, updated_at = NOW() WHERE id = $7',
      [size, kindOf(req.body.kind), str(req.body.title, 255), dateOnly(req.body.effective_on),
       dateOnly(req.body.expires_on), str(req.body.notes, 4000), id]
    );
    logAudit({ entity_type: 'account_doc', entity_id: dr.rows[0].account_id, action: 'uploaded',
      user_id: req.user.id, user_name: req.user.name, details: { file: dr.rows[0].file_name }, ip: req.ip });
    const fresh = await pool.query('SELECT * FROM account_documents WHERE id = $1', [id]);
    res.json({ success: true, document: rowDates(fresh.rows[0]) });
  } catch (err) {
    console.error('Account doc confirm error:', err);
    res.status(500).json({ error: 'Failed to save the document' });
  }
});

router.put('/:id', requireManage, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT * FROM account_documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'Document not found' });
    await pool.query(
      'UPDATE account_documents SET kind = $1, title = $2, effective_on = $3, expires_on = $4, notes = $5, updated_at = NOW() WHERE id = $6',
      [kindOf(req.body.kind), str(req.body.title, 255), dateOnly(req.body.effective_on),
       dateOnly(req.body.expires_on), str(req.body.notes, 4000), id]
    );
    const fresh = await pool.query('SELECT * FROM account_documents WHERE id = $1', [id]);
    res.json({ success: true, document: rowDates(fresh.rows[0]) });
  } catch (err) {
    console.error('Account doc update error:', err);
    res.status(500).json({ error: 'Failed to update the document' });
  }
});

router.get('/:id/download', requireView, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'File storage is not configured yet.' });
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query("SELECT r2_key, file_name FROM account_documents WHERE id = $1 AND status = 'ready'", [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'Document not found' });
    const url = await r2.presignDownload(dr.rows[0].r2_key, dr.rows[0].file_name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Account doc download error:', err);
    res.status(500).json({ error: 'Failed to open the document' });
  }
});

router.delete('/:id', requireManage, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT * FROM account_documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'Document not found' });
    try { if (r2.configured()) await r2.deleteObject(dr.rows[0].r2_key); }
    catch (e) { console.error('Account doc R2 delete failed (row removed anyway):', e.message); }
    await pool.query('DELETE FROM account_documents WHERE id = $1', [id]);
    logAudit({ entity_type: 'account_doc', entity_id: dr.rows[0].account_id, action: 'deleted',
      user_id: req.user.id, user_name: req.user.name, details: { file: dr.rows[0].file_name }, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error('Account doc delete error:', err);
    res.status(500).json({ error: 'Failed to delete the document' });
  }
});

module.exports = router;
