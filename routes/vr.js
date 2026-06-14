const express = require('express');
const https = require('https');
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Helper: send email via Resend
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

function getInitials(name) {
  return name.split(' ').filter(Boolean).map(function(p) { return p[0]; }).join('').toUpperCase().slice(0, 3);
}

async function generateVRNumber(userInitials) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    'SELECT COUNT(*) FROM vehicle_repairs WHERE EXTRACT(YEAR FROM created_at) = $1',
    [year]
  );
  const seq = String(parseInt(rows[0].count) + 1).padStart(4, '0');
  return 'VR-' + year + '-' + seq + '-' + userInitials;
}

// GET all VRs
router.get('/', requireAuth, async function(req, res) {
  try {
    let query, params;
    if (['admin', 'approver', 'manager'].includes(req.user.role)) {
      query = 'SELECT vr.*, u.name as requester_name, a.name as assigned_name FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id LEFT JOIN users a ON vr.assigned_user_id = a.id ORDER BY vr.created_at DESC';
      params = [];
    } else {
      query = 'SELECT vr.*, u.name as requester_name, a.name as assigned_name FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id LEFT JOIN users a ON vr.assigned_user_id = a.id WHERE vr.requester_id = $1 ORDER BY vr.created_at DESC';
      params = [req.user.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle repairs' });
  }
});

// GET single VR
router.get('/:id', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT vr.*, u.name as requester_name, u.email as requester_email, a.name as assigned_name FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id LEFT JOIN users a ON vr.assigned_user_id = a.id WHERE vr.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Vehicle repair not found' });
    const vr = rows[0];
    if (!['admin', 'approver', 'manager'].includes(req.user.role) && vr.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: items } = await pool.query('SELECT * FROM vr_line_items WHERE vr_id = $1 ORDER BY id', [req.params.id]);
    vr.line_items = items;
    res.json(vr);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vehicle repair' });
  }
});

// POST create VR
router.post('/', requireAuth, async function(req, res) {
  const { vehicle, vin_last6, assigned_user_id, shop_name, city_code, notes, line_items } = req.body;
  if (!vehicle) return res.status(400).json({ error: 'Vehicle is required' });
  const initials = getInitials(req.user.name);
  const vr_number = await generateVRNumber(initials);
  const total = (line_items || []).reduce(function(sum, item) {
    return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0));
  }, 0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO vehicle_repairs (vr_number, requester_id, assigned_user_id, vehicle, vin_last6, shop_name, city_code, notes, total_amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [vr_number, req.user.id, assigned_user_id || null, vehicle, (vin_last6 || '').toUpperCase().slice(0, 6) || null, shop_name || null, city_code || null, notes || null, total]
    );
    const vr = rows[0];
    for (const item of (line_items || [])) {
      await client.query(
        'INSERT INTO vr_line_items (vr_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4)',
        [vr.id, item.description, item.quantity || 1, item.unit_price || 0]
      );
    }
    await client.query('COMMIT');
    await logAudit({ entity_type: 'vr', entity_id: vr.id, entity_number: vr_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { vehicle, total } });
    res.status(201).json(vr);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to create vehicle repair' });
  } finally {
    client.release();
  }
});

// PUT update VR
router.put('/:id', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_repairs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Vehicle repair not found' });
    const vr = rows[0];
    if (!['admin'].includes(req.user.role) && vr.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (vr.status !== 'draft') return res.status(400).json({ error: 'Only draft vehicle repairs can be edited' });
    const { vehicle, vin_last6, assigned_user_id, shop_name, city_code, notes, line_items } = req.body;
    if (!vehicle) return res.status(400).json({ error: 'Vehicle is required' });
    const total = (line_items || []).reduce(function(sum, item) {
      return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0));
    }, 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE vehicle_repairs SET vehicle=$1, vin_last6=$2, assigned_user_id=$3, shop_name=$4, city_code=$5, notes=$6, total_amount=$7, updated_at=NOW() WHERE id=$8',
        [vehicle, (vin_last6 || '').toUpperCase().slice(0, 6) || null, assigned_user_id || null, shop_name || null, city_code || null, notes || null, total, req.params.id]
      );
      await client.query('DELETE FROM vr_line_items WHERE vr_id = $1', [req.params.id]);
      for (const item of (line_items || [])) {
        await client.query(
          'INSERT INTO vr_line_items (vr_id, description, quantity, unit_price) VALUES ($1,$2,$3,$4)',
          [req.params.id, item.description, item.quantity || 1, item.unit_price || 0]
        );
      }
      await client.query('COMMIT');
      await logAudit({ entity_type: 'vr', entity_id: parseInt(req.params.id), entity_number: vr.vr_number, action: 'edited', user_id: req.user.id, user_name: req.user.name });
      res.json({ success: true, id: parseInt(req.params.id) });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vehicle repair' });
  }
});

// POST submit VR
router.post('/:id/submit', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_repairs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const vr = rows[0];
    if (vr.requester_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Access denied' });
    if (vr.status !== 'draft') return res.status(400).json({ error: 'Already submitted' });
    await pool.query("UPDATE vehicle_repairs SET status='submitted', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await logAudit({ entity_type: 'vr', entity_id: vr.id, entity_number: vr.vr_number, action: 'submitted', user_id: req.user.id, user_name: req.user.name });

    // Email approvers and admins
    const { rows: approvers } = await pool.query(
      "SELECT email, name FROM users WHERE role IN ('approver','admin') AND active = true AND receive_emails = true"
    );
    if (approvers.length) {
      const emails = approvers.map(function(a) { return a.email; });
      await sendEmail(emails, 'Vehicle Repair Submitted: ' + vr.vr_number,
        '<p><strong>' + req.user.name + '</strong> submitted vehicle repair <strong>' + vr.vr_number + '</strong> for approval.</p>' +
        '<p><strong>Vehicle:</strong> ' + (vr.vehicle || '') + (vr.vin_last6 ? ' (VIN: ••••••' + vr.vin_last6 + ')' : '') + '</p>' +
        '<p><strong>Shop:</strong> ' + (vr.shop_name || '—') + '</p>' +
        '<p><strong>Total:</strong> $' + parseFloat(vr.total_amount).toFixed(2) + '</p>' +
        '<p>Please log in to review and approve.</p>'
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// POST approve VR
router.post('/:id/approve', requireAuth, requireRole('admin', 'approver', 'manager'), async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT vr.*, u.email as requester_email, u.name as requester_name FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id WHERE vr.id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const vr = rows[0];
    if (vr.status !== 'submitted') return res.status(400).json({ error: 'Can only approve submitted repairs' });
    await pool.query("UPDATE vehicle_repairs SET status='approved', approver_id=$1, approved_at=NOW(), updated_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
    await logAudit({ entity_type: 'vr', entity_id: vr.id, entity_number: vr.vr_number, action: 'approved', user_id: req.user.id, user_name: req.user.name });
    if (vr.requester_email) {
      await sendEmail(vr.requester_email, 'Vehicle Repair Approved: ' + vr.vr_number,
        '<p>Your vehicle repair <strong>' + vr.vr_number + '</strong> has been <strong style="color:green">approved</strong> by ' + req.user.name + '.</p>' +
        '<p><strong>Vehicle:</strong> ' + (vr.vehicle || '') + '</p>' +
        '<p><strong>Total:</strong> $' + parseFloat(vr.total_amount).toFixed(2) + '</p>'
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// POST reject VR
router.post('/:id/reject', requireAuth, requireRole('admin', 'approver', 'manager'), async function(req, res) {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query('SELECT vr.*, u.email as requester_email FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id WHERE vr.id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const vr = rows[0];
    if (vr.status !== 'submitted') return res.status(400).json({ error: 'Can only reject submitted repairs' });
    await pool.query("UPDATE vehicle_repairs SET status='rejected', rejection_reason=$1, updated_at=NOW() WHERE id=$2", [reason || null, req.params.id]);
    await logAudit({ entity_type: 'vr', entity_id: vr.id, entity_number: vr.vr_number, action: 'rejected', user_id: req.user.id, user_name: req.user.name, details: { reason } });
    if (vr.requester_email) {
      await sendEmail(vr.requester_email, 'Vehicle Repair Rejected: ' + vr.vr_number,
        '<p>Your vehicle repair <strong>' + vr.vr_number + '</strong> was <strong style="color:red">rejected</strong> by ' + req.user.name + '.</p>' +
        (reason ? '<p><strong>Reason:</strong> ' + reason + '</p>' : '')
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

// DELETE VR
router.delete('/:id', requireAuth, async function(req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM vehicle_repairs WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const vr = rows[0];
    if (req.user.role !== 'admin' && vr.requester_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (vr.status !== 'draft') return res.status(400).json({ error: 'Only draft repairs can be deleted' });
    await pool.query('DELETE FROM vehicle_repairs WHERE id = $1', [req.params.id]);
    await logAudit({ entity_type: 'vr', entity_id: vr.id, entity_number: vr.vr_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// POST /api/vr/ai-extract — parse shop estimate image/PDF and return structured data
router.post('/ai-extract', requireAuth, async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI not configured' });
  const { imageData, mediaType } = req.body;
  if (!imageData) return res.status(400).json({ error: 'No image data provided' });

  const prompt = 'You are extracting data from a vehicle repair/maintenance shop estimate or quote. ' +
    'Extract ALL of the following fields if present and return ONLY valid JSON (no explanation, no markdown):\n' +
    '{\n' +
    '  "shop_name": "name of the shop or garage",\n' +
    '  "vehicle": "year make model as a single string",\n' +
    '  "vin_last6": "last 6 characters of VIN if present, otherwise null",\n' +
    '  "notes": "any recommendations, comments, or technician notes",\n' +
    '  "line_items": [\n' +
    '    { "description": "part or labor description", "quantity": 1, "unit_price": 0.00 }\n' +
    '  ]\n' +
    '}\n' +
    'If a field is not found, use null. For line_items, include every part and labor charge. unit_price should be the per-unit cost as a number.';

  const body = JSON.stringify({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageData } },
        { type: 'text', text: prompt }
      ]
    }]
  });

  try {
    const result = await new Promise(function(resolve, reject) {
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
    const text = result.content[0].text.trim();
    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const extracted = JSON.parse(jsonStr);
    res.json(extracted);
  } catch (err) {
    console.error('VR AI extract error:', err);
    res.status(500).json({ error: 'Failed to extract data from image' });
  }
});

module.exports = router;
