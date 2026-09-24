// Vehicle sheet deadline reminders.
//
// A manager starting a sheet can give the driver a "complete by" time. Once that
// passes, the driver gets one reminder (push + text) and the manager who started
// the sheet gets a heads-up. reminder_sent_at on the sheet is the claim, so each
// sheet is reminded once; changing the deadline clears it (routes/vehicleHandoffs.js).
//
// Nothing goes out overnight: the sweep only sends between 7am and 8pm Eastern.
// A reminder held until morning is still a reminder.
//
// No backticks anywhere in this file (Windows corrupts them in .js).
const cron = require('node-cron');
const { pool } = require('../db');

function easternHour() {
  try {
    var h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()), 10);
    return isNaN(h) ? null : (h === 24 ? 0 : h);
  } catch (e) { return null; }
}

async function runVehicleSheetReminders() {
  var h = easternHour();
  if (h !== null && (h < 7 || h >= 20)) return { skipped: 'quiet_hours', sent: 0 };
  var internal = require('../routes/vehicleHandoffs')._internal;
  // Claim first, then send: two instances cannot both remind the same sheet.
  const r = await pool.query(
    'UPDATE vehicle_handoffs SET reminder_sent_at = NOW() ' +
    "WHERE status IN ('awaiting_driver','in_progress','returned') AND due_at IS NOT NULL AND due_at < NOW() " +
    "AND reminder_sent_at IS NULL AND filled_by = 'driver' AND driver_not_present = false RETURNING id"
  );
  var sent = 0;
  for (var i = 0; i < r.rows.length; i++) {
    try {
      var s = await internal.loadSheet(r.rows[i].id);
      if (!s) continue;
      await internal.notifyUser(s.driver_user_id, 'Vehicle sheet overdue',
        'Your vehicle sheet ' + s.handoff_number + ' for the ' + internal.vehicleName(s) + ' is past due. Please finish it now.',
        internal.sheetLink(s, true), { sms: true });
      if (s.created_by) {
        await internal.notifyUser(s.created_by, 'Vehicle sheet overdue',
          (s.driver_name || 'The driver') + ' has not finished ' + s.handoff_number + ' yet.', internal.sheetLink(s, false), {});
      }
      sent++;
    } catch (e) { console.error('[vehicle-sheets] reminder failed:', e.message); }
  }
  return { sent: sent };
}

function startVehicleSheetReminders() {
  cron.schedule('*/30 * * * *', function () {
    runVehicleSheetReminders().catch(function (e) { console.error('[vehicle-sheets] reminder sweep failed:', e.message); });
  }, { timezone: 'America/New_York' });
}

module.exports = { startVehicleSheetReminders: startVehicleSheetReminders, runVehicleSheetReminders: runVehicleSheetReminders };
