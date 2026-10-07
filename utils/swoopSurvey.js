// Swoop (Agero) review emails - pure helpers plus the settings readers.
// No scheduling here; jobs/swoopSurveys.js does the mailbox polling and
// routes/swoop.js serves the page. House style: string concatenation, no
// template literals (CLAUDE.md 1.1).
//
// The email ("New Review for ID #115320408") is an HTML table. Graph hands it to
// us as plain text, and depending on how Outlook flattens the table the label
// and value can land on one line ("NPS Score: 10") or on separate lines. So the
// parser does NOT read "the rest of the line". It finds each known label in
// order and takes everything between it and the next label. That is also what
// keeps an EMPTY Feedback cell from swallowing the "Account:" line below it.

const { pool } = require('../db');

const SUBJECT_PREFIX = 'New Review for ID';

// In the order Swoop prints them. key -> label text, or a list of label texts
// any of which counts. The live emails say "Customer Contact" / "Customer
// Number"; the sample the parser was first written from said "Pickup Contact" /
// "Pickup Number". Only the Pickup pair was recognised, so the customer's name
// and phone were swallowed into the Driver value and every complaint came out as
// "Swoop customer" with no phone (Tony, 2026-10-07). Both spellings are accepted.
const LABELS = [
  ['score', 'NPS Score'],
  ['feedback', 'Feedback'],
  ['account', 'Account'],
  ['driver', 'Driver'],
  ['pickupContact', ['Customer Contact', 'Pickup Contact', 'Customer Name']],
  ['pickupPhone', ['Customer Number', 'Pickup Number', 'Customer Phone', 'Pickup Phone']]
];

// Text after the table that must never be read as part of the last value.
const FOOTER_RE = /(Agero Proprietary|©\s*\d{4}|&copy;)/i;

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function clean(v) {
  return String(v == null ? '' : v).replace(/ /g, ' ').replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n').trim();
}

// "2026-10-05T14:02:11Z" -> "2026-10-05" in Eastern time, so a review that lands
// at 9 PM Eastern is filed under that day, not tomorrow's UTC date.
function easternDate(iso) {
  if (!iso) return null;
  var d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}

// 0-10 integer, or null when the cell is empty or not a number in range.
function parseScore(v) {
  var m = String(v == null ? '' : v).match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  var n = Math.round(parseFloat(m[0]));
  if (isNaN(n) || n < 0 || n > 10) return null;
  return n;
}

// msg = { subject, receivedDateTime, bodyText, internetMessageId }
// Returns { jobId, score, feedback, account, driver, pickupContact, pickupPhone,
//           receivedAt, dateReceived, internetMessageId }. jobId '' = unusable.
function parseSwoopEmail(msg) {
  msg = msg || {};
  var subject = String(msg.subject || '');
  var body = String(msg.bodyText || '').replace(/\r\n?/g, '\n');

  var jobId = '';
  var sm = subject.match(/ID\s*#?\s*(\d{4,})/i) || body.match(/Review for ID\s*#?\s*(\d{4,})/i);
  if (sm) jobId = sm[1];

  // Cut the footer off first so "Pickup Number" cannot run into it.
  var fm = body.match(FOOTER_RE);
  if (fm) body = body.slice(0, fm.index);

  // Locate the labels. Only Feedback can contain customer text, and a customer
  // can type anything ("Account: never again"). So NPS Score and Feedback are
  // taken at their FIRST occurrence, and every label after Feedback at its LAST
  // occurrence, searching backwards from the end. Whatever the customer typed
  // then stays inside Feedback.
  function labelRe(label) {
    var alts = Array.isArray(label) ? label : [label];
    return new RegExp('(^|[\\s|])(?:' + alts.map(escRe).join('|') + ')\\s*:', 'ig');
  }
  function firstAt(label, from, to) {
    var re = labelRe(label); re.lastIndex = from;
    var m = re.exec(body);
    if (!m || m.index >= to) return null;
    return { start: m.index + m[1].length, valueStart: m.index + m[0].length };
  }
  function lastBefore(label, from, to) {
    var re = labelRe(label); re.lastIndex = from;
    var m, best = null;
    while ((m = re.exec(body)) !== null) {
      if (m.index + m[0].length > to) break;
      best = { start: m.index + m[1].length, valueStart: m.index + m[0].length };
    }
    return best;
  }
  var hits = [];
  var head = 0;
  for (var i = 0; i < 2; i++) {            // NPS Score, Feedback
    var f = firstAt(LABELS[i][1], head, body.length);
    if (!f) continue;
    f.key = LABELS[i][0];
    hits.push(f);
    head = f.valueStart;
  }
  var tail = [];
  var bound = body.length;
  for (var k = LABELS.length - 1; k >= 2; k--) {   // Pickup Number back to Account
    var l = lastBefore(LABELS[k][1], head, bound);
    if (!l) continue;
    l.key = LABELS[k][0];
    tail.unshift(l);
    bound = l.start;
  }
  hits = hits.concat(tail);

  var out = {};
  for (var h = 0; h < hits.length; h++) {
    var end = (h + 1 < hits.length) ? hits[h + 1].start : body.length;
    // A table border flattened to text can leave a stray "|" behind.
    out[hits[h].key] = clean(body.slice(hits[h].valueStart, end).replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, ''));
  }

  var receivedAt = msg.receivedDateTime || null;
  return {
    jobId: jobId,
    score: parseScore(out.score),
    feedback: out.feedback || '',
    account: out.account || '',
    driver: (out.driver || '').replace(/\n+/g, ' '),
    pickupContact: (out.pickupContact || '').replace(/\n+/g, ' '),
    pickupPhone: (out.pickupPhone || '').replace(/\s+/g, ''),
    receivedAt: receivedAt,
    dateReceived: easternDate(receivedAt),
    internetMessageId: msg.internetMessageId || ''
  };
}

// --- settings -------------------------------------------------------------

async function getSetting(key) {
  try {
    var r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : null;
  } catch (e) { return null; }
}

function intIn(raw, lo, hi, dflt) {
  var s = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(s)) return dflt;
  var n = parseInt(s, 10);
  return (n < lo || n > hi) ? dflt : n;
}

// Tony's scale (2026-10-05): 0-5 = -100, 6-8 = 0, 9-10 = 100. Kept in settings
// so the bands can move without a deploy. A nonsense pair (passive below
// detractor) falls back to the defaults rather than scoring everything wrong.
const DEFAULT_DETRACTOR_MAX = 5;
const DEFAULT_PASSIVE_MAX = 8;
const DEFAULT_COMPLAINT_MAX = 7;   // "anything less than 8"

async function npsBands() {
  var d = intIn(await getSetting('swoop_nps_detractor_max'), 0, 10, DEFAULT_DETRACTOR_MAX);
  var p = intIn(await getSetting('swoop_nps_passive_max'), 0, 10, DEFAULT_PASSIVE_MAX);
  if (p < d) { d = DEFAULT_DETRACTOR_MAX; p = DEFAULT_PASSIVE_MAX; }
  return { detractorMax: d, passiveMax: p };
}

async function complaintMaxScore() {
  return intIn(await getSetting('swoop_complaint_max_score'), 0, 10, DEFAULT_COMPLAINT_MAX);
}

// One survey's NPS value: -100, 0 or 100 (null when there is no score).
function npsFor(score, bands) {
  if (score == null || score === '') return null;
  var n = Number(score);
  if (isNaN(n)) return null;
  if (n <= bands.detractorMax) return -100;
  if (n <= bands.passiveMax) return 0;
  return 100;
}

// SQL twin of npsFor. The bands are integers that came through intIn, so
// inlining them is safe (and lets AVG() run in one pass).
function npsSql(col, bands) {
  var d = parseInt(bands.detractorMax, 10), p = parseInt(bands.passiveMax, 10);
  return '(CASE WHEN ' + col + ' IS NULL THEN NULL WHEN ' + col + ' <= ' + d + ' THEN -100 ' +
    'WHEN ' + col + ' <= ' + p + ' THEN 0 ELSE 100 END)';
}

// "Beardshear Jesse" is Swoop's Last First, with no comma. The shared roster
// matcher reads a comma-less name as First Last, which still finds an exact
// "Jesse Beardshear" but misses the last-name + initial tier. So try the comma
// form first, then the raw text.
function resolveDriver(resolver, raw) {
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return { user_id: null, name: null, tier: 99 };
  var toks = s.split(/\s+/);
  if (s.indexOf(',') === -1 && toks.length >= 2) {
    var hit = resolver.resolve(toks[0] + ', ' + toks.slice(1).join(' '));
    if (hit.user_id) return hit;
  }
  return resolver.resolve(s);
}

// Repair helper for rows stored before the label fix: their driver_raw holds
// "Brown Sean Customer Contact: J W Cepeda Customer Number: +14072347617".
// Returns { driver, contact, phone } or null when there is nothing to split.
function splitLegacyDriver(raw) {
  var s = String(raw == null ? '' : raw);
  if (!/Customer\s+(Contact|Number|Name|Phone)\s*:/i.test(s)) return null;
  var r = parseSwoopEmail({ subject: 'New Review for ID #0000', bodyText: 'Driver: ' + s });
  return { driver: r.driver, contact: r.pickupContact, phone: r.pickupPhone };
}

module.exports = {
  splitLegacyDriver: splitLegacyDriver,
  SUBJECT_PREFIX: SUBJECT_PREFIX,
  parseSwoopEmail: parseSwoopEmail,
  parseScore: parseScore,
  easternDate: easternDate,
  npsBands: npsBands,
  complaintMaxScore: complaintMaxScore,
  npsFor: npsFor,
  npsSql: npsSql,
  resolveDriver: resolveDriver,
  getSetting: getSetting,
  DEFAULT_DETRACTOR_MAX: DEFAULT_DETRACTOR_MAX,
  DEFAULT_PASSIVE_MAX: DEFAULT_PASSIVE_MAX,
  DEFAULT_COMPLAINT_MAX: DEFAULT_COMPLAINT_MAX
};
