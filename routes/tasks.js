const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const perms = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { notifyTaskAssigned } = require('../jobs/taskReminders');

const router = express.Router();

const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const RECUR = ['', 'daily', 'weekly', 'monthly'];
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };

async function nameOf(id) {
  if (!id) return 'someone';
  const { rows } = await pool.query('SELECT name FROM users WHERE id = $1', [id]);
  return rows.length ? rows[0].name : 'someone';
}
async function addActivity(taskId, user, type, body) {
  await pool.query(
    'INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)',
    [taskId, user ? user.id : null, user ? user.name : null, type, body]
  );
}
async function loadTask(id) {
  const { rows } = await pool.query(
    'SELECT t.*, a.name AS assignee_name, c.name AS creator_name ' +
    'FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id LEFT JOIN users c ON t.created_by = c.id WHERE t.id = $1',
    [id]
  );
  if (!rows.length) return null;
  const task = rows[0];
  const { rows: subs } = await pool.query('SELECT * FROM task_subtasks WHERE task_id = $1 ORDER BY position, id', [id]);
  const { rows: acts } = await pool.query('SELECT * FROM task_activity WHERE task_id = $1 ORDER BY created_at ASC, id ASC', [id]);
  task.subtasks = subs;
  task.activity = acts;
  return task;
}
async function canTouch(req, task) {
  if (await perms.hasPermission(req.user.role, 'manage_tasks')) return true;
  return task.assigned_to === req.user.id;
}

// LIST — managers see all; everyone else sees tasks assigned to them.
router.get('/', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    const params = [];
    let where = '';
    if (!manage) { where = 'WHERE t.assigned_to = $1'; params.push(req.user.id); }
    const { rows } = await pool.query(
      'SELECT t.*, a.name AS assignee_name, c.name AS creator_name, ' +
      '(SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id) AS subtask_total, ' +
      '(SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id AND s.done) AS subtask_done ' +
      'FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id LEFT JOIN users c ON t.created_by = c.id ' +
      where + " ORDER BY (t.status = 'done'), " +
      "CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, " +
      't.due_date NULLS LAST, t.position, t.id',
      params
    );
    rows.forEach(function (r) { r.subtask_total = parseInt(r.subtask_total) || 0; r.subtask_done = parseInt(r.subtask_done) || 0; });
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load tasks' }); }
});

// CREATE (managers/admin)
router.post('/', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const status = STATUSES.indexOf(b.status) !== -1 ? b.status : 'todo';
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : 'medium';
    const recurrence = RECUR.indexOf(b.recurrence) !== -1 ? (b.recurrence || null) : null;
    const assigned_to = b.assigned_to ? parseInt(b.assigned_to, 10) : null;
    const due_date = b.due_date || null;
    const { rows } = await pool.query(
      'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [title, b.description || null, status, priority, assigned_to, req.user.id, due_date, recurrence]
    );
    const task = rows[0];
    if (Array.isArray(b.subtasks)) {
      for (let i = 0; i < b.subtasks.length; i++) {
        const st = b.subtasks[i];
        const tt = (typeof st === 'string' ? st : (st && st.title) || '').trim();
        if (tt) await pool.query('INSERT INTO task_subtasks (task_id, title, position) VALUES ($1,$2,$3)', [task.id, tt, i]);
      }
    }
    await addActivity(task.id, req.user, 'event', 'created this task');
    if (assigned_to) await addActivity(task.id, req.user, 'event', 'assigned it to ' + (await nameOf(assigned_to)));
    try { await logAudit({ entity_type: 'task', entity_id: task.id, entity_number: '#' + task.id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { title: title } }); } catch (e) {}
    if (assigned_to) { try { await notifyTaskAssigned(task.id); } catch (e) {} }
    res.status(201).json(await loadTask(task.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create task' }); }
});

// SUBTASK toggle (assignee or manager) — declared before /:id routes
router.patch('/subtasks/:sid', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT s.*, t.assigned_to FROM task_subtasks s JOIN tasks t ON s.task_id = t.id WHERE s.id = $1', [req.params.sid]);
    if (!rows.length) return res.status(404).json({ error: 'Subtask not found' });
    if (!(await canTouch(req, rows[0]))) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('UPDATE task_subtasks SET done = $1 WHERE id = $2', [!!(req.body && req.body.done), req.params.sid]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update subtask' }); }
});
router.delete('/subtasks/:sid', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  await pool.query('DELETE FROM task_subtasks WHERE id = $1', [req.params.sid]);
  res.json({ success: true });
});

// GET one (assignee or manager)
router.get('/:id', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canTouch(req, task))) return res.status(403).json({ error: 'Forbidden' });
    res.json(task);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load task' }); }
});

// UPDATE (managers/admin)
router.put('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const ex = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Task not found' });
    const title = (b.title || ex.title || '').trim();
    const status = STATUSES.indexOf(b.status) !== -1 ? b.status : ex.status;
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : ex.priority;
    const recurrence = RECUR.indexOf(b.recurrence) !== -1 ? (b.recurrence || null) : ex.recurrence;
    const assigned_to = b.assigned_to !== undefined ? (b.assigned_to ? parseInt(b.assigned_to, 10) : null) : ex.assigned_to;
    const due_date = b.due_date !== undefined ? (b.due_date || null) : ex.due_date;
    const description = b.description !== undefined ? b.description : ex.description;
    const dueChanged = String(due_date) !== String(ex.due_date);
    const assigneeChanged = (assigned_to || null) !== (ex.assigned_to || null);
    await pool.query(
      'UPDATE tasks SET title=$1, description=$2, status=$3, priority=$4, assigned_to=$5, due_date=$6, recurrence=$7, ' +
      (dueChanged ? 'reminded_day_before=false, reminded_due=false, last_overdue_on=NULL, ' : '') +
      'updated_at=NOW() WHERE id=$8',
      [title, description, status, priority, assigned_to, due_date, recurrence, req.params.id]
    );
    if (assigneeChanged) await addActivity(req.params.id, req.user, 'event', assigned_to ? ('reassigned it to ' + (await nameOf(assigned_to))) : 'unassigned it');
    try { await logAudit({ entity_type: 'task', entity_id: parseInt(req.params.id), entity_number: '#' + req.params.id, action: 'edited', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    if (assigneeChanged && assigned_to) { try { await notifyTaskAssigned(req.params.id); } catch (e) {} }
    res.json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update task' }); }
});

// STATUS change (assignee or manager) + recurrence spawn on completion
router.patch('/:id/status', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const status = req.body && req.body.status;
    if (STATUSES.indexOf(status) === -1) return res.status(400).json({ error: 'Invalid status' });
    const ex = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Task not found' });
    if (!(await canTouch(req, ex))) return res.status(403).json({ error: 'Forbidden' });
    if (status === 'done' && ex.status !== 'done') {
      await pool.query("UPDATE tasks SET status='done', completed_at=NOW(), completed_by=$1, updated_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
      await addActivity(req.params.id, req.user, 'event', 'marked it done');
      if (ex.recurrence) await spawnRecurrence(ex, req.user);
    } else {
      await pool.query('UPDATE tasks SET status=$1, completed_at=NULL, completed_by=NULL, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
      await addActivity(req.params.id, req.user, 'event', 'moved it to ' + (STATUS_LABEL[status] || status));
    }
    res.json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update status' }); }
});

async function spawnRecurrence(task, user) {
  const base = task.due_date ? new Date(task.due_date) : new Date();
  const x = new Date(base.getTime());
  if (task.recurrence === 'daily') x.setDate(x.getDate() + 1);
  else if (task.recurrence === 'weekly') x.setDate(x.getDate() + 7);
  else if (task.recurrence === 'monthly') x.setMonth(x.getMonth() + 1);
  const ndStr = x.toISOString().slice(0, 10);
  const { rows } = await pool.query(
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7) RETURNING id",
    [task.title, task.description, task.priority, task.assigned_to, task.created_by, ndStr, task.recurrence]
  );
  const newId = rows[0].id;
  const { rows: subs } = await pool.query('SELECT title, position FROM task_subtasks WHERE task_id = $1 ORDER BY position, id', [task.id]);
  for (let i = 0; i < subs.length; i++) await pool.query('INSERT INTO task_subtasks (task_id, title, position) VALUES ($1,$2,$3)', [newId, subs[i].title, subs[i].position]);
  await addActivity(newId, user, 'event', 'auto-created from recurring task #' + task.id);
}

// SUBTASK add (managers/admin)
router.post('/:id/subtasks', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Subtask title required' });
  const { rows: mx } = await pool.query('SELECT COALESCE(MAX(position),-1)+1 AS p FROM task_subtasks WHERE task_id = $1', [req.params.id]);
  const { rows } = await pool.query('INSERT INTO task_subtasks (task_id, title, position) VALUES ($1,$2,$3) RETURNING *', [req.params.id, title, mx[0].p]);
  res.status(201).json(rows[0]);
});

// COMMENT (assignee or manager)
router.post('/:id/comments', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const body = ((req.body && req.body.body) || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment text required' });
    const ex = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Task not found' });
    if (!(await canTouch(req, ex))) return res.status(403).json({ error: 'Forbidden' });
    await addActivity(req.params.id, req.user, 'comment', body);
    res.status(201).json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add comment' }); }
});

// DELETE (managers/admin)
router.delete('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  try { await logAudit({ entity_type: 'task', entity_id: parseInt(req.params.id), entity_number: '#' + req.params.id, action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
