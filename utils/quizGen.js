// utils/quizGen.js
// Weekly SOP quiz generation. Picks the least-recently-quizzed active SOP,
// pulls its text, and asks Claude for exactly 2 multiple-choice questions
// grounded in that SOP. Style matches routes/ai.js (raw https, no SDK, string
// concatenation instead of template literals to stay backtick-safe).

const https = require('https');
const { pool } = require('../db');

// ---- helpers ---------------------------------------------------------------

// Monday (ET) of the week that contains the given date. Returns 'YYYY-MM-DD'.
function weekMonday(d) {
  var et = new Date((d || new Date()).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  var day = et.getDay();                 // 0=Sun .. 6=Sat
  var diff = (day === 0 ? -6 : 1 - day); // shift back to Monday
  et.setDate(et.getDate() + diff);
  var y = et.getFullYear();
  var m = ('0' + (et.getMonth() + 1)).slice(-2);
  var dd = ('0' + et.getDate()).slice(-2);
  return y + '-' + m + '-' + dd;
}

function callClaude(system, userText) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      system: system,
      messages: [{ role: 'user', content: userText }]
    });
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var rq = https.request(options, function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    rq.on('error', reject);
    rq.setTimeout(30000, function () { rq.destroy(new Error('AI request timed out.')); });
    rq.write(body);
    rq.end();
  });
}

// Pull JSON out of a model reply, tolerating stray prose or code fences.
function extractJson(text) {
  if (!text) return null;
  var start = text.indexOf('{');
  var end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (e) { return null; }
}

// Validate the shape we require: exactly 2 questions, each with 4 string
// options and an in-range integer correct_index.
function validQuiz(obj) {
  if (!obj || !Array.isArray(obj.questions) || obj.questions.length !== 2) return false;
  for (var i = 0; i < obj.questions.length; i++) {
    var q = obj.questions[i];
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) return false;
    if (!Array.isArray(q.options) || q.options.length !== 4) return false;
    for (var j = 0; j < 4; j++) {
      if (typeof q.options[j] !== 'string' || !q.options[j].trim()) return false;
    }
    if (typeof q.correct_index !== 'number' || q.correct_index < 0 || q.correct_index > 3) return false;
  }
  return true;
}

var SYSTEM = [
  'You are writing a short workplace knowledge check for a locksmith / roadside company.',
  'You will be given the text of ONE Standard Operating Procedure (SOP).',
  'Write exactly TWO multiple-choice questions that test understanding of that SOP.',
  'Rules:',
  '- Every question and every answer option must be grounded ONLY in the supplied SOP text. Do not invent facts.',
  '- Each question must have exactly 4 options with exactly one clearly correct answer.',
  '- Make the wrong options plausible but clearly incorrect to someone who knows the SOP.',
  '- Keep each question and option to one sentence.',
  'Respond with ONLY a JSON object, no prose, in exactly this form:',
  '{"questions":[{"prompt":"...","options":["...","...","...","..."],"correct_index":0},{"prompt":"...","options":["...","...","...","..."],"correct_index":2}]}'
].join('\n');

// ---- main ------------------------------------------------------------------

// Pick the active SOP least recently used as a quiz topic (never-used first).
async function pickSop() {
  var r = await pool.query(
    'SELECT d.id, d.title, ' +
    '  (SELECT MAX(q.week_of) FROM quizzes q WHERE q.sop_id = d.id) AS last_used ' +
    'FROM sop_documents d WHERE d.active = true ' +
    'ORDER BY last_used ASC NULLS FIRST, random() LIMIT 1'
  );
  return r.rows[0] || null;
}

// Concatenate a SOP's chunk text up to a character budget.
async function sopText(sopId) {
  var r = await pool.query(
    'SELECT content FROM sop_chunks WHERE sop_id = $1 ORDER BY chunk_index ASC',
    [sopId]
  );
  var budget = 40000;
  var parts = [];
  for (var i = 0; i < r.rows.length; i++) {
    var chunk = (r.rows[i].content || '').slice(0, budget);
    parts.push(chunk);
    budget -= chunk.length;
    if (budget <= 0) break;
  }
  return parts.join('\n');
}

// Generate (or regenerate) the quiz for a given week. Returns the quiz id.
// If a quiz row already exists for that week it is replaced (questions cascade).
async function generateQuiz(weekOf) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  var week = weekOf || weekMonday(new Date());

  var sop = await pickSop();
  if (!sop) throw new Error('No active SOP documents to generate a quiz from');

  var text = await sopText(sop.id);
  if (!text || text.length < 50) throw new Error('SOP "' + sop.title + '" has no indexed text');

  // Ask Claude, with one retry on malformed output.
  var quiz = null;
  for (var attempt = 0; attempt < 2 && !quiz; attempt++) {
    var reply = await callClaude(SYSTEM, 'SOP TITLE: ' + sop.title + '\n\nSOP TEXT:\n' + text);
    var out = (reply && reply.content && reply.content[0] && reply.content[0].text) || '';
    var parsed = extractJson(out);
    if (validQuiz(parsed)) quiz = parsed;
  }
  if (!quiz) throw new Error('AI did not return a valid 2-question quiz for "' + sop.title + '"');

  // Persist. Replace any existing draft for this week.
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var existing = await client.query('SELECT id FROM quizzes WHERE week_of = $1', [week]);
    var quizId;
    if (existing.rows.length) {
      quizId = existing.rows[0].id;
      // Clear prior assignments first — this cascades to quiz_answers (FK on
      // assignment_id has ON DELETE CASCADE), so answers no longer reference the
      // old questions and the question delete below won't violate the FK.
      await client.query('DELETE FROM quiz_assignments WHERE quiz_id = $1', [quizId]);
      await client.query('DELETE FROM quiz_questions WHERE quiz_id = $1', [quizId]);
      await client.query(
        "UPDATE quizzes SET sop_id = $1, sop_title = $2, status = 'draft' WHERE id = $3",
        [sop.id, sop.title, quizId]
      );
    } else {
      var ins = await client.query(
        "INSERT INTO quizzes (week_of, sop_id, sop_title, status) VALUES ($1,$2,$3,'draft') RETURNING id",
        [week, sop.id, sop.title]
      );
      quizId = ins.rows[0].id;
    }
    for (var p = 0; p < quiz.questions.length; p++) {
      var q = quiz.questions[p];
      await client.query(
        'INSERT INTO quiz_questions (quiz_id, position, prompt, options, correct_index) VALUES ($1,$2,$3,$4,$5)',
        [quizId, p + 1, q.prompt.trim(), JSON.stringify(q.options), q.correct_index]
      );
    }
    await client.query('COMMIT');
    return quizId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { generateQuiz, weekMonday };
