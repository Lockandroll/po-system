const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function getInitials(name) {
  return name.split(' ').filter(Boolean).map(function(p) { return p[0]; }).join('').toUpperCase().slice(0, 3);
}

async function generateQuoteNumber(userInitials) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT COUNT(*) FROM quotes WHERE EXTRACT(YEAR FROM created_at) = $1",
    [year]
  );
  const seq = String(parseInt(rows[0].count) + 1).padStart(4, '0');
  return 'QT-' + year + '-' + seq + '-' + userInitials;
}

// GET all quotes (own only, unless admin)
router.get('/', requireAuth, async (req, res) => {
  try {
    let query, params;
    if (req.user.role === 'admin') {
      query = 'SELECT q.*, u.name as requester_name FROM quotes q JOIN users u ON q.requester_id = u.id ORDER BY q.created_at DESC';
      params = [];
    } else {
      query = 'SELECT q.*, u.name as requester_name FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.requester_id = $1 ORDER BY q.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quotes' });
  }
});

// GET single quote with line items
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT q.*, u.name as requester_name FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: items } = await pool.query(
      'SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id',
      [req.params.id]
    );
    quote.line_items = items;
    res.json(quote);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

// POST create quote
router.post('/', requireAuth, async (req, res) => {
  const { customer_name, city_code, notes, line_items } = req.body;
  if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
  const initials = getInitials(req.user.name);
  const quote_number = await generateQuoteNumber(initials);
  const total = (line_items || []).reduce(function(sum, item) {
    return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0));
  }, 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO quotes (quote_number, requester_id, customer_name, city_code, notes, total_amount) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [quote_number, req.user.id, customer_name, city_code || null, notes || null, total]
    );
    const quote = rows[0];
    for (const item of (line_items || [])) {
      await client.query(
        'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
        [quote.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(quote);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create quote' });
  } finally {
    client.release();
  }
});

// PUT update quote
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { customer_name, city_code, notes, line_items } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    const total = (line_items || []).reduce(function(sum, item) {
      return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0));
    }, 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE quotes SET customer_name=$1, city_code=$2, notes=$3, total_amount=$4, updated_at=NOW() WHERE id=$5',
        [customer_name, city_code || null, notes || null, total, req.params.id]
      );
      await client.query('DELETE FROM quote_line_items WHERE quote_id = $1', [req.params.id]);
      for (const item of (line_items || [])) {
        await client.query(
          'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
          [req.params.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price]
        );
      }
      await client.query('COMMIT');
      res.json({ success: true, id: parseInt(req.params.id) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// DELETE quote
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await pool.query('DELETE FROM quotes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

module.exports = router;
