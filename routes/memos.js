// Company memos - one note and/or PDF, sent to many people at once, with a
// tracker of who viewed it and who signed it.
//
// First use (Tony, 2026-10-09): the new PTO policy, sent as the policy PDF with
// a one-line note ("Here is the updated PTO policy."), signature required, Nova
// locked until signed. Built so any memo works: a written memo, a PDF, or both.
//
// Two halves in one router:
//   /api/memos/...      the sender's side. manage_memos, which ships dark, so
//                       admin and owner only until a box is ticked.
//   /api/memos/me/...   the recipient's side. No permission: being on the
//                       recipient list IS the permission. These paths stay open
//                       while someone is locked (utils/memoLock.js pathIsOpen).
//   /api/memos/user/:id the memo copies inside someone's Employee File, behind
//                       the personnel-file rank rule (utils/org.js canOpenFile).
//
// Rules that run through the whole file:
//   1. A SENT MEMO NEVER CHANGES. The note, the written text and the PDF are
//      frozen at send, fingerprinted (content_hash), and every signature
//      stores the fingerprint it was given (signed_hash). A fix is a revision:
//      a new memo that supersedes the old one, which everybody signs again.
//   2. THE RECIPIENT LIST IS FROZEN AT SEND. One memo_recipients row per person,
//      so the tracker shows who it actually went to. The only later additions
//      are new hires on a memo sent with "also send to people hired later".
//   3. "VIEWED" MEANS OPENED IN NOVA. Not an email open (unreliable, and mail
//      scanners open everything). The client posts /me/:id/view when the memo
//      is on screen, and /me/:id/end when they reach the last page.
//   4. FEEDBACK NEVER TOUCHES WHAT WAS SIGNED. Questions and feedback (one
//      private thread per person per memo, memo_feedback) sit beside the
//      memo, never inside the fingerprint. Signing means "I received this";
//      the thread is where someone puts a question or a disagreement in
//      writing (Tony, 2026-10-09).
//
// MESSAGES (Tony, 2026-10-11: "Memos and Messaging"). A message is a memo row
// with kind = 'message': a short text note to one person or a few, numbered
// MSG-YYYY-NNN, sent by push and text (never email), with "Got it" instead of a
// signature by default. Techs can answer by TEXTING BACK: routes/inbound.js
// routes the reply here (handleTextReply). Managers can be given
// send_messages (dark), which lets them message people in their own cities only:
// no memos, no lock, no signature, no Everyone. The SEND gate below carries that
// scope; anything memo-only stays behind MANAGE.
//
// House style: string concatenation only, no template literals.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { userHasExtraPerm } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const org = require('../utils/org');
const r2 = require('../utils/r2');
const push = require('../utils/push');
const email = require('../utils/email');
const sms = require('../utils/sms');
const memoLock = require('../utils/memoLock');
const memoPdf = require('../utils/memoPdf');
const { getSetting } = require('../utils/security');
const vault = require('../utils/vaultAccess');
const policyVersions = require('../utils/policyVersions');
const smsReplies = require('../utils/smsReplies');

var DEFAULT_TYPES = ['Policy update', 'Schedule', 'Safety', 'Reminder', 'Announcement', 'Other'];
var ROLES = ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician', 'manager', 'admin', 'owner'];
var ROLE_LABELS = {
  locksmith: 'Locksmith', locksmith_coordinator: 'Locksmith Coordinator', dispatcher: 'Dispatcher',
  roadside_technician: 'Roadside Technician', manager: 'Manager', admin: 'Admin', owner: 'Owner'
};
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var MAX_SIGNATURE_CHARS = 400000;
var MAX_FEEDBACK_CHARS = 2000;
var MAX_FEEDBACK_PER_THREAD = 40;
// A message's text rides inside the SMS up to this many characters. Longer
// than that, the text says "the full message is in Nova", and a GOT IT by text
// does not count: they have not seen all of it.
var MESSAGE_SMS_CHARS = 300;
var MAX_MESSAGE_CHARS = 2000;

// ---------------------------------------------------------------- helpers

function clean(v, max) {
  if (v === null || v === undefined) return null;
  var s = String(v).trim();
  if (!s) return null;
  return max ? s.slice(0, max) : s;
}
function cleanDate(v) {
  var s = clean(v);
  return (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s : null;
}
function cleanTs(v) {
  var s = clean(v);
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function bool(v, dflt) {
  if (v === undefined || v === null) return dflt;
  return v === true || v === 'true' || v === 1 || v === '1';
}
function intId(v) { var n = parseInt(v, 10); return n > 0 ? n : 0; }
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function appUrl(path) { return (process.env.APP_URL || '').replace(/\/$/, '') + (path || ''); }
function ipOf(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || null; }
function dstr(v) {
  if (!v) return null;
  if (v instanceof Date) {
    var m = v.getMonth() + 1, d = v.getDate();
    return v.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }
  return String(v).slice(0, 10);
}
function longDate(s) {
  s = dstr(s); if (!s) return '';
  var p = s.split('-');
  var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return MON[Number(p[1]) - 1] + ' ' + Number(p[2]) + ', ' + p[0];
}
function deviceOf(ua) {
  ua = String(ua || '');
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'iPhone';
  if (/windows/i.test(ua)) return 'Windows';
  if (/mac os/i.test(ua)) return 'Mac';
  return ua ? 'Browser' : '';
}

async function logEvent(memoId, action, actor, userId, detail) {
  try {
    await pool.query(
      'INSERT INTO memo_events (memo_id, user_id, action, actor_id, actor_name, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [memoId, userId || null, action, actor ? actor.id : null, actor ? actor.name : 'Nova', detail ? JSON.stringify(detail) : null]
    );
  } catch (e) { console.error('[memos] event log failed:', e.message); }
}

async function loadMemo(id) {
  var r = await pool.query('SELECT * FROM memos WHERE id = $1', [intId(id)]);
  return r.rows[0] || null;
}

async function memoTypes() {
  try {
    var v = await getSetting('memo_types');
    var a = v ? JSON.parse(v) : null;
    if (Array.isArray(a) && a.length) return a.map(String);
  } catch (e) {}
  return DEFAULT_TYPES.slice();
}

// Admins and owners are LOCKED like everyone else (Tony, 2026-10-10: "I want
// admin and owner to also lock"). The person who SENDS the memo is still left
// off the list by default ("Leave me out"), so nobody is locked by their own
// memo. The way back, a settings flip rather than a deploy, is
// settings.memo_lock_admins = '0': admins and owners then get the banner
// instead of the lock on memos sent after that.
async function lockExemptRoles() {
  var v = await getSetting('memo_lock_admins');
  return v === '0' || v === 'false' ? ['admin', 'owner'] : [];
}

function ackText(memo) {
  if (memo.kind === 'message') {
    return memo.require_signature !== false ? 'By signing, I confirm that I received and read this message.' : 'I confirm that I received and read this message.';
  }
  var what = memo.file_name ? (memo.body ? 'this memo and the attached document (' + memo.file_name + ')' : 'the attached document (' + memo.file_name + ')') : 'this memo';
  var applies = memo.effective_date ? 'it applies to me starting ' + longDate(memo.effective_date) : 'it applies to me';
  if (memo.require_signature === false) return 'I confirm that I received and read ' + what + ', and that I understand ' + applies + '.';
  return 'By signing, I confirm that I received and read ' + what + ', and that I understand ' + applies + '.';
}

// The fingerprint every signature is tied to. Covers exactly what the person
// reads: the title, the note, the written memo, the effective date and the PDF
// bytes (by their own SHA-256).
function contentHash(m) {
  var o = {
    title: m.title || '', type: m.type || '', note: m.note || '', body: m.body || '',
    effective_date: dstr(m.effective_date) || '', file_sha256: m.file_sha256 || '',
    require_signature: m.require_signature !== false
  };
  // Only messages carry the extra keys, so every memo fingerprint stays exactly
  // what it was before messages existed.
  if (m.kind === 'message') { o.kind = 'message'; o.require_response = m.require_response !== false; }
  var basis = JSON.stringify(o);
  return crypto.createHash('sha256').update(basis).digest('hex');
}

// ---- who it goes to ---------------------------------------------------------

function normAudience(a) {
  a = (a && typeof a === 'object') ? a : {};
  var mode = ['all', 'cities', 'roles', 'people'].indexOf(a.mode) !== -1 ? a.mode : 'all';
  function arr(x) { return Array.isArray(x) ? x : []; }
  return {
    mode: mode,
    cities: arr(a.cities).map(function (c) { return String(c).toUpperCase().slice(0, 3); }).filter(Boolean),
    roles: arr(a.roles).map(String).filter(function (r) { return ROLES.indexOf(r) !== -1; }),
    user_ids: arr(a.user_ids).map(intId).filter(Boolean)
  };
}

// Everyone who CAN receive a memo: active, finished onboarding, and not on
// their way out (offboarding has its own paperwork, and a lock on someone in
// their last week would only get in the way of the property return).
var ELIGIBLE =
  'SELECT u.id, u.name, u.email, u.phone, u.role, u.home_city, u.receive_emails, u.receive_sms, u.created_at ' +
  'FROM users u WHERE u.active = true ' +
  "  AND COALESCE(u.onboarding_status, 'complete') = 'complete' " +
  '  AND COALESCE(u.offboarding_restricted, false) = false ';

async function resolveAudience(aud, opts, client) {
  opts = opts || {};
  var db = client || pool;
  var a = normAudience(aud);
  var sql = ELIGIBLE, params = [];
  if (a.mode === 'cities') { params.push(a.cities); sql += ' AND u.home_city = ANY($' + params.length + '::text[])'; }
  if (a.mode === 'roles') { params.push(a.roles); sql += ' AND u.role = ANY($' + params.length + '::text[])'; }
  if (a.mode === 'people') { params.push(a.user_ids); sql += ' AND u.id = ANY($' + params.length + '::int[])'; }
  if (opts.excludeId) { params.push(opts.excludeId); sql += ' AND u.id <> $' + params.length; }
  if (opts.createdAfter) { params.push(opts.createdAfter); sql += ' AND u.created_at > $' + params.length; }
  sql += ' ORDER BY u.name';
  return (await db.query(sql, params)).rows;
}

function audienceLabel(a) {
  a = normAudience(a);
  if (a.mode === 'cities') return a.cities.join(', ') || 'No locations';
  if (a.mode === 'roles') return a.roles.map(function (r) { return ROLE_LABELS[r] || r; }).join(', ') || 'No roles';
  if (a.mode === 'people') return a.user_ids.length + ' picked';
  return 'Everyone';
}

// ---- notifications ------------------------------------------------------------

function memoLink(memo) { return appUrl('/?view=my-memo&id=' + memo.id); }

// Push, email and text, each optional per memo and each honouring the
// person's own preferences (receive_emails / receive_sms) exactly the way every
// other notice in Nova does. Returns the channels actually attempted, which is
// what the tracker and the signed copy print as "delivered by".
// A MESSAGE is never emailed, and its text carries the message itself so it can
// be read (and answered) without opening Nova.
async function notifyOne(memo, u, isReminder) {
  var via = ['Nova'];
  var isMsg = memo.kind === 'message';
  var verb = memo.require_signature !== false ? 'read and sign' : 'read';
  var who = memo.sent_by_name || 'Nova';
  var title = isMsg
    ? ((isReminder ? 'Reminder: message from ' : 'Message from ') + who + ': ' + memo.title)
    : ((isReminder ? 'Reminder: ' : 'New memo: ') + memo.title);
  if (memo.notify_push !== false && push.isReady()) {
    try {
      await push.sendPushToUsers([u.id], { title: title, body: isMsg ? snippet(memo.body || memo.note, 140) : ('From ' + who + '. Please ' + verb + ' it in Nova.'), url: '/?view=my-memo&id=' + memo.id });
      via.push('push');
    } catch (e) {}
  }
  if (!isMsg && memo.notify_email !== false && u.email && u.receive_emails !== false) {
    try {
      var body = '<p>' + esc(who) + ' sent you a memo' + (memo.sign_by ? ', due ' + esc(longDate(memo.sign_by)) : '') + '.</p>' +
        (memo.note ? '<p style="font-style:italic">&ldquo;' + esc(memo.note) + '&rdquo;</p>' : '') +
        '<p>Please ' + verb + ' it in Nova.' + (memo.lock_until_done ? ' Nova will ask you to do this before anything else.' : '') + '</p>';
      await email.sendEmail(u.email, title, email.emailTemplate({
        badge: 'Memo', title: title, body: body, buttonText: 'Open the memo', buttonUrl: memoLink(memo)
      }));
      via.push('email');
    } catch (e) { console.error('[memos] email failed:', e.message); }
  }
  if (memo.notify_sms !== false && u.phone && u.receive_sms) {
    try {
      var txt = isMsg ? messageSms(memo, isReminder)
        : 'Nova: ' + (isReminder ? 'reminder, ' : '') + 'new memo from ' + who + ': "' + memo.title + '". Please ' + verb + ' it in Nova: ' + memoLink(memo);
      await sms.sendSms(u.phone, txt);
      via.push('text');
      // So a text back lands on this memo (utils/smsReplies.js).
      await smsReplies.record(u.phone, u.id, 'memo', memo.id);
    } catch (e) { console.error('[memos] sms failed:', e.message); }
  }
  return via;
}

// The text for a message: who, subject, the message itself (trimmed), and what
// to do, which depends on what the sender asked for.
function messageSms(memo, isReminder) {
  var who = memo.sent_by_name || 'Nova';
  var text = String(memo.body || memo.note || '').trim();
  var long = text.length > MESSAGE_SMS_CHARS;
  var cut = long ? text.slice(0, MESSAGE_SMS_CHARS - 3).replace(/\s+\S*$/, '') + '...' : text;
  var replies = memo.allow_feedback !== false;
  var how;
  if (memo.require_signature !== false) how = 'This one needs your signature in Nova:';
  else if (long) how = 'The full message is in Nova' + (replies ? ' (or reply here with a question):' : ':');
  else if (memo.require_response === false) how = replies ? 'Reply here with any question. Open in Nova:' : 'Open in Nova:';
  else how = replies ? 'Text back GOT IT, or reply with a question. Open in Nova:' : 'Text back GOT IT. Open in Nova:';
  return (isReminder ? 'Reminder - ' : '') + 'Message from ' + who + ': ' + memo.title + '\n\n' + cut + '\n\n' + how + ' ' + memoLink(memo);
}

async function deliverAll(memo, users) {
  for (var i = 0; i < users.length; i++) {
    var via = await notifyOne(memo, users[i], false);
    try {
      await pool.query('UPDATE memo_recipients SET delivered_via = $3 WHERE memo_id = $1 AND user_id = $2',
        [memo.id, users[i].id, via.join(', ')]);
    } catch (e) {}
  }
}

// ---- reading counts -----------------------------------------------------------

// A thread is unread for the managers when the employee wrote after a manager
// last opened it, and unread for the employee when a manager replied after they
// last opened it.
var FB_UNREAD = 'r.last_feedback_at IS NOT NULL AND (r.feedback_staff_seen_at IS NULL OR r.last_feedback_at > r.feedback_staff_seen_at)';
var FB_REPLY_UNREAD = 'r.last_reply_at IS NOT NULL AND (r.feedback_user_seen_at IS NULL OR r.last_reply_at > r.feedback_user_seen_at)';

var COUNTS_SQL =
  'COUNT(r.id)::int AS total,' +
  ' COUNT(r.first_viewed_at)::int AS viewed,' +
  ' COUNT(r.completed_at)::int AS completed,' +
  ' COUNT(r.excused_at) FILTER (WHERE r.completed_at IS NULL)::int AS excused,' +
  " COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.status = 'sent' AND m.lock_until_done AND r.lock_exempt = false AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()))::int AS locked," +
  " COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.sign_by IS NOT NULL AND m.sign_by < CURRENT_DATE)::int AS overdue," +
  ' COUNT(r.id) FILTER (WHERE r.feedback_count > 0)::int AS feedback,' +
  ' COUNT(r.id) FILTER (WHERE ' + FB_UNREAD + ')::int AS feedback_unread';

function recipientStatus(r, memo) {
  if (r.completed_at) return r.completion === 'acknowledged' ? 'acknowledged' : (r.completion === 'read' ? 'read' : 'signed');
  if (r.excused_at) return 'excused';
  if (r.first_viewed_at) return 'viewed';
  return 'not_opened';
}

function memoSummary(m) {
  return {
    id: m.id, memo_no: m.memo_no, kind: m.kind === 'message' ? 'message' : 'memo', type: m.type, title: m.title, note: m.note, body: m.body,
    require_response: m.require_response !== false, file_to_record: m.file_to_record !== false, created_by: m.created_by || null,
    effective_date: dstr(m.effective_date), sign_by: dstr(m.sign_by),
    file_name: m.file_name, file_size: m.file_size, file_pages: m.file_pages, has_file: !!m.file_key,
    source_document_id: m.source_document_id || null,
    require_signature: m.require_signature !== false, lock_until_done: !!m.lock_until_done,
    lock_starts_at: m.lock_starts_at, audience: normAudience(m.audience), audience_label: audienceLabel(m.audience),
    include_future_hires: !!m.include_future_hires, exclude_sender: m.exclude_sender !== false,
    notify_push: m.notify_push !== false, notify_sms: m.notify_sms !== false, notify_email: m.notify_email !== false,
    remind_every_days: m.remind_every_days, allow_feedback: m.allow_feedback !== false, status: m.status, content_hash: m.content_hash,
    supersedes_id: m.supersedes_id, superseded_by_id: m.superseded_by_id,
    created_by_name: m.created_by_name, sent_by_name: m.sent_by_name, sent_at: m.sent_at,
    withdrawn_at: m.withdrawn_at, withdrawn_by_name: m.withdrawn_by_name, withdrawn_reason: m.withdrawn_reason,
    scheduled_send_at: m.scheduled_send_at, scheduled_by_name: m.scheduled_by_name,
    created_at: m.created_at, updated_at: m.updated_at, ack_text: ackText(m)
  };
}

// ---- questions and feedback --------------------------------------------------------

async function feedbackThread(memoId, userId) {
  return (await pool.query(
    'SELECT id, author_id, author_name, from_staff, body, created_at, via FROM memo_feedback ' +
    'WHERE memo_id = $1 AND user_id = $2 ORDER BY created_at, id', [memoId, userId])).rows;
}

function snippet(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '...' : s;
}

// Who hears about new feedback: whoever sent the memo, plus anyone listed in
// the memo_feedback_notify setting (comma-separated user ids), so an HR person
// can be added without a deploy. If none of them is active any more, every
// active admin and owner, so a question is never sent into nobody.
async function feedbackWatchers(memo, excludeId) {
  var ids = [];
  if (memo.sent_by) ids.push(Number(memo.sent_by));
  else if (memo.created_by) ids.push(Number(memo.created_by));
  try {
    String((await getSetting('memo_feedback_notify')) || '').split(',').forEach(function (x) {
      var n = parseInt(x, 10); if (n > 0 && ids.indexOf(n) === -1) ids.push(n);
    });
  } catch (e) {}
  var cols = 'SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE active = true ';
  var users = ids.length ? (await pool.query(cols + 'AND id = ANY($1::int[])', [ids])).rows : [];
  if (!users.length) users = (await pool.query(cols + "AND role IN ('admin','owner')")).rows;
  return users.filter(function (u) { return u.id !== excludeId; });
}

// An employee wrote: tell the watchers by push and email. No text message - a
// question is not urgent enough to buzz someone's phone at 11 PM.
async function notifyFeedback(memo, author, text) {
  var users = await feedbackWatchers(memo, author.id);
  var title = 'Feedback on memo: ' + memo.title;
  var url = '/?view=memo&id=' + memo.id + '_' + author.id;
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    if (push.isReady()) {
      try { await push.sendPushToUsers([u.id], { title: title, body: author.name + ': ' + snippet(text, 140), url: url }); } catch (e) {}
    }
    if (u.email && u.receive_emails !== false) {
      try {
        await email.sendEmail(u.email, title, email.emailTemplate({
          badge: 'Memo feedback', title: author.name + ' left feedback',
          body: '<p>On <b>' + esc(memo.memo_no || '') + ' ' + esc(memo.title) + '</b>:</p>' +
            '<p style="white-space:pre-wrap;border-left:3px solid #f97316;padding-left:12px">' + esc(text) + '</p>' +
            '<p>Only you and the people who manage memos can see this. Reply from the memo tracker in Nova.</p>',
          buttonText: 'Reply in Nova', buttonUrl: appUrl(url)
        }));
      } catch (e) { console.error('[memos] feedback email failed:', e.message); }
    }
  }
  return users.length;
}

// A manager replied: tell the employee by push and email, honouring their own
// email setting like every other notice.
async function notifyReply(memo, uid, replier, text, opts) {
  opts = opts || {};
  var u = (await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms, active FROM users WHERE id = $1', [uid])).rows[0];
  if (!u || u.active === false) return { texted: false };
  var title = (memo.kind === 'message' ? 'Reply about message: ' : 'Reply about memo: ') + memo.title;
  // They wrote in by text, so the answer goes back the same way. Texts honour
  // their own receive_sms switch only for broadcasts; a direct answer to a text
  // they sent is always allowed to come back as a text.
  var texted = false;
  if (opts.byText && u.phone) {
    try {
      await sms.sendSms(u.phone, replier.name + ': ' + String(text).slice(0, 600));
      await smsReplies.record(u.phone, u.id, 'memo', memo.id);
      texted = true;
    } catch (e) { console.error('[memos] reply text failed:', e.message); }
  }
  if (push.isReady()) {
    try { await push.sendPushToUsers([u.id], { title: title, body: replier.name + ': ' + snippet(text, 140), url: '/?view=my-memo&id=' + memo.id }); } catch (e) {}
  }
  if (memo.kind !== 'message' && u.email && u.receive_emails !== false) {
    try {
      await email.sendEmail(u.email, title, email.emailTemplate({
        badge: 'Memo', title: replier.name + ' replied',
        body: '<p>About <b>' + esc(memo.title) + '</b>:</p>' +
          '<p style="white-space:pre-wrap;border-left:3px solid #f97316;padding-left:12px">' + esc(text) + '</p>',
        buttonText: 'Open the memo', buttonUrl: memoLink(memo)
      }));
    } catch (e) { console.error('[memos] reply email failed:', e.message); }
  }
  return { texted: texted };
}

function threadOut(rows) {
  return rows.map(function (f) {
    return { id: f.id, author_name: f.author_name, from_staff: !!f.from_staff, body: f.body, created_at: f.created_at, via: f.via || null };
  });
}

// ---- the PDF itself -------------------------------------------------------------
// Forty people opening the same policy within a few minutes would be forty R2
// reads of the same bytes. A tiny in-process cache keyed by the R2 key (which
// never changes for a given upload) makes it one.
var _fileCache = new Map();
async function fileBuffer(memo) {
  if (!memo || !memo.file_key) return null;
  if (_fileCache.has(memo.file_key)) return _fileCache.get(memo.file_key);
  var buf = await r2.getObjectBuffer(memo.file_key);
  _fileCache.set(memo.file_key, buf);
  if (_fileCache.size > 6) _fileCache.delete(_fileCache.keys().next().value);
  return buf;
}

async function companyInfo() {
  return {
    name: (await getSetting('company_name')) || 'Lock and Roll LLC',
    line: (await getSetting('memo_company_line')) || 'Pop-A-Lock · 589 Dorset Court, Mount Dora, FL 32757'
  };
}

async function signedCopyBuffer(memo, rcp) {
  var fromTitle = null;
  if (memo.sent_by) {
    try { var su = await pool.query('SELECT title, role FROM users WHERE id = $1', [memo.sent_by]); if (su.rows[0]) fromTitle = su.rows[0].title || null; } catch (e) {}
  }
  var fb = memo.file_key ? await fileBuffer(memo) : null;
  var thread = [];
  try { thread = await feedbackThread(memo.id, rcp.user_id); } catch (e) {}
  return memoPdf.buildSignedCopy(memo, Object.assign({}, rcp, {
    user_role_label: ROLE_LABELS[rcp.user_role] || rcp.user_role || '',
    device: deviceOf(rcp.user_agent)
  }), { company: await companyInfo(), ackText: ackText(memo), fromTitle: fromTitle, fileBuffer: fb, feedback: thread });
}

function pdfName(memo, who) {
  var base = (memo.memo_no || ('memo-' + memo.id)) + (who ? '-' + who : '');
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-') + '.pdf';
}

// =============================================================================
//  RECIPIENT SIDE  (/me)  - no permission; being a recipient is the gate.
//  Declared FIRST so '/me/...' is never swallowed by '/:id'.
// =============================================================================

var MY_SQL =
  'SELECT m.*, r.id AS rid, r.first_viewed_at, r.last_viewed_at, r.view_count, r.reached_end_at, r.completed_at, ' +
  ' r.completion, r.completed_via, r.last_feedback_via, r.excused_at, r.lock_exempt, r.delivered_at, r.signature_name, r.feedback_count, r.last_reply_at, ' +
  ' (' + FB_REPLY_UNREAD + ') AS reply_unread ' +
  'FROM memo_recipients r JOIN memos m ON m.id = r.memo_id ';

function myView(row) {
  var s = memoSummary(row);
  var lockActive = row.status === 'sent' && !!row.lock_until_done && !row.lock_exempt &&
    (!row.lock_starts_at || new Date(row.lock_starts_at) <= new Date());
  return Object.assign(s, {
    my: {
      first_viewed_at: row.first_viewed_at, view_count: row.view_count, reached_end_at: row.reached_end_at,
      completed_at: row.completed_at, completion: row.completion, completed_via: row.completed_via || null, excused_at: row.excused_at,
      delivered_at: row.delivered_at, signature_name: row.signature_name,
      feedback_count: row.feedback_count || 0, unread_replies: !!row.reply_unread,
      can_feedback: row.allow_feedback !== false && row.status === 'sent',
      open: !row.completed_at && !row.excused_at && row.status === 'sent',
      locks_me: lockActive && !row.completed_at && !row.excused_at
    }
  });
}

// The memo locking this person out right now, if any. The lock screen asks
// this once per page load. Read straight from the tables (not the cached map)
// so it is never a few seconds stale for the one person looking at it.
router.get('/me/lock', requireAuth, async (req, res) => {
  try {
    var exempt = false;
    var r = await pool.query(MY_SQL +
      "WHERE r.user_id = $1 AND m.status = 'sent' AND m.lock_until_done = true AND r.lock_exempt = false " +
      ' AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()) AND r.completed_at IS NULL AND r.excused_at IS NULL ' +
      'ORDER BY m.sent_at ASC, m.id ASC LIMIT 1', [req.user.id]);
    res.json({ memo: r.rows[0] ? myView(r.rows[0]) : null, exempt: exempt });
  } catch (e) {
    // Fail open, same as the gate: a broken lookup must not lock anyone out.
    res.json({ memo: null });
  }
});

// Open memos for the Home banner and the sidebar. Reads and writes nothing
// else - drawing a banner must never count as having viewed the memo.
router.get('/me/pending', requireAuth, async (req, res) => {
  try {
    var r = await pool.query(MY_SQL +
      "WHERE r.user_id = $1 AND m.status = 'sent' AND r.completed_at IS NULL AND r.excused_at IS NULL " +
      'ORDER BY m.sent_at ASC', [req.user.id]);
    // Memos where a manager answered their question and they have not read it.
    var rp = await pool.query(MY_SQL + "WHERE r.user_id = $1 AND m.status <> 'draft' AND " + FB_REPLY_UNREAD + ' ORDER BY r.last_reply_at DESC LIMIT 5', [req.user.id]);
    res.json({ memos: r.rows.map(myView), replies: rp.rows.map(myView) });
  } catch (e) {
    res.json({ memos: [], replies: [] });
  }
});

// Everything ever sent to me, for My File.
router.get('/me', requireAuth, async (req, res) => {
  try {
    var r = await pool.query(MY_SQL +
      "WHERE r.user_id = $1 AND m.status <> 'draft' ORDER BY m.sent_at DESC, m.id DESC", [req.user.id]);
    res.json({ memos: r.rows.map(myView) });
  } catch (e) {
    console.error('[memos] me failed:', e);
    res.status(500).json({ error: 'Could not load your memos.' });
  }
});

async function myRow(req) {
  var r = await pool.query(MY_SQL + "WHERE r.user_id = $1 AND m.id = $2 AND m.status <> 'draft'", [req.user.id, intId(req.params.id)]);
  return r.rows[0] || null;
}

router.get('/me/:id', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  res.json({ memo: myView(row) });
});

// The PDF itself, as base64 JSON so the client's api() wrapper carries the
// session like every other call and the lock screen can render it with pdf.js.
router.get('/me/:id/file', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (!row.file_key) return res.status(404).json({ error: 'This memo has no document.' });
  try {
    var buf = await fileBuffer(row);
    res.json({ filename: row.file_name, mime: 'application/pdf', data: buf.toString('base64') });
  } catch (e) {
    console.error('[memos] file read failed:', e.message);
    res.status(502).json({ error: 'Could not load the document. Try again in a moment.' });
  }
});

// Stamp a view. Called by the client when the memo is actually on screen.
router.post('/me/:id/view', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  // A message is short and has no pages, so being on screen IS reading it to
  // the end. A "Just read it" message is done the moment it is opened.
  var isMsg = row.kind === 'message';
  await pool.query(
    'UPDATE memo_recipients SET first_viewed_at = COALESCE(first_viewed_at, NOW()), last_viewed_at = NOW(), view_count = view_count + 1' +
    (isMsg ? ', reached_end_at = COALESCE(reached_end_at, NOW())' : '') + ' WHERE id = $1',
    [row.rid]);
  if (!row.first_viewed_at) await logEvent(row.id, 'viewed', req.user, req.user.id);
  var done = null;
  if (row.status === 'sent' && row.require_response === false && !row.completed_at && !row.excused_at) {
    done = await markDone(row, 'read', { actor: req.user, ip: ipOf(req), ua: clean(req.headers['user-agent'], 400) });
  }
  res.json({ success: true, completed_at: done });
});

// They reached the last page. Signing needs this when there is anything to read.
router.post('/me/:id/end', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  var r = await pool.query('UPDATE memo_recipients SET reached_end_at = COALESCE(reached_end_at, NOW()), ' +
    'first_viewed_at = COALESCE(first_viewed_at, NOW()) WHERE id = $1 RETURNING reached_end_at', [row.rid]);
  if (!row.reached_end_at) await logEvent(row.id, 'read_to_end', req.user, req.user.id);
  res.json({ success: true, reached_end_at: r.rows[0] && r.rows[0].reached_end_at });
});

async function complete(req, res, kind) {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (row.status !== 'sent') {
    return res.status(409).json({ error: row.status === 'superseded'
      ? 'This memo was replaced by a newer version. Open the new one to sign it.'
      : 'This memo was withdrawn and no longer needs a signature.' });
  }
  if (row.completed_at) return res.status(409).json({ error: 'You already ' + (row.completion === 'acknowledged' ? 'acknowledged' : 'signed') + ' this memo.' });
  var needsSig = row.require_signature !== false;
  if (kind === 'acknowledged' && needsSig) return res.status(400).json({ error: 'This memo needs your signature.' });
  if (kind === 'signed' && !needsSig) return res.status(400).json({ error: 'This memo only needs you to confirm you read it.' });
  // A message has no pages: on screen is read. Everything else must be read to the end.
  if (row.kind !== 'message' && (row.file_key || row.body) && !row.reached_end_at) {
    return res.status(409).json({ error: 'Read to the end of the memo first.', need_end: true });
  }
  var b = req.body || {};
  var typed = null, drawn = null;
  if (kind === 'signed') {
    typed = clean(b.typed_name, 160);
    drawn = clean(b.signature_data, MAX_SIGNATURE_CHARS);
    if (!typed || typed.length < 2) return res.status(400).json({ error: 'Type your full name.' });
    if (!drawn || drawn.indexOf('data:image/') !== 0) return res.status(400).json({ error: 'Sign in the box.' });
  }
  var at = await markDone(row, kind, { typed: typed, drawn: drawn, ip: ipOf(req), ua: clean(req.headers['user-agent'], 400), actor: req.user });
  if (!at) return res.status(409).json({ error: 'Already done.' });
  res.json({ success: true, completed_at: at });
}

// The one place a recipient row becomes done: signed / acknowledged (Got it)
// / read. Used by the buttons in Nova, by opening a "Just read it" message, and
// by a GOT IT texted back (via = 'sms'). Returns the completion time, or null
// when it was already done.
async function markDone(row, kind, o) {
  o = o || {};
  var actor = o.actor || { id: row.user_id || null, name: 'Nova' };
  var upd = await pool.query(
    'UPDATE memo_recipients SET completed_at = NOW(), completion = $2, signature_name = $3, signature_data = $4, ' +
    ' signature_ip = $5, user_agent = $6, signed_hash = $7, completed_via = $8::varchar, ' +
    // Answering by text is not opening it in Nova, so "Seen" stays honest.
    " first_viewed_at = CASE WHEN $8::varchar = 'sms' THEN first_viewed_at ELSE COALESCE(first_viewed_at, NOW()) END " +
    'WHERE id = $1 AND completed_at IS NULL RETURNING completed_at',
    [row.rid, kind, o.typed || null, o.drawn || null, o.ip || null, o.ua || null, row.content_hash, o.via || null]);
  if (!upd.rows.length) return null;
  memoLock.invalidate();
  await logEvent(row.id, kind, actor, actor.id, { ip: o.ip || null, device: deviceOf(o.ua), via: o.via || 'nova' });
  await logAudit({
    entity_type: 'memo', entity_id: row.id, entity_number: row.memo_no, action: 'memo_' + kind,
    user_id: actor.id, user_name: actor.name, ip: o.ip || null, details: { title: row.title, content_hash: row.content_hash, via: o.via || 'nova' }
  });
  return upd.rows[0].completed_at;
}

router.post('/me/:id/sign', requireAuth, function (req, res) { return complete(req, res, 'signed'); });
router.post('/me/:id/acknowledge', requireAuth, function (req, res) { return complete(req, res, 'acknowledged'); });

router.get('/me/:id/pdf', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  var rr = await pool.query('SELECT * FROM memo_recipients WHERE id = $1', [row.rid]);
  var rcp = rr.rows[0];
  if (!rcp || !rcp.completed_at) return res.status(409).json({ error: 'Your copy is ready once you have signed it.' });
  try {
    var buf = await signedCopyBuffer(row, rcp);
    res.json({ filename: pdfName(row, rcp.user_name), mime: 'application/pdf', data: buf.toString('base64') });
  } catch (e) {
    console.error('[memos] my pdf failed:', e);
    res.status(500).json({ error: 'Could not build the PDF.' });
  }
});

// ---- my questions and feedback ------------------------------------------------
// Open while locked (the /api/memos/me prefix), so a question can be asked
// before signing. Never blocks signing and never changes the signed copy.

router.get('/me/:id/feedback', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  var thread = await feedbackThread(row.id, req.user.id);
  await pool.query('UPDATE memo_recipients SET feedback_user_seen_at = NOW() WHERE id = $1', [row.rid]);
  res.json({ thread: threadOut(thread), can_feedback: row.allow_feedback !== false && row.status === 'sent' });
});

router.post('/me/:id/feedback', requireAuth, async (req, res) => {
  var row = await myRow(req);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (row.allow_feedback === false) return res.status(403).json({ error: 'Feedback is turned off for this memo.' });
  if (row.status !== 'sent') return res.status(409).json({ error: 'This memo is closed, so feedback is off. Talk to your manager directly.' });
  var text = clean((req.body || {}).body, MAX_FEEDBACK_CHARS + 1);
  if (!text) return res.status(400).json({ error: 'Write something first.' });
  if (text.length > MAX_FEEDBACK_CHARS) return res.status(400).json({ error: 'Keep it under ' + MAX_FEEDBACK_CHARS + ' characters.' });
  if ((row.feedback_count || 0) >= MAX_FEEDBACK_PER_THREAD) return res.status(429).json({ error: 'That is a lot of messages on one memo. Talk to your manager directly.' });
  await pool.query('INSERT INTO memo_feedback (memo_id, user_id, author_id, author_name, from_staff, body) VALUES ($1,$2,$2,$3,false,$4)',
    [row.id, req.user.id, req.user.name, text]);
  await pool.query('UPDATE memo_recipients SET feedback_count = feedback_count + 1, last_feedback_at = NOW(), feedback_user_seen_at = NOW(), last_feedback_via = NULL WHERE id = $1', [row.rid]);
  await logEvent(row.id, 'feedback', req.user, req.user.id);
  var told = 0;
  try { told = await notifyFeedback(row, { id: req.user.id, name: req.user.name }, text); } catch (e) { console.error('[memos] feedback notify failed:', e.message); }
  res.json({ success: true, thread: threadOut(await feedbackThread(row.id, req.user.id)), notified: told });
});

// =============================================================================
//  EMPLOYEE FILE  (/user/:uid)  - the memo copies inside someone's file.
// =============================================================================

async function hasAnyPerm(req, perms) {
  for (var i = 0; i < perms.length; i++) {
    if (await permissions.hasPermission(req.user.role, perms[i])) return true;
    if (await userHasExtraPerm(req, req.user.id, perms[i])) return true;
  }
  return false;
}

// Whoever can open the file can see the memos in it - and nobody else. The
// rank rule (nobody opens a peer's file, not even admin to admin) comes first,
// then one of the permissions that already opens Employee Files.
async function canOpenUserFile(req, uid) {
  var tu = await pool.query('SELECT id, role FROM users WHERE id = $1', [uid]);
  if (!tu.rows.length) return { ok: false, code: 404 };
  if (!(await org.canOpenFile(req.user, tu.rows[0]))) return { ok: false, code: 403 };
  if (!(await hasAnyPerm(req, ['manage_memos', 'manage_onboarding', 'view_employee_records']))) return { ok: false, code: 403 };
  return { ok: true };
}

router.get('/user/:uid', requireAuth, async (req, res) => {
  var uid = intId(req.params.uid);
  var g = await canOpenUserFile(req, uid);
  if (!g.ok) return res.status(g.code).json({ error: g.code === 404 ? 'Not found.' : 'You cannot open that file.' });
  // A message sent with "File in Employee File" off (small stuff: "the keys are
  // at the office") stays out of the file. It is still in their own My File.
  var r = await pool.query(MY_SQL + "WHERE r.user_id = $1 AND m.status <> 'draft' AND m.file_to_record IS NOT FALSE ORDER BY m.sent_at DESC, m.id DESC", [uid]);
  // Their feedback threads ride along, read-only: the file shows the whole
  // conversation, and replying happens on the memo tracker.
  var fb = (await pool.query('SELECT memo_id, id, author_id, author_name, from_staff, body, created_at, via FROM memo_feedback WHERE user_id = $1 ORDER BY created_at, id', [uid])).rows;
  var by = {};
  fb.forEach(function (f) { (by[f.memo_id] = by[f.memo_id] || []).push(f); });
  res.json({ memos: r.rows.map(function (row) { var v = myView(row); v.feedback = threadOut(by[row.id] || []); return v; }) });
});

router.get('/user/:uid/:id/pdf', requireAuth, async (req, res) => {
  var uid = intId(req.params.uid);
  var g = await canOpenUserFile(req, uid);
  if (!g.ok) return res.status(g.code).json({ error: g.code === 404 ? 'Not found.' : 'You cannot open that file.' });
  return sendSignedCopy(req, res, intId(req.params.id), uid);
});

async function sendSignedCopy(req, res, memoId, uid) {
  var memo = await loadMemo(memoId);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  var rr = await pool.query('SELECT * FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memo.id, uid]);
  var rcp = rr.rows[0];
  if (!rcp) return res.status(404).json({ error: 'Not found.' });
  if (!rcp.completed_at) return res.status(409).json({ error: rcp.user_name + ' has not signed this memo yet.' });
  try {
    var buf = await signedCopyBuffer(memo, rcp);
    await logEvent(memo.id, 'exported_copy', req.user, uid);
    res.json({ filename: pdfName(memo, rcp.user_name), mime: 'application/pdf', data: buf.toString('base64') });
  } catch (e) {
    console.error('[memos] signed copy failed:', e);
    res.status(500).json({ error: 'Could not build the PDF.' });
  }
}

// =============================================================================
//  SENDER SIDE  - manage_memos (dark: admin and owner only for now)
// =============================================================================

var MANAGE = [requireAuth, requirePermission('manage_memos')];

// Who may SEND, and to whom. manage_memos: everything, as before.
// send_messages (dark, 2026-10-11): messages only, to people whose home city is
// one of the cities this person manages (user_cities; their own home city if
// they have none). Every route behind SEND checks canTouch() for the record and
// checkScope() for the audience, so the limits hold even against a hand-made
// request.
async function sendScope(req) {
  if (await hasAnyPerm(req, ['manage_memos'])) return { full: true, cities: null };
  if (!(await hasAnyPerm(req, ['send_messages']))) return null;
  var c = (await pool.query('SELECT city_code FROM user_cities WHERE user_id = $1', [req.user.id])).rows
    .map(function (x) { return String(x.city_code || '').trim().toUpperCase(); }).filter(Boolean);
  if (!c.length) {
    var h = (await pool.query('SELECT home_city FROM users WHERE id = $1', [req.user.id])).rows[0];
    if (h && h.home_city) c = [String(h.home_city).trim().toUpperCase()];
  }
  return { full: false, cities: c };
}
async function sendGate(req, res, next) {
  var sc = await sendScope(req);
  if (!sc) return res.status(403).json({ error: 'You do not have permission to do that.' });
  req.memoScope = sc;
  next();
}
var SEND = [requireAuth, sendGate];
function canTouch(req, memo) {
  if (!memo) return false;
  if (req.memoScope && req.memoScope.full) return true;
  return memo.kind === 'message' && Number(memo.created_by) === Number(req.user.id);
}
// Fields a scoped sender may never set, whatever the request says.
function scopeFields(req, f, creating) {
  if (req.memoScope && req.memoScope.full) return f;
  if (creating || f.kind !== undefined) f.kind = 'message';
  if (f.lock_until_done !== undefined || creating) f.lock_until_done = false;
  if (f.require_signature !== undefined || creating) f.require_signature = false;
  if (f.include_future_hires !== undefined || creating) f.include_future_hires = false;
  if (f.audience !== undefined) {
    var a = normAudience(JSON.parse(f.audience));
    f.audience = JSON.stringify({ mode: 'people', cities: [], roles: [], user_ids: a.mode === 'people' ? a.user_ids : [] });
  }
  return f;
}
// Everyone a scoped sender's audience reaches must live in one of their cities.
function scopeProblem(scope, memo, users) {
  if (!scope || scope.full) return null;
  if (memo.kind !== 'message') return 'You can send messages, not memos.';
  if (normAudience(memo.audience).mode !== 'people') return 'Pick the people this message is for.';
  if (memo.lock_until_done || memo.require_signature !== false) return 'Messages you send cannot lock Nova or ask for a signature.';
  var out = users.filter(function (u) { return scope.cities.indexOf(String(u.home_city || '').trim().toUpperCase()) === -1; });
  if (out.length) return 'You can only message people in your cities (' + (scope.cities.join(', ') || 'none set') + '). Not: ' + out.map(function (u) { return u.name; }).join(', ') + '.';
  return null;
}

router.get('/meta', SEND, async (req, res) => {
  var sc = req.memoScope;
  var cities = (await pool.query('SELECT code, name FROM cities WHERE active = true ORDER BY name')).rows;
  var plist = (await pool.query(ELIGIBLE + ' ORDER BY u.name')).rows;
  if (!sc.full) plist = plist.filter(function (u) { return sc.cities.indexOf(String(u.home_city || '').trim().toUpperCase()) !== -1; });
  var people = plist.map(function (u) {
    return { id: u.id, name: u.name, role: u.role, role_label: ROLE_LABELS[u.role] || u.role, city: u.home_city,
      has_phone: !!(u.phone && u.receive_sms), has_email: !!(u.email && u.receive_emails !== false) };
  });
  res.json({
    types: await memoTypes(),
    cities: cities,
    roles: ROLES.map(function (r) { return { key: r, label: ROLE_LABELS[r] }; }),
    people: people,
    lock_exempt_roles: await lockExemptRoles(),
    r2_ready: r2.configured(),
    max_file_mb: Math.round(MAX_FILE_BYTES / 1048576),
    scope: { full: sc.full, cities: sc.cities },
    message_sms_chars: MESSAGE_SMS_CHARS, max_message_chars: MAX_MESSAGE_CHARS
  });
});

// Top-of-page numbers for the Memos & Messaging screen. ?kind=memo|message
// filters. A scoped sender (send_messages) sees only the messages they wrote.
router.get('/', SEND, async (req, res) => {
  var sc = req.memoScope;
  var where = [], params = [];
  var kind = String(req.query.kind || '');
  if (kind === 'memo' || kind === 'message') { params.push(kind); where.push("COALESCE(m.kind, 'memo') = $" + params.length); }
  if (!sc.full) { params.push(req.user.id); where.push("m.kind = 'message' AND m.created_by = $" + params.length); }
  var rows = (await pool.query(
    'SELECT m.*, ' + COUNTS_SQL + ', ' +
    ' (SELECT string_agg(x.user_name, \', \') FROM (SELECT user_name FROM memo_recipients WHERE memo_id = m.id ORDER BY user_name LIMIT 4) x) AS to_names,' +
    " COUNT(r.id) FILTER (WHERE r.completed_via = 'sms')::int AS by_text," +
    ' MAX(r.completed_at) AS last_completed_at, MAX(r.first_viewed_at) AS last_viewed_at ' +
    'FROM memos m LEFT JOIN memo_recipients r ON r.memo_id = m.id ' +
    (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
    'GROUP BY m.id ORDER BY COALESCE(m.sent_at, m.updated_at) DESC, m.id DESC', params)).rows;
  var sp = [], sw = '';
  if (!sc.full) { sp.push(req.user.id); sw = " AND m.kind = 'message' AND m.created_by = $1"; }
  var stats = (await pool.query(
    "SELECT COUNT(DISTINCT m.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND COALESCE(m.kind, 'memo') = 'memo')::int AS open_memos," +
    ' COUNT(DISTINCT r.user_id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL)::int AS people_outstanding,' +
    ' COUNT(DISTINCT r.user_id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.lock_until_done AND r.lock_exempt = false AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()))::int AS locked_now,' +
    ' COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.sign_by < CURRENT_DATE)::int AS overdue,' +
    " COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.kind = 'message' AND m.require_response IS NOT FALSE)::int AS messages_waiting " +
    "FROM memos m JOIN memo_recipients r ON r.memo_id = m.id WHERE m.status = 'sent'" + sw, sp)).rows[0];
  var fbs = (await pool.query("SELECT COUNT(*)::int AS n FROM memo_recipients r JOIN memos m ON m.id = r.memo_id WHERE m.status <> 'draft' AND " + FB_UNREAD + sw, sp)).rows[0];
  stats.feedback_unread = fbs ? fbs.n : 0;
  stats.unmatched_texts = 0;
  if (sc.full) {
    try { stats.unmatched_texts = (await pool.query('SELECT COUNT(*)::int AS n FROM sms_unmatched WHERE resolved_at IS NULL')).rows[0].n; } catch (e) {}
  }
  res.json({
    stats: stats,
    scope: { full: sc.full, cities: sc.cities },
    memos: rows.map(function (m) {
      return Object.assign(memoSummary(m), {
        to_names: m.to_names || null,
        counts: { total: m.total, viewed: m.viewed, completed: m.completed, excused: m.excused, locked: m.locked, overdue: m.overdue,
          feedback: m.feedback, feedback_unread: m.feedback_unread, by_text: m.by_text },
        last_completed_at: m.last_completed_at, last_viewed_at: m.last_viewed_at
      });
    })
  });
});

function draftFields(b) {
  b = b || {};
  var f = {};
  if (b.type !== undefined) f.type = clean(b.type, 80) || 'Announcement';
  if (b.title !== undefined) f.title = clean(b.title, 200) || '';
  if (b.note !== undefined) f.note = clean(b.note, 600);
  if (b.body !== undefined) f.body = clean(b.body, 20000);
  if (b.effective_date !== undefined) f.effective_date = cleanDate(b.effective_date);
  if (b.sign_by !== undefined) f.sign_by = cleanDate(b.sign_by);
  if (b.require_signature !== undefined) f.require_signature = bool(b.require_signature, true);
  if (b.lock_until_done !== undefined) f.lock_until_done = bool(b.lock_until_done, false);
  if (b.lock_starts_at !== undefined) f.lock_starts_at = cleanTs(b.lock_starts_at);
  if (b.audience !== undefined) f.audience = JSON.stringify(normAudience(b.audience));
  if (b.include_future_hires !== undefined) f.include_future_hires = bool(b.include_future_hires, false);
  if (b.exclude_sender !== undefined) f.exclude_sender = bool(b.exclude_sender, true);
  if (b.notify_push !== undefined) f.notify_push = bool(b.notify_push, true);
  if (b.notify_sms !== undefined) f.notify_sms = bool(b.notify_sms, true);
  if (b.notify_email !== undefined) f.notify_email = bool(b.notify_email, true);
  if (b.allow_feedback !== undefined) f.allow_feedback = bool(b.allow_feedback, true);
  if (b.remind_every_days !== undefined) {
    var n = parseInt(b.remind_every_days, 10);
    f.remind_every_days = (n >= 0 && n <= 30) ? n : 2;
  }
  if (b.kind !== undefined) f.kind = b.kind === 'message' ? 'message' : 'memo';
  if (b.require_response !== undefined) f.require_response = bool(b.require_response, true);
  if (b.file_to_record !== undefined) f.file_to_record = bool(b.file_to_record, true);
  return f;
}

// A new message starts with message defaults: no signature, "Got it", no
// reminders, no email, picked people. Anything the request sets wins.
function messageDefaults(f) {
  if (f.kind !== 'message') return f;
  var d = { type: 'Message', require_signature: false, require_response: true, remind_every_days: 0, notify_email: false,
    audience: JSON.stringify({ mode: 'people', cities: [], roles: [], user_ids: [] }), lock_until_done: false, include_future_hires: false };
  Object.keys(d).forEach(function (k) { if (f[k] === undefined) f[k] = d[k]; });
  f.notify_email = false;
  return f;
}

router.post('/', SEND, async (req, res) => {
  var f = messageDefaults(scopeFields(req, draftFields(req.body), true));
  var cols = ['created_by', 'created_by_name'], vals = [req.user.id, req.user.name];
  Object.keys(f).forEach(function (k) { cols.push(k); vals.push(f[k]); });
  var ph = vals.map(function (_, i) { return '$' + (i + 1); });
  var r = await pool.query('INSERT INTO memos (' + cols.join(',') + ') VALUES (' + ph.join(',') + ') RETURNING *', vals);
  await logEvent(r.rows[0].id, 'created', req.user);
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.put('/:id', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: notEditable(memo) });
  var f = scopeFields(req, draftFields(req.body), false);
  if (f.kind === 'message' || (f.kind === undefined && memo.kind === 'message')) f.notify_email = false;
  var keys = Object.keys(f);
  if (!keys.length) return res.json({ memo: memoSummary(memo) });
  var sets = keys.map(function (k, i) { return k + ' = $' + (i + 2); });
  var r = await pool.query('UPDATE memos SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $1 RETURNING *',
    [memo.id].concat(keys.map(function (k) { return f[k]; })));
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.delete('/:id', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: memo.status === 'scheduled' ? notEditable(memo) : 'Only a draft can be deleted. A sent memo can be withdrawn.' });
  // The R2 object is left where it is: a revision shares its file key with the
  // memo it came from, and an orphaned PDF costs nothing worth the risk.
  await pool.query('DELETE FROM memos WHERE id = $1', [memo.id]);
  await logAudit({ entity_type: 'memo', entity_id: memo.id, action: 'memo_draft_deleted', user_id: req.user.id, user_name: req.user.name, details: { title: memo.title } });
  res.json({ success: true });
});

// ---- the PDF upload: presign -> browser PUTs to R2 -> confirm --------------------

router.post('/:id/upload-url', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: notEditable(memo) });
  if (!r2.configured()) return res.status(503).json({ error: 'File storage is not set up on this server (R2), so a PDF cannot be attached yet.' });
  var b = req.body || {};
  var name = clean(b.filename, 200) || 'memo.pdf';
  var size = parseInt(b.size, 10) || 0;
  var type = String(b.content_type || '').toLowerCase();
  if (type !== 'application/pdf' && !/\.pdf$/i.test(name)) return res.status(400).json({ error: 'Attach a PDF.' });
  if (size > MAX_FILE_BYTES) return res.status(400).json({ error: 'That PDF is larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MB.' });
  var key = 'memos/' + memo.id + '/' + Date.now() + '-' + crypto.randomBytes(5).toString('hex') + '.pdf';
  var url = await r2.presignUpload(key, 'application/pdf');
  res.json({ url: url, key: key });
});

router.post('/:id/file', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: notEditable(memo) });
  var b = req.body || {};
  var key = String(b.key || '');
  // Only a key this route handed out for THIS memo. Anything else would let a
  // sender attach some other module's private object to a company-wide memo.
  if (key.indexOf('memos/' + memo.id + '/') !== 0 || key.indexOf('..') !== -1) return res.status(400).json({ error: 'Bad upload key.' });
  var buf;
  try { buf = await r2.getObjectBuffer(key); }
  catch (e) { return res.status(400).json({ error: 'The upload did not arrive. Try attaching it again.' }); }
  if (!buf || buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'That file is not a PDF.' });
  if (buf.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'That PDF is too large.' });
  var pages;
  try { pages = await memoPdf.pdfPageCount(buf); }
  catch (e) { return res.status(400).json({ error: 'That PDF could not be opened. If it is password protected, save an unprotected copy and attach that.' }); }
  var sha = crypto.createHash('sha256').update(buf).digest('hex');
  var r = await pool.query(
    'UPDATE memos SET file_key = $2, file_name = $3, file_size = $4, file_pages = $5, file_sha256 = $6, source_document_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING *',
    [memo.id, key, clean(b.filename, 255) || 'memo.pdf', buf.length, pages, sha]);
  _fileCache.set(key, buf);
  await logEvent(memo.id, 'file_attached', req.user, null, { name: r.rows[0].file_name, pages: pages });
  res.json({ memo: memoSummary(r.rows[0]) });
});

// Attach a policy that is already in the Document Vault, instead of
// downloading it and uploading it again (Tony, 2026-10-09). The bytes are
// COPIED into this memo's own R2 key, not linked: rule 1 says a sent memo never
// changes, and a link would let a later edit or delete in the vault change what
// everybody signed. source_document_id only records where it came from.
// The picker uses GET /api/documents/search, so it only ever offers files this
// person can open in the vault; this route checks the same rule again.
router.post('/:id/from-vault', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: notEditable(memo) });
  if (!r2.configured()) return res.status(503).json({ error: 'File storage is not set up on this server (R2).' });
  var docId = intId((req.body || {}).document_id);
  var dr = await pool.query("SELECT id, name, r2_key, folder_id, owner_id, mime_type FROM documents WHERE id = $1 AND status = 'ready'", [docId]);
  var doc = dr.rows[0];
  if (!doc) return res.status(404).json({ error: 'That document is not in the vault.' });
  var ctx = await vault.loadContext(req.user);
  if (!vault.canViewFile(ctx, doc)) return res.status(403).json({ error: 'You do not have access to that document.' });
  var buf;
  try { buf = await r2.getObjectBuffer(doc.r2_key); }
  catch (e) { return res.status(502).json({ error: 'Could not read that document from storage.' }); }
  if (!buf || buf.length < 5 || buf.slice(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'Only a PDF can be attached to a memo. That file is not one.' });
  if (buf.length > MAX_FILE_BYTES) return res.status(400).json({ error: 'That PDF is too large.' });
  var pages;
  try { pages = await memoPdf.pdfPageCount(buf); }
  catch (e) { return res.status(400).json({ error: 'That PDF could not be opened. If it is password protected, save an unprotected copy to the vault.' }); }
  var key = 'memos/' + memo.id + '/' + Date.now() + '-' + crypto.randomBytes(5).toString('hex') + '.pdf';
  try { await r2.putObject(key, buf, 'application/pdf'); }
  catch (e) { return res.status(502).json({ error: 'Could not copy the document. Try again.' }); }
  var sha = crypto.createHash('sha256').update(buf).digest('hex');
  var name = /\.pdf$/i.test(doc.name || '') ? doc.name : ((doc.name || 'document') + '.pdf');
  var r = await pool.query(
    'UPDATE memos SET file_key = $2, file_name = $3, file_size = $4, file_pages = $5, file_sha256 = $6, source_document_id = $7, updated_at = NOW() WHERE id = $1 RETURNING *',
    [memo.id, key, name.slice(0, 255), buf.length, pages, sha, doc.id]);
  _fileCache.set(key, buf);
  await logEvent(memo.id, 'file_attached', req.user, null, { name: name, pages: pages, from_vault: doc.id });
  res.json({ memo: memoSummary(r.rows[0]) });
});

// The other direction (policy versions, Tony 2026-10-09): make this memo's PDF
// the CURRENT version of a Vault file, so onboarding, Nova AI and anyone who
// opens the file see the same policy the memo announced. This is what was
// missing when the PTO memo went out and onboarding kept the old policy.
// Allowed on a draft or a sent memo - the memo's own copy never changes either
// way; this only writes a new version onto the Vault file.
router.post('/:id/publish-to-vault', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (!memo.file_key) return res.status(400).json({ error: 'This memo has no PDF to publish.' });
  if (!r2.configured()) return res.status(503).json({ error: 'File storage is not set up on this server (R2).' });
  var docId = intId((req.body || {}).document_id);
  var dr = await pool.query("SELECT id, name, folder_id, owner_id FROM documents WHERE id = $1 AND status = 'ready'", [docId]);
  var doc = dr.rows[0];
  if (!doc) return res.status(404).json({ error: 'That file is not in the vault.' });
  var ctx = await vault.loadContext(req.user);
  if (!vault.canEditFile(ctx, doc)) return res.status(403).json({ error: 'You cannot change that file in the vault.' });
  var buf;
  try { buf = await fileBuffer(memo); }
  catch (e) { return res.status(502).json({ error: 'Could not read the memo PDF from storage.' }); }
  var key = 'documents/' + crypto.randomUUID() + '/' + String(doc.name || 'policy.pdf').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  try { await r2.putObject(key, buf, 'application/pdf'); }
  catch (e) { return res.status(502).json({ error: 'Could not copy the PDF into the vault. Try again.' }); }
  var note = String((req.body || {}).note || '').trim() || ('Published from memo ' + (memo.memo_no || ('#' + memo.id)) + (memo.title ? ': ' + memo.title : ''));
  var row = await policyVersions.replaceDocument(pool, doc.id, {
    r2_key: key,
    name: /\.pdf$/i.test(doc.name || '') ? doc.name : ((doc.name || 'policy') + '.pdf'),
    mime_type: 'application/pdf',
    size_bytes: buf.length
  }, req.user, note);
  if (!row) return res.status(404).json({ error: 'That file is not in the vault.' });
  await logEvent(memo.id, 'published_to_vault', req.user, null, { document_id: doc.id, name: row.name, version: row.version });
  await logAudit({ entity_type: 'document', entity_id: doc.id, action: 'new_version', user_id: req.user.id, user_name: req.user.name, details: { from_memo: memo.id, version: row.version } });
  var usage = await policyVersions.documentUsage(pool, doc.id);
  res.json({ success: true, document_id: doc.id, name: row.name, version: row.version, usage: usage });
});

router.delete('/:id/file', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: notEditable(memo) });
  var r = await pool.query('UPDATE memos SET file_key = NULL, file_name = NULL, file_size = NULL, file_pages = NULL, file_sha256 = NULL, source_document_id = NULL, updated_at = NOW() WHERE id = $1 RETURNING *', [memo.id]);
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.get('/:id/file', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo || !memo.file_key) return res.status(404).json({ error: 'Not found.' });
  try {
    var buf = await fileBuffer(memo);
    res.json({ filename: memo.file_name, mime: 'application/pdf', data: buf.toString('base64') });
  } catch (e) { res.status(502).json({ error: 'Could not load the document.' }); }
});

// ---- who it will go to, before it is sent ----------------------------------------

async function previewFor(req, aud, excludeSender) {
  var users = await resolveAudience(aud, { excludeId: excludeSender ? req.user.id : null });
  var exemptRoles = await lockExemptRoles();
  var cityCounts = {};
  users.forEach(function (u) { var c = u.home_city || '-'; cityCounts[c] = (cityCounts[c] || 0) + 1; });
  return {
    count: users.length,
    lock_count: users.filter(function (u) { return exemptRoles.indexOf(u.role) === -1; }).length,
    exempt: users.filter(function (u) { return exemptRoles.indexOf(u.role) !== -1; }).map(function (u) { return u.name; }),
    no_text: users.filter(function (u) { return !(u.phone && u.receive_sms); }).map(function (u) { return u.name; }),
    no_email: users.filter(function (u) { return !(u.email && u.receive_emails !== false); }).map(function (u) { return u.name; }),
    by_city: cityCounts,
    people: users.map(function (u) { return { id: u.id, name: u.name, role: u.role, city: u.home_city }; })
  };
}

router.post('/audience-preview', SEND, async (req, res) => {
  var b = req.body || {};
  var aud = b.audience;
  if (!req.memoScope.full) aud = { mode: 'people', user_ids: normAudience(aud).user_ids };
  var pv = await previewFor(req, aud, bool(b.exclude_sender, true));
  if (!req.memoScope.full) {
    var bad = await resolveAudience(aud, {});
    var prob = scopeProblem(req.memoScope, { kind: 'message', audience: aud, require_signature: false }, bad);
    if (prob) pv.problem = prob;
  }
  res.json(pv);
});

// ---- send -----------------------------------------------------------------------

function notEditable(m) {
  if (m.status === 'scheduled') return 'This memo is scheduled to send. Cancel the schedule to change it.';
  if (m.status === 'sending') return 'This memo is going out right now.';
  return 'A sent memo cannot be changed. Use Revise to send a corrected version.';
}

function sendProblems(m) {
  var p = [];
  if (m.kind === 'message') {
    if (!clean(m.title)) p.push('Give the message a subject.');
    if (!clean(m.body) && !clean(m.note)) p.push('Write the message.');
    if (m.file_key) p.push('Messages are text only. Send a memo to attach a PDF.');
    if (String(m.body || '').length > MAX_MESSAGE_CHARS) p.push('Keep a message under ' + MAX_MESSAGE_CHARS + ' characters, or send it as a memo.');
  } else {
    if (!clean(m.title)) p.push('Give the memo a title.');
    if (!m.file_key && !clean(m.body) && !clean(m.note)) p.push('Attach a PDF or write the memo.');
  }
  if (m.lock_until_done && m.require_response === false && m.require_signature === false) p.push('A "Just read it" message cannot lock Nova: there is nothing to do to unlock it.');
  var a = normAudience(m.audience);
  if (a.mode === 'cities' && !a.cities.length) p.push('Pick at least one location.');
  if (a.mode === 'roles' && !a.roles.length) p.push('Pick at least one role.');
  if (a.mode === 'people' && !a.user_ids.length) p.push('Pick at least one person.');
  return p;
}

// The send itself, shared by the Send button and the scheduled-send job
// (jobs/memos.js). actor is whoever pressed Send - or, for a scheduled memo,
// whoever scheduled it, so "sent by" and "leave me out" still mean that person.
// Returns { code, error, problems } on refusal, { memo, users } on success.
async function performSend(memoId, actor, opts) {
  opts = opts || {};
  var allowed = opts.fromStatus ? [opts.fromStatus] : ['draft', 'scheduled'];
  var client = await pool.connect();
  var memo, users;
  try {
    await client.query('BEGIN');
    var mr = await client.query('SELECT * FROM memos WHERE id = $1 FOR UPDATE', [intId(memoId)]);
    memo = mr.rows[0];
    if (!memo) { await client.query('ROLLBACK'); return { code: 404, error: 'Not found.' }; }
    if (allowed.indexOf(memo.status) === -1) { await client.query('ROLLBACK'); return { code: 409, error: memo.status === 'sending' ? 'This memo is going out right now.' : 'This memo has already been sent.' }; }
    var probs = sendProblems(memo);
    if (probs.length) { await client.query('ROLLBACK'); return { code: 400, error: probs.join(' '), problems: probs }; }

    users = await resolveAudience(memo.audience, { excludeId: memo.exclude_sender !== false ? actor.id : null }, client);
    if (!users.length) { await client.query('ROLLBACK'); return { code: 400, error: memo.kind === 'message' ? 'Pick who this message is for.' : 'Nobody matches who this memo is for.' }; }
    var sp = scopeProblem(opts.scope, memo, users);
    if (sp) { await client.query('ROLLBACK'); return { code: 403, error: sp }; }

    // Memo numbers run MEMO-YYYY-NNN in send order, messages MSG-YYYY-NNN on
    // their own count. The advisory lock makes two simultaneous sends take
    // turns instead of both getting the same number.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('memo_no'))");
    var yr = new Date().getFullYear();
    var prefix = memo.kind === 'message' ? 'MSG' : 'MEMO';
    var nr = await client.query("SELECT COUNT(*)::int AS n FROM memos WHERE memo_no LIKE $1", [prefix + '-' + yr + '-%']);
    var n = (nr.rows[0].n || 0) + 1;
    var memoNo = prefix + '-' + yr + '-' + (n < 10 ? '00' : (n < 100 ? '0' : '')) + n;

    var exemptRoles = await lockExemptRoles();
    var hash = contentHash(memo);
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
      await client.query(
        'INSERT INTO memo_recipients (memo_id, user_id, user_name, user_role, user_city, lock_exempt, delivered_at, delivered_via) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,NOW(),'Nova') ON CONFLICT (memo_id, user_id) DO NOTHING",
        [memo.id, u.id, u.name, u.role, u.home_city, exemptRoles.indexOf(u.role) !== -1]);
    }
    var up = await client.query(
      "UPDATE memos SET status = 'sent', memo_no = $2, content_hash = $3, sent_by = $4, sent_by_name = $5, sent_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *",
      [memo.id, memoNo, hash, actor.id, actor.name]);
    memo = up.rows[0];
    // A revision retires the memo it replaces: its open rows stop locking
    // anyone, because the lock only ever reads status = 'sent'.
    if (memo.supersedes_id) {
      await client.query("UPDATE memos SET status = 'superseded', superseded_by_id = $2, updated_at = NOW() WHERE id = $1 AND status = 'sent'",
        [memo.supersedes_id, memo.id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('[memos] send failed:', e);
    return { code: 500, error: 'Could not send the memo.' };
  } finally {
    client.release();
  }

  memoLock.invalidate();
  await logEvent(memo.id, 'sent', actor, null, { recipients: users.length, memo_no: memo.memo_no, scheduled: !!actor.scheduled });
  if (memo.supersedes_id) await logEvent(memo.supersedes_id, 'superseded', actor, null, { by: memo.memo_no });
  await logAudit({
    entity_type: 'memo', entity_id: memo.id, entity_number: memo.memo_no, action: memo.kind === 'message' ? 'message_sent' : 'memo_sent',
    user_id: actor.id, user_name: actor.name, ip: actor.ip || null,
    details: { title: memo.title, recipients: users.length, lock: !!memo.lock_until_done, signature: memo.require_signature !== false, content_hash: memo.content_hash, scheduled: !!actor.scheduled }
  });
  return { memo: memo, users: users };
}

router.post('/:id/send', SEND, async (req, res) => {
  if (!canTouch(req, await loadMemo(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  var r = await performSend(req.params.id, { id: req.user.id, name: req.user.name, ip: ipOf(req) }, { scope: req.memoScope });
  if (r.error) return res.status(r.code).json({ error: r.error, problems: r.problems });
  // Notifications go out AFTER the response: forty emails and texts in series
  // would otherwise hold the Send button for a minute. Each person's row
  // already exists, so the memo is in their Nova the moment this returns.
  // (test-memos.js sets memosSyncDelivery so it can read what was sent.)
  if (req.app && req.app.get('memosSyncDelivery')) {
    await deliverAll(r.memo, r.users);
    return res.json({ success: true, memo: memoSummary(r.memo), recipients: r.users.length });
  }
  res.json({ success: true, memo: memoSummary(r.memo), recipients: r.users.length });
  setImmediate(function () { deliverAll(r.memo, r.users).catch(function (e) { console.error('[memos] delivery failed:', e.message); }); });
});

// ---- schedule a send ----------------------------------------------------------
// So a memo written at 11 PM goes out at 8 AM instead of buzzing forty phones
// at midnight (Tony, 2026-10-09). The memo is checked NOW, exactly as Send
// would check it, so a problem shows up while the sender is still looking at it
// and not as a silent failure at 8 AM. While scheduled it cannot be edited;
// Cancel puts it back to a draft. jobs/memos.js runScheduledSends() sends it
// within a minute of the time, through performSend() above.
var MAX_SCHEDULE_DAYS = 90;
router.post('/:id/schedule', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft' && memo.status !== 'scheduled') return res.status(409).json({ error: 'This memo has already been sent.' });
  var at = cleanTs((req.body || {}).send_at);
  if (!at) return res.status(400).json({ error: 'Pick a date and time to send it.' });
  var t = new Date(at).getTime();
  if (t < Date.now() + 60000) return res.status(400).json({ error: 'Pick a time in the future.' });
  if (t > Date.now() + MAX_SCHEDULE_DAYS * 86400000) return res.status(400).json({ error: 'Pick a time within the next ' + MAX_SCHEDULE_DAYS + ' days.' });
  var probs = sendProblems(memo);
  if (probs.length) return res.status(400).json({ error: probs.join(' '), problems: probs });
  var users = await resolveAudience(memo.audience, { excludeId: memo.exclude_sender !== false ? req.user.id : null });
  if (!users.length) return res.status(400).json({ error: memo.kind === 'message' ? 'Pick who this message is for.' : 'Nobody matches who this memo is for.' });
  var spb = scopeProblem(req.memoScope, memo, users);
  if (spb) return res.status(403).json({ error: spb });
  var r = await pool.query(
    "UPDATE memos SET status = 'scheduled', scheduled_send_at = $2, scheduled_by = $3, scheduled_by_name = $4, updated_at = NOW() WHERE id = $1 RETURNING *",
    [memo.id, at, req.user.id, req.user.name]);
  await logEvent(memo.id, 'scheduled', req.user, null, { send_at: at, recipients: users.length });
  res.json({ success: true, memo: memoSummary(r.rows[0]), recipients: users.length });
});

router.post('/:id/unschedule', SEND, async (req, res) => {
  if (!canTouch(req, await loadMemo(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  var r = await pool.query(
    "UPDATE memos SET status = 'draft', scheduled_send_at = NULL, scheduled_by = NULL, scheduled_by_name = NULL, updated_at = NOW() WHERE id = $1 AND status = 'scheduled' RETURNING *",
    [intId(req.params.id)]);
  if (!r.rows.length) return res.status(409).json({ error: 'This memo is not scheduled (it may have just gone out).' });
  await logEvent(r.rows[0].id, 'unscheduled', req.user);
  res.json({ success: true, memo: memoSummary(r.rows[0]) });
});

// Due scheduled memos -> sent. Called every minute by jobs/memos.js.
// The status flip to 'sending' is the claim: two servers (or two overlapping
// ticks) can never both send the same memo. A memo that can no longer be sent
// (everyone it was for has left, say) goes back to a draft and the person who
// scheduled it is told, rather than failing silently at 8 AM.
async function runScheduledSends() {
  var due = (await pool.query(
    "SELECT id, scheduled_by, scheduled_by_name FROM memos WHERE status = 'scheduled' AND scheduled_send_at <= NOW() ORDER BY scheduled_send_at")).rows;
  var sent = 0;
  for (var i = 0; i < due.length; i++) {
    var d = due[i];
    var claim = await pool.query("UPDATE memos SET status = 'sending' WHERE id = $1 AND status = 'scheduled' RETURNING id", [d.id]);
    if (!claim.rows.length) continue;
    var r = await performSend(d.id, { id: d.scheduled_by, name: d.scheduled_by_name || 'Nova', scheduled: true }, { fromStatus: 'sending' });
    if (r.error) {
      await pool.query("UPDATE memos SET status = 'draft', updated_at = NOW() WHERE id = $1 AND status = 'sending'", [d.id]);
      await logEvent(d.id, 'schedule_failed', { id: null, name: 'Nova' }, null, { error: r.error });
      try {
        var who = (await pool.query('SELECT email, receive_emails FROM users WHERE id = $1', [d.scheduled_by])).rows[0];
        var m = await loadMemo(d.id);
        if (who && who.email && who.receive_emails !== false) {
          await email.sendEmail(who.email, 'Your scheduled memo did not go out', email.emailTemplate({
            badge: 'Memo', title: 'Your scheduled memo did not go out',
            body: '<p>&ldquo;' + esc(m ? m.title : 'Memo') + '&rdquo; was scheduled to send, but Nova could not send it: ' + esc(r.error) + '</p><p>It is back in your drafts.</p>',
            buttonText: 'Open the draft', buttonUrl: appUrl('/?view=memo-edit&id=' + d.id)
          }));
        }
      } catch (e) {}
      continue;
    }
    sent++;
    try { await deliverAll(r.memo, r.users); } catch (e) { console.error('[memos] scheduled delivery failed:', e.message); }
  }
  return sent;
}

// ---- the tracker ------------------------------------------------------------------

router.get('/:id', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  var recs = (await pool.query(
    'SELECT r.id, r.user_id, r.user_name, r.user_role, r.user_city, r.lock_exempt, r.delivered_at, r.delivered_via, r.first_viewed_at, ' +
    ' r.last_viewed_at, r.view_count, r.reached_end_at, r.completed_at, r.completion, r.completed_via, r.last_feedback_via, r.signature_name, r.excused_at, ' +
    ' r.excused_by_name, r.excused_reason, r.reminder_count, r.last_reminded_at, r.added_late, u.active, ' +
    ' r.feedback_count, r.last_feedback_at, (' + FB_UNREAD + ') AS feedback_unread ' +
    'FROM memo_recipients r LEFT JOIN users u ON u.id = r.user_id WHERE r.memo_id = $1 ORDER BY r.user_name', [memo.id])).rows;
  var lockOn = memo.status === 'sent' && memo.lock_until_done && (!memo.lock_starts_at || new Date(memo.lock_starts_at) <= new Date());
  var today = dstr(new Date());
  recs = recs.map(function (r) {
    var st = recipientStatus(r, memo);
    return Object.assign(r, {
      status: st,
      role_label: ROLE_LABELS[r.user_role] || r.user_role,
      locked: !!(lockOn && !r.lock_exempt && !r.completed_at && !r.excused_at),
      overdue: !!(memo.sign_by && !r.completed_at && !r.excused_at && dstr(memo.sign_by) < today)
    });
  });
  var counts = {
    total: recs.length,
    viewed: recs.filter(function (r) { return r.first_viewed_at; }).length,
    completed: recs.filter(function (r) { return r.completed_at; }).length,
    excused: recs.filter(function (r) { return r.status === 'excused'; }).length,
    viewed_open: recs.filter(function (r) { return r.status === 'viewed'; }).length,
    not_opened: recs.filter(function (r) { return r.status === 'not_opened'; }).length,
    locked: recs.filter(function (r) { return r.locked; }).length,
    overdue: recs.filter(function (r) { return r.overdue; }).length,
    reached_end: recs.filter(function (r) { return r.reached_end_at; }).length,
    feedback: recs.filter(function (r) { return r.feedback_count > 0; }).length,
    feedback_unread: recs.filter(function (r) { return r.feedback_unread; }).length
  };
  var events = (await pool.query('SELECT action, user_id, actor_name, detail, created_at FROM memo_events WHERE memo_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [memo.id])).rows;
  var related = {};
  if (memo.supersedes_id) { var a = await loadMemo(memo.supersedes_id); if (a) related.supersedes = { id: a.id, memo_no: a.memo_no, title: a.title }; }
  if (memo.superseded_by_id) { var b2 = await loadMemo(memo.superseded_by_id); if (b2) related.superseded_by = { id: b2.id, memo_no: b2.memo_no, title: b2.title, status: b2.status }; }
  res.json({ memo: memoSummary(memo), recipients: recs, counts: counts, events: events, related: related });
});

router.post('/:id/remind', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'sent') return res.status(409).json({ error: 'Only a sent memo can be reminded.' });
  var ids = Array.isArray((req.body || {}).user_ids) ? req.body.user_ids.map(intId).filter(Boolean) : null;
  var sql = 'SELECT u.id, u.name, u.email, u.phone, u.receive_emails, u.receive_sms FROM memo_recipients r JOIN users u ON u.id = r.user_id ' +
    'WHERE r.memo_id = $1 AND r.completed_at IS NULL AND r.excused_at IS NULL AND u.active = true';
  var params = [memo.id];
  if (ids && ids.length) { sql += ' AND r.user_id = ANY($2::int[])'; params.push(ids); }
  var users = (await pool.query(sql, params)).rows;
  for (var i = 0; i < users.length; i++) {
    await notifyOne(memo, users[i], true);
    await pool.query('UPDATE memo_recipients SET reminder_count = reminder_count + 1, last_reminded_at = NOW() WHERE memo_id = $1 AND user_id = $2', [memo.id, users[i].id]);
  }
  await logEvent(memo.id, 'reminded', req.user, (users.length === 1 ? users[0].id : null), { count: users.length });
  res.json({ success: true, reminded: users.length });
});

router.post('/:id/recipients/:uid/excuse', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  var reason = clean((req.body || {}).reason, 300);
  if (!reason) return res.status(400).json({ error: 'Say why (for example: on leave until Nov 2).' });
  var r = await pool.query(
    'UPDATE memo_recipients SET excused_at = NOW(), excused_by_name = $3, excused_reason = $4 WHERE memo_id = $1 AND user_id = $2 AND completed_at IS NULL RETURNING user_name',
    [memo.id, intId(req.params.uid), req.user.name, reason]);
  if (!r.rows.length) return res.status(409).json({ error: 'Nothing to excuse - they may have already signed.' });
  memoLock.invalidate();
  await logEvent(memo.id, 'excused', req.user, intId(req.params.uid), { reason: reason });
  res.json({ success: true });
});

router.delete('/:id/recipients/:uid/excuse', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  await pool.query('UPDATE memo_recipients SET excused_at = NULL, excused_by_name = NULL, excused_reason = NULL WHERE memo_id = $1 AND user_id = $2',
    [memo.id, intId(req.params.uid)]);
  memoLock.invalidate();
  await logEvent(memo.id, 'unexcused', req.user, intId(req.params.uid));
  res.json({ success: true });
});

// Withdraw: stop reminders and release the lock. Every row - viewed, signed,
// not opened - is kept exactly as it was.
router.post('/:id/withdraw', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'sent') return res.status(409).json({ error: 'Only a sent memo can be withdrawn.' });
  var reason = clean((req.body || {}).reason, 500);
  if (!reason) return res.status(400).json({ error: 'Say why it is being withdrawn.' });
  await pool.query("UPDATE memos SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by_name = $2, withdrawn_reason = $3, updated_at = NOW() WHERE id = $1",
    [memo.id, req.user.name, reason]);
  memoLock.invalidate();
  await logEvent(memo.id, 'withdrawn', req.user, null, { reason: reason });
  await logAudit({ entity_type: 'memo', entity_id: memo.id, entity_number: memo.memo_no, action: 'memo_withdrawn', user_id: req.user.id, user_name: req.user.name, details: { reason: reason } });
  res.json({ success: true });
});

// Revise: a new draft carrying everything over, linked to this one. Sending it
// supersedes this memo, and everyone signs the new version.
router.post('/:id/revise', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'sent') return res.status(409).json({ error: 'Only a sent memo can be revised.' });
  var open = await pool.query("SELECT id FROM memos WHERE supersedes_id = $1 AND status = 'draft' LIMIT 1", [memo.id]);
  if (open.rows.length) return res.json({ memo: { id: open.rows[0].id }, existing: true });
  var r = await pool.query(
    'INSERT INTO memos (type, title, note, body, effective_date, file_key, file_name, file_size, file_pages, file_sha256, source_document_id, ' +
    ' require_signature, lock_until_done, sign_by, audience, include_future_hires, exclude_sender, notify_push, notify_sms, ' +
    ' notify_email, remind_every_days, allow_feedback, supersedes_id, created_by, created_by_name) ' +
    'SELECT type, title, note, body, effective_date, file_key, file_name, file_size, file_pages, file_sha256, source_document_id, ' +
    ' require_signature, lock_until_done, NULL, audience, include_future_hires, exclude_sender, notify_push, notify_sms, ' +
    ' notify_email, remind_every_days, allow_feedback, id, $2, $3 FROM memos WHERE id = $1 RETURNING *',
    [memo.id, req.user.id, req.user.name]);
  await logEvent(r.rows[0].id, 'created', req.user, null, { revision_of: memo.memo_no });
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.get('/:id/recipients/:uid/pdf', SEND, async (req, res) => {
  if (!canTouch(req, await loadMemo(req.params.id))) return res.status(404).json({ error: 'Not found.' });
  return sendSignedCopy(req, res, intId(req.params.id), intId(req.params.uid));
});

router.get('/:id/report', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo || memo.status === 'draft') return res.status(404).json({ error: 'Not found.' });
  var recs = (await pool.query('SELECT * FROM memo_recipients WHERE memo_id = $1', [memo.id])).rows;
  try {
    var buf = await memoPdf.buildStatusReport(memo, recs, { company: await companyInfo() });
    res.json({ filename: pdfName(memo, 'status-report'), mime: 'application/pdf', data: buf.toString('base64') });
  } catch (e) {
    console.error('[memos] report failed:', e);
    res.status(500).json({ error: 'Could not build the report.' });
  }
});

router.get('/:id/signed-copies', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo || memo.status === 'draft') return res.status(404).json({ error: 'Not found.' });
  var recs = (await pool.query('SELECT * FROM memo_recipients WHERE memo_id = $1 AND completed_at IS NOT NULL ORDER BY user_name', [memo.id])).rows;
  if (!recs.length) return res.status(409).json({ error: 'Nobody has signed yet.' });
  try {
    var bufs = [];
    for (var i = 0; i < recs.length; i++) bufs.push(await signedCopyBuffer(memo, recs[i]));
    var all = await memoPdf.mergePdfs(bufs);
    await logEvent(memo.id, 'exported_all', req.user, null, { count: recs.length });
    res.json({ filename: pdfName(memo, 'all-signed-copies'), mime: 'application/pdf', data: all.toString('base64') });
  } catch (e) {
    console.error('[memos] all copies failed:', e);
    res.status(500).json({ error: 'Could not build the PDF.' });
  }
});

// ---- reading and answering feedback ------------------------------------------------

router.get('/:id/recipients/:uid/feedback', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  var uid = intId(req.params.uid);
  var rr = await pool.query('SELECT id, user_name FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memo.id, uid]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Not found.' });
  var thread = await feedbackThread(memo.id, uid);
  if (thread.length) await pool.query('UPDATE memo_recipients SET feedback_staff_seen_at = NOW() WHERE id = $1', [rr.rows[0].id]);
  res.json({ user_name: rr.rows[0].user_name, thread: threadOut(thread) });
});

router.post('/:id/recipients/:uid/feedback', SEND, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!canTouch(req, memo)) return res.status(404).json({ error: 'Not found.' });
  if (memo.status === 'draft' || memo.status === 'scheduled' || memo.status === 'sending') return res.status(409).json({ error: 'This memo has not gone out yet.' });
  var uid = intId(req.params.uid);
  var rr = await pool.query('SELECT id, user_name, last_feedback_via FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memo.id, uid]);
  if (!rr.rows.length) return res.status(404).json({ error: 'Not found.' });
  var text = clean((req.body || {}).body, MAX_FEEDBACK_CHARS + 1);
  if (!text) return res.status(400).json({ error: 'Write a reply first.' });
  if (text.length > MAX_FEEDBACK_CHARS) return res.status(400).json({ error: 'Keep it under ' + MAX_FEEDBACK_CHARS + ' characters.' });
  // They last wrote in by text, so this answer goes back as a text (plus push).
  var byText = rr.rows[0].last_feedback_via === 'sms';
  var ins = await pool.query('INSERT INTO memo_feedback (memo_id, user_id, author_id, author_name, from_staff, body) VALUES ($1,$2,$3,$4,true,$5) RETURNING id',
    [memo.id, uid, req.user.id, req.user.name, text]);
  await pool.query('UPDATE memo_recipients SET last_reply_at = NOW(), feedback_staff_seen_at = NOW() WHERE id = $1', [rr.rows[0].id]);
  await logEvent(memo.id, 'feedback_reply', req.user, uid, byText ? { via: 'sms' } : null);
  var told = { texted: false };
  try { told = (await notifyReply(memo, uid, { id: req.user.id, name: req.user.name }, text, { byText: byText })) || told; } catch (e) { console.error('[memos] reply notify failed:', e.message); }
  if (told.texted) await pool.query("UPDATE memo_feedback SET via = 'sms' WHERE id = $1", [ins.rows[0].id]);
  res.json({ success: true, texted: !!told.texted, thread: threadOut(await feedbackThread(memo.id, uid)) });
});

// =============================================================================
//  TEXT REPLIES  (called by routes/inbound.js POST /sms)
// =============================================================================
// A reply routed to this memo or message (see utils/smsReplies.js for how).
// Returns { matched, reply, reason }: reply is the one short text Nova sends
// back (null = say nothing), reason is why it did NOT match (kept with the
// text on the Unmatched texts list).
async function handleTextReply(o) {
  var memo = await loadMemo(o.memoId);
  var user = o.user;
  if (!memo || !user) return { matched: false, reason: 'No memo or message to match.' };
  var rr = await pool.query(MY_SQL + 'WHERE r.user_id = $1 AND m.id = $2', [user.id, memo.id]);
  var row = rr.rows[0];
  if (!row) return { matched: false, reason: (memo.memo_no || 'That memo') + ' was not sent to ' + user.name + '.' };
  var isMsg = memo.kind === 'message';
  var noun = isMsg ? 'message' : 'memo';
  var first = String(user.name || '').split(' ')[0] || 'there';
  var sender = memo.sent_by_name || 'the office';
  var link = memoLink(memo);
  var body = String(o.body || '').trim();
  var media = parseInt(o.mediaCount, 10) || 0;
  if (memo.status !== 'sent') return { matched: true, reply: 'That ' + noun + ' is closed now. If you still need something, talk to your manager directly.' };
  var open = !row.completed_at && !row.excused_at;

  if (!media && smsReplies.isAffirmation(body)) {
    if (!open) return { matched: true, reply: null };
    if (memo.require_signature !== false) return { matched: true, reply: 'Thanks, ' + first + '. This one needs your signature, which only works in Nova: ' + link };
    if (!isMsg) return { matched: true, reply: 'Thanks, ' + first + '. Please open the memo in Nova to confirm you read it: ' + link };
    if (String(memo.body || memo.note || '').trim().length > MESSAGE_SMS_CHARS) {
      return { matched: true, reply: 'Thanks, ' + first + '. This message is longer than a text, so please read it in Nova and tap Got it there: ' + link };
    }
    var kind = memo.require_response === false ? 'read' : 'acknowledged';
    await pool.query('UPDATE memo_recipients SET reached_end_at = COALESCE(reached_end_at, NOW()) WHERE id = $1', [row.rid]);
    await markDone(row, kind, { via: 'sms', actor: { id: user.id, name: user.name } });
    return { matched: true, reply: 'Thanks, ' + first + '. Marked ' + (kind === 'read' ? 'as read' : 'Got it') + ' for ' + sender + '.' };
  }

  // Anything else is a reply on their private thread with the sender.
  if (memo.allow_feedback === false) return { matched: true, reply: 'Replies are off for this ' + noun + '. If you need something, talk to your manager directly.' };
  if ((row.feedback_count || 0) >= MAX_FEEDBACK_PER_THREAD) return { matched: true, reply: 'That is a lot of messages on one ' + noun + '. Please call your manager.' };
  var text = body.slice(0, MAX_FEEDBACK_CHARS);
  if (media) text = (text ? text + '\n' : '') + '[' + media + (media === 1 ? ' photo' : ' photos') + ' sent by text, not saved]';
  if (!text) return { matched: true, reply: null };
  await pool.query("INSERT INTO memo_feedback (memo_id, user_id, author_id, author_name, from_staff, body, via) VALUES ($1,$2,$2,$3,false,$4,'sms')",
    [memo.id, user.id, user.name, text]);
  await pool.query("UPDATE memo_recipients SET feedback_count = feedback_count + 1, last_feedback_at = NOW(), last_feedback_via = 'sms' WHERE id = $1", [row.rid]);
  await logEvent(memo.id, 'feedback', { id: user.id, name: user.name }, user.id, { via: 'sms' });
  // "Just read it": any text back means they read it.
  if (open && memo.require_response === false && memo.require_signature === false && isMsg) {
    await markDone(row, 'read', { via: 'sms', actor: { id: user.id, name: user.name } });
  }
  try { await notifyFeedback(memo, { id: user.id, name: user.name }, text); } catch (e) { console.error('[memos] text feedback notify failed:', e.message); }
  if (media) return { matched: true, reply: 'Got your text. Photos by text are not saved yet, so please add it in Nova: ' + link };
  return { matched: true, reply: 'Sent to ' + sender + ' on ' + memo.memo_no + '.' };
}

// ---- Unmatched texts (manage_memos only) ----------------------------------------

router.get('/texts/unmatched', MANAGE, async (req, res) => {
  var rows = (await pool.query(
    'SELECT x.*, u.role AS user_role, u.home_city AS user_city FROM sms_unmatched x LEFT JOIN users u ON u.id = x.user_id ' +
    'WHERE x.resolved_at IS NULL ORDER BY x.received_at DESC LIMIT 200')).rows;
  var ids = rows.map(function (r) { return r.user_id; }).filter(Boolean);
  var open = {};
  if (ids.length) {
    (await pool.query(
      "SELECT r.user_id, m.id, m.memo_no, m.title, m.kind, m.sent_at FROM memo_recipients r JOIN memos m ON m.id = r.memo_id " +
      "WHERE r.user_id = ANY($1::int[]) AND m.status = 'sent' AND m.sent_at > NOW() - INTERVAL '60 days' ORDER BY m.sent_at DESC", [ids])).rows
      .forEach(function (m) { (open[m.user_id] = open[m.user_id] || []).push({ id: m.id, memo_no: m.memo_no, title: m.title, kind: m.kind }); });
  }
  res.json({ texts: rows.map(function (r) {
    return { id: r.id, from_number: r.from_number, user_id: r.user_id, user_name: r.user_name, user_role: r.user_role,
      role_label: ROLE_LABELS[r.user_role] || r.user_role || null, user_city: r.user_city, body: r.body, media_count: r.media_count,
      reason: r.reason, received_at: r.received_at, memos: (open[r.user_id] || []).slice(0, 10) };
  }) });
});

async function loadUnmatched(id) {
  return (await pool.query('SELECT * FROM sms_unmatched WHERE id = $1 AND resolved_at IS NULL', [intId(id)])).rows[0] || null;
}

router.post('/texts/unmatched/:id/attach', MANAGE, async (req, res) => {
  var x = await loadUnmatched(req.params.id);
  if (!x) return res.status(404).json({ error: 'That text is gone or already handled.' });
  if (!x.user_id) return res.status(400).json({ error: 'Match the phone number to a person first.' });
  var memo = await loadMemo((req.body || {}).memo_id);
  if (!memo || memo.status === 'draft') return res.status(404).json({ error: 'Pick a memo or message.' });
  var rr = await pool.query('SELECT id FROM memo_recipients WHERE memo_id = $1 AND user_id = $2', [memo.id, x.user_id]);
  if (!rr.rows.length) return res.status(400).json({ error: (memo.memo_no || 'That') + ' was not sent to ' + x.user_name + '.' });
  var text = String(x.body || '').trim() || '[text with no words]';
  if (x.media_count) text += '\n[' + x.media_count + (x.media_count === 1 ? ' photo' : ' photos') + ' sent by text, not saved]';
  await pool.query("INSERT INTO memo_feedback (memo_id, user_id, author_id, author_name, from_staff, body, via, created_at) VALUES ($1,$2,$2,$3,false,$4,'sms',$5)",
    [memo.id, x.user_id, x.user_name, text.slice(0, MAX_FEEDBACK_CHARS), x.received_at]);
  await pool.query("UPDATE memo_recipients SET feedback_count = feedback_count + 1, last_feedback_at = GREATEST(COALESCE(last_feedback_at, $2), $2), last_feedback_via = 'sms', feedback_staff_seen_at = NOW() WHERE id = $1",
    [rr.rows[0].id, x.received_at]);
  await pool.query("UPDATE sms_unmatched SET resolved_at = NOW(), resolved_by_name = $2, resolution = 'attached', memo_id = $3 WHERE id = $1", [x.id, req.user.name, memo.id]);
  await logEvent(memo.id, 'feedback', { id: x.user_id, name: x.user_name }, x.user_id, { via: 'sms', attached_by: req.user.name });
  res.json({ success: true, memo_id: memo.id });
});

// resolution 'replied' = they answered it with a new message instead.
router.post('/texts/unmatched/:id/dismiss', MANAGE, async (req, res) => {
  var how = (req.body || {}).resolution === 'replied' ? 'replied' : 'dismissed';
  var r = await pool.query("UPDATE sms_unmatched SET resolved_at = NOW(), resolved_by_name = $2, resolution = $3 WHERE id = $1 AND resolved_at IS NULL RETURNING id",
    [intId(req.params.id), req.user.name, how]);
  if (!r.rows.length) return res.status(404).json({ error: 'That text is gone or already handled.' });
  res.json({ success: true });
});

// A text from a number on no Nova account, usually a tech on a new phone: put
// the number on their account so the next text routes by itself. Every other
// open text from that number is matched to them too.
router.post('/texts/unmatched/:id/phone', MANAGE, async (req, res) => {
  var x = await loadUnmatched(req.params.id);
  if (!x) return res.status(404).json({ error: 'That text is gone or already handled.' });
  var uid = intId((req.body || {}).user_id);
  var u = (await pool.query('SELECT id, name, phone FROM users WHERE id = $1 AND active = true', [uid])).rows[0];
  if (!u) return res.status(404).json({ error: 'Pick an active person.' });
  var taken = (await pool.query("SELECT id, name FROM users WHERE active = true AND id <> $1 AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $2", [u.id, x.phone_key])).rows;
  if (taken.length) return res.status(409).json({ error: 'That number is already on ' + taken[0].name + '\'s account.' });
  await pool.query('UPDATE users SET phone = $2 WHERE id = $1', [u.id, x.from_number]);
  await pool.query('UPDATE sms_unmatched SET user_id = $2, user_name = $3 WHERE phone_key = $1 AND resolved_at IS NULL', [x.phone_key, u.id, u.name]);
  await logAudit({ entity_type: 'user', entity_id: u.id, action: 'phone_changed_from_text', user_id: req.user.id, user_name: req.user.name,
    details: { from: u.phone || null, to: x.from_number, via: 'unmatched text ' + x.id } });
  res.json({ success: true, user_id: u.id, user_name: u.name });
});

module.exports = router;
module.exports._internal = {
  handleTextReply: handleTextReply, messageSms: messageSms, sendScope: sendScope,
  resolveAudience: resolveAudience, normAudience: normAudience, contentHash: contentHash, ackText: ackText,
  notifyOne: notifyOne, lockExemptRoles: lockExemptRoles, ELIGIBLE: ELIGIBLE, memoSummary: memoSummary,
  performSend: performSend, runScheduledSends: runScheduledSends, deliverAll: deliverAll
};
