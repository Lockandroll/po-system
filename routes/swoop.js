// Swoop (Agero) review surveys - the Swoop Surveys page. Mirrors routes/geico.js.
// Gated on manage_geico on purpose (Tony, 2026-10-05: "reuse Geico access"), so
// it is live for every role that already sees Geico Surveys, with no new box.
// House style: string concatenation, no template literals (CLAUDE.md 1.1).

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { logActivity } = require('../utils/feedbackIntake');
const { buildEmployeeResolver } = require('../utils/rosterMatch');
const SW = require('../utils/swoopSurvey');

const adminMgr = [requireAuth, requirePermission('manage_geico')];

// Display name always follows the CURRENT users.name for a linked row, so a
// rename does not split one person into two rows on the leaderboard.
const EMP_NAME = "COALESCE(NULLIF(u.name,''), NULLIF(s.employee_name,''))";
const EMP_JOIN = ' LEFT JOIN users u ON u.id = s.employee_user_id ';
const VERIFIED_SQL = "(s.employee_source IN ('import','manual'))";

function keyAuth(req, res, next) {
  const expected = process.env.REPORT_API_KEY;
  if (!expected) return res.status(500).json({ error: 'REPORT_API_KEY is not configured' });
  if (req.headers['x-report-key'] !== expected) return res.status(401).json({ error: 'Invalid or missing report key' });
  next();
}

function jobs() { return require('../jobs/swoopSurveys'); }

// Shared WHERE builder for the list and the stats, so the cards always describe
// exactly the rows in the table.
//   from, to (YYYY-MM-DD, to exclusive), city_code, employee (display name),
//   band (promoter | passive | detractor), verified (yes | no)
function buildWhere(q, bands) {
  const where = [];
  const params = [];
  function add(cond, val) { params.push(val); where.push(cond.replace('$$', '$' + params.length)); }
  if (q.from) add('s.date_received >= $$', q.from);
  if (q.to) add('s.date_received < $$', q.to);
  if (q.city_code) add('s.city_code = $$', q.city_code);
  if (q.employee) add(EMP_NAME + ' = $$', q.employee);
  const d = parseInt(bands.detractorMax, 10), p = parseInt(bands.passiveMax, 10);
  if (q.band === 'detractor') where.push('s.score <= ' + d);
  else if (q.band === 'passive') where.push('s.score > ' + d + ' AND s.score <= ' + p);
  else if (q.band === 'promoter') where.push('s.score > ' + p);
  if (q.verified === 'yes') where.push(VERIFIED_SQL);
  else if (q.verified === 'no') where.push("COALESCE(s.employee_source,'') NOT IN ('import','manual')");
  return { sql: where.length ? ('WHERE ' + where.join(' AND ')) : '', params: params };
}

// GET /api/swoop - filtered list
router.get('/', adminMgr, async (req, res) => {
  try {
    const bands = await SW.npsBands();
    const w = buildWhere(req.query, bands);
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const offset = parseInt(req.query.offset, 10) || 0;
    const sql =
      "SELECT s.id, s.job_id, s.score, " + SW.npsSql('s.score', bands) + " AS nps, s.feedback, s.account, " +
      "       s.driver_raw, s.pickup_contact, s.pickup_phone, s.city_code, COALESCE(c.name,'') AS city_name, " +
      "       to_char(s.date_received,'YYYY-MM-DD') AS date_received, " +
      "       " + EMP_NAME + " AS employee_name, s.employee_user_id, s.employee_source, " +
      "       cf.id AS complaint_id, cf.status AS complaint_status " +
      "FROM swoop_surveys s LEFT JOIN cities c ON c.code = s.city_code " + EMP_JOIN +
      "LEFT JOIN customer_feedback cf ON cf.source = 'swoop_survey' AND cf.external_ref = s.job_id " +
      w.sql + " ORDER BY s.date_received DESC NULLS LAST, s.id DESC LIMIT " + limit + " OFFSET " + offset;
    const { rows } = await pool.query(sql, w.params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/swoop failed:', err);
    res.status(500).json({ error: 'Failed to load Swoop surveys' });
  }
});

// GET /api/swoop/stats - NPS overall, by city and by employee.
// NPS = the plain average of each survey's -100 / 0 / 100 value (Tony's rule),
// which is the same number as "% promoters minus % detractors".
router.get('/stats', adminMgr, async (req, res) => {
  try {
    const bands = await SW.npsBands();
    const w = buildWhere(req.query, bands);
    const nps = SW.npsSql('s.score', bands);
    const d = parseInt(bands.detractorMax, 10), p = parseInt(bands.passiveMax, 10);
    const agg =
      " COUNT(*)::int AS n, COUNT(s.score)::int AS scored, " +
      " ROUND(AVG(" + nps + ")::numeric, 1)::float AS nps, " +
      " SUM(CASE WHEN s.score > " + p + " THEN 1 ELSE 0 END)::int AS promoters, " +
      " SUM(CASE WHEN s.score > " + d + " AND s.score <= " + p + " THEN 1 ELSE 0 END)::int AS passives, " +
      " SUM(CASE WHEN s.score <= " + d + " THEN 1 ELSE 0 END)::int AS detractors, " +
      " SUM(CASE WHEN " + VERIFIED_SQL + " THEN 1 ELSE 0 END)::int AS verified ";
    const from = " FROM swoop_surveys s LEFT JOIN cities c ON c.code = s.city_code " + EMP_JOIN + w.sql;
    const [tot, city, emp] = await Promise.all([
      pool.query('SELECT' + agg + from, w.params),
      pool.query("SELECT COALESCE(c.name,'(no city)') AS k," + agg + from + ' GROUP BY 1 ORDER BY n DESC', w.params),
      pool.query("SELECT COALESCE(" + EMP_NAME + ",'(unassigned)') AS k, MAX(s.employee_user_id) AS user_id," + agg + from +
        ' GROUP BY 1 ORDER BY n DESC', w.params)
    ]);
    const maxScore = await SW.complaintMaxScore();
    res.json({
      total: tot.rows[0], byCity: city.rows, byEmployee: emp.rows,
      bands: bands, complaintMaxScore: maxScore
    });
  } catch (err) {
    console.error('GET /api/swoop/stats failed:', err);
    res.status(500).json({ error: 'Failed to load Swoop stats' });
  }
});

// GET /api/swoop/employees - the people picker (active first, former kept).
router.get('/employees', adminMgr, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, active FROM users ORDER BY active DESC, name ASC');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/swoop/employees failed:', err.message);
    res.json([]);
  }
});

// After a job is verified: correct the survey's city when it was only ever a
// guess from Swoop's driver, and put the person on the complaint if the
// complaint has nobody yet. A complaint that already names a tech is left
// alone - somebody set it on purpose.
async function afterVerify(surveyId, jobId, userId, name, actor) {
  if (userId) {
    try {
      const { homeCityOf } = jobs();
      const city = await homeCityOf(userId);
      if (city) {
        await pool.query(
          "UPDATE swoop_surveys SET city_code = $1, city_source = 'employee', updated_at = NOW() " +
          "WHERE id = $2 AND (city_source IS NULL OR city_source = 'driver')",
          [city, surveyId]);
      }
    } catch (e) { console.error('[swoop] afterVerify city:', e.message); }
  }
  if (!userId) return;
  try {
    const cf = await pool.query(
      "SELECT id FROM customer_feedback WHERE source = 'swoop_survey' AND external_ref = $1 AND tech_user_id IS NULL LIMIT 1",
      [jobId]);
    if (!cf.rows.length) return;
    await pool.query('UPDATE customer_feedback SET tech_user_id = $1, tech_name_raw = $2, updated_at = NOW() WHERE id = $3',
      [userId, name, cf.rows[0].id]);
    await logActivity(cf.rows[0].id, actor || null, 'event',
      'Swoop job ' + jobId + ' verified: technician is ' + name + '.', null);
  } catch (e) { console.error('[swoop] afterVerify complaint:', e.message); }
}

// PUT /api/swoop/assign-employee  body: { job_id, user_id }  (null clears)
// A pick here is 'manual' = verified, and a later CSV import will not touch it.
router.put('/assign-employee', adminMgr, async (req, res) => {
  const job = (req.body && req.body.job_id != null) ? String(req.body.job_id).trim() : '';
  if (!job) return res.status(400).json({ error: 'job_id is required' });
  const rawId = req.body ? req.body.user_id : null;
  const userId = (rawId === null || rawId === undefined || rawId === '') ? null : parseInt(rawId, 10);
  if (userId !== null && (isNaN(userId) || userId <= 0)) return res.status(400).json({ error: 'user_id is not valid' });
  try {
    const sv = await pool.query('SELECT id, employee_name, employee_user_id FROM swoop_surveys WHERE job_id = $1', [job]);
    if (!sv.rows.length) return res.status(404).json({ error: 'That Swoop job ID is not in the survey table.' });
    const before = sv.rows[0];
    if (userId === null) {
      await pool.query('UPDATE swoop_surveys SET employee_name = NULL, employee_user_id = NULL, employee_source = NULL, updated_at = NOW() WHERE id = $1', [before.id]);
      await logAudit({ entity_type: 'swoop_survey', entity_id: before.id, entity_number: job, action: 'employee_cleared',
        user_id: req.user.id, user_name: req.user.name,
        details: { from: before.employee_name || null, from_user_id: before.employee_user_id || null } });
      return res.json({ job_id: job, employee_name: null, employee_user_id: null, employee_source: null });
    }
    const u = await pool.query('SELECT id, name FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(400).json({ error: 'That user does not exist.' });
    const name = u.rows[0].name;
    await pool.query("UPDATE swoop_surveys SET employee_name = $1, employee_user_id = $2, employee_source = 'manual', updated_at = NOW() WHERE id = $3",
      [name, userId, before.id]);
    await logAudit({ entity_type: 'swoop_survey', entity_id: before.id, entity_number: job, action: 'employee_assigned',
      user_id: req.user.id, user_name: req.user.name,
      details: { to: name, to_user_id: userId, from: before.employee_name || null, from_user_id: before.employee_user_id || null } });
    await afterVerify(before.id, job, userId, name, req.user);
    res.json({ job_id: job, employee_name: name, employee_user_id: userId, employee_source: 'manual' });
  } catch (err) {
    console.error('PUT /api/swoop/assign-employee failed:', err.message);
    res.status(500).json({ error: 'Failed to assign the employee' });
  }
});

// POST /api/swoop/import-employees  body: { rows: [{ job_id, employee_name }] }
// The verification upload. Each name goes through the shared roster matcher; a
// name nobody matches is kept as text (still counts as verified, because a
// human wrote it down). Hand-picked rows are never overwritten.
router.post('/import-employees', adminMgr, async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows provided' });
    if (rows.length > 5000) return res.status(400).json({ error: 'That file has more than 5,000 rows. Split it and import in parts.' });
    const resolver = await buildEmployeeResolver();
    let updated = 0, skipped = 0, notFound = 0, matched = 0, unmatched = 0, manualKept = 0;
    const notFoundList = [];
    const unmatchedNames = {};
    for (let i = 0; i < rows.length; i++) {
      const job = String(rows[i].job_id == null ? '' : rows[i].job_id).replace(/^#/, '').trim();
      const emp = String(rows[i].employee_name == null ? '' : rows[i].employee_name).trim();
      if (!job || !emp) { skipped++; continue; }
      const ex = await pool.query('SELECT id, employee_source FROM swoop_surveys WHERE job_id = $1', [job]);
      if (!ex.rows.length) { notFound++; if (notFoundList.length < 25) notFoundList.push(job); continue; }
      if (ex.rows[0].employee_source === 'manual') { manualKept++; continue; }
      const hit = SW.resolveDriver(resolver, emp);
      if (hit.user_id) matched++; else { unmatched++; unmatchedNames[emp] = 1; }
      const name = hit.user_id ? hit.name : emp;
      const r = await pool.query(
        "UPDATE swoop_surveys SET employee_name = $1, employee_user_id = $2, employee_source = 'import', updated_at = NOW() WHERE id = $3",
        [name, hit.user_id, ex.rows[0].id]);
      updated += r.rowCount;
      await afterVerify(ex.rows[0].id, job, hit.user_id, name, req.user);
    }
    await logAudit({ entity_type: 'swoop_survey', entity_id: null, entity_number: null, action: 'employees_imported',
      user_id: req.user.id, user_name: req.user.name,
      details: { rows: rows.length, updated: updated, matched: matched, unmatched: unmatched, notFound: notFound, manualKept: manualKept } });
    res.json({ ok: true, updated, skipped, notFound, notFoundList, matched, unmatched, manualKept,
      unmatchedNames: Object.keys(unmatchedNames).slice(0, 25) });
  } catch (err) {
    console.error('POST /api/swoop/import-employees failed:', err);
    res.status(500).json({ error: 'Failed to import employees' });
  }
});

// POST /api/swoop/file-complaint  body: { job_id }
// By hand, for a survey above the threshold or older than the auto-file window.
router.post('/file-complaint', requireAuth, requirePermission('manage_feedback'), async (req, res) => {
  const job = (req.body && req.body.job_id != null) ? String(req.body.job_id).trim() : '';
  if (!job) return res.status(400).json({ error: 'job_id is required' });
  try {
    const J = jobs();
    const { rows } = await pool.query(J.SURVEY_COLUMNS + 'WHERE s.job_id = $1 LIMIT 1', [job]);
    if (!rows.length) return res.status(404).json({ error: 'That Swoop job ID is not in the survey table.' });
    const result = await J.fileComplaintForSurvey(rows[0]);
    if (!result || !result.id) return res.status(500).json({ error: 'Could not file the complaint. Check the server log.' });
    res.json({ id: result.id, duplicate: !!result.duplicate, job_id: job });
  } catch (err) {
    console.error('POST /api/swoop/file-complaint failed:', err.message);
    res.status(500).json({ error: 'Failed to file complaint: ' + err.message });
  }
});

// POST /api/swoop/check-now - run one pass (mailbox read + complaint filing) now.
router.post('/check-now', adminMgr, async (req, res) => {
  try {
    const out = await jobs().runPassOnce();
    if (!out) return res.status(409).json({ error: 'A check is already running. Try again in a minute.' });
    res.json({
      ok: true,
      mailboxOk: !!out.ingest,
      fetched: out.ingest ? out.ingest.fetched : 0,
      inserted: out.ingest ? out.ingest.inserted : 0,
      filed: out.filing.filed
    });
  } catch (err) {
    console.error('POST /api/swoop/check-now failed:', err.message);
    res.status(500).json({ error: 'Check failed: ' + err.message });
  }
});

// POST /api/swoop/ingest - backfill a date range (key-protected, for curl)
//   body: { startIso, endIso, mailbox }
router.post('/ingest', keyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.startIso || !b.endIso) return res.status(400).json({ error: 'startIso and endIso are required' });
    const summary = await jobs().ingestRange({ startIso: b.startIso, endIso: b.endIso, mailbox: b.mailbox });
    res.json({ ok: true, summary: summary });
  } catch (err) {
    console.error('POST /api/swoop/ingest failed:', err);
    res.status(500).json({ error: err.message || 'Failed to ingest' });
  }
});

module.exports = router;
