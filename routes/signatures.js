// E-signature module (Adobe Sign style). Phase 2: upload + storage.
// Source/flattened PDFs and signature images live in Cloudflare R2 (presigned,
// direct browser<->R2). page_dimensions (per-page width/height in PDF points) is
// captured here from the uploaded PDF and is the source of truth for the
// normalized(0-1) -> PDF-point coordinate mapping used by the editor and flatten.
const express = require('express');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');

const router = express.Router();

// Year-sequenced request number, e.g. SIG-2026-0001.
async function generateRequestNumber() {
  const year = new Date().getFullYear();
  const prefix = 'SIG-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(request_number, '-', 3) AS INTEGER)) AS maxseq FROM signature_requests WHERE request_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'SIG-' + year + '-' + seq;
}

function sanitizeName(name) {
  return String(name || 'document').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'document';
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  return (xf || req.ip || '').toString().slice(0, 64);
}

// Append one row to the tamper-evident audit trail for a request.
async function logEvent(requestId, signerId, type, actor, req, detail) {
  try {
    await pool.query(
      'INSERT INTO signature_events (request_id, signer_id, event_type, actor, ip, user_agent, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [requestId, signerId || null, type, actor || null, clientIp(req),
       (req && req.headers['user-agent'] || '').toString().slice(0, 1000) || null,
       detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.error('Signature event log failed:', e.message); }
}

// ---- List (dashboard) ----
router.get('/', requireAuth, requirePermission('view_signatures'), async (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    const params = [];
    let sql =
      'SELECT r.id, r.request_number, r.title, r.status, r.page_count, r.created_at, r.updated_at, ' +
      'r.sent_at, r.completed_at, r.expires_at, u.name AS created_by_name, ' +
      '(SELECT COUNT(*) FROM signature_signers s WHERE s.request_id = r.id) AS signer_count, ' +
      "(SELECT COUNT(*) FROM signature_signers s WHERE s.request_id = r.id AND s.status = 'signed') AS signed_count " +
      'FROM signature_requests r LEFT JOIN users u ON u.id = r.created_by';
    if (status) { params.push(status); sql += ' WHERE r.status = $' + params.length; }
    sql += ' ORDER BY r.created_at DESC';
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('List signatures error:', err);
    res.status(500).json({ error: 'Failed to load signature requests' });
  }
});

// ---- Detail (request + signers + fields + events) ----
router.get('/:id', requireAuth, requirePermission('view_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query(
      'SELECT r.*, u.name AS created_by_name FROM signature_requests r LEFT JOIN users u ON u.id = r.created_by WHERE r.id = $1',
      [id]
    );
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    // Tokens are intentionally omitted from this payload.
    const signers = (await pool.query(
      'SELECT id, name, email, phone, role_label, sign_order, status, signed_at, declined_reason, consent_accepted, user_id ' +
      'FROM signature_signers WHERE request_id = $1 ORDER BY COALESCE(sign_order, 0), id',
      [id]
    )).rows;
    const fields = (await pool.query(
      'SELECT id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, ai_confidence, value, value_r2_key, font_size ' +
      'FROM signature_fields WHERE request_id = $1 ORDER BY page, id',
      [id]
    )).rows;
    const events = (await pool.query(
      'SELECT id, signer_id, event_type, actor, ip, created_at FROM signature_events WHERE request_id = $1 ORDER BY created_at ASC, id ASC',
      [id]
    )).rows;
    res.json({ request: rr.rows[0], signers: signers, fields: fields, events: events });
  } catch (err) {
    console.error('Get signature error:', err);
    res.status(500).json({ error: 'Failed to load signature request' });
  }
});

// ---- Step 1: create the request + presign the source-PDF upload ----
router.post('/upload-url', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    if (!r2.configured()) {
      return res.status(503).json({ error: 'Document storage is not configured yet. Add the R2_* environment variables in Railway.' });
    }
    const title = (req.body.title || '').trim();
    const fileName = (req.body.file_name || title || 'document.pdf').trim();
    const mime = (req.body.mime_type || 'application/pdf').slice(0, 255);
    if (!title) return res.status(400).json({ error: 'A document title is required' });
    if (mime !== 'application/pdf') return res.status(400).json({ error: 'Only PDF files can be sent for signature' });

    const requestNumber = await generateRequestNumber();
    const key = 'signatures/' + crypto.randomUUID() + '/' + sanitizeName(fileName);
    const { rows } = await pool.query(
      "INSERT INTO signature_requests (request_number, title, created_by, status, source_r2_key) " +
      "VALUES ($1,$2,$3,'draft',$4) RETURNING id, request_number",
      [requestNumber, title.slice(0, 255), req.user.id, key]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, request_number: rows[0].request_number, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Signature upload-url error:', err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// ---- Step 2: confirm upload; read page count + per-page dimensions from the PDF ----
router.post('/:id/confirm', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT id, source_r2_key, created_by FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    const reqRow = rr.rows[0];
    if (reqRow.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your request' });
    }

    // Pull the just-uploaded PDF back from R2 and measure it. Dimensions are in
    // PDF points (1/72in), bottom-left origin in the PDF itself; we only store sizes.
    let pageCount = 0;
    let dims = [];
    try {
      const buf = await r2.getObjectBuffer(reqRow.source_r2_key);
      const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
      const pages = pdf.getPages();
      pageCount = pages.length;
      dims = pages.map(function (p) { const s = p.getSize(); return { w: s.width, h: s.height }; });
    } catch (e) {
      console.error('Signature PDF parse failed:', e.message);
      return res.status(400).json({ error: 'Could not read that PDF. Make sure it is a valid, unlocked PDF.' });
    }
    if (!pageCount) return res.status(400).json({ error: 'That PDF has no pages.' });

    await pool.query(
      'UPDATE signature_requests SET page_count = $1, page_dimensions = $2, updated_at = NOW() WHERE id = $3',
      [pageCount, JSON.stringify(dims), id]
    );
    await logEvent(id, null, 'created', req.user.name, req, { pages: pageCount });
    logAudit({ entity_type: 'signature_request', entity_id: id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { pages: pageCount } });
    res.json({ success: true, page_count: pageCount, page_dimensions: dims });
  } catch (err) {
    console.error('Signature confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// ---- Download / preview the source (or signed) PDF via a presigned GET URL ----
router.get('/:id/download', requireAuth, requirePermission('view_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const signed = req.query.which === 'signed';
    const col = signed ? 'signed_r2_key' : 'source_r2_key';
    const rr = await pool.query('SELECT request_number, ' + col + ' AS key FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length || !rr.rows[0].key) return res.status(404).json({ error: 'File not found' });
    const fname = rr.rows[0].request_number + (signed ? '-signed.pdf' : '.pdf');
    const url = await r2.presignDownload(rr.rows[0].key, fname, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Signature download error:', err);
    res.status(500).json({ error: 'Failed to get download link' });
  }
});

// ---- Delete a request (draft cleanup); cascades signers/fields/events ----
router.delete('/:id', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT id, source_r2_key, signed_r2_key, created_by FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rr.rows[0];
    if (row.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your request' });
    }
    try { await r2.deleteObject(row.source_r2_key); } catch (e) {}
    try { if (row.signed_r2_key) await r2.deleteObject(row.signed_r2_key); } catch (e) {}
    await pool.query('DELETE FROM signature_requests WHERE id = $1', [id]);
    logAudit({ entity_type: 'signature_request', entity_id: id, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error('Signature delete error:', err);
    res.status(500).json({ error: 'Failed to delete signature request' });
  }
});

module.exports = router;
