const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const perms = require('../utils/permissions');
const { logAudit } = require('../utils/audit');
const { notifyTaskAssigned, notifyTaskCc, notifyTaskCcInfo, notifyTaskCcDone } = require('../jobs/taskReminders');
const { spawnFromTemplate, recurNextStart, recurYmd, recurFromYmd } = require('../jobs/taskReminders');
const { resolveDateTokens } = require('../utils/messageTokens');

const router = express.Router();

const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const RECUR = ['', 'daily', 'weekly', 'monthly'];
const STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
function etTodayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
// Insert one subtask from either a string or a {title, assigned_to} object. assigned_to only honored when manage=true.
async function insertSubtask(taskId, st, position, manage) {
  const title = (typeof st === 'string' ? st : (st && st.title) || '').trim();
  if (!title) return;
  let aid = null;
  if (manage && st && typeof st === 'object' && st.assigned_to != null && st.assigned_to !== '') {
    aid = parseInt(st.assigned_to, 10);
    if (isNaN(aid)) aid = null;
  }
  await pool.query('INSERT INTO task_subtasks (task_id, title, position, assigned_to) VALUES ($1,$2,$3,$4)', [taskId, title.slice(0, 500), position, aid]);
}
// Create a recurring schedule (hidden template). The daily spawner sends a real task on each send day.
async function createRecurringTemplate(b, o, user) {
  const startDay = (o.recStartDay != null) ? o.recStartDay : o.recDay;
  const nextStr = recurYmd(recurNextStart(o.recurrence, startDay, recurFromYmd(etTodayStr())));
  const rtSecondary = b.secondary_assignee_id ? parseInt(b.secondary_assignee_id, 10) : null;
  const rtAssignedBy = o.assigned_to ? o.created_by : null;
  const rtDueLocked = (o.assigned_to && o.assigned_to !== o.created_by) ? await computeDueLock(o.created_by, o.assigned_to) : false;
  const { rows } = await pool.query(
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day, recurrence_start_day, is_template, next_run_on, secondary_assignee_id, assigned_by, due_locked) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,NULL,$6,$7,$8,true,$9,$10,$11,$12) RETURNING *",
    [o.title, o.description, o.priority, o.assigned_to, o.created_by, o.recurrence, o.recDay, startDay, nextStr, rtSecondary, rtAssignedBy, rtDueLocked]
  );
  const tpl = rows[0];
  if (Array.isArray(b.subtasks)) {
    for (let i = 0; i < b.subtasks.length; i++) await insertSubtask(tpl.id, b.subtasks[i], i, !!o.manage);
  }
  await saveCc(tpl.id, b.cc, false);
  await saveAttachments(tpl.id, b.attachments, user);
  if (nextStr <= etTodayStr()) { try { await spawnFromTemplate(tpl.id); } catch (e) { console.error('first send failed:', e.message); } }
  return tpl;
}

async function nameOf(id) {
  if (!id) return 'someone';
  const { rows } = await pool.query('SELECT name FROM users WHERE id = $1', [id]);
  return rows.length ? rows[0].name : 'someone';
}
// True if managerId sits anywhere up employeeId's supervisor_id chain.
async function isUpline(managerId, employeeId) {
  if (!managerId || !employeeId || managerId === employeeId) return false;
  let cur = employeeId, guard = 0;
  while (cur && guard++ < 20) {
    const r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [cur]);
    const sup = r.rows.length ? r.rows[0].supervisor_id : null;
    if (!sup) return false;
    if (sup === managerId) return true;
    cur = sup;
  }
  return false;
}
// Lock the due date when the assigner is up the assignee's reporting line.
async function computeDueLock(assignerId, assigneeId) {
  if (!assigneeId || !assignerId || assignerId === assigneeId) return false;
  return await isUpline(assignerId, assigneeId);
}
// Admins/owner, the assigner, and anyone upline of the assignee may move a locked due date.
async function canEditDue(req, task) {
  if (!task.due_locked) return true;
  if (req.user.role === 'admin' || req.user.role === 'owner') return true;
  if (task.assigned_by && task.assigned_by === req.user.id) return true;
  if (task.assigned_to && await isUpline(req.user.id, task.assigned_to)) return true;
  return false;
}
// True if viewerId is assigneeId's default backup AND assigneeId is on approved PTO today (ET).
async function isActiveBackupFor(viewerId, assigneeId) {
  if (!viewerId || !assigneeId) return false;
  const r = await pool.query(
    "SELECT 1 FROM users u JOIN pto_requests p ON p.user_id = u.id " +
    "WHERE u.id = $2 AND u.default_backup_id = $1 AND p.status = 'approved' " +
    "AND $3::date BETWEEN p.start_date AND p.end_date LIMIT 1",
    [viewerId, assigneeId, etTodayStr()]);
  return r.rows.length > 0;
}
async function addActivity(taskId, user, type, body) {
  await pool.query(
    'INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)',
    [taskId, user ? user.id : null, user ? user.name : null, type, body]
  );
}
const ATT_MAX = 50 * 1024 * 1024; // 50 MB per file
function stripDataUrl(v) { return String(v == null ? '' : v).replace(/^data:[^;]+;base64,/, ''); }
async function saveAttachments(taskId, list, user) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const a of list) {
    if (!a) continue;
    const data = stripDataUrl(a.data || a.image_data || '');
    if (!data) continue;
    const size = parseInt(a.size_bytes, 10) || Math.round(data.length * 0.75);
    if (size > ATT_MAX) continue;
    await pool.query(
      'INSERT INTO task_attachments (task_id, filename, mime_type, image_data, size_bytes, uploaded_by, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [taskId, String(a.filename || 'file').slice(0, 255), String(a.mime_type || a.mime || 'application/octet-stream').slice(0, 100), data, size, user ? user.id : null, user ? user.name : null]
    );
    n++;
  }
  return n;
}
async function saveCc(taskId, ids, replace) {
  if (!Array.isArray(ids)) return;
  const clean = Array.from(new Set(ids.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); })));
  if (replace) await pool.query('DELETE FROM task_cc WHERE task_id = $1', [taskId]);
  for (const uid of clean) await pool.query('INSERT INTO task_cc (task_id, user_id) VALUES ($1,$2) ON CONFLICT (task_id, user_id) DO NOTHING', [taskId, uid]);
}
async function loadTask(id) {
  const { rows } = await pool.query(
    'SELECT t.*, a.name AS assignee_name, c.name AS creator_name, sec.name AS secondary_name, ab.name AS assigned_by_name ' +
    'FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id LEFT JOIN users c ON t.created_by = c.id ' +
    'LEFT JOIN users sec ON t.secondary_assignee_id = sec.id LEFT JOIN users ab ON t.assigned_by = ab.id WHERE t.id = $1',
    [id]
  );
  if (!rows.length) return null;
  const task = rows[0];
  const { rows: subs } = await pool.query('SELECT s.*, u.name AS assignee_name FROM task_subtasks s LEFT JOIN users u ON s.assigned_to = u.id WHERE s.task_id = $1 ORDER BY s.position, s.id', [id]);
  const { rows: acts } = await pool.query('SELECT * FROM task_activity WHERE task_id = $1 ORDER BY created_at ASC, id ASC', [id]);
  task.subtasks = subs;
  task.activity = acts;
  const { rows: atts } = await pool.query('SELECT id, filename, mime_type, size_bytes, uploaded_by_name, created_at FROM task_attachments WHERE task_id = $1 ORDER BY id', [id]);
  const { rows: ccs } = await pool.query('SELECT c.user_id, u.name FROM task_cc c LEFT JOIN users u ON c.user_id = u.id WHERE c.task_id = $1 ORDER BY u.name', [id]);
  task.attachments = atts;
  task.cc = ccs.map(function (r) { return { user_id: r.user_id, name: r.name }; });
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
  if (task.secondary_assignee_id === req.user.id) return true;
  if (await isActiveBackupFor(req.user.id, task.assigned_to)) return true;
  return canEdit(req, task);
}

// LIST — managers see all; everyone else sees tasks assigned to them.
router.get('/', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    const audit = req.user.role === 'admin';
    const view = req.query.view === 'assigned' ? 'assigned' : (req.query.view === 'recurring' ? 'recurring' : 'mine');
    const params = [];
    let where = '';
    if (view === 'recurring') {
      if (!manage) return res.json([]);
      if (audit) { where = 'WHERE t.is_template = true'; }
      else { params.push(req.user.id); where = 'WHERE t.is_template = true AND t.created_by = $1'; }
    } else if (view === 'assigned') {
      if (!manage) return res.json([]);
      if (audit) {
        // Admin/owner oversight of all delegated/unassigned tasks (personal stays private).
        where = 'WHERE NOT t.is_template AND NOT (t.assigned_to IS NOT NULL AND (t.created_by IS NULL OR t.assigned_to = t.created_by))';
      } else {
        params.push(req.user.id); where = 'WHERE NOT t.is_template AND t.created_by = $1 AND (t.assigned_to IS NULL OR t.assigned_to <> $1)';
      }
    } else {
      where = 'WHERE NOT t.is_template AND ( t.assigned_to = $1 OR t.secondary_assignee_id = $1 ' +
        "OR EXISTS (SELECT 1 FROM users u JOIN pto_requests p ON p.user_id = u.id " +
        "WHERE u.id = t.assigned_to AND u.default_backup_id = $1 AND p.status = 'approved' " +
        "AND $2::date BETWEEN p.start_date AND p.end_date) )";
      params.push(req.user.id); params.push(etTodayStr());
    }
    const { rows } = await pool.query(
      'SELECT t.*, a.name AS assignee_name, c.name AS creator_name, sec.name AS secondary_name, ' +
      '(SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id) AS subtask_total, ' +
      '(SELECT COUNT(*) FROM task_subtasks s WHERE s.task_id = t.id AND s.done) AS subtask_done ' +
      'FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id LEFT JOIN users c ON t.created_by = c.id ' +
      'LEFT JOIN users sec ON t.secondary_assignee_id = sec.id ' +
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
      "FROM tasks WHERE NOT is_template AND ( assigned_to = $1 OR secondary_assignee_id = $1 " +
      "OR EXISTS (SELECT 1 FROM users u JOIN pto_requests p ON p.user_id = u.id " +
      "WHERE u.id = tasks.assigned_to AND u.default_backup_id = $1 AND p.status = 'approved' " +
      "AND $2::date BETWEEN p.start_date AND p.end_date) )", [uid, etTodayStr()]);
    let assigned_open = 0, assigned_overdue = 0;
    if (manage) {
      let where = '', params = [];
      if (audit) {
        where = 'WHERE NOT is_template AND NOT (assigned_to IS NOT NULL AND (created_by IS NULL OR assigned_to = created_by))';
      } else { params.push(uid); where = 'WHERE NOT is_template AND created_by = $1 AND (assigned_to IS NULL OR assigned_to <> $1)'; }
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
    const recStartDay = (recurrence === 'weekly' || recurrence === 'monthly') && b.recurrence_start_day != null && b.recurrence_start_day !== '' ? parseInt(b.recurrence_start_day, 10) : null;
    let assigned_to = b.assigned_to ? parseInt(b.assigned_to, 10) : null;
    if (!manage) {
      if (assigned_to && assigned_to !== req.user.id) return res.status(403).json({ error: 'You can only create tasks for yourself.' });
      assigned_to = req.user.id;
    }
    if (recurrence) {
      const tpl = await createRecurringTemplate(b, { title: title, description: b.description || null, priority: priority, assigned_to: assigned_to, created_by: req.user.id, recurrence: recurrence, recDay: recDay, recStartDay: recStartDay, manage: manage }, req.user);
      await addActivity(tpl.id, req.user, 'event', 'created this recurring schedule');
      try { await logAudit({ entity_type: 'task', entity_id: tpl.id, entity_number: '#' + tpl.id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { title: title, recurring: true } }); } catch (e) {}
      return res.status(201).json(await loadTask(tpl.id));
    }
    const due_date = b.due_date || null;
    const rTitle = resolveDateTokens(title);
    const rDesc = b.description ? resolveDateTokens(b.description) : null;
    const secondary_assignee_id = b.secondary_assignee_id ? parseInt(b.secondary_assignee_id, 10) : null;
    const assigned_by = assigned_to ? req.user.id : null;
    const due_locked = (assigned_to && assigned_to !== req.user.id) ? await computeDueLock(req.user.id, assigned_to) : false;
    const { rows } = await pool.query(
      'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day, secondary_assignee_id, assigned_by, due_locked) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [rTitle, rDesc, status, priority, assigned_to, req.user.id, due_date, recurrence, recDay, secondary_assignee_id, assigned_by, due_locked]
    );
    const task = rows[0];
    if (Array.isArray(b.subtasks)) {
      for (let i = 0; i < b.subtasks.length; i++) await insertSubtask(task.id, b.subtasks[i], i, manage);
    }
    await addActivity(task.id, req.user, 'event', 'created this task');
    if (assigned_to) await addActivity(task.id, req.user, 'event', 'assigned it to ' + (await nameOf(assigned_to)));
    if (secondary_assignee_id) await addActivity(task.id, req.user, 'event', 'added ' + (await nameOf(secondary_assignee_id)) + ' as secondary');
    try { await logAudit({ entity_type: 'task', entity_id: task.id, entity_number: '#' + task.id, action: 'created', user_id: req.user.id, user_name: req.user.name, details: { title: title } }); } catch (e) {}
    await saveCc(task.id, b.cc, false);
    await saveAttachments(task.id, b.attachments, req.user);
    if (assigned_to) { try { await notifyTaskAssigned(task.id); } catch (e) {} }
    try { await notifyTaskCc(task.id); } catch (e) {}
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
    const recStartDay = (recurrence === 'weekly' || recurrence === 'monthly') && b.recurrence_start_day != null && b.recurrence_start_day !== '' ? parseInt(b.recurrence_start_day, 10) : null;
    const due_date = b.due_date || null;
    const rTitle = recurrence ? title : resolveDateTokens(title);
    const rDesc = b.description ? (recurrence ? b.description : resolveDateTokens(b.description)) : null;
    const subs = Array.isArray(b.subtasks) ? b.subtasks : [];
    let assignees = Array.isArray(b.assignees) ? b.assignees.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : [];
    if (!assignees.length) assignees = [null];
    const ids = [];
    const assigneeNames = [];
    for (let a = 0; a < assignees.length; a++) {
      const aid = assignees[a];
      if (recurrence) {
        const tpl = await createRecurringTemplate(b, { title: title, description: b.description || null, priority: priority, assigned_to: aid, created_by: req.user.id, recurrence: recurrence, recDay: recDay, recStartDay: recStartDay, manage: true }, req.user);
        ids.push(tpl.id);
        await addActivity(tpl.id, req.user, 'event', 'created this recurring schedule');
        if (aid) assigneeNames.push(await nameOf(aid));
        continue;
      }
      const bSecondary = b.secondary_assignee_id ? parseInt(b.secondary_assignee_id, 10) : null;
      const bAssignedBy = aid ? req.user.id : null;
      const bDueLocked = (aid && aid !== req.user.id) ? await computeDueLock(req.user.id, aid) : false;
      const { rows } = await pool.query(
        'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day, secondary_assignee_id, assigned_by, due_locked) ' +
        "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
        [rTitle, rDesc, priority, aid, req.user.id, due_date, recurrence, recDay, bSecondary, bAssignedBy, bDueLocked]
      );
      const id = rows[0].id;
      ids.push(id);
      for (let i = 0; i < subs.length; i++) await insertSubtask(id, subs[i], i, true);
      await saveCc(id, b.cc, false);
      await saveAttachments(id, b.attachments, req.user);
      await addActivity(id, req.user, 'event', 'created this task');
      if (aid) { assigneeNames.push(await nameOf(aid)); await addActivity(id, req.user, 'event', 'assigned it to ' + (await nameOf(aid))); try { await notifyTaskAssigned(id); } catch (e) {} }
    }
    try {
      const ccIds = Array.isArray(b.cc) ? b.cc.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : [];
      if (ccIds.length && !recurrence) await notifyTaskCcInfo(ccIds, { title: title, description: b.description || null, priority: priority, due_date: due_date, assignees: assigneeNames, attCount: Array.isArray(b.attachments) ? b.attachments.length : 0 });
    } catch (e) {}
    try { await logAudit({ entity_type: 'task', entity_id: ids[0], entity_number: '#' + ids[0], action: 'created', user_id: req.user.id, user_name: req.user.name, details: { title: title, count: ids.length } }); } catch (e) {}
    res.status(201).json({ count: ids.length, ids: ids });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to create tasks' }); }
});

// SUBTASK toggle (assignee or manager) — declared before /:id routes
router.patch('/subtasks/:sid', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT s.assigned_to AS sub_assignee, t.assigned_to, t.created_by FROM task_subtasks s JOIN tasks t ON s.task_id = t.id WHERE s.id = $1', [req.params.sid]);
    if (!rows.length) return res.status(404).json({ error: 'Subtask not found' });
    const subOwn = rows[0].sub_assignee && rows[0].sub_assignee === req.user.id;
    if (!subOwn && !(await canChangeStatus(req, rows[0]))) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('UPDATE task_subtasks SET done = $1 WHERE id = $2', [!!(req.body && req.body.done), req.params.sid]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update subtask' }); }
});
router.delete('/subtasks/:sid', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  await pool.query('DELETE FROM task_subtasks WHERE id = $1', [req.params.sid]);
  res.json({ success: true });
});
// Assign a subtask to a person (task manager or task creator)
router.patch('/subtasks/:sid/assignee', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT s.id, t.created_by FROM task_subtasks s JOIN tasks t ON s.task_id = t.id WHERE s.id = $1', [req.params.sid]);
    if (!rows.length) return res.status(404).json({ error: 'Subtask not found' });
    const manage = await perms.hasPermission(req.user.role, 'manage_tasks');
    if (!manage && rows[0].created_by !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    let aid = (req.body && req.body.assigned_to != null && req.body.assigned_to !== '') ? parseInt(req.body.assigned_to, 10) : null;
    if (isNaN(aid)) aid = null;
    await pool.query('UPDATE task_subtasks SET assigned_to = $1 WHERE id = $2', [aid, req.params.sid]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update subtask' }); }
});

// GET raw attachment data (anyone who can see the task)
router.get('/:id/attachments/:aid', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canSee(req, task))) return res.status(403).json({ error: 'Forbidden' });
    const { rows } = await pool.query('SELECT filename, mime_type, image_data FROM task_attachments WHERE id = $1 AND task_id = $2', [req.params.aid, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Attachment not found' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to load attachment' }); }
});
// ADD attachments to an existing task (anyone who can see it)
router.post('/:id/attachments', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await canSee(req, task))) return res.status(403).json({ error: 'Forbidden' });
    const list = Array.isArray(req.body && req.body.attachments) ? req.body.attachments : (req.body ? [req.body] : []);
    const n = await saveAttachments(req.params.id, list, req.user);
    if (n) await addActivity(req.params.id, req.user, 'event', 'added ' + n + ' attachment' + (n === 1 ? '' : 's'));
    res.status(201).json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to add attachment' }); }
});
// DELETE an attachment (creator/manager, or the uploader)
router.delete('/:id/attachments/:aid', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const task = await loadTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const att = (await pool.query('SELECT uploaded_by FROM task_attachments WHERE id = $1 AND task_id = $2', [req.params.aid, req.params.id])).rows[0];
    if (!att) return res.status(404).json({ error: 'Attachment not found' });
    const mayDelete = (att.uploaded_by === req.user.id) || (await canEdit(req, task));
    if (!mayDelete) return res.status(403).json({ error: 'Forbidden' });
    await pool.query('DELETE FROM task_attachments WHERE id = $1 AND task_id = $2', [req.params.aid, req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to delete attachment' }); }
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
    const recStartDay = (recurrence === 'weekly' || recurrence === 'monthly') ? (b.recurrence_start_day !== undefined ? (b.recurrence_start_day === '' || b.recurrence_start_day == null ? null : parseInt(b.recurrence_start_day, 10)) : ex.recurrence_start_day) : null;
    const assigned_to = b.assigned_to !== undefined ? (b.assigned_to ? parseInt(b.assigned_to, 10) : null) : ex.assigned_to;
    const due_date = b.due_date !== undefined ? (b.due_date || null) : ex.due_date;
    const description = b.description !== undefined ? b.description : ex.description;
    const secondary_assignee_id = b.secondary_assignee_id !== undefined ? (b.secondary_assignee_id ? parseInt(b.secondary_assignee_id, 10) : null) : ex.secondary_assignee_id;
    const assigneeChgd = (assigned_to || null) !== (ex.assigned_to || null);
    const newAssignedBy = assigneeChgd ? (assigned_to ? req.user.id : null) : ex.assigned_by;
    const newDueLocked = assigneeChgd ? ((assigned_to && assigned_to !== req.user.id) ? await computeDueLock(req.user.id, assigned_to) : false) : ex.due_locked;
    if (ex.is_template) {
      const startDay = (recStartDay != null) ? recStartDay : recDay;
      if (recurrence) {
        const nextStr = recurYmd(recurNextStart(recurrence, startDay, recurFromYmd(etTodayStr())));
        await pool.query('UPDATE tasks SET title=$1, description=$2, priority=$3, assigned_to=$4, recurrence=$5, recurrence_day=$6, recurrence_start_day=$7, next_run_on=$8, secondary_assignee_id=$9, assigned_by=$10, due_locked=$11, updated_at=NOW() WHERE id=$12',
          [title, description, priority, assigned_to, recurrence, recDay, startDay, nextStr, secondary_assignee_id, newAssignedBy, newDueLocked, req.params.id]);
      } else {
        await pool.query('UPDATE tasks SET title=$1, description=$2, priority=$3, assigned_to=$4, recurrence=NULL, recurrence_day=NULL, recurrence_start_day=NULL, next_run_on=NULL, is_template=false, due_date=$5, secondary_assignee_id=$6, assigned_by=$7, due_locked=$8, updated_at=NOW() WHERE id=$9',
          [title, description, priority, assigned_to, due_date, secondary_assignee_id, newAssignedBy, newDueLocked, req.params.id]);
      }
      if (b.cc !== undefined) await saveCc(req.params.id, b.cc, true);
      try { await logAudit({ entity_type: 'task', entity_id: parseInt(req.params.id), entity_number: '#' + req.params.id, action: 'edited', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
      return res.json(await loadTask(req.params.id));
    }
    const dueChanged = String(due_date) !== String(ex.due_date);
    const assigneeChanged = (assigned_to || null) !== (ex.assigned_to || null);
    if (dueChanged && !(await canEditDue(req, ex))) {
      return res.status(403).json({ error: 'This due date was set by a higher-level assigner and is locked.' });
    }
    if (status === 'done' && ex.status !== 'done' && ex.require_due_to_close && !due_date) {
      return res.status(400).json({ error: 'Set a due date before closing this task.' });
    }
    const secondaryChanged = (secondary_assignee_id || null) !== (ex.secondary_assignee_id || null);
    await pool.query(
      'UPDATE tasks SET title=$1, description=$2, status=$3, priority=$4, assigned_to=$5, due_date=$6, recurrence=$7, recurrence_day=$8, secondary_assignee_id=$9, assigned_by=$10, due_locked=$11, ' +
      (dueChanged ? 'reminded_day_before=false, reminded_due=false, last_overdue_on=NULL, ' : '') +
      'updated_at=NOW() WHERE id=$12',
      [title, description, status, priority, assigned_to, due_date, recurrence, recDay, secondary_assignee_id, newAssignedBy, newDueLocked, req.params.id]
    );
    if (assigneeChanged) await addActivity(req.params.id, req.user, 'event', assigned_to ? ('reassigned it to ' + (await nameOf(assigned_to))) : 'unassigned it');
    if (secondaryChanged) await addActivity(req.params.id, req.user, 'event', secondary_assignee_id ? ('set ' + (await nameOf(secondary_assignee_id)) + ' as secondary') : 'removed the secondary');
    try { await logAudit({ entity_type: 'task', entity_id: parseInt(req.params.id), entity_number: '#' + req.params.id, action: 'edited', user_id: req.user.id, user_name: req.user.name, details: {} }); } catch (e) {}
    if (b.cc !== undefined) await saveCc(req.params.id, b.cc, true);
    if (assigneeChanged && assigned_to) { try { await notifyTaskAssigned(req.params.id); } catch (e) {} }
    if (status === 'done' && ex.status !== 'done') { try { await notifyTaskCcDone(req.params.id, req.user.name); } catch (e) {} }
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
    if (status === 'done' && ex.status !== 'done' && ex.require_due_to_close && !ex.due_date) {
      return res.status(400).json({ error: 'Set a due date before closing this task.' });
    }
    if (status === 'done' && ex.status !== 'done') {
      await pool.query("UPDATE tasks SET status='done', completed_at=NOW(), completed_by=$1, updated_at=NOW() WHERE id=$2", [req.user.id, req.params.id]);
      await addActivity(req.params.id, req.user, 'event', 'marked it done');
      try { await notifyTaskCcDone(req.params.id, req.user.name); } catch (e) {}
      if (ex.recurrence && !ex.is_template) await spawnRecurrence(ex, req.user);
    } else {
      await pool.query('UPDATE tasks SET status=$1, completed_at=NULL, completed_by=NULL, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
      await addActivity(req.params.id, req.user, 'event', 'moved it to ' + (STATUS_LABEL[status] || status));
    }
    res.json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to update status' }); }
});

// SET secondary assignee — narrow endpoint so the assignee (or creator/manager) can add a
// co-owner without opening the manager-only edit form. Primary stays responsible.
router.patch('/:id/secondary', requireAuth, requirePermission('view_tasks'), async (req, res) => {
  try {
    const ex = (await pool.query('SELECT * FROM tasks WHERE id = $1', [req.params.id])).rows[0];
    if (!ex) return res.status(404).json({ error: 'Task not found' });
    const allowed = (ex.assigned_to === req.user.id) || (await canEdit(req, ex));
    if (!allowed) return res.status(403).json({ error: 'Forbidden' });
    let sid = req.body && req.body.secondary_assignee_id;
    sid = sid ? parseInt(sid, 10) : null;
    if (sid && isNaN(sid)) sid = null;
    if (sid) {
      const u = (await pool.query('SELECT id FROM users WHERE id = $1', [sid])).rows[0];
      if (!u) return res.status(400).json({ error: 'Unknown user' });
    }
    const changed = (sid || null) !== (ex.secondary_assignee_id || null);
    await pool.query('UPDATE tasks SET secondary_assignee_id = $1, updated_at = NOW() WHERE id = $2', [sid, req.params.id]);
    if (changed) await addActivity(req.params.id, req.user, 'event', sid ? ('set ' + (await nameOf(sid)) + ' as secondary') : 'removed the secondary');
    res.json(await loadTask(req.params.id));
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to set secondary' }); }
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
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day, secondary_assignee_id, assigned_by, due_locked) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
    [task.title, task.description, task.priority, task.assigned_to, task.created_by, ndStr, task.recurrence, task.recurrence_day, task.secondary_assignee_id, task.assigned_by, task.due_locked]
  );
  const newId = rows[0].id;
  const { rows: subs } = await pool.query('SELECT title, position, assigned_to FROM task_subtasks WHERE task_id = $1 ORDER BY position, id', [task.id]);
  for (let i = 0; i < subs.length; i++) await pool.query('INSERT INTO task_subtasks (task_id, title, position, assigned_to) VALUES ($1,$2,$3,$4)', [newId, subs[i].title, subs[i].position, subs[i].assigned_to]);
  await addActivity(newId, user, 'event', 'auto-created from recurring task #' + task.id);
}

// SUBTASK add (managers/admin)
router.post('/:id/subtasks', requireAuth, requirePermission('manage_tasks'), async (req, res) => {
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Subtask title required' });
  const { rows: mx } = await pool.query('SELECT COALESCE(MAX(position),-1)+1 AS p FROM task_subtasks WHERE task_id = $1', [req.params.id]);
  let aid = (req.body && req.body.assigned_to != null && req.body.assigned_to !== '') ? parseInt(req.body.assigned_to, 10) : null;
  if (isNaN(aid)) aid = null;
  const { rows } = await pool.query('INSERT INTO task_subtasks (task_id, title, position, assigned_to) VALUES ($1,$2,$3,$4) RETURNING *', [req.params.id, title, mx[0].p, aid]);
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
