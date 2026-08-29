// The kudos push.
//
// Kudos arrive one tap at a time and the person they are about is usually
// driving. Sending a notification per tap would turn a good week into a phone
// that will not stop, so this job exists purely to BATCH: one push per person
// per win, ever, no matter how many people pressed the button.
//
// The batching key is pushed_at on the kudos row itself rather than a claim
// table. A sweep marks every kudos it just announced as pushed; the next sweep
// only sees the ones that arrived since. That means a win that collects three
// more kudos tomorrow does get a second push - which is right, it is new news -
// while three that land in the same fifteen minutes are one buzz.
//
// Deliberately NOT here:
//   * no count of anybody's lifetime kudos. See rule 2 at the top of
//     routes/employeeRecords.js.
//   * no push about zero. Unreachable by construction: the sweep starts from
//     rows that exist.
//   * no email and no SMS. A pat on the back is not worth a text message that
//     costs money and lands at 6am.
//
// No backticks anywhere in this file (Windows corrupts them in .js).
const cron = require('node-cron');
const { pool } = require('../db');
const push = require('../utils/push');

// Nothing goes out before this hour or after it, Eastern. There is no
// company-wide quiet-hours helper in this codebase yet, so the window lives
// here; a kudos held overnight is still a kudos in the morning, and the
// celebration on the home screen is waiting either way.
var QUIET_START_HOUR = 20;   // 8pm - nothing sent at or after this
var QUIET_END_HOUR = 7;      // 7am - nothing sent before this

function easternHour(now) {
  try {
    var s = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false
    }).format(now || new Date());
    var h = parseInt(s, 10);
    return isNaN(h) ? null : (h === 24 ? 0 : h);
  } catch (e) {
    return null;
  }
}

function inQuietHours(now) {
  var h = easternHour(now);
  // Unknown hour means send. Failing closed here would mean silently never
  // notifying anybody if the runtime lacked the timezone data.
  if (h === null) return false;
  return h >= QUIET_START_HOUR || h < QUIET_END_HOUR;
}

async function runKudosPush(opts) {
  var force = !!(opts && opts.force);
  if (!force && inQuietHours()) return { skipped: 'quiet_hours', sent: 0 };
  if (!push.isReady()) {
    // Still stamp nothing. If VAPID is configured later, the backlog goes out
    // on the next sweep rather than being lost.
    return { skipped: 'push_not_configured', sent: 0 };
  }

  // One row per (recipient, win) with something new on it. The join to
  // employee_records repeats the visibility clause the celebration uses: a
  // recognition that has been voided or un-shared since the tap must not
  // produce a notification quoting it.
  var groups;
  try {
    groups = (await pool.query(
      'SELECT k.to_user_id, k.record_id, COUNT(*)::int AS n, ' +
      '       MAX(r.category) AS category ' +
      'FROM kudos k JOIN employee_records r ON r.id = k.record_id ' +
      'JOIN users u ON u.id = k.to_user_id ' +
      'WHERE k.pushed_at IS NULL ' +
      "  AND r.status = 'active' AND r.visible_to_employee = true " +
      '  AND u.active IS NOT FALSE ' +
      'GROUP BY k.to_user_id, k.record_id'
    )).rows;
  } catch (e) {
    console.error('[kudos-push] load failed:', e.message);
    return { skipped: 'query_failed', sent: 0 };
  }
  if (!groups.length) return { sent: 0, groups: 0 };

  var sent = 0;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var forWhat = g.category ? ' for your ' + g.category + ' win' : ' for your win';
    var body = (g.n === 1 ? 'Somebody gave you kudos' : g.n + ' people gave you kudos') +
      forWhat + '. Open Nova to see who.';
    try {
      await push.sendPushToUsers([g.to_user_id], { title: 'Nova', body: body, url: '/' });
      sent++;
    } catch (e) {
      console.error('[kudos-push] send failed for user ' + g.to_user_id + ':', e.message);
      // Fall through and stamp anyway. A push that failed to deliver is not
      // worth re-announcing on every sweep for the rest of the week - the
      // celebration on the home screen is the reliable channel, this is the
      // nice-to-have.
    }
    try {
      await pool.query(
        'UPDATE kudos SET pushed_at = NOW() WHERE to_user_id = $1 AND record_id = $2 AND pushed_at IS NULL',
        [g.to_user_id, g.record_id]
      );
    } catch (e) {
      console.error('[kudos-push] stamp failed for user ' + g.to_user_id + ':', e.message);
    }
  }
  console.log('[kudos-push] ' + groups.length + ' batch(es), ' + sent + ' push(es).');
  return { sent: sent, groups: groups.length };
}

function startKudosPush() {
  // Every 15 minutes. Fast enough that a kudos still feels like a reaction,
  // slow enough that a burst of them is one notification.
  cron.schedule('*/15 * * * *', function () {
    runKudosPush().catch(function (e) { console.error('[kudos-push] failed:', e.message); });
  });
  console.log('Kudos push scheduled (every 15 min, quiet 8pm-7am America/New_York).');
}

module.exports = {
  startKudosPush: startKudosPush,
  runKudosPush: runKudosPush,
  inQuietHours: inQuietHours,
  easternHour: easternHour,
  QUIET_START_HOUR: QUIET_START_HOUR,
  QUIET_END_HOUR: QUIET_END_HOUR
};
