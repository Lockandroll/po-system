// routes/onboarding.js
// New-hire onboarding: a gated, strictly sequential track (video / SOP read /
// quiz steps) that must be finished — and signed off by a supervisor — before
// the user's real role unlocks. The lock itself lives in middleware/auth.js.
// No backticks in this file (Windows corrupts them). String concatenation only.
const express = require('express');
const https = require('https');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const push = require('../utils/push');

const router = express.Router();

const DEFAULT_PASS_SCORE = 80;
const DEFAULT_QUESTION_COUNT = 3;
const DEFAULT_MIN_SECONDS = 30;

function appUrl(path) { return (process.env.APP_URL || '').replace(/\/$/, '') + (path || ''); }

function cfg(step) {
  var c = step && step.config;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
  return c || {};
}
function passScore(step) { var v = parseInt(cfg(step).pass_score, 10); return (v >= 1 && v <= 100) ? v : DEFAULT_PASS_SCORE; }
function questionCount(step) { var v = parseInt(cfg(step).question_count, 10); return (v >= 1 && v <= 10) ? v : DEFAULT_QUESTION_COUNT; }
function minSeconds(step) { var v = parseInt(cfg(step).min_seconds, 10); return (v >= 0 && v <= 7200) ? v : DEFAULT_MIN_SECONDS; }

// ---- completion action (notify a chosen person + create a task on finish) ---
// Global default lives in settings key 'onboarding_completion'. A per-hire
// override on users.onboarding_completion_override (JSONB) is merged on top.
var DEFAULT_COMPLETION = {
  enabled: false,
  recipient_id: null,
  notify: true,
  create_task: true,
  task_title: 'Onboarding wrap-up for {{name}}',
  task_description: '{{name}} ({{role}}) finished onboarding on {{date}}, signed off by {{signer}}. Handle any remaining first-week items: equipment, accounts, keys, and schedule.',
  task_priority: 'medium',
  task_due_days: 3
};

function roleLabelSafe(role) {
  var s = String(role || '').split('_').map(function (w) { return w ? (w.charAt(0).toUpperCase() + w.slice(1)) : ''; }).join(' ');
  return s || 'New hire';
}
function fillTemplate(str, vars) {
  return String(str == null ? '' : str).replace(/\{\{(\w+)\}\}/g, function (m, k) { return (vars[k] != null ? String(vars[k]) : ''); });
}
function parseJsonMaybe(v) {
  if (v && typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return (v && typeof v === 'object') ? v : null;
}
async function getCompletionConfig() {
  var out = {}; Object.keys(DEFAULT_COMPLETION).forEach(function (k) { out[k] = DEFAULT_COMPLETION[k]; });
  try {
    var r = await pool.query("SELECT value FROM settings WHERE key = 'onboarding_completion'");
    var v = r.rows.length ? parseJsonMaybe(r.rows[0].value) : null;
    if (v) Object.keys(v).forEach(function (k) { if (v[k] !== undefined && v[k] !== null) out[k] = v[k]; });
  } catch (e) { console.error('[onboarding] completion config read failed:', e.message); }
  return out;
}
function mergeOverride(base, override) {
  var out = {}; Object.keys(base).forEach(function (k) { out[k] = base[k]; });
  var ov = parseJsonMaybe(override);
  if (ov) Object.keys(ov).forEach(function (k) { if (ov[k] !== undefined && ov[k] !== null && ov[k] !== '') out[k] = ov[k]; });
  return out;
}
function cleanCompletion(b) {
  b = b || {};
  var days = parseInt(b.task_due_days, 10);
  return {
    enabled: b.enabled === true,
    recipient_id: parseInt(b.recipient_id, 10) || null,
    notify: b.notify !== false,
    create_task: b.create_task !== false,
    task_title: String(b.task_title || '').slice(0, 300),
    task_description: String(b.task_description || '').slice(0, 4000),
    task_priority: (['low', 'medium', 'high'].indexOf(b.task_priority) >= 0) ? b.task_priority : 'medium',
    task_due_days: (days >= 0 && days <= 60) ? days : 3
  };
}
// newHire: { id, name, role, onboarding_completion_override }; signer: req.user
async function runCompletionAction(newHire, signer) {
  var conf = mergeOverride(await getCompletionConfig(), newHire.onboarding_completion_override);
  if (!conf.enabled) return;
  var recipientId = parseInt(conf.recipient_id, 10) || 0;
  if (!recipientId) return;
  var rr = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1 AND active = true', [recipientId]);
  if (!rr.rows.length) return;
  var rec = rr.rows[0];
  var vars = {
    name: newHire.name, role: roleLabelSafe(newHire.role),
    date: new Date().toLocaleDateString('en-US'), signer: signer.name, recipient: rec.name
  };
  var title = fillTemplate(conf.task_title, vars).trim() || ('Onboarding wrap-up for ' + newHire.name);
  var desc = fillTemplate(conf.task_description, vars);

  if (conf.create_task !== false) {
    try {
      var due = null; var days = parseInt(conf.task_due_days, 10);
      if (days >= 0) { var d = new Date(); d.setDate(d.getDate() + days); due = d.toISOString().slice(0, 10); }
      var pr = (['low', 'medium', 'high'].indexOf(conf.task_priority) >= 0) ? conf.task_priority : 'medium';
      var tr = await pool.query(
        "INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, source) VALUES ($1,$2,'todo',$3,$4,$5,$6,'onboarding') RETURNING id",
        [title, desc, pr, recipientId, signer.id, due]
      );
      var taskId = tr.rows[0].id;
      try { await pool.query("INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,'event',$4)", [taskId, signer.id, signer.name, 'created this task — ' + newHire.name + ' finished onboarding']); } catch (e) {}
    } catch (e) { console.error('[onboarding] completion task failed:', e.message); }
  }

  if (conf.notify !== false) {
    try {
      await push.sendPushToUsers([recipientId], { title: 'Onboarding complete', body: newHire.name + ' finished onboarding.', url: appUrl('/?view=tasks') });
      if (rec.receive_emails !== false && rec.email) {
        var html = emailTemplate({
          badge: 'Onboarding complete', badgeColor: 'green',
          title: newHire.name + ' finished onboarding',
          body: '<strong>' + newHire.name + '</strong> (' + vars.role + ') completed onboarding and was signed off by <strong>' + signer.name + '</strong>.' + (conf.create_task !== false ? ' A task has been created and assigned to you.' : ''),
          details: [{ label: 'New hire', value: newHire.name }, { label: 'Role', value: vars.role }, { label: 'Signed off by', value: signer.name }],
          buttonText: 'Open tasks', buttonUrl: appUrl('/?view=tasks')
        });
        await sendEmail(rec.email, newHire.name + ' finished onboarding', html);
      }
      if (rec.receive_sms && rec.phone) {
        await sendSms(rec.phone, 'Lock & Roll: ' + newHire.name + ' finished onboarding' + (conf.create_task !== false ? ' — a task was assigned to you.' : '.'));
      }
    } catch (e) { console.error('[onboarding] completion notify failed:', e.message); }
  }
}

// ---- shared queries ---------------------------------------------------------

async function activeSteps() {
  const r = await pool.query('SELECT * FROM onboarding_steps WHERE active = true ORDER BY position ASC, id ASC');
  return r.rows;
}
async function progressMap(userId) {
  const r = await pool.query('SELECT * FROM onboarding_progress WHERE user_id = $1', [userId]);
  const map = {};
  r.rows.forEach(function (p) { map[p.step_id] = p; });
  return map;
}
// The first active step the user has not completed, or null when all are done.
function findCurrent(steps, prog) {
  for (var i = 0; i < steps.length; i++) {
    var p = prog[steps[i].id];
    if (!p || p.status !== 'done') return steps[i];
  }
  return null;
}
async function ensureStarted(userId, stepId) {
  await pool.query(
    'INSERT INTO onboarding_progress (user_id, step_id, status, started_at) VALUES ($1,$2,$3,NOW()) ' +
    'ON CONFLICT (user_id, step_id) DO UPDATE SET started_at = COALESCE(onboarding_progress.started_at, NOW())',
    [userId, stepId, 'pending']
  );
}

// Walk the supervisor chain upward (same pattern as PTO approvals).
async function chainIds(userId) {
  const ids = []; let cur = userId, guard = 0;
  while (guard++ < 25) {
    const r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [cur]);
    if (!r.rows.length || !r.rows[0].supervisor_id) break;
    const sid = r.rows[0].supervisor_id;
    if (ids.indexOf(sid) !== -1) break;
    ids.push(sid); cur = sid;
  }
  return ids;
}
async function canSignOff(user, newHireId) {
  if (user.role === 'admin' || user.isOwner) return true;
  if (user.id === newHireId) return false;
  const chain = await chainIds(newHireId);
  return chain.indexOf(user.id) !== -1;
}

// ---- AI quiz generation (fresh questions on every attempt) ------------------

function callClaude(system, userText) {
  return new Promise(function (resolve, reject) {
    var body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 3000,
      system: system,
      messages: [{ role: 'user', content: userText }]
    });
    var options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
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
    rq.setTimeout(45000, function () { rq.destroy(new Error('AI request timed out.')); });
    rq.write(body);
    rq.end();
  });
}
function extractJson(text) {
  if (!text) return null;
  var s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (err) { return null; }
}
function validQuestions(obj, n) {
  if (!obj || !Array.isArray(obj.questions) || obj.questions.length !== n) return false;
  for (var i = 0; i < obj.questions.length; i++) {
    var q = obj.questions[i];
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) return false;
    if (!Array.isArray(q.options) || q.options.length !== 4) return false;
    for (var j = 0; j < 4; j++) { if (typeof q.options[j] !== 'string' || !q.options[j].trim()) return false; }
    if (typeof q.correct_index !== 'number' || q.correct_index < 0 || q.correct_index > 3) return false;
  }
  return true;
}
async function sopFullText(sopId) {
  const r = await pool.query('SELECT title, content FROM sop_documents WHERE id = $1', [sopId]);
  if (!r.rows.length) return null;
  return { title: r.rows[0].title, text: (r.rows[0].content || '').slice(0, 40000) };
}
// Find the matching pretty file in the "Standard Operating Procedures" vault
// folder for a given SOP, and return a short-lived inline URL to display it.
// Reading uses this file; quiz questions still come from sop_documents text.
function normName(s) {
  return String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
async function sopVaultDoc(sopId) {
  if (!r2.configured()) return null;
  const sr = await pool.query('SELECT title, filename FROM sop_documents WHERE id = $1', [sopId]);
  if (!sr.rows.length) return null;
  const fr = await pool.query("SELECT id FROM document_folders WHERE lower(trim(name)) = 'standard operating procedures'");
  if (!fr.rows.length) return null;
  const folderIds = fr.rows.map(function (f) { return f.id; });
  const dr = await pool.query("SELECT id, name, r2_key, mime_type FROM documents WHERE status = 'ready' AND folder_id = ANY($1::int[])", [folderIds]);
  if (!dr.rows.length) return null;
  const targets = [normName(sr.rows[0].title), normName(sr.rows[0].filename)].filter(Boolean);
  let best = null;
  for (let i = 0; i < dr.rows.length; i++) {
    const dn = normName(dr.rows[i].name);
    if (targets.indexOf(dn) !== -1) { best = dr.rows[i]; break; }
    if (!best && targets.some(function (t) { return t && (dn.indexOf(t) === 0 || t.indexOf(dn) === 0); })) best = dr.rows[i];
  }
  if (!best) return null;
  try {
    const url = await r2.presignDownload(best.r2_key, best.name, true, 3600);
    return { url: url, name: best.name, mime_type: best.mime_type };
  } catch (e) { return null; }
}
async function generateQuestions(step, avoidPrompts) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI is not configured (ANTHROPIC_API_KEY missing).');
  var n = questionCount(step);
  var sop = await sopFullText(step.sop_id);
  if (!sop || !sop.text || sop.text.length < 50) throw new Error('This step has no SOP text to quiz on. Ask an admin to check the step.');
  var system = [
    'You are writing an onboarding knowledge check for a new hire at a locksmith / roadside company.',
    'You will be given the text of ONE Standard Operating Procedure (SOP).',
    'Write exactly ' + n + ' multiple-choice questions that test understanding of that SOP.',
    'Rules:',
    '- Every question and every option must be grounded ONLY in the supplied SOP text. Do not invent facts.',
    '- Each question must have exactly 4 options with exactly one clearly correct answer.',
    '- Make wrong options plausible but clearly incorrect to someone who read the SOP.',
    '- Keep each question and option to one sentence.',
    (avoidPrompts && avoidPrompts.length ? '- Do NOT reuse or lightly rephrase these earlier questions: ' + avoidPrompts.join(' | ') : ''),
    'Respond with ONLY a JSON object, no prose, exactly:',
    '{"questions":[{"prompt":"...","options":["...","...","...","..."],"correct_index":0}]}'
  ].join('\n');
  var out = null;
  for (var attempt = 0; attempt < 2 && !out; attempt++) {
    var reply = await callClaude(system, 'SOP TITLE: ' + sop.title + '\n\nSOP TEXT:\n' + sop.text);
    if (reply && reply.error) throw new Error('AI error: ' + (reply.error.message || 'unknown'));
    var text = (reply && reply.content && reply.content[0] && reply.content[0].text) || '';
    var parsed = extractJson(text);
    if (validQuestions(parsed, n)) out = parsed;
  }
  if (!out) throw new Error('The AI did not return a valid quiz. Try again.');
  return out.questions;
}

// ---- notifications -----------------------------------------------------------

async function notifyReadyForSignoff(newHire) {
  try {
    var recipients = [];
    var sup = null;
    if (newHire.supervisor_id) {
      var sr = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1 AND active = true', [newHire.supervisor_id]);
      if (sr.rows.length) { sup = sr.rows[0]; recipients.push(sup); }
    }
    if (!recipients.length) {
      var ar = await pool.query("SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE active = true AND role IN ('admin','owner')");
      recipients = ar.rows;
    }
    var emails = recipients.filter(function (u) { return u.receive_emails !== false && u.email; }).map(function (u) { return u.email; });
    var phones = recipients.filter(function (u) { return u.receive_sms && u.phone; }).map(function (u) { return u.phone; });
    await push.sendPushToUsers(recipients.map(function (u) { return u.id; }), { title: 'Onboarding ready for sign-off', body: newHire.name + ' finished every onboarding step.', url: '/?view=onboarding-admin' });
    if (emails.length) {
      var html = emailTemplate({
        badge: 'Sign-off needed', badgeColor: 'green',
        title: newHire.name + ' finished onboarding',
        body: '<strong>' + newHire.name + '</strong> has completed every onboarding step. Review and sign off to unlock their full Nova access.',
        details: [{ label: 'New hire', value: newHire.name }, { label: 'Waiting on', value: sup ? sup.name : 'an admin' }],
        buttonText: 'Review & Sign Off', buttonUrl: appUrl('/?view=onboarding-admin')
      });
      await sendEmail(emails, 'Sign-off needed: ' + newHire.name + ' finished onboarding', html);
    }
    if (phones.length) {
      await sendSms(phones, 'Lock & Roll: ' + newHire.name + ' finished onboarding and needs your sign-off to unlock Nova. ' + appUrl('/?view=onboarding-admin'));
    }
  } catch (e) { console.error('[onboarding] signoff notify failed:', e.message); }
}

async function maybeNotifyReady(userId) {
  const steps = await activeSteps();
  if (!steps.length) return;
  const prog = await progressMap(userId);
  if (findCurrent(steps, prog)) return; // still has steps left
  const ur = await pool.query('SELECT id, name, supervisor_id FROM users WHERE id = $1', [userId]);
  if (ur.rows.length) await notifyReadyForSignoff(ur.rows[0]);
}

// ============================ NEW-HIRE ENDPOINTS ==============================

// GET /api/onboarding/me — my track: every step + status, and the current step's payload
router.get('/me', requireAuth, async (req, res) => {
  const ur = await pool.query('SELECT id, name, onboarding_status, onboarding_enrolled_at, supervisor_id FROM users WHERE id = $1', [req.user.id]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const me = ur.rows[0];
  const status = me.onboarding_status || 'complete';
  if (status === 'complete') return res.json({ onboarding_status: 'complete' });

  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);

  var supName = null;
  if (me.supervisor_id) {
    const sr = await pool.query('SELECT name FROM users WHERE id = $1', [me.supervisor_id]);
    if (sr.rows.length) supName = sr.rows[0].name;
  }

  const list = steps.map(function (s) {
    const p = prog[s.id];
    return {
      id: s.id, type: s.type, title: s.title, description: s.description,
      status: (p && p.status === 'done') ? 'done' : (current && current.id === s.id ? 'current' : 'locked'),
      score: p ? p.score : null, attempts: p ? p.attempts : 0
    };
  });

  var payload = { onboarding_status: status, name: me.name, supervisor_name: supName, steps: list, all_steps_done: !current, current: null };

  if (current) {
    await ensureStarted(req.user.id, current.id);
    var cur = { id: current.id, type: current.type, title: current.title, description: current.description, min_seconds: minSeconds(current) };
    if (current.type === 'video' && current.video_key && r2.configured()) {
      try { cur.video_url = await r2.presignDownload(current.video_key, 'welcome.mp4', true, 3600); } catch (e) { cur.video_error = 'Video is unavailable right now.'; }
    }
    if (current.type === 'sop_read' && current.sop_id) {
      const sop = await sopFullText(current.sop_id);
      if (sop) { cur.sop_title = sop.title; cur.sop_content = sop.text; }
      try {
        const vdoc = await sopVaultDoc(current.sop_id);
        if (vdoc) { cur.sop_doc_url = vdoc.url; cur.sop_doc_mime = vdoc.mime_type; cur.sop_doc_name = vdoc.name; }
      } catch (e) {}
    }
    if (current.type === 'quiz') {
      cur.pass_score = passScore(current);
      cur.question_count = questionCount(current);
      const p = prog[current.id];
      cur.attempts = p ? p.attempts : 0;
    }
    payload.current = cur;
  }
  res.json(payload);
});

// POST /api/onboarding/steps/:id/complete — finish a video or sop_read step
router.post('/steps/:id/complete', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  if (current.type === 'quiz') return res.status(400).json({ error: 'Quizzes are completed by passing them.' });

  // Server-side minimum time on step (started_at is set when the step is first served).
  const p = prog[stepId];
  const minS = minSeconds(current);
  if (minS > 0 && p && p.started_at) {
    const elapsed = (Date.now() - new Date(p.started_at).getTime()) / 1000;
    if (elapsed < minS) return res.status(400).json({ error: 'Take your time with this one — a little longer before continuing.' });
  }
  await pool.query(
    'INSERT INTO onboarding_progress (user_id, step_id, status, started_at, completed_at) VALUES ($1,$2,$3,NOW(),NOW()) ' +
    "ON CONFLICT (user_id, step_id) DO UPDATE SET status = 'done', completed_at = NOW()",
    [req.user.id, stepId, 'done']
  );
  await logAudit({ entity_type: 'onboarding', entity_id: stepId, action: 'step_completed', user_id: req.user.id, user_name: req.user.name, details: { step: current.title, type: current.type } });
  await maybeNotifyReady(req.user.id);
  res.json({ success: true });
});

// POST /api/onboarding/steps/:id/quiz/start — generate a fresh attempt
router.post('/steps/:id/quiz/start', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  if (current.type !== 'quiz') return res.status(400).json({ error: 'This step is not a quiz.' });

  // Fresh questions every attempt; tell the model what was already asked.
  var avoid = [];
  try {
    const prior = await pool.query('SELECT questions FROM onboarding_quiz_attempts WHERE user_id = $1 AND step_id = $2 ORDER BY id DESC LIMIT 2', [req.user.id, stepId]);
    prior.rows.forEach(function (row) {
      var qs = row.questions; if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch (e) { qs = []; } }
      (qs || []).forEach(function (q) { if (q && q.prompt) avoid.push(q.prompt); });
    });
  } catch (e) { /* non-fatal */ }

  let questions;
  try { questions = await generateQuestions(current, avoid); }
  catch (e) { return res.status(502).json({ error: e.message }); }

  const ins = await pool.query(
    'INSERT INTO onboarding_quiz_attempts (user_id, step_id, questions) VALUES ($1,$2,$3) RETURNING id',
    [req.user.id, stepId, JSON.stringify(questions)]
  );
  await ensureStarted(req.user.id, stepId);
  // Never send correct_index to the browser.
  res.json({
    attempt_id: ins.rows[0].id,
    pass_score: passScore(current),
    questions: questions.map(function (q, i) { return { n: i, prompt: q.prompt, options: q.options }; })
  });
});

// POST /api/onboarding/quiz-attempts/:id/submit — grade an attempt
router.post('/quiz-attempts/:id/submit', requireAuth, async (req, res) => {
  const attemptId = parseInt(req.params.id, 10) || 0;
  const ar = await pool.query('SELECT * FROM onboarding_quiz_attempts WHERE id = $1 AND user_id = $2', [attemptId, req.user.id]);
  if (!ar.rows.length) return res.status(404).json({ error: 'Attempt not found' });
  const attempt = ar.rows[0];
  if (attempt.submitted_at) return res.status(400).json({ error: 'This attempt was already submitted.' });

  var qs = attempt.questions; if (typeof qs === 'string') { try { qs = JSON.parse(qs); } catch (e) { qs = []; } }
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  if (answers.length !== qs.length) return res.status(400).json({ error: 'Answer every question before submitting.' });

  const sr = await pool.query('SELECT * FROM onboarding_steps WHERE id = $1', [attempt.step_id]);
  const step = sr.rows[0];
  const need = step ? passScore(step) : DEFAULT_PASS_SCORE;

  var correct = 0;
  var results = qs.map(function (q, i) {
    var a = parseInt(answers[i], 10);
    var ok = (a === q.correct_index);
    if (ok) correct++;
    return { n: i, correct: ok, correct_index: q.correct_index };
  });
  const score = Math.round((correct / qs.length) * 100);
  const passed = score >= need;

  await pool.query('UPDATE onboarding_quiz_attempts SET answers = $1, score = $2, passed = $3, submitted_at = NOW() WHERE id = $4',
    [JSON.stringify(answers), score, passed, attemptId]);
  await pool.query(
    'INSERT INTO onboarding_progress (user_id, step_id, status, attempts, score, started_at, completed_at) VALUES ($1,$2,$3,1,$4,NOW(),' + (passed ? 'NOW()' : 'NULL') + ') ' +
    'ON CONFLICT (user_id, step_id) DO UPDATE SET attempts = onboarding_progress.attempts + 1, score = GREATEST(COALESCE(onboarding_progress.score,0), $4)' +
    (passed ? ", status = 'done', completed_at = NOW()" : ''),
    [req.user.id, attempt.step_id, passed ? 'done' : 'pending', score]
  );
  await logAudit({ entity_type: 'onboarding', entity_id: attempt.step_id, action: passed ? 'quiz_passed' : 'quiz_failed', user_id: req.user.id, user_name: req.user.name, details: { step: step ? step.title : null, score: score, need: need } });
  if (passed) await maybeNotifyReady(req.user.id);
  res.json({ score: score, passed: passed, need: need, results: results });
});

// ============================ ADMIN ENDPOINTS =================================

const admin = express.Router();
router.use('/admin', requireAuth, function (req, res, next) {
  // A user who is themselves still onboarding can never touch admin endpoints.
  if (req.user.onboarding) return res.status(403).json({ error: 'Forbidden' });
  next();
}, requirePermission('manage_onboarding'), admin);

// Steps CRUD -------------------------------------------------------------------
admin.get('/steps', async (req, res) => {
  const r = await pool.query(
    'SELECT s.*, d.title AS sop_title FROM onboarding_steps s LEFT JOIN sop_documents d ON d.id = s.sop_id WHERE s.active = true ORDER BY s.position ASC, s.id ASC'
  );
  res.json(r.rows);
});

admin.post('/steps', async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (['video', 'sop_read', 'quiz'].indexOf(type) === -1) return res.status(400).json({ error: 'Invalid step type' });
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if ((type === 'sop_read' || type === 'quiz') && !parseInt(b.sop_id, 10)) return res.status(400).json({ error: 'Pick an SOP for this step' });
  if (type === 'video' && !String(b.video_key || '').trim()) return res.status(400).json({ error: 'Upload the video first' });
  const mx = await pool.query('SELECT COALESCE(MAX(position),0) AS p FROM onboarding_steps WHERE active = true');
  const config = {};
  if (b.pass_score !== undefined) config.pass_score = parseInt(b.pass_score, 10) || DEFAULT_PASS_SCORE;
  if (b.question_count !== undefined) config.question_count = parseInt(b.question_count, 10) || DEFAULT_QUESTION_COUNT;
  if (b.min_seconds !== undefined) config.min_seconds = parseInt(b.min_seconds, 10) || 0;
  const r = await pool.query(
    'INSERT INTO onboarding_steps (position, type, title, description, sop_id, video_key, config) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [mx.rows[0].p + 1, type, title.slice(0, 200), String(b.description || '').trim() || null, parseInt(b.sop_id, 10) || null, String(b.video_key || '').trim() || null, JSON.stringify(config)]
  );
  await logAudit({ entity_type: 'onboarding', entity_id: r.rows[0].id, action: 'step_created', user_id: req.user.id, user_name: req.user.name, details: { title: title, type: type } });
  res.status(201).json(r.rows[0]);
});

admin.put('/steps/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  const b = req.body || {};
  const cur = await pool.query('SELECT * FROM onboarding_steps WHERE id = $1', [id]);
  if (!cur.rows.length) return res.status(404).json({ error: 'Step not found' });
  const s = cur.rows[0];
  const config = cfg(s);
  if (b.pass_score !== undefined) config.pass_score = parseInt(b.pass_score, 10) || DEFAULT_PASS_SCORE;
  if (b.question_count !== undefined) config.question_count = parseInt(b.question_count, 10) || DEFAULT_QUESTION_COUNT;
  if (b.min_seconds !== undefined) config.min_seconds = parseInt(b.min_seconds, 10) || 0;
  const r = await pool.query(
    'UPDATE onboarding_steps SET title = COALESCE($1, title), description = $2, sop_id = COALESCE($3, sop_id), video_key = COALESCE($4, video_key), config = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
    [b.title ? String(b.title).trim().slice(0, 200) : null, (b.description !== undefined ? (String(b.description).trim() || null) : s.description), parseInt(b.sop_id, 10) || null, (b.video_key ? String(b.video_key).trim() : null), JSON.stringify(config), id]
  );
  res.json(r.rows[0]);
});

admin.delete('/steps/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  // Soft-delete so existing progress rows keep their history.
  const r = await pool.query('UPDATE onboarding_steps SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id, title', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Step not found' });
  await logAudit({ entity_type: 'onboarding', entity_id: id, action: 'step_removed', user_id: req.user.id, user_name: req.user.name, details: { title: r.rows[0].title } });
  res.json({ success: true });
});

admin.post('/steps/reorder', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  if (!ids || !ids.length) return res.status(400).json({ error: 'ids array required' });
  for (var i = 0; i < ids.length; i++) {
    await pool.query('UPDATE onboarding_steps SET position = $1, updated_at = NOW() WHERE id = $2', [i + 1, parseInt(ids[i], 10) || 0]);
  }
  res.json({ success: true });
});

// SOP list for the step builder (managers with manage_onboarding may lack the
// admin-only /api/sops route, so expose titles here).
admin.get('/sops', async (req, res) => {
  const r = await pool.query('SELECT id, title FROM sop_documents WHERE active = true ORDER BY title ASC');
  res.json(r.rows);
});

// Video upload (R2 presigned PUT, same flow as quote photos / document vault)
admin.post('/video-upload-url', async (req, res) => {
  if (!r2.configured()) return res.status(503).json({ error: 'Video storage is not configured. Add the R2_* environment variables in Railway.' });
  const name = String((req.body && req.body.name) || 'welcome.mp4').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  const mime = String((req.body && req.body.mime_type) || 'video/mp4').slice(0, 100);
  const key = 'onboarding/videos/' + crypto.randomUUID() + '/' + name;
  const uploadUrl = await r2.presignUpload(key, mime);
  res.json({ key: key, uploadUrl: uploadUrl });
});

// Enrollment + progress dashboard ----------------------------------------------
admin.get('/progress', async (req, res) => {
  const steps = await activeSteps();
  const total = steps.length;
  const ur = await pool.query(
    "SELECT u.id, u.name, u.title, u.role, u.onboarding_enrolled_at, u.supervisor_id, u.onboarding_completion_override, s.name AS supervisor_name " +
    "FROM users u LEFT JOIN users s ON s.id = u.supervisor_id " +
    "WHERE u.active = true AND u.onboarding_status IS NOT NULL AND u.onboarding_status <> 'complete' ORDER BY u.onboarding_enrolled_at ASC NULLS LAST, u.name ASC"
  );
  const out = [];
  for (var i = 0; i < ur.rows.length; i++) {
    const u = ur.rows[i];
    const prog = await progressMap(u.id);
    var done = 0;
    steps.forEach(function (s) { if (prog[s.id] && prog[s.id].status === 'done') done++; });
    const current = findCurrent(steps, prog);
    out.push({
      id: u.id, name: u.name, title: u.title, role: u.role,
      supervisor_id: u.supervisor_id, supervisor_name: u.supervisor_name,
      enrolled_at: u.onboarding_enrolled_at,
      steps_done: done, steps_total: total,
      current_step: current ? current.title : null,
      ready_for_signoff: !current && total > 0,
      can_sign_off: await canSignOff(req.user, u.id),
      completion_override: parseJsonMaybe(u.onboarding_completion_override)
    });
  }
  res.json({ users: out, steps_total: total });
});

admin.post('/enroll', async (req, res) => {
  const target = parseInt(req.body && req.body.user_id, 10) || 0;
  if (!target) return res.status(400).json({ error: 'Pick a user to enroll' });
  const ur = await pool.query('SELECT id, name, onboarding_status FROM users WHERE id = $1 AND active = true', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  if (ur.rows[0].onboarding_status && ur.rows[0].onboarding_status !== 'complete') return res.status(400).json({ error: 'Already in onboarding' });
  if (target === req.user.id) return res.status(400).json({ error: 'You cannot enroll yourself' });
  const tr = await pool.query('SELECT role FROM users WHERE id = $1', [target]);
  if (tr.rows.length && tr.rows[0].role === 'owner') return res.status(400).json({ error: 'Owners cannot be enrolled in onboarding' });
  await pool.query('DELETE FROM onboarding_progress WHERE user_id = $1', [target]);
  await pool.query("UPDATE users SET onboarding_status = 'required', onboarding_enrolled_at = NOW() WHERE id = $1", [target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'enrolled', user_id: req.user.id, user_name: req.user.name, details: { user: ur.rows[0].name } });
  res.json({ success: true });
});

// Supervisor sign-off — the final gate. Requires every step done.
admin.post('/users/:id/signoff', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  const ur = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms, onboarding_status, role, onboarding_completion_override FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];
  if (!u.onboarding_status || u.onboarding_status === 'complete') return res.status(400).json({ error: 'This user is not in onboarding' });
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Only their supervisor (or an admin) can sign off' });

  const steps = await activeSteps();
  const prog = await progressMap(target);
  const force = req.body && req.body.force === true;
  if (findCurrent(steps, prog) && !force) return res.status(400).json({ error: 'They still have steps to finish', incomplete: true });

  await pool.query("UPDATE users SET onboarding_status = 'complete' WHERE id = $1", [target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: force ? 'signed_off_forced' : 'signed_off', user_id: req.user.id, user_name: req.user.name, details: { user: u.name } });

  // Tell the new hire they are in.
  try {
    await push.sendPushToUsers([target], { title: 'Welcome to the team!', body: 'Onboarding complete — Nova is unlocked.', url: '/' });
    if (u.receive_emails !== false && u.email) {
      const html = emailTemplate({
        badge: 'Welcome aboard', badgeColor: 'green',
        title: 'Onboarding complete — Nova is unlocked',
        body: 'Congratulations, ' + u.name + '! <strong>' + req.user.name + '</strong> signed off on your onboarding. The full Nova app is now unlocked for you.',
        details: [{ label: 'Signed off by', value: req.user.name }],
        buttonText: 'Open Nova', buttonUrl: appUrl('/')
      });
      await sendEmail(u.email, 'Welcome aboard — Nova is unlocked', html);
    }
    if (u.receive_sms && u.phone) {
      await sendSms(u.phone, 'Lock & Roll: Onboarding complete — ' + req.user.name + ' signed you off. Nova is unlocked! ' + appUrl('/'));
    }
  } catch (e) { console.error('[onboarding] welcome notify failed:', e.message); }

  // Completion action: notify a chosen person + create a task for them (customizable).
  try { await runCompletionAction(u, req.user); } catch (e) { console.error('[onboarding] completion action failed:', e.message); }

  res.json({ success: true });
});

// Remove someone from onboarding without sign-off ceremony (mistake / rehire etc.)
admin.post('/users/:id/remove', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  const ur = await pool.query('SELECT id, name, onboarding_status FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  if (!ur.rows[0].onboarding_status || ur.rows[0].onboarding_status === 'complete') return res.status(400).json({ error: 'Not in onboarding' });
  await pool.query("UPDATE users SET onboarding_status = 'complete' WHERE id = $1", [target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'removed', user_id: req.user.id, user_name: req.user.name, details: { user: ur.rows[0].name } });
  res.json({ success: true });
});

// Per-user step detail for the dashboard drill-down
admin.get('/users/:id/detail', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(target);
  const attempts = await pool.query(
    'SELECT step_id, COUNT(*)::int AS n, MAX(score) AS best FROM onboarding_quiz_attempts WHERE user_id = $1 AND submitted_at IS NOT NULL GROUP BY step_id',
    [target]
  );
  const aMap = {};
  attempts.rows.forEach(function (a) { aMap[a.step_id] = a; });
  res.json(steps.map(function (s) {
    const p = prog[s.id];
    return {
      id: s.id, type: s.type, title: s.title,
      status: (p && p.status === 'done') ? 'done' : 'pending',
      score: p ? p.score : null,
      attempts: aMap[s.id] ? aMap[s.id].n : 0,
      completed_at: p ? p.completed_at : null
    };
  }));
});

// ---- completion-action config (global default) ------------------------------
admin.get('/completion', async (req, res) => {
  res.json(await getCompletionConfig());
});
admin.put('/completion', async (req, res) => {
  var conf = cleanCompletion(req.body);
  await pool.query(
    "INSERT INTO settings (key, value, updated_at) VALUES ('onboarding_completion', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
    [JSON.stringify(conf)]
  );
  await logAudit({ entity_type: 'onboarding', entity_id: 0, action: 'completion_config_updated', user_id: req.user.id, user_name: req.user.name, details: { enabled: conf.enabled, recipient_id: conf.recipient_id } });
  res.json({ success: true, config: conf });
});

// ---- per-hire override ------------------------------------------------------
// Body: { override: { ...partial fields } } or { override: null } to clear.
admin.put('/users/:id/completion-override', async (req, res) => {
  var target = parseInt(req.params.id, 10) || 0;
  var ur = await pool.query('SELECT id FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  var raw = req.body && req.body.override;
  var clean = null;
  if (raw && typeof raw === 'object') {
    clean = {};
    if (raw.enabled != null) clean.enabled = raw.enabled === true;
    if (raw.notify != null) clean.notify = raw.notify === true;
    if (raw.create_task != null) clean.create_task = raw.create_task === true;
    var rid = parseInt(raw.recipient_id, 10); if (rid) clean.recipient_id = rid;
    if (raw.task_title != null && String(raw.task_title).trim() !== '') clean.task_title = String(raw.task_title).slice(0, 300);
    if (raw.task_description != null && String(raw.task_description).trim() !== '') clean.task_description = String(raw.task_description).slice(0, 4000);
    if (['low', 'medium', 'high'].indexOf(raw.task_priority) >= 0) clean.task_priority = raw.task_priority;
    if (raw.task_due_days != null && raw.task_due_days !== '') { var dd = parseInt(raw.task_due_days, 10); if (dd >= 0 && dd <= 60) clean.task_due_days = dd; }
    if (!Object.keys(clean).length) clean = null;
  }
  await pool.query('UPDATE users SET onboarding_completion_override = $1 WHERE id = $2', [clean ? JSON.stringify(clean) : null, target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: clean ? 'completion_override_set' : 'completion_override_cleared', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true, override: clean });
});

module.exports = router;
