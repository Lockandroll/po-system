const cron = require('node-cron');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { sendEmail, emailTemplate } = require('../utils/email');
const push = require('../utils/push');
const { resolveDateTokens } = require('../utils/messageTokens');

const TZ = 'America/New_York';
const APP = (process.env.APP_URL || '').replace(/\/$/, '');

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch (e) { return String(d); }
}
function etDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function calDateStr(d) {
  // Calendar date of a DATE value (stored at UTC midnight).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
}

async function getChannels(key) {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'notification_rules'");
    if (rows.length && rows[0].value) {
      const r = JSON.parse(rows[0].value);
      if (r && r[key]) return { email: r[key].email !== false, sms: r[key].sms !== false };
    }
  } catch (e) {}
  return { email: true, sms: true };
}
async function deliver(user, sms, subject, html, ch) {
  ch = ch || { email: true, sms: true };
  if (ch.sms && user.phone) { try { await sendSms([user.phone], sms); } catch (e) { console.error('[tasks] sms failed:', e.message); } }
  if (ch.email && user.email) { try { await sendEmail(user.email, subject, html); } catch (e) { console.error('[tasks] email failed:', e.message); } }
}

function taskEmail(t, line, attCount) {
  const att = attCount ? '<br>Attachments: ' + attCount + ' file' + (attCount === 1 ? '' : 's') + ' \u2014 view them in Nova.' : '';
  return emailTemplate({
    badge: 'Task reminder', badgeColor: 'orange',
    title: t.title,
    body: (line ? line + '<br><br>' : '') + (t.description ? t.description + '<br><br>' : '') +
      'Priority: ' + t.priority + (t.due_date ? '<br>Due: ' + fmtDate(t.due_date) : '') + att,
    buttonText: 'View Task', buttonUrl: APP + '/?view=tasks',
    footerNote: 'Automated task notification from Nova.'
  });
}

// Immediate notification when a task is assigned/reassigned.
async function notifyTaskAssigned(taskId) {
  const { rows } = await pool.query(
    'SELECT t.*, u.name AS assignee_name, u.phone, u.email FROM tasks t JOIN users u ON t.assigned_to = u.id WHERE t.id = $1',
    [taskId]
  );
  if (!rows.length) return;
  const t = rows[0];
  const due = t.due_date ? ' (due ' + fmtDate(t.due_date) + ')' : '';
  const sms = 'New task assigned to you: ' + t.title + due + '. Open Nova to view it.';
  const ch = await getChannels('task_assigned');
  const attCount = (await pool.query('SELECT COUNT(*)::int AS n FROM task_attachments WHERE task_id = $1', [taskId])).rows[0].n;
  await deliver(t, sms, 'New task: ' + t.title, taskEmail(t, 'You have been assigned a new task.', attCount), ch);
  await push.sendPushToUsers([t.assigned_to], { title: 'New task', body: t.title + due, url: '/' });
}

// FYI email to people copied on a task (awareness only \u2014 no task, no SMS, no push).
async function ccEmails(userIds) {
  if (!userIds || !userIds.length) return [];
  const { rows } = await pool.query('SELECT email FROM users WHERE id = ANY($1::int[]) AND active = true AND receive_emails <> false AND email IS NOT NULL', [userIds]);
  return rows.map(function (r) { return r.email; }).filter(Boolean);
}
async function notifyTaskCc(taskId) {
  const t = (await pool.query('SELECT t.*, a.name AS assignee_name FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id WHERE t.id = $1', [taskId])).rows[0];
  if (!t) return;
  const ids = (await pool.query('SELECT user_id FROM task_cc WHERE task_id = $1', [taskId])).rows.map(function (r) { return r.user_id; });
  const emails = await ccEmails(ids);
  if (!emails.length) return;
  const attCount = (await pool.query('SELECT COUNT(*)::int AS n FROM task_attachments WHERE task_id = $1', [taskId])).rows[0].n;
  if (!(await getChannels('task_cc_created')).email) return;
  const line = 'You have been copied on this task' + (t.assignee_name ? ' (assigned to ' + t.assignee_name + ')' : '') + ' so you are aware. No action is needed unless asked.';
  try { await sendEmail(emails, 'FYI \u2014 task: ' + t.title, taskEmail(t, line, attCount)); } catch (e) { console.error('[tasks] cc email failed:', e.message); }
}
// Bulk variant: one summary FYI to the copied people for a batch of identical tasks.
async function notifyTaskCcInfo(ccUserIds, info) {
  const emails = await ccEmails(ccUserIds);
  if (!emails.length) return;
  if (!(await getChannels('task_cc_created')).email) return;
  const who = (info.assignees && info.assignees.length) ? info.assignees.join(', ') : 'the team';
  const t = { title: info.title, description: info.description, priority: info.priority, due_date: info.due_date };
  const line = 'You have been copied on a task assigned to ' + who + ' so you are aware. No action is needed unless asked.';
  try { await sendEmail(emails, 'FYI \u2014 task: ' + info.title, taskEmail(t, line, info.attCount || 0)); } catch (e) { console.error('[tasks] cc email failed:', e.message); }
}
// FYI email to the copied people when the task is closed out (moved to Done).
async function notifyTaskCcDone(taskId, closerName) {
  const t = (await pool.query('SELECT t.*, a.name AS assignee_name FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id WHERE t.id = $1', [taskId])).rows[0];
  if (!t) return;
  const ids = (await pool.query('SELECT user_id FROM task_cc WHERE task_id = $1', [taskId])).rows.map(function (r) { return r.user_id; });
  const emails = await ccEmails(ids);
  if (!emails.length) return;
  if (!(await getChannels('task_cc_done')).email) return;
  const who = closerName || t.assignee_name || 'someone';
  const line = 'This task you were copied on has been marked Done by ' + who + '. No action is needed.';
  const html = emailTemplate({
    badge: 'Task completed', badgeColor: 'green',
    title: t.title,
    body: line + '<br><br>' + (t.description ? t.description + '<br><br>' : '') +
      'Completed by: ' + who + '<br>Completed: ' + fmtDate(new Date()) + (t.due_date ? '<br>Was due: ' + fmtDate(t.due_date) : ''),
    buttonText: 'View Task', buttonUrl: APP + '/?view=tasks',
    footerNote: 'Automated task notification from Nova.'
  });
  try { await sendEmail(emails, 'Done \u2014 task: ' + t.title, html); } catch (e) { console.error('[tasks] cc done email failed:', e.message); }
}
// FYI email to the copied people the first day a task they were copied on goes overdue.
async function notifyTaskCcOverdue(taskId) {
  const t = (await pool.query('SELECT t.*, a.name AS assignee_name FROM tasks t LEFT JOIN users a ON t.assigned_to = a.id WHERE t.id = $1', [taskId])).rows[0];
  if (!t) return;
  const ids = (await pool.query('SELECT user_id FROM task_cc WHERE task_id = $1', [taskId])).rows.map(function (r) { return r.user_id; });
  const emails = await ccEmails(ids);
  if (!emails.length) return;
  if (!(await getChannels('task_cc_overdue')).email) return;
  const who = t.assignee_name || 'someone';
  const line = 'This task you were copied on is past its due date and has not been marked Done' + (t.assignee_name ? ' (assigned to ' + t.assignee_name + ')' : '') + '. No action is needed unless asked.';
  const html = emailTemplate({
    badge: 'Task overdue', badgeColor: 'red',
    title: t.title,
    body: line + '<br><br>' + (t.description ? t.description + '<br><br>' : '') +
      'Priority: ' + t.priority + '<br>Assigned to: ' + who + (t.due_date ? '<br>Was due: ' + fmtDate(t.due_date) : ''),
    buttonText: 'View Task', buttonUrl: APP + '/?view=tasks',
    footerNote: 'Automated task notification from Nova.'
  });
  try { await sendEmail(emails, 'Overdue \u2014 task: ' + t.title, html); } catch (e) { console.error('[tasks] cc overdue email failed:', e.message); }
}
// Daily-sweep companion: the first day an open task with FYI recipients is overdue,
// email them once (email-only, matching the FYI awareness rule) then flag it so it
// never repeats. Runs its own query so it also covers unassigned/orphaned tasks that
// the assignee digest (INNER JOIN on users) skips.
async function runCcOverdueNotices(todayStr) {
  try {
    const { rows } = await pool.query(
      "SELECT t.id FROM tasks t " +
      "WHERE t.status <> 'done' AND t.is_template = false AND t.due_date IS NOT NULL " +
      "AND t.due_date < $1::date AND t.cc_overdue_notified = false " +
      "AND EXISTS (SELECT 1 FROM task_cc c WHERE c.task_id = t.id)",
      [todayStr]
    );
    for (const r of rows) {
      try { await notifyTaskCcOverdue(r.id); } catch (e) { console.error('[tasks] cc overdue notify failed for', r.id, e.message); }
      await pool.query('UPDATE tasks SET cc_overdue_notified = true WHERE id = $1', [r.id]);
    }
    if (rows.length) console.log('[tasks] cc overdue notices sent for', rows.length, 'task(s)');
  } catch (err) {
    console.error('[tasks] cc overdue sweep failed:', err.message);
  }
}

// Small helpers for the daily digest.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}
function digestSection(title, color, items) {
  if (!items.length) return '';
  var rows = items.map(function (t) {
    var due = t.due_date ? fmtDate(t.due_date) : '';
    return '<tr><td style="padding:7px 0;font-size:14px;color:#111111;border-bottom:1px solid #f0f0f0">' +
      '<strong>' + esc(t.title) + '</strong>' +
      '<span style="color:#888888;font-size:12px"> — ' + esc(t.priority || 'normal') + (due ? (' · due ' + esc(due)) : '') + '</span>' +
      '</td></tr>';
  }).join('');
  return '<div style="margin:0 0 18px">' +
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:' + color + ';margin:0 0 4px">' + esc(title) + ' (' + items.length + ')</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + rows + '</table></div>';
}
function buildTaskDigestEmail(name, g) {
  var body = 'Hi ' + esc(firstName(name)) + ', here are your open tasks that need attention:<br><br>' +
    digestSection('Overdue', '#dc2626', g.overdue) +
    digestSection('Due today', '#c2520a', g.today) +
    digestSection('Due tomorrow', '#2563eb', g.tomorrow);
  return emailTemplate({
    badge: 'Task reminders', badgeColor: 'orange',
    title: 'Your task reminders',
    body: body,
    buttonText: 'View Tasks', buttonUrl: APP + '/?view=tasks',
    footerNote: 'Automated daily task summary from Nova.'
  });
}

// Daily sweep: one digest per person covering day-before, due-today, and overdue tasks.
async function runTaskReminders() {
  try {
    const now = new Date();
    const todayStr = etDateStr(now);
    const tmrwStr = etDateStr(new Date(now.getTime() + 86400000));
    const { rows } = await pool.query(
      "SELECT t.*, u.name AS assignee_name, u.phone, u.email FROM tasks t JOIN users u ON t.assigned_to = u.id " +
      "WHERE t.status <> 'done' AND t.due_date IS NOT NULL ORDER BY t.due_date ASC, t.priority ASC"
    );
    const ch = await getChannels('task_due');

    // Group the tasks that are due for a reminder today by assignee.
    var byUser = {};
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      const dueStr = calDateStr(t.due_date);
      var bucket = null;
      if (dueStr === tmrwStr && !t.reminded_day_before) bucket = 'tomorrow';
      else if (dueStr === todayStr && !t.reminded_due) bucket = 'today';
      else if (dueStr < todayStr) {
        const lastStr = t.last_overdue_on ? calDateStr(t.last_overdue_on) : null;
        if (lastStr !== todayStr) bucket = 'overdue';
      }
      if (!bucket) continue;
      var g = byUser[t.assigned_to] || (byUser[t.assigned_to] = {
        user: { name: t.assignee_name, email: t.email, phone: t.phone },
        overdue: [], today: [], tomorrow: []
      });
      g[bucket].push(t);
    }

    for (const id in byUser) {
      const g = byUser[id];
      const total = g.overdue.length + g.today.length + g.tomorrow.length;
      if (!total) continue;
      var parts = [];
      if (g.overdue.length) parts.push(g.overdue.length + ' overdue');
      if (g.today.length) parts.push(g.today.length + ' due today');
      if (g.tomorrow.length) parts.push(g.tomorrow.length + ' due tomorrow');
      const summary = parts.join(', ');
      const subject = 'Your tasks: ' + summary;
      const sms = firstName(g.user.name) + ', Nova tasks — ' + summary + '. Open Nova to view.';
      await deliver(g.user, sms, subject, buildTaskDigestEmail(g.user.name, g), ch);

      // Mark each task reminded so it is not re-sent (same flags as before).
      for (let k = 0; k < g.tomorrow.length; k++) await pool.query('UPDATE tasks SET reminded_day_before = true WHERE id = $1', [g.tomorrow[k].id]);
      for (let k = 0; k < g.today.length; k++) await pool.query('UPDATE tasks SET reminded_due = true WHERE id = $1', [g.today[k].id]);
      for (let k = 0; k < g.overdue.length; k++) await pool.query('UPDATE tasks SET last_overdue_on = $1 WHERE id = $2', [todayStr, g.overdue[k].id]);
    }

    // FYI recipients: email them once the first day their task goes overdue.
    await runCcOverdueNotices(todayStr);
  } catch (err) {
    console.error('[tasks] reminder sweep failed:', err.message);
  }
}

// ── Recurring task scheduler ───────────────────────────────────
// Dates are handled as UTC-midnight DATE values, matching how DATE columns store/compare.
function recurYmd(d) { return new Date(d).toISOString().slice(0, 10); }
function recurFromYmd(s) { var p = String(s).slice(0, 10).split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
function recurClampDay(y, m, day) { var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Math.min(day, last); }

// Next SEND date on/after ref. weekly: startDay = 0-6 (Sun-Sat). monthly: startDay = 1-31.
function recurNextStart(recurrence, startDay, ref) {
  var r = recurFromYmd(recurYmd(ref));
  if (recurrence === 'daily') return r;
  if (recurrence === 'weekly') {
    var add = ((startDay - r.getUTCDay()) % 7 + 7) % 7;
    r.setUTCDate(r.getUTCDate() + add);
    return r;
  }
  var y = r.getUTCFullYear(), m = r.getUTCMonth();
  var cand = new Date(Date.UTC(y, m, recurClampDay(y, m, startDay)));
  if (cand.getTime() < r.getTime()) cand = new Date(Date.UTC(y, m + 1, recurClampDay(y, m + 1, startDay)));
  return cand;
}
// DUE date for the cycle whose send date is start. Due falls on/after the send within the cycle.
function recurDueFromStart(recurrence, dueDay, start) {
  var s = recurFromYmd(recurYmd(start));
  if (recurrence === 'daily') return s;
  if (recurrence === 'weekly') {
    var add = ((dueDay - s.getUTCDay()) % 7 + 7) % 7;
    var d = new Date(s.getTime()); d.setUTCDate(d.getUTCDate() + add);
    return d;
  }
  var y = s.getUTCFullYear(), m = s.getUTCMonth(), sd = s.getUTCDate();
  if (dueDay >= sd) return new Date(Date.UTC(y, m, recurClampDay(y, m, dueDay)));
  return new Date(Date.UTC(y, m + 1, recurClampDay(y, m + 1, dueDay)));
}
// Advance to the NEXT cycle's send date, strictly after start.
function recurAdvanceStart(recurrence, startDay, start) {
  var s = recurFromYmd(recurYmd(start));
  if (recurrence === 'daily') { s.setUTCDate(s.getUTCDate() + 1); return s; }
  if (recurrence === 'weekly') { s.setUTCDate(s.getUTCDate() + 7); return s; }
  var y = s.getUTCFullYear(), m = s.getUTCMonth();
  return new Date(Date.UTC(y, m + 1, recurClampDay(y, m + 1, startDay)));
}

// Create one real task instance from a recurring template, then advance the template's next send.
async function spawnFromTemplate(templateId) {
  const tpl = (await pool.query('SELECT * FROM tasks WHERE id = $1 AND is_template = true', [templateId])).rows[0];
  if (!tpl || !tpl.recurrence || !tpl.next_run_on) return null;
  const start = recurFromYmd(recurYmd(tpl.next_run_on));
  const dueStr = recurYmd(recurDueFromStart(tpl.recurrence, tpl.recurrence_day, start));
  const ins = await pool.query(
    'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, recurrence, recurrence_day, recurrence_start_day, is_template, series_id, secondary_assignee_id, assigned_by, due_locked) ' +
    "VALUES ($1,$2,'todo',$3,$4,$5,$6,NULL,NULL,NULL,false,$7,$8,$9,$10) RETURNING id",
    [resolveDateTokens(tpl.title, recurYmd(start)), resolveDateTokens(tpl.description, recurYmd(start)), tpl.priority, tpl.assigned_to, tpl.created_by, dueStr, tpl.id, tpl.secondary_assignee_id, tpl.assigned_by, tpl.due_locked]
  );
  const newId = ins.rows[0].id;
  const subs = (await pool.query('SELECT title, position, assigned_to FROM task_subtasks WHERE task_id = $1 ORDER BY position, id', [tpl.id])).rows;
  for (let i = 0; i < subs.length; i++) await pool.query('INSERT INTO task_subtasks (task_id, title, position, assigned_to) VALUES ($1,$2,$3,$4)', [newId, subs[i].title, subs[i].position, subs[i].assigned_to]);
  const ccs = (await pool.query('SELECT user_id FROM task_cc WHERE task_id = $1', [tpl.id])).rows;
  for (const c of ccs) await pool.query('INSERT INTO task_cc (task_id, user_id) VALUES ($1,$2) ON CONFLICT (task_id, user_id) DO NOTHING', [newId, c.user_id]);
  const atts = (await pool.query('SELECT filename, mime_type, image_data, size_bytes, uploaded_by, uploaded_by_name FROM task_attachments WHERE task_id = $1', [tpl.id])).rows;
  for (const a of atts) await pool.query('INSERT INTO task_attachments (task_id, filename, mime_type, image_data, size_bytes, uploaded_by, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7)', [newId, a.filename, a.mime_type, a.image_data, a.size_bytes, a.uploaded_by, a.uploaded_by_name]);
  await pool.query("INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,NULL,'System','event',$2)", [newId, 'auto-created from recurring schedule #' + tpl.id]);
  // Advance next send past today so a backlog of missed cycles produces only one instance.
  const startDay = (tpl.recurrence_start_day != null) ? tpl.recurrence_start_day : tpl.recurrence_day;
  const today = recurFromYmd(etDateStr(new Date()));
  let ns = recurAdvanceStart(tpl.recurrence, startDay, start), guard = 0;
  while (ns.getTime() <= today.getTime() && guard++ < 500) ns = recurAdvanceStart(tpl.recurrence, startDay, ns);
  await pool.query('UPDATE tasks SET next_run_on = $1 WHERE id = $2', [recurYmd(ns), tpl.id]);
  if (tpl.assigned_to) { try { await notifyTaskAssigned(newId); } catch (e) {} }
  try { await notifyTaskCc(newId); } catch (e) {}
  return newId;
}

// Daily sweep: send any recurring task whose send day has arrived.
async function runRecurringSpawner() {
  try {
    const todayStr = etDateStr(new Date());
    const { rows } = await pool.query(
      'SELECT id FROM tasks WHERE is_template = true AND recurrence IS NOT NULL AND next_run_on IS NOT NULL AND next_run_on <= $1::date',
      [todayStr]
    );
    for (const r of rows) { try { await spawnFromTemplate(r.id); } catch (e) { console.error('[tasks] spawn failed for template', r.id, e.message); } }
    if (rows.length) console.log('[tasks] recurring spawner sent', rows.length, 'task(s)');
  } catch (err) {
    console.error('[tasks] recurring spawner failed:', err.message);
  }
}

function startRecurringSpawner() {
  cron.schedule('0 7 * * *', function () {
    console.log('[tasks] Running recurring task spawner\u2026');
    runRecurringSpawner();
  }, { timezone: TZ });
  console.log('[tasks] Recurring task spawner scheduled (07:00 ' + TZ + ')');
}

function startTaskReminders() {
  cron.schedule('0 8 * * *', function () {
    console.log('[tasks] Running daily task reminder sweep…');
    runTaskReminders();
  }, { timezone: TZ });
  console.log('[tasks] Task reminder job scheduled (08:00 ' + TZ + ')');
}

async function runCompletedCleanup() {
  try {
    const r = await pool.query(
      "DELETE FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND completed_at < NOW() - INTERVAL '14 days'"
    );
    if (r.rowCount) console.log('[tasks] Completed-task cleanup removed ' + r.rowCount + ' task(s) older than 14 days');
  } catch (err) {
    console.error('[tasks] completed cleanup failed:', err.message);
  }
}

function startCompletedCleanup() {
  cron.schedule('0 3 * * *', function () {
    console.log('[tasks] Running completed-task cleanup\u2026');
    runCompletedCleanup();
  }, { timezone: TZ });
  console.log('[tasks] Completed-task cleanup scheduled (03:00 ' + TZ + ', deletes done tasks >14 days old)');
}

module.exports = { startTaskReminders, startCompletedCleanup, runCompletedCleanup, runTaskReminders, notifyTaskAssigned, notifyTaskCc, notifyTaskCcInfo, notifyTaskCcDone, notifyTaskCcOverdue, runCcOverdueNotices, startRecurringSpawner, runRecurringSpawner, spawnFromTemplate, recurNextStart, recurDueFromStart, recurAdvanceStart, recurYmd, recurFromYmd };
