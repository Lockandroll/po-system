// Who is locked out of Nova right now by an unsigned memo.
//
// middleware/auth.js asks lockedMemoFor(userId) on EVERY authenticated request,
// so this is built to cost nothing per request: one small query refreshes an
// in-memory map of { user_id -> memo_id } at most every REFRESH_MS, and every
// request in between is a Map lookup. routes/memos.js calls invalidate() the
// moment anything that changes the answer happens (send, sign, acknowledge,
// excuse, withdraw), so on the one Railway instance a signature unlocks Nova on
// the very next tap, not 15 seconds later. A second instance would catch up on
// its next refresh.
//
// It FAILS OPEN, on purpose, and that is the opposite of every other gate in
// auth.js. A memo lock is a nudge to read something, not an access control: a
// database hiccup, or a deploy where the memo tables have not landed yet, must
// never lock the whole company out of Nova. If the refresh throws, the last
// good answer is kept; if there never was one, nobody is locked.
//
// "Locked" means: a SENT memo with lock_until_done, whose lock has started
// (lock_starts_at empty or in the past), that this person has not signed or
// acknowledged, has not been excused from, and is not exempt from (admins and
// owners are exempt by default - see routes/memos.js lockExemptRoles()).
//
// House style: string concatenation only, no template literals.
var { pool } = require('../db');

var REFRESH_MS = 15000;

var _map = new Map();      // user_id -> memo_id
var _at = 0;               // when _map was last refreshed (ms)
var _inflight = null;      // the refresh in progress, so a burst of requests shares one query

var LOCK_SQL =
  'SELECT DISTINCT ON (r.user_id) r.user_id, r.memo_id ' +
  'FROM memo_recipients r JOIN memos m ON m.id = r.memo_id ' +
  "WHERE m.status = 'sent' AND m.lock_until_done = true " +
  '  AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()) ' +
  '  AND r.completed_at IS NULL AND r.excused_at IS NULL AND r.lock_exempt = false ' +
  'ORDER BY r.user_id, m.sent_at ASC, m.id ASC';

async function refresh() {
  if (_inflight) return _inflight;
  _inflight = (async function () {
    try {
      var r = await pool.query(LOCK_SQL);
      var next = new Map();
      for (var i = 0; i < r.rows.length; i++) next.set(Number(r.rows[i].user_id), Number(r.rows[i].memo_id));
      _map = next;
      _at = Date.now();
    } catch (e) {
      // Keep the last good map. Stamp the time anyway so a missing table does
      // not turn into a query on every single request.
      _at = Date.now();
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

// The memo id locking this person out, or null. Never throws.
async function lockedMemoFor(userId) {
  try {
    if (!userId) return null;
    if (Date.now() - _at > REFRESH_MS) await refresh();
    var v = _map.get(Number(userId));
    return v ? v : null;
  } catch (e) {
    return null;
  }
}

// Throw the cached answer away so the next request re-reads it.
function invalidate() {
  _at = 0;
}

// Which API paths stay open while someone is locked. Everything they need to
// read and sign the memo, plus the things that must never stop mid-shift:
//   /api/auth          signing in and out, /auth/me
//   /api/memos/me      the memo itself, its PDF, signing it
//   /api/push          so the phone keeps receiving notifications
//   /api/timeclock     nobody is kept from clocking in or out (Tony's call)
//   /api/locations     the Live Map keeps their dot while they read
//   invoice payment completion - a card already swiped on the Square app comes
//                      back through these and must be written down, or the
//                      money is taken and Nova never knows. Everything else on
//                      the invoice waits; the editor autosaves, so nothing typed
//                      is lost, and signing takes about a minute.
var OPEN_PREFIXES = ['/api/auth', '/api/memos/me', '/api/push', '/api/timeclock', '/api/locations', '/api/version'];
var OPEN_PATTERNS = [
  /^\/api\/invoices\/\d+\/payments(\/|$)/,
  /^\/api\/invoices\/\d+\/square-candidates(\/|\?|$)/,
  /^\/api\/invoices\/\d+\/attach-square-payment(\/|$)/
];

function pathIsOpen(p) {
  p = String(p || '');
  for (var i = 0; i < OPEN_PREFIXES.length; i++) {
    var pre = OPEN_PREFIXES[i];
    if (p === pre || p.indexOf(pre + '/') === 0 || p.indexOf(pre + '?') === 0) return true;
  }
  for (var j = 0; j < OPEN_PATTERNS.length; j++) if (OPEN_PATTERNS[j].test(p)) return true;
  return false;
}

module.exports = {
  lockedMemoFor: lockedMemoFor,
  invalidate: invalidate,
  refresh: refresh,
  pathIsOpen: pathIsOpen,
  REFRESH_MS: REFRESH_MS
};
