'use strict';
/*
 * Weekly SOP quiz compliance report  (Nova)
 * -----------------------------------------
 * Tony, 2026-10-05: "send out a compliance report each week telling us who did
 * it and who did not."
 *
 * WHEN: once per quiz, at the moment that quiz closes, which is the Monday send
 * of the NEXT quiz (jobs/quiz.js sendQuiz calls sendForClosingQuiz right before
 * it flips the old quiz to 'closed'). So the report is the final tally: nobody
 * can still take the old quiz after it lands. Tony picked Monday-before-the-next-
 * quiz over a mid-week "who is overdue" nudge.
 *
 * WHO GETS IT (Tony's call, same date):
 *   - admin + owner: the whole company.
 *   - each manager: only their own team, using org.teamIds - the SAME visibility
 *     scope the Team Quiz page already uses, so the email never shows a manager a
 *     name they could not already see in Nova. A manager whose team had nobody
 *     on this quiz gets nothing.
 *   Anyone inactive, without an email, or with receive_emails = false is skipped.
 *
 * ONCE ONLY: quizzes.report_sent_at is stamped after the send, so a manual
 * re-send of a quiz, a second tick, or a reboot can never mail it twice. The
 * "Email me" link on the Quiz page uses previewToUser, which never stamps.
 *
 * Admin/owner assignments are left out of every list. Those rows only exist
 * because an admin pressed "Send test to me", and they are not staff results.
 *
 * NOTE: no backtick/template-literal strings anywhere in this file (Windows-safe
 * per the Nova editing rules).
 */

var { pool } = require('../db');
var { sendEmail, emailTemplate } = require('./email');
var org = require('./org');

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function appUrl() {
  return (process.env.APP_URL || 'https://www.popalockar.com').replace(/\/+$/, '');
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  } catch (e) { return ''; }
}

// Week-of dates come back from pg as a JS Date at UTC midnight. Format in UTC so
// Monday does not slide to Sunday in Eastern time.
function fmtWeek(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return String(d); }
}

function roleLabel(r) {
  return String(r || '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// Everything the report needs for one quiz, company-wide. Callers scope it.
async function loadQuizData(quizId) {
  var qz = await pool.query(
    'SELECT q.id, q.week_of, q.sop_title, q.status, q.sent_at, ' +
    '  (SELECT COUNT(*)::int FROM quiz_questions qq WHERE qq.quiz_id = q.id) AS total_q ' +
    'FROM quizzes q WHERE q.id = $1',
    [quizId]
  );
  if (!qz.rows.length) return null;
  var rows = await pool.query(
    'SELECT a.user_id, u.name, u.role, u.home_city, a.status, a.score, a.passed, a.completed_at, a.reminders_sent ' +
    'FROM quiz_assignments a JOIN users u ON u.id = a.user_id ' +
    'WHERE a.quiz_id = $1 AND (u.role IS NULL OR u.role NOT IN (' + "'admin','owner'" + ')) ' +
    'ORDER BY u.name ASC',
    [quizId]
  );
  return { quiz: qz.rows[0], rows: rows.rows };
}

// Staff in a quizzed role who never got the text at all (no phone, or SMS off).
// They are not "did not do it" - they were never asked - but they are a gap
// somebody should close, so the company-wide report lists them separately.
async function loadNotTexted(quizId, roles) {
  var r = await pool.query(
    'SELECT u.id AS user_id, u.name, u.role, u.home_city, ' +
    '  (u.phone IS NULL OR u.phone = ' + "''" + ') AS no_phone, (u.receive_sms IS NOT TRUE) AS sms_off ' +
    'FROM users u WHERE u.active = true AND u.role = ANY($2) ' +
    '  AND NOT EXISTS (SELECT 1 FROM quiz_assignments a WHERE a.quiz_id = $1 AND a.user_id = u.id) ' +
    'ORDER BY u.name ASC',
    [quizId, roles]
  );
  return r.rows;
}

function th(t, right) {
  return '<th style="text-align:' + (right ? 'right' : 'left') + ';font-size:11px;color:#777777;font-weight:700;text-transform:uppercase;padding:6px 4px;border-bottom:1px solid #dddddd">' + t + '</th>';
}
function td(t, right, color) {
  return '<td style="font-size:13px;color:' + (color || '#111111') + ';padding:7px 4px;border-bottom:1px solid #eeeeee;text-align:' + (right ? 'right' : 'left') + '">' + t + '</td>';
}

function section(title, color, count, tableHtml, emptyText) {
  return '<div style="margin:0 0 24px">' +
    '<div style="font-size:14px;font-weight:700;color:' + color + ';margin:0 0 8px">' + esc(title) + ' (' + count + ')</div>' +
    (count ? tableHtml : '<div style="font-size:13px;color:#777777">' + esc(emptyText) + '</div>') +
    '</div>';
}

// Build subject + html for a set of rows. scopeLabel is shown in the title.
function buildEmail(data, rows, notTexted, scopeLabel) {
  var q = data.quiz;
  var total = q.total_q || 2;
  var missed = rows.filter(function (r) { return r.status !== 'completed'; });
  var done = rows.filter(function (r) { return r.status === 'completed'; });
  var passed = done.filter(function (r) { return r.passed; });
  var pct = rows.length ? Math.round(100 * done.length / rows.length) : 0;

  var missedTable = '<table role="presentation" width="100%" style="border-collapse:collapse"><tr>' +
    th('Name') + th('Role') + th('City') + th('Reminders', true) + '</tr>' +
    missed.map(function (r) {
      return '<tr>' + td(esc(r.name)) + td(esc(roleLabel(r.role))) + td(esc(r.home_city || '')) + td(String(r.reminders_sent || 0), true) + '</tr>';
    }).join('') + '</table>';

  var doneTable = '<table role="presentation" width="100%" style="border-collapse:collapse"><tr>' +
    th('Name') + th('City') + th('Score', true) + th('Result', true) + th('Done', true) + '</tr>' +
    done.map(function (r) {
      return '<tr>' + td(esc(r.name)) + td(esc(r.home_city || '')) +
        td((r.score == null ? '-' : r.score) + '/' + total, true) +
        td(r.passed ? 'Pass' : 'Fail', true, r.passed ? '#15803d' : '#b91c1c') +
        td(esc(fmtDate(r.completed_at)), true) + '</tr>';
    }).join('') + '</table>';

  var html = section('Did NOT take it', '#b91c1c', missed.length, missedTable, 'Everyone took it.') +
    section('Took it', '#15803d', done.length, doneTable, 'Nobody took it.');

  if (notTexted && notTexted.length) {
    var ntTable = '<table role="presentation" width="100%" style="border-collapse:collapse"><tr>' +
      th('Name') + th('City') + th('Why') + '</tr>' +
      notTexted.map(function (r) {
        var why = r.no_phone ? 'No phone on file' : (r.sms_off ? 'Text messages turned off' : 'Not sent');
        return '<tr>' + td(esc(r.name)) + td(esc(r.home_city || '')) + td(esc(why), false, '#777777') + '</tr>';
      }).join('') + '</table>';
    html += section('Never received the quiz', '#c2520a', notTexted.length, ntTable, '');
  }

  var subject = 'SOP quiz compliance: ' + pct + '% (' + done.length + '/' + rows.length + ') - ' + (q.sop_title || 'weekly quiz') +
    (scopeLabel ? ' - ' + scopeLabel : '');
  var body = 'Final results for the week of ' + esc(fmtWeek(q.week_of)) + ' quiz on <b>' + esc(q.sop_title || '') + '</b>. ' +
    'The quiz is now closed and the next one has gone out.';
  var mail = emailTemplate({
    badge: 'SOP Quiz',
    badgeColor: pct >= 90 ? 'green' : (pct < 70 ? 'red' : null),
    title: 'Weekly SOP quiz compliance' + (scopeLabel ? ': ' + esc(scopeLabel) : ''),
    body: body,
    details: [
      { label: 'Completed', value: done.length + ' of ' + rows.length + ' (' + pct + '%)' },
      { label: 'Did not take it', value: String(missed.length) },
      { label: 'Passed (all correct)', value: String(passed.length) }
    ],
    sectionHtml: html,
    buttonText: 'Open the SOP Quiz page',
    buttonUrl: appUrl() + '/',
    footerNote: 'Sent every week when the SOP quiz closes. Admins and owners get the whole company; each manager gets their own team.'
  });
  return { subject: subject, html: mail, counts: { assigned: rows.length, completed: done.length, passed: passed.length } };
}

async function recipients() {
  var r = await pool.query(
    'SELECT id, name, email, role FROM users ' +
    'WHERE active = true AND receive_emails IS NOT FALSE AND email IS NOT NULL AND email <> ' + "''" +
    "  AND role IN ('admin','owner','manager') ORDER BY id ASC"
  );
  return r.rows;
}

// Send the report for one quiz to everyone who should get it. Never throws for
// a single bad recipient. Returns { sent, skipped }.
async function sendReport(quizId, roles) {
  var data = await loadQuizData(quizId);
  if (!data) return { sent: 0, skipped: 'quiz not found' };
  var notTexted = await loadNotTexted(quizId, roles || []);
  var people = await recipients();
  var sent = 0;

  var full = buildEmail(data, data.rows, notTexted, '');
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    try {
      if (p.role === 'admin' || p.role === 'owner') {
        if (await sendEmail(p.email, full.subject, full.html)) sent++;
        continue;
      }
      // Manager: team scope only.
      var ids = await org.teamIds(p.id);
      if (!ids.length) continue;
      var set = {};
      ids.forEach(function (id) { set[Number(id)] = true; });
      var mine = data.rows.filter(function (r) { return set[Number(r.user_id)]; });
      if (!mine.length) continue;
      var myNot = notTexted.filter(function (r) { return set[Number(r.user_id)]; });
      var m = buildEmail(data, mine, myNot, 'Your team');
      if (await sendEmail(p.email, m.subject, m.html)) sent++;
    } catch (e) {
      console.error('[quizReport] send failed for user ' + p.id + ':', e.message);
    }
  }
  return { sent: sent, counts: full.counts };
}

// Called from jobs/quiz.js sendQuiz, just before older open quizzes are closed.
// Reports every still-open quiz other than the new one that has not been
// reported yet. Fire-and-forget safe: the caller wraps it, and it never blocks
// the new quiz going out.
async function sendForClosingQuizzes(newQuizId, settings) {
  if (settings && settings.reportEnabled === false) return 0;
  var r = await pool.query(
    "SELECT id FROM quizzes WHERE id <> $1 AND status = 'sent' AND report_sent_at IS NULL ORDER BY week_of ASC",
    [newQuizId]
  );
  var n = 0;
  for (var i = 0; i < r.rows.length; i++) {
    var qid = r.rows[i].id;
    // Stamp FIRST so a crash halfway through can never cause a second full mailing.
    await pool.query('UPDATE quizzes SET report_sent_at = NOW() WHERE id = $1', [qid]);
    var out = await sendReport(qid, settings ? settings.roles : []);
    console.log('[quizReport] quiz ' + qid + ' compliance report sent to ' + out.sent + ' recipient(s)');
    n += out.sent;
  }
  return n;
}

// "Email me" from the Quiz page: the full company report to one person, no stamp.
async function previewToUser(quizId, userId, roles) {
  var u = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (!u.rows.length || !u.rows[0].email) throw new Error('No email address on your account.');
  var data = await loadQuizData(quizId);
  if (!data) throw new Error('Quiz not found.');
  var notTexted = await loadNotTexted(quizId, roles || []);
  var m = buildEmail(data, data.rows, notTexted, '');
  var ok = await sendEmail(u.rows[0].email, '[Preview] ' + m.subject, m.html);
  if (!ok) throw new Error('The email did not send. Check RESEND_API_KEY.');
  return { email: u.rows[0].email, counts: m.counts };
}

module.exports = { sendReport, sendForClosingQuizzes, previewToUser, buildEmail, loadQuizData };
