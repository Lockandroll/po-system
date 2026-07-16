const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { emailTemplate } = require('../utils/email');
const notify = require('../utils/notify');
const push = require('../utils/push');
const { buildSignoffPdf } = require('../utils/signoffPdf');

const router = express.Router();

// Roles that see every sign-off sheet; everyone else sees only ones assigned to (or created by) them.
const SEE_ALL = ['admin', 'manager'];

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

// ---- Trip series helpers -------------------------------------------------
// A job that needs more than one visit gets one sheet per trip, linked by trip_group_id.
// Trip 1 is the original sheet; trips 2+ suffix its form number (-T2, -T3).

function groupIdOf(form) {
  return form.trip_group_id || form.id;
}

function tripFormNumber(baseNumber, tripNumber) {
  return String(baseNumber) + '-T' + tripNumber;
}

// Label used on the PDF, in email subjects, and in attachment filenames.
// Returns '' for an ordinary single-visit job so nothing changes for the common case.
function tripLabel(form, tripCount) {
  const n = form.trip_number || 1;
  if (n <= 1 && (!tripCount || tripCount <= 1)) return '';
  return 'Trip ' + n + (tripCount ? ' of ' + tripCount : '');
}

async function tripCountOf(groupId) {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM signoff_forms WHERE trip_group_id = $1', [groupId]);
  return (rows[0] && rows[0].c) || 1;
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
    const seeAll = SEE_ALL.includes(req.user.role);
    const where = seeAll ? '' : 'WHERE (f.assigned_to = $1 OR f.created_by = $1) ';
    const params = seeAll ? [] : [req.user.id];
    const { rows } = await pool.query(
      'SELECT f.id, f.form_number, f.status, f.wo_number, f.po_number, f.account, f.store_name, f.store_number, f.created_by, f.assigned_to, ' +
      '       f.address, f.city_state_zip, f.service_requested_by, f.work_complete, f.completed_at, f.created_at, ' +
      '       f.trip_group_id, f.trip_number, ' +
      '       (SELECT COUNT(*)::int FROM signoff_forms t WHERE t.trip_group_id = f.trip_group_id) AS trip_count, ' +
      '       c.name AS created_by_name, d.name AS completed_by_name, a.name AS assigned_to_name, ' +
      '       (SELECT COUNT(*) FROM signoff_photos p WHERE p.form_id = f.id) AS photo_count ' +
      'FROM signoff_forms f ' +
      'LEFT JOIN users c ON f.created_by = c.id ' +
      'LEFT JOIN users d ON f.completed_by = d.id ' +
      'LEFT JOIN users a ON f.assigned_to = a.id ' +
      where +
      'ORDER BY (f.status = \'pending\') DESC, f.created_at DESC',
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sign-off sheets' });
  }
});

// GET assignable users (anyone with module access can load this for the picker)
router.get('/assignees', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE active IS NOT FALSE ORDER BY name ASC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch assignees' });
  }
});

// GET single sheet with photos
router.get('/:id', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT f.*, c.name AS created_by_name, d.name AS completed_by_name, a.name AS assigned_to_name ' +
      'FROM signoff_forms f LEFT JOIN users c ON f.created_by = c.id LEFT JOIN users d ON f.completed_by = d.id LEFT JOIN users a ON f.assigned_to = a.id WHERE f.id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    const form = rows[0];
    if (!SEE_ALL.includes(req.user.role) && form.assigned_to !== req.user.id && form.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const { rows: photos } = await pool.query('SELECT id, image_data, caption FROM signoff_photos WHERE form_id = $1 ORDER BY id', [req.params.id]);
    form.photos = photos;
    // Every trip on this job, for the trip strip. can_open mirrors the access rule above so the
    // strip never offers a tech a sheet they would get a 403 on.
    const { rows: trips } = await pool.query(
      'SELECT t.id, t.form_number, t.trip_number, t.status, t.work_complete, t.completed_at, t.trip_reason, t.created_by, t.assigned_to, u.name AS completed_by_name ' +
      'FROM signoff_forms t LEFT JOIN users u ON t.completed_by = u.id ' +
      'WHERE t.trip_group_id = $1 ORDER BY t.trip_number ASC',
      [groupIdOf(form)]
    );
    const seeAll = SEE_ALL.includes(req.user.role);
    form.trips = trips.map(function (t) {
      return {
        id: t.id, form_number: t.form_number, trip_number: t.trip_number, status: t.status,
        work_complete: t.work_complete, completed_at: t.completed_at, completed_by_name: t.completed_by_name,
        trip_reason: t.trip_reason,
        can_open: seeAll || t.assigned_to === req.user.id || t.created_by === req.user.id
      };
    });
    form.trip_count = form.trips.length;
    // Only the newest trip can spawn the next one, and only once it is finished.
    const last = form.trips[form.trips.length - 1];
    form.can_add_trip = !!(last && last.id === form.id && form.status === 'completed');
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
        'INSERT INTO signoff_forms (form_number, status, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by, assigned_to) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
        [form_number, 'pending', b.po_number || null, b.account || null, b.store_name || null, b.store_number || null, b.address || null, b.city_state_zip || null, b.service_requested_by || null, b.notes || null, req.user.id, (b.assigned_to ? (parseInt(b.assigned_to, 10) || null) : null)]
      );
      const form = rows[0];
      // Trip 1 seeds its own series.
      const { rows: seeded } = await pool.query(
        'UPDATE signoff_forms SET trip_group_id = id, trip_number = 1, trip_base_number = form_number WHERE id = $1 RETURNING *',
        [form.id]
      );
      const seededForm = seeded[0] || form;
      try { await logAudit({ entity_type: 'signoff', entity_id: form.id, entity_number: form_number, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { store: b.store_name || null, po: b.po_number || null } }); } catch (e) {}
      return res.status(201).json(seededForm);
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
      'UPDATE signoff_forms SET po_number=$1, account=$2, store_name=$3, store_number=$4, address=$5, city_state_zip=$6, service_requested_by=$7, notes=$8, assigned_to=$9, updated_at=NOW() WHERE id=$10 RETURNING *',
      [b.po_number || null, b.account || null, b.store_name || null, b.store_number || null, b.address || null, b.city_state_zip || null, b.service_requested_by || null, b.notes || null, (b.assigned_to ? (parseInt(b.assigned_to, 10) || null) : null), req.params.id]
    );
    try { await logAudit({ entity_type: 'signoff', entity_id: parseInt(req.params.id), entity_number: rows[0].form_number, action: 'edited', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json(upd[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update sign-off sheet' });
  }
});

// POST /:id/trip — start the next visit on this job.
// Copies the job setup forward; everything that belongs to a visit (times, techs, signature,
// photos, invoice #) starts empty, because the manager signs for the visit that actually happened.
router.post('/:id/trip', requireAuth, requirePermission('create_signoff'), async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    const src = rows[0];
    if (!SEE_ALL.includes(req.user.role) && src.assigned_to !== req.user.id && src.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (src.status !== 'completed') {
      return res.status(400).json({ error: 'Finish this sheet before adding the next trip.' });
    }
    const groupId = groupIdOf(src);
    // One live sheet per job — no two open trips at once.
    const open = await pool.query("SELECT id, form_number FROM signoff_forms WHERE trip_group_id = $1 AND status = 'pending' LIMIT 1", [groupId]);
    if (open.rows.length) {
      return res.status(400).json({ error: 'Trip ' + open.rows[0].form_number + ' is still open on this job. Complete it before adding another.' });
    }
    const agg = await pool.query('SELECT MAX(trip_number) AS maxtrip, MIN(trip_base_number) AS base FROM signoff_forms WHERE trip_group_id = $1', [groupId]);
    const nextTrip = (agg.rows[0].maxtrip || 1) + 1;
    const base = agg.rows[0].base || src.trip_base_number || src.form_number;
    const form_number = tripFormNumber(base, nextTrip);
    const assigned = (b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== '')
      ? (parseInt(b.assigned_to, 10) || null)
      : (src.assigned_to || null);
    const { rows: ins } = await pool.query(
      'INSERT INTO signoff_forms (form_number, status, wo_number, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by, assigned_to, trip_group_id, trip_number, trip_base_number, trip_reason) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
      [form_number, 'pending', src.wo_number, src.po_number, src.account, src.store_name, src.store_number, src.address, src.city_state_zip, src.service_requested_by, src.notes, req.user.id, assigned, groupId, nextTrip, base, b.trip_reason || null]
    );
    const trip = ins[0];
    try {
      await logAudit({
        entity_type: 'signoff', entity_id: trip.id, entity_number: form_number, action: 'trip_created',
        user_id: req.user.id, user_name: req.user.name,
        details: { trip_number: nextTrip, from: src.form_number, reason: b.trip_reason || null }
      });
    } catch (e) {}
    // Point any work order on this job at the live trip so "Open Sign-Off" lands on the current sheet.
    try {
      await pool.query(
        'UPDATE work_orders SET signoff_id = $1, updated_at = NOW() WHERE signoff_id IN (SELECT id FROM signoff_forms WHERE trip_group_id = $2)',
        [trip.id, groupId]
      );
    } catch (e) { console.error('Repoint work order to new trip failed:', e && e.message); }
    res.status(201).json(trip);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add trip: ' + err.message });
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
    // Only a pending sheet can be completed. Once completed it stays locked (no reopen mechanism
    // exists) so a re-submit can't silently overwrite an already-signed sheet.
    if (existing.status !== 'pending') {
      client.release();
      return res.status(409).json({ error: 'This sign-off is already completed. Ask a manager to reopen it to make changes.' });
    }
    await client.query('BEGIN');
    const { rows: upd } = await client.query(
      'UPDATE signoff_forms SET start_time=$1, end_time=$2, invoice_number=$3, work_complete=$4, num_technicians=$5, manager_name=$6, technician_names=$7, work_description=$8, signature_data = COALESCE($9, signature_data), notes=COALESCE($10, notes), gps_lat = COALESCE($11, gps_lat), gps_lon = COALESCE($12, gps_lon), gps_accuracy = COALESCE($13, gps_accuracy), gps_error=$14, signed_at = COALESCE($15, signed_at), status=$16, completed_by=$17, completed_at=NOW(), updated_at=NOW() WHERE id=$18 RETURNING *',
      [b.start_time || null, b.end_time || null, b.invoice_number || null, (b.work_complete === true || b.work_complete === false) ? b.work_complete : null, b.num_technicians ? parseInt(b.num_technicians) : null, b.manager_name || null, b.technician_names || null, b.work_description || null, b.signature_data || null, b.notes || null, (b.gps_lat != null && b.gps_lat !== '') ? b.gps_lat : null, (b.gps_lon != null && b.gps_lon !== '') ? b.gps_lon : null, (b.gps_accuracy != null && b.gps_accuracy !== '') ? b.gps_accuracy : null, b.gps_error || null, b.signed_at || null, 'completed', req.user.id, req.params.id]
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
    // Auto-advance any linked work order to 'job_completed' — but only when the work is actually
    // finished. A trip signed off with "Work 100% complete = No" means a return trip is coming,
    // so the job stays open. Matches the WO against any sheet in the trip group.
    try {
      if (form.work_complete === true) {
        // Only the latest trip in the group may close the job. If a later trip exists (higher
        // trip_number) an earlier trip completing late must not close a job that continued on.
        const later = await pool.query(
          'SELECT 1 FROM signoff_forms WHERE trip_group_id = $1 AND trip_number > $2 LIMIT 1',
          [groupIdOf(form), form.trip_number || 1]
        );
        if (!later.rows.length) {
          await pool.query(
            "UPDATE work_orders SET status='job_completed', updated_at=NOW() " +
            "WHERE signoff_id IN (SELECT id FROM signoff_forms WHERE trip_group_id = $1) " +
            "AND status NOT IN ('paperwork_sent','job_completed')",
            [groupIdOf(form)]
          );
        }
      }
    } catch (e) { console.error('Work order auto-complete failed:', e && e.message); }

    // Email admins with signature + photos attached
    try {
      const base = (process.env.APP_URL || '').replace(/\/$/, '');
      const _so = await notify.broadcastRecipients('signoff_completed', "role IN ('admin', 'owner')");
      await push.sendPushToUsers(_so.userIds, { title: 'Sign-off completed', body: req.user.name + ' completed a sign-off sheet.', url: '/' });
      const emails = _so.emails;
      if (emails.length) {
        const _tripCount = await tripCountOf(groupIdOf(form));
        const _tripLabel = tripLabel(form, _tripCount);
        const html = emailTemplate({
          badge: 'Sign-off completed', badgeColor: 'green',
          title: 'Work order sign-off completed',
          body: '<strong>' + (req.user.name || 'A technician') + '</strong> completed sign-off sheet ' + form.form_number + (_tripLabel ? ' (' + _tripLabel + ')' : '') + (form.store_name ? ' for ' + form.store_name : '') + '. The signed sign-off PDF and photos are attached.' +
                (form.work_complete === false ? ' <strong>Work is not 100% complete</strong> — a return trip is expected, so the job remains open.' : ''),
          details: [
            { label: 'Form #', value: form.form_number },
            (_tripLabel ? { label: 'Trip', value: _tripLabel } : null),
            { label: 'PO #', value: form.po_number || '—' },
            { label: 'Invoice #', value: form.invoice_number || '—' },
            { label: 'Account', value: form.account || '—' },
            { label: 'Store', value: (form.store_name || '—') + (form.store_number ? ' (#' + form.store_number + ')' : '') },
            { label: 'Work 100% complete', value: form.work_complete === true ? 'Yes' : (form.work_complete === false ? 'No' : '—') },
            { label: 'Technicians', value: form.technician_names || '—' },
            { label: 'Completed by', value: req.user.name }
          ].filter(Boolean),
          buttonText: 'View Sign-Off Sheet',
          buttonUrl: base + '/?view=view-signoff&id=' + form.id,
          footerNote: 'Automated notification from Nova when a work order sign-off sheet is completed.'
        });
        // Company header for the PDF (falls back to the app defaults).
        var company = { name: 'Lock And Roll, LLC', address: '589 Dorset Court', csz: 'Mount Dora, FL 32757', phone: '337-873-2983' };
        var logoUrl = null;
        try {
          const cs = await pool.query("SELECT key, value FROM settings WHERE key IN ('company_name','company_address','company_city_state_zip','company_phone','logo')");
          const cmap = {}; cs.rows.forEach(function (r) { cmap[r.key] = r.value; });
          if (cmap.company_name) company.name = cmap.company_name;
          if (cmap.company_address) company.address = cmap.company_address;
          if (cmap.company_city_state_zip) company.csz = cmap.company_city_state_zip;
          if (cmap.company_phone) company.phone = cmap.company_phone;
          if (cmap.logo) logoUrl = cmap.logo;
        } catch (e) {}

        function fileSafe(x) { return String(x == null ? '' : x).replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
        var poLabel = form.po_number ? ('PO ' + String(form.po_number)) : form.form_number;
        // Trip 1 keeps the filename the office already files under; only trips 2+ get a suffix.
        var tripSuffix = (form.trip_number && form.trip_number > 1) ? (' Trip ' + form.trip_number) : '';

        const attachments = [];
        // PDF of the full sign-off sheet, named "PO xxxx Sign Off.pdf" (or "... Sign Off Trip 2.pdf").
        try {
          const pdfBuf = await buildSignoffPdf(form, photos, { company: company, completedBy: req.user.name, logo: logoUrl, tripLabel: _tripLabel });
          if (pdfBuf && pdfBuf.length) attachments.push({ filename: fileSafe(poLabel + ' Sign Off' + tripSuffix) + '.pdf', content: pdfBuf.toString('base64') });
        } catch (e) { console.error('Sign-off PDF build failed:', e && e.message); }
        // Photos named "PO xxxx <label>.jpg".
        for (var j = 0; j < photos.length; j++) {
          const pobj = photos[j];
          const pimg = typeof pobj === 'string' ? pobj : (pobj && pobj.image_data);
          const plabel = (pobj && pobj.caption) ? String(pobj.caption) : ('Picture ' + (j + 1));
          if (pimg) attachments.push({ filename: fileSafe(poLabel + ' ' + plabel + tripSuffix) + '.jpg', content: stripDataUrl(pimg) });
        }
        await sendWithAttachments(emails, 'Sign-Off Completed: ' + form.form_number + (form.store_name ? ' — ' + form.store_name : '') + (_tripLabel ? ' — ' + _tripLabel : ''), html, attachments);
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
    // Don't punch a hole in a trip series — later trips must go first.
    const later = await pool.query(
      'SELECT form_number FROM signoff_forms WHERE trip_group_id = $1 AND trip_number > $2 ORDER BY trip_number DESC',
      [groupIdOf(form), form.trip_number || 1]
    );
    if (later.rows.length) {
      return res.status(400).json({ error: 'Delete ' + later.rows[0].form_number + ' first — later trips on this job depend on this sheet.' });
    }
    await pool.query('DELETE FROM signoff_forms WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'signoff', entity_id: form.id, entity_number: form.form_number, action: 'deleted', user_id: req.user.id, user_name: req.user.name }); } catch (e) {}
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete sign-off sheet' });
  }
});

module.exports = router;
