const cron = require('node-cron');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { sendEmail, emailTemplate } = require('../utils/email');
const push = require('../utils/push');

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
  const line = 'You have been copied on this task' + (t.assignee_name ? ' (assigned to ' + t.assignee_name + ')' : '') + ' so you are aware. No action is needed unless asked.';
  try { await sendEmail(emails, 'FYI \u2014 task: ' + t.title, taskEmail(t, line, attCount)); } catch (e) { console.error('[tasks] cc email failed:', e.message); }
}
// Bulk variant: one summary FYI to the copied people for a batch of identical tasks.
async function notifyTaskCcInfo(ccUserIds, info) {
  const emails = await ccEmails(ccUserIds);
  if (!emails.length) return;
  const who = (info.assignees && info.assignees.length) ? info.assignees.join(', ') : 'the team';
  const t = { title: info.title, description: info.description, priority: info.priority, due_date: info.due_date };
  const line = 'You have been copied on a task assigned to ' + who + ' so you are aware. No action is needed unless asked.';
  try { await sendEmail(emails, 'FYI \u2014 task: ' + info.title, taskEmail(t, line, info.attCount || 0)); } catch (e) { console.error('[tasks] cc email failed:', e.message); }
}

// Daily sweep: day-before, due-today, and overdue reminders.
async function runTaskReminders() {
  try {
    const now = new Date();
    const todayStr = etDateStr(now);
    const tmrwStr = etDateStr(new Date(now.getTime() + 86400000));
    const { rows } = await pool.query(
      "SELECT t.*, u.name AS assignee_name, u.phone, u.email FROM tasks t JOIN users u ON t.assigned_to = u.id " +
      "WHERE t.status <> 'done' AND t.due_date IS NOT NULL"
    );
    const ch = await getChannels('task_due');
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      const dueStr = calDateStr(t.due_date);
      if (dueStr === tmrwStr && !t.reminded_day_before) {
        await deliver(t, 'Reminder: task "' + t.title + '" is due tomorrow (' + fmtDate(t.due_date) + ').', 'Task due tomorrow: ' + t.title, taskEmail(t, 'This task is due tomorrow.'), ch);
        await pool.query('UPDATE tasks SET reminded_day_before = true WHERE id = $1', [t.id]);
      } else if (dueStr === todayStr && !t.reminded_due) {
        await deliver(t, 'Reminder: task "' + t.title + '" is due today.', 'Task due today: ' + t.title, taskEmail(t, 'This task is due today.'), ch);
        await pool.query('UPDATE tasks SET reminded_due = true WHERE id = $1', [t.id]);
      } else if (dueStr < todayStr) {
        const lastStr = t.last_overdue_on ? calDateStr(t.last_overdue_on) : null;
        if (lastStr !== todayStr) {
          await deliver(t, 'Reminder: task "' + t.title + '" is OVERDUE (was due ' + fmtDate(t.due_date) + ').', 'Task overdue: ' + t.title, taskEmail(t, 'This task is overdue.'), ch);
          await pool.query('UPDATE tasks SET last_overdue_on = $1 WHERE id = $2', [todayStr, t.id]);
        }
      }
    }
  } catch (err) {
    console.error('[tasks] reminder sweep failed:', err.message);
  }
}

function startTaskReminders() {
  cron.schedule('0 8 * * *', function () {
    console.log('[tasks] Running daily task reminder sweep…');
    runTaskReminders();
  }, { timezone: TZ });
  console.log('[tasks] Task reminder job scheduled (08:00 ' + TZ + ')');
}

module.exports = { startTaskReminders, runTaskReminders, notifyTaskAssigned, notifyTaskCc, notifyTaskCcInfo };
