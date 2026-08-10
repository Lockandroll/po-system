const cron = require('node-cron');
const { pool } = require('../db');

const TZ = 'America/New_York';

// ---------------------------------------------------------------------------
//  Accounts Payable - bill reminders
// ---------------------------------------------------------------------------
// A bill coming due raises a normal Nova task a few days ahead. Deliberately a
// TASK, exactly like A/R collections: the task module already has assignment,
// due dates, day-before and due-day reminders, overdue escalation and a place
// people actually look. A bespoke "bills due" inbox would be a screen nobody
// opens on a Tuesday.
//
// One reminder task per bill, ever. The guard is ap_bills.reminder_task_id: the
// query only picks up bills where it IS NULL, and the moment a task is made the
// id is written back. The title also carries the bill id, so even a manual task
// with the same wording could not be mistaken for this one.
function reminderTitle(bill) {
  const who = bill.payee || bill.vendor_name || 'a vendor';
  return 'Pay: ' + who + ' - bill #' + bill.id;
}

async function getLeadDays() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'ap_reminder_lead_days'");
    var lead = r.rows.length ? parseInt(r.rows[0].value, 10) : 3;
    if (!isFinite(lead) || lead < 0 || lead > 30) lead = 3;
    return lead;
  } catch (e) { return 3; }
}

async function getFallbackUser() {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'ap_reminder_user_id'");
    const uid = r.rows.length ? parseInt(r.rows[0].value, 10) : NaN;
    return isFinite(uid) ? uid : null;
  } catch (e) { return null; }
}

async function runApReminders() {
  try {
    const lead = await getLeadDays();
    const fallback = await getFallbackUser();

    // Unpaid bills due within the lead window - plus any already overdue that
    // never got a task (a bill entered late still deserves its reminder) - that
    // do not yet have a reminder task.
    const r = await pool.query(
      'SELECT b.id, b.payee, b.amount, b.due_date, b.assigned_to, v.name AS vendor_name, ' +
      '       (b.due_date - CURRENT_DATE)::int AS days_out ' +
      'FROM ap_bills b LEFT JOIN vendors v ON v.id = b.vendor_id ' +
      "WHERE b.status = 'unpaid' AND b.reminder_task_id IS NULL AND b.due_date IS NOT NULL " +
      '  AND b.due_date <= CURRENT_DATE + ($1::int) ' +
      'ORDER BY b.due_date LIMIT 200', [lead]);

    var made = 0;
    for (var i = 0; i < r.rows.length; i++) {
      const bill = r.rows[i];
      // Whoever the bill is assigned to; else the fallback AP person; else nobody
      // (better an unassigned task than fifty tasks dumped on one admin).
      const assignee = bill.assigned_to || fallback || null;
      const who = bill.payee || bill.vendor_name || 'a vendor';
      const dueStr = String(bill.due_date).slice(0, 10);
      const out = Number(bill.days_out);
      const when = out < 0
        ? ' - ' + Math.abs(out) + ' day' + (Math.abs(out) === 1 ? '' : 's') + ' ago'
        : (out === 0 ? ' - today' : ' - in ' + out + ' day' + (out === 1 ? '' : 's'));
      const desc = who + (bill.amount != null ? ' for $' + Number(bill.amount).toFixed(2) : '') +
        '. Due ' + dueStr + when + '. Mark it paid in Accounts Payable once it is done.';
      const priority = (out <= 1) ? 'high' : 'medium';

      // source/source_id link the task back to the bill (the same columns the PO
      // and inspection tasks use), so the bill can find and clean up its task.
      const ins = await pool.query(
        'INSERT INTO tasks (title, description, status, priority, assigned_to, due_date, source, source_id) ' +
        "VALUES ($1,$2,'todo',$3,$4,$5,'ap',$6) RETURNING id",
        [reminderTitle(bill), desc, priority, assignee, dueStr, bill.id]);

      await pool.query('UPDATE ap_bills SET reminder_task_id=$1, reminded_on=CURRENT_DATE WHERE id=$2',
        [ins.rows[0].id, bill.id]);
      made++;
    }
    if (made) console.log('A/P: raised ' + made + ' bill reminder task(s).');
  } catch (e) {
    // A missing table or empty install must never take the cron process down.
    console.error('runApReminders error:', e.message);
  }
}

function startApJobs() {
  // Early, just after the A/R jobs (07:15 / 07:30), so the day's payables are
  // waiting in the task list when somebody sits down rather than appearing
  // halfway through the morning.
  cron.schedule('45 7 * * *', runApReminders, { timezone: TZ });
  console.log('A/P jobs scheduled (bill reminders 07:45).');
}

module.exports = { startApJobs, runApReminders, reminderTitle };
