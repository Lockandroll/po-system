const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');
const r2 = require('../utils/r2');
const { buildInvoicePdf } = require('../utils/invoicePdf');

const router = express.Router();

function sanitizeName(n) {
  return String(n || 'photo').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'photo';
}

// ---- helpers ---------------------------------------------------------------

async function getSetting(key, fallback) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : fallback;
  } catch (e) { return fallback; }
}

async function generateInvoiceNumber() {
  const startRaw = await getSetting('invoice_start_number', '100001');
  const start = parseInt(startRaw, 10) || 100001;
  const { rows } = await pool.query('SELECT MAX(invoice_number) AS maxn FROM invoices');
  const maxn = rows[0] && rows[0].maxn != null ? parseInt(rows[0].maxn, 10) : null;
  return maxn != null ? (maxn + 1) : start;
}

function computeTotals(line_items, tax_rate, tip_amount, tax_exempt) {
  const rate = parseFloat(tax_rate) || 0;
  let labor = 0, parts = 0, taxable = 0;
  (line_items || []).forEach(function (it) {
    const ext = (parseFloat(it.quantity) || 0) * (parseFloat(it.unit_price) || 0);
    if (it.line_type === 'labor') labor += ext; else parts += ext;
    if (it.taxable) taxable += ext;
  });
  const subtotal = labor + parts;
  const tax_amount = tax_exempt ? 0 : (taxable * rate / 100);
  const tip = parseFloat(tip_amount) || 0;
  const grand_total = subtotal + tax_amount + tip;
  return { labor: labor, parts: parts, subtotal: subtotal, tax_amount: tax_amount, tip: tip, grand_total: grand_total };
}

function httpsGetJson(url) {
  return new Promise(function (resolve, reject) {
    https.get(url, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad JSON from upstream')); }
      });
    }).on('error', reject);
  });
}

function anthropicVision(dataUrl, instruction) {
  return new Promise(function (resolve, reject) {
    let media = 'image/jpeg', b64 = dataUrl;
    const m = /^data:([^;]+);base64,(.*)$/i.exec(dataUrl || '');
    if (m) { media = m[1]; b64 = m[2]; }
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: b64 } },
          { type: 'text', text: instruction }
        ]
      }]
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
    const req = https.request(options, function (res) {
      let data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('ID scan timed out. Please try again.')); });
    req.write(body);
    req.end();
  });
}

function canSeeAll(role) { return role === 'admin' || role === 'manager'; }

// ---- config / accounts -----------------------------------------------------

// Accounts that are flagged to appear in the invoice dropdown, with their config.
router.get('/accounts', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, account_number, invoice_notes, auto_line_items, agreement_text FROM vendors WHERE show_in_invoice = true ORDER BY name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice accounts' });
  }
});

// Default agreement text + start number (for the form + setup screen).
router.get('/config', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const agreement = await getSetting('invoice_default_agreement', '');
    let pay_types = [];
    try { pay_types = JSON.parse(await getSetting('invoice_pay_types', '[]')); } catch (e) { pay_types = []; }
    if (!Array.isArray(pay_types) || !pay_types.length) pay_types = ['Cash', 'Check', 'Visa', 'Mastercard', 'Amex', 'Discover', 'Debit', 'Motor Club', 'Account / Invoice', 'Other'];
    res.json({ default_agreement: agreement, pay_types: pay_types });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch invoice config' });
  }
});

// ---- smart inputs ----------------------------------------------------------

// Save the editable pay-type list (managers/admin).
router.post('/pay-types', requireAuth, requirePermission('manage_invoice_setup'), async (req, res) => {
  const { pay_types } = req.body;
  if (!Array.isArray(pay_types)) return res.status(400).json({ error: 'pay_types must be an array' });
  const clean = pay_types.map(function (p) { return String(p == null ? '' : p).trim(); }).filter(Boolean);
  try {
    await pool.query("INSERT INTO settings (key, value, updated_at) VALUES ('invoice_pay_types', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [JSON.stringify(clean)]);
    res.json({ ok: true, pay_types: clean });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to save pay types' }); }
});

// Scan VIN from a photo: AI reads the 17-character VIN off the plate/sticker/barcode.
router.post('/scan-vin', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This image shows a vehicle VIN (dash, door-jamb sticker, or a barcode label). Find the 17-character Vehicle Identification Number and respond with ONLY a JSON object: {"vin":""}. A VIN is exactly 17 characters of letters and digits (no I, O, or Q). If you cannot read it, return {"vin":""}.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    const vin = String(parsed.vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    res.json({ vin: vin });
  } catch (err) {
    console.error('VIN scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the VIN. Enter it manually.' });
  }
});

// VIN decode via NHTSA vPIC (free, no key). Returns year/make/model.
router.get('/decode-vin/:vin', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const vin = String(req.params.vin || '').trim();
  if (vin.length < 11) return res.status(400).json({ error: 'Enter a full VIN.' });
  try {
    const url = 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + encodeURIComponent(vin) + '?format=json';
    const j = await httpsGetJson(url);
    const r = (j.Results && j.Results[0]) || {};
    res.json({
      year: r.ModelYear || '',
      make: r.Make ? (r.Make.charAt(0) + r.Make.slice(1).toLowerCase()) : '',
      model: r.Model || '',
      raw: { make: r.Make || '', model: r.Model || '', year: r.ModelYear || '' }
    });
  } catch (err) {
    console.error('VIN decode failed:', err.message);
    res.status(502).json({ error: 'Could not reach the VIN decoder. Enter the vehicle manually.' });
  }
});

// ID scan: extract customer fields from a photo of a license (front or back).
router.post('/scan-id', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This is a photo of a driver license or state ID. Extract the holder information and respond with ONLY a JSON object, no prose, using these exact keys (use an empty string if a field is not present): {"customer_name":"","dl_number":"","dl_state":"","street_address":"","city":"","state":"","zip":""}. customer_name should be the full name in First Last order. dl_state and state are 2-letter codes.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) {
      resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    }
    if (!text) return res.status(502).json({ error: 'Could not read the ID. Enter details manually.' });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    res.json({
      customer_name: parsed.customer_name || '',
      dl_number: parsed.dl_number || '',
      dl_state: parsed.dl_state || '',
      street_address: parsed.street_address || '',
      city: parsed.city || '',
      state: parsed.state || '',
      zip: parsed.zip || ''
    });
  } catch (err) {
    console.error('ID scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the ID. Enter details manually.' });
  }
});


// Plate scan: read a license plate number + state from a photo.
router.post('/scan-plate', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'No image provided.' });
  const instruction = 'This is a photo of a vehicle license plate (tag). Read the plate and respond with ONLY a JSON object, no prose, using these exact keys (use an empty string if a field is not present): {"plate":"","state":""}. plate is the alphanumeric plate/tag number with no spaces or dashes, uppercase. state is the 2-letter code of the issuing state if it is printed on the plate. Ignore slogans, county names, sticker months, and the word the state spells out unless it is the issuing state. If you cannot read the plate, return {"plate":"","state":""}.';
  try {
    const resp = await anthropicVision(image, instruction);
    let text = '';
    if (resp && Array.isArray(resp.content)) resp.content.forEach(function (b) { if (b.type === 'text') text += b.text; });
    let parsed = {};
    const jm = text.match(/\{[\s\S]*\}/);
    try { parsed = JSON.parse(jm ? jm[0] : text); } catch (e) { parsed = {}; }
    const plate = String(parsed.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const state = String(parsed.state || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
    res.json({ plate: plate, state: state });
  } catch (err) {
    console.error('Plate scan failed:', err.message);
    res.status(502).json({ error: 'Could not read the plate. Enter it manually.' });
  }
});

// ---- parts usage report ----------------------------------------------------

// Aggregated part usage for a month (YYYY-MM). Feeds month-end ordering.
router.get('/parts-report', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    const now = new Date();
    let y = now.getFullYear(), mo = now.getMonth() + 1;
    if (m) { y = parseInt(m[1], 10); mo = parseInt(m[2], 10); }
    const start = y + '-' + String(mo).padStart(2, '0') + '-01';
    const ny = mo === 12 ? y + 1 : y;
    const nmo = mo === 12 ? 1 : mo + 1;
    const end = ny + '-' + String(nmo).padStart(2, '0') + '-01';
    const { rows } = await pool.query(
      "SELECT COALESCE(NULLIF(li.item_number, ''), p.item_number) AS item_number, " +
      "       li.description, p.preferred_vendor, " +
      "       SUM(li.quantity) AS total_qty, COUNT(DISTINCT inv.id) AS invoice_count, " +
      "       AVG(li.unit_price) AS avg_price " +
      "FROM invoice_line_items li " +
      "JOIN invoices inv ON inv.id = li.invoice_id " +
      "LEFT JOIN parts p ON p.id = li.part_id " +
      "WHERE li.line_type = 'part' AND inv.invoice_date >= $1 AND inv.invoice_date < $2 " +
      "GROUP BY COALESCE(NULLIF(li.item_number, ''), p.item_number), li.description, p.preferred_vendor " +
      "ORDER BY total_qty DESC",
      [start, end]
    );
    res.json({ month: y + '-' + String(mo).padStart(2, '0'), items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build parts report' });
  }
});

// Push selected aggregated parts into the Monthly Req (running list).
router.post('/parts-report/add-to-req', requireAuth, requirePermission('manage_running'), async (req, res) => {
  const { items, city_code } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items to add.' });
  try {
    for (const it of items) {
      await pool.query(
        'INSERT INTO running_list_items (requester_id, city_code, description, quantity, unit_price, vendor_name, part_number, notes, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [req.user.id, city_code || null, it.description || 'Part', parseFloat(it.quantity) || 1, it.unit_price != null ? it.unit_price : null, it.vendor_name || null, it.item_number || null, 'From invoices parts report', 'active']
      );
    }
    res.json({ ok: true, added: items.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add to Monthly Req' });
  }
});

// ---- CRUD ------------------------------------------------------------------

router.get('/', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    let query, params;
    if (canSeeAll(req.user.role)) {
      query = 'SELECT i.*, u.name AS locksmith_name_join FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id ORDER BY i.created_at DESC';
      params = [];
    } else {
      query = 'SELECT i.*, u.name AS locksmith_name_join FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.locksmith_id = $1 ORDER BY i.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

router.get('/:id', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT i.*, u.name AS locksmith_name_join, u.phone AS locksmith_phone, u.email AS locksmith_email FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const invoice = rows[0];
    if (!canSeeAll(req.user.role) && invoice.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const items = await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [req.params.id]);
    invoice.line_items = items.rows;
    // Attach photos with short-lived presigned view URLs (if R2 is configured).
    invoice.photos = [];
    try {
      const ph = await pool.query("SELECT id, filename, mime_type, caption, show_in_print, position, r2_key FROM invoice_photos WHERE invoice_id = $1 AND status = 'ready' ORDER BY position, id", [req.params.id]);
      for (const p of ph.rows) {
        let url = null;
        if (r2.configured()) { try { url = await r2.presignDownload(p.r2_key, p.filename || 'photo', true); } catch (e) {} }
        invoice.photos.push({ id: p.id, filename: p.filename, mime_type: p.mime_type, caption: p.caption, show_in_print: p.show_in_print, position: p.position, url: url });
      }
    } catch (e) { /* table may not exist yet on first deploy */ }
    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

// ---- Invoice photos (Cloudflare R2) ---------------------------------------
// Confirm the caller may modify this invoice (owner or a see-all role).
async function loadInvoiceForWrite(id, user) {
  const r = await pool.query('SELECT id, locksmith_id FROM invoices WHERE id = $1', [id]);
  if (!r.rows.length) return { error: 404 };
  if (!canSeeAll(user.role) && r.rows[0].locksmith_id !== user.id) return { error: 403 };
  return { invoice: r.rows[0] };
}

// Step 1: reserve a photo row + presigned PUT URL. Browser uploads bytes to R2 directly.
router.post('/:id/photos/upload-url', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const id = parseInt(req.params.id, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error === 404) return res.status(404).json({ error: 'Invoice not found' });
    if (chk.error === 403) return res.status(403).json({ error: 'Access denied' });
    const name = sanitizeName(req.body.name);
    const mime = (req.body.mime_type || 'image/jpeg').slice(0, 255);
    if (!/^image\//.test(mime)) return res.status(400).json({ error: 'Only image files can be attached as photos.' });
    const posRow = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM invoice_photos WHERE invoice_id = $1', [id]);
    const key = 'invoices/' + id + '/' + crypto.randomUUID() + '/' + name;
    const { rows } = await pool.query(
      "INSERT INTO invoice_photos (invoice_id, r2_key, filename, mime_type, position, status, uploaded_by) VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id",
      [id, key, name, mime, posRow.rows[0].next, req.user.id]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Invoice photo upload-url error:', err);
    res.status(500).json({ error: 'Failed to start photo upload' });
  }
});

// Step 2: confirm the upload finished; mark ready + record size.
router.post('/:id/photos/:photoId/confirm', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    const caption = (req.body.caption || '').toString().slice(0, 300);
    const r = await pool.query("UPDATE invoice_photos SET status = 'ready', size_bytes = $1, caption = $2 WHERE id = $3 AND invoice_id = $4 RETURNING id", [size, caption, photoId, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm photo' });
  }
});

// Update caption / show_in_print.
router.patch('/:id/photos/:photoId', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const sets = [], params = [];
    if (req.body.caption !== undefined) { params.push(String(req.body.caption).slice(0, 300)); sets.push('caption = $' + params.length); }
    if (req.body.show_in_print !== undefined) { params.push(req.body.show_in_print === true); sets.push('show_in_print = $' + params.length); }
    if (!sets.length) return res.json({ success: true });
    params.push(photoId); params.push(id);
    const r = await pool.query('UPDATE invoice_photos SET ' + sets.join(', ') + ' WHERE id = $' + (params.length - 1) + ' AND invoice_id = $' + params.length + ' RETURNING id', params);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo patch error:', err);
    res.status(500).json({ error: 'Failed to update photo' });
  }
});

// Delete a photo (R2 object + row).
router.delete('/:id/photos/:photoId', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const chk = await loadInvoiceForWrite(id, req.user);
    if (chk.error) return res.status(chk.error).json({ error: chk.error === 404 ? 'Invoice not found' : 'Access denied' });
    const r = await pool.query('SELECT r2_key FROM invoice_photos WHERE id = $1 AND invoice_id = $2', [photoId, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Photo not found' });
    try { await r2.deleteObject(r.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e.message); }
    await pool.query('DELETE FROM invoice_photos WHERE id = $1 AND invoice_id = $2', [photoId, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

// ---- Email the whole invoice as a PDF attachment (mirrors the document vault) ----
function escEmail(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
router.post('/:id/email', requireAuth, requirePermission('view_invoices'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ir = await pool.query('SELECT i.*, u.name AS locksmith_name_join FROM invoices i LEFT JOIN users u ON i.locksmith_id = u.id WHERE i.id = $1', [id]);
    if (!ir.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const inv = ir.rows[0];
    if (!canSeeAll(req.user.role) && inv.locksmith_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

    const to = (req.body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email address' });
    const toName = (req.body.to_name || '').toString().slice(0, 120);
    const message = (req.body.message || '').toString().slice(0, 2000);

    const items = (await pool.query('SELECT * FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position, id', [id])).rows;

    // Print-flagged photos → buffers from R2.
    const photos = [];
    try {
      const ph = (await pool.query("SELECT r2_key, caption FROM invoice_photos WHERE invoice_id = $1 AND show_in_print = true AND status = 'ready' ORDER BY position, id", [id])).rows;
      if (ph.length && r2.configured()) {
        for (const p of ph) {
          try { photos.push({ buffer: await r2.getObjectBuffer(p.r2_key), caption: p.caption }); } catch (e) { console.error('R2 photo fetch failed:', e.message); }
        }
      }
    } catch (e) { /* table may be absent on first deploy */ }

    const company = {
      name: await getSetting('company_name', 'Pop-A-Lock'),
      address: await getSetting('company_address', ''),
      csz: await getSetting('company_city_state_zip', ''),
      phone: await getSetting('company_phone', ''),
      logo: await getSetting('logo', '')
    };

    let pdfBuf;
    try { pdfBuf = await buildInvoicePdf(inv, items, photos, { company: company }); }
    catch (e) { console.error('Invoice PDF build failed:', e); return res.status(500).json({ error: 'Could not build the invoice PDF.' }); }
    if (pdfBuf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'The invoice PDF is over 20 MB and is too large to email. Remove some photos from the printed version and try again.' });

    const safeMsg = message ? escEmail(message).replace(/\n/g, '<br>') : '';
    const fileName = 'Invoice-' + (inv.invoice_number || id) + '.pdf';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
      '<p>' + (toName ? ('Hi ' + escEmail(toName) + ',') : 'Hello,') + '</p>' +
      '<p>Please find attached invoice <strong>#' + escEmail(String(inv.invoice_number || id)) + '</strong>' + (inv.grand_total != null ? (' for a total of <strong>$' + Number(inv.grand_total).toFixed(2) + '</strong>') : '') + '.</p>' +
      (safeMsg ? ('<p>' + safeMsg + '</p>') : '') +
      '<p>Sent by ' + escEmail(req.user.name) + ' on behalf of Lock and Roll LLC.</p>' +
      '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact Lock and Roll LLC directly with any questions.</p>' +
      '</div>';

    await sendEmail(
      to,
      'Invoice #' + (inv.invoice_number || id) + ' from Lock and Roll LLC',
      html,
      req.user.email || null,
      [{ filename: fileName, content: pdfBuf.toString('base64'), content_type: 'application/pdf' }]
    );
    try { await logAudit({ entity_type: 'invoice', entity_id: id, entity_number: String(inv.invoice_number || ''), action: 'email', user_id: req.user.id, user_name: req.user.name, details: { to: to } }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error('Invoice email error:', err);
    res.status(500).json({ error: 'Failed to send the invoice' });
  }
});

function pickInvoiceFields(b) {
  return {
    account_id: b.account_id || null,
    account_name: b.account_name || null,
    customer_po_wo: b.customer_po_wo || null,
    pay_type: b.pay_type || null,
    card_last4: b.card_last4 ? String(b.card_last4).replace(/\D/g, '').slice(-4) : null,
    cc_online: b.cc_online === true,
    time_in: b.time_in || null,
    time_out: b.time_out || null,
    customer_name: b.customer_name || null,
    dl_number: b.dl_number || null,
    dl_state: b.dl_state || null,
    street_address: b.street_address || null,
    city: b.city || null,
    state: b.state || null,
    zip: b.zip || null,
    phone: b.phone || null,
    email: b.email || null,
    vehicle_year: b.vehicle_year || null,
    vehicle_make: b.vehicle_make || null,
    vehicle_model: b.vehicle_model || null,
    license_tag: b.license_tag || null,
    tag_state: b.tag_state || null,
    vin: b.vin || null,
    mileage: b.mileage || null,
    ent_registration: b.ent_registration === true,
    ent_insurance: b.ent_insurance === true,
    ent_title: b.ent_title === true,
    ent_rental: b.ent_rental === true,
    notes: b.notes || null,
    payments_note: b.payments_note || null,
    agreement_text: b.agreement_text || null,
    signature_image: b.signature_image || null,
    signed_name: b.signed_name || b.customer_name || null,
    approval_code: b.approval_code || null,
    tax_exempt: b.tax_exempt === true,
    signature_required: b.signature_required === true
  };
}

async function insertLineItems(client, invoiceId, line_items) {
  let pos = 0;
  for (const it of (line_items || [])) {
    if (!it || !it.description) continue;
    await client.query(
      'INSERT INTO invoice_line_items (invoice_id, line_type, part_id, item_number, description, quantity, unit_price, taxable, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [invoiceId, it.line_type === 'labor' ? 'labor' : 'part', it.part_id || null, it.item_number || null, it.description, parseFloat(it.quantity) || 1, parseFloat(it.unit_price) || 0, it.taxable === true, pos++]
    );
  }
}

router.post('/', requireAuth, requirePermission('create_invoice'), async (req, res) => {
  const b = req.body || {};
  const f = pickInvoiceFields(b);
  const status = ['draft', 'completed', 'paid'].indexOf(b.status) !== -1 ? b.status : 'draft';
  if (f.signature_required && status !== 'draft' && !f.signature_image) {
    return res.status(400).json({ error: 'A signature is required before this invoice can be marked ' + status + '. Save as draft, or capture a signature.' });
  }
  const tax_rate = parseFloat(b.tax_rate) || 0;
  const t = computeTotals(b.line_items, tax_rate, b.tip_amount, b.tax_exempt === true);
  const invoice_date = b.invoice_date || new Date().toISOString().split('T')[0];
  const signedAt = f.signature_image ? new Date() : null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const invoice_number = await generateInvoiceNumber();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        'INSERT INTO invoices (invoice_number, locksmith_id, locksmith_name, invoice_date, status, account_id, account_name, customer_po_wo, pay_type, card_last4, cc_online, time_in, time_out, customer_name, dl_number, dl_state, street_address, city, state, zip, phone, email, vehicle_year, vehicle_make, vehicle_model, license_tag, tag_state, vin, mileage, ent_registration, ent_insurance, ent_title, ent_rental, tax_rate, labor_amount, parts_amount, subtotal, tax_amount, tip_amount, grand_total, notes, payments_note, agreement_text, signature_image, signed_name, signed_at, approval_code, tax_exempt, signature_required) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49) RETURNING *',
        [invoice_number, req.user.id, req.user.name, invoice_date, status, f.account_id, f.account_name, f.customer_po_wo, f.pay_type, f.card_last4, f.cc_online, f.time_in, f.time_out, f.customer_name, f.dl_number, f.dl_state, f.street_address, f.city, f.state, f.zip, f.phone, f.email, f.vehicle_year, f.vehicle_make, f.vehicle_model, f.license_tag, f.tag_state, f.vin, f.mileage, f.ent_registration, f.ent_insurance, f.ent_title, f.ent_rental, tax_rate, t.labor, t.parts, t.subtotal, t.tax_amount, t.tip, t.grand_total, f.notes, f.payments_note, f.agreement_text, f.signature_image, f.signed_name, signedAt, f.approval_code, f.tax_exempt, f.signature_required]
      );
      const invoice = ins.rows[0];
      await insertLineItems(client, invoice.id, b.line_items);
      await client.query('COMMIT');
      client.release();
      try { await logAudit({ entity_type: 'invoice', entity_id: invoice.id, entity_number: String(invoice_number), action: 'created', user_id: req.user.id, user_name: req.user.name, details: { customer: f.customer_name, total: t.grand_total } }); } catch (e) {}
      try {
        const _q = await notify.broadcastRecipients('invoice_created', "role IN ('admin', 'owner')");
        await push.sendPushToUsers(_q.userIds, { title: 'New invoice', body: req.user.name + ' created invoice #' + invoice_number + '.', url: '/' });
        if (_q.emails && _q.emails.length) {
          const html = emailTemplate({
            badge: 'New invoice', title: 'A new invoice was created',
            body: '<strong>' + req.user.name + '</strong> created invoice #' + invoice_number + '.',
            details: [
              { label: 'Invoice #', value: String(invoice_number) },
              { label: 'Customer', value: f.customer_name || '—' },
              { label: 'Account', value: f.account_name || '—' },
              { label: 'Grand Total', value: '$' + t.grand_total.toFixed(2) },
              { label: 'Created by', value: req.user.name }
            ],
            buttonText: 'View Invoice',
            buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-invoice&id=' + invoice.id
          });
          await sendEmail(_q.emails, 'New Invoice #' + invoice_number, html);
        }
      } catch (e) { console.error('Invoice notify failed:', e); }
      return res.status(201).json(invoice);
    } catch (err) {
      await client.query('ROLLBACK').catch(function () {});
      client.release();
      if (err.code === '23505' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create invoice: ' + err.message });
    }
  }
});

router.put('/:id', requireAuth, requirePermission('edit_invoice'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const existing = cur.rows[0];
    if (!canSeeAll(req.user.role) && existing.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const b = req.body || {};
    const f = pickInvoiceFields(b);
    const status = ['draft', 'completed', 'paid'].indexOf(b.status) !== -1 ? b.status : existing.status;
    if (f.signature_required && status !== 'draft' && !f.signature_image) {
      return res.status(400).json({ error: 'A signature is required before this invoice can be marked ' + status + '. Save as draft, or capture a signature.' });
    }
    const tax_rate = parseFloat(b.tax_rate) || 0;
    const t = computeTotals(b.line_items, tax_rate, b.tip_amount, b.tax_exempt === true);
    const invoice_date = b.invoice_date || existing.invoice_date;
    // Preserve original sign time; set it the first time a signature appears.
    let signedAt = existing.signed_at;
    if (f.signature_image && !existing.signed_at) signedAt = new Date();
    if (!f.signature_image) signedAt = existing.signed_at; // keep
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE invoices SET account_id=$1, account_name=$2, customer_po_wo=$3, pay_type=$4, card_last4=$5, cc_online=$6, time_in=$7, time_out=$8, customer_name=$9, dl_number=$10, dl_state=$11, street_address=$12, city=$13, state=$14, zip=$15, phone=$16, email=$17, vehicle_year=$18, vehicle_make=$19, vehicle_model=$20, license_tag=$21, tag_state=$22, vin=$23, mileage=$24, ent_registration=$25, ent_insurance=$26, ent_title=$27, ent_rental=$28, tax_rate=$29, labor_amount=$30, parts_amount=$31, subtotal=$32, tax_amount=$33, tip_amount=$34, grand_total=$35, notes=$36, payments_note=$37, agreement_text=$38, signature_image=$39, signed_name=$40, signed_at=$41, status=$42, invoice_date=$43, approval_code=$44, tax_exempt=$45, signature_required=$46, updated_at=NOW() WHERE id=$47',
        [f.account_id, f.account_name, f.customer_po_wo, f.pay_type, f.card_last4, f.cc_online, f.time_in, f.time_out, f.customer_name, f.dl_number, f.dl_state, f.street_address, f.city, f.state, f.zip, f.phone, f.email, f.vehicle_year, f.vehicle_make, f.vehicle_model, f.license_tag, f.tag_state, f.vin, f.mileage, f.ent_registration, f.ent_insurance, f.ent_title, f.ent_rental, tax_rate, t.labor, t.parts, t.subtotal, t.tax_amount, t.tip, t.grand_total, f.notes, f.payments_note, f.agreement_text, f.signature_image, f.signed_name, signedAt, status, invoice_date, f.approval_code, f.tax_exempt, f.signature_required, req.params.id]
      );
      await client.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [req.params.id]);
      await insertLineItems(client, parseInt(req.params.id, 10), b.line_items);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      client.release();
      throw err;
    }
    client.release();
    try { await logAudit({ entity_type: 'invoice', entity_id: parseInt(req.params.id, 10), entity_number: String(existing.invoice_number), action: 'edited', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true, id: parseInt(req.params.id, 10) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

router.delete('/:id', requireAuth, requirePermission('delete_invoice'), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Invoice not found' });
    const existing = cur.rows[0];
    if (!canSeeAll(req.user.role) && existing.locksmith_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await pool.query('DELETE FROM invoices WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'invoice', entity_id: existing.id, entity_number: String(existing.invoice_number), action: 'deleted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

module.exports = router;
