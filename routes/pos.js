const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Helper: send email via Resend (supports optional cc array)
async function sendEmail(to, subject, html, cc) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const body = {
      from: process.env.FROM_EMAIL || 'Lock and Roll <onboarding@resend.dev>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    };
    if (cc && cc.length > 0) body.cc = Array.isArray(cc) ? cc : [cc];
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// Helper: build PO HTML for email body
function buildPOEmailHtml(po, items, approverName, ordererName) {
  const rows = items.map(function(item) {
    const lineTotal = (parseFloat(item.quantity) * parseFloat(item.unit_price)).toFixed(2);
    return '<tr>' +
      '<td style="padding:8px;border:1px solid #ddd">' + (item.item_number || '') + '</td>' +
      '<td style="padding:8px;border:1px solid #ddd">' + (item.manufacturer || '') + '</td>' +
      '<td style="padding:8px;border:1px solid #ddd">' + item.description + '</td>' +
      '<td style="padding:8px;border:1px solid #ddd;text-align:center">' + item.quantity + '</td>' +
      '<td style="padding:8px;border:1px solid #ddd;text-align:right">$' + parseFloat(item.unit_price).toFixed(2) + '</td>' +
      '<td style="padding:8px;border:1px solid #ddd;text-align:right">$' + lineTotal + '</td>' +
      '</tr>';
  }).join('');

  return '<div style="font-family:sans-serif;max-width:700px;margin:0 auto">' +
    '<div style="background:#111;padding:20px 24px;border-bottom:3px solid #f97316">' +
      '<h1 style="color:#f97316;margin:0;font-size:22px">Lock and Roll</h1>' +
      '<p style="color:#aaa;margin:4px 0 0">Purchase Order — Approved</p>' +
    '</div>' +
    '<div style="padding:20px 24px;background:#fff">' +
      '<table style="width:100%;margin-bottom:20px;font-size:14px">' +
        '<tr>' +
          '<td style="padding:4px 0;color:#555;width:160px">PO Number:</td>' +
          '<td style="padding:4px 0;font-weight:bold">' + po.po_number + '</td>' +
          '<td style="padding:4px 0;color:#555;width:160px">Vendor / Supplier:</td>' +
          '<td style="padding:4px 0">' + po.vendor_name + '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:4px 0;color:#555">Customer:</td>' +
          '<td style="padding:4px 0">' + (po.customer_name || '—') + '</td>' +
          '<td style="padding:4px 0;color:#555">City:</td>' +
          '<td style="padding:4px 0">' + (po.city_code || '—') + '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:4px 0;color:#555">Requested By:</td>' +
          '<td style="padding:4px 0">' + (po.requester_name || '—') + '</td>' +
          '<td style="padding:4px 0;color:#555">Approved By:</td>' +
          '<td style="padding:4px 0">' + (approverName || '—') + '</td>' +
        '</tr>' +
        '<tr>' +
          '<td style="padding:4px 0;color:#555">Orderer:</td>' +
          '<td style="padding:4px 0">' + (ordererName || '—') + '</td>' +
          '<td></td><td></td>' +
        '</tr>' +
        (po.notes ? '<tr><td style="padding:4px 0;color:#555">Notes:</td><td colspan="3" style="padding:4px 0">' + po.notes + '</td></tr>' : '') +
      '</table>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">' +
        '<thead>' +
          '<tr style="background:#f3f4f6">' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:left">Item #</th>' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:left">Manufacturer</th>' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:left">Description</th>' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:center">Qty</th>' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:right">Unit Price</th>' +
            '<th style="padding:8px;border:1px solid #ddd;text-align:right">Total</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rows + '</tbody>' +
        '<tfoot>' +
          '<tr>' +
            '<td colspan="5" style="padding:8px;border:1px solid #ddd;text-align:right;font-weight:bold">Grand Total</td>' +
            '<td style="padding:8px;border:1px solid #ddd;text-align:right;font-weight:bold">$' + parseFloat(po.total_amount).toFixed(2) + '</td>' +
          '</tr>' +
        '</tfoot>' +
      '</table>' +
    '</div>' +
  '</div>';
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

  const appUrl = process.env.APP_URL || '';
  const poUrl = appUrl ? appUrl + '/#view/' + po.id : null;

  const { rows: approvers } = await pool.query("SELECT email, name FROM users WHERE role IN ('approver', 'admin') AND active = true AND receive_emails = true");
  for (let i = 0; i < approvers.length; i++) {
    const approver = approvers[i];
    await sendEmail(
      approver.email,
      '[Lock and Roll] New PO Needs Approval: ' + po.po_number,
      '<p>Hi ' + approver.name + ',</p>' +
      '<p><strong>' + req.user.name + '</strong> has submitted purchase order <strong>' + po.po_number + '</strong> for approval.</p>' +
      '<p><strong>Vendor:</strong> ' + po.vendor_name + '<br/>' +
      '<strong>Total:</strong> $' + parseFloat(po.total_amount).toFixed(2) + '</p>' +
      (poUrl ? '<p><a href="' + poUrl + '" style="background:#f97316;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block">Review PO</a></p>' +
               '<p style="color:#888;font-size:12px">Or copy this link: ' + poUrl + '</p>' : '<p>Please log in to review and approve or reject it.</p>')
    );
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

  const { rows: items } = await pool.query('SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY id', [req.params.id]);

  const emailHtml = buildPOEmailHtml(po, items, req.user.name, orderer.name);

  const ccEmails = [];
  const { rows: approverRows } = await pool.query('SELECT receive_emails FROM users WHERE id = $1', [req.user.id]);
  const approverReceives = approverRows.length && approverRows[0].receive_emails !== false;
  if (approverReceives && req.user.email && req.user.email !== po.requester_email) ccEmails.push(req.user.email);
  if (orderer.receive_emails !== false && orderer.email && orderer.email !== po.requester_email) ccEmails.push(orderer.email);

  await logAudit({ entity_type: 'po', entity_id: po.id, entity_number: po.po_number, action: 'approved', user_id: req.user.id, user_name: req.user.name, details: { orderer: orderer.name, total: po.total_amount } });

  if (po.requester_receive_emails !== false) await sendEmail(
    po.requester_email,
    '[Lock and Roll] PO Approved: ' + po.po_number,
    '<p>Hi ' + po.requester_name + ',</p>' +
    '<p>Your purchase order <strong>' + po.po_number + '</strong> has been <strong style="color:green">approved</strong> by ' + req.user.name + '.</p>' +
    '<p><strong>' + orderer.name + '</strong> has been assigned to place the order.</p>' +
    emailHtml,
    ccEmails
  );

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

  if (po.requester_receive_emails !== false) await sendEmail(
    po.requester_email,
    '[Lock and Roll] PO Rejected: ' + po.po_number,
    '<p>Hi ' + po.requester_name + ',</p>' +
    '<p>Your purchase order <strong>' + po.po_number + '</strong> has been <strong style="color:red">rejected</strong> by ' + req.user.name + '.</p>' +
    (reason ? '<p><strong>Reason:</strong> ' + reason + '</p>' : '') +
    '<p>You may edit and resubmit the PO after making any needed changes.</p>'
  );

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

  if (po.requester_receive_emails !== false) await sendEmail(
    po.requester_email,
    '[Lock and Roll] PO Cancelled: ' + po.po_number,
    '<p>Hi ' + po.requester_name + ',</p>' +
    '<p>Your purchase order <strong>' + po.po_number + '</strong> has been <strong>cancelled</strong> by an administrator.</p>' +
    '<p><strong>Vendor:</strong> ' + po.vendor_name + '<br/>' +
    '<strong>Total:</strong> $' + parseFloat(po.total_amount).toFixed(2) + '</p>'
  );

  res.json({ success: true });
});

module.exports = router;
