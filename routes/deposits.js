const express = require('express');
const https = require('https');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Roles that can see every deposit (not just their own)
const SEE_ALL = ['admin', 'manager'];
// Roles that can export and delete
const MANAGE = ['admin', 'manager'];

async function generateDepositNumber() {
  const year = new Date().getFullYear();
  const prefix = 'DEP-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(deposit_number, '-', 3) AS INTEGER)) as maxseq FROM deposits WHERE deposit_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'DEP-' + year + '-' + seq;
}

// POST /ai-extract — read a deposit receipt photo and return amount + date.
// The tech reviews/edits the prefilled values before submitting.
router.post('/ai-extract', requireAuth, requirePermission('create_deposit'), async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data provided' });

  const prompt = 'You are reading a bank cash deposit receipt or deposit slip. ' +
    'Extract ONLY the following fields and return ONLY valid JSON (no explanation, no markdown):\n' +
    '{\n' +
    '  "amount": 0.00,\n' +
    '  "deposit_date": "YYYY-MM-DD"\n' +
    '}\n' +
    'amount is the total cash/deposit amount as a number with no currency symbol or commas. ' +
    'deposit_date is the date printed on the receipt in YYYY-MM-DD format. ' +
    'If a field is not found, use null.';

  const isPdf = (mediaType || '').toLowerCase() === 'application/pdf';
  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imageData } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } };

  const body = JSON.stringify({
    model: 'claude-opus-4-8',
    max_tokens: 512,
    messages: [{ role: 'user', content: [ contentBlock, { type: 'text', text: prompt } ] }]
  });

  try {
    const result = await new Promise(function(resolve, reject) {
      var headers = {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      };
      if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
      const options = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: headers };
      const request = https.request(options, function(r) {
        var data = '';
        r.on('data', function(chunk) { data += chunk; });
        r.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      request.on('error', reject);
      request.write(body);
      request.end();
    });
    if (result.error) return res.status(500).json({ error: result.error.message });
    const text = (result.content[0].text || '').trim();
    // Extract the JSON object without relying on markdown fences (keeps this file backtick-free)
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    const jsonStr = (start !== -1 && end !== -1) ? text.slice(start, end + 1) : text;
    const extracted = JSON.parse(jsonStr);
    res.json(extracted);
  } catch (err) {
    console.error('Deposit AI extract error:', err);
    res.status(500).json({ error: 'Failed to extract data from image' });
  }
});

// POST / — submit a deposit with optional Pulsar-owed figure, multiple receipt
// photos, and expense lines (each expense may carry its own photo).
router.post('/', requireAuth, requirePermission('create_deposit'), async function(req, res) {
  const client = await pool.connect();
  try {
    const { amount, deposit_date, period_start, period_end, city_code, notes, pulsar_owed, receipt_image, receipt_filename } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      client.release();
      return res.status(400).json({ error: 'A valid deposit amount is required' });
    }
    if (!deposit_date) {
      client.release();
      return res.status(400).json({ error: 'Deposit date is required' });
    }
    const owed = (pulsar_owed === '' || pulsar_owed == null || isNaN(parseFloat(pulsar_owed))) ? null : parseFloat(pulsar_owed);
    // Receipts: prefer the receipts[] array; fall back to the legacy single image.
    let receipts = Array.isArray(req.body.receipts) ? req.body.receipts : [];
    if (!receipts.length && receipt_image) receipts = [{ image: receipt_image, filename: receipt_filename || null }];
    const expenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
    const deposit_number = await generateDepositNumber();
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO deposits (deposit_number, user_id, user_name, city_code, amount, deposit_date, period_start, period_end, notes, pulsar_owed) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, deposit_number, user_id, user_name, city_code, amount, deposit_date, period_start, period_end, notes, pulsar_owed, created_at',
      [
        deposit_number,
        req.user.id,
        req.user.name,
        city_code || null,
        amt,
        deposit_date,
        period_start || null,
        period_end || null,
        notes || null,
        owed
      ]
    );
    const dep = rows[0];
    for (let i = 0; i < receipts.length; i++) {
      const rc = receipts[i];
      if (rc && rc.image) {
        await client.query(
          'INSERT INTO deposit_receipts (deposit_id, image, filename) VALUES ($1,$2,$3)',
          [dep.id, rc.image, rc.filename || null]
        );
      }
    }
    let expenseTotal = 0;
    for (let j = 0; j < expenses.length; j++) {
      const ex = expenses[j];
      if (!ex) continue;
      const exAmt = parseFloat(ex.amount);
      const desc = (ex.description == null ? '' : String(ex.description)).slice(0, 500);
      if (!desc && isNaN(exAmt)) continue;
      const safeAmt = isNaN(exAmt) ? 0 : exAmt;
      expenseTotal += safeAmt;
      await client.query(
        'INSERT INTO deposit_expenses (deposit_id, description, amount, receipt_image, receipt_filename) VALUES ($1,$2,$3,$4,$5)',
        [dep.id, desc || null, safeAmt, ex.image || null, ex.filename || null]
      );
    }
    await client.query('COMMIT');
    await logAudit({
      entity_type: 'deposit',
      entity_id: dep.id,
      entity_number: dep.deposit_number,
      action: 'created',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { amount: amt, pulsar_owed: owed, expense_total: expenseTotal, city_code: city_code || null }
    });
    res.status(201).json(dep);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to submit deposit' });
  } finally {
    client.release();
  }
});

// GET / — list deposits (own for employees; all for see-all roles).
// Includes pulsar_owed and a summed expense total so the client can show Over/Short.
// Never returns receipt images in the list (kept lightweight).
router.get('/', requireAuth, requirePermission('view_deposits'), async function(req, res) {
  try {
    const cols = 'd.id, d.deposit_number, d.user_id, COALESCE(u.name, d.user_name) AS user_name, d.city_code, d.amount, d.pulsar_owed, d.deposit_date, d.period_start, d.period_end, d.notes, d.receipt_filename, ' +
      '(d.receipt_image IS NOT NULL OR EXISTS(SELECT 1 FROM deposit_receipts r WHERE r.deposit_id = d.id)) AS has_receipt, ' +
      'COALESCE((SELECT SUM(e.amount) FROM deposit_expenses e WHERE e.deposit_id = d.id), 0) AS total_expenses, ' +
      'd.created_at';
    let query, params;
    if (SEE_ALL.includes(req.user.role)) {
      query = 'SELECT ' + cols + ' FROM deposits d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.deposit_date DESC, d.created_at DESC';
      params = [];
    } else {
      query = 'SELECT ' + cols + ' FROM deposits d LEFT JOIN users u ON u.id = d.user_id WHERE d.user_id = $1 ORDER BY d.deposit_date DESC, d.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deposits' });
  }
});

// GET /export — all deposits for CSV (admin/manager only). No images.
router.get('/export', requireAuth, requirePermission('export_deposits'), async function(req, res) {
  if (!MANAGE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT d.deposit_number, COALESCE(u.name, d.user_name) AS user_name, d.city_code, d.amount, d.pulsar_owed, d.deposit_date, d.period_start, d.period_end, d.notes, d.receipt_filename, ' +
      '(d.receipt_image IS NOT NULL OR EXISTS(SELECT 1 FROM deposit_receipts r WHERE r.deposit_id = d.id)) AS has_receipt, ' +
      'COALESCE((SELECT SUM(e.amount) FROM deposit_expenses e WHERE e.deposit_id = d.id), 0) AS total_expenses, ' +
      'd.created_at FROM deposits d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.deposit_date DESC, d.created_at DESC'
    );
    res.json({ deposits: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export deposits' });
  }
});

// GET /:id — single deposit incl. receipts and expenses (owner or see-all roles)
router.get('/:id', requireAuth, requirePermission('view_deposits'), async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT d.*, u.name AS current_user_name FROM deposits d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found' });
    const dep = rows[0];
    if (dep.current_user_name) dep.user_name = dep.current_user_name;
    delete dep.current_user_name;
    if (!SEE_ALL.includes(req.user.role) && dep.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const rc = await pool.query('SELECT id, image, filename FROM deposit_receipts WHERE deposit_id = $1 ORDER BY id', [dep.id]);
    dep.receipts = rc.rows;
    // Back-compat: surface the legacy single image as a receipt if no child rows exist.
    if (!dep.receipts.length && dep.receipt_image) {
      dep.receipts = [{ id: null, image: dep.receipt_image, filename: dep.receipt_filename || null }];
    }
    const ex = await pool.query('SELECT id, description, amount, receipt_image, receipt_filename FROM deposit_expenses WHERE deposit_id = $1 ORDER BY id', [dep.id]);
    dep.expenses = ex.rows;
    res.json(dep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deposit' });
  }
});

// DELETE /:id — admin/manager only. Child receipts/expenses cascade.
router.delete('/:id', requireAuth, requirePermission('delete_deposit'), async function(req, res) {
  if (!MANAGE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await pool.query('DELETE FROM deposits WHERE id = $1 RETURNING id, deposit_number', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found' });
    await logAudit({
      entity_type: 'deposit',
      entity_id: rows[0].id,
      entity_number: rows[0].deposit_number,
      action: 'deleted',
      user_id: req.user.id,
      user_name: req.user.name
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete deposit' });
  }
});

module.exports = router;
