// jobs/quiz.js
// Weekly SOP quiz scheduler. Mirrors jobs/reminders.js.
//   sendTick   (every 15 min) -> at the configured ET day+time, generate this
//                                week's quiz if needed, send it, close last week.
//   remindTick (daily 09:05 ET) -> ping everyone still pending on the open quiz.
// "Keep pinging": reminders go out every day until the quiz is closed (i.e.
// until the next week's quiz is sent).

const cron = require('node-cron');
const { pool } = require('../db');
const { sendSms } = require('../utils/sms');
const { generateQuiz, weekMonday } = require('../utils/quizGen');
const { getQuizSettings, makeToken } = require('../routes/quiz');

function appUrl() {
  return (process.env.APP_URL || 'https://www.popalockar.com').replace(/\/+$/, '');
}

// Current time in ET as { dow, hh, mm }.
function nowET() {
  var et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { dow: et.getDay(), hh: et.getHours(), mm: et.getMinutes() };
}

// Create assignments + text every eligible user. Returns count sent.
// Marks the quiz 'sent' and closes any earlier still-open quiz.
async function sendQuiz(quizId) {
  var settings = await getQuizSettings();
  var qz = await pool.query('SELECT id, week_of, sop_title, status FROM quizzes WHERE id = $1', [quizId]);
  if (!qz.rows.length) throw new Error('Quiz not found');
  var quiz = qz.rows[0];

  // Eligible: active users in an allowed role, with a phone and SMS opt-in.
  var users = await pool.query(
    'SELECT id, name, phone FROM users ' +
    'WHERE active = true AND receive_sms = true AND phone IS NOT NULL AND phone <> $2 ' +
    '  AND role = ANY($1)',
    [settings.roles, '']
  );

  var link = appUrl() + '/?quiz=';
  var body = 'Lock & Roll weekly SOP check: 2 quick questions on ' + quiz.sop_title + '. Tap to take it: ';
  var sent = 0;
  for (var i = 0; i < users.rows.length; i++) {
    var u = users.rows[i];
    // Skip if this user already has an assignment for this quiz.
    var exists = await pool.query(
      'SELECT 1 FROM quiz_assignments WHERE quiz_id = $1 AND user_id = $2', [quiz.id, u.id]
    );
    if (exists.rows.length) continue;
    var tok = makeToken();
    await pool.query(
      "INSERT INTO quiz_assignments (quiz_id, user_id, token, status, sent_at) VALUES ($1,$2,$3,'pending',NOW())",
      [quiz.id, u.id, tok]
    );
    try { await sendSms(u.phone, body + link + tok); sent++; }
    catch (e) { console.error('[quiz] SMS failed for user ' + u.id + ':', e.message); }
  }

  // Mark sent, and close any older open quiz.
  await pool.query("UPDATE quizzes SET status='sent', sent_at=COALESCE(sent_at, NOW()) WHERE id=$1", [quiz.id]);
  await pool.query("UPDATE quizzes SET status='closed' WHERE id <> $1 AND status='sent'", [quiz.id]);
  console.log('[quiz] Sent quiz ' + quiz.id + ' (' + quiz.sop_title + ') to ' + sent + ' users');
  return sent;
}

async function sendTick() {
  try {
    var settings = await getQuizSettings();
    if (!settings.enabled) return;

    var t = nowET();
    var target = (settings.time || '09:00').split(':');
    var th = parseInt(target[0], 10);
    var tm = parseInt(target[1], 10) || 0;

    // Fire once when the ET clock is within the 15-min tick window of the target.
    var nowMin = t.hh * 60 + t.mm;
    var tgtMin = th * 60 + tm;
    if (t.dow !== settings.dow) return;
    if (nowMin < tgtMin || nowMin >= tgtMin + 15) return;

    var week = weekMonday(new Date());
    var q = await pool.query('SELECT id, status FROM quizzes WHERE week_of = $1', [week]);
    if (q.rows.length && q.rows[0].status === 'sent') return; // already sent this week

    var quizId = q.rows.length ? q.rows[0].id : null;
    if (!quizId) {
      console.log('[quiz] Generating this week\'s quiz...');
      quizId = await generateQuiz(week);
    }
    await sendQuiz(quizId);
  } catch (e) {
    console.error('[quiz] sendTick failed:', e.message);
  }
}

async function remindTick() {
  try {
    var settings = await getQuizSettings();
    if (!settings.enabled) return;
    // The single open quiz (status 'sent').
    var q = await pool.query("SELECT id, sop_title FROM quizzes WHERE status='sent' ORDER BY week_of DESC LIMIT 1");
    if (!q.rows.length) return;
    var quiz = q.rows[0];

    var pend = await pool.query(
      "SELECT a.id, a.token, u.phone FROM quiz_assignments a JOIN users u ON u.id = a.user_id " +
      "WHERE a.quiz_id = $1 AND a.status = 'pending' AND u.active = true AND u.receive_sms = true AND u.phone IS NOT NULL",
      [quiz.id]
    );
    var link = appUrl() + '/?quiz=';
    var body = 'Reminder: your Lock & Roll SOP quiz (' + quiz.sop_title + ') is still open. 2 questions: ';
    var n = 0;
    for (var i = 0; i < pend.rows.length; i++) {
      var p = pend.rows[i];
      try {
        await sendSms(p.phone, body + link + p.token);
        await pool.query('UPDATE quiz_assignments SET reminders_sent = reminders_sent + 1 WHERE id = $1', [p.id]);
        n++;
      } catch (e) { console.error('[quiz] reminder failed for assignment ' + p.id + ':', e.message); }
    }
    if (n) console.log('[quiz] Sent ' + n + ' quiz reminders for quiz ' + quiz.id);
  } catch (e) {
    console.error('[quiz] remindTick failed:', e.message);
  }
}

function startQuiz() {
  cron.schedule('*/15 * * * *', sendTick, { timezone: 'America/New_York' });
  cron.schedule('5 9 * * *', remindTick, { timezone: 'America/New_York' });
  console.log('[quiz] Weekly SOP quiz scheduler started (send tick every 15m, reminders 09:05 ET)');
}

module.exports = { startQuiz, sendQuiz, sendTick, remindTick };
