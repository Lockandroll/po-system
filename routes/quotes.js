const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');

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
    if (['admin','approver','manager'].includes(req.user.role)) {
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

// GET single quote with line items and requester contact info
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT q.*, u.name as requester_name, u.email as requester_email, u.phone as requester_phone FROM quotes q JOIN users u ON q.requester_id = u.id WHERE q.id = $1',
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
  const { customer_name, city_code, notes, important_info, tax_rate, line_items } = req.body;
  if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
  const initials = getInitials(req.user.name);
  const quote_number = await generateQuoteNumber(initials);
  const taxRateVal = parseFloat(tax_rate) || 0;
  // Subtotal based on list_price; tax only on taxable items
  const subtotal = (line_items || []).reduce(function(sum, item) {
    return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0));
  }, 0);
  const taxableSubtotal = (line_items || []).reduce(function(sum, item) {
    return item.taxable ? sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0)) : sum;
  }, 0);
  const tax_amount = taxableSubtotal * taxRateVal / 100;
  const total = subtotal + tax_amount;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO quotes (quote_number, requester_id, customer_name, city_code, notes, important_info, tax_rate, tax_amount, total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [quote_number, req.user.id, customer_name, city_code || null, notes || null, important_info || null, taxRateVal, tax_amount, total]
    );
    const quote = rows[0];
    for (const item of (line_items || [])) {
      await client.query(
        'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price, list_price, taxable, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [quote.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price || 0, item.list_price || 0, item.taxable || false, item.url || null]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { customer: customer_name, total } });

    try {
      const { rows: admins } = await pool.query("SELECT email, name FROM users WHERE role = 'admin' AND active = true AND receive_emails = true");
      if (admins.length) {
        const emails = admins.map(function(a) { return a.email; });
        const html = emailTemplate({
          badge: 'New quote',
          title: 'A new quote has been created',
          body: '<strong>' + req.user.name + '</strong> created a new quote.',
          details: [
            { label: 'Quote number', value: quote_number },
            { label: 'Customer', value: customer_name },
            { label: 'City', value: city_code || '—' },
            { label: 'Total', value: '$' + total.toFixed(2) },
            { label: 'Created by', value: req.user.name }
          ],
          buttonText: 'View Quote',
          buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-quote&id=' + quote.id
        });
        await sendEmail(emails, 'New Quote: ' + quote_number, html);
      }
    } catch (emailErr) {
      console.error('Quote email notification failed:', emailErr);
    }

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
    const { customer_name, city_code, notes, important_info, tax_rate, line_items } = req.body;
    if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
    const taxRateVal = parseFloat(tax_rate) || 0;
    const subtotal = (line_items || []).reduce(function(sum, item) {
      return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0));
    }, 0);
    const taxableSubtotal = (line_items || []).reduce(function(sum, item) {
      return item.taxable ? sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0)) : sum;
    }, 0);
    const tax_amount = taxableSubtotal * taxRateVal / 100;
    const total = subtotal + tax_amount;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE quotes SET customer_name=$1, city_code=$2, notes=$3, important_info=$4, tax_rate=$5, tax_amount=$6, total_amount=$7, updated_at=NOW() WHERE id=$8',
        [customer_name, city_code || null, notes || null, important_info || null, taxRateVal, tax_amount, total, req.params.id]
      );
      await client.query('DELETE FROM quote_line_items WHERE quote_id = $1', [req.params.id]);
      for (const item of (line_items || [])) {
        await client.query(
          'INSERT INTO quote_line_items (quote_id, item_number, manufacturer, description, quantity, unit_price, list_price, taxable, url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [req.params.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price || 0, item.list_price || 0, item.taxable || false, item.url || null]
        );
      }
      await client.query('COMMIT');
      await logAudit({ entity_type: 'quote', entity_id: parseInt(req.params.id), entity_number: quote.quote_number, action: 'edited', user_id: req.user.id, user_name: req.user.name });
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
    await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote.quote_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete quote' });
  }
});

module.exports = router;
