const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendEmail, emailTemplate } = require('../utils/email');

const router = express.Router();

function appUrl(path) {
  return (process.env.APP_URL || '').replace(/\/$/, '') + (path || '');
}

// Helper: compute total from line items
function computeTotal(items) {
  return items.reduce(function(sum, i) { return sum + parseFloat(i.quantity) * parseFloat(i.unit_price); }, 0);
}

// Helper: get user initials from name
function getInitials(name) {
  return (name || '').split(' ').map(function(w){ return w[0] || ''; }).join('').toUpperCase().slice(0, 3);
}

// Helper: generate PO number
async function generatePONumber(cityCode, userInitials) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    'SELECT COUNT(*) FROM purchase_orders WHERE EXTRACT(YEAR FROM created_at) = $1',
    [year]
  );
  const seq = String(parseInt(rows[0].count) + 1).padStart(4, '0');
  return cityCode + '-' + year + '-' + seq + '-' + userInitials;
}

const PO_JOIN =
  'SELECT po.*, ' +
  'u.name AS requester_name, ' +
  'a.name AS approver_name, ' +
  'ord.name AS orderer_name, ord.email AS orderer_email, ' +
  'sa.name AS shipping_address_name, sa.address AS shipping_address_text ' +
  'FROM purchase_orders po ' +
  'LEFT JOIN users u ON po.requester_id = u.id ' +
  'LEFT JOIN users a ON po.approver_id = a.id ' +
  'LEFT JOIN users ord ON po.orderer_id = ord.id ' +
  'LEFT JOIN shipping_addresses sa ON po.shipping_address_id = sa.id ';

// Export all POs with line items as JSON (for CSV download)
router.get('/export', requireAuth, async (req, res) => {
  const isApproverOrAdmin = ['approver', 'admin', 'manager'].includes(req.user.role);
  const poQuery = PO_JOIN +
    (isApproverOrAdmin ? '' : 'WHERE po.requester_id = $1 ') +
    'ORDER BY po.created_at DESC';
  const poParams = isApproverOrAdmin ? [] : [req.user.id];
  const { rows: pos } = await pool.query(poQuery, poParams);

  const { rows: items } = await pool.query(
    'SELECT li.*, po.po_number FROM po_line_items li JOIN purchase_orders po ON li.po_id = po.id' +
    (isApproverOrAdmin ? '' : ' WHERE po.requester_id = $1') +
    ' ORDER BY li.po_id, li.id',
    isApproverOrAdmin ? [] : [req.user.id]
  );

  const itemsByPO = {};
  items.forEach(function(item) {
    if (!itemsByPO[item.po_number]) itemsByPO[item.po_number] = [];
    itemsByPO[item.po_number].push(item);
  });

  res.json({ pos, itemsByPO });
});

// Get all POs
router.get('/', requireAuth, async (req, res) => {
  const isApproverOrAdmin = ['approver', 'admin', 'manager'].includes(req.user.role);
  const query = PO_JOIN +
    (isApproverOrAdmin ? '' : 'WHERE po.requester_id = $1 ') +
    'ORDER BY po.created_at DESC';
  const params = isApproverOrAdmin ? [] : [req.user.id];
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Get single PO with line items
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    PO_JOIN + 'WHERE po.id = $1',
    [req.params.id]
  );

  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });

  if (req.user.role === 'requester' && po.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows: items } = await pool.query(
    'SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY id',
    [req.params.id]
  );

  res.json(Object.assign({}, po, { line_items: items }));
});

// Create PO
router.post('/', requireAuth, async (req, res) => {
  const vendor_name = req.body.vendor_name;
  const customer_name = req.body.customer_name;
  const city_code = req.body.city_code;
  const notes = req.body.notes;
  const line_items = req.body.line_items;
  const shipping_address_id = req.body.shipping_address_id || null;
  if (!vendor_name) return res.status(400).json({ error: 'Vendor name is required' });
  if (!city_code) return res.status(400).json({ error: 'City is required' });
  if (!line_items || line_items.length === 0) return res.status(400).json({ error: 'At least one line item is required' });

  const userInitials = getInitials(req.user.name);
  const po_number = await generatePONumber(city_code.toUpperCase(), userInitials);
  const total_amount = computeTotal(line_items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, customer_name, city_code, notes, total_amount, shipping_address_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [po_number, req.user.id, vendor_name, customer_name || null, city_code.toUpperCase(), notes || null, total_amount, shipping_address_id]
    );
    const po = rows[0];
    for (let i = 0; i < line_items.length; i++) {
      const item = line_items[i];
      await client.query(
        'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6)',
        [po.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { vendor: vendor_name, total: total_amount } });
    res.status(201).json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Update PO
router.put('/:id', requireAuth, async (req, res) => {
  const vendor_name = req.body.vendor_name;
  const customer_name = req.body.customer_name;
  const city_code = req.body.city_code;
  const notes = req.body.notes;
  const line_items = req.body.line_items;
  const shipping_address_id = req.body.shipping_address_id !== undefined ? (req.body.shipping_address_id || null) : undefined;
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.requester_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (po.status !== 'draft' && req.user.role !== 'admin') {
    return res.status(400).json({ error: 'Only draft POs can be edited' });
  }

  const total_amount = line_items ? computeTotal(line_items) : po.total_amount;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      'UPDATE purchase_orders SET vendor_name=$1, customer_name=$2, city_code=$3, notes=$4, total_amount=$5, shipping_address_id=$6, updated_at=NOW() WHERE id=$7 RETURNING *',
      [vendor_name || po.vendor_name, customer_name != null ? customer_name : po.customer_name, city_code ? city_code.toUpperCase() : po.city_code, notes != null ? notes : po.notes, total_amount, shipping_address_id !== undefined ? shipping_address_id : po.shipping_address_id, req.params.id]
    );
    if (line_items) {
      await client.query('DELETE FROM po_line_items WHERE po_id = $1', [req.params.id]);
      for (let i = 0; i < line_items.length; i++) {
        const item = line_items[i];
        await client.query(
          'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1, $2, $3, $4, $5, $6)',
          [req.params.id, item.item_number || null, item.manufacturer || null, item.description, item.quantity, item.unit_price]
        );
      }
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'po', entity_id: parseInt(req.params.id), entity_number: po.po_number, action: 'edited', user_id: req.user.id, user_name: req.user.name });
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Delete PO
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (req.user.role === 'admin') {
    await pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
    return res.json({ success: true });
  }
  if (po.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'You do not have permission to delete this PO' });
  }
  if (po.status !== 'draft') {
    return res.status(400).json({ error: 'Only draft POs can be deleted. Ask an admin to delete or cancel this PO.' });
  }
  await pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
  res.json({ success: true });
});

// Submit PO for approval
router.post('/:id/submit', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.requester_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (po.status !== 'draft') return res.status(400).json({ error: 'PO is not in draft status' });

  await pool.query('UPDATE purchase_orders SET status=$1, updated_at=NOW() WHERE id=$2', ['submitted', req.params.id]);
  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'submitted', user_id: req.user.id, user_name: req.user.name });

  const { rows: approvers } = await pool.query("SELECT email, name FROM users WHERE role = 'admin' AND active = true AND receive_emails = true");
  if (approvers.length) {
    const emails = approvers.map(function(a) { return a.email; });
    const html = emailTemplate({
      badge: 'Action required',
      title: 'Purchase order submitted for approval',
      body: '<strong>' + req.user.name + '</strong> submitted a purchase order that needs your review.',
      details: [
        { label: 'PO number', value: po.po_number },
        { label: 'Vendor', value: po.vendor_name },
        { label: 'Customer/Employee', value: po.customer_name || '—' },
        { label: 'City', value: po.city_code || '—' },
        { label: 'Total', value: '$' + parseFloat(po.total_amount).toFixed(2) },
        { label: 'Requested by', value: req.user.name }
      ],
      buttonText: 'Review PO',
      buttonUrl: appUrl('?view=view&id=' + po.id)
    });
    await sendEmail(emails, 'Action Required: PO ' + po.po_number + ' needs approval', html);
  }

  res.json({ success: true });
});

// Approve PO
router.post('/:id/approve', requireAuth, requireRole('approver', 'admin'), async (req, res) => {
  const orderer_id = req.body.orderer_id;
  if (!orderer_id) return res.status(400).json({ error: 'Please select the person responsible for ordering' });

  const { rows } = await pool.query(
    'SELECT po.*, u.email AS requester_email, u.name AS requester_name, u.receive_emails AS requester_receive_emails FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1',
    [req.params.id]
  );
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'submitted') return res.status(400).json({ error: 'PO is not pending approval' });

  const { rows: ordererRows } = await pool.query('SELECT id, name, email, receive_emails FROM users WHERE id = $1', [orderer_id]);
  if (!ordererRows.length) return res.status(400).json({ error: 'Selected orderer not found' });
  const orderer = ordererRows[0];

  await pool.query(
    'UPDATE purchase_orders SET status=$1, approver_id=$2, orderer_id=$3, approved_at=NOW(), updated_at=NOW() WHERE id=$4',
    ['approved', req.user.id, orderer_id, req.params.id]
  );

  const ccEmails = [];
  const { rows: approverRows } = await pool.query('SELECT receive_emails FROM users WHERE id = $1', [req.user.id]);
  const approverReceives = approverRows.length && approverRows[0].receive_emails !== false;
  if (approverReceives && req.user.email && req.user.email !== po.requester_email) ccEmails.push(req.user.email);
  if (orderer.receive_emails !== false && orderer.email && orderer.email !== po.requester_email) ccEmails.push(orderer.email);

  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'approved', user_id: req.user.id, user_name: req.user.name, details: { orderer: orderer.name, total: po.total_amount } });

  if (po.requester_receive_emails !== false) {
    const html = emailTemplate({
      badge: 'Approved',
      badgeColor: 'green',
      title: 'Your purchase order has been approved',
      body: 'Your purchase order has been approved by <strong>' + req.user.name + '</strong>. <strong>' + orderer.name + '</strong> has been assigned to place the order.',
      details: [
        { label: 'PO number', value: po.po_number },
        { label: 'Vendor', value: po.vendor_name },
        { label: 'Customer/Employee', value: po.customer_name || '—' },
        { label: 'Total', value: '$' + parseFloat(po.total_amount).toFixed(2) },
        { label: 'Approved by', value: req.user.name },
        { label: 'Orderer', value: orderer.name }
      ],
      buttonText: 'View PO',
      buttonUrl: appUrl('?view=view&id=' + po.id)
    });
    await sendEmail(po.requester_email, 'Approved: PO ' + po.po_number, html, ccEmails);
  }

  res.json({ success: true });
});

// Reject PO
router.post('/:id/reject', requireAuth, requireRole('approver', 'admin'), async (req, res) => {
  const reason = req.body.reason;
  const { rows } = await pool.query(
    'SELECT po.*, u.email AS requester_email, u.name AS requester_name, u.receive_emails AS requester_receive_emails FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1',
    [req.params.id]
  );
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'submitted') return res.status(400).json({ error: 'PO is not pending approval' });

  await pool.query(
    'UPDATE purchase_orders SET status=$1, approver_id=$2, rejection_reason=$3, updated_at=NOW() WHERE id=$4',
    ['rejected', req.user.id, reason || null, req.params.id]
  );

  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'rejected', user_id: req.user.id, user_name: req.user.name, details: { reason } });

  if (po.requester_receive_emails !== false) {
    const html = emailTemplate({
      badge: 'Not approved',
      badgeColor: 'red',
      title: 'Your purchase order was not approved',
      body: 'Your purchase order has been rejected by <strong>' + req.user.name + '</strong>. You may edit and resubmit after making any needed changes.',
      details: [
        { label: 'PO number', value: po.po_number },
        { label: 'Vendor', value: po.vendor_name },
        { label: 'Total', value: '$' + parseFloat(po.total_amount).toFixed(2) },
        { label: 'Rejected by', value: req.user.name },
        ...(reason ? [{ label: 'Reason', value: reason }] : [])
      ],
      buttonText: 'View & Edit PO',
      buttonUrl: appUrl('?view=view&id=' + po.id)
    });
    await sendEmail(po.requester_email, 'Not Approved: PO ' + po.po_number, html);
  }

  res.json({ success: true });
});

// Cancel PO (admin only)
router.post('/:id/cancel', requireAuth, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT po.*, u.email AS requester_email, u.name AS requester_name, u.receive_emails AS requester_receive_emails FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1',
    [req.params.id]
  );
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status === 'draft') return res.status(400).json({ error: 'Use delete for draft POs' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is already cancelled' });

  await pool.query(
    'UPDATE purchase_orders SET status=$1, updated_at=NOW() WHERE id=$2',
    ['cancelled', req.params.id]
  );

  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'cancelled', user_id: req.user.id, user_name: req.user.name });

  if (po.requester_receive_emails !== false) {
    const html = emailTemplate({
      badge: 'Cancelled',
      badgeColor: 'red',
      title: 'Your purchase order was cancelled',
      body: 'Your purchase order <strong>' + po.po_number + '</strong> has been cancelled by an administrator.',
      details: [
        { label: 'PO number', value: po.po_number },
        { label: 'Vendor', value: po.vendor_name },
        { label: 'Total', value: '$' + parseFloat(po.total_amount).toFixed(2) }
      ],
      buttonText: 'View PO',
      buttonUrl: appUrl('?view=view&id=' + po.id)
    });
    await sendEmail(po.requester_email, 'Cancelled: PO ' + po.po_number, html);
  }

  res.json({ success: true });
});

// Mark PO as ordered (orderer or admin)
router.post('/:id/order', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT po.*, u.email AS requester_email, u.name AS requester_name, u.receive_emails AS requester_receive_emails FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1',
    [req.params.id]
  );
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'approved') return res.status(400).json({ error: 'Only approved POs can be marked as ordered' });
  if (req.user.role !== 'admin' && po.orderer_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the assigned orderer or an admin can mark this as ordered' });
  }

  await pool.query(
    "UPDATE purchase_orders SET status='order placed', updated_at=NOW() WHERE id=$1",
    [req.params.id]
  );

  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'order placed', user_id: req.user.id, user_name: req.user.name });

  if (po.requester_receive_emails !== false && po.requester_email) {
    const html = emailTemplate({
      badge: 'Order placed',
      badgeColor: 'purple',
      title: 'Your purchase order has been placed',
      body: '<strong>' + req.user.name + '</strong> has confirmed that PO <strong>' + po.po_number + '</strong> has been ordered from the vendor.',
      details: [
        { label: 'PO number', value: po.po_number },
        { label: 'Vendor', value: po.vendor_name },
        { label: 'Total', value: '$' + parseFloat(po.total_amount).toFixed(2) },
        { label: 'Ordered by', value: req.user.name }
      ],
      buttonText: 'View PO',
      buttonUrl: appUrl('?view=view&id=' + po.id)
    });
    await sendEmail(po.requester_email, 'Order Placed: PO ' + po.po_number, html);
  }

  res.json({ success: true });
});

module.exports = router;
