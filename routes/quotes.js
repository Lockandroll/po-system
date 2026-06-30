const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const notify = require('../utils/notify');
const push = require('../utils/push');

const router = express.Router();

function getInitials(name) {
  return name.split(' ').filter(Boolean).map(function(p) { return p[0]; }).join('').toUpperCase().slice(0, 3);
}

async function generateQuoteNumber(userInitials) {
  const year = new Date().getFullYear();
  const prefix = 'QT-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(quote_number, '-', 3) AS INTEGER)) as maxseq FROM quotes WHERE quote_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'QT-' + year + '-' + seq + '-' + userInitials;
}

// GET all quotes (own only, unless admin)
router.get('/', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    let query, params;
    if (['admin','manager'].includes(req.user.role)) {
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
router.get('/:id', requireAuth, requirePermission('view_quotes'), async (req, res) => {
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
router.post('/', requireAuth, requirePermission('create_quote'), async (req, res) => {
  const { customer_name, city_code, notes, important_info, tax_rate, line_items } = req.body;
  if (!customer_name) return res.status(400).json({ error: 'Customer name is required' });
  const initials = getInitials(req.user.name);
  const taxRateVal = parseFloat(tax_rate) || 0;
  const subtotal = (line_items || []).reduce(function(sum, item) {
    return sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0));
  }, 0);
  const taxableSubtotal = (line_items || []).reduce(function(sum, item) {
    return item.taxable ? sum + ((parseFloat(item.quantity) || 0) * (parseFloat(item.list_price) || 0)) : sum;
  }, 0);
  const tax_amount = taxableSubtotal * taxRateVal / 100;
  const total = subtotal + tax_amount;

  for (var attempt = 0; attempt < 10; attempt++) {
    const quote_number = await generateQuoteNumber(initials);
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
      client.release();
      try { await logAudit({ entity_type: 'quote', entity_id: quote.id, entity_number: quote_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { customer: customer_name, total } }); } catch(e) {}
      try {
        const _q = await notify.broadcastRecipients('quote_created', "role IN ('admin', 'owner')");
        await push.sendPushToUsers(_q.userIds, { title: 'New quote', body: req.user.name + ' created a new quote.', url: '/' });
        const emailAdmins = _q.emails;
        const smsAdmins = _q.phones;
        if (emailAdmins.length) {
          const emails = emailAdmins;
          const html = emailTemplate({
            badge: 'New quote', title: 'A new quote has been created',
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
        if (smsAdmins.length) {
          const phones = smsAdmins;
          await sendSms(phones, 'Lock & Roll: ' + req.user.name + ' created quote ' + quote_number + ' for ' + customer_name + '. Total: $' + total.toFixed(2) + '. ' + ((process.env.APP_URL || '').replace(/\/$/, '') + '/?view=view-quote&id=' + quote.id));
        }
      } catch(e) { console.error('Quote email/SMS failed:', e); }
      return res.status(201).json(quote);
    } catch (err) {
      await client.query('ROLLBACK').catch(function(){});
      client.release();
      // Retry on duplicate quote number
      if (err.code === '23505' && err.constraint === 'quotes_quote_number_key' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create quote: ' + err.message });
    }
  }
});

// PUT update quote
router.put('/:id', requireAuth, requirePermission('edit_quote'), async (req, res) => {
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
router.delete('/:id', requireAuth, requirePermission('delete_quote'), async (req, res) => {
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

// POST push a quote into PO(s) - one PO per supplier (manufacturer); uses our cost (unit_price)
router.post('/:id/push-to-po', requireAuth, requirePermission('push_quote_po'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM quotes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quote not found' });
    const quote = rows[0];
    if (req.user.role !== 'admin' && quote.requester_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!quote.city_code) return res.status(400).json({ error: 'Set a city on the quote before pushing it to a PO.' });
    const { rows: items } = await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [req.params.id]);
    if (!items.length) return res.status(400).json({ error: 'This quote has no line items.' });

    const groups = {};
    const order = [];
    items.forEach(function (it) {
      const key = (it.manufacturer || '').trim() || 'Unspecified Supplier';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(it);
    });

    const initials = getInitials(req.user.name);
    const city = String(quote.city_code).toUpperCase();
    const year = new Date().getFullYear();
    let created = [];

    for (var attempt = 0; attempt < 10; attempt++) {
    created = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const mx = await client.query("SELECT MAX(CAST(SPLIT_PART(po_number, '-', 3) AS INTEGER)) as maxseq FROM purchase_orders WHERE EXTRACT(YEAR FROM created_at) = $1", [year]);
      let seq = (mx.rows[0].maxseq || 0);
      for (let g = 0; g < order.length; g++) {
        const vendor = order[g];
        const grp = groups[vendor];
        seq++;
        const po_number = city + '-' + year + '-' + String(seq).padStart(4, '0') + '-' + initials;
        const total = grp.reduce(function (s, i) { return s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0); }, 0);
        const poRows = await client.query(
          'INSERT INTO purchase_orders (po_number, requester_id, vendor_name, customer_name, city_code, notes, total_amount, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [po_number, req.user.id, vendor, quote.customer_name || null, city, 'From quote ' + quote.quote_number, total, 'submitted']
        );
        const po = poRows.rows[0];
        for (let i = 0; i < grp.length; i++) {
          const it = grp[i];
          await client.query(
            'INSERT INTO po_line_items (po_id, item_number, manufacturer, description, quantity, unit_price) VALUES ($1,$2,$3,$4,$5,$6)',
            [po.id, it.item_number || null, it.manufacturer || null, it.description, it.quantity, it.unit_price || 0]
          );
        }
        created.push({ id: po.id, po_number: po_number, vendor_name: vendor, total: total });
      }
      await client.query('COMMIT');
      client.release();
      break;
    } catch (err) {
      await client.query('ROLLBACK').catch(function(){});
      client.release();
      if (err.code === '23505' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create PO(s): ' + err.message });
    }
    }
    for (let c = 0; c < created.length; c++) {
      try { await logAudit({ entity_type: 'po', entity_id: created[c].id, entity_number: created[c].po_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { vendor: created[c].vendor_name, total: created[c].total, from_quote: quote.quote_number } }); } catch (e) {}
      try { await logAudit({ entity_type: 'po', entity_id: created[c].id, entity_number: created[c].po_number, action: 'submitted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    }
    try {
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      const _q2 = await notify.broadcastRecipients('quote_to_pos', "role IN ('admin', 'owner')");
      await push.sendPushToUsers(_q2.userIds, { title: 'Quote pushed to POs', body: req.user.name + ' pushed a quote to purchase orders.', url: '/' });
      const emailAdmins = _q2.emails;
      const smsAdmins = _q2.phones;
      const listText = created.map(function (c) { return c.po_number + ' (' + c.vendor_name + ', $' + parseFloat(c.total).toFixed(2) + ')'; }).join(', ');
      if (emailAdmins.length) {
        const html = emailTemplate({
          badge: 'Action required',
          title: created.length === 1 ? 'Purchase order submitted for approval' : (created.length + ' purchase orders submitted for approval'),
          body: '<strong>' + req.user.name + '</strong> pushed quote ' + quote.quote_number + ' to ' + created.length + ' purchase order' + (created.length === 1 ? '' : 's') + ' that need your review.',
          details: created.map(function (c) { return { label: c.po_number, value: c.vendor_name + ' — $' + parseFloat(c.total).toFixed(2) }; }).concat([{ label: 'From quote', value: quote.quote_number }, { label: 'Customer/Employee', value: quote.customer_name || '—' }, { label: 'City', value: city }]),
          buttonText: 'Review POs',
          buttonUrl: base + '/?view=dashboard'
        });
        await sendEmail(emailAdmins, 'Action Required: ' + created.length + ' PO' + (created.length === 1 ? '' : 's') + ' from quote ' + quote.quote_number, html);
      }
      if (smsAdmins.length) {
        await sendSms(smsAdmins, 'Lock & Roll: ' + req.user.name + ' submitted ' + created.length + ' PO' + (created.length === 1 ? '' : 's') + ' from quote ' + quote.quote_number + ': ' + listText + '. ' + base + '/?view=dashboard');
      }
    } catch (e) { console.error('Push-to-PO notify failed:', e); }
    res.status(201).json({ ok: true, count: created.length, pos: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to push to PO' });
  }
});

// ===== Quote photos =====
// Reference images attached to a quote. Bytes live in Cloudflare R2; only
// metadata + the R2 key are stored here. Same access rule as the quote itself:
// admins/managers see all, everyone else only their own quotes.
function canAccessQuote(user, quote) {
  return user.role === 'admin' || user.role === 'manager' || quote.requester_id === user.id;
}

function sanitizePhotoName(name) {
  return String(name || 'photo').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'photo';
}

// List the ready photos for a quote, each with a short-lived inline preview URL.
router.get('/:id/photos', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    const qr = await pool.query('SELECT id, requester_id FROM quotes WHERE id = $1', [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quote not found' });
    if (!canAccessQuote(req.user, qr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await pool.query(
      "SELECT id, name, mime_type, size_bytes, uploaded_by_name, created_at, r2_key FROM quote_photos WHERE quote_id = $1 AND status = 'ready' ORDER BY id",
      [req.params.id]
    );
    const out = [];
    for (const p of rows) {
      let url = null;
      if (r2.configured()) {
        try { url = await r2.presignDownload(p.r2_key, p.name, true); } catch (e) {}
      }
      out.push({ id: p.id, name: p.name, mime_type: p.mime_type, size_bytes: p.size_bytes, uploaded_by_name: p.uploaded_by_name, created_at: p.created_at, url: url });
    }
    res.json(out);
  } catch (err) {
    console.error('List quote photos error:', err);
    res.status(500).json({ error: 'Failed to fetch photos' });
  }
});

// Step 1: reserve a record + presigned PUT URL. Browser uploads bytes to R2.
router.post('/:id/photos/upload-url', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const qr = await pool.query('SELECT id, requester_id FROM quotes WHERE id = $1', [req.params.id]);
    if (!qr.rows.length) return res.status(404).json({ error: 'Quote not found' });
    if (!canAccessQuote(req.user, qr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const name = (req.body.name || '').trim();
    const mime = (req.body.mime_type || 'application/octet-stream').slice(0, 255);
    if (!name) return res.status(400).json({ error: 'File name is required' });
    const key = 'quote-photos/' + req.params.id + '/' + crypto.randomUUID() + '/' + sanitizePhotoName(name);
    const { rows } = await pool.query(
      "INSERT INTO quote_photos (quote_id, name, r2_key, mime_type, uploaded_by, uploaded_by_name, status) VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id",
      [req.params.id, name.slice(0, 255), key, mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Quote photo upload-url error:', err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Step 2: confirm the upload completed; record the size and mark it ready.
router.post('/photos/:photoId/confirm', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    const pr = await pool.query(
      'SELECT p.id, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1',
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    await pool.query("UPDATE quote_photos SET size_bytes = $1, status = 'ready' WHERE id = $2", [size, req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Quote photo confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// Download / preview a single photo via a short-lived presigned GET URL.
router.get('/photos/:photoId/download', requireAuth, requirePermission('view_quotes'), async (req, res) => {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Photo storage is not configured yet.' });
    const pr = await pool.query(
      "SELECT p.id, p.name, p.r2_key, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1 AND p.status = 'ready'",
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    const url = await r2.presignDownload(pr.rows[0].r2_key, pr.rows[0].name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Quote photo download error:', err);
    res.status(500).json({ error: 'Failed to generate download link' });
  }
});

// Delete a photo: remove the R2 object and the metadata row.
router.delete('/photos/:photoId', requireAuth, requirePermission('edit_quote'), async (req, res) => {
  try {
    const pr = await pool.query(
      'SELECT p.id, p.r2_key, p.quote_id, q.requester_id FROM quote_photos p JOIN quotes q ON p.quote_id = q.id WHERE p.id = $1',
      [req.params.photoId]
    );
    if (!pr.rows.length) return res.status(404).json({ error: 'Photo not found' });
    if (!canAccessQuote(req.user, pr.rows[0])) return res.status(403).json({ error: 'Access denied' });
    try { if (r2.configured()) await r2.deleteObject(pr.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e); }
    await pool.query('DELETE FROM quote_photos WHERE id = $1', [req.params.photoId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Quote photo delete error:', err);
    res.status(500).json({ error: 'Failed to delete photo' });
  }
});

module.exports = router;
