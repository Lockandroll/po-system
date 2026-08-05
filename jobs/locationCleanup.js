const cron = require('node-cron');
const locations = require('../routes/locations');

const TZ = 'America/New_York';

// Location history is the one dataset here that grows without a natural ceiling.
// A dozen techs reporting once a minute is roughly four million rows a year, and
// open-ended location history on employees is a liability nobody wants sitting
// in a database. The retention window is settings.location_retention_days.
async function runLocationCleanup() {
  try {
    const r = await locations.sweepOldPings();
    if (r && r.deleted) {
      console.log('Location cleanup: deleted ' + r.deleted + ' point(s) older than ' + r.days + ' days.');
    }
  } catch (e) {
    console.error('runLocationCleanup error:', e.message);
  }
}

function startLocationCleanup() {
  // Nightly at 3:40am, after the time clock auto-close at 3:10 so the last
  // entries of the day are already settled.
  cron.schedule('40 3 * * *', runLocationCleanup, { timezone: TZ });
  console.log('Location cleanup job scheduled (nightly 3:40am).');
}

module.exports = { startLocationCleanup, runLocationCleanup };
