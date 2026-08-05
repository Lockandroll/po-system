const { pool } = require('../db');

// ---------------------------------------------------------------------------
//  Duty status - "ready to accept calls"
// ---------------------------------------------------------------------------
// Techs do not punch a time clock, so this is the switch everything else hangs
// off. It decides three things:
//   1. whether Nova will store the tech's position at all (routes/locations.js)
//   2. whether the tech can see the dispatch board (routes/dispatch.js)
//   3. whether dispatch treats them as available
//
// There is deliberately NO automatic overnight clear. Some of the crew work
// nights, and a nightly sweep would quietly take the on-call people off duty at
// the exact moment they matter. Instead the board reports how long someone has
// been marked ready, and a dispatcher can clear a forgotten toggle by hand.

async function getDuty(userId) {
  const r = await pool.query('SELECT * FROM tech_duty WHERE user_id = $1', [userId]);
  if (!r.rows.length) return { user_id: userId, ready: false, ready_since: null, last_changed_at: null };
  return r.rows[0];
}

async function isReady(userId) {
  const r = await pool.query('SELECT ready FROM tech_duty WHERE user_id = $1', [userId]);
  return !!(r.rows.length && r.rows[0].ready);
}

// ready_since is only reset when duty actually flips on, so a tech tapping
// "Ready" twice does not restart their clock and hide how long they have been out.
async function setReady(userId, ready, byUserId, note) {
  ready = !!ready;
  const cur = await getDuty(userId);
  const flipped = (!!cur.ready !== ready);
  const since = ready ? (flipped || !cur.ready_since ? new Date() : cur.ready_since) : null;

  await pool.query(
    'INSERT INTO tech_duty (user_id, ready, ready_since, last_changed_at, changed_by, note) ' +
    'VALUES ($1,$2,$3,NOW(),$4,$5) ' +
    'ON CONFLICT (user_id) DO UPDATE SET ready = EXCLUDED.ready, ready_since = EXCLUDED.ready_since, ' +
    'last_changed_at = NOW(), changed_by = EXCLUDED.changed_by, note = EXCLUDED.note',
    [userId, ready, since, byUserId || null, note || null]
  );
  if (flipped) {
    await pool.query(
      'INSERT INTO tech_duty_log (user_id, ready, changed_by, note) VALUES ($1,$2,$3,$4)',
      [userId, ready, byUserId || null, note || null]
    );
  }
  return getDuty(userId);
}

function hoursOnDuty(duty) {
  if (!duty || !duty.ready || !duty.ready_since) return null;
  return (Date.now() - new Date(duty.ready_since).getTime()) / 3600000;
}

module.exports = { getDuty, isReady, setReady, hoursOnDuty };
