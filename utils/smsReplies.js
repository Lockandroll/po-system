// Routing a text reply to the thing it answers (Tony, 2026-10-11: "Can people
// reply to the text message and I work it through Nova?").
//
// Nova has ONE Twilio number. It sends 2FA codes, quiz reminders, customer
// feedback follow-ups, and memos and messages. When someone texts back, the
// reply has to land on the right thing. The rules, in order:
//
//   1. A tag in the text wins: MSG-2026-007 / MEMO-2026-004 (a memo or message)
//      or FB-1234 (a customer feedback record).
//   2. Otherwise the NEWEST reply-able text Nova sent to that phone in the last
//      REPLY_WINDOW_DAYS decides. Every such text is written to
//      sms_reply_targets: memos and messages explicitly (routes/memos.js), and
//      any text carrying an FB-1234 tag automatically (utils/sms.js calls
//      noteOutbound after a successful send).
//   3. Otherwise the text is kept in sms_unmatched, shown on Memos & Messaging >
//      Unmatched texts, instead of being dropped.
//
// STOP / HELP never reach this code: Twilio answers those itself.
// Everything here fails quietly (logs, never throws into a send path).
//
// House style: string concatenation only, no template literals.
var REPLY_WINDOW_DAYS = 7;

function db() { return require('../db').pool; }

// Last 10 digits, the same matching the feedback SMS handler always used.
function phoneKey(p) {
  var digits = String(p || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function record(phone, userId, kind, targetId) {
  var key = phoneKey(phone);
  if (!key || !targetId) return;
  try {
    await db().query('INSERT INTO sms_reply_targets (phone_key, user_id, kind, target_id) VALUES ($1,$2,$3,$4)',
      [key, userId || null, kind, targetId]);
  } catch (e) { console.error('[sms-replies] record failed:', e.message); }
}

// Called by utils/sms.js after every successful send. Only texts that carry a
// feedback tag are worth remembering; 2FA codes and reminders are not.
async function noteOutbound(phone, message) {
  var m = String(message || '').match(/\bFB-(\d+)\b/);
  if (!m) return;
  await record(phone, null, 'feedback', parseInt(m[1], 10));
}

// The newest reply-able text sent to this phone inside the window.
async function latestTarget(key) {
  if (!key) return null;
  var r = await db().query(
    'SELECT kind, target_id, sent_at FROM sms_reply_targets WHERE phone_key = $1 AND sent_at > NOW() - ($2 || \' days\')::interval ' +
    'ORDER BY sent_at DESC, id DESC LIMIT 1', [key, String(REPLY_WINDOW_DAYS)]);
  return r.rows[0] || null;
}

// A tag the person typed. Memo numbers look like MSG-2026-007; "MSG 7" or
// "msg-7" means number 7 of the current year.
function parseTag(body) {
  var s = String(body || '');
  var full = s.match(/\b(MSG|MEMO)[-\s]?(\d{4})[-\s](\d{1,4})\b/i);
  if (full) {
    var n = parseInt(full[3], 10);
    return { kind: 'memo', memo_no: full[1].toUpperCase() + '-' + full[2] + '-' + (n < 10 ? '00' : (n < 100 ? '0' : '')) + n };
  }
  var short = s.match(/\b(MSG|MEMO)[-\s]?(\d{1,4})\b/i);
  if (short) {
    var k = parseInt(short[2], 10);
    return { kind: 'memo', memo_no: short[1].toUpperCase() + '-' + new Date().getFullYear() + '-' + (k < 10 ? '00' : (k < 100 ? '0' : '')) + k };
  }
  var fb = s.match(/\bFB[-\s]?(\d+)\b/i);
  if (fb) return { kind: 'feedback', id: parseInt(fb[1], 10) };
  return null;
}

// "Got it" by text. Short, and nothing else in it: "got it, but which link?"
// is a question, not a confirmation, so it goes to the thread instead.
var AFFIRM = /^(got\s*it|gotit|ok(ay)?|k|kk|yes|yep|yup|y|done|will\s*do|on\s*it|roger|copy|10-4|understood|thanks|thank\s*you|ty)[\s.!]*$/i;
var THUMBS = /^[\s\u{1F44D}\u{1F3FB}-\u{1F3FF}\u{2705}\u{2714}\u{FE0F}\u{1F44C}]+$/u;
function isAffirmation(body) {
  var s = String(body || '').trim();
  if (!s) return false;
  if (/^Liked\s+["“].*["”]$/i.test(s)) return true; // iPhone "Liked ..." tapback arriving as text
  return AFFIRM.test(s) || THUMBS.test(s);
}

async function storeUnmatched(from, user, body, mediaCount, reason) {
  try {
    await db().query(
      'INSERT INTO sms_unmatched (from_number, phone_key, user_id, user_name, body, media_count, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [String(from || '').slice(0, 40), phoneKey(from), user ? user.id : null, user ? user.name : null,
        String(body || '').slice(0, 2000), mediaCount || 0, reason || null]);
  } catch (e) { console.error('[sms-replies] unmatched store failed:', e.message); }
}

module.exports = {
  REPLY_WINDOW_DAYS: REPLY_WINDOW_DAYS, phoneKey: phoneKey, record: record, noteOutbound: noteOutbound,
  latestTarget: latestTarget, parseTag: parseTag, isAffirmation: isAffirmation, storeUnmatched: storeUnmatched
};
