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

var DEFAULT_TYPES = ['Policy update', 'Schedule', 'Safety', 'Reminder', 'Announcement', 'Other'];
var ROLES = ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician', 'manager', 'admin', 'owner'];
var ROLE_LABELS = {
  locksmith: 'Locksmith', locksmith_coordinator: 'Locksmith Coordinator', dispatcher: 'Dispatcher',
  roadside_technician: 'Roadside Technician', manager: 'Manager', admin: 'Admin', owner: 'Owner'
};
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var MAX_SIGNATURE_CHARS = 400000;

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

// Admins and owners get the memo and the banner, but are not LOCKED by default
// (2026-10-09): the people who run Nova should never be shut out of it by a
// memo one of them sent. A settings flip, not a deploy, if Tony wants them
// locked too: settings.memo_lock_admins = '1'.
async function lockExemptRoles() {
  var v = await getSetting('memo_lock_admins');
  return v === '1' || v === 'true' ? [] : ['admin', 'owner'];
}

function ackText(memo) {
  var what = memo.file_name ? (memo.body ? 'this memo and the attached document (' + memo.file_name + ')' : 'the attached document (' + memo.file_name + ')') : 'this memo';
  var applies = memo.effective_date ? 'it applies to me starting ' + longDate(memo.effective_date) : 'it applies to me';
  if (memo.require_signature === false) return 'I confirm that I received and read ' + what + ', and that I understand ' + applies + '.';
  return 'By signing, I confirm that I received and read ' + what + ', and that I understand ' + applies + '.';
}

// The fingerprint every signature is tied to. Covers exactly what the person
// reads: the title, the note, the written memo, the effective date and the PDF
// bytes (by their own SHA-256).
function contentHash(m) {
  var basis = JSON.stringify({
    title: m.title || '', type: m.type || '', note: m.note || '', body: m.body || '',
    effective_date: dstr(m.effective_date) || '', file_sha256: m.file_sha256 || '',
    require_signature: m.require_signature !== false
  });
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
async function notifyOne(memo, u, isReminder) {
  var via = ['Nova'];
  var verb = memo.require_signature !== false ? 'read and sign' : 'read';
  var title = (isReminder ? 'Reminder: ' : 'New memo: ') + memo.title;
  var who = memo.sent_by_name || 'Nova';
  if (memo.notify_push !== false && push.isReady()) {
    try {
      await push.sendPushToUsers([u.id], { title: title, body: 'From ' + who + '. Please ' + verb + ' it in Nova.', url: '/?view=my-memo&id=' + memo.id });
      via.push('push');
    } catch (e) {}
  }
  if (memo.notify_email !== false && u.email && u.receive_emails !== false) {
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
      await sms.sendSms(u.phone, 'Nova: ' + (isReminder ? 'reminder, ' : '') + 'new memo from ' + who + ': "' + memo.title + '". Please ' + verb + ' it in Nova: ' + memoLink(memo));
      via.push('text');
    } catch (e) { console.error('[memos] sms failed:', e.message); }
  }
  return via;
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

var COUNTS_SQL =
  'COUNT(r.id)::int AS total,' +
  ' COUNT(r.first_viewed_at)::int AS viewed,' +
  ' COUNT(r.completed_at)::int AS completed,' +
  ' COUNT(r.excused_at) FILTER (WHERE r.completed_at IS NULL)::int AS excused,' +
  " COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.status = 'sent' AND m.lock_until_done AND r.lock_exempt = false AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()))::int AS locked," +
  " COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.sign_by IS NOT NULL AND m.sign_by < CURRENT_DATE)::int AS overdue";

function recipientStatus(r, memo) {
  if (r.completed_at) return r.completion === 'acknowledged' ? 'acknowledged' : 'signed';
  if (r.excused_at) return 'excused';
  if (r.first_viewed_at) return 'viewed';
  return 'not_opened';
}

function memoSummary(m) {
  return {
    id: m.id, memo_no: m.memo_no, type: m.type, title: m.title, note: m.note, body: m.body,
    effective_date: dstr(m.effective_date), sign_by: dstr(m.sign_by),
    file_name: m.file_name, file_size: m.file_size, file_pages: m.file_pages, has_file: !!m.file_key,
    require_signature: m.require_signature !== false, lock_until_done: !!m.lock_until_done,
    lock_starts_at: m.lock_starts_at, audience: normAudience(m.audience), audience_label: audienceLabel(m.audience),
    include_future_hires: !!m.include_future_hires, exclude_sender: m.exclude_sender !== false,
    notify_push: m.notify_push !== false, notify_sms: m.notify_sms !== false, notify_email: m.notify_email !== false,
    remind_every_days: m.remind_every_days, status: m.status, content_hash: m.content_hash,
    supersedes_id: m.supersedes_id, superseded_by_id: m.superseded_by_id,
    created_by_name: m.created_by_name, sent_by_name: m.sent_by_name, sent_at: m.sent_at,
    withdrawn_at: m.withdrawn_at, withdrawn_by_name: m.withdrawn_by_name, withdrawn_reason: m.withdrawn_reason,
    created_at: m.created_at, updated_at: m.updated_at, ack_text: ackText(m)
  };
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
  return memoPdf.buildSignedCopy(memo, Object.assign({}, rcp, {
    user_role_label: ROLE_LABELS[rcp.user_role] || rcp.user_role || '',
    device: deviceOf(rcp.user_agent)
  }), { company: await companyInfo(), ackText: ackText(memo), fromTitle: fromTitle, fileBuffer: fb });
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
  ' r.completion, r.excused_at, r.lock_exempt, r.delivered_at, r.signature_name ' +
  'FROM memo_recipients r JOIN memos m ON m.id = r.memo_id ';

function myView(row) {
  var s = memoSummary(row);
  var lockActive = row.status === 'sent' && !!row.lock_until_done && !row.lock_exempt &&
    (!row.lock_starts_at || new Date(row.lock_starts_at) <= new Date());
  return Object.assign(s, {
    my: {
      first_viewed_at: row.first_viewed_at, view_count: row.view_count, reached_end_at: row.reached_end_at,
      completed_at: row.completed_at, completion: row.completion, excused_at: row.excused_at,
      delivered_at: row.delivered_at, signature_name: row.signature_name,
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
    res.json({ memos: r.rows.map(myView) });
  } catch (e) {
    res.json({ memos: [] });
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
  await pool.query(
    'UPDATE memo_recipients SET first_viewed_at = COALESCE(first_viewed_at, NOW()), last_viewed_at = NOW(), view_count = view_count + 1 WHERE id = $1',
    [row.rid]);
  if (!row.first_viewed_at) await logEvent(row.id, 'viewed', req.user, req.user.id);
  res.json({ success: true });
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
  if ((row.file_key || row.body) && !row.reached_end_at) {
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
  var ip = ipOf(req);
  var ua = clean(req.headers['user-agent'], 400);
  var upd = await pool.query(
    'UPDATE memo_recipients SET completed_at = NOW(), completion = $2, signature_name = $3, signature_data = $4, ' +
    ' signature_ip = $5, user_agent = $6, signed_hash = $7, first_viewed_at = COALESCE(first_viewed_at, NOW()) ' +
    'WHERE id = $1 AND completed_at IS NULL RETURNING completed_at',
    [row.rid, kind, typed, drawn, ip, ua, row.content_hash]);
  if (!upd.rows.length) return res.status(409).json({ error: 'Already done.' });
  memoLock.invalidate();
  await logEvent(row.id, kind, req.user, req.user.id, { ip: ip, device: deviceOf(ua) });
  await logAudit({
    entity_type: 'memo', entity_id: row.id, entity_number: row.memo_no, action: 'memo_' + kind,
    user_id: req.user.id, user_name: req.user.name, ip: ip, details: { title: row.title, content_hash: row.content_hash }
  });
  res.json({ success: true, completed_at: upd.rows[0].completed_at });
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
  var r = await pool.query(MY_SQL + "WHERE r.user_id = $1 AND m.status <> 'draft' ORDER BY m.sent_at DESC, m.id DESC", [uid]);
  res.json({ memos: r.rows.map(myView) });
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

router.get('/meta', MANAGE, async (req, res) => {
  var cities = (await pool.query('SELECT code, name FROM cities WHERE active = true ORDER BY name')).rows;
  var people = (await pool.query(ELIGIBLE + ' ORDER BY u.name')).rows.map(function (u) {
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
    max_file_mb: Math.round(MAX_FILE_BYTES / 1048576)
  });
});

// Top-of-page numbers for the Memos screen.
router.get('/', MANAGE, async (req, res) => {
  var rows = (await pool.query(
    'SELECT m.*, ' + COUNTS_SQL + ' FROM memos m LEFT JOIN memo_recipients r ON r.memo_id = m.id ' +
    'GROUP BY m.id ORDER BY COALESCE(m.sent_at, m.updated_at) DESC, m.id DESC')).rows;
  var stats = (await pool.query(
    "SELECT COUNT(DISTINCT m.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL)::int AS open_memos," +
    ' COUNT(DISTINCT r.user_id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL)::int AS people_outstanding,' +
    ' COUNT(DISTINCT r.user_id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.lock_until_done AND r.lock_exempt = false AND (m.lock_starts_at IS NULL OR m.lock_starts_at <= NOW()))::int AS locked_now,' +
    ' COUNT(r.id) FILTER (WHERE r.completed_at IS NULL AND r.excused_at IS NULL AND m.sign_by < CURRENT_DATE)::int AS overdue ' +
    "FROM memos m JOIN memo_recipients r ON r.memo_id = m.id WHERE m.status = 'sent'")).rows[0];
  res.json({
    stats: stats,
    memos: rows.map(function (m) {
      return Object.assign(memoSummary(m), {
        counts: { total: m.total, viewed: m.viewed, completed: m.completed, excused: m.excused, locked: m.locked, overdue: m.overdue }
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
  if (b.remind_every_days !== undefined) {
    var n = parseInt(b.remind_every_days, 10);
    f.remind_every_days = (n >= 0 && n <= 30) ? n : 2;
  }
  return f;
}

router.post('/', MANAGE, async (req, res) => {
  var f = draftFields(req.body);
  var cols = ['created_by', 'created_by_name'], vals = [req.user.id, req.user.name];
  Object.keys(f).forEach(function (k) { cols.push(k); vals.push(f[k]); });
  var ph = vals.map(function (_, i) { return '$' + (i + 1); });
  var r = await pool.query('INSERT INTO memos (' + cols.join(',') + ') VALUES (' + ph.join(',') + ') RETURNING *', vals);
  await logEvent(r.rows[0].id, 'created', req.user);
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.put('/:id', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: 'A sent memo cannot be changed. Use Revise to send a corrected version.' });
  var f = draftFields(req.body);
  var keys = Object.keys(f);
  if (!keys.length) return res.json({ memo: memoSummary(memo) });
  var sets = keys.map(function (k, i) { return k + ' = $' + (i + 2); });
  var r = await pool.query('UPDATE memos SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $1 RETURNING *',
    [memo.id].concat(keys.map(function (k) { return f[k]; })));
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.delete('/:id', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: 'Only a draft can be deleted. A sent memo can be withdrawn.' });
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
  if (memo.status !== 'draft') return res.status(409).json({ error: 'A sent memo cannot be changed.' });
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
  if (memo.status !== 'draft') return res.status(409).json({ error: 'A sent memo cannot be changed.' });
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
    'UPDATE memos SET file_key = $2, file_name = $3, file_size = $4, file_pages = $5, file_sha256 = $6, updated_at = NOW() WHERE id = $1 RETURNING *',
    [memo.id, key, clean(b.filename, 255) || 'memo.pdf', buf.length, pages, sha]);
  _fileCache.set(key, buf);
  await logEvent(memo.id, 'file_attached', req.user, null, { name: r.rows[0].file_name, pages: pages });
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.delete('/:id/file', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  if (memo.status !== 'draft') return res.status(409).json({ error: 'A sent memo cannot be changed.' });
  var r = await pool.query('UPDATE memos SET file_key = NULL, file_name = NULL, file_size = NULL, file_pages = NULL, file_sha256 = NULL, updated_at = NOW() WHERE id = $1 RETURNING *', [memo.id]);
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

router.post('/audience-preview', MANAGE, async (req, res) => {
  var b = req.body || {};
  res.json(await previewFor(req, b.audience, bool(b.exclude_sender, true)));
});

// ---- send -----------------------------------------------------------------------

function sendProblems(m) {
  var p = [];
  if (!clean(m.title)) p.push('Give the memo a title.');
  if (!m.file_key && !clean(m.body) && !clean(m.note)) p.push('Attach a PDF or write the memo.');
  var a = normAudience(m.audience);
  if (a.mode === 'cities' && !a.cities.length) p.push('Pick at least one location.');
  if (a.mode === 'roles' && !a.roles.length) p.push('Pick at least one role.');
  if (a.mode === 'people' && !a.user_ids.length) p.push('Pick at least one person.');
  return p;
}

router.post('/:id/send', MANAGE, async (req, res) => {
  var client = await pool.connect();
  var memo, users;
  try {
    await client.query('BEGIN');
    var mr = await client.query('SELECT * FROM memos WHERE id = $1 FOR UPDATE', [intId(req.params.id)]);
    memo = mr.rows[0];
    if (!memo) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found.' }); }
    if (memo.status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This memo has already been sent.' }); }
    var probs = sendProblems(memo);
    if (probs.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: probs.join(' '), problems: probs }); }

    users = await resolveAudience(memo.audience, { excludeId: memo.exclude_sender !== false ? req.user.id : null }, client);
    if (!users.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nobody matches who this memo is for.' }); }

    // Memo numbers run MEMO-YYYY-NNN in send order. The advisory lock makes
    // two simultaneous sends take turns instead of both getting the same number.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('memo_no'))");
    var yr = new Date().getFullYear();
    var nr = await client.query("SELECT COUNT(*)::int AS n FROM memos WHERE memo_no LIKE $1", ['MEMO-' + yr + '-%']);
    var n = (nr.rows[0].n || 0) + 1;
    var memoNo = 'MEMO-' + yr + '-' + (n < 10 ? '00' : (n < 100 ? '0' : '')) + n;

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
      [memo.id, memoNo, hash, req.user.id, req.user.name]);
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
    return res.status(500).json({ error: 'Could not send the memo.' });
  } finally {
    client.release();
  }

  memoLock.invalidate();
  await logEvent(memo.id, 'sent', req.user, null, { recipients: users.length, memo_no: memo.memo_no });
  if (memo.supersedes_id) await logEvent(memo.supersedes_id, 'superseded', req.user, null, { by: memo.memo_no });
  await logAudit({
    entity_type: 'memo', entity_id: memo.id, entity_number: memo.memo_no, action: 'memo_sent',
    user_id: req.user.id, user_name: req.user.name, ip: ipOf(req),
    details: { title: memo.title, recipients: users.length, lock: !!memo.lock_until_done, signature: memo.require_signature !== false, content_hash: memo.content_hash }
  });
  // Notifications go out AFTER the response: forty emails and texts in series
  // would otherwise hold the Send button for a minute. Each person's row
  // already exists, so the memo is in their Nova the moment this returns.
  // (test-memos.js sets memosSyncDelivery so it can read what was sent.)
  if (req.app && req.app.get('memosSyncDelivery')) {
    await deliverAll(memo, users);
    return res.json({ success: true, memo: memoSummary(memo), recipients: users.length });
  }
  res.json({ success: true, memo: memoSummary(memo), recipients: users.length });
  setImmediate(function () { deliverAll(memo, users).catch(function (e) { console.error('[memos] delivery failed:', e.message); }); });
});

// ---- the tracker ------------------------------------------------------------------

router.get('/:id', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
  var recs = (await pool.query(
    'SELECT r.id, r.user_id, r.user_name, r.user_role, r.user_city, r.lock_exempt, r.delivered_at, r.delivered_via, r.first_viewed_at, ' +
    ' r.last_viewed_at, r.view_count, r.reached_end_at, r.completed_at, r.completion, r.signature_name, r.excused_at, ' +
    ' r.excused_by_name, r.excused_reason, r.reminder_count, r.last_reminded_at, r.added_late, u.active ' +
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
    reached_end: recs.filter(function (r) { return r.reached_end_at; }).length
  };
  var events = (await pool.query('SELECT action, user_id, actor_name, detail, created_at FROM memo_events WHERE memo_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200', [memo.id])).rows;
  var related = {};
  if (memo.supersedes_id) { var a = await loadMemo(memo.supersedes_id); if (a) related.supersedes = { id: a.id, memo_no: a.memo_no, title: a.title }; }
  if (memo.superseded_by_id) { var b2 = await loadMemo(memo.superseded_by_id); if (b2) related.superseded_by = { id: b2.id, memo_no: b2.memo_no, title: b2.title, status: b2.status }; }
  res.json({ memo: memoSummary(memo), recipients: recs, counts: counts, events: events, related: related });
});

router.post('/:id/remind', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
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
router.post('/:id/withdraw', MANAGE, async (req, res) => {
  var memo = await loadMemo(req.params.id);
  if (!memo) return res.status(404).json({ error: 'Not found.' });
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
    'INSERT INTO memos (type, title, note, body, effective_date, file_key, file_name, file_size, file_pages, file_sha256, ' +
    ' require_signature, lock_until_done, sign_by, audience, include_future_hires, exclude_sender, notify_push, notify_sms, ' +
    ' notify_email, remind_every_days, supersedes_id, created_by, created_by_name) ' +
    'SELECT type, title, note, body, effective_date, file_key, file_name, file_size, file_pages, file_sha256, ' +
    ' require_signature, lock_until_done, NULL, audience, include_future_hires, exclude_sender, notify_push, notify_sms, ' +
    ' notify_email, remind_every_days, id, $2, $3 FROM memos WHERE id = $1 RETURNING *',
    [memo.id, req.user.id, req.user.name]);
  await logEvent(r.rows[0].id, 'created', req.user, null, { revision_of: memo.memo_no });
  res.json({ memo: memoSummary(r.rows[0]) });
});

router.get('/:id/recipients/:uid/pdf', MANAGE, async (req, res) => {
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

module.exports = router;
module.exports._internal = {
  resolveAudience: resolveAudience, normAudience: normAudience, contentHash: contentHash, ackText: ackText,
  notifyOne: notifyOne, lockExemptRoles: lockExemptRoles, ELIGIBLE: ELIGIBLE, memoSummary: memoSummary
};
