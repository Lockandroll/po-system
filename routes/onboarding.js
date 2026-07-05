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
const hrCrypto = require('../utils/hrCrypto');

const router = express.Router();

const DEFAULT_PASS_SCORE = 80;
const DEFAULT_QUESTION_COUNT = 5;
const DEFAULT_MIN_SECONDS = 30;

// Required-document upload slots (Phase 1). Slot 4 is satisfied by EITHER an SSN
// card or a birth certificate. An admin may override via step config.slots.
const DEFAULT_UPLOAD_SLOTS = [
  { key: 'license', label: "Driver's License", category: 'license', expires: true },
  { key: 'registration', label: 'Vehicle Registration', category: 'registration', expires: true },
  { key: 'insurance', label: 'Proof of Auto Liability Insurance', category: 'insurance', expires: true },
  { key: 'identity', label: 'Social Security Card or Birth Certificate', category: 'identity', expires: false }
];
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const UPLOAD_OK_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
// New Hire Packet fields (native form). DEFAULT set — override per step via
// config.fields. Swap these for the exact packet PDF fields when available.
const DEFAULT_PACKET_FIELDS = [
  { key: 'sec_employee', type: 'section', label: 'Employee Information' },
  { key: 'legal_first', label: 'Legal first name', type: 'text', required: true },
  { key: 'middle', label: 'Middle name', type: 'text' },
  { key: 'legal_last', label: 'Legal last name', type: 'text', required: true },
  { key: 'preferred_name', label: 'Preferred name (optional)', type: 'text' },
  { key: 'personal_email', label: 'Personal email', type: 'email' },
  { key: 'address', label: 'Home mailing address', type: 'text', required: true },
  { key: 'city', label: 'City', type: 'text', required: true },
  { key: 'state', label: 'State', type: 'text', required: true },
  { key: 'zip', label: 'ZIP code', type: 'text', required: true },
  { key: 'mobile_phone', label: 'Mobile phone', type: 'tel', required: true },
  { key: 'position_role', label: 'Position / role', type: 'text', who: 'manager' },
  { key: 'employment_type', label: 'Employment type', type: 'select', options: ['Full-time', 'Part-time'], who: 'manager' },
  { key: 'start_date', label: 'Anticipated start date', type: 'date', who: 'manager' },
  { key: 'work_location', label: 'Work location / market', type: 'text', who: 'manager' },
  { key: 'job_title', label: 'Job title', type: 'text', who: 'manager' },
  { key: 'sec_ec', type: 'section', label: 'Emergency Contacts' },
  { key: 'ec1_name', label: 'Primary contact — full name', type: 'text', required: true },
  { key: 'ec1_rel', label: 'Primary contact — relationship', type: 'text' },
  { key: 'ec1_phone', label: 'Primary contact — phone', type: 'tel', required: true },
  { key: 'ec1_alt', label: 'Primary contact — alternate phone', type: 'tel' },
  { key: 'ec2_name', label: 'Secondary contact — full name', type: 'text' },
  { key: 'ec2_rel', label: 'Secondary contact — relationship', type: 'text' },
  { key: 'ec2_phone', label: 'Secondary contact — phone', type: 'tel' },
  { key: 'ec2_alt', label: 'Secondary contact — alternate phone', type: 'tel' },
  { key: 'sec_driving', type: 'section', label: 'Driving & Vehicle', note: 'Complete only if your position requires driving for Lock and Roll. If you do not drive for work, leave this blank.' },
  { key: 'dl_state', label: "Driver's license — state", type: 'text' },
  { key: 'dl_number', label: "Driver's license — number", type: 'text' },
  { key: 'dl_exp', label: "Driver's license — expiration date", type: 'date' },
  { key: 'veh_year', label: 'Vehicle year', type: 'text' },
  { key: 'veh_make', label: 'Vehicle make', type: 'text' },
  { key: 'veh_model', label: 'Vehicle model', type: 'text' },
  { key: 'veh_color', label: 'Vehicle color', type: 'text' },
  { key: 'plate', label: 'License plate', type: 'text' },
  { key: 'plate_state', label: 'Plate state', type: 'text' },
  { key: 'sec_ack', type: 'section', label: 'Acknowledgment & Signature', note: 'Your submission is your electronic signature, with the same legal force as a handwritten one. Direct deposit is set up separately in Paychex.' },
  { key: 'ack', type: 'ack', required: true, label: 'By submitting, I acknowledge that: I have received and reviewed the Lock and Roll Employee Handbook and agree to follow its policies (including at-will employment, drug and alcohol, and confidentiality); the information in this packet is true, accurate, and complete to the best of my knowledge; where it applies to my position I acknowledge the Lock and Roll Motor Vehicle Policy and will keep a valid license, current registration, and auto liability insurance; and I agree to sign this packet electronically.' }
];
function packetFields(step) {
  var c = cfg(step);
  return (Array.isArray(c.fields) && c.fields.length) ? c.fields : DEFAULT_PACKET_FIELDS;
}

function uploadSlots(step) {
  var c = cfg(step);
  if (Array.isArray(c.slots) && c.slots.length) return c.slots;
  return DEFAULT_UPLOAD_SLOTS;
}
// Latest non-superseded file per slot for a hire's onboarding uploads.
async function slotStatus(userId) {
  const r = await pool.query(
    'SELECT DISTINCT ON (slot_key) id, slot_key, name, mime_type, expires_at, review_status, reject_reason, verify_status, extracted ' +
    "FROM hr_documents WHERE user_id = $1 AND source = 'onboarding' AND slot_key IS NOT NULL AND review_status <> 'superseded' " +
    'ORDER BY slot_key, id DESC',
    [userId]
  );
  var by = {};
  r.rows.forEach(function (row) { by[row.slot_key] = row; });
  return by;
}

function appUrl(path) { return (process.env.APP_URL || '').replace(/\/$/, '') + (path || ''); }

function cfg(step) {
  var c = step && step.config;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
  return c || {};
}
function passScore(step) { var v = parseInt(cfg(step).pass_score, 10); return (v >= 1 && v <= 100) ? v : DEFAULT_PASS_SCORE; }
function questionCount(step) { var v = parseInt(cfg(step).question_count, 10); return (v >= 1 && v <= 10) ? v : DEFAULT_QUESTION_COUNT; }
function minSeconds(step) { var v = parseInt(cfg(step).min_seconds, 10); return (v >= 0 && v <= 7200) ? v : DEFAULT_MIN_SECONDS; }

// ---- completion action (create one or more tasks + notify on finish) --------
// Global default lives in settings key 'onboarding_completion'.
//   { enabled, tasks: [ { recipient, title, description, priority, due_days, notify } ] }
// recipient is a numeric user-id string, or a dynamic token:
//   'supervisor' = the new hire's supervisor, 'signer' = whoever signs off.
// A per-hire override on users.onboarding_completion_override (JSONB) replaces
// the task list for that hire when it supplies its own tasks[].
var DEFAULT_TASK = {
  recipient: 'supervisor',
  title: 'Onboarding wrap-up for {{name}}',
  description: '{{name}} ({{role}}) finished onboarding on {{date}}, signed off by {{signer}}. Handle any remaining first-week items: equipment, accounts, keys, and schedule.',
  priority: 'medium',
  due_days: 3,
  notify: true
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
function normalizeRecipient(r) {
  if (r === 'supervisor' || r === 'signer') return r;
  var n = parseInt(r, 10);
  return n ? String(n) : null;
}
function cleanTask(t) {
  if (!t) return null;
  var rec = normalizeRecipient(t.recipient != null ? t.recipient : t.recipient_id);
  if (!rec) return null;
  var days = parseInt(t.due_days != null ? t.due_days : t.task_due_days, 10);
  return {
    recipient: rec,
    title: String(t.title != null ? t.title : (t.task_title || '')).slice(0, 300),
    description: String(t.description != null ? t.description : (t.task_description || '')).slice(0, 4000),
    priority: (['low', 'medium', 'high'].indexOf(t.priority != null ? t.priority : t.task_priority) >= 0) ? (t.priority != null ? t.priority : t.task_priority) : 'medium',
    due_days: (days >= 0 && days <= 60) ? days : 3,
    notify: (t.notify !== false)
  };
}
// Normalize a stored/POSTed config into { enabled, tasks: [...] }, migrating the
// old single-task shape (recipient_id, task_title, ...) into a one-element list.
function normalizeConfig(v) {
  var out = { enabled: false, tasks: [] };
  if (!v) return out;
  out.enabled = v.enabled === true;
  if (Array.isArray(v.tasks)) {
    out.tasks = v.tasks.map(cleanTask).filter(Boolean);
  } else if (v.recipient_id != null || v.task_title != null || v.task_description != null) {
    var t = cleanTask({
      recipient: v.recipient_id != null ? String(v.recipient_id) : null,
      title: v.task_title, description: v.task_description,
      priority: v.task_priority, due_days: v.task_due_days, notify: v.notify
    });
    if (t) out.tasks = [t];
  }
  return out;
}
async function getCompletionConfig() {
  try {
    var r = await pool.query("SELECT value FROM settings WHERE key = 'onboarding_completion'");
    var v = r.rows.length ? parseJsonMaybe(r.rows[0].value) : null;
    return normalizeConfig(v);
  } catch (e) { console.error('[onboarding] completion config read failed:', e.message); return { enabled: false, tasks: [] }; }
}
// Merge a per-hire override on top of the normalized base config. An override may
// flip 'enabled' and/or supply its own tasks[] (which replaces the default list).
function applyOverride(base, override) {
  var ov = parseJsonMaybe(override);
  var out = { enabled: base.enabled, tasks: base.tasks };
  if (!ov) return out;
  if (typeof ov.enabled === 'boolean') out.enabled = ov.enabled;
  if (Array.isArray(ov.tasks)) {
    out.tasks = ov.tasks.map(cleanTask).filter(Boolean);
  } else if (ov.recipient_id != null || ov.task_title != null || ov.task_description != null || ov.task_priority != null || ov.task_due_days != null) {
    var d = base.tasks[0] || DEFAULT_TASK;
    var t = cleanTask({
      recipient: ov.recipient_id != null ? String(ov.recipient_id) : d.recipient,
      title: (ov.task_title != null && String(ov.task_title).trim() !== '') ? ov.task_title : d.title,
      description: (ov.task_description != null && String(ov.task_description).trim() !== '') ? ov.task_description : d.description,
      priority: ov.task_priority != null ? ov.task_priority : d.priority,
      due_days: ov.task_due_days != null && ov.task_due_days !== '' ? ov.task_due_days : d.due_days,
      notify: ov.notify
    });
    if (t) out.tasks = [t];
  }
  return out;
}
function cleanCompletion(b) {
  b = b || {};
  var tasks = Array.isArray(b.tasks) ? b.tasks.map(cleanTask).filter(Boolean) : [];
  return { enabled: b.enabled === true, tasks: tasks };
}
// Resolve a task recipient (id string or dynamic token) to a concrete user id.
async function resolveRecipientId(rec, newHire, signer) {
  if (rec === 'signer') return (signer && signer.id) ? parseInt(signer.id, 10) : null;
  if (rec === 'supervisor') {
    var sid = newHire ? newHire.supervisor_id : null;
    if (sid == null && newHire && newHire.id) {
      try { var r = await pool.query('SELECT supervisor_id FROM users WHERE id = $1', [newHire.id]); if (r.rows.length) sid = r.rows[0].supervisor_id; } catch (e) {}
    }
    return sid ? parseInt(sid, 10) : null;
  }
  var n = parseInt(rec, 10);
  return n || null;
}
// newHire: { id, name, role, supervisor_id, onboarding_completion_override }; signer: req.user
async function runCompletionAction(newHire, signer) {
  var conf = applyOverride(await getCompletionConfig(), newHire.onboarding_completion_override);
  if (!conf.enabled) return;
  var tasks = Array.isArray(conf.tasks) ? conf.tasks : [];
  for (var i = 0; i < tasks.length; i++) {
    try { await runOneCompletionTask(tasks[i], newHire, signer); }
    catch (e) { console.error('[onboarding] completion task ' + i + ' failed:', e.message); }
  }
}
async function runOneCompletionTask(t, newHire, signer) {
  var recipientId = await resolveRecipientId(t.recipient, newHire, signer);
  if (!recipientId) return;
  var rr = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1 AND active = true', [recipientId]);
  if (!rr.rows.length) return;
  var rec = rr.rows[0];
  var vars = {
    name: newHire.name, role: roleLabelSafe(newHire.role),
    date: new Date().toLocaleDateString('en-US'), signer: signer.name, recipient: rec.name
  };
  var title = fillTemplate(t.title, vars).trim() || ('Onboarding wrap-up for ' + newHire.name);
  var desc = fillTemplate(t.description, vars);

  try {
    var due = null; var days = parseInt(t.due_days, 10);
    if (days >= 0) { var d = new Date(); d.setDate(d.getDate() + days); due = d.toISOString().slice(0, 10); }
    var pr = (['low', 'medium', 'high'].indexOf(t.priority) >= 0) ? t.priority : 'medium';
    var tr = await pool.query(
      "INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, due_date, source) VALUES ($1,$2,'todo',$3,$4,$5,$6,'onboarding') RETURNING id",
      [title, desc, pr, recipientId, signer.id, due]
    );
    var taskId = tr.rows[0].id;
    try { await pool.query("INSERT INTO task_activity (task_id, user_id, user_name, type, body) VALUES ($1,$2,$3,'event',$4)", [taskId, signer.id, signer.name, 'created this task — ' + newHire.name + ' finished onboarding']); } catch (e) {}
  } catch (e) { console.error('[onboarding] completion task insert failed:', e.message); }

  if (t.notify !== false) {
    try {
      await push.sendPushToUsers([recipientId], { title: 'Onboarding complete', body: newHire.name + ' finished onboarding.', url: appUrl('/?view=tasks') });
      if (rec.receive_emails !== false && rec.email) {
        var html = emailTemplate({
          badge: 'Onboarding complete', badgeColor: 'green',
          title: newHire.name + ' finished onboarding',
          body: '<strong>' + newHire.name + '</strong> (' + vars.role + ') completed onboarding and was signed off by <strong>' + signer.name + '</strong>. A task has been created and assigned to you.',
          details: [{ label: 'New hire', value: newHire.name }, { label: 'Role', value: vars.role }, { label: 'Task', value: title }, { label: 'Signed off by', value: signer.name }],
          buttonText: 'Open tasks', buttonUrl: appUrl('/?view=tasks')
        });
        await sendEmail(rec.email, newHire.name + ' finished onboarding', html);
      }
      if (rec.receive_sms && rec.phone) {
        await sendSms(rec.phone, 'Lock & Roll: ' + newHire.name + ' finished onboarding — a task was assigned to you.');
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

// ---- AI document verification (reads uploaded IDs / insurance / registration) ----
// Vision call mirrors routes/vr.js. Resolves the raw Anthropic reply object.
function callClaudeVision(bytes, mime, prompt) {
  return new Promise(function (resolve, reject) {
    var isPdf = String(mime || '').toLowerCase() === 'application/pdf';
    var blk = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }
      : { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: bytes.toString('base64') } };
    var body = JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 700, messages: [{ role: 'user', content: [blk, { type: 'text', text: prompt }] }] });
    var headers = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(body) };
    if (isPdf) headers['anthropic-beta'] = 'pdfs-2024-09-25';
    var rq = https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: headers }, function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    rq.setTimeout(30000, function () { rq.destroy(new Error('AI vision timed out.')); });
    rq.write(body); rq.end();
  });
}
function extractPrompt(category) {
  var common = " Read the document. Return ONLY valid JSON, no markdown, no prose. Use null for anything not clearly shown.";
  if (category === 'license') return "This is a driver's license." + common + ' Shape: {"name":"full name","first":"first name","middle":"middle name or initial","last":"last name","address":"street address line","city":"","state":"2-letter state","zip":"","dl_state":"issuing state 2-letter","dl_number":"license number","expiration":"YYYY-MM-DD"}';
  if (category === 'insurance') return "This is a proof of auto liability insurance." + common + ' Shape: {"names":["every insured / listed-driver name shown"],"vin":"full VIN","expiration":"policy end date YYYY-MM-DD"}';
  if (category === 'registration') return "This is a vehicle registration." + common + ' Shape: {"name":"registered owner","vin":"full VIN","expiration":"registration expiration YYYY-MM-DD","veh_year":"","veh_make":"","veh_model":"","veh_color":"","plate":"license plate number","plate_state":"2-letter state"}';
  return "This is a Social Security card or birth certificate." + common + ' Shape: {"name":"full name shown"}';
}
async function extractDocFields(category, bytes, mime) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  var reply = await callClaudeVision(bytes, mime, extractPrompt(category));
  if (reply && reply.error) throw new Error((reply.error && reply.error.message) || 'AI error');
  var text = (reply && reply.content && reply.content[0] && reply.content[0].text) || '';
  return extractJson(text);
}
function normNameLoose(s) { return String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function nameMatches(a, bList) {
  var an = normNameLoose(a); if (!an) return false;
  var parts = an.split(' ').filter(function (w) { return w.length > 1; });
  return (bList || []).some(function (b) {
    var bn = normNameLoose(b); if (!bn) return false;
    if (bn.indexOf(an) !== -1 || an.indexOf(bn) !== -1) return true;
    if (parts.length >= 2) return bn.indexOf(parts[0]) !== -1 && bn.indexOf(parts[parts.length - 1]) !== -1;
    return false;
  });
}
function vinNorm(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function expiredOn(dateStr) {
  if (!dateStr) return null;
  var d = new Date(String(dateStr) + 'T00:00:00'); if (isNaN(d.getTime())) return null;
  return d.getTime() < Date.now();
}
// Cross-check the current uploaded set. Assistive only; never blocks the tech.
async function verifySet(userId) {
  var r = await pool.query(
    "SELECT DISTINCT ON (slot_key) slot_key, extracted FROM hr_documents " +
    "WHERE user_id = $1 AND source = 'onboarding' AND slot_key IS NOT NULL AND review_status <> 'superseded' " +
    "ORDER BY slot_key, id DESC", [userId]);
  var ex = {};
  r.rows.forEach(function (row) { var e = row.extracted; if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { e = null; } } ex[row.slot_key] = e || {}; });
  var lic = ex.license || {}, ins = ex.insurance || {}, reg = ex.registration || {};
  var insNames = ins.names || (ins.name ? [ins.name] : []);
  var ok = [], warn = [];
  if (lic.name && insNames.length) {
    if (nameMatches(lic.name, insNames)) ok.push('Name matches — license and insurance both list ' + lic.name + '.');
    else warn.push('Insurance does not clearly list ' + lic.name + ' — please check.');
  }
  if (ins.vin && reg.vin) {
    if (vinNorm(ins.vin) === vinNorm(reg.vin)) ok.push('VIN matches — insurance and registration are the same vehicle.');
    else warn.push('VIN on insurance and registration do not match.');
  }
  [['Driver license', lic.expiration], ['Insurance', ins.expiration], ['Registration', reg.expiration]].forEach(function (t) {
    var e = expiredOn(t[1]);
    if (e === true) warn.push(t[0] + ' appears expired (' + t[1] + ').');
    else if (e === false) ok.push(t[0] + ' is current (through ' + t[1] + ').');
  });
  return { ok: ok, warn: warn };
}

// Build a packet pre-fill from what AI read off the license + registration.
async function packetPrefill(userId) {
  const r = await pool.query(
    "SELECT DISTINCT ON (slot_key) slot_key, extracted FROM hr_documents " +
    "WHERE user_id = $1 AND source = 'onboarding' AND slot_key IS NOT NULL AND review_status <> 'superseded' " +
    "ORDER BY slot_key, id DESC", [userId]);
  var ex = {};
  r.rows.forEach(function (row) { var e = row.extracted; if (typeof e === 'string') { try { e = JSON.parse(e); } catch (x) { e = null; } } ex[row.slot_key] = e || {}; });
  var lic = ex.license || {}, reg = ex.registration || {};
  var out = {};
  function put(k, v) { if (v != null && String(v).trim() !== '' && String(v).toLowerCase() !== 'null') out[k] = v; }
  var f = lic.first, m = lic.middle, l = lic.last;
  if ((!f || !l) && lic.name) { var parts = String(lic.name).trim().split(/\s+/); if (!f) f = parts[0]; if (!l && parts.length > 1) l = parts[parts.length - 1]; if (!m && parts.length > 2) m = parts.slice(1, -1).join(' '); }
  put('legal_first', f); put('middle', m); put('legal_last', l);
  put('address', lic.address); put('city', lic.city); put('state', lic.state); put('zip', lic.zip);
  put('dl_state', lic.dl_state || lic.state); put('dl_number', lic.dl_number); put('dl_exp', lic.expiration);
  put('veh_year', reg.veh_year); put('veh_make', reg.veh_make); put('veh_model', reg.veh_model); put('veh_color', reg.veh_color);
  put('plate', reg.plate); put('plate_state', reg.plate_state);
  return out;
}

// ---- Phase model helpers (v3) -----------------------------------------------
function phaseOf(step) { return (parseInt(step.phase, 10) === 2) ? 2 : 1; }
async function getUserPhase(userId) {
  const r = await pool.query('SELECT onboarding_phase FROM users WHERE id = $1', [userId]);
  return (r.rows.length && parseInt(r.rows[0].onboarding_phase, 10) === 2) ? 2 : 1;
}
// Record an event only if one of this type does not already exist for the user.
// Returns true if it was newly inserted (used to fire a notification exactly once).
async function recordEventOnce(userId, type) {
  const e = await pool.query('SELECT 1 FROM onboarding_events WHERE user_id = $1 AND event_type = $2 LIMIT 1', [userId, type]);
  if (e.rows.length) return false;
  await pool.query('INSERT INTO onboarding_events (user_id, event_type) VALUES ($1,$2)', [userId, type]);
  return true;
}
// Tell the direct supervisor a hire has submitted Phase 1 for review.
async function notifyPhase1Ready(hire) {
  try {
    if (!hire.supervisor_id) return;
    const sr = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms FROM users WHERE id = $1', [hire.supervisor_id]);
    if (!sr.rows.length) return;
    const s = sr.rows[0];
    await push.sendPushToUsers([s.id], { title: 'Phase 1 ready for review', body: hire.name + ' submitted their paperwork.', url: appUrl('/?view=onboarding-admin') });
    if (s.receive_emails !== false && s.email) {
      const html = emailTemplate({
        badge: 'Phase 1 review', badgeColor: 'orange',
        title: hire.name + ' submitted Phase 1',
        body: '<strong>' + hire.name + '</strong> finished their Phase 1 paperwork and uploads. Review and approve — or send it back — in Nova.',
        details: [{ label: 'New hire', value: hire.name }],
        buttonText: 'Review now', buttonUrl: appUrl('/?view=onboarding-admin')
      });
      await sendEmail(s.email, hire.name + ' submitted Phase 1 for review', html);
    }
    if (s.receive_sms && s.phone) await sendSms(s.phone, 'Lock & Roll: ' + hire.name + ' submitted Phase 1 onboarding for your review.');
  } catch (e) { console.error('[onboarding] phase1 ready notify failed:', e.message); }
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
    const _ct = best.mime_type || (String(best.name || '').toLowerCase().slice(-4) === '.pdf' ? 'application/pdf' : null);
    const url = await r2.presignDownload(best.r2_key, best.name, true, 3600, _ct);
    return { url: url, name: best.name, mime_type: best.mime_type };
  } catch (e) { return null; }
}
// Presign one specific vault document (the file the admin picked for a read step).
async function vaultDocById(documentId) {
  if (!r2.configured() || !documentId) return null;
  const dr = await pool.query("SELECT id, name, r2_key, mime_type FROM documents WHERE id = $1 AND status = 'ready'", [documentId]);
  if (!dr.rows.length) return null;
  const d = dr.rows[0];
  try {
    const _ct = d.mime_type || (String(d.name || '').toLowerCase().slice(-4) === '.pdf' ? 'application/pdf' : null);
    const url = await r2.presignDownload(d.r2_key, d.name, true, 3600, _ct);
    return { url: url, name: d.name, mime_type: d.mime_type };
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

// Distinct SOPs that have a quiz step in the track — the ONLY source for the
// final exam (acknowledge-only docs have no quiz, so they are excluded).
async function examSopIds() {
  const r = await pool.query("SELECT DISTINCT sop_id FROM onboarding_steps WHERE active = true AND type = 'quiz' AND sop_id IS NOT NULL");
  return r.rows.map(function (x) { return x.sop_id; }).filter(Boolean);
}
function examCount(step) { var v = parseInt(cfg(step).question_count, 10); return (v >= 5 && v <= 50) ? v : 20; }
async function generateExamQuestions(step, avoidPrompts) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI is not configured (ANTHROPIC_API_KEY missing).');
  var n = examCount(step);
  var ids = await examSopIds();
  if (!ids.length) throw new Error('There are no quizzed documents to build the final exam from.');
  var parts = [];
  for (var i = 0; i < ids.length; i++) {
    var sop = await sopFullText(ids[i]);
    if (sop && sop.text && sop.text.length > 40) parts.push('=== ' + sop.title + ' ===\n' + sop.text.slice(0, 7000));
  }
  if (!parts.length) throw new Error('No readable material found for the final exam.');
  var corpus = parts.join('\n\n').slice(0, 60000);
  var system = [
    'You are writing the FINAL cumulative exam for a new hire at a locksmith / roadside company.',
    'You will be given the text of SEVERAL Standard Operating Procedures the hire has studied.',
    'Write exactly ' + n + ' multiple-choice questions that test understanding ACROSS all of the supplied SOPs, spread reasonably across the different documents.',
    'Rules:',
    '- Every question and option must be grounded ONLY in the supplied text. Do not invent facts.',
    '- Each question must have exactly 4 options with exactly one clearly correct answer.',
    '- Make wrong options plausible but clearly incorrect to someone who studied the material.',
    '- Keep each question and option to one sentence.',
    (avoidPrompts && avoidPrompts.length ? '- Do NOT reuse or lightly rephrase these earlier questions: ' + avoidPrompts.join(' | ') : ''),
    'Respond with ONLY a JSON object, no prose, exactly:',
    '{"questions":[{"prompt":"...","options":["...","...","...","..."],"correct_index":0}]}'
  ].join('\n');
  var out = null;
  for (var attempt = 0; attempt < 2 && !out; attempt++) {
    var reply = await callClaude(system, 'STUDY MATERIAL:\n' + corpus);
    if (reply && reply.error) throw new Error('AI error: ' + (reply.error.message || 'unknown'));
    var text = (reply && reply.content && reply.content[0] && reply.content[0].text) || '';
    var parsed = extractJson(text);
    if (validQuestions(parsed, n)) out = parsed;
  }
  if (!out) throw new Error('The AI did not return a valid exam. Try again.');
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
  const ur = await pool.query('SELECT id, name, onboarding_status, onboarding_enrolled_at, supervisor_id, onboarding_phase FROM users WHERE id = $1', [req.user.id]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const me = ur.rows[0];
  const status = me.onboarding_status || 'complete';
  if (status === 'complete') return res.json({ onboarding_status: 'complete' });

  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  let current = findCurrent(steps, prog);
  const phase = (parseInt(me.onboarding_phase, 10) === 2) ? 2 : 1;
  var awaitingReview = false;
  if (current && phaseOf(current) > phase) {
    awaitingReview = true; current = null;
    if (await recordEventOnce(req.user.id, 'phase1_submitted')) { try { await notifyPhase1Ready(me); } catch (e) {} }
  }

  var supName = null;
  if (me.supervisor_id) {
    const sr = await pool.query('SELECT name FROM users WHERE id = $1', [me.supervisor_id]);
    if (sr.rows.length) supName = sr.rows[0].name;
  }

  const list = steps.map(function (s) {
    const p = prog[s.id];
    return {
      id: s.id, type: s.type, title: s.title, description: s.description, phase: phaseOf(s),
      status: (p && p.status === 'done') ? 'done' : (current && current.id === s.id ? 'current' : 'locked'),
      score: p ? p.score : null, attempts: p ? p.attempts : 0
    };
  });

  var payload = { onboarding_status: status, name: me.name, supervisor_name: supName, steps: list, all_steps_done: (!current && !awaitingReview), awaiting_review: awaitingReview, phase: phase, current: null };

  if (current) {
    await ensureStarted(req.user.id, current.id);
    var cur = { id: current.id, type: current.type, title: current.title, description: current.description, min_seconds: minSeconds(current) };
    if (current.type === 'video' && current.video_key && r2.configured()) {
      try { cur.video_url = await r2.presignDownload(current.video_key, 'welcome.mp4', true, 3600); } catch (e) { cur.video_error = 'Video is unavailable right now.'; }
    }
    if (current.type === 'sop_read' || current.type === 'acknowledge') {
      const docId = parseInt(cfg(current).document_id, 10) || 0;
      if (current.sop_id) {
        const sop = await sopFullText(current.sop_id);
        if (sop) { cur.sop_title = sop.title; cur.sop_content = sop.text; }
      }
      try {
        const vdoc = docId ? await vaultDocById(docId) : (current.sop_id ? await sopVaultDoc(current.sop_id) : null);
        if (vdoc) {
          cur.sop_doc_url = vdoc.url; cur.sop_doc_mime = vdoc.mime_type; cur.sop_doc_name = vdoc.name;
          if (!cur.sop_title) cur.sop_title = vdoc.name;
        }
      } catch (e) {}
    }
    if (current.type === 'quiz') {
      cur.pass_score = passScore(current);
      cur.question_count = questionCount(current);
      const p = prog[current.id];
      cur.attempts = p ? p.attempts : 0;
      cur.must_reread = (await quizBatchFails(req.user.id, current.id)) >= 2;
      if (cur.must_reread) { var _rd = await stepReading(current); cur.sop_content = _rd.sop_content; cur.sop_doc_url = _rd.sop_doc_url; cur.sop_doc_mime = _rd.sop_doc_mime; cur.sop_doc_name = _rd.sop_doc_name; }
    }
    if (current.type === 'final_exam') {
      cur.pass_score = passScore(current);
      cur.question_count = examCount(current);
      const p = prog[current.id];
      cur.attempts = p ? p.attempts : 0;
      cur.is_final_exam = true;
    }
    if (current.type === 'form') {
      cur.fields = packetFields(current).filter(function (f) { return f.who !== 'manager'; });
      const _pr = await pool.query('SELECT data, field_flags, status FROM onboarding_packet_responses WHERE user_id = $1', [req.user.id]);
      var _existing = (_pr.rows.length && _pr.rows[0].data) ? _pr.rows[0].data : {};
      var _pre = await packetPrefill(req.user.id);
      var _merged = {}, _k; for (_k in _pre) _merged[_k] = _pre[_k]; for (_k in _existing) _merged[_k] = _existing[_k];
      var _newlyFilled = 0; for (_k in _pre) { if (_existing[_k] == null) _newlyFilled++; }
      cur.packet = { data: _merged, field_flags: (_pr.rows.length ? _pr.rows[0].field_flags : null), status: (_pr.rows.length ? _pr.rows[0].status : 'draft') };
      cur.prefilled = _newlyFilled > 0 && (!_pr.rows.length || _pr.rows[0].status !== 'submitted');
    }
    if (current.type === 'document_upload') {
      cur.slots = uploadSlots(current);
      cur.uploaded = await slotStatus(req.user.id);
      try { cur.verify = await verifySet(req.user.id); } catch (e) {}
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
  if (phaseOf(current) > (await getUserPhase(req.user.id))) return res.status(400).json({ error: 'Your paperwork is with your manager for review.' });
  if (current.type === 'quiz') return res.status(400).json({ error: 'Quizzes are completed by passing them.' });
  if (current.type === 'document_upload') {
    const _slots = uploadSlots(current);
    const _have = await slotStatus(req.user.id);
    const _missing = _slots.filter(function (s) { return !_have[s.key]; });
    if (_missing.length) return res.status(400).json({ error: 'Upload all required documents before continuing.', missing: _missing.map(function (s) { return s.key; }) });
  }

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
  if (current.type === 'acknowledge') {
    await pool.query('INSERT INTO onboarding_events (user_id, event_type, step_id, document_id, actor_id, actor_name) VALUES ($1,$2,$3,$4,$1,$5)', [req.user.id, 'acknowledged', stepId, parseInt(cfg(current).document_id, 10) || null, req.user.name]);
  }
  await maybeNotifyReady(req.user.id);
  res.json({ success: true });
});

// POST /api/onboarding/steps/:id/upload — trainee uploads one required document.
// Base64 in JSON; encrypted server-side (Tier-2) into R2 under hr/. Presence and
// file type/size are the only gate here; a manager judges correctness in review.
router.post('/steps/:id/upload', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  if (current.type !== 'document_upload') return res.status(400).json({ error: 'This step does not take uploads.' });
  if (!hrCrypto.storageReady()) return res.status(503).json({ error: 'Secure document storage is not set up yet. Tell your manager.' });

  const b = req.body || {};
  const slot = uploadSlots(current).filter(function (s) { return s.key === String(b.slot_key || '').trim(); })[0];
  if (!slot) return res.status(400).json({ error: 'Unknown upload slot.' });

  const mime = String(b.mime_type || '').toLowerCase().split(';')[0].trim();
  if (UPLOAD_OK_MIME.indexOf(mime) === -1) return res.status(400).json({ error: 'Upload a photo (JPG/PNG/HEIC) or a PDF.' });

  var raw = String(b.data || '');
  var comma = raw.indexOf(',');
  if (raw.slice(0, 64).indexOf('base64') !== -1 && comma !== -1) raw = raw.slice(comma + 1);
  var bytes = null;
  try { bytes = Buffer.from(raw, 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return res.status(400).json({ error: 'That file did not come through — try again.' });
  if (bytes.length > UPLOAD_MAX_BYTES) return res.status(400).json({ error: 'That file is too large (max 15 MB).' });

  const name = String(b.filename || (slot.key + (mime === 'application/pdf' ? '.pdf' : '.jpg'))).slice(0, 200);
  const key = hrCrypto.hrKey(req.user.id, name);
  try { await hrCrypto.putEncrypted(key, bytes); }
  catch (e) { return res.status(502).json({ error: 'Could not store the file securely. Try again.' }); }

  await pool.query(
    "UPDATE hr_documents SET review_status = 'superseded', updated_at = NOW() " +
    "WHERE user_id = $1 AND source = 'onboarding' AND slot_key = $2 AND review_status <> 'superseded'",
    [req.user.id, slot.key]
  );
  const ins = await pool.query(
    'INSERT INTO hr_documents (user_id, category, slot_key, r2_key, name, mime_type, size_bytes, source, uploaded_by, uploaded_by_name) ' +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,'onboarding',$1,$8) RETURNING id",
    [req.user.id, slot.category, slot.key, key, name, mime, bytes.length, req.user.name]
  );
  await pool.query(
    'INSERT INTO onboarding_events (user_id, event_type, step_id, detail, actor_id, actor_name) VALUES ($1,$2,$3,$4,$1,$5)',
    [req.user.id, 'doc_uploaded', stepId, JSON.stringify({ slot: slot.key, name: name, size: bytes.length }), req.user.name]
  );
  await logAudit({ entity_type: 'hr_document', entity_id: ins.rows[0].id, action: 'uploaded', user_id: req.user.id, user_name: req.user.name, details: { slot: slot.key } });
  res.json({ success: true, slot: slot.key });
  // AI reads the document in the background (assistive; a failure just leaves it
  // for manual review). Uses the plaintext bytes still in memory.
  extractDocFields(slot.category, bytes, mime).then(function (fields) {
    if (!fields) return;
    var expiry = (fields.expiration && /^\d{4}-\d{2}-\d{2}$/.test(String(fields.expiration))) ? String(fields.expiration) : null;
    var expired = expiry ? (new Date(expiry + 'T00:00:00').getTime() < Date.now()) : false;
    return pool.query('UPDATE hr_documents SET extracted = $1, expires_at = $2, verify_status = $3, updated_at = NOW() WHERE id = $4', [JSON.stringify(fields), expiry, (expired ? 'flagged' : 'verified'), ins.rows[0].id]);
  }).catch(function () {});
});

// DELETE /api/onboarding/steps/:id/upload/:slot — remove a slot's pending file to redo it.
router.delete('/steps/:id/upload/:slot', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  const r = await pool.query(
    "SELECT id, r2_key FROM hr_documents WHERE user_id = $1 AND source = 'onboarding' AND slot_key = $2 AND review_status = 'pending' ORDER BY id DESC LIMIT 1",
    [req.user.id, String(req.params.slot || '').trim()]
  );
  if (!r.rows.length) return res.json({ success: true });
  try { await r2.deleteObject(r.rows[0].r2_key); } catch (e) {}
  await pool.query('DELETE FROM hr_documents WHERE id = $1', [r.rows[0].id]);
  res.json({ success: true });
});

// Failed quiz attempts since the last forced re-read (the 2-tries batch).
async function quizBatchFails(userId, stepId) {
  const rr = await pool.query("SELECT created_at FROM onboarding_events WHERE user_id = $1 AND step_id = $2 AND event_type = 'quiz_reread' ORDER BY id DESC LIMIT 1", [userId, stepId]);
  const since = rr.rows.length ? rr.rows[0].created_at : new Date(0);
  const fr = await pool.query("SELECT COUNT(*)::int AS c FROM onboarding_quiz_attempts WHERE user_id = $1 AND step_id = $2 AND passed = false AND submitted_at IS NOT NULL AND submitted_at > $3", [userId, stepId, since]);
  return fr.rows[0].c;
}
// Resolve a step's reading material (SOP text and/or vault doc) for re-read.
async function stepReading(step) {
  var out = {};
  const docId = parseInt(cfg(step).document_id, 10) || 0;
  if (step.sop_id) { const sop = await sopFullText(step.sop_id); if (sop) { out.sop_title = sop.title; out.sop_content = sop.text; } }
  try {
    const vdoc = docId ? await vaultDocById(docId) : (step.sop_id ? await sopVaultDoc(step.sop_id) : null);
    if (vdoc) { out.sop_doc_url = vdoc.url; out.sop_doc_mime = vdoc.mime_type; out.sop_doc_name = vdoc.name; if (!out.sop_title) out.sop_title = vdoc.name; }
  } catch (e) {}
  return out;
}

// POST /api/onboarding/steps/:id/quiz/start — generate a fresh attempt
router.post('/steps/:id/quiz/start', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  if (phaseOf(current) > (await getUserPhase(req.user.id))) return res.status(400).json({ error: 'Your paperwork is with your manager for review.' });
  if (current.type !== 'quiz' && current.type !== 'final_exam') return res.status(400).json({ error: 'This step is not a quiz.' });
  if (current.type === 'quiz' && (await quizBatchFails(req.user.id, stepId)) >= 2) return res.status(400).json({ error: 'Re-read the material before your next attempt.', must_reread: true });

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
  try { questions = current.type === 'final_exam' ? await generateExamQuestions(current, avoid) : await generateQuestions(current, avoid); }
  catch (e) { return res.status(502).json({ error: e.message }); }

  const ins = await pool.query(
    'INSERT INTO onboarding_quiz_attempts (user_id, step_id, questions, is_final_exam) VALUES ($1,$2,$3,$4) RETURNING id',
    [req.user.id, stepId, JSON.stringify(questions), current.type === 'final_exam']
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
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, step_id, score, passed, actor_id, actor_name) VALUES ($1,$2,$3,$4,$5,$1,$6)', [req.user.id, (attempt.is_final_exam ? 'exam_attempt' : 'quiz_attempt'), attempt.step_id, score, passed, req.user.name]);
  var revert = false, reading = null;
  if (!passed && step && step.type === 'quiz' && (await quizBatchFails(req.user.id, attempt.step_id)) >= 2) { revert = true; reading = await stepReading(step); }
  if (passed) await maybeNotifyReady(req.user.id);
  res.json({ score: score, passed: passed, need: need, results: results, revert_to_read: revert, reading: reading });
});

// POST /api/onboarding/steps/:id/quiz/reread — record the forced re-read, resetting the 2-try batch.
router.post('/steps/:id/quiz/reread', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId || current.type !== 'quiz') return res.status(400).json({ error: 'Not your current quiz.' });
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, step_id, actor_id, actor_name) VALUES ($1,$2,$3,$1,$4)', [req.user.id, 'quiz_reread', stepId, req.user.name]);
  res.json({ success: true });
});


// ---- Employee self-view: read-only access to one's OWN encrypted documents ----
router.get('/me/file', requireAuth, async (req, res) => {
  const docs = await pool.query("SELECT id, category, name, mime_type, expires_at, source, created_at FROM hr_documents WHERE user_id = $1 AND review_status <> 'superseded' ORDER BY category ASC, id DESC", [req.user.id]);
  res.json({ documents: docs.rows });
});
router.get('/me/hr-doc/:docId', requireAuth, async (req, res) => {
  if (req.headers['x-view-as']) return res.status(403).json({ error: 'Not available in preview mode.' });
  const docId = parseInt(req.params.docId, 10) || 0;
  const dr = await pool.query('SELECT user_id, r2_key, mime_type, name FROM hr_documents WHERE id = $1', [docId]);
  if (!dr.rows.length || dr.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Not permitted.' });
  try {
    const bytes = await hrCrypto.getDecrypted(dr.rows[0].r2_key);
    res.setHeader('Content-Type', dr.rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(dr.rows[0].name || 'document').replace(/"/g, '') + '"');
    await logAudit({ entity_type: 'hr_document', entity_id: docId, action: 'viewed_self', user_id: req.user.id, user_name: req.user.name, details: {} });
    res.send(bytes);
  } catch (e) { res.status(502).json({ error: 'Could not open the document.' }); }
});

// POST /api/onboarding/steps/:id/packet — save + submit the native New Hire Packet.
router.post('/steps/:id/packet', requireAuth, async (req, res) => {
  const stepId = parseInt(req.params.id, 10) || 0;
  const steps = await activeSteps();
  const prog = await progressMap(req.user.id);
  const current = findCurrent(steps, prog);
  if (!current || current.id !== stepId) return res.status(400).json({ error: 'That is not your current step.' });
  if (current.type !== 'form') return res.status(400).json({ error: 'This step is not a form.' });
  const fields = packetFields(current);
  const data = (req.body && req.body.data && typeof req.body.data === 'object') ? req.body.data : {};
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.who === 'manager' || !f.required) continue;
    var v = data[f.key];
    if (f.type === 'ack') { if (v !== true && v !== 'true') return res.status(400).json({ error: 'Please read and check the acknowledgment.' }); }
    else if (v == null || String(v).trim() === '') return res.status(400).json({ error: 'Please complete: ' + f.label });
  }
  await pool.query(
    "INSERT INTO onboarding_packet_responses (user_id, data, status, field_flags, submitted_at) VALUES ($1,$2::jsonb,'submitted','{}'::jsonb,NOW()) " +
    "ON CONFLICT (user_id) DO UPDATE SET data = COALESCE(onboarding_packet_responses.data,'{}'::jsonb) || $2::jsonb, status = 'submitted', field_flags = '{}'::jsonb, submitted_at = NOW(), updated_at = NOW()",
    [req.user.id, JSON.stringify(data)]
  );
  await pool.query(
    "INSERT INTO onboarding_progress (user_id, step_id, status, started_at, completed_at) VALUES ($1,$2,'done',NOW(),NOW()) " +
    "ON CONFLICT (user_id, step_id) DO UPDATE SET status = 'done', completed_at = NOW()",
    [req.user.id, stepId]
  );
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, step_id, actor_id, actor_name) VALUES ($1,$2,$3,$1,$4)', [req.user.id, 'packet_submitted', stepId, req.user.name]);
  await logAudit({ entity_type: 'onboarding', entity_id: stepId, action: 'packet_submitted', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true });
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
  const rows = r.rows;
  const docIds = [];
  rows.forEach(function (s) { const id = parseInt(cfg(s).document_id, 10) || 0; if (id) docIds.push(id); });
  if (docIds.length) {
    const dn = await pool.query('SELECT id, name FROM documents WHERE id = ANY($1::int[])', [docIds]);
    const map = {}; dn.rows.forEach(function (d) { map[d.id] = d.name; });
    rows.forEach(function (s) { const id = parseInt(cfg(s).document_id, 10) || 0; if (id) s.doc_title = map[id] || null; });
  }
  res.json(rows);
});

admin.post('/steps', async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (['video', 'sop_read', 'quiz', 'document_upload', 'acknowledge', 'final_exam', 'form'].indexOf(type) === -1) return res.status(400).json({ error: 'Invalid step type' });
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required' });
  if (type === 'quiz' && !parseInt(b.sop_id, 10)) return res.status(400).json({ error: 'Pick an SOP for the quiz' });
  if ((type === 'sop_read' || type === 'acknowledge') && !parseInt(b.document_id, 10)) return res.status(400).json({ error: 'Pick a document from the vault' });
  if (type === 'video' && !String(b.video_key || '').trim()) return res.status(400).json({ error: 'Upload the video first' });
  const mx = await pool.query('SELECT COALESCE(MAX(position),0) AS p FROM onboarding_steps WHERE active = true');
  const config = {};
  if (b.pass_score !== undefined) config.pass_score = parseInt(b.pass_score, 10) || DEFAULT_PASS_SCORE;
  if (b.question_count !== undefined) config.question_count = parseInt(b.question_count, 10) || DEFAULT_QUESTION_COUNT;
  if (b.min_seconds !== undefined) config.min_seconds = parseInt(b.min_seconds, 10) || 0;
  if (parseInt(b.document_id, 10)) config.document_id = parseInt(b.document_id, 10);
  const stepPhase = (parseInt(b.phase, 10) === 2) ? 2 : 1;
  const r = await pool.query(
    'INSERT INTO onboarding_steps (position, type, title, description, sop_id, video_key, config, phase) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [mx.rows[0].p + 1, type, title.slice(0, 200), String(b.description || '').trim() || null, parseInt(b.sop_id, 10) || null, String(b.video_key || '').trim() || null, JSON.stringify(config), stepPhase]
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
  if (b.document_id !== undefined) { const did = parseInt(b.document_id, 10); if (did) config.document_id = did; }
  const putPhase = (b.phase !== undefined) ? ((parseInt(b.phase, 10) === 2) ? 2 : 1) : null;
  const r = await pool.query(
    'UPDATE onboarding_steps SET title = COALESCE($1, title), description = $2, sop_id = COALESCE($3, sop_id), video_key = COALESCE($4, video_key), config = $5, phase = COALESCE($7, phase), updated_at = NOW() WHERE id = $6 RETURNING *',
    [b.title ? String(b.title).trim().slice(0, 200) : null, (b.description !== undefined ? (String(b.description).trim() || null) : s.description), parseInt(b.sop_id, 10) || null, (b.video_key ? String(b.video_key).trim() : null), JSON.stringify(config), id, putPhase]
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

// Vault documents in the "Standard Operating Procedures" folder — the pool a
// read step's document is chosen from.
admin.get('/vault-docs', async (req, res) => {
  const dr = await pool.query(
    "SELECT d.id, d.name, d.mime_type, COALESCE(f.name, 'Root') AS folder FROM documents d " +
    "LEFT JOIN document_folders f ON f.id = d.folder_id WHERE d.status = 'ready' " +
    "ORDER BY folder ASC, d.name ASC"
  );
  res.json(dr.rows);
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
  const ur = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms, onboarding_status, role, supervisor_id, onboarding_completion_override FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];
  if (!u.onboarding_status || u.onboarding_status === 'complete') return res.status(400).json({ error: 'This user is not in onboarding' });
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Only their supervisor (or an admin) can sign off' });

  const steps = await activeSteps();
  const prog = await progressMap(target);
  const force = req.body && req.body.force === true;
  if (findCurrent(steps, prog) && !force) return res.status(400).json({ error: 'They still have steps to finish', incomplete: true });

  await pool.query("UPDATE users SET onboarding_status = 'complete' WHERE id = $1", [target]);
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, actor_id, actor_name) VALUES ($1,$2,$3,$4)', [target, 'signoff', req.user.id, req.user.name]);
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

// ---- Phase 1 review (direct supervisor / owner / admin) ---------------------

// Hires whose Phase 1 is complete and awaiting the caller's review.
admin.get('/reviews', async (req, res) => {
  const ur = await pool.query("SELECT id, name, role, supervisor_id, onboarding_enrolled_at FROM users WHERE onboarding_status IS NOT NULL AND onboarding_status <> 'complete' AND (onboarding_phase IS NULL OR onboarding_phase = 1)");
  const steps = await activeSteps();
  const p1 = steps.filter(function (s) { return phaseOf(s) === 1; });
  const out = [];
  for (const u of ur.rows) {
    if (!p1.length) continue;
    const prog = await progressMap(u.id);
    const done = p1.every(function (s) { var pr = prog[s.id]; return pr && pr.status === 'done'; });
    if (!done) continue;
    if (!(await canSignOff(req.user, u.id))) continue;
    out.push({ id: u.id, name: u.name, role: u.role, enrolled_at: u.onboarding_enrolled_at });
  }
  res.json(out);
});

// Full Phase 1 detail for the reviewer: packet + uploaded docs + AI checks.
admin.get('/users/:id/phase1', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not your review to make.' });
  const pk = await pool.query('SELECT data, status, field_flags FROM onboarding_packet_responses WHERE user_id = $1', [target]);
  const docs = await pool.query("SELECT id, slot_key, category, name, mime_type, expires_at, extracted, verify_status, review_status, reject_reason FROM hr_documents WHERE user_id = $1 AND source = 'onboarding' AND review_status <> 'superseded' ORDER BY slot_key, id DESC", [target]);
  const verify = await verifySet(target);
  const _fs = await pool.query("SELECT * FROM onboarding_steps WHERE active = true AND type = 'form' ORDER BY position ASC LIMIT 1");
  var managerFields = _fs.rows.length ? packetFields(_fs.rows[0]).filter(function (f) { return f.who === 'manager'; }) : [];
  res.json({ packet: pk.rows[0] || null, documents: docs.rows, verify: verify, manager_fields: managerFields });
});

// Manager fills the employment / HR fields on the packet (employee never sees these).
admin.post('/users/:id/packet-details', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not permitted.' });
  const data = (req.body && req.body.data && typeof req.body.data === 'object') ? req.body.data : {};
  await pool.query(
    "INSERT INTO onboarding_packet_responses (user_id, data, status) VALUES ($1,$2::jsonb,'draft') " +
    "ON CONFLICT (user_id) DO UPDATE SET data = COALESCE(onboarding_packet_responses.data,'{}'::jsonb) || $2::jsonb, updated_at = NOW()",
    [target, JSON.stringify(data)]
  );
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'packet_details_saved', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true });
});

// Stream a decrypted HR document inline for review (access-checked + audited).
admin.get('/hr-doc/:docId', async (req, res) => {
  const docId = parseInt(req.params.docId, 10) || 0;
  const dr = await pool.query('SELECT user_id, r2_key, mime_type, name FROM hr_documents WHERE id = $1', [docId]);
  if (!dr.rows.length) return res.status(404).json({ error: 'Not found' });
  if (!(await canSignOff(req.user, dr.rows[0].user_id))) return res.status(403).json({ error: 'Not permitted.' });
  try {
    const bytes = await hrCrypto.getDecrypted(dr.rows[0].r2_key);
    res.setHeader('Content-Type', dr.rows[0].mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + String(dr.rows[0].name || 'document').replace(/"/g, '') + '"');
    await logAudit({ entity_type: 'hr_document', entity_id: docId, action: 'viewed', user_id: req.user.id, user_name: req.user.name, details: {} });
    res.send(bytes);
  } catch (e) { res.status(502).json({ error: 'Could not open the document.' }); }
});

// Approve Phase 1 -> advance the hire to Phase 2 (unlocks clock-in + training).
admin.post('/users/:id/phase1/approve', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  const ur = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms, onboarding_status FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];
  if (!u.onboarding_status || u.onboarding_status === 'complete') return res.status(400).json({ error: 'Not in onboarding' });
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Only their supervisor (or an admin) can approve' });
  const steps = await activeSteps();
  const prog = await progressMap(target);
  const p1 = steps.filter(function (s) { return phaseOf(s) === 1; });
  if (!p1.every(function (s) { var pr = prog[s.id]; return pr && pr.status === 'done'; })) return res.status(400).json({ error: 'They have not finished Phase 1 yet.' });

  await pool.query("UPDATE users SET onboarding_phase = 2 WHERE id = $1", [target]);
  await pool.query("UPDATE hr_documents SET review_status = 'accepted', updated_at = NOW() WHERE user_id = $1 AND source = 'onboarding' AND review_status = 'pending'", [target]);
  await pool.query("UPDATE onboarding_packet_responses SET status = 'approved', reviewed_by = $2, reviewed_by_name = $3, reviewed_at = NOW() WHERE user_id = $1", [target, req.user.id, req.user.name]);
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, actor_id, actor_name) VALUES ($1,$2,$3,$4)', [target, 'phase1_approved', req.user.id, req.user.name]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'phase1_approved', user_id: req.user.id, user_name: req.user.name, details: { user: u.name } });
  try {
    await push.sendPushToUsers([target], { title: 'Phase 1 approved', body: 'Your paperwork is approved — training is unlocked.', url: '/' });
    if (u.receive_emails !== false && u.email) {
      const html = emailTemplate({ badge: 'Phase 1 approved', badgeColor: 'green', title: 'Your paperwork is approved', body: 'Nice work, ' + u.name + '. <strong>' + req.user.name + '</strong> approved your Phase 1 paperwork. When you are ready, continue your training with your manager.', details: [{ label: 'Approved by', value: req.user.name }], buttonText: 'Continue onboarding', buttonUrl: appUrl('/') });
      await sendEmail(u.email, 'Your Phase 1 paperwork is approved', html);
    }
    if (u.receive_sms && u.phone) await sendSms(u.phone, 'Lock & Roll: your Phase 1 paperwork is approved. Continue training with your manager.');
  } catch (e) { console.error('[onboarding] phase1 approve notify failed:', e.message); }
  res.json({ success: true });
});

// Reopen Phase 1 back to the hire, flagging specific upload slots and/or packet fields.
admin.post('/users/:id/phase1/reopen', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  const ur = await pool.query('SELECT id, name, email, phone, receive_emails, receive_sms, onboarding_status FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'User not found' });
  const u = ur.rows[0];
  if (!u.onboarding_status || u.onboarding_status === 'complete') return res.status(400).json({ error: 'Not in onboarding' });
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Only their supervisor (or an admin) can reopen' });
  const b = req.body || {};
  const slots = Array.isArray(b.slots) ? b.slots : [];
  const fields = Array.isArray(b.fields) ? b.fields : [];
  const note = String(b.note || '').slice(0, 500);
  if (!slots.length && !fields.length) return res.status(400).json({ error: 'Flag at least one item to send back.' });
  const steps = await activeSteps();
  if (slots.length) {
    for (const sk of slots) {
      await pool.query("UPDATE hr_documents SET review_status = 'rejected', reject_reason = $3, updated_at = NOW() WHERE user_id = $1 AND source = 'onboarding' AND slot_key = $2 AND review_status <> 'superseded'", [target, String(sk), note || 'Please re-upload']);
    }
    const upStep = steps.filter(function (s) { return s.type === 'document_upload'; })[0];
    if (upStep) await pool.query("UPDATE onboarding_progress SET status = 'pending', completed_at = NULL WHERE user_id = $1 AND step_id = $2", [target, upStep.id]);
  }
  if (fields.length) {
    var flags = {}; fields.forEach(function (f) { flags[String(f)] = note || 'Please correct'; });
    await pool.query("UPDATE onboarding_packet_responses SET status = 'reopened', field_flags = $2, reviewed_by = $3, reviewed_by_name = $4, reviewed_at = NOW() WHERE user_id = $1", [target, JSON.stringify(flags), req.user.id, req.user.name]);
    const pkStep = steps.filter(function (s) { return s.type === 'form'; })[0];
    if (pkStep) await pool.query("UPDATE onboarding_progress SET status = 'pending', completed_at = NULL WHERE user_id = $1 AND step_id = $2", [target, pkStep.id]);
  }
  await pool.query('INSERT INTO onboarding_events (user_id, event_type, detail, actor_id, actor_name) VALUES ($1,$2,$3,$4,$5)', [target, 'phase1_reopened', JSON.stringify({ slots: slots, fields: fields, note: note }), req.user.id, req.user.name]);
  await pool.query("DELETE FROM onboarding_events WHERE user_id = $1 AND event_type = 'phase1_submitted'", [target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'phase1_reopened', user_id: req.user.id, user_name: req.user.name, details: { slots: slots, fields: fields } });
  try {
    await push.sendPushToUsers([target], { title: 'Onboarding needs your attention', body: 'Your manager sent something back to fix.', url: '/' });
    if (u.receive_emails !== false && u.email) {
      const html = emailTemplate({ badge: 'Action needed', badgeColor: 'orange', title: 'A couple things to fix', body: 'Hi ' + u.name + ', <strong>' + req.user.name + '</strong> sent part of your paperwork back to fix.' + (note ? '<br><br>Note: ' + note : '') + '<br><br>Open Nova to fix the flagged items and resubmit.', details: [], buttonText: 'Open Nova', buttonUrl: appUrl('/') });
      await sendEmail(u.email, 'Onboarding — a couple things to fix', html);
    }
    if (u.receive_sms && u.phone) await sendSms(u.phone, 'Lock & Roll: your manager sent part of your onboarding back to fix. Open Nova to resubmit.');
  } catch (e) { console.error('[onboarding] reopen notify failed:', e.message); }
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

// Full onboarding event record for a hire (Section 7 evidence).
admin.get('/users/:id/events', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not permitted.' });
  const r = await pool.query('SELECT id, event_type, step_id, document_id, document_version, score, passed, detail, actor_name, created_at FROM onboarding_events WHERE user_id = $1 ORDER BY id ASC', [target]);
  res.json(r.rows);
});

// Downloadable CSV of the hire's complete onboarding record.
admin.get('/users/:id/record.csv', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not permitted.' });
  const ur = await pool.query('SELECT name FROM users WHERE id = $1', [target]);
  const name = ur.rows.length ? ur.rows[0].name : ('user ' + target);
  const r = await pool.query('SELECT event_type, step_id, document_id, document_version, score, passed, detail, actor_name, created_at FROM onboarding_events WHERE user_id = $1 ORDER BY id ASC', [target]);
  const esc = function (v) { var s = (v == null ? '' : String(v)); return '"' + s.replace(/"/g, '""') + '"'; };
  var lines = ['Date,Event,Step ID,Document ID,Doc Version,Score,Passed,Actor,Detail'];
  r.rows.forEach(function (e) {
    var det = e.detail; if (det && typeof det === 'object') det = JSON.stringify(det);
    lines.push([esc(e.created_at ? new Date(e.created_at).toISOString() : ''), esc(e.event_type), esc(e.step_id), esc(e.document_id), esc(e.document_version), esc(e.score), esc(e.passed), esc(e.actor_name), esc(det)].join(','));
  });
  const csv = lines.join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="onboarding-record-' + String(name).replace(/[^a-zA-Z0-9]+/g, '_') + '.csv"');
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: 'record_exported', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.send(csv);
});

// ================= EMPLOYEE FILES (living personnel file) =====================
// Access mirrors onboarding review: Owner/Admin company-wide, Manager downline
// (canSignOff = admin/owner OR in the target's supervisor chain).

admin.get('/employees', async (req, res) => {
  var rows;
  if (req.user.role === 'admin' || req.user.isOwner) {
    rows = (await pool.query('SELECT id, name, role FROM users ORDER BY name ASC')).rows;
  } else {
    rows = (await pool.query(
      'WITH RECURSIVE dl AS (SELECT id, name, role FROM users WHERE supervisor_id = $1 ' +
      'UNION SELECT u.id, u.name, u.role FROM users u JOIN dl ON u.supervisor_id = dl.id) ' +
      'SELECT id, name, role FROM dl ORDER BY name ASC', [req.user.id])).rows;
  }
  const counts = await pool.query("SELECT user_id, COUNT(*)::int AS n FROM hr_documents WHERE review_status <> 'superseded' GROUP BY user_id");
  const cmap = {}; counts.rows.forEach(function (c) { cmap[c.user_id] = c.n; });
  res.json(rows.map(function (u) { return { id: u.id, name: u.name, role: u.role, doc_count: cmap[u.id] || 0 }; }));
});

admin.get('/employees/:id/file', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not permitted.' });
  const ur = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [target]);
  if (!ur.rows.length) return res.status(404).json({ error: 'Not found' });
  const docs = await pool.query("SELECT id, category, slot_key, name, mime_type, expires_at, verify_status, review_status, source, uploaded_by_name, created_at FROM hr_documents WHERE user_id = $1 AND review_status <> 'superseded' ORDER BY category ASC, id DESC", [target]);
  res.json({ user: ur.rows[0], documents: docs.rows });
});

admin.post('/employees/:id/upload', async (req, res) => {
  const target = parseInt(req.params.id, 10) || 0;
  if (!(await canSignOff(req.user, target))) return res.status(403).json({ error: 'Not permitted.' });
  if (!hrCrypto.storageReady()) return res.status(503).json({ error: 'Secure storage is not configured.' });
  const b = req.body || {};
  const category = String(b.category || 'other').slice(0, 40);
  const mime = String(b.mime_type || '').toLowerCase().split(';')[0].trim();
  if (['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'].indexOf(mime) === -1) return res.status(400).json({ error: 'Upload a photo or PDF.' });
  var raw = String(b.data || ''); var comma = raw.indexOf(',');
  if (raw.slice(0, 64).indexOf('base64') !== -1 && comma !== -1) raw = raw.slice(comma + 1);
  var bytes = null; try { bytes = Buffer.from(raw, 'base64'); } catch (e) { bytes = null; }
  if (!bytes || !bytes.length) return res.status(400).json({ error: 'That file did not come through.' });
  if (bytes.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'That file is too large (max 20 MB).' });
  const name = String(b.filename || 'document').slice(0, 200);
  const key = hrCrypto.hrKey(target, name);
  try { await hrCrypto.putEncrypted(key, bytes); } catch (e) { return res.status(502).json({ error: 'Could not store the file.' }); }
  const expires = (b.expires_at && /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires_at))) ? String(b.expires_at) : null;
  const ins = await pool.query("INSERT INTO hr_documents (user_id, category, r2_key, name, mime_type, size_bytes, expires_at, source, review_status, uploaded_by, uploaded_by_name) VALUES ($1,$2,$3,$4,$5,$6,$7,'manual','accepted',$8,$9) RETURNING id", [target, category, key, name, mime, bytes.length, expires, req.user.id, req.user.name]);
  await logAudit({ entity_type: 'hr_document', entity_id: ins.rows[0].id, action: 'uploaded_manual', user_id: req.user.id, user_name: req.user.name, details: { category: category } });
  res.json({ success: true });
});

admin.delete('/employees/hr-doc/:docId', async (req, res) => {
  const docId = parseInt(req.params.docId, 10) || 0;
  const dr = await pool.query('SELECT user_id, r2_key FROM hr_documents WHERE id = $1', [docId]);
  if (!dr.rows.length) return res.json({ success: true });
  if (!(await canSignOff(req.user, dr.rows[0].user_id))) return res.status(403).json({ error: 'Not permitted.' });
  try { await r2.deleteObject(dr.rows[0].r2_key); } catch (e) {}
  await pool.query('DELETE FROM hr_documents WHERE id = $1', [docId]);
  await logAudit({ entity_type: 'hr_document', entity_id: docId, action: 'deleted', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true });
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
  await logAudit({ entity_type: 'onboarding', entity_id: 0, action: 'completion_config_updated', user_id: req.user.id, user_name: req.user.name, details: { enabled: conf.enabled, task_count: (conf.tasks || []).length } });
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
    if (typeof raw.enabled === 'boolean') clean.enabled = raw.enabled;
    if (Array.isArray(raw.tasks)) {
      var ts = raw.tasks.map(cleanTask).filter(Boolean);
      if (ts.length) clean.tasks = ts;
    } else {
      // legacy single-field override (kept for back-compat)
      if (raw.notify != null) clean.notify = raw.notify === true;
      if (raw.create_task != null) clean.create_task = raw.create_task === true;
      var rid = parseInt(raw.recipient_id, 10); if (rid) clean.recipient_id = rid;
      if (raw.task_title != null && String(raw.task_title).trim() !== '') clean.task_title = String(raw.task_title).slice(0, 300);
      if (raw.task_description != null && String(raw.task_description).trim() !== '') clean.task_description = String(raw.task_description).slice(0, 4000);
      if (['low', 'medium', 'high'].indexOf(raw.task_priority) >= 0) clean.task_priority = raw.task_priority;
      if (raw.task_due_days != null && raw.task_due_days !== '') { var dd = parseInt(raw.task_due_days, 10); if (dd >= 0 && dd <= 60) clean.task_due_days = dd; }
    }
    if (!Object.keys(clean).length) clean = null;
  }
  await pool.query('UPDATE users SET onboarding_completion_override = $1 WHERE id = $2', [clean ? JSON.stringify(clean) : null, target]);
  await logAudit({ entity_type: 'onboarding', entity_id: target, action: clean ? 'completion_override_set' : 'completion_override_cleared', user_id: req.user.id, user_name: req.user.name, details: {} });
  res.json({ success: true, override: clean });
});

module.exports = router;
