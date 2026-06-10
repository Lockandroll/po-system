const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Helper: send email via Resend
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL || 'PO System <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    });
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// Helper: compute total from line items
function computeTotal(items) {
  return items.reduce((sum, i) => sum + parseFloat(i.quantity) * parseFloat(i.unit_price), 0);
}

// Helper: generate PO number
async function generatePONumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT COUNT(*) FROM purchase_orders WHERE po_number LIKE $1",
    [`PO-${year}-%`]
  );
  const seq = String(parseInt(rows[0].count) + 1).padStart(4, '0');
  return `PO-${year}-${seq}`;
}

// Get all POs (requesters see own; approvers/admins see all)
router.get('/', requireAuth, async (req, res) => {
  let query, params;
  const isApproverOrAdmin = ['approver', 'admin'].includes(req.user.role);
  if (isApproverOrAdmin) {
    query = `
      SELECT po.*, u.name AS requester_name, a.name AS approver_name
      FROM purchase_orders po
      LEFT JOIN users u ON po.requester_id = u.id
      LEFT JOIN users a ON po.approver_id = a.id
      ORDER BY po.created_at DESC
    `;
    params = [];
  } else {
    query = `
      SELECT po.*, u.name AS requester_name, a.name AS approver_name
      FROM purchase_orders po
      LEFT JOIN users u ON po.requester_id = u.id
      LEFT JOIN users a ON po.approver_id = a.id
      WHERE po.requester_id = $1
      ORDER BY po.created_at DESC
    `;
    params = [req.user.id];
  }
  const { rows } = await pool.query(query, params);
  res.json(rows);
});

// Get single PO with line items
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT po.*, u.name AS requester_name, a.name AS approver_name
    FROM purchase_orders po
    LEFT JOIN users u ON po.requester_id = u.id
    LEFT JOIN users a ON po.approver_id = a.id
    WHERE po.id = $1
  `, [req.params.id]);

  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });

  // Only requester (or approver/admin) can see it
  if (req.user.role === 'requester' && po.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { rows: items } = await pool.query(
    'SELECT * FROM po_line_items WHERE po_id = $1 ORDER BY id',
    [req.params.id]
  );

  res.json({ ...po, line_items: items });
});

// Create PO
router.post('/', requireAuth, async (req, res) => {
  const { vendor_name, notes, line_items } = req.body;
  if (!vendor_name) return res.status(400).json({ error: 'Vendor name is required' });
  if (!line_items || line_items.length === 0) return res.status(400).json({ error: 'At least one line item is required' });

  const po_number = await generatePONumber();
  const total_amount = computeTotal(line_items);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, notes, total_amount) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [po_number, req.user.id, vendor_name, notes || null, total_amount]
    );
    const po = rows[0];
    for (const item of line_items) {
      await client.query(
        'INSERT INTO po_line_items (po_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
        [po.id, item.description, item.quantity, item.unit_price]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(po);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Update draft PO
router.put('/:id', requireAuth, async (req, res) => {
  const { vendor_name, notes, line_items } = req.body;
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
      'UPDATE purchase_orders SET vendor_name=$1, notes=$2, total_amount=$3, updated_at=NOW() WHERE id=$4 RETURNING *',
      [vendor_name || po.vendor_name, notes ?? po.notes, total_amount, req.params.id]
    );
    if (line_items) {
      await client.query('DELETE FROM po_line_items WHERE po_id = $1', [req.params.id]);
      for (const item of line_items) {
        await client.query(
          'INSERT INTO po_line_items (po_id, description, quantity, unit_price) VALUES ($1, $2, $3, $4)',
          [req.params.id, item.description, item.quantity, item.unit_price]
        );
      }
    }
    await client.query('COMMIT');
    res.json(updated[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// Delete draft PO
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM purchase_orders WHERE id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.requester_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (po.status !== 'draft') return res.status(400).json({ error: 'Only draft POs can be deleted' });
  await pool.query('DELETE FROM purchase_orders WHERE id = $1', [req.params.id]);
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

  // Notify all approvers
  const { rows: approvers } = await pool.query("SELECT email, name FROM users WHERE role IN ('approver', 'admin')");
  for (const approver of approvers) {
    await sendEmail(
      approver.email,
      `[PO System] New PO Needs Approval: ${po.po_number}`,
      `<p>Hi ${approver.name},</p>
       <p><strong>${req.user.name}</strong> has submitted purchase order <strong>${po.po_number}</strong> for approval.</p>
       <p><strong>Vendor:</strong> ${po.vendor_name}<br/>
       <strong>Total:</strong> $${parseFloat(po.total_amount).toFixed(2)}</p>
       <p>Please log in to review and approve or reject it.</p>`
    );
  }

  res.json({ success: true });
});

// Approve PO
router.post('/:id/approve', requireAuth, requireRole('approver', 'admin'), async (req, res) => {
  const { rows } = await pool.query('SELECT po.*, u.email AS requester_email, u.name AS requester_name FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'submitted') return res.status(400).json({ error: 'PO is not pending approval' });

  await pool.query(
    'UPDATE purchase_orders SET status=$1, approver_id=$2, approved_at=NOW(), updated_at=NOW() WHERE id=$3',
    ['approved', req.user.id, req.params.id]
  );

  await sendEmail(
    po.requester_email,
    `[PO System] PO Approved: ${po.po_number}`,
    `<p>Hi ${po.requester_name},</p>
     <p>Your purchase order <strong>${po.po_number}</strong> has been <strong style="color:green">approved</strong> by ${req.user.name}.</p>
     <p><strong>Vendor:</strong> ${po.vendor_name}<br/>
     <strong>Total:</strong> $${parseFloat(po.total_amount).toFixed(2)}</p>`
  );

  res.json({ success: true });
});

// Reject PO
router.post('/:id/reject', requireAuth, requireRole('approver', 'admin'), async (req, res) => {
  const { reason } = req.body;
  const { rows } = await pool.query('SELECT po.*, u.email AS requester_email, u.name AS requester_name FROM purchase_orders po JOIN users u ON po.requester_id = u.id WHERE po.id = $1', [req.params.id]);
  const po = rows[0];
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'submitted') return res.status(400).json({ error: 'PO is not pending approval' });

  await pool.query(
    'UPDATE purchase_orders SET status=$1, approver_id=$2, rejection_reason=$3, updated_at=NOW() WHERE id=$4',
    ['rejected', req.user.id, reason || null, req.params.id]
  );

  await sendEmail(
    po.requester_email,
    `[PO System] PO Rejected: ${po.po_number}`,
    `<p>Hi ${po.requester_name},</p>
     <p>Your purchase order <strong>${po.po_number}</strong> has been <strong style="color:red">rejected</strong> by ${req.user.name}.</p>
     ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
     <p>You may edit and resubmit the PO after making any needed changes.</p>`
  );

  res.json({ success: true });
});

module.exports = router;
