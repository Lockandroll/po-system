// Customer feedback intake orchestrator. Reused by the Pulsar inbound webhook
// and (later) a manual-create path. Resolves city -> manager(s), tech, inserts the
// feedback record (deduped), auto-creates a task for the city manager, logs the
// activity timeline, and sends admins an FYI. Never throws past its own try/catch -
// a failure flags the row needs_review rather than dropping the feedback.
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('./email');
const { resolveAssignee } = require('./taskFromEmail');
const { notifyTaskAssigned } = require('../jobs/taskReminders');

const APP = (process.env.APP_URL || '').replace(/\/$/, '');

// 'FL - Orlando' -> 'Orlando'. Falls back to the whole string.
function cityNameFromLocation(locationRaw) {
  if (!locationRaw) return null;
  var s = String(locationRaw).trim();
  var dash = s.indexOf('-');
  if (dash !== -1) s = s.slice(dash + 1);
  return s.trim() || null;
}

async function resolveCityCode(locationRaw) {
  var name = cityNameFromLocation(locationRaw);
  if (!name) return null;
  try {
    var r = await pool.query('SELECT code FROM cities WHERE lower(name) = lower($1) LIMIT 1', [name]);
    if (r.rows.length) return r.rows[0].code;
    r = await pool.query('SELECT code FROM cities WHERE name ILIKE $1 LIMIT 1', ['%' + name + '%']);
    if (r.rows.length) return r.rows[0].code;
  } catch (e) { console.error('[feedback] resolveCityCode:', e.message); }
  return null;
}

// Managers assigned to the city. Falls back to all admins/owners if the city has
// none (or is unknown). Returns an array of { id, name, email, phone }.
async function resolveRecipients(cityCode) {
  try {
    if (cityCode) {
      var r = await pool.query(
        'SELECT u.id, u.name, u.email, u.phone FROM users u ' +
        'JOIN user_cities uc ON uc.user_id = u.id ' +
        "WHERE uc.city_code = $1 AND u.role = 'manager' AND u.active = true",
        [cityCode]
      );
      if (r.rows.length) return { recipients: r.rows, fellBack: false };
    }
  } catch (e) { console.error('[feedback] resolveRecipients:', e.message); }
  try {
    var a = await pool.query("SELECT id, name, email, phone FROM users WHERE role IN ('admin','owner') AND active = true");
    return { recipients: a.rows, fellBack: true };
  } catch (e) { console.error('[feedback] resolveRecipients fallback:', e.message); return { recipients: [], fellBack: true }; }
}

async function resolveTechUserId(techNameRaw) {
  if (!techNameRaw) return null;
  try {
    var u = await resolveAssignee(techNameRaw);
    return u ? u.id : null;
  } catch (e) { return null; }
}

async function listAdmins() {
  try {
    var r = await pool.query("SELECT id, name, email FROM users WHERE role IN ('admin','owner') AND active = true AND email IS NOT NULL");
    return r.rows;
  } catch (e) { return []; }
}

async function fyiEnabled() {
  try {
    var r = await pool.query("SELECT value FROM settings WHERE key = 'feedback_admin_fyi'");
    if (r.rows.length && String(r.rows[0].value) === '0') return false;
  } catch (e) {}
  return true;
}

// Basic priority until AI classification lands (Phase 3).
function priorityFromCategory(cat) {
  if (cat === 'tech_conduct' || cat === 'complaint' || cat === 'damage') return 'high';
  if (cat === 'praise') return 'low';
  return 'medium';
}

async function logActivity(feedbackId, user, type, body, channel) {
  try {
    await pool.query(
      'INSERT INTO customer_feedback_activity (feedback_id, user_id, user_name, type, channel, body) VALUES ($1,$2,$3,$4,$5,$6)',
      [feedbackId, user ? user.id : null, user ? user.name : null, type || 'note', channel || null, body || '']
    );
    await pool.query('UPDATE customer_feedback SET last_interaction_at = NOW(), updated_at = NOW() WHERE id = $1', [feedbackId]);
  } catch (e) { console.error('[feedback] logActivity:', e.message); }
}

async function alreadyExists(source, externalRef) {
  if (!externalRef) return null;
  try {
    var r = await pool.query('SELECT id FROM customer_feedback WHERE source = $1 AND external_ref = $2 LIMIT 1', [source, externalRef]);
    return r.rows.length ? r.rows[0].id : null;
  } catch (e) { return null; }
}

// parsed = output of parsePulsarEmail; meta = { source, external_ref, raw_email, raw_subject }
async function intakeFeedback(parsed, meta) {
  meta = meta || {};
  var source = meta.source || 'pulsar';

  var dupId = await alreadyExists(source, meta.external_ref);
  if (dupId) { console.log('[feedback] duplicate, skipping. id=' + dupId); return { duplicate: true, id: dupId }; }

  var cityCode = await resolveCityCode(parsed.location_raw);
  var techId = await resolveTechUserId(parsed.tech_name_raw);
  var recRes = await resolveRecipients(cityCode);
  var recipients = recRes.recipients;
  var assignee = recipients.length ? recipients[0] : null;
  var category = parsed.category_hint || 'complaint';
  var needsReview = (!cityCode) || (!techId) || recRes.fellBack;

  var ins = await pool.query(
    'INSERT INTO customer_feedback (source, external_ref, received_at, raw_email, raw_subject, ' +
    'customer_name, customer_phone, customer_email, vehicle_make, vehicle_model, vehicle_year, ' +
    'service_task, job_location, location_raw, city_code, tech_name_raw, tech_user_id, incident_text, ' +
    'invoice_ref, category, status, assigned_to, needs_review) ' +
    "VALUES ($1,$2,COALESCE($3, NOW()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'new',$21,$22) RETURNING *",
    [source, meta.external_ref || null, parsed.received_at || null, meta.raw_email || null, meta.raw_subject || null,
     parsed.customer_name, parsed.customer_phone, parsed.customer_email, parsed.vehicle_make, parsed.vehicle_model,
     parsed.vehicle_year, parsed.service_task, parsed.job_location, parsed.location_raw, cityCode, parsed.tech_name_raw,
     techId, parsed.incident_text, parsed.invoice_ref, category, assignee ? assignee.id : null, needsReview]
  );
  var fb = ins.rows[0];

  await logActivity(fb.id, null, 'event', 'Created from ' + (source === 'pulsar' ? 'Pulsar email' : source) + '.', source);

  // Auto-create the task for the city manager.
  var task = null;
  if (assignee) {
    try {
      var title = 'Customer feedback: ' + (parsed.customer_name || 'Unknown') +
        (cityCode ? ' (' + cityCode + ')' : '');
      var descParts = [];
      if (parsed.incident_text) descParts.push(parsed.incident_text);
      descParts.push('---');
      if (parsed.tech_name_raw) descParts.push('Tech named: ' + parsed.tech_name_raw);
      if (parsed.service_task) descParts.push('Task: ' + parsed.service_task);
      if (parsed.vehicle_year || parsed.vehicle_make) {
        descParts.push('Vehicle: ' + [parsed.vehicle_year, parsed.vehicle_make, parsed.vehicle_model].filter(Boolean).join(' '));
      }
      descParts.push('Feedback record: ' + APP + '/?view=feedback&id=' + fb.id);
      var priority = priorityFromCategory(category);
      var t = await pool.query(
        'INSERT INTO tasks (title, description, status, priority, assigned_to, created_by, source) ' +
        "VALUES ($1,$2,'todo',$3,$4,$5,'feedback') RETURNING *",
        [title, descParts.join('\n'), priority, assignee.id, assignee.id]
      );
      task = t.rows[0];
      await pool.query('UPDATE customer_feedback SET task_id = $1 WHERE id = $2', [task.id, fb.id]);
      await logActivity(fb.id, null, 'event', 'Assigned to ' + assignee.name + ' (task #' + task.id + ').', null);
      try { await notifyTaskAssigned(task.id); } catch (e) { console.error('[feedback] notifyTaskAssigned:', e.message); }
    } catch (e) { console.error('[feedback] create task:', e.message); }
  }

  // Admin FYI email.
  try {
    if (await fyiEnabled()) {
      var admins = await listAdmins();
      var to = admins.map(function (a) { return a.email; }).filter(Boolean);
      if (to.length) {
        var details = [
          { label: 'Customer', value: parsed.customer_name || 'Unknown' },
          { label: 'City', value: cityCode || (parsed.location_raw || 'Unknown') },
          { label: 'Tech', value: parsed.tech_name_raw || 'Unknown' },
          { label: 'Category', value: category },
          { label: 'Assigned to', value: assignee ? assignee.name : 'Unassigned (needs review)' }
        ];
        var html = emailTemplate({
          badge: 'New Feedback', badgeColor: 'orange',
          title: 'New customer feedback received',
          body: parsed.incident_text || 'A new customer feedback record was created.',
          details: details,
          buttonText: 'View Feedback', buttonUrl: APP + '/?view=feedback&id=' + fb.id,
          footerNote: 'FYI only - no action required. The assigned manager has a task.'
        });
        await sendEmail(to[0], 'New customer feedback: ' + (parsed.customer_name || 'Unknown'), html, to.slice(1));
      }
    }
  } catch (e) { console.error('[feedback] admin FYI:', e.message); }

  return { duplicate: false, id: fb.id, feedback: fb, task: task, assignee: assignee, needsReview: needsReview };
}

module.exports = {
  intakeFeedback: intakeFeedback,
  logActivity: logActivity,
  resolveCityCode: resolveCityCode,
  resolveRecipients: resolveRecipients,
  resolveTechUserId: resolveTechUserId,
  priorityFromCategory: priorityFromCategory
};
