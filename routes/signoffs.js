const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { emailTemplate } = require('../utils/email');
const notify = require('../utils/notify');

const router = express.Router();

function getInitials(name) {
  return String(name || '').split(' ').filter(Boolean).map(function (p) { return p[0]; }).join('').toUpperCase().slice(0, 3);
}

async function generateFormNumber(initials) {
  const year = new Date().getFullYear();
  const prefix = 'SO-' + year + '-%';
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(form_number, '-', 3) AS INTEGER)) as maxseq FROM signoff_forms WHERE form_number LIKE $1",
    [prefix]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return 'SO-' + year + '-' + seq + '-' + (initials || 'XX');
}

function stripDataUrl(s) {
  if (!s) return '';
  return String(s).replace(/^data:[^;]+;base64,/, '');
}

async function sendWithAttachments(recipients, subject, html, attachments) {
  if (!process.env.RESEND_API_KEY) { console.warn('RESEND_API_KEY not set — skipping signoff email'); return; }
  try {
    const payload = {
      from: process.env.FROM_EMAIL || 'Lock and Roll <onboarding@resend.dev>',
      to: Array.isArray(recipients) ? recipients : [recipients],
      subject: subject,
      html: html
    };
    if (attachments && attachments.length) payload.attachments = attachments;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) { const t = await resp.text(); console.error('Resend error ' + resp.status + ':', t); }
  } catch (err) {
    console.error('Signoff email failed:', err.message);
  }
}

// GET all sign-off sheets (everyone sees the shared queue). No heavy image data.
router.get('/', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT f.id, f.form_number, f.status, f.wo_number, f.po_number, f.account, f.store_name, f.store_number, ' +
      '       f.address, f.city_state_zip, f.service_requested_by, f.work_complete, f.completed_at, f.created_at, ' +
      '       c.name AS created_by_name, d.name AS completed_by_name, ' +
      '       (SELECT COUNT(*) FROM signoff_photos p WHERE p.form_id = f.id) AS photo_count ' +
      'FROM signoff_forms f ' +
      'LEFT JOIN users c ON f.created_by = c.id ' +
      'LEFT JOIN users d ON f.completed_by = d.id ' +
      'ORDER BY (f.status = \'pending\') DESC, f.created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sign-off sheets' });
  }
});

// GET single sheet with photos
router.get('/:id', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT f.*, c.name AS created_by_name, d.name AS completed_by_name ' +
      'FROM signoff_forms f LEFT JOIN users c ON f.created_by = c.id LEFT JOIN users d ON f.completed_by = d.id WHERE f.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    const form = rows[0];
    const { rows: photos } = await pool.query('SELECT id, image_data, caption FROM signoff_photos WHERE form_id = $1 ORDER BY id', [req.params.id]);
    form.photos = photos;
    res.json(form);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sign-off sheet' });
  }
});

// POST create (setup) — lands in the pending queue
router.post('/', requireAuth, requirePermission('create_signoff'), async (req, res) => {
  const b = req.body || {};
  const initials = getInitials(req.user.name);
  for (var attempt = 0; attempt < 10; attempt++) {
    const form_number = await generateFormNumber(initials);
    try {
      const { rows } = await pool.query(
        'INSERT INTO signoff_forms (form_number, status, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [form_number, 'pending', b.po_number || null, b.account || null, b.store_name || null, b.store_number || null, b.address || null, b.city_state_zip || null, b.service_requested_by || null, b.notes || null, req.user.id]
      );
      const form = rows[0];
      try { await logAudit({ entity_type: 'signoff', entity_id: form.id, entity_number: form_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { store: b.store_name || null, po: b.po_number || null } }); } catch (e) {}
      return res.status(201).json(form);
    } catch (err) {
      if (err.code === '23505' && attempt < 9) continue;
      console.error(err);
      return res.status(500).json({ error: 'Failed to create sign-off sheet: ' + err.message });
    }
  }
});

// PUT update setup fields (only while pending)
router.put('/:id', requireAuth, requirePermission('edit_signoff'), async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    if (rows[0].status === 'completed') return res.status(400).json({ error: 'This sheet is already completed and cannot be edited.' });
    const { rows: upd } = await pool.query(
      'UPDATE signoff_forms SET po_number=$1, account=$2, store_name=$3, store_number=$4, address=$5, city_state_zip=$6, service_requested_by=$7, notes=$8, updated_at=NOW() WHERE id=$9 RETURNING *',
      [b.po_number || null, b.account || null, b.store_name || null, b.store_number || null, b.address || null, b.city_state_zip || null, b.service_requested_by || null, b.notes || null, req.params.id]
    );
    try { await logAudit({ entity_type: 'signoff', entity_id: parseInt(req.params.id), entity_number: rows[0].form_number, action: 'edited', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json(upd[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update sign-off sheet' });
  }
});

// POST complete — tech fills onsite, signs, attaches photos. Emails admins.
router.post('/:id/complete', requireAuth, requirePermission('complete_signoff'), async (req, res) => {
  const b = req.body || {};
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.id]);
    if (!rows.length) { client.release(); return res.status(404).json({ error: 'Sign-off sheet not found' }); }
    const existing = rows[0];
    await client.query('BEGIN');
    const { rows: upd } = await client.query(
      'UPDATE signoff_forms SET start_time=$1, end_time=$2, invoice_number=$3, work_complete=$4, num_technicians=$5, manager_name=$6, technician_names=$7, work_description=$8, signature_data=$9, notes=COALESCE($10, notes), status=$11, completed_by=$12, completed_at=NOW(), updated_at=NOW() WHERE id=$13 RETURNING *',
      [b.start_time || null, b.end_time || null, b.invoice_number || null, (b.work_complete === true || b.work_complete === false) ? b.work_complete : null, b.num_technicians ? parseInt(b.num_technicians) : null, b.manager_name || null, b.technician_names || null, b.work_description || null, b.signature_data || null, b.notes || null, 'completed', req.user.id, req.params.id]
    );
    const photos = Array.isArray(b.photos) ? b.photos : [];
    // Replace photos with the submitted set
    await client.query('DELETE FROM signoff_photos WHERE form_id = $1', [req.params.id]);
    for (var i = 0; i < photos.length; i++) {
      const ph = photos[i];
      const img = typeof ph === 'string' ? ph : (ph && ph.image_data);
      const cap = (ph && ph.caption) ? ph.caption : null;
      if (img) await client.query('INSERT INTO signoff_photos (form_id, image_data, caption) VALUES ($1,$2,$3)', [req.params.id, img, cap]);
    }
    await client.query('COMMIT');
    client.release();

    const form = upd[0];
    try { await logAudit({ entity_type: 'signoff', entity_id: form.id, entity_number: form.form_number, action: 'completed', user_id: req.user.id, user_name: req.user.name, details: { manager: form.manager_name, photos: photos.length } }); } catch (e) {}

    // Email admins with signature + photos attached
    try {
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      const _so = await notify.broadcastRecipients('signoff_completed', "role = 'admin'");
      const emails = _so.emails;
      if (emails.length) {
        const html = emailTemplate({
          badge: 'Sign-off completed', badgeColor: 'green',
          title: 'Work order sign-off completed',
          body: '<strong>' + (req.user.name || 'A technician') + '</strong> completed sign-off sheet ' + form.form_number + (form.store_name ? ' for ' + form.store_name : '') + '. The photos are attached.',
          details: [
            { label: 'Form #', value: form.form_number },
            { label: 'PO #', value: form.po_number || '—' },
            { label: 'Invoice #', value: form.invoice_number || '—' },
            { label: 'Account', value: form.account || '—' },
            { label: 'Store', value: (form.store_name || '—') + (form.store_number ? ' (#' + form.store_number + ')' : '') },
            { label: 'Work 100% complete', value: form.work_complete === true ? 'Yes' : (form.work_complete === false ? 'No' : '—') },
            { label: 'Technicians', value: form.technician_names || '—' },
            { label: 'Completed by', value: req.user.name }
          ],
          buttonText: 'View Sign-Off Sheet',
          buttonUrl: base + '/?view=view-signoff&id=' + form.id,
          footerNote: 'Automated notification from Nova when a work order sign-off sheet is completed.'
        });
        const attachments = [];
        // Signature image intentionally not attached to admin email.
        for (var j = 0; j < photos.length; j++) {
          const pobj = photos[j];
          const pimg = typeof pobj === 'string' ? pobj : (pobj && pobj.image_data);
          const pcap = (pobj && pobj.caption) ? String(pobj.caption).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') : '';
          if (pimg) attachments.push({ filename: form.form_number + '-' + (pcap || ('photo-' + (j + 1))) + '.jpg', content: stripDataUrl(pimg) });
        }
        await sendWithAttachments(emails, 'Sign-Off Completed: ' + form.form_number + (form.store_name ? ' — ' + form.store_name : ''), html, attachments);
      }
    } catch (e) { console.error('Signoff completion email failed:', e); }

    res.json(form);
  } catch (err) {
    await client.query('ROLLBACK').catch(function () {});
    client.release();
    console.error(err);
    res.status(500).json({ error: 'Failed to complete sign-off sheet: ' + err.message });
  }
});

// DELETE (admin or creator)
router.delete('/:id', requireAuth, requirePermission('delete_signoff'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    const form = rows[0];
    if (req.user.role !== 'admin' && form.created_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    await pool.query('DELETE FROM signoff_forms WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'signoff', entity_id: form.id, entity_number: form.form_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete sign-off sheet' });
  }
});

module.exports = router;
