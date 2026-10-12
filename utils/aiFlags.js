// utils/aiFlags.js
// Out-of-scope flags on Nova AI conversations (2026-10-12).
//
// Why: Jesse asked the agent for something it was never built to do. It
// apologized and listed five things it CAN do instead of saying plainly that
// it couldn't, and he walked away thinking the tool was worthless. Tony's call:
//   1. the AI says "I can't do that" in its first sentence and stops;
//   2. those conversations are FLAGGED in the AI Conversations log;
//   3. the people in settings.ai_flag_notify get an email, so repeated asks
//      become a list of features people actually want.
//
// How the flag travels: the model ends its reply with ONE marker line,
//   [[FLAG: out_of_scope | what they wanted, in a few words]]
// parseFlag() strips it before the reply is shown, spoken or logged, so a user
// never sees it. Rudeness alone is never flagged (Tony: do not police tone).
//
// No backticks anywhere (Windows-safe, see CLAUDE.md 1.1).

var email = require('./email');
var { getSetting } = require('./security');

var KINDS = ['out_of_scope'];

var SCOPE_RULE =
  '\n\nWHEN YOU CANNOT DO SOMETHING: If a request is outside what you can do (no tool for it, nothing in the documents, ' +
  'or it needs a system or person you cannot reach), say so plainly in your FIRST sentence, for example: ' +
  '"I can\'t do that from Nova." Then, if you know it, say who or where handles it (their manager, a screen in Nova, ' +
  'the office) in one short sentence, and stop. Do not apologize at length, do not list other things you can do, and do not pretend to be able to. ' +
  'If someone vents or is rude, do not comment on their tone and do not grovel: answer the request if you can, otherwise ask one short question ' +
  'about what they were trying to get done.\n' +
  'FLAGGING: Whenever you tell someone you cannot do what they asked because it is outside your abilities, end your reply with ' +
  'this exact line on its own, last, and nothing after it:\n' +
  '[[FLAG: out_of_scope | <what they wanted, under 15 words>]]\n' +
  'The line is removed before they see it; it lets the company see what people want the AI to do. ' +
  'Use it ONLY for out-of-scope requests: never for a permission or access error, never because someone was rude, ' +
  'never when you did what they asked.';

var MARKER_RE = /\[\[\s*FLAG\s*:\s*([a-z_]+)\s*(?:\|\s*([^\]]*))?\]\]/gi;

// parseFlag(text) -> { text: reply without the marker, flag: { kind, note } | null }
function parseFlag(text) {
  var s = String(text || '');
  var flag = null;
  s = s.replace(MARKER_RE, function (m, kind, note) {
    var k = String(kind || '').toLowerCase();
    if (!flag && KINDS.indexOf(k) !== -1) flag = { kind: k, note: String(note || '').trim().slice(0, 300) };
    return '';
  });
  return { text: s.replace(/\s+$/, ''), flag: flag };
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function snip(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '...' : s; }

// Who hears about a flag: settings.ai_flag_notify (comma-separated user ids),
// else every active admin and owner, so a flag never goes to nobody.
async function watchers(pool) {
  var ids = [];
  try {
    String((await getSetting('ai_flag_notify')) || '').split(',').forEach(function (x) {
      var n = parseInt(x, 10); if (n > 0 && ids.indexOf(n) === -1) ids.push(n);
    });
  } catch (e) {}
  var cols = 'SELECT id, name, email, receive_emails FROM users WHERE active = true ';
  var users = ids.length ? (await pool.query(cols + 'AND id = ANY($1::int[])', [ids])).rows : [];
  if (!users.length) users = (await pool.query(cols + "AND role IN ('admin','owner')")).rows;
  return users.filter(function (u) { return u.email && u.receive_emails !== false; });
}

// The flag is always saved. The email is skipped when the same person was
// already emailed about within settings.ai_flag_email_cooldown_min (default 30),
// so someone retrying the same ask five times does not send five emails.
async function recordFlag(pool, convId, user, question, reply, flag) {
  if (!convId || !flag) return { emailed: 0 };
  await pool.query('UPDATE ai_conversations SET flag_kind = $2, flag_note = $3 WHERE id = $1', [convId, flag.kind, flag.note || null]);

  var cooldown = 30;
  try {
    var c = parseInt(await getSetting('ai_flag_email_cooldown_min'), 10);
    if (c >= 0) cooldown = c;
  } catch (e) {}
  if (cooldown > 0) {
    var recent = await pool.query(
      'SELECT 1 FROM ai_conversations WHERE user_id = $1 AND id <> $2 AND flag_emailed_at > NOW() - ($3 || \' minutes\')::interval LIMIT 1',
      [user.id, convId, String(cooldown)]
    );
    if (recent.rows.length) return { emailed: 0, cooldown: true };
  }

  var to = await watchers(pool);
  if (!to.length) return { emailed: 0 };
  var base = (process.env.APP_URL || '').replace(/\/$/, '');
  var subject = 'Nova AI: ' + (user.name || 'Someone') + ' asked for something it can\'t do';
  var html = email.emailTemplate({
    badge: 'AI out of scope',
    title: (user.name || 'Someone') + ' asked Nova AI for something it can\'t do',
    body:
      '<p><b>What they wanted:</b> ' + esc(flag.note || '(not summarized)') + '</p>' +
      '<p><b>They asked:</b><br>' + esc(snip(question, 800)) + '</p>' +
      '<p><b>Nova AI answered:</b><br>' + esc(snip(reply, 800)) + '</p>' +
      '<p style="color:#888;font-size:12px">If this comes up again from other people, it may be worth building.</p>',
    buttonText: 'Open AI Conversations',
    buttonUrl: base + '/?view=ai-conversations'
  });
  var sent = 0;
  for (var i = 0; i < to.length; i++) {
    try { await email.sendEmail(to[i].email, subject, html); sent++; } catch (e) { console.error('AI flag email failed:', e.message); }
  }
  if (sent) await pool.query('UPDATE ai_conversations SET flag_emailed_at = NOW() WHERE id = $1', [convId]);
  return { emailed: sent };
}

module.exports = { SCOPE_RULE: SCOPE_RULE, parseFlag: parseFlag, recordFlag: recordFlag, KINDS: KINDS };
