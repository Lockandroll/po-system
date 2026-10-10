const express = require('express');
const { pool } = require('../db');
const { reindexSop } = require('../utils/sopIndex');
const policyVersions = require('../utils/policyVersions');
const { logAudit } = require('../utils/audit');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// List SOP documents (metadata only - no full text) - admin only
router.get('/', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { rows } = await pool.query(
      'SELECT d.id, d.title, d.filename, d.char_count, d.active, d.uploaded_by_name, d.created_at, d.version, d.updated_at, d.updated_by_name, ' +
      '(SELECT COUNT(*)::int FROM onboarding_steps s WHERE s.active = true AND s.sop_id = d.id) AS used_by_steps ' +
      'FROM sop_documents d ORDER BY d.created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    console.error('SOP list error:', err);
    res.status(500).json({ error: 'Failed to load SOP documents' });
  }
});

// Create a SOP document (extracted text, sent from the browser) - admin only
router.post('/', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { title, filename, content } = req.body;
    if (!title || !content || !content.trim()) {
      return res.status(400).json({ error: 'Title and extracted content are required' });
    }
    const text = content.trim();
    const { rows } = await pool.query(
      'INSERT INTO sop_documents (title, filename, content, char_count, uploaded_by, uploaded_by_name) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [title.trim().slice(0, 255), (filename || '').slice(0, 255), text, text.length, req.user.id, req.user.name]
    );
    try {
      await reindexSop(pool, rows[0].id, text);
    } catch (e) { console.error('SOP chunk index failed:', e.message); }
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('SOP create error:', err);
    res.status(500).json({ error: 'Failed to save SOP document' });
  }
});

// Update a SOP document (toggle active, or rename) - admin only
router.put('/:id', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const { active, title } = req.body;
    const sets = [];
    const params = [];
    if (typeof active === 'boolean') { params.push(active); sets.push('active = $' + params.length); }
    if (typeof title === 'string' && title.trim()) { params.push(title.trim().slice(0, 255)); sets.push('title = $' + params.length); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await pool.query('UPDATE sop_documents SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
    res.json({ success: true });
  } catch (err) {
    console.error('SOP update error:', err);
    res.status(500).json({ error: 'Failed to update SOP document' });
  }
});

// Delete a SOP document - admin only. Refused while an onboarding step uses it
// (the delete would null the step's sop_id and leave a hire a blank step or a
// quiz with nothing to ask), unless the caller passes force=1.
router.delete('/:id', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    if (req.query.force !== '1') {
      const use = await policyVersions.sopUsage(pool, req.params.id);
      if (use.onboarding_steps.length) {
        return res.status(409).json({
          error: 'Onboarding uses this SOP (' + use.onboarding_steps.map(function (x) { return x.title; }).join(', ') +
            '). Upload a new version instead, or point those steps at another SOP first.',
          in_use: use.onboarding_steps
        });
      }
    }
    await pool.query('DELETE FROM sop_documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('SOP delete error:', err);
    res.status(500).json({ error: 'Failed to delete SOP document' });
  }
});

// ---- Versions (Tony, 2026-10-09) ----
// Replace an SOP's text IN PLACE, keeping its id, so onboarding steps,
// onboarding quizzes and Nova AI all move to the new wording at once. The old
// text goes to sop_document_versions. See utils/policyVersions.js.
router.post('/:id/version', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const b = req.body || {};
    const text = String(b.content || '').trim();
    if (text.length < 20) return res.status(400).json({ error: 'The new version has no readable text' });
    const row = await policyVersions.replaceSop(pool, req.params.id, { content: text, filename: b.filename, title: b.title }, req.user, b.note);
    if (!row) return res.status(404).json({ error: 'SOP not found' });
    logAudit({ entity_type: 'sop', entity_id: row.id, action: 'new_version', user_id: req.user.id, user_name: req.user.name, details: { title: row.title, version: row.version, note: b.note || null } });
    const usage = await policyVersions.sopUsage(pool, row.id);
    res.json({ success: true, sop: row, usage: usage });
  } catch (err) {
    console.error('SOP version error:', err);
    res.status(500).json({ error: 'Failed to save the new version' });
  }
});

router.get('/:id/versions', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const out = await policyVersions.sopVersions(pool, req.params.id);
    if (!out) return res.status(404).json({ error: 'SOP not found' });
    res.json(out);
  } catch (err) {
    console.error('SOP versions error:', err);
    res.status(500).json({ error: 'Failed to load the version history' });
  }
});

// One old version's text, for reading back what a hire was shown then.
router.get('/:id/versions/:vid', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const r = await pool.query('SELECT * FROM sop_document_versions WHERE id = $1 AND sop_id = $2', [parseInt(req.params.vid, 10), parseInt(req.params.id, 10)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Version not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('SOP version read error:', err);
    res.status(500).json({ error: 'Failed to load that version' });
  }
});

router.get('/:id/usage', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    res.json(await policyVersions.sopUsage(pool, req.params.id));
  } catch (err) {
    console.error('SOP usage error:', err);
    res.status(500).json({ error: 'Failed to check where this SOP is used' });
  }
});

// Point every onboarding step at another SOP, and (by default) disable this one
// so Nova AI stops quoting it. The one-click cleanup for a policy that was
// uploaded as a separate SOP instead of a new version.
router.post('/:id/relink', requireAuth, requireRole('admin'), async function(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const to = parseInt((req.body || {}).to_sop_id, 10);
    if (!to || to === id) return res.status(400).json({ error: 'Pick a different SOP' });
    const tr = await pool.query('SELECT id, title FROM sop_documents WHERE id = $1', [to]);
    if (!tr.rows.length) return res.status(404).json({ error: 'That SOP does not exist' });
    const moved = await policyVersions.relinkSop(pool, id, to);
    const deactivate = (req.body || {}).deactivate !== false;
    if (deactivate) await pool.query('UPDATE sop_documents SET active = false WHERE id = $1', [id]);
    await pool.query('UPDATE sop_documents SET active = true WHERE id = $1', [to]);
    logAudit({ entity_type: 'sop', entity_id: id, action: 'relink_onboarding', user_id: req.user.id, user_name: req.user.name, details: { to: to, to_title: tr.rows[0].title, steps: moved.map(function (x) { return x.id; }), deactivated: deactivate } });
    res.json({ success: true, moved: moved, to_title: tr.rows[0].title, deactivated: deactivate });
  } catch (err) {
    console.error('SOP relink error:', err);
    res.status(500).json({ error: 'Failed to move the steps' });
  }
});

module.exports = router;
