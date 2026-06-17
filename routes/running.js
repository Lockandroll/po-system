const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const ADMIN = ['admin', 'manager'];

function getInitials(name) {
  return (name || '').split(' ').map(function(w){ return w[0] || ''; }).join('').toUpperCase().slice(0, 3);
}

function computeTotal(items) {
  return items.reduce(function(sum, i) { return sum + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0); }, 0);
}

// Mirrors the PO numbering scheme used in routes/pos.js
async function generatePONumber(cityCode, userInitials) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(po_number, '-', 3) AS INTEGER)) as maxseq FROM purchase_orders WHERE EXTRACT(YEAR FROM created_at) = $1",
    [year]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return cityCode + '-' + year + '-' + seq + '-' + userInitials;
}

// GET the current user's own active running list
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM running_list_items WHERE requester_id = $1 AND status = 'active' ORDER BY created_at ASC",
    [req.user.id]
  );
  res.json(rows);
});

// GET every active item across all requesters, with requester name (admin/manager)
router.get('/admin', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT r.*, u.name AS requester_name FROM running_list_items r " +
    "LEFT JOIN users u ON r.requester_id = u.id " +
    "WHERE r.status = 'active' ORDER BY r.city_code ASC, r.created_at ASC"
  );
  res.json(rows);
});

// POST create an item (requester adds to own list; admin can add to any city)
router.post('/', requireAuth, async (req, res) => {
  const description = (req.body.description || '').trim();
  const city_code = req.body.city_code ? req.body.city_code.toUpperCase() : null;
  if (!description) return res.status(400).json({ error: 'Description is required' });
  if (!city_code) return res.status(400).json({ error: 'City is required' });
  const { rows } = await pool.query(
    'INSERT INTO running_list_items (requester_id, city_code, description, quantity, unit_price, vendor_name, part_number, link, notes) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.user.id, city_code, description, req.body.quantity || 1, req.body.unit_price || null, req.body.vendor_name || null, req.body.part_number || null, req.body.link || null, req.body.notes || null]
  );
  res.status(201).json(rows[0]);
});

// PUT update an item (owner or admin/manager)
router.put('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM running_list_items WHERE id = $1', [req.params.id]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.requester_id !== req.user.id && !ADMIN.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const b = req.body;
  const { rows: updated } = await pool.query(
    'UPDATE running_list_items SET description=$1, quantity=$2, unit_price=$3, vendor_name=$4, part_number=$5, link=$6, notes=$7, city_code=$8, updated_at=NOW() WHERE id=$9 RETURNING *',
    [
      b.description != null ? b.description : item.description,
      b.quantity != null ? b.quantity : item.quantity,
      b.unit_price !== undefined ? b.unit_price : item.unit_price,
      b.vendor_name !== undefined ? b.vendor_name : item.vendor_name,
      b.part_number !== undefined ? b.part_number : item.part_number,
      b.link !== undefined ? b.link : item.link,
      b.notes !== undefined ? b.notes : item.notes,
      b.city_code ? b.city_code.toUpperCase() : item.city_code,
      req.params.id
    ]
  );
  res.json(updated[0]);
});

// DELETE an item (owner or admin/manager)
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM running_list_items WHERE id = $1', [req.params.id]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.requester_id !== req.user.id && !ADMIN.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await pool.query('DELETE FROM running_list_items WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// POST roll a city's running list into a single draft PO (admin/manager)
// Body: { city_code, vendor_name, item_ids? } — if item_ids omitted, pushes all active items for the city
router.post('/create-po', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  const city_code = req.body.city_code ? req.body.city_code.toUpperCase() : null;
  const requested_vendor = (req.body.vendor_name || '').trim();
  const item_ids = Array.isArray(req.body.item_ids) ? req.body.item_ids : null;
  if (!city_code) return res.status(400).json({ error: 'City is required' });

  let itemsQuery = "SELECT * FROM running_list_items WHERE status = 'active' AND city_code = $1";
  const params = [city_code];
  if (item_ids && item_ids.length) {
    itemsQuery += ' AND id = ANY($2)';
    params.push(item_ids);
  }
  itemsQuery += ' ORDER BY created_at ASC';
  const { rows: items } = await pool.query(itemsQuery, params);
  if (!items.length) return res.status(400).json({ error: 'No items to push for this city' });

  // One combined PO for the whole city, including items from every vendor.
  // The running list stores a vendor per item, but a PO has a single vendor field,
  // so derive it from the items: the distinct vendor names joined, or a generic
  // fallback if none are set. An explicit vendor_name in the request still wins.
  const distinctVendors = [...new Set(items.map(function(i){ return (i.vendor_name || '').trim(); }).filter(Boolean))];
  const vendor_name = requested_vendor || (distinctVendors.length ? distinctVendors.join(', ') : 'Various Vendors');

  const po_number = await generatePONumber(city_code, getInitials(req.user.name));
  const total_amount = computeTotal(items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: poRows } = await client.query(
      'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, customer_name, city_code, notes, total_amount) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [po_number, req.user.id, vendor_name, null, city_code, 'Created from ' + city_code + ' running list', total_amount]
    );
    const po = poRows[0];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await client.query(
        'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
        [po.id, it.part_number || null, null, it.description, it.quantity || 1, it.unit_price || 0]
      );
      await client.query(
        "UPDATE running_list_items SET status='consumed', po_id=$1, updated_at=NOW() WHERE id=$2",
        [po.id, it.id]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { source: 'running_list', city: city_code, items: items.length, total: total_amount } });
    res.status(201).json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
