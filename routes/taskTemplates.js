const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Load one template with its ordered steps (+ default assignee names)
async function loadTemplate(id) {
  const { rows } = await pool.query('SELECT * FROM task_templates WHERE id = $1', [id]);
  if (!rows.length) return null;
  const tpl = rows[0];
  const { rows: steps } = await pool.query(
    'SELECT s.*, u.name AS assignee_name FROM task_template_steps s ' +
    'LEFT JOIN users u ON s.default_assignee_id = u.id ' +
    'WHERE s.template_id = $1 ORDER BY s.position, s.id',
    [id]
  );
  tpl.steps = steps;
  return tpl;
}

// Replace all steps for a template from an incoming array of {title, default_assignee_id}
async function saveSteps(templateId, steps) {
  await pool.query('DELETE FROM task_template_steps WHERE template_id = $1', [templateId]);
  if (!Array.isArray(steps)) return;
  let pos = 0;
  for (const st of steps) {
    const title = (typeof st === 'string' ? st : (st && st.title) || '').trim();
    if (!title) continue;
    let aid = null;
    if (st && typeof st === 'object' && st.default_assignee_id != null && st.default_assignee_id !== '') {
      aid = parseInt(st.default_assignee_id, 10);
      if (isNaN(aid)) aid = null;
    }
    await pool.query(
      'INSERT INTO task_template_steps (template_id, title, position, default_assignee_id) VALUES ($1,$2,$3,$4)',
      [templateId, title.slice(0, 500), pos, aid]
    );
    pos++;
  }
}

// LIST — active templates by default; ?all=1 includes inactive (admin screen)
router.get('/', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const includeInactive = req.query.all === '1' || req.query.all === 'true';
    const where = includeInactive ? '' : 'WHERE t.active = true ';
    const { rows } = await pool.query(
      'SELECT t.*, (SELECT COUNT(*) FROM task_template_steps s WHERE s.template_id = t.id) AS step_count ' +
      'FROM task_templates t ' + where + 'ORDER BY t.active DESC, LOWER(t.name)'
    );
    rows.forEach(function (r) { r.step_count = parseInt(r.step_count, 10) || 0; });
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load templates' }); }
});

// GET one
router.get('/:id', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const tpl = await loadTemplate(req.params.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json(tpl);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load template' }); }
});

// CREATE
router.post('/', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : 'medium';
    const category = b.category ? String(b.category).slice(0, 50) : null;
    const { rows } = await pool.query(
      'INSERT INTO task_templates (name, description, priority, category, active, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [name.slice(0, 255), b.description ? String(b.description) : null, priority, category, b.active === false ? false : true, req.user.id]
    );
    const id = rows[0].id;
    await saveSteps(id, b.steps);
    try { await logAudit({ entity_type: 'task_template', entity_id: id, entity_number: '#' + id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { name: name } }); } catch (e) {}
    res.status(201).json(await loadTemplate(id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create template' }); }
});

// UPDATE (fields + full step replace when steps provided)
router.put('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const { rows: ex } = await pool.query('SELECT * FROM task_templates WHERE id = $1', [req.params.id]);
    if (!ex.length) return res.status(404).json({ error: 'Template not found' });
    const cur = ex[0];
    const name = b.name != null ? (b.name || '').trim() : cur.name;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : cur.priority;
    const category = b.category !== undefined ? (b.category ? String(b.category).slice(0, 50) : null) : cur.category;
    const description = b.description !== undefined ? (b.description ? String(b.description) : null) : cur.description;
    const active = b.active !== undefined ? !!b.active : cur.active;
    await pool.query(
      'UPDATE task_templates SET name = $1, description = $2, priority = $3, category = $4, active = $5, updated_at = NOW() WHERE id = $6',
      [name.slice(0, 255), description, priority, category, active, req.params.id]
    );
    if (Array.isArray(b.steps)) await saveSteps(req.params.id, b.steps);
    try { await logAudit({ entity_type: 'task_template', entity_id: req.params.id, entity_number: '#' + req.params.id, action: 'updated', user_id: req.user.id, user_name: req.user.name, details: { name: name } }); } catch (e) {}
    res.json(await loadTemplate(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update template' }); }
});

// DELETE
router.delete('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    await pool.query('DELETE FROM task_templates WHERE id = $1', [req.params.id]);
    try { await logAudit({ entity_type: 'task_template', entity_id: req.params.id, entity_number: '#' + req.params.id, action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete template' }); }
});

module.exports = router;
