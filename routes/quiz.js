// routes/quiz.js
// Weekly SOP quiz API.
//   publicRouter  -> token-gated take + grade (no JWT), mounted at /api/quiz-take
//   router (admin)-> list / current / results / settings / manual generate+send,
//                    mounted at /api/quiz (view_quiz to read, manage_quiz to write)

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const permissions = require('../utils/permissions');
const { generateQuiz, weekMonday } = require('../utils/quizGen');
const { sendSms } = require('../utils/sms');

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
    "('quiz_roles','[\"locksmith\",\"locksmith_coordinator\",\"dispatcher\",\"roadside_technician\",\"manager\"]')," +
    "('quiz_pass_score','2'),('quiz_due_days','3') ON CONFLICT (key) DO NOTHING;"
  );
}
ensureQuizTables().catch(function (e) { console.error('[quiz] table init failed:', e.message); });

// ---- settings helpers ------------------------------------------------------

var SETTING_KEYS = ['quiz_enabled', 'quiz_send_dow', 'quiz_send_time', 'quiz_roles', 'quiz_pass_score', 'quiz_due_days'];

async function getQuizSettings() {
  var { rows } = await pool.query('SELECT key, value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  var map = {};
  rows.forEach(function (r) { map[r.key] = r.value; });
  var roles;
  try { roles = JSON.parse(map.quiz_roles); } catch (e) { roles = null; }
  if (!Array.isArray(roles)) roles = ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician', 'manager'];
  return {
    enabled: map.quiz_enabled === 'true' || map.quiz_enabled === true,
    dow: map.quiz_send_dow !== undefined ? parseInt(map.quiz_send_dow, 10) : 1, // 1 = Monday
    time: map.quiz_send_time || '09:00',
    roles: roles,
    passScore: map.quiz_pass_score !== undefined ? parseInt(map.quiz_pass_score, 10) : 2,
    dueDays: map.quiz_due_days !== undefined ? parseInt(map.quiz_due_days, 10) : 3
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
      'SELECT qa.id, qa.status, qa.score, qa.passed, qa.quiz_id, q.sop_title, q.status AS quiz_status ' +
      'FROM quiz_assignments qa JOIN quizzes q ON q.id = qa.quiz_id WHERE qa.token = $1',
      [req.params.token]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'Quiz not found or link expired.' });
    var asg = a.rows[0];
    var qs = await pool.query(
      'SELECT id, position, prompt, options, correct_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [asg.quiz_id]
    );
    var completed = asg.status === 'completed';
    // Only reveal the answer key AFTER the quiz is completed, never before.
    var selMap = {};
    if (completed) {
      var ans = await pool.query('SELECT question_id, selected_index FROM quiz_answers WHERE assignment_id = $1', [asg.id]);
      ans.rows.forEach(function (r) { selMap[r.question_id] = r.selected_index; });
    }
    res.json({
      sopTitle: asg.sop_title,
      completed: completed,
      score: asg.score,
      passed: asg.passed,
      total: qs.rows.length,
      questions: qs.rows.map(function (r) {
        var o = { id: r.id, position: r.position, prompt: r.prompt, options: r.options };
        if (completed) { o.correct_index = r.correct_index; o.selected_index = (r.id in selMap) ? selMap[r.id] : -1; }
        return o;
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

// GET /api/quiz/:id/results -> per-user completion + scores (+ overdue flag)
router.get('/:id/results', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var settings = await getQuizSettings();
    var { rows } = await pool.query(
      'SELECT u.name, u.role, a.status, a.score, a.passed, a.sent_at, a.completed_at, a.reminders_sent, ' +
      "  (a.status = 'pending' AND a.sent_at < NOW() - ($2 || ' days')::interval) AS overdue " +
      'FROM quiz_assignments a JOIN users u ON u.id = a.user_id ' +
      'WHERE a.quiz_id = $1 ORDER BY a.status ASC, u.name ASC',
      [req.params.id, String(settings.dueDays)]
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
      ['quiz_pass_score', String(parseInt(b.passScore, 10) || 2)],
      ['quiz_due_days', String(parseInt(b.dueDays, 10) || 3)]
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

// GET /api/quiz/compliance -> headline numbers for the dashboard
router.get('/compliance', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var settings = await getQuizSettings();
    var cur = await pool.query("SELECT id, week_of FROM quizzes WHERE status = 'sent' ORDER BY week_of DESC LIMIT 1");
    var thisWeek = null;
    if (cur.rows.length) {
      var q = cur.rows[0];
      var c = await pool.query(
        "SELECT COUNT(*)::int AS assigned, " +
        "  COUNT(*) FILTER (WHERE status = 'completed')::int AS completed, " +
        "  COUNT(*) FILTER (WHERE status = 'pending' AND sent_at < NOW() - ($2 || ' days')::interval)::int AS overdue " +
        "FROM quiz_assignments WHERE quiz_id = $1",
        [q.id, String(settings.dueDays)]
      );
      var r = c.rows[0];
      thisWeek = {
        week_of: q.week_of, assigned: r.assigned, completed: r.completed, overdue: r.overdue,
        pct: r.assigned ? Math.round(100 * r.completed / r.assigned) : 0
      };
    }
    var ov = await pool.query(
      "SELECT COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed " +
      "FROM quiz_assignments a JOIN quizzes q ON q.id = a.quiz_id WHERE q.status IN ('sent','closed')"
    );
    var o = ov.rows[0];
    res.json({
      dueDays: settings.dueDays,
      thisWeek: thisWeek,
      overallPct: o.assigned ? Math.round(100 * o.completed / o.assigned) : 0,
      overallCompleted: o.completed, overallAssigned: o.assigned
    });
  } catch (e) {
    console.error('quiz compliance:', e.message);
    res.status(500).json({ error: 'Failed to load compliance.' });
  }
});

// GET /api/quiz/roster -> per-employee history rollup across all quizzes
router.get('/roster', requireAuth, requirePermission('view_quiz'), async function (req, res) {
  try {
    var stats = await pool.query(
      "SELECT u.id, u.name, u.role, " +
      "  COUNT(a.id) AS assigned, " +
      "  COUNT(a.id) FILTER (WHERE a.status='completed') AS completed, " +
      "  COUNT(a.id) FILTER (WHERE a.passed) AS passed, " +
      "  COALESCE(SUM(a.score) FILTER (WHERE a.status='completed'),0)::int AS correct, " +
      "  COALESCE(SUM(CASE WHEN a.status='completed' THEN (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = a.quiz_id) ELSE 0 END),0)::int AS possible, " +
      "  MAX(a.completed_at) AS last_completed " +
      "FROM quiz_assignments a JOIN users u ON u.id = a.user_id " +
      "GROUP BY u.id, u.name, u.role ORDER BY u.name ASC"
    );
    // Trouble topic = the SOP where the user has the most wrong answers.
    var wrong = await pool.query(
      "SELECT a.user_id, qz.sop_title, COUNT(*) FILTER (WHERE ans.correct = false)::int AS wrong " +
      "FROM quiz_answers ans " +
      "JOIN quiz_assignments a ON a.id = ans.assignment_id " +
      "JOIN quizzes qz ON qz.id = a.quiz_id " +
      "GROUP BY a.user_id, qz.sop_title"
    );
    var trouble = {};
    wrong.rows.forEach(function (r) {
      if (!r.wrong) return;
      if (!trouble[r.user_id] || r.wrong > trouble[r.user_id].wrong) trouble[r.user_id] = { topic: r.sop_title, wrong: r.wrong };
    });
    res.json(stats.rows.map(function (r) {
      return {
        id: r.id, name: r.name, role: r.role,
        assigned: parseInt(r.assigned, 10), completed: parseInt(r.completed, 10), passed: parseInt(r.passed, 10),
        correct: r.correct, possible: r.possible, last_completed: r.last_completed,
        trouble: trouble[r.id] ? trouble[r.id].topic : null
      };
    }));
  } catch (e) {
    console.error('quiz roster:', e.message);
    res.status(500).json({ error: 'Failed to load roster.' });
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

// GET /api/quiz/mine -> the logged-in user's current open quiz (no token needed)
router.get('/mine', requireAuth, async function (req, res) {
  try {
    var a = await pool.query(
      "SELECT qa.id, qa.status, qa.score, qa.passed, qa.quiz_id, q.sop_title " +
      "FROM quiz_assignments qa JOIN quizzes q ON q.id = qa.quiz_id " +
      "WHERE qa.user_id = $1 AND q.status = 'sent' ORDER BY q.week_of DESC LIMIT 1",
      [req.user.id]
    );
    if (!a.rows.length) return res.json({ quiz: null });
    var asg = a.rows[0];
    var qs = await pool.query(
      'SELECT id, position, prompt, options, correct_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [asg.quiz_id]
    );
    var completed = asg.status === 'completed';
    // Only reveal the answer key AFTER the quiz is completed, never before.
    var selMap = {};
    if (completed) {
      var ans = await pool.query('SELECT question_id, selected_index FROM quiz_answers WHERE assignment_id = $1', [asg.id]);
      ans.rows.forEach(function (r) { selMap[r.question_id] = r.selected_index; });
    }
    res.json({
      quiz: { sopTitle: asg.sop_title },
      completed: completed,
      score: asg.score,
      passed: asg.passed,
      total: qs.rows.length,
      questions: qs.rows.map(function (r) {
        var o = { id: r.id, position: r.position, prompt: r.prompt, options: r.options };
        if (completed) { o.correct_index = r.correct_index; o.selected_index = (r.id in selMap) ? selMap[r.id] : -1; }
        return o;
      })
    });
  } catch (e) {
    console.error('quiz mine get:', e.message);
    res.status(500).json({ error: 'Failed to load your quiz.' });
  }
});

// POST /api/quiz/mine -> submit answers for the logged-in user's open quiz
router.post('/mine', requireAuth, async function (req, res) {
  var client = await pool.connect();
  try {
    var answers = (req.body && req.body.answers) || [];
    var a = await client.query(
      "SELECT qa.id, qa.quiz_id, qa.status FROM quiz_assignments qa JOIN quizzes q ON q.id = qa.quiz_id " +
      "WHERE qa.user_id = $1 AND q.status = 'sent' ORDER BY q.week_of DESC LIMIT 1",
      [req.user.id]
    );
    if (!a.rows.length) return res.status(404).json({ error: 'No open quiz.' });
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
    console.error('quiz mine post:', e.message);
    res.status(500).json({ error: 'Failed to submit.' });
  } finally {
    client.release();
  }
});

// POST /api/quiz/:id/send-test -> create/reuse an assignment for the CURRENT
// user (bypasses the role filter so an admin can try it), text the link if they
// have a phone, and return the link so the dashboard can open it. Works even on
// a 'draft' quiz — nothing is marked sent and the team is not messaged.
router.post('/:id/send-test', requireAuth, requirePermission('manage_quiz'), async function (req, res) {
  try {
    var quizId = parseInt(req.params.id, 10);
    var qz = await pool.query('SELECT id FROM quizzes WHERE id = $1', [quizId]);
    if (!qz.rows.length) return res.status(404).json({ error: 'Quiz not found.' });
    var u = await pool.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    var ex = await pool.query('SELECT token FROM quiz_assignments WHERE quiz_id = $1 AND user_id = $2', [quizId, req.user.id]);
    var tok;
    if (ex.rows.length) {
      tok = ex.rows[0].token;
    } else {
      tok = token();
      await pool.query(
        "INSERT INTO quiz_assignments (quiz_id, user_id, token, status, sent_at) VALUES ($1,$2,$3,'pending',NOW())",
        [quizId, req.user.id, tok]
      );
    }
    var base = (process.env.APP_URL || '').replace(/\/$/, '');
    if (!base) base = req.protocol + '://' + req.get('host'); // fall back to the portal the admin is on
    var link = base + '/?quiz=' + tok;
    var texted = false;
    if (u.rows.length && u.rows[0].phone) {
      try { await sendSms(u.rows[0].phone, 'SOP quiz test: ' + link); texted = true; } catch (e) { /* ignore */ }
    }
    res.json({ success: true, link: link, texted: texted });
  } catch (e) {
    console.error('quiz send-test:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ======================= TEAM (manager, downline-scoped) ===================
// Managers see quiz history for their own downline only. Read-only: no
// generate/send/settings surface. Gate lets the 'manager' role in out-of-the
// -box, plus anyone granted the view_team_quiz permission (admin/owner too).

async function downlineIds(managerId) {
  var r = await pool.query(
    'WITH RECURSIVE dl AS (' +
    '  SELECT id FROM users WHERE supervisor_id = $1' +
    '  UNION' +
    '  SELECT u.id FROM users u JOIN dl ON u.supervisor_id = dl.id' +
    ') SELECT id FROM dl',
    [managerId]
  );
  return r.rows.map(function (x) { return x.id; });
}

async function requireTeamQuiz(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    var role = req.user.role;
    if (role === 'admin' || role === 'manager' || req.user.isOwner) return next();
    if (await permissions.hasPermission(role, 'view_team_quiz')) return next();
    var ep = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [req.user.id]);
    var arr = ep.rows.length ? ep.rows[0].extra_perms : null;
    if (Array.isArray(arr) && arr.indexOf('view_team_quiz') !== -1) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    return res.status(403).json({ error: 'Forbidden' });
  }
}

// GET /api/quiz/team/roster -> per-employee history rollup, downline only.
router.get('/team/roster', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var ids = await downlineIds(req.user.id);
    if (!ids.length) return res.json([]);
    var stats = await pool.query(
      'SELECT u.id, u.name, u.role, ' +
      '  COUNT(a.id) AS assigned, ' +
      "  COUNT(a.id) FILTER (WHERE a.status='completed') AS completed, " +
      '  COUNT(a.id) FILTER (WHERE a.passed) AS passed, ' +
      "  COALESCE(SUM(a.score) FILTER (WHERE a.status='completed'),0)::int AS correct, " +
      "  COALESCE(SUM(CASE WHEN a.status='completed' THEN (SELECT COUNT(*) FROM quiz_questions qq WHERE qq.quiz_id = a.quiz_id) ELSE 0 END),0)::int AS possible, " +
      '  MAX(a.completed_at) AS last_completed ' +
      'FROM users u LEFT JOIN quiz_assignments a ON a.user_id = u.id ' +
      'WHERE u.id = ANY($1) ' +
      'GROUP BY u.id, u.name, u.role ORDER BY u.name ASC',
      [ids]
    );
    var wrong = await pool.query(
      "SELECT a.user_id, qz.sop_title, COUNT(*) FILTER (WHERE ans.correct = false)::int AS wrong " +
      'FROM quiz_answers ans JOIN quiz_assignments a ON a.id = ans.assignment_id ' +
      'JOIN quizzes qz ON qz.id = a.quiz_id WHERE a.user_id = ANY($1) ' +
      'GROUP BY a.user_id, qz.sop_title',
      [ids]
    );
    var trouble = {};
    wrong.rows.forEach(function (r) {
      if (!r.wrong) return;
      if (!trouble[r.user_id] || r.wrong > trouble[r.user_id].wrong) trouble[r.user_id] = { topic: r.sop_title, wrong: r.wrong };
    });
    res.json(stats.rows.map(function (r) {
      return {
        id: r.id, name: r.name, role: r.role,
        assigned: parseInt(r.assigned, 10), completed: parseInt(r.completed, 10), passed: parseInt(r.passed, 10),
        correct: r.correct, possible: r.possible, last_completed: r.last_completed,
        trouble: trouble[r.id] ? trouble[r.id].topic : null
      };
    }));
  } catch (e) {
    console.error('quiz team roster:', e.message);
    res.status(500).json({ error: 'Failed to load team roster.' });
  }
});

// GET /api/quiz/team/compliance -> headline numbers, downline only.
router.get('/team/compliance', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var settings = await getQuizSettings();
    var ids = await downlineIds(req.user.id);
    if (!ids.length) return res.json({ dueDays: settings.dueDays, thisWeek: null, overallPct: 0, overallCompleted: 0, overallAssigned: 0 });
    var cur = await pool.query("SELECT id, week_of FROM quizzes WHERE status = 'sent' ORDER BY week_of DESC LIMIT 1");
    var thisWeek = null;
    if (cur.rows.length) {
      var q = cur.rows[0];
      var c = await pool.query(
        'SELECT COUNT(*)::int AS assigned, ' +
        "  COUNT(*) FILTER (WHERE status = 'completed')::int AS completed, " +
        "  COUNT(*) FILTER (WHERE status = 'pending' AND sent_at < NOW() - ($2 || ' days')::interval)::int AS overdue " +
        'FROM quiz_assignments WHERE quiz_id = $1 AND user_id = ANY($3)',
        [q.id, String(settings.dueDays), ids]
      );
      var r = c.rows[0];
      thisWeek = { week_of: q.week_of, assigned: r.assigned, completed: r.completed, overdue: r.overdue, pct: r.assigned ? Math.round(100 * r.completed / r.assigned) : 0 };
    }
    var ov = await pool.query(
      "SELECT COUNT(*)::int AS assigned, COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed " +
      "FROM quiz_assignments a JOIN quizzes q ON q.id = a.quiz_id WHERE q.status IN ('sent','closed') AND a.user_id = ANY($1)",
      [ids]
    );
    var o = ov.rows[0];
    res.json({ dueDays: settings.dueDays, thisWeek: thisWeek, overallPct: o.assigned ? Math.round(100 * o.completed / o.assigned) : 0, overallCompleted: o.completed, overallAssigned: o.assigned });
  } catch (e) {
    console.error('quiz team compliance:', e.message);
    res.status(500).json({ error: 'Failed to load team compliance.' });
  }
});

// GET /api/quiz/team -> quizzes with completion counts, downline only.
router.get('/team', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var ids = await downlineIds(req.user.id);
    if (!ids.length) return res.json([]);
    var out = await pool.query(
      'SELECT q.id, q.week_of, q.sop_title, q.status, q.sent_at, ' +
      '  COUNT(a.*) AS assigned, ' +
      "  COUNT(a.*) FILTER (WHERE a.status='completed') AS completed, " +
      '  COUNT(a.*) FILTER (WHERE a.passed) AS passed ' +
      'FROM quizzes q JOIN quiz_assignments a ON a.quiz_id = q.id AND a.user_id = ANY($1) ' +
      'GROUP BY q.id ORDER BY q.week_of DESC LIMIT 52',
      [ids]
    );
    res.json(out.rows);
  } catch (e) {
    console.error('quiz team list:', e.message);
    res.status(500).json({ error: 'Failed to load team quizzes.' });
  }
});

// GET /api/quiz/team/:id/results -> per-user completion + scores, downline only.
router.get('/team/:id/results', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var settings = await getQuizSettings();
    var ids = await downlineIds(req.user.id);
    if (!ids.length) return res.json([]);
    var out = await pool.query(
      'SELECT a.id AS assignment_id, u.name, u.role, a.status, a.score, a.passed, a.sent_at, a.completed_at, a.reminders_sent, ' +
      "  (a.status = 'pending' AND a.sent_at < NOW() - ($2 || ' days')::interval) AS overdue " +
      'FROM quiz_assignments a JOIN users u ON u.id = a.user_id ' +
      'WHERE a.quiz_id = $1 AND a.user_id = ANY($3) ORDER BY a.status ASC, u.name ASC',
      [req.params.id, String(settings.dueDays), ids]
    );
    res.json(out.rows);
  } catch (e) {
    console.error('quiz team results:', e.message);
    res.status(500).json({ error: 'Failed to load team results.' });
  }
});

// GET /api/quiz/team/:id/breakdown -> per-question answer distribution across the
// manager's downline for one quiz. Powers the training view: which questions the
// team missed most, and how they split across the options.
router.get('/team/:id/breakdown', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var ids = await downlineIds(req.user.id);
    if (!ids.length) return res.json({ questions: [] });
    var qs = await pool.query(
      'SELECT id, position, prompt, options, correct_index FROM quiz_questions WHERE quiz_id = $1 ORDER BY position ASC',
      [req.params.id]
    );
    var dist = await pool.query(
      'SELECT ans.question_id, ans.selected_index, COUNT(*)::int AS n ' +
      'FROM quiz_answers ans ' +
      'WHERE ans.assignment_id IN (SELECT id FROM quiz_assignments WHERE quiz_id = $1 AND user_id = ANY($2)) ' +
      'GROUP BY ans.question_id, ans.selected_index',
      [req.params.id, ids]
    );
    var byq = {};
    dist.rows.forEach(function (r) {
      if (!byq[r.question_id]) byq[r.question_id] = {};
      byq[r.question_id][r.selected_index] = r.n;
    });
    res.json({
      questions: qs.rows.map(function (q) {
        var counts = byq[q.id] || {};
        var answered = 0;
        Object.keys(counts).forEach(function (k) { answered += counts[k]; });
        return {
          position: q.position, prompt: q.prompt, options: q.options, correct_index: q.correct_index,
          answered: answered, correct_count: counts[q.correct_index] || 0,
          counts: (q.options || []).map(function (_, oi) { return counts[oi] || 0; })
        };
      })
    });
  } catch (e) {
    console.error('quiz team breakdown:', e.message);
    res.status(500).json({ error: 'Failed to load breakdown.' });
  }
});

// GET /api/quiz/assignment/:id/detail -> full drill-down of one person's answers.
router.get('/assignment/:id/detail', requireAuth, requireTeamQuiz, async function (req, res) {
  try {
    var aq = await pool.query(
      'SELECT a.id, a.user_id, a.quiz_id, a.status, a.score, a.passed, a.completed_at, u.name, q.sop_title, q.week_of ' +
      'FROM quiz_assignments a JOIN users u ON u.id = a.user_id JOIN quizzes q ON q.id = a.quiz_id WHERE a.id = $1',
      [req.params.id]
    );
    if (!aq.rows.length) return res.status(404).json({ error: 'Not found.' });
    var asg = aq.rows[0];
    if (!(req.user.role === 'admin' || req.user.isOwner)) {
      var ids = await downlineIds(req.user.id);
      if (ids.indexOf(asg.user_id) === -1) return res.status(403).json({ error: 'Forbidden' });
    }
    var qs = await pool.query(
      'SELECT qq.id, qq.position, qq.prompt, qq.options, qq.correct_index, ans.selected_index, ans.correct ' +
      'FROM quiz_questions qq ' +
      'LEFT JOIN quiz_answers ans ON ans.question_id = qq.id AND ans.assignment_id = $1 ' +
      'WHERE qq.quiz_id = $2 ORDER BY qq.position ASC',
      [asg.id, asg.quiz_id]
    );
    res.json({
      name: asg.name, sop_title: asg.sop_title, week_of: asg.week_of,
      status: asg.status, score: asg.score, passed: asg.passed, completed_at: asg.completed_at,
      questions: qs.rows.map(function (r) {
        return { position: r.position, prompt: r.prompt, options: r.options, correct_index: r.correct_index, selected_index: r.selected_index, correct: r.correct };
      })
    });
  } catch (e) {
    console.error('quiz assignment detail:', e.message);
    res.status(500).json({ error: 'Failed to load answers.' });
  }
});

module.exports = router;
module.exports.publicRouter = pub;
module.exports.getQuizSettings = getQuizSettings;
module.exports.makeToken = token;
