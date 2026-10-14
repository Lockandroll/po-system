// Customer-facing photos in the employee file: a tech photo and a vehicle photo,
// shown to customers on the call link (/c/<token>) once the tech acknowledges.
// Plan: claude/nova-dispatch-new-call-plan.md, step 4 (Tony, 2026-10-13):
// a simple manager upload, no approval flow, no plate information.
//
//   GET    /api/employee-photos/:userId          which slots are filled (+ thumbnails)
//   POST   /api/employee-photos/:userId/:slot    { data: <data URL> }
//   DELETE /api/employee-photos/:userId/:slot
//
// Same permission as the employee file itself (manage_onboarding).
// No backticks anywhere in this file (Windows corrupts them in .js).

const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const cl = require('../utils/callLink');

const router = express.Router();
router.use(requireAuth, requirePermission('manage_onboarding'));

function uid(req) { const n = parseInt(req.params.userId, 10); return isFinite(n) && n > 0 ? n : null; }

router.get('/:userId', async function (req, res) {
  const id = uid(req);
  if (!id) return res.status(400).json({ error: 'Bad user' });
  const r = await pool.query('SELECT slot, r2_key, mime, uploaded_at FROM employee_photos WHERE user_id = $1', [id]);
  const out = { storage_ready: r2.configured(), required: await cl.photosRequired(), slots: {} };
  for (const p of r.rows) {
    var data = null;
    if (req.query.thumbs === '1' && r2.configured()) {
      try { data = 'data:' + (p.mime || 'image/jpeg') + ';base64,' + (await r2.getObjectBuffer(p.r2_key)).toString('base64'); }
      catch (e) { data = null; }
    }
    out.slots[p.slot] = { uploaded_at: p.uploaded_at, data: data };
  }
  res.json(out);
});

router.post('/:userId/:slot', async function (req, res) {
  const id = uid(req);
  const slot = req.params.slot;
  if (!id || cl.PHOTO_SLOTS.indexOf(slot) === -1) return res.status(400).json({ error: 'Bad photo slot' });
  const u = await pool.query('SELECT id, name FROM users WHERE id = $1', [id]);
  if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
  var stored;
  try { stored = await cl.storeDataUrl('employees/' + id + '/' + slot, req.body && req.body.data); }
  catch (e) { console.error('[employeePhotos] store:', e.message); return res.status(502).json({ error: 'The photo did not upload. Try again.' }); }
  if (stored.error) return res.status(400).json({ error: stored.error });
  const prev = await pool.query('SELECT r2_key FROM employee_photos WHERE user_id = $1 AND slot = $2', [id, slot]);
  await pool.query(
    'INSERT INTO employee_photos (user_id, slot, r2_key, mime, uploaded_at, uploaded_by) VALUES ($1,$2,$3,$4,NOW(),$5) ' +
    'ON CONFLICT (user_id, slot) DO UPDATE SET r2_key = EXCLUDED.r2_key, mime = EXCLUDED.mime, uploaded_at = NOW(), uploaded_by = EXCLUDED.uploaded_by',
    [id, slot, stored.key, stored.mime, req.user.id]);
  if (prev.rows.length && prev.rows[0].r2_key !== stored.key) { try { await r2.deleteObject(prev.rows[0].r2_key); } catch (e) {} }
  await logAudit({ entity_type: 'user', entity_id: id, action: 'customer_photo_' + slot, user_id: req.user.id, user_name: req.user.name,
    details: { employee: u.rows[0].name, replaced: !!prev.rows.length } });
  res.json({ ok: true });
});

router.delete('/:userId/:slot', async function (req, res) {
  const id = uid(req);
  const slot = req.params.slot;
  if (!id || cl.PHOTO_SLOTS.indexOf(slot) === -1) return res.status(400).json({ error: 'Bad photo slot' });
  const prev = await pool.query('DELETE FROM employee_photos WHERE user_id = $1 AND slot = $2 RETURNING r2_key', [id, slot]);
  if (prev.rows.length) { try { await r2.deleteObject(prev.rows[0].r2_key); } catch (e) {} }
  await logAudit({ entity_type: 'user', entity_id: id, action: 'customer_photo_' + slot + '_removed', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ ok: true, removed: prev.rows.length > 0 });
});

module.exports = router;
