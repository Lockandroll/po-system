// routes/quiz.js
// Weekly SOP quiz API.
//   publicRouter  -> token-gated take + grade (no JWT), mounted at /api/quiz-take
//   router (admin)-> list / current / results / settings / manual generate+send,
//                    mounted at /api/quiz (view_quiz to read, manage_quiz to write)

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { generateQuiz, weekMonday } = require('../utils/quizGen');

const router = express.Router();       // admin surface
const pub = express.Router();          // public token surface

// Self-bootstrapping: create the quiz tables + seed default settings on load, so
// this module works without editing db.js. All statements are idempotent.
async function ensureQuizTables() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS quizzes (' +
    '  id SERIAL PRIMARY KEY,' +
    '  week_of DATE NOT NULL UNIQUE,' +
    '  sop_id INTEGER REFERENCES sop_documents(id),' +
    '  sop_title VARCHAR(255),' +
    "  status VARCHAR(20) NOT NULL DEFAULT 'draft'," +
    '  created_at TIMESTAMPTZ DEFAULT NOW(),' +
    '  sent_at TIMESTAMPTZ' +
    ');'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS quiz_questions (' +
    '  id SERIAL PRIMARY KEY,' +
    '  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,' +
    '  position INTEGER NOT NULL,' +
    '  prompt TEXT NOT NULL,' +
    '  options JSONB NOT NULL,' +
    '  correct_index INTEGER NOT NULL' +
    ');'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS quiz_assignments (' +
    '  id SERIAL PRIMARY KEY,' +
    '  quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,' +
    '  user_id INTEGER NOT NULL REFERENCES users(id),' +
    '  token VARCHAR(64) NOT NULL UNIQUE,' +
    "  status VARCHAR(20) NOT NULL DEFAULT 'pending'," +
    '  score INTEGER,' +
    '  passed BOOLEAN,' +
    '  sent_at TIMESTAMPTZ,' +
    '  completed_at TIMESTAMPTZ,' +
    '  reminders_sent INTEGER NOT NULL DEFAULT 0' +
    ');'
  );
  await pool.query(
    'CREATE TABLE IF NOT EXISTS quiz_answers (' +
    '  id SERIAL PRIMARY KEY,' +
    '  assignment_id INTEGER NOT NULL REFERENCES quiz_assignments(id) ON DELETE CASCADE,' +
    '  question_id INTEGER NOT NULL REFERENCES quiz_questions(id),' +
    '  selected_index INTEGER,' +
    '  correct BOOLEAN' +
    ');'
  );
  await pool.query('CREATE INDEX IF NOT EXISTS idx_quiz_assign_quiz ON quiz_assignments(quiz_id);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_quiz_assign_token ON quiz_assignments(token);');
  await pool.query(
    "INSERT INTO settings (key, value) VALUES " +
    "('quiz_enabled','false'),('quiz_send_dow','1'),('quiz_send_time','09:00')," +
    "('quiz_roles','[\"locksmith\",\"locksmith_coordinator\",\"roadside_technician\",\"manager\"]')," +
    "('quiz_pass_score','2') ON CONFLICT (key) DO NOTHING;"
  );
}
ensureQuizTables().catch(function (e) { console.error('[quiz] table init failed:', e.message); });

// ---- settings helpers ------------------------------------------------------

var SETTING_KEYS = ['quiz_enabled', 'quiz_send_dow', 'quiz_send_time', 'quiz_roles', 'quiz_pass_score'];

async function getQuizSettings() {
  var { rows } = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  var map = {};
  rows.forEach(function (r) { map[r.key] = r.value; });
  var roles;
  try { roles = JSON.parse(map.quiz_roles); } catch (e) { roles = null; }
  if (!Array.isArray(roles)) roles = ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager'];
  return {
    enabled: map.quiz_enabled === 'true' || map.quiz_enabled === true,
    dow: map.quiz_send_dow !== undefined ? parseInt(map.quiz_send_dow, 10) : 1, // 1 = Monday
    time: map.quiz_send_time || '09:00',
    roles: roles,
    passScore: map.quiz_pass_score !== undefined ? parseInt(map.quiz_pass_score, 10) : 2
  };
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

// ============================ PUBLIC (token) ================================

// GET /api/quiz-take/:token  -> questions WITHOUT the correct answers
pub.get('/:token', async function (req, res) {
  try {
    var a = await pool.query(
      'SELECT qa.id, qa.status, qa.score, qa.quiz_id, q.sop_title, q.status AS quiz_status ' +
      'FROM quiz_assignments qa JOIN quizzes q ON q.id = qa.quiz_id WHERE qa.token = $1',
      [req.params.token]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Quiz not found or link expired.' });
    var asg = a.rows[0];
    var qs = await pool.query(
      'SELECT id, position, prompt, options FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [asg.quiz_id]
    );
    res.json({
      sopTitle: asg.sop_title,
      completed: asg.status === 'completed',
      score: asg.score,
      total: qs.rows.length,
      questions: qs.rows.map(function (r) {
        return { id: r.id, position: r.position, prompt: r.prompt, options: r.options };
      })
    });
  } catch (e) {
    console.error('quiz-take get:', e.message);
    res.status(500).json({ error: 'Failed to load quiz.' });
  }
});

// POST /api/quiz-take/:token  body { answers: [selectedIndex, selectedIndex] }
pub.post('/:token', async function (req, res) {
  var client = await pool.connect();
  try {
    var answers = (req.body && req.body.answers) || [];
    var a = await client.query(
      'SELECT id, quiz_id, status FROM quiz_assignments WHERE token = $1', [req.params.token]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Quiz not found or link expired.' });
    var asg = a.rows[0];
    if (asg.status === 'completed') return res.status(409).json({ error: 'You already completed this quiz.' });

    var qs = await client.query(
      'SELECT id, position, correct_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [asg.quiz_id]
    );
    var settings = await getQuizSettings();

    await client.query('BEGIN');
    var score = 0;
    var results = [];
    for (var i = 0; i < qs.rows.length; i++) {
      var q = qs.rows[i];
      var sel = (typeof answers[i] === 'number') ? answers[i] : -1;
      var correct = sel === q.correct_index;
      if (correct) score++;
      await client.query(
        'INSERT INTO quiz_answers (assignment_id, question_id, selected_index, correct) VALUES ($1,$2,$3,$4)',
        [asg.id, q.id, sel, correct]
      );
      results.push({ position: q.position, selected: sel, correct_index: q.correct_index, correct: correct });
    }
    var passed = score >= settings.passScore;
    await client.query(
      "UPDATE quiz_assignments SET status='completed', score=$1, passed=$2, completed_at=NOW() WHERE id=$3",
      [score, passed, asg.id]
    );
    await client.query('COMMIT');
    res.json({ score: score, total: qs.rows.length, passed: passed, results: results });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('quiz-take post:', e.message);
    res.status(500).json({ error: 'Failed to submit quiz.' });
  } finally {
    client.release();
  }
});

// ============================ ADMIN =========================================

// GET /api/quiz  -> quizzes with completion counts
router.get('/', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var { rows } = await pool.query(
      'SELECT q.id, q.week_of, q.sop_title, q.status, q.sent_at, ' +
      "  COUNT(a.*) FILTER (WHERE TRUE) AS assigned, " +
      "  COUNT(a.*) FILTER (WHERE a.status='completed') AS completed, " +
      "  COUNT(a.*) FILTER (WHERE a.passed) AS passed " +
      'FROM quizzes q LEFT JOIN quiz_assignments a ON a.quiz_id = q.id ' +
      'GROUP BY q.id ORDER BY q.week_of DESC LIMIT 52'
    );
    res.json(rows);
  } catch (e) {
    console.error('quiz list:', e.message);
    res.status(500).json({ error: 'Failed to load quizzes.' });
  }
});

// GET /api/quiz/current -> this week's quiz + questions (with answers, admin view)
router.get('/current', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var week = weekMonday(new Date());
    var q = await pool.query('SELECT * FROM quizzes WHERE week_of = $1', [week]);
    if (!q.rows.length) return res.json({ quiz: null, week_of: week });
    var quiz = q.rows[0];
    var qs = await pool.query(
      'SELECT id, position, prompt, options, correct_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [quiz.id]
    );
    res.json({ quiz: quiz, questions: qs.rows });
  } catch (e) {
    console.error('quiz current:', e.message);
    res.status(500).json({ error: 'Failed to load current quiz.' });
  }
});

// GET /api/quiz/:id/results -> per-user completion + scores
router.get('/:id/results', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var { rows } = await pool.query(
      'SELECT u.name, u.role, a.status, a.score, a.passed, a.sent_at, a.completed_at, a.reminders_sent ' +
      'FROM quiz_assignments a JOIN users u ON u.id = a.user_id ' +
      'WHERE a.quiz_id = $1 ORDER BY a.status ASC, u.name ASC',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('quiz results:', e.message);
    res.status(500).json({ error: 'Failed to load results.' });
  }
});

// GET /api/quiz/settings
router.get('/settings', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  res.json(await getQuizSettings());
});

// PUT /api/quiz/settings  { enabled, dow, time, roles, passScore }
router.put('/settings', requireAuth, requirePermission('manage_quiz'), async function (req, res) {
  try {
    var b = req.body || {};
    var pairs = [
      ['quiz_enabled', b.enabled ? 'true' : 'false'],
      ['quiz_send_dow', String(parseInt(b.dow, 10) || 0)],
      ['quiz_send_time', String(b.time || '09:00')],
      ['quiz_roles', JSON.stringify(Array.isArray(b.roles) ? b.roles : [])],
      ['quiz_pass_score', String(parseInt(b.passScore, 10) || 2)]
    ];
    for (var i = 0; i < pairs.length; i++) {
      await pool.query(
        'INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW()) ' +
        'ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()',
        pairs[i]
      );
    }
    res.json(await getQuizSettings());
  } catch (e) {
    console.error('quiz settings put:', e.message);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// POST /api/quiz/generate -> manually (re)generate this week's draft (testing)
router.post('/generate', requireAuth, requirePermission('manage_quiz'), async function (req, res) {
  try {
    var id = await generateQuiz(weekMonday(new Date()));
    res.json({ success: true, quizId: id });
  } catch (e) {
    console.error('quiz generate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/quiz/:id/send -> manually send a quiz now (testing / re-send)
router.post('/:id/send', requireAuth, requirePermission('manage_quiz'), async function (req, res) {
  try {
    var jobs = require('../jobs/quiz');
    var n = await jobs.sendQuiz(parseInt(req.params.id, 10));
    res.json({ success: true, sent: n });
  } catch (e) {
    console.error('quiz send:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.publicRouter = pub;
module.exports.getQuizSettings = getQuizSettings;
module.exports.makeToken = token;
