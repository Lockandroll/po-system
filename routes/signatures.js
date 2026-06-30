// E-signature module (Adobe Sign style). Phase 2: upload + storage.
// Source/flattened PDFs and signature images live in Cloudflare R2 (presigned,
// direct browser<->R2). page_dimensions (per-page width/height in PDF points) is
// captured here from the uploaded PDF and is the source of truth for the
// normalized(0-1) -> PDF-point coordinate mapping used by the editor and flatten.
const express = require('express');
const crypto = require('crypto');
const https = require('https');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');

const router = express.Router();

// Field types allowed in v1 (mirrors signature_fields.field_type).
const FIELD_TYPES = ['signature', 'initials', 'date', 'name', 'text', 'checkbox'];

// Detection runs as its own Anthropic vision call so it has an independent token
// budget and prompt, separate from the Neurolock chat in routes/ai.js.
function callVision(systemPrompt, content, maxTokens) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: maxTokens || 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: content }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = https.request(options, function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, function () { r.destroy(new Error('AI detection timed out. Please try again.')); });
    r.write(body);
    r.end();
  });
}

// Pull a JSON array out of the model reply, tolerating code fences / stray prose.
function extractJsonArray(text) {
  if (!text) return [];
  var t = String(text).trim();
  var start = t.indexOf('[');
  var end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try { var parsed = JSON.parse(t.slice(start, end + 1)); return Array.isArray(parsed) ? parsed : []; }
  catch (e) { return []; }
}

function clamp01(n) { n = Number(n); if (!isFinite(n)) return 0; return Math.max(0, Math.min(1, n)); }

// Validate + clamp the model's raw detections into rows we are willing to store.
function normalizeDetected(raw, pageCount) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (var i = 0; i < raw.length; i++) {
    var f = raw[i];
    if (!f || FIELD_TYPES.indexOf(f.field_type) === -1) continue;
    var page = parseInt(f.page, 10); if (!Number.isInteger(page) || page < 0) page = 0;
    if (pageCount && page > pageCount - 1) continue;
    var x = clamp01(f.x), y = clamp01(f.y), w = clamp01(f.w), h = clamp01(f.h);
    if (w <= 0 || h <= 0) continue;
    if (x + w > 1) w = 1 - x;
    if (y + h > 1) h = 1 - y;
    var conf = (f.confidence == null) ? null : clamp01(f.confidence);
    out.push({ page: page, field_type: f.field_type, x: x, y: y, w: w, h: h,
      label: (f.label ? String(f.label).slice(0, 255) : null), confidence: conf });
  }
  return out;
}

// Split a data URL or raw base64 into an image block source.
function parseImage(img) {
  if (!img) return null;
  var m = String(img).match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.*)$/);
  if (m) { var mt = (m[1] === 'image/jpg') ? 'image/jpeg' : m[1]; return { media_type: mt, data: m[2] }; }
  return { media_type: 'image/png', data: String(img) };
}

const DETECT_SYSTEM =
  'You are a precise document-analysis tool that locates fillable and signable fields in a document. ' +
  'You are shown the pages of one document as images, in order. Identify the places a person must fill in or sign: ' +
  'signature lines, initial blocks, date blanks, printed-name blanks, generic text blanks, and checkboxes. ' +
  'Respond with ONLY a JSON array, no prose and no markdown fences. Each element must be: ' +
  '{"page": <0-based integer matching the labeled page>, "field_type": one of ["signature","initials","date","name","text","checkbox"], ' +
  '"x": <number>, "y": <number>, "w": <number>, "h": <number>, "label": <short string>, "confidence": <number 0-1>}. ' +
  'x, y, w, h are fractions of THAT page width/height in the range 0 to 1, origin at the TOP-LEFT of the page; ' +
  'x,y is the top-left corner of the field box. For fields that sit on a printed underline (signatures, dates, printed names), treat the underline as the BOTTOM edge of the box and place the box just ABOVE it, not below. Be conservative and only include real fields. If there are none, return [].';


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
  if (!req || !req.headers) return '';
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
// ===================== Templates (reusable forms) =====================
// NOTE: these must be registered BEFORE the generic '/:id' route below, or
// '/templates' would be captured as an id.
router.get('/templates', requireAuth, requirePermission('view_signatures'), async (req, res) => {
  try {
    const rows = (await pool.query(
      'SELECT t.id, t.name, t.page_count, t.created_at, u.name AS created_by_name FROM signature_templates t LEFT JOIN users u ON u.id = t.created_by ORDER BY t.name ASC'
    )).rows;
    res.json(rows);
  } catch (err) { console.error('Template list error:', err); res.status(500).json({ error: 'Failed to load templates' }); }
});

router.get('/templates/:tid', requireAuth, requirePermission('view_signatures'), async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM signature_templates WHERE id = $1', [parseInt(req.params.tid, 10)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Template not found' });
    res.json(r.rows[0]);
  } catch (err) { console.error('Template get error:', err); res.status(500).json({ error: 'Failed to load template' }); }
});

// Save a draft request's document + layout as a reusable template.
router.post('/templates/from-request/:id', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT * FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    const request = rr.rows[0];
    if (request.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your request' });
    if (!request.source_r2_key) return res.status(400).json({ error: 'This request has no document.' });
    var name = (req.body.name || request.title || 'Template').toString().trim().slice(0, 255);
    const signers = (await pool.query('SELECT id, name, role_label, sign_order FROM signature_signers WHERE request_id = $1 ORDER BY sign_order, id', [id])).rows;
    const fields = (await pool.query('SELECT * FROM signature_fields WHERE request_id = $1 ORDER BY page, id', [id])).rows;
    var roleIdx = {};
    var roles = signers.map(function (sg, i) { roleIdx[sg.id] = i; return { label: (sg.role_label || sg.name || ('Signer ' + (i + 1))) }; });
    var tfields = fields.map(function (f) {
      return { role: (f.signer_id != null && roleIdx[f.signer_id] != null) ? roleIdx[f.signer_id] : null,
        field_type: f.field_type, page: f.page, x: +f.x, y: +f.y, w: +f.w, h: +f.h,
        required: f.required, label: f.label, value: f.value, locked: !!f.locked };
    });
    var newKey = 'signature-templates/' + crypto.randomUUID() + '/' + name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '.pdf';
    try { var buf = await r2.getObjectBuffer(request.source_r2_key); await r2.putObject(newKey, buf, 'application/pdf'); }
    catch (e) { console.error('Template copy failed:', e.message); return res.status(500).json({ error: 'Could not copy the document.' }); }
    const ins = await pool.query(
      'INSERT INTO signature_templates (name, source_r2_key, page_count, page_dimensions, roles, fields, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [name, newKey, request.page_count || 0, JSON.stringify(request.page_dimensions || null), JSON.stringify(roles), JSON.stringify(tfields), req.user.id]
    );
    // Also drop a browsable copy into the Documents vault, in a 'Signature Templates' folder.
    try {
      var folderId = null;
      var ff = await pool.query("SELECT id FROM document_folders WHERE name = 'Signature Templates' AND owner_id = $1 AND parent_id IS NULL", [req.user.id]);
      if (ff.rows.length) folderId = ff.rows[0].id;
      else { var nf = await pool.query("INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('Signature Templates', NULL, $1, $2) RETURNING id", [req.user.id, req.user.name]); folderId = nf.rows[0].id; }
      var vaultKey = 'documents/' + crypto.randomUUID() + '/' + name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '.pdf';
      await r2.putObject(vaultKey, buf, 'application/pdf');
      await pool.query(
        "INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) VALUES ($1, $2, $3, 'application/pdf', $4, 'ready', $5, $6)",
        [name + ' (template).pdf', folderId, vaultKey, buf.length, req.user.id, req.user.name]
      );
    } catch (e) { console.error('Template vault drop failed:', e.message); }
    res.json({ id: ins.rows[0].id, name: name });
  } catch (err) { console.error('Template save error:', err); res.status(500).json({ error: 'Failed to save template' }); }
});

// Create a fresh draft request from a template (clones the PDF + fields + role slots).
router.post('/templates/:tid/use', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const t = (await pool.query('SELECT * FROM signature_templates WHERE id = $1', [parseInt(req.params.tid, 10)])).rows[0];
    if (!t) return res.status(404).json({ error: 'Template not found' });
    var title = (req.body.title || t.name || 'Untitled').toString().trim().slice(0, 255);
    var roles = Array.isArray(t.roles) ? t.roles : [];
    var fields = Array.isArray(t.fields) ? t.fields : [];
    var newKey = 'signatures/' + crypto.randomUUID() + '/' + title.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) + '.pdf';
    try { var buf = await r2.getObjectBuffer(t.source_r2_key); await r2.putObject(newKey, buf, 'application/pdf'); }
    catch (e) { console.error('Template use copy failed:', e.message); return res.status(500).json({ error: 'Could not copy the template document.' }); }
    const requestNumber = await generateRequestNumber();
    const rq = await pool.query(
      "INSERT INTO signature_requests (request_number, title, created_by, status, source_r2_key, page_count, page_dimensions) VALUES ($1,$2,$3,'draft',$4,$5,$6) RETURNING id",
      [requestNumber, title, req.user.id, newKey, t.page_count || 0, JSON.stringify(t.page_dimensions || null)]
    );
    var reqId = rq.rows[0].id;
    var roleToSigner = {};
    for (var i = 0; i < roles.length; i++) {
      var lbl = (roles[i] && roles[i].label) ? String(roles[i].label).slice(0, 100) : ('Signer ' + (i + 1));
      var sr = await pool.query("INSERT INTO signature_signers (request_id, name, email, role_label, sign_order, status) VALUES ($1,'','',$2,$3,'pending') RETURNING id", [reqId, lbl, i]);
      roleToSigner[i] = sr.rows[0].id;
    }
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      var sid = (f.role != null && roleToSigner[f.role] != null) ? roleToSigner[f.role] : null;
      await pool.query(
        'INSERT INTO signature_fields (request_id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, font_size, value, locked) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,NULL,$11,$12)',
        [reqId, sid, f.field_type, f.page || 0, f.x, f.y, f.w, f.h, (f.required === false ? false : true), f.label || null, (f.value != null ? f.value : null), !!f.locked]
      );
    }
    await logEvent(reqId, null, 'created', req.user.name, req, { from_template: t.id, pages: t.page_count || 0 });
    res.json({ id: reqId, request_number: requestNumber });
  } catch (err) { console.error('Template use error:', err); res.status(500).json({ error: 'Failed to create from template' }); }
});

router.delete('/templates/:tid', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const t = (await pool.query('SELECT id, source_r2_key, created_by FROM signature_templates WHERE id = $1', [parseInt(req.params.tid, 10)])).rows[0];
    if (!t) return res.status(404).json({ error: 'Template not found' });
    if (t.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your template' });
    try { await r2.deleteObject(t.source_r2_key); } catch (e) {}
    await pool.query('DELETE FROM signature_templates WHERE id = $1', [t.id]);
    res.json({ success: true });
  } catch (err) { console.error('Template delete error:', err); res.status(500).json({ error: 'Failed to delete template' }); }
});

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
      'SELECT id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, ai_confidence, value, value_r2_key, font_size, locked ' +
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

// ---- Phase 3: AI field detection over rendered page images ----
// Client (pdf.js) renders each page to a PNG and posts them here; we ask Claude
// to locate fields and store them as AI drafts the human then corrects.
router.post('/:id/detect', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'AI is not configured. Add ANTHROPIC_API_KEY in Railway Variables.' });
    }
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT id, created_by, page_count FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    if (rr.rows[0].created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your request' });
    }
    const pageCount = rr.rows[0].page_count || 0;

    var pages = Array.isArray(req.body.pages) ? req.body.pages : [];
    if (!pages.length) return res.status(400).json({ error: 'Page images are required to run detection.' });
    if (pages.length > 15) pages = pages.slice(0, 15); // bound token cost; extra pages get human-added fields

    // Multi-image message: a 'Page i:' label precedes each page image so the model
    // ties every detection back to the right page index.
    var content = [{ type: 'text', text: 'Here are the ' + pages.length + ' page(s) of the document, in order.' }];
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i] || {};
      var pageIndex = Number.isInteger(pg.page) ? pg.page : i;
      var parsed = parseImage(pg.image);
      if (!parsed) continue;
      content.push({ type: 'text', text: 'Page ' + pageIndex + ':' });
      content.push({ type: 'image', source: { type: 'base64', media_type: parsed.media_type, data: parsed.data } });
    }
    if (content.length === 1) return res.status(400).json({ error: 'No valid page images were provided.' });

    const response = await callVision(DETECT_SYSTEM, content, 4096);
    if (response.error) {
      console.error('Detection API error:', JSON.stringify(response.error));
      const msg = (response.error.message || '').toLowerCase();
      if (msg.indexOf('image') !== -1 || msg.indexOf('size') !== -1 || msg.indexOf('large') !== -1) {
        return res.status(400).json({ error: 'The page images are too large. Render them at a lower resolution and retry.' });
      }
      return res.status(502).json({ error: 'AI detection failed. Please try again.' });
    }
    const text = (response.content && response.content[0] && response.content[0].text) ? response.content[0].text : '';
    const valid = normalizeDetected(extractJsonArray(text), pageCount);

    // Replace only AI drafts; keep any human-added or edited fields intact.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM signature_fields WHERE request_id = $1 AND ai_detected = true', [id]);
      for (var j = 0; j < valid.length; j++) {
        var f = valid[j];
        await client.query(
          'INSERT INTO signature_fields (request_id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, ai_confidence) ' +
          'VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, true, $8, true, $9)',
          [id, f.field_type, f.page, f.x, f.y, f.w, f.h, f.label, f.confidence]
        );
      }
      await client.query('UPDATE signature_requests SET updated_at = NOW() WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await logEvent(id, null, 'ai_detected', req.user.name, req, { detected: valid.length, pages: pages.length });
    const fields = (await pool.query(
      'SELECT id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, ai_confidence FROM signature_fields WHERE request_id = $1 ORDER BY page, id',
      [id]
    )).rows;
    res.json({ detected: valid.length, fields: fields });
  } catch (err) {
    console.error('Signature detect error:', err);
    res.status(500).json({ error: 'Failed to run field detection.' });
  }
});


// ---- Phase 4: replace the draft layout (signers + fields) from the editor ----
// Atomic: wipes the request's signers + fields and re-inserts them, mapping each
// field's signer index to the freshly-inserted signer id. Draft-only (a sent
// request is locked). Fields saved here are ai_detected=false (human-authored).
router.put('/:id/layout', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT id, created_by, status, page_count FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    const reqRow = rr.rows[0];
    if (reqRow.created_by !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your request' });
    }
    if (reqRow.status !== 'draft') {
      return res.status(409).json({ error: 'This request has already been sent and can no longer be edited.' });
    }
    const pageCount = reqRow.page_count || 0;

    var signersIn = Array.isArray(req.body.signers) ? req.body.signers : [];
    var fieldsIn = Array.isArray(req.body.fields) ? req.body.fields : [];
    if (signersIn.length > 20) return res.status(400).json({ error: 'Too many signers (max 20).' });

    var signers = [];
    for (var i = 0; i < signersIn.length; i++) {
      var sIn = signersIn[i] || {};
      var nm = (sIn.name || '').toString().trim().slice(0, 255);
      if (!nm) continue;
      signers.push({
        name: nm,
        email: (sIn.email || '').toString().trim().slice(0, 255) || null,
        phone: (sIn.phone || '').toString().trim().slice(0, 50) || null,
        role_label: (sIn.role_label || '').toString().trim().slice(0, 100) || null
      });
    }

    var fields = [];
    for (var j = 0; j < fieldsIn.length; j++) {
      var f = fieldsIn[j] || {};
      if (FIELD_TYPES.indexOf(f.field_type) === -1) continue;
      var page = parseInt(f.page, 10); if (!Number.isInteger(page) || page < 0) page = 0;
      if (pageCount && page > pageCount - 1) continue;
      var x = clamp01(f.x), y = clamp01(f.y), w = clamp01(f.w), h = clamp01(f.h);
      if (w <= 0 || h <= 0) continue;
      // The model tends to anchor line-based fields at the underline, leaving the box a
      // touch low; lift non-checkbox fields so they sit on the line instead of below it.
      if (f.field_type !== 'checkbox') y = Math.max(0, y - h * 0.4);
      if (x + w > 1) w = 1 - x;
      if (y + h > 1) h = 1 - y;
      var si = (f.signer == null) ? null : parseInt(f.signer, 10);
      if (si != null && (!Number.isInteger(si) || si < 0 || si >= signers.length)) si = null;
      var fval = null;
      if (f.field_type === 'checkbox') fval = (f.value === 'true' || f.value === true) ? 'true' : null;
      else if (f.field_type !== 'signature' && f.field_type !== 'initials') fval = (f.value != null && String(f.value).trim() !== '') ? String(f.value).slice(0, 2000) : null;
      fields.push({ signer: si, field_type: f.field_type, page: page, x: x, y: y, w: w, h: h,
        required: (f.required === false) ? false : true,
        label: f.label ? String(f.label).slice(0, 255) : null,
        font_size: (f.font_size != null && isFinite(f.font_size)) ? Number(f.font_size) : null,
        value: fval, locked: (f.locked === true) });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM signature_fields WHERE request_id = $1', [id]);
      await client.query('DELETE FROM signature_signers WHERE request_id = $1', [id]);
      var ids = [];
      for (var a = 0; a < signers.length; a++) {
        var sr = await client.query(
          'INSERT INTO signature_signers (request_id, name, email, phone, role_label, sign_order, status) ' +
          "VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id",
          [id, signers[a].name, signers[a].email, signers[a].phone, signers[a].role_label, a]
        );
        ids.push(sr.rows[0].id);
      }
      for (var b = 0; b < fields.length; b++) {
        var fl = fields[b];
        var sid = (fl.signer != null) ? ids[fl.signer] : null;
        await client.query(
          'INSERT INTO signature_fields (request_id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, font_size, value, locked) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13)',
          [id, sid, fl.field_type, fl.page, fl.x, fl.y, fl.w, fl.h, fl.required, fl.label, fl.font_size, fl.value, fl.locked]
        );
      }
      await client.query('UPDATE signature_requests SET updated_at = NOW() WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await logEvent(id, null, 'layout_saved', req.user.name, req, { signers: signers.length, fields: fields.length });
    const outSigners = (await pool.query('SELECT id, name, email, phone, role_label, sign_order, status FROM signature_signers WHERE request_id = $1 ORDER BY sign_order, id', [id])).rows;
    const outFields = (await pool.query('SELECT id, signer_id, field_type, page, x, y, w, h, required, label, ai_detected, ai_confidence, font_size FROM signature_fields WHERE request_id = $1 ORDER BY page, id', [id])).rows;
    res.json({ signers: outSigners, fields: outFields });
  } catch (err) {
    console.error('Signature layout save error:', err);
    res.status(500).json({ error: 'Failed to save layout' });
  }
});


// ===================== Phase 5: send / remind / void =====================
function sigLink(token) { return (process.env.APP_URL || '').replace(/\/$/, '') + '/sign/' + token; }

// Email (+ optional SMS) a signer their single-use signing link.
async function sigNotifySigner(request, signer) {
  if (!signer.email) return;
  var link = sigLink(signer.token);
  var html = emailTemplate({
    badge: 'Signature requested', badgeColor: 'orange',
    title: 'Please sign: ' + request.title,
    body: 'Hi ' + (signer.name || 'there') + ',<br><br>You have a document waiting for your signature.' + (request.message ? ('<br><br>' + request.message) : ''),
    details: [{ label: 'Document', value: request.title }, { label: 'Reference', value: request.request_number }],
    buttonText: 'Review & sign', buttonUrl: link,
    footerNote: 'This is a secure, single-use signing link. Do not forward it.'
  });
  await sendEmail(signer.email, 'Signature requested: ' + request.title, html);
  if (signer.phone) { try { await sendSms(signer.phone, 'You have a document to sign: ' + request.title + ' ' + link); } catch (e) {} }
}

router.post('/:id/send', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT * FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    const request = rr.rows[0];
    if (request.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your request' });
    if (request.status !== 'draft') return res.status(409).json({ error: 'This request has already been sent.' });

    const signers = (await pool.query('SELECT * FROM signature_signers WHERE request_id = $1 ORDER BY sign_order, id', [id])).rows;
    const fields = (await pool.query('SELECT id, signer_id FROM signature_fields WHERE request_id = $1', [id])).rows;
    if (!signers.length) return res.status(400).json({ error: 'Add at least one signer before sending.' });
    if (!fields.length) return res.status(400).json({ error: 'Add at least one field before sending.' });
    if (signers.some(function (s) { return !s.email; })) return res.status(400).json({ error: 'Every signer needs an email address.' });
    var unassigned = fields.filter(function (f) { return f.signer_id == null; });
    if (unassigned.length) return res.status(400).json({ error: unassigned.length + ' field(s) are not assigned to a signer.' });
    var withField = {}; fields.forEach(function (f) { withField[f.signer_id] = true; });
    var empty = signers.filter(function (s) { return !withField[s.id]; });
    if (empty.length) return res.status(400).json({ error: 'Each signer needs at least one field: ' + empty.map(function (s) { return s.name; }).join(', ') });

    var expires = request.expires_at ? new Date(request.expires_at) : new Date(Date.now() + 30 * 86400000);
    for (var i = 0; i < signers.length; i++) {
      var token = crypto.randomBytes(32).toString('hex');
      await pool.query("UPDATE signature_signers SET token = $1, token_expires_at = $2, status = 'pending' WHERE id = $3", [token, expires, signers[i].id]);
      signers[i].token = token;
    }
    await pool.query("UPDATE signature_requests SET status = 'sent', sent_at = NOW(), expires_at = $2, updated_at = NOW() WHERE id = $1", [id, expires]);
    for (var j = 0; j < signers.length; j++) {
      sigNotifySigner(request, signers[j]).catch(function (e) { console.error('Signer notify failed:', e.message); });
      await logEvent(id, signers[j].id, 'sent', req.user.name, req, { to: signers[j].email });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Signature send error:', err);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

router.post('/:id/remind', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT * FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    const request = rr.rows[0];
    if (request.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your request' });
    if (['sent', 'partially_signed'].indexOf(request.status) === -1) return res.status(409).json({ error: 'Nothing to remind - this request is ' + request.status + '.' });
    const pending = (await pool.query("SELECT * FROM signature_signers WHERE request_id = $1 AND status <> 'signed' AND status <> 'declined' AND token IS NOT NULL", [id])).rows;
    for (var i = 0; i < pending.length; i++) {
      sigNotifySigner(request, pending[i]).catch(function (e) { console.error('Reminder failed:', e.message); });
      await logEvent(id, pending[i].id, 'reminder_sent', req.user.name, req, {});
    }
    res.json({ success: true, reminded: pending.length });
  } catch (err) {
    console.error('Signature remind error:', err);
    res.status(500).json({ error: 'Failed to send reminders' });
  }
});

router.post('/:id/void', requireAuth, requirePermission('manage_signatures'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rr = await pool.query('SELECT id, created_by, status FROM signature_requests WHERE id = $1', [id]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Signature request not found' });
    if (rr.rows[0].created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Not your request' });
    if (rr.rows[0].status === 'completed') return res.status(409).json({ error: 'A completed request cannot be voided.' });
    await pool.query("UPDATE signature_requests SET status = 'voided', updated_at = NOW() WHERE id = $1", [id]);
    await pool.query("UPDATE signature_signers SET token = NULL WHERE request_id = $1", [id]);
    await logEvent(id, null, 'voided', req.user.name, req, {});
    res.json({ success: true });
  } catch (err) {
    console.error('Signature void error:', err);
    res.status(500).json({ error: 'Failed to void request' });
  }
});

// ===================== Phase 7: flatten + complete =====================
async function flattenAndComplete(requestId) {
  const request = (await pool.query('SELECT * FROM signature_requests WHERE id = $1', [requestId])).rows[0];
  if (!request) return;
  const fields = (await pool.query('SELECT * FROM signature_fields WHERE request_id = $1', [requestId])).rows;
  const signers = (await pool.query('SELECT * FROM signature_signers WHERE request_id = $1 ORDER BY sign_order, id', [requestId])).rows;
  const events = (await pool.query('SELECT * FROM signature_events WHERE request_id = $1 ORDER BY created_at, id', [requestId])).rows;

  const srcBuf = await r2.getObjectBuffer(request.source_r2_key);
  const pdf = await PDFDocument.load(srcBuf, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var page = pages[f.page]; if (!page) continue;
    var sz = page.getSize(); var W = sz.width, Hh = sz.height;
    // normalized (top-left) -> PDF points (bottom-left)
    var bx = (+f.x) * W, bw = (+f.w) * W, bh = (+f.h) * Hh;
    var by = Hh - ((+f.y) * Hh) - bh;
    if (f.field_type === 'signature' || f.field_type === 'initials') {
      if (f.value_r2_key) {
        try {
          var imgBuf = await r2.getObjectBuffer(f.value_r2_key);
          var png = await pdf.embedPng(imgBuf);
          var d = png.scale(1);
          var ar = Math.min(bw / d.width, bh / d.height);
          var dw = d.width * ar, dh = d.height * ar;
          page.drawImage(png, { x: bx + (bw - dw) / 2, y: by + (bh - dh) / 2, width: dw, height: dh });
        } catch (e) { console.error('Embed signature failed:', e.message); }
      }
    } else if (f.field_type === 'checkbox') {
      if (f.value === 'true') {
        var cs = Math.min(bw, bh);
        page.drawText('X', { x: bx + cs * 0.15, y: by + cs * 0.12, size: cs * 0.78, font: font, color: rgb(0.1, 0.1, 0.1) });
      }
    } else if (f.value) {
      var fs = f.font_size ? Number(f.font_size) : Math.min(bh * 0.7, 12);
      if (fs < 6) fs = 6; if (fs > 14) fs = 14;
      page.drawText(String(f.value).slice(0, 200), { x: bx + 2, y: by + (bh - fs) / 2 + 1, size: fs, font: font, color: rgb(0.05, 0.05, 0.05) });
    }
  }

  // ----- Certificate of completion -----
  var cert = pdf.addPage();
  var yy = cert.getSize().height - 60;
  function certLine(txt, size, color) {
    if (yy < 56) { cert = pdf.addPage(); yy = cert.getSize().height - 60; }
    cert.drawText(String(txt).slice(0, 110), { x: 50, y: yy, size: size || 11, font: font, color: color || rgb(0.12, 0.12, 0.12) });
    yy -= (size || 11) + 8;
  }
  certLine('Certificate of Completion', 18); yy -= 6;
  certLine('Document: ' + (request.title || ''), 11);
  certLine('Reference: ' + request.request_number, 11);
  certLine('Completed: ' + new Date().toISOString(), 11); yy -= 8;
  certLine('Signers', 13);
  signers.forEach(function (s) { certLine('- ' + (s.name || '') + '  <' + (s.email || '') + '>  ' + (s.status || '') + (s.signed_at ? ('  ' + new Date(s.signed_at).toISOString()) : ''), 10); });
  yy -= 8; certLine('Audit trail', 13);
  events.forEach(function (e) { certLine(new Date(e.created_at).toISOString() + '  ' + e.event_type + (e.actor ? ('  ' + e.actor) : '') + (e.ip ? ('  [' + e.ip + ']') : ''), 9); });

  const outBuf = Buffer.from(await pdf.save());
  const key = 'signatures/' + request.id + '/' + request.request_number + '-signed.pdf';
  await r2.putObject(key, outBuf, 'application/pdf');
  await pool.query("UPDATE signature_requests SET signed_r2_key = $1, status = 'completed', completed_at = NOW(), updated_at = NOW() WHERE id = $2", [key, request.id]);
  await logEvent(request.id, null, 'completed', null, null, { signed_key: key });

  // Auto-drop the signed PDF into the Documents vault (owned by the creator).
  var creator = (await pool.query('SELECT email, name FROM users WHERE id = $1', [request.created_by])).rows[0] || {};
  try {
    var signedFolderId = null;
    var sf = await pool.query("SELECT id FROM document_folders WHERE name = 'Signed Documents' AND owner_id = $1 AND parent_id IS NULL", [request.created_by]);
    if (sf.rows.length) signedFolderId = sf.rows[0].id;
    else { var nsf = await pool.query("INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ('Signed Documents', NULL, $1, $2) RETURNING id", [request.created_by, creator.name || null]); signedFolderId = nsf.rows[0].id; }
    await pool.query(
      "INSERT INTO documents (name, folder_id, r2_key, mime_type, size_bytes, status, owner_id, owner_name) " +
      "VALUES ($1, $2, $3, 'application/pdf', $4, 'ready', $5, $6)",
      [(request.title || request.request_number) + ' (signed).pdf', signedFolderId, key, outBuf.length, request.created_by, creator.name || null]
    );
  } catch (e) { console.error('Vault drop failed:', e.message); }

  // Email the completed PDF to all signers + the creator.
  try {
    var recips = signers.map(function (s) { return s.email; }).filter(Boolean);
    if (creator.email) recips.push(creator.email);
    if (recips.length) {
      var html = emailTemplate({
        badge: 'Completed', badgeColor: 'green', title: 'Signed: ' + request.title,
        body: 'All parties have signed. The completed document is attached.',
        details: [{ label: 'Reference', value: request.request_number }],
        footerNote: 'Signed electronically via Nova.'
      });
      await sendEmail(recips, 'Completed: ' + request.title, html, null, [{ filename: request.request_number + '-signed.pdf', content: outBuf.toString('base64') }]);
    }
  } catch (e) { console.error('Completion email failed:', e.message); }
  // Internal broadcast (configurable in Settings > Notifications > 'Signature request completed').
  try {
    var _bc = await notify.broadcastRecipients('signature_completed', "role IN ('admin','owner')");
    if (_bc.emails && _bc.emails.length) {
      var bhtml = emailTemplate({ badge: 'Completed', badgeColor: 'green', title: 'Signature completed: ' + request.title,
        body: 'All parties have signed "' + (request.title || '') + '". The signed document is saved in the Document Vault.',
        details: [{ label: 'Reference', value: request.request_number }], footerNote: 'Automated Nova notification.' });
      await sendEmail(_bc.emails, 'Signature completed: ' + request.title, bhtml);
    }
  } catch (e) { console.error('Completion broadcast failed:', e.message); }
}

// ===================== Phase 6: public signing (no auth) =====================
const pub = express.Router();

async function loadSignerByToken(token) {
  if (!token) return null;
  const sr = await pool.query('SELECT * FROM signature_signers WHERE token = $1', [token]);
  if (!sr.rows.length) return null;
  const signer = sr.rows[0];
  const rr = await pool.query('SELECT * FROM signature_requests WHERE id = $1', [signer.request_id]);
  if (!rr.rows.length) return null;
  return { signer: signer, request: rr.rows[0] };
}

function tokenError(signer, request) {
  if (request.status === 'voided') return { code: 410, msg: 'This request has been canceled.' };
  if (signer.token_expires_at && new Date(signer.token_expires_at) < new Date()) return { code: 410, msg: 'This signing link has expired.' };
  return null;
}

pub.get('/:token', async (req, res) => {
  try {
    const ctx = await loadSignerByToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'This signing link is not valid.' });
    const signer = ctx.signer, request = ctx.request;
    var te = tokenError(signer, request);
    if (te) return res.status(te.code).json({ error: te.msg });
    if (signer.status === 'pending') {
      await pool.query("UPDATE signature_signers SET status = 'viewed' WHERE id = $1", [signer.id]);
      await logEvent(request.id, signer.id, 'viewed', signer.name, req, {});
    }
    const fields = (await pool.query('SELECT id, field_type, page, x, y, w, h, required, label, value, locked FROM signature_fields WHERE request_id = $1 AND signer_id = $2 ORDER BY page, id', [request.id, signer.id])).rows;
    var pdfUrl = null;
    try { pdfUrl = await r2.presignDownload(request.source_r2_key, request.request_number + '.pdf', true); } catch (e) {}
    res.json({
      request: { id: request.id, title: request.title, request_number: request.request_number, page_count: request.page_count, page_dimensions: request.page_dimensions, message: request.message, status: request.status },
      signer: { id: signer.id, name: signer.name, email: signer.email, role_label: signer.role_label, status: signer.status, consent_accepted: signer.consent_accepted },
      fields: fields, pdfUrl: pdfUrl
    });
  } catch (err) {
    console.error('Public sign load error:', err);
    res.status(500).json({ error: 'Failed to load the document.' });
  }
});

pub.post('/:token/consent', async (req, res) => {
  try {
    const ctx = await loadSignerByToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Invalid link.' });
    var te = tokenError(ctx.signer, ctx.request);
    if (te) return res.status(te.code).json({ error: te.msg });
    await pool.query('UPDATE signature_signers SET consent_accepted = true WHERE id = $1', [ctx.signer.id]);
    await logEvent(ctx.request.id, ctx.signer.id, 'consented', ctx.signer.name, req, {});
    res.json({ success: true });
  } catch (err) { console.error('Consent error:', err); res.status(500).json({ error: 'Failed to record consent' }); }
});

pub.post('/:token/submit', async (req, res) => {
  try {
    const ctx = await loadSignerByToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Invalid link.' });
    const signer = ctx.signer, request = ctx.request;
    var te = tokenError(signer, request);
    if (te) return res.status(te.code).json({ error: te.msg });
    if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    if (!signer.consent_accepted && !req.body.consent) return res.status(400).json({ error: 'You must agree to sign electronically first.' });

    const fields = (await pool.query('SELECT * FROM signature_fields WHERE request_id = $1 AND signer_id = $2', [request.id, signer.id])).rows;
    var values = req.body.values || {};
    // Required-field validation
    for (var v = 0; v < fields.length; v++) {
      var f = fields[v]; var entry = values[f.id] || {};
      if (!f.required || f.locked) continue;
      var has;
      if (f.field_type === 'signature' || f.field_type === 'initials') has = !!entry.image;
      else if (f.field_type === 'checkbox') has = true; // checkbox required = must be acknowledged; accept either state
      else has = (entry.value != null && String(entry.value).trim() !== '');
      if (!has) return res.status(400).json({ error: 'Please complete all required fields before submitting.' });
    }
    // Persist values
    for (var k = 0; k < fields.length; k++) {
      var fl = fields[k]; var e2 = values[fl.id] || {};
      if (fl.locked) continue;
      if (fl.field_type === 'signature' || fl.field_type === 'initials') {
        if (e2.image) {
          var b64 = String(e2.image).replace(/^data:image\/png;base64,/, '');
          var key = 'signatures/' + request.id + '/sig-' + fl.id + '-' + Date.now() + '.png';
          try { await r2.putObject(key, Buffer.from(b64, 'base64'), 'image/png'); await pool.query('UPDATE signature_fields SET value_r2_key = $1 WHERE id = $2', [key, fl.id]); }
          catch (e) { console.error('Signature upload failed:', e.message); }
        }
      } else if (fl.field_type === 'checkbox') {
        await pool.query('UPDATE signature_fields SET value = $1 WHERE id = $2', [e2.value ? 'true' : 'false', fl.id]);
      } else {
        await pool.query('UPDATE signature_fields SET value = $1 WHERE id = $2', [String(e2.value || '').slice(0, 2000), fl.id]);
      }
    }
    await pool.query("UPDATE signature_signers SET status = 'signed', signed_at = NOW(), consent_accepted = true, token = NULL WHERE id = $1", [signer.id]);
    await logEvent(request.id, signer.id, 'signed', signer.name, req, {});

    var remaining = (await pool.query("SELECT COUNT(*)::int AS n FROM signature_signers WHERE request_id = $1 AND status <> 'signed'", [request.id])).rows[0].n;
    if (remaining === 0) {
      try { await flattenAndComplete(request.id); }
      catch (e) { console.error('Flatten failed, marking completed anyway:', e.message); await pool.query("UPDATE signature_requests SET status = 'completed', completed_at = NOW() WHERE id = $1", [request.id]); }
    } else {
      await pool.query("UPDATE signature_requests SET status = 'partially_signed', updated_at = NOW() WHERE id = $1", [request.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit your signature' });
  }
});

pub.post('/:token/delegate', async (req, res) => {
  try {
    const ctx = await loadSignerByToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Invalid link.' });
    const signer = ctx.signer, request = ctx.request;
    var te = tokenError(signer, request);
    if (te) return res.status(te.code).json({ error: te.msg });
    if (signer.status === 'signed') return res.status(409).json({ error: 'You have already signed this document.' });
    var name = (req.body.name || '').toString().trim().slice(0, 255);
    var email = (req.body.email || '').toString().trim().slice(0, 255);
    var reason = (req.body.reason || '').toString().slice(0, 500);
    if (!name || !email || email.indexOf('@') === -1) return res.status(400).json({ error: 'A name and valid email are required.' });
    var oldName = signer.name, oldEmail = signer.email;
    var newToken = crypto.randomBytes(32).toString('hex');
    var expires = signer.token_expires_at ? new Date(signer.token_expires_at) : new Date(Date.now() + 30 * 86400000);
    // Reassign this signer slot to the delegate (their field assignments carry over),
    // issue a fresh single-use token, and reset their progress.
    await pool.query("UPDATE signature_signers SET name = $1, email = $2, token = $3, token_expires_at = $4, status = 'pending', consent_accepted = false, signed_at = NULL WHERE id = $5", [name, email, newToken, expires, signer.id]);
    await logEvent(request.id, signer.id, 'delegated', oldName || oldEmail, req, { to_name: name, to_email: email, reason: reason });
    var link = (process.env.APP_URL || '').replace(/\/$/, '') + '/sign/' + newToken;
    try {
      var html = emailTemplate({ badge: 'Signature requested', badgeColor: 'orange', title: 'Please sign: ' + request.title,
        body: 'Hi ' + name + ',<br><br>' + (oldName || 'Someone') + ' has asked you to sign this document on their behalf.' + (reason ? ('<br><br>Note: ' + reason) : ''),
        details: [{ label: 'Document', value: request.title }, { label: 'Reference', value: request.request_number }],
        buttonText: 'Review & sign', buttonUrl: link, footerNote: 'Secure, single-use signing link. Do not forward it.' });
      await sendEmail(email, 'Signature requested: ' + request.title, html);
    } catch (e) { console.error('Delegate email failed:', e.message); }
    try {
      var creator = (await pool.query('SELECT email FROM users WHERE id = $1', [request.created_by])).rows[0];
      if (creator && creator.email) {
        var chtml = emailTemplate({ badge: 'Forwarded', badgeColor: 'orange', title: 'Signer forwarded: ' + request.title,
          body: (oldName || oldEmail || 'A signer') + ' forwarded their signature to <strong>' + name + ' (' + email + ')</strong>.' + (reason ? ('<br><br>Reason: ' + reason) : ''),
          details: [{ label: 'Reference', value: request.request_number }], footerNote: 'Automated Nova notification.' });
        await sendEmail(creator.email, 'Signer forwarded: ' + request.title, chtml);
      }
    } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error('Delegate error:', err);
    res.status(500).json({ error: 'Failed to forward the request' });
  }
});

pub.post('/:token/decline', async (req, res) => {
  try {
    const ctx = await loadSignerByToken(req.params.token);
    if (!ctx) return res.status(404).json({ error: 'Invalid link.' });
    const signer = ctx.signer, request = ctx.request;
    var te = tokenError(signer, request);
    if (te) return res.status(te.code).json({ error: te.msg });
    var reason = (req.body.reason || '').toString().slice(0, 500);
    await pool.query("UPDATE signature_signers SET status = 'declined', declined_reason = $1, token = NULL WHERE id = $2", [reason || null, signer.id]);
    await pool.query("UPDATE signature_requests SET status = 'declined', updated_at = NOW() WHERE id = $1", [request.id]);
    await logEvent(request.id, signer.id, 'declined', signer.name, req, { reason: reason });
    // Notify the creator.
    try {
      var creator = (await pool.query('SELECT email FROM users WHERE id = $1', [request.created_by])).rows[0];
      if (creator && creator.email) {
        var html = emailTemplate({ badge: 'Declined', badgeColor: 'red', title: 'Declined: ' + request.title,
          body: (signer.name || 'A signer') + ' declined to sign.' + (reason ? ('<br><br>Reason: ' + reason) : ''),
          details: [{ label: 'Reference', value: request.request_number }], footerNote: 'Nova signatures.' });
        await sendEmail(creator.email, 'Declined: ' + request.title, html);
      }
    } catch (e) {}
    try {
      var _bd = await notify.broadcastRecipients('signature_declined', "role IN ('admin','owner')");
      if (_bd.emails && _bd.emails.length) {
        var dhtml = emailTemplate({ badge: 'Declined', badgeColor: 'red', title: 'Signature declined: ' + request.title,
          body: (signer.name || 'A signer') + ' declined to sign "' + (request.title || '') + '".' + (reason ? ('<br><br>Reason: ' + reason) : ''),
          details: [{ label: 'Reference', value: request.request_number }], footerNote: 'Automated Nova notification.' });
        await sendEmail(_bd.emails, 'Signature declined: ' + request.title, dhtml);
      }
    } catch (e) {}
    res.json({ success: true });
  } catch (err) { console.error('Decline error:', err); res.status(500).json({ error: 'Failed to record decline' }); }
});

module.exports = router;
module.exports.publicRouter = pub;

