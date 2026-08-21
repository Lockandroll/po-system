const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { emailTemplate } = require('../utils/email');
const notify = require('../utils/notify');
const push = require('../utils/push');
const { buildSignoffPdf } = require('../utils/signoffPdf');
const signoffTrips = require('../utils/signoffTrips');

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

// tripFormNumber and the trip INSERT now live in utils/signoffTrips.js — the work order
// module creates trips too, and two copies of that INSERT is how the numbering drifts.

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

// ---- Linked work order ---------------------------------------------------
// A sign-off sheet carries no work_order_id of its own; the link runs the other
// way, because work_orders.signoff_id points at the LIVE trip. So the lookup has
// to go through the trip group: whichever work order points at any sheet in this
// series is this job's work order. That is what lets trip 3 find the WO that
// trip 1 was born from.
//
// Fallback: a sheet someone typed in by hand before the WO arrived has no
// pointer at all, so we match on the client's WO number instead — but only when
// EXACTLY ONE live work order carries that number. Two accounts reusing a number
// fails closed rather than showing a tech somebody else's job.
async function findLinkedWorkOrder(form) {
  const { rows } = await pool.query(
    'SELECT * FROM work_orders ' +
    'WHERE signoff_id IN (SELECT id FROM signoff_forms WHERE trip_group_id = $1) ' +
    'ORDER BY id DESC LIMIT 1',
    [groupIdOf(form)]
  );
  if (rows.length) return rows[0];
  const wn = String(form.wo_number || '').trim();
  if (!wn) return null;
  const { rows: byNum } = await pool.query(
    'SELECT * FROM work_orders WHERE wo_number = $1 AND revision_of_id IS NULL ORDER BY id DESC LIMIT 2',
    [wn]
  );
  return byNum.length === 1 ? byNum[0] : null;
}

// Read access to a sheet, in one place. Mirrors the rule GET /:id enforces:
// admins and managers see everything, everyone else sees only sheets assigned to
// (or created by) them. Returns { form } or { err: 403|404 }.
async function loadSheetForRead(req, id) {
  const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [id]);
  if (!rows.length) return { err: 404, message: 'Sign-off sheet not found' };
  const form = rows[0];
  if (!SEE_ALL.includes(req.user.role) && form.assigned_to !== req.user.id && form.created_by !== req.user.id) {
    return { err: 403, message: 'Access denied' };
  }
  return { form: form };
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
    // The JOB's invoice, if it has one. Drives the button beside the Invoice
    // Number field: create one, open the existing one, or (when that one is
    // frozen) create a replacement. Looked up by trip group, so trip 3 finds the
    // invoice trip 1 created. Best-effort: a lookup failure must not 500 a sheet
    // a tech is trying to open on site.
    form.invoice_link = null;
    try {
      const { rows: ilr } = await pool.query(
        'SELECT id, invoice_number, status FROM invoices WHERE signoff_group_id = $1 ORDER BY id DESC LIMIT 1',
        [groupIdOf(form)]
      );
      if (ilr.length) {
        form.invoice_link = {
          id: ilr[0].id,
          invoice_number: String(ilr[0].invoice_number),
          status: ilr[0].status
        };
      }
    } catch (e) { console.error('Sign-off invoice link lookup failed:', e && e.message); }
    // The JOB's work order, if it came from one. Only enough to draw the button —
    // the popup pulls the full record (and the original document) on demand, so a
    // sheet opening on a phone in a parking lot never drags a PDF down with it.
    // Best-effort for the same reason the invoice lookup is.
    form.work_order_link = null;
    try {
      const wo = await findLinkedWorkOrder(form);
      if (wo) {
        const { rows: ac } = await pool.query('SELECT COUNT(*)::int AS c FROM work_order_attachments WHERE work_order_id = $1', [wo.id]);
        form.work_order_link = {
          id: wo.id,
          wo_ref: wo.wo_ref || null,
          wo_number: wo.wo_number || null,
          status: wo.status || null,
          attachment_count: (ac[0] && ac[0].c) || 0
        };
      }
    } catch (e) { console.error('Sign-off work order link lookup failed:', e && e.message); }
    res.json(form);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sign-off sheet' });
  }
});

// GET /:id/work-order — the work order behind this sheet, for the popup.
//
// Gated on view_signoffs and the SHEET's access rule on purpose, NOT on
// view_work_orders. GET /api/work-orders/:id only lets you through if you manage
// work orders or the WO itself is assigned to you, and a tech is routinely
// assigned the sign-off while the work order sits with the coordinator. Anyone
// allowed to open the sheet is allowed to read the order it came from.
router.get('/:id/work-order', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const got = await loadSheetForRead(req, req.params.id);
    if (got.err) return res.status(got.err).json({ error: got.message });
    const wo = await findLinkedWorkOrder(got.form);
    if (!wo) return res.status(404).json({ error: 'No work order is linked to this sign-off sheet.' });
    // Attachment metadata only. The bytes come one at a time from the route below.
    const { rows: att } = await pool.query(
      'SELECT id, filename, mime_type, size_bytes FROM work_order_attachments WHERE work_order_id = $1 ORDER BY id',
      [wo.id]
    );
    wo.attachments = att;
    // parsed is the AI extractor's raw scratch output — the popup shows the
    // corrected columns, never that. email_body stays: with no PDF or image on
    // the order it IS the original document.
    delete wo.parsed;
    res.json(wo);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the linked work order' });
  }
});

// GET /:id/work-order/attachment/:aid — the original document for the popup.
// Same access rule as above, and the attachment has to belong to THIS sheet's
// work order — the id in the URL is never trusted on its own.
router.get('/:id/work-order/attachment/:aid', requireAuth, requirePermission('view_signoffs'), async (req, res) => {
  try {
    const got = await loadSheetForRead(req, req.params.id);
    if (got.err) return res.status(got.err).json({ error: got.message });
    const wo = await findLinkedWorkOrder(got.form);
    if (!wo) return res.status(404).json({ error: 'No work order is linked to this sign-off sheet.' });
    const { rows } = await pool.query(
      'SELECT image_data, mime_type, filename FROM work_order_attachments WHERE id = $1 AND work_order_id = $2',
      [req.params.aid, wo.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    res.json({ image_data: rows[0].image_data, mime_type: rows[0].mime_type, filename: rows[0].filename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load the work order document' });
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
// The copy-forward itself lives in utils/signoffTrips.js; this route owns the access rule.
router.post('/:id/trip', requireAuth, requirePermission('create_signoff'), async (req, res) => {
  const b = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Sign-off sheet not found' });
    const src = rows[0];
    if (!SEE_ALL.includes(req.user.role) && src.assigned_to !== req.user.id && src.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    // A blank pick in the assignee dropdown has always meant "same tech as last trip" here,
    // not "unassign". undefined is what tells the helper to inherit.
    const assignedTo = (b.assigned_to !== undefined && b.assigned_to !== null && b.assigned_to !== '')
      ? (parseInt(b.assigned_to, 10) || null)
      : undefined;
    const r = await signoffTrips.createNextTrip(src.id, {
      userId: req.user.id,
      userName: req.user.name,
      assignedTo: assignedTo,
      trip_reason: b.trip_reason || null,
      via: 'signoff'
    });
    if (r.error) return res.status(r.code || 400).json({ error: r.error });
    res.status(201).json(r.trip);
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
    // NOTE invoice_number: COALESCE(NULLIF($3, ''), invoice_number). A blank in the
    // request must NEVER null a number the sheet already carries - that is exactly
    // how a stamped number used to get wiped by anyone completing the sheet without
    // retyping it. A real number still overwrites, so a typo stays correctable.
    // A blank IS legitimate now: the client only requires an invoice number when
    // work_complete is true. A job can run several trips with a sheet each, and
    // only the trip that finishes it bills - so an unfinished trip closes with
    // the box empty. The COALESCE is what makes that safe: if an earlier trip
    // already stamped the job's invoice number, an empty later submission leaves
    // it exactly where it was.
    const { rows: upd } = await client.query(
      'UPDATE signoff_forms SET start_time=$1, end_time=$2, invoice_number = COALESCE(NULLIF($3, \'\'), invoice_number), work_complete=$4, num_technicians=$5, manager_name=$6, technician_names=$7, work_description=$8, signature_data = COALESCE($9, signature_data), notes=COALESCE($10, notes), gps_lat = COALESCE($11, gps_lat), gps_lon = COALESCE($12, gps_lon), gps_accuracy = COALESCE($13, gps_accuracy), gps_error=$14, signed_at = COALESCE($15, signed_at), status=$16, completed_by=$17, completed_at=NOW(), updated_at=NOW() WHERE id=$18 RETURNING *',
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
