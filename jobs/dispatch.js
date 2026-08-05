const cron = require('node-cron');
const { pool } = require('../db');
const push = require('../utils/push');
const dispatch = require('../routes/dispatch');

const TZ = 'America/New_York';

// ---------------------------------------------------------------------------
//  Nudges
// ---------------------------------------------------------------------------
// A call assigned to a phone that nobody has picked up is the failure mode this
// whole board exists to prevent. Two minutes after assignment, if the tech has
// not accepted, remind them.
//
// This deliberately does NOT take the call back. A tech can be driving, or under
// a dash with their hands full, and yanking the job out from under them at the
// two minute mark would cause more chaos than it prevents. The reminder fires,
// the board turns the row amber, and a human decides.
async function runAcceptReminders() {
  try {
    const mins = await dispatch.acceptTimeoutMinutes();
    const r = await pool.query(
      "SELECT id, job_number, service_type, address, assigned_to FROM dispatch_jobs " +
      "WHERE status = 'assigned' AND assigned_to IS NOT NULL AND accepted_at IS NULL " +
      "  AND assigned_at < NOW() - ($1 || ' minutes')::interval " +
      "  AND accept_reminder_at IS NULL",
      [String(mins)]
    );
    for (var i = 0; i < r.rows.length; i++) {
      const j = r.rows[i];
      try {
        await push.sendPushToUsers([j.assigned_to], {
          title: 'Still waiting on you',
          body: (j.service_type || j.job_number || 'A call') + ' has not been accepted yet.',
          url: '/?view=dispatch',
          tag: 'dispatch-' + j.id
        });
      } catch (e) { console.error('accept reminder push failed:', e.message); }
      // Stamped whether or not the push landed, so a dead subscription cannot
      // turn this into a nag loop that fires every single minute.
      await pool.query('UPDATE dispatch_jobs SET accept_reminder_at = NOW() WHERE id = $1', [j.id]);
      await pool.query(
        "INSERT INTO dispatch_job_events (job_id, event, detail) VALUES ($1, 'accept_reminder', $2)",
        [j.id, 'no acceptance after ' + mins + ' min']);
    }
    if (r.rows.length) console.log('Dispatch: reminded on ' + r.rows.length + ' unaccepted call(s).');
  } catch (e) {
    console.error('runAcceptReminders error:', e.message);
  }
}

// A call sitting on the board with nobody on it. Flagged for dispatch rather
// than pushed at a tech, because the fix is somebody assigning it.
async function runUnassignedAlerts() {
  try {
    const mins = await dispatch.unassignedAlertMinutes();
    const r = await pool.query(
      "UPDATE dispatch_jobs SET unassigned_alert_at = NOW() " +
      "WHERE status = 'new' AND assigned_to IS NULL " +
      "  AND created_at < NOW() - ($1 || ' minutes')::interval " +
      "  AND unassigned_alert_at IS NULL RETURNING id",
      [String(mins)]
    );
    for (var i = 0; i < r.rows.length; i++) {
      await pool.query(
        "INSERT INTO dispatch_job_events (job_id, event, detail) VALUES ($1, 'unassigned_alert', $2)",
        [r.rows[i].id, 'still unassigned after ' + mins + ' min']);
    }
    if (r.rowCount) console.log('Dispatch: ' + r.rowCount + ' call(s) flagged as sitting unassigned.');
  } catch (e) {
    console.error('runUnassignedAlerts error:', e.message);
  }
}

function startDispatchJobs() {
  cron.schedule('* * * * *', runAcceptReminders, { timezone: TZ });
  cron.schedule('* * * * *', runUnassignedAlerts, { timezone: TZ });
  console.log('Dispatch nudges scheduled (every minute).');
}

module.exports = { startDispatchJobs, runAcceptReminders, runUnassignedAlerts };
