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
async function ownerIds() {
  const r = await pool.query("SELECT id FROM users WHERE role = 'owner'");
  return r.rows.map(function (x) { return x.id; });
}
function isOwnersOwn(task, owners) {
  if (!owners || !owners.length) return false;
  if (task.assigned_to && owners.indexOf(task.assigned_to) !== -1) return true;
  if ((task.assigned_to === null || task.assigned_to === undefined) && task.created_by && owners.indexOf(task.created_by) !== -1) return true;
  return false;
}
function involved(req, task) {
  return task.assigned_to === req.user.id || task.created_by === req.user.id;
}
// Visibility: you see tasks you're involved in; owner sees all; a plain admin
// audits everything except an owner's own (personal/self) tasks.
async function canSee(req, task) {
  if (involved(req, task)) return true;
  // Personal (self-assigned) tasks are private to that person - no audit.
  if (task.assigned_to && (task.created_by == null || task.assigned_to === task.created_by)) return false;
  // Admins and owners can audit delegated / unassigned tasks.
  if (req.user.role === 'admin') return true;
  return false;
}
// Edit/delete: the creator, or a manager/admin who can see it.
async function canEdit(req, task) {
  if (task.created_by === req.user.id) return true;
  if (await perms.hasPermission(req.user.role, 'manage_tasks') && await canSee(req, task)) return true;
  return false;
}
// Status/checklist: the assignee, or anyone who can edit.
async function canChangeStatus(req, task) {
  if (task.assigned_to === req.user.id) return true;
  return canEdit(req, task);
}

// LIST — managers see all; everyone else sees tasks assigned to them.
router.get('/', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    const audit = req.user.role === 'admin';
    const view = req.query.view === 'assigned' ? 'assigned' : 'mine';
    const params = [];
    let where = '';
    if (view === 'assigned') {
      if (!manage) return res.json([]);
      if (audit) {
        // Admin/owner oversight of all delegated/unassigned tasks (personal stays private).
        where = 'WHERE NOT (t.assigned_to IS NOT NULL AND (t.created_by IS NULL OR t.assigned_to = t.created_by))';
      } else {
        params.push(req.user.id); where = 'WHERE t.created_by = $1 AND (t.assigned_to IS NULL OR t.assigned_to <> $1)';
      }
    } else {
      where = 'WHERE t.assigned_to = $1'; params.push(req.user.id);
    }
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

// COUNTS for tab badges (open + past-due)
router.get('/counts', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const uid = req.user.id;
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    const audit = req.user.role === 'admin';
    const mine = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status <> 'done') AS open, " +
      "COUNT(*) FILTER (WHERE status <> 'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue " +
      "FROM tasks WHERE assigned_to = $1", [uid]);
    let assigned_open = 0, assigned_overdue = 0;
    if (manage) {
      let where = '', params = [];
      if (audit) {
        where = 'WHERE NOT (assigned_to IS NOT NULL AND (created_by IS NULL OR assigned_to = created_by))';
      } else { params.push(uid); where = 'WHERE created_by = $1 AND (assigned_to IS NULL OR assigned_to <> $1)'; }
      const conj = where ? (where + " AND status <> 'done'") : "WHERE status <> 'done'";
      const a = await pool.query("SELECT COUNT(*) AS open, COUNT(*) FILTER (WHERE due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue FROM tasks " + conj, params);
      assigned_open = parseInt(a.rows[0].open) || 0;
      assigned_overdue = parseInt(a.rows[0].overdue) || 0;
    }
    res.json({ mine_open: parseInt(mine.rows[0].open) || 0, mine_overdue: parseInt(mine.rows[0].overdue) || 0, assigned_open: assigned_open, assigned_overdue: assigned_overdue });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load task counts' }); }
});

// CREATE - anyone (view_tasks) makes a personal task; assigning to others needs manage_tasks.
router.post('/', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    const status = STATUSES.indexOf(b.status) !== -1 ? b.status : 'todo';
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : 'medium';
    const recurrence = RECUR.indexOf(b.recurrence) !== -1 ? (b.recurrence || null) : null;
    const recDay = (recurrence === 'weekly' || recurrence === 'monthly') && b.recurrence_day != null && b.recurrence_day !== '' ? parseInt(b.recurrence_day, 10) : null;
    let assigned_to = b.assigned_to ? parseInt(b.assigned_to, 10) : null;
    if (!manage) {
      if (assigned_to && assigned_to !== req.user.id) return res.status(403).json({ error: 'You can only create tasks for yourself.' });
      assigned_to = req.user.id;
    }
    const due_date = b.due_date || null;
    const { rows } = await pool.query(
      'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [title, b.description || null, status, priority, assigned_to, req.user.id, due_date, recurrence, recDay]
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

// BULK create — one task per selected assignee (managers/admin)
router.post('/bulk', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const title = (b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : 'medium';
    const recurrence = RECUR.indexOf(b.recurrence) !== -1 ? (b.recurrence || null) : null;
    const recDay = (recurrence === 'weekly' || recurrence === 'monthly') && b.recurrence_day != null && b.recurrence_day !== '' ? parseInt(b.recurrence_day, 10) : null;
    const due_date = b.due_date || null;
    const subs = Array.isArray(b.subtasks) ? b.subtasks : [];
    let assignees = Array.isArray(b.assignees) ? b.assignees.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : [];
    if (!assignees.length) assignees = [null];
    const ids = [];
    for (let a = 0; a < assignees.length; a++) {
      const aid = assignees[a];
      const { rows } = await pool.query(
        'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day) ' +
        "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7,$8) RETURNING id",
        [title, b.description || null, priority, aid, req.user.id, due_date, recurrence, recDay]
      );
      const id = rows[0].id;
      ids.push(id);
      for (let i = 0; i < subs.length; i++) {
        const st = subs[i];
        const tt = (typeof st === 'string' ? st : (st && st.title) || '').trim();
        if (tt) await pool.query('INSERT INTO task_subtasks (task_id, title, position) VALUES ($1,$2,$3)', [id, tt, i]);
      }
      await addActivity(id, req.user, 'event', 'created this task');
      if (aid) { await addActivity(id, req.user, 'event', 'assigned it to ' + (await nameOf(aid))); try { await notifyTaskAssigned(id); } catch (e) {} }
    }
    try { await logAudit({ entity_type: 'task', entity_id: ids[0], entity_number: '#' + ids[0], action: 'created', user_id: req.user.id, user_name: req.user.name, details: { title: title, count: ids.length } }); } catch (e) {}
    res.status(201).json({ count: ids.length, ids: ids });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create tasks' }); }
});

// SUBTASK toggle (assignee or manager) — declared before /:id routes
router.patch('/subtasks/:sid', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT s.*, t.assigned_to, t.created_by FROM task_subtasks s JOIN tasks t ON s.task_id = t.id WHERE s.id = $1', [req.params.sid]);
    if (!rows.length) return res.status(404).json({ error: 'Subtask not found' });
    if (!(await canChangeStatus(req, rows[0]))) return res.status(403).json({ error: 'Forbidden' });
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
    if (!(await canSee(req, task))) return res.status(403).json({ error: 'Forbidden' });
    res.json(task);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load task' }); }
});

// UPDATE (managers/admin)
router.put('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  try {
    const b = req.body || {};
    const ex = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Task not found' });
    if (!(await canEdit(req, ex))) return res.status(403).json({ error: 'Forbidden' });
    const title = (b.title || ex.title || '').trim();
    const status = STATUSES.indexOf(b.status) !== -1 ? b.status : ex.status;
    const priority = PRIORITIES.indexOf(b.priority) !== -1 ? b.priority : ex.priority;
    const recurrence = RECUR.indexOf(b.recurrence) !== -1 ? (b.recurrence || null) : ex.recurrence;
    const recDay = (recurrence === 'weekly' || recurrence === 'monthly') ? (b.recurrence_day !== undefined ? (b.recurrence_day === '' || b.recurrence_day == null ? null : parseInt(b.recurrence_day, 10)) : ex.recurrence_day) : null;
    const assigned_to = b.assigned_to !== undefined ? (b.assigned_to ? parseInt(b.assigned_to, 10) : null) : ex.assigned_to;
    const due_date = b.due_date !== undefined ? (b.due_date || null) : ex.due_date;
    const description = b.description !== undefined ? b.description : ex.description;
    const dueChanged = String(due_date) !== String(ex.due_date);
    const assigneeChanged = (assigned_to || null) !== (ex.assigned_to || null);
    await pool.query(
      'UPDATE tasks SET title=$1, description=$2, status=$3, priority=$4, assigned_to=$5, due_date=$6, recurrence=$7, recurrence_day=$8, ' +
      (dueChanged ? 'reminded_day_before=false, reminded_due=false, last_overdue_on=NULL, ' : '') +
      'updated_at=NOW() WHERE id=$9',
      [title, description, status, priority, assigned_to, due_date, recurrence, recDay, req.params.id]
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
    if (!(await canChangeStatus(req, ex))) return res.status(403).json({ error: 'Forbidden' });
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

function nextRecurDue(task) {
  const base = task.due_date ? new Date(task.due_date) : new Date();
  if (task.recurrence === 'weekly') {
    const target = (task.recurrence_day != null) ? task.recurrence_day : base.getUTCDay();
    const x = new Date(base.getTime()); x.setUTCDate(x.getUTCDate() + 1);
    while (x.getUTCDay() !== target) x.setUTCDate(x.getUTCDate() + 1);
    return x;
  }
  if (task.recurrence === 'monthly') {
    const y = base.getUTCFullYear(), m = base.getUTCMonth();
    const ny = y + Math.floor((m + 1) / 12), nm = (m + 1) % 12;
    const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    const day = Math.min((task.recurrence_day != null ? task.recurrence_day : base.getUTCDate()), lastDay);
    return new Date(Date.UTC(ny, nm, day));
  }
  const x = new Date(base.getTime()); x.setUTCDate(x.getUTCDate() + 1); return x;
}
async function spawnRecurrence(task, user) {
  const ndStr = nextRecurDue(task).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7,$8) RETURNING id",
    [task.title, task.description, task.priority, task.assigned_to, task.created_by, ndStr, task.recurrence, task.recurrence_day]
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
    if (!(await canSee(req, ex))) return res.status(403).json({ error: 'Forbidden' });
    await addActivity(req.params.id, req.user, 'comment', body);
    res.status(201).json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add comment' }); }
});

// DELETE (managers/admin)
router.delete('/:id', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  const _t = (await pool.query('SELECT assigned_to, created_by FROM tasks WHERE id = $1', [req.params.id])).rows[0];
  if (_t && !(await canEdit(req, _t))) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  try { await logAudit({ entity_type: 'task', entity_id: parseInt(req.params.id), entity_number: '#' + req.params.id, action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
  res.json({ success: true });
});

module.exports = router;
