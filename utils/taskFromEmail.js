const { pool } = require('../db');
const { logAudit } = require('./audit');
const { notifyTaskAssigned } = require('../jobs/taskReminders');

// Pull a bare email address out of a "Name <addr@x.com>" header.
function emailFromHeader(s) {
  s = String(s || '');
  var m = s.match(/<([^>]+)>/);
  var addr = m ? m[1] : s;
  return addr.trim().toLowerCase();
}

async function findUserByEmail(email) {
  if (!email) return null;
  const { rows } = await pool.query(
    'SELECT id, name, email, role FROM users WHERE lower(email) = lower($1) LIMIT 1',
    [String(email).trim()]
  );
  return rows.length ? rows[0] : null;
}

// Resolve free-text ("Mike", "mike@x.com", "Mike Yonkman") to a user row, or null.
async function resolveAssignee(text) {
  if (!text) return null;
  var t = String(text).trim();
  if (!t) return null;

  if (t.indexOf('@') !== -1) {
    var byEmail = await findUserByEmail(emailFromHeader(t));
    if (byEmail) return byEmail;
  }
  var r1 = await pool.query('SELECT id, name, email FROM users WHERE lower(name) = lower($1) LIMIT 1', [t]);
  if (r1.rows.length) return r1.rows[0];

  var r2 = await pool.query('SELECT id, name, email FROM users WHERE name ILIKE $1', ['%' + t + '%']);
  if (r2.rows.length === 1) return r2.rows[0];

  var first = t.split(/\s+/)[0];
  if (first && first !== t) {
    var r3 = await pool.query('SELECT id, name, email FROM users WHERE name ILIKE $1', [first + '%']);
    if (r3.rows.length === 1) return r3.rows[0];
  }
  return null;
}

async function addActivity(taskId, user, type, body) {
  await pool.query(
    'INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,$4,$5)',
    [taskId, user ? user.id : null, user ? user.name : null, type, body]
  );
}

// parsed = { title, description, priority, due_date, assignee }
// creatorUser = { id, name }
// explicitAssigneeId optionally overrides the AI-resolved assignee (used by the add-in dropdown).
async function createTaskFromParsed(parsed, creatorUser, source, explicitAssigneeId) {
  var assigneeUser = creatorUser;

  if (explicitAssigneeId) {
    const { rows } = await pool.query('SELECT id, name FROM users WHERE id = $1', [parseInt(explicitAssigneeId, 10)]);
    if (rows.length) assigneeUser = rows[0];
  } else if (parsed.assignee) {
    var matched = await resolveAssignee(parsed.assignee);
    if (matched) assigneeUser = matched;
  }

  const { rows } = await pool.query(
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, source) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,$6,$7) RETURNING *",
    [parsed.title, parsed.description || null, parsed.priority, assigneeUser.id, creatorUser.id, parsed.due_date || null, source || 'email']
  );
  const task = rows[0];

  await addActivity(task.id, creatorUser, 'event', 'created this task from ' + (source === 'outlook_addin' ? 'Outlook' : 'a forwarded email'));
  if (assigneeUser.id) await addActivity(task.id, creatorUser, 'event', 'assigned it to ' + assigneeUser.name);
  try {
    await logAudit({ entity_type: 'task', entity_id: task.id, entity_number: '#' + task.id, action: 'created', user_id: creatorUser.id, user_name: creatorUser.name, details: { title: parsed.title, source: source || 'email' } });
  } catch (e) {}
  if (assigneeUser.id) { try { await notifyTaskAssigned(task.id); } catch (e) {} }

  return { task: task, assignee: assigneeUser };
}

module.exports = { emailFromHeader, findUserByEmail, resolveAssignee, createTaskFromParsed };
