// jobs/checkins.js
//
// Two sweeps, both about calls that stopped reporting back. Wrapped by
// utils/jobHealth via server.js like every other scheduler here, so they show up
// in Settings > Job Health. No backticks.

var cron = require('node-cron');
var { pool } = require('../db');
var engine = require('../utils/checkinEngine');
var r2 = require('../utils/r2');

// Railway redeploys mid-call and the status callback lands nowhere. Without
// this, a technician sits watching a spinner that will never resolve, decides
// Nova is broken, and calls it in himself, which is the right instinct but he
// should not have had to guess.
function startCheckinSweeper() {
  cron.schedule('*/5 * * * *', async function () {
    try {
      var out = await engine.sweepStuck(10);
      if (out.handled) console.log('[checkins] swept ' + out.handled + ' stuck call(s) of ' + out.checked);
    } catch (e) {
      console.error('[checkins] sweep failed:', e.message);
    }
  });
  console.log('Check-in sweeper scheduled (every 5 min)');
}

// Recordings age out; transcripts do not. The transcript is what the system
// reads and what settles most arguments, and it costs nothing to keep. The
// audio is the expensive, sensitive half, so it goes on a clock.
//
// CHECKIN_RECORDING_RETENTION_DAYS = 0 keeps audio forever.
function startCheckinRetention() {
  cron.schedule('40 3 * * *', async function () {
    var days = parseInt(process.env.CHECKIN_RECORDING_RETENTION_DAYS, 10);
    if (!isFinite(days) || days <= 0) return;
    if (!r2.configured()) return;
    try {
      var { rows } = await pool.query(
        'SELECT id, recording_key FROM checkin_events ' +
        "WHERE recording_key IS NOT NULL AND created_at < NOW() - ($1 || ' days')::interval LIMIT 200",
        [String(days)]
      );
      var gone = 0;
      for (var i = 0; i < rows.length; i++) {
        try {
          await r2.deleteObject(rows[i].recording_key);
          await pool.query('UPDATE checkin_events SET recording_key = NULL WHERE id = $1', [rows[i].id]);
          gone++;
        } catch (e) { console.error('[checkins] retention ' + rows[i].id + ':', e.message); }
      }
      if (gone) console.log('[checkins] retired ' + gone + ' recording(s) older than ' + days + ' days');
    } catch (e) {
      console.error('[checkins] retention sweep failed:', e.message);
    }
  });
  console.log('Check-in recording retention scheduled (daily 03:40)');
}

module.exports = { startCheckinSweeper: startCheckinSweeper, startCheckinRetention: startCheckinRetention };
