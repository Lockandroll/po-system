const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Roles that can see every deposit (not just their own)
const SEE_ALL = ['admin', 'manager', 'approver'];
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

// POST / — submit a deposit (any authenticated user, for themselves)
router.post('/', requireAuth, async function(req, res) {
  try {
    const { amount, deposit_date, city_code, bank_name, notes, receipt_image, receipt_filename } = req.body;
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ error: 'A valid deposit amount is required' });
    }
    if (!deposit_date) {
      return res.status(400).json({ error: 'Deposit date is required' });
    }
    const deposit_number = await generateDepositNumber();
    const { rows } = await pool.query(
      'INSERT INTO deposits (deposit_number, user_id, user_name, city_code, amount, deposit_date, bank_name, notes, receipt_image, receipt_filename) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, deposit_number, user_id, user_name, city_code, amount, deposit_date, bank_name, notes, receipt_filename, created_at',
      [
        deposit_number,
        req.user.id,
        req.user.name,
        city_code || null,
        amt,
        deposit_date,
        bank_name || null,
        notes || null,
        receipt_image || null,
        receipt_filename || null
      ]
    );
    const dep = rows[0];
    await logAudit({
      entity_type: 'deposit',
      entity_id: dep.id,
      entity_number: dep.deposit_number,
      action: 'created',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { amount: amt, city_code: city_code || null }
    });
    res.status(201).json(dep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit deposit' });
  }
});

// GET / — list deposits (own for requester; all for admin/manager/approver).
// Never returns the receipt image in the list (kept lightweight).
router.get('/', requireAuth, async function(req, res) {
  try {
    const cols = 'id, deposit_number, user_id, user_name, city_code, amount, deposit_date, bank_name, notes, receipt_filename, ' +
      '(receipt_image IS NOT NULL) AS has_receipt, created_at';
    let query, params;
    if (SEE_ALL.includes(req.user.role)) {
      query = 'SELECT ' + cols + ' FROM deposits ORDER BY deposit_date DESC, created_at DESC';
      params = [];
    } else {
      query = 'SELECT ' + cols + ' FROM deposits WHERE user_id = $1 ORDER BY deposit_date DESC, created_at DESC';
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
router.get('/export', requireAuth, async function(req, res) {
  if (!MANAGE.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT deposit_number, user_name, city_code, amount, deposit_date, bank_name, notes, receipt_filename, ' +
      '(receipt_image IS NOT NULL) AS has_receipt, created_at FROM deposits ORDER BY deposit_date DESC, created_at DESC'
    );
    res.json({ deposits: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export deposits' });
  }
});

// GET /:id — single deposit incl. receipt image (owner or see-all roles)
router.get('/:id', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Deposit not found' });
    const dep = rows[0];
    if (!SEE_ALL.includes(req.user.role) && dep.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(dep);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch deposit' });
  }
});

// DELETE /:id — admin/manager only
router.delete('/:id', requireAuth, async function(req, res) {
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
