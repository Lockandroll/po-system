const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { runWeeklyReport, ingestRange } = require('../jobs/geicoIngest');
const PC = require('../utils/pulsarCash');
const { logAudit } = require('../utils/audit');

const adminMgr = [requireAuth, requirePermission('manage_geico')];

// The employee credited on a survey lives in two places:
//   geico_surveys.employee_user_id - a real Nova user, set either by the
//     Employee dropdown on the survey table or by the CSV import when the
//     imported name matched somebody on the roster.
//   geico_surveys.employee_name    - the display name. For a linked row it is a
//     copy of users.name; for an imported name nobody could match it is the raw
//     Geico "Tech ID" text.
// Everything the UI reads goes through EMP_NAME so a linked row always shows
// (and groups under) the user's CURRENT name - rename someone in Users and the
// leaderboard follows, instead of splitting them in two.
const EMP_NAME = "COALESCE(NULLIF(u.name,''), NULLIF(g.employee_name,''))";
const EMP_JOIN = ' LEFT JOIN users u ON u.id = g.employee_user_id ';

// Shared-secret guard for the action endpoints (so they can be curl-tested
// without a logged-in session). Header: x-report-key: <REPORT_API_KEY>
function keyAuth(req, res, next) {
  const expected = process.env.REPORT_API_KEY;
  if (!expected) return res.status(500).json({ error: 'REPORT_API_KEY is not configured' });
  if (req.headers['x-report-key'] !== expected) return res.status(401).json({ error: 'Invalid or missing report key' });
  next();
}

// Geico writes the technician as "Last, First" ("Benson, Chris"); Nova stores
// people as "Chris Benson". This is the same roster matcher the Pulsar cash
// import uses (routes/pulsar.js), minus the saved-override tier - there is no
// hand-kept map for Geico:
//   1. users.pulsar_name        (the field that exists precisely for this)
//   2. users.name / nickname
//   3. last name + first initial, ONLY when exactly one ACTIVE user answers to
//      it. Nova has several people sharing a last name, so "same last name"
//      alone can never match.
// Anything else stays unmatched and is stored as raw text - a wrong link is far
// worse than an unlinked name, because the leaderboard would credit the wrong
// person and nobody would know to look.
async function buildEmployeeResolver() {
  const { rows } = await pool.query('SELECT id, name, pulsar_name, nickname, active FROM users');
  const exact = {};     // squashed key -> { id, tier }
  const initial = {};   // "lastname f" -> [ids]
  const byId = {};

  function claim(key, id, tier) {
    if (!key) return;
    const prior = exact[key];
    if (!prior || tier < prior.tier) exact[key] = { id: id, tier: tier };
  }

  rows.forEach(function (row) {
    byId[row.id] = { id: row.id, name: row.name, active: row.active };
    claim(PC.squash(row.pulsar_name), row.id, 1);
    claim(PC.squash(row.name), row.id, 2);
    String(row.nickname == null ? '' : row.nickname).split(',').forEach(function (nick) {
      claim(PC.squash(nick), row.id, 2);
    });
    const forms = [row.name].concat(String(row.nickname == null ? '' : row.nickname).split(','));
    forms.forEach(function (form) {
      const toks = PC.squash(form).split(' ').filter(Boolean);
      if (toks.length < 2) return;
      const key = toks[toks.length - 1] + ' ' + toks[0].charAt(0);
      if (!initial[key]) initial[key] = [];
      if (initial[key].indexOf(row.id) === -1) initial[key].push(row.id);
    });
  });

  return {
    byId: byId,
    // Returns { user_id, name, tier } - user_id null when nobody matched.
    resolve: function (raw) {
      const nm = PC.normalizeTechName(raw);
      let best = null;
      for (let i = 0; i < nm.keys.length; i++) {
        const hit = exact[nm.keys[i]];
        if (hit && (!best || hit.tier < best.tier)) best = hit;
      }
      if (best) return { user_id: best.id, name: byId[best.id].name, tier: best.tier };
      if (nm.last && nm.first) {
        const key = PC.squash(nm.last) + ' ' + PC.squash(nm.first).charAt(0);
        const ids = (initial[key] || []).filter(function (id) { return byId[id] && byId[id].active; });
        if (ids.length === 1) return { user_id: ids[0], name: byId[ids[0]].name, tier: 3 };
      }
      return { user_id: null, name: null, tier: 99 };
    }
  };
}

// GET /api/geico  - filtered list of stored surveys (admin/manager)
// Query params: from, to (YYYY-MM-DD), city_code, service, rating, loss_state, limit, offset
router.get('/', adminMgr, async (req, res) => {
  try {
    const where = [];
    const params = [];
    function add(cond, val) { params.push(val); where.push(cond.replace('$$', '$' + params.length)); }

    if (req.query.from)       add('g.date_received >= $$', req.query.from);
    if (req.query.to)         add('g.date_received < $$', req.query.to);
    if (req.query.city_code)  add('g.city_code = $$', req.query.city_code);
    if (req.query.service)    add('g.service = $$', req.query.service);
    if (req.query.rating)     add('g.rating = $$', req.query.rating);
    if (req.query.loss_state) add('g.loss_state = $$', req.query.loss_state);
    if (req.query.employee)   add(EMP_NAME + ' = $$', req.query.employee);

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const offset = parseInt(req.query.offset, 10) || 0;

    // cf: the Customer Feedback complaint already filed against this survey, if
    // any. Poor/Fair surveys file themselves through jobs/geicoComplaints.js,
    // keyed on external_ref = the Geico PO number.
    const sql =
      "SELECT g.id, to_char(g.date_received,'YYYY-MM-DD') AS date_received, g.account_number, " +
      "       g.city_code, COALESCE(c.name,'') AS city_name, g.po_number, g.service, g.loss_state, " +
      "       to_char(g.date_of_dispatch,'MM/DD/YYYY') AS date_of_dispatch, g.arrived_on_time, " +
      "       g.time_to_arrive, g.rating, " + EMP_NAME + " AS employee_name, " +
      "       g.employee_user_id, g.employee_source, " +
      "       cf.id AS complaint_id, cf.status AS complaint_status " +
      "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code " +
      EMP_JOIN +
      "LEFT JOIN customer_feedback cf ON cf.source = 'geico_survey' AND cf.external_ref = g.po_number " +
      whereSql + " ORDER BY g.date_received DESC, c.name ASC NULLS LAST " +
      "LIMIT " + limit + " OFFSET " + offset;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/geico failed:', err);
    res.status(500).json({ error: 'Failed to load surveys' });
  }
});

// GET /api/geico/employees - the people picker for the Employee column.
// Real Nova users only (active first; former employees stay on the list because
// older surveys still credit them). A manual pick always links a user id.
router.get('/employees', adminMgr, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, nickname, active FROM users ORDER BY active DESC, name ASC'
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/geico/employees failed:', err.message);
    res.json([]);
  }
});

// GET /api/geico/stats - summary breakdowns (admin/manager)
router.get('/stats', adminMgr, async (req, res) => {
  try {
    const where = [];
    const params = [];
    function add(cond, val) { params.push(val); where.push(cond.replace('$$', '$' + params.length)); }
    if (req.query.from) add('g.date_received >= $$', req.query.from);
    if (req.query.to)   add('g.date_received < $$', req.query.to);
    if (req.query.city_code)  add('g.city_code = $$', req.query.city_code);
    if (req.query.service)    add('g.service = $$', req.query.service);
    if (req.query.rating)     add('g.rating = $$', req.query.rating);
    if (req.query.loss_state) add('g.loss_state = $$', req.query.loss_state);
    if (req.query.employee)   add(EMP_NAME + ' = $$', req.query.employee);
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    // Every breakdown carries the users join, because the Employee filter above
    // is written in terms of u.name and would otherwise be an unknown alias.
    const base = ' FROM geico_surveys g ' + EMP_JOIN + whereSql;
    const totalQ = pool.query('SELECT COUNT(*)::int AS n' + base, params);
    const onTimeQ = pool.query(
      "SELECT " +
      " SUM(CASE WHEN g.arrived_on_time ILIKE 'yes' THEN 1 ELSE 0 END)::int AS on_time, " +
      " SUM(CASE WHEN g.arrived_on_time IS NOT NULL AND g.arrived_on_time <> '' THEN 1 ELSE 0 END)::int AS answered" +
      base, params);
    const ratingQ = pool.query("SELECT COALESCE(NULLIF(g.rating,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const serviceQ = pool.query("SELECT COALESCE(NULLIF(g.service,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const stateQ = pool.query("SELECT COALESCE(NULLIF(g.loss_state,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const cityQ = pool.query(
      "SELECT COALESCE(c.name,'(unmatched)') AS k, COUNT(*)::int AS n, " +
      " SUM(CASE WHEN g.rating ILIKE 'excellent' THEN 1 ELSE 0 END)::int AS excellent, " +
      " SUM(CASE WHEN g.rating IS NOT NULL AND g.rating <> '' THEN 1 ELSE 0 END)::int AS rated, " +
      " SUM(CASE WHEN g.arrived_on_time ILIKE 'yes' THEN 1 ELSE 0 END)::int AS on_time, " +
      " SUM(CASE WHEN g.arrived_on_time IS NOT NULL AND g.arrived_on_time <> '' THEN 1 ELSE 0 END)::int AS answered " +
      "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code " + EMP_JOIN +
      whereSql + " GROUP BY 1 ORDER BY n DESC", params);

    // MAX(g.employee_user_id) is safe as a per-name id: every linked row for one
    // person carries the same user id, and rows that only have raw text carry
    // NULL, which MAX ignores. The client uses it to tell a linked person from a
    // name that is still only text.
    const employeeQ = pool.query(
      "SELECT COALESCE(" + EMP_NAME + ",'(unassigned)') AS k, COUNT(*)::int AS n, " +
      " MAX(g.employee_user_id) AS user_id, " +
      " SUM(CASE WHEN g.rating ILIKE 'excellent' THEN 1 ELSE 0 END)::int AS excellent, " +
      " SUM(CASE WHEN g.rating IS NOT NULL AND g.rating <> '' THEN 1 ELSE 0 END)::int AS rated, " +
      " SUM(CASE WHEN g.arrived_on_time ILIKE 'yes' THEN 1 ELSE 0 END)::int AS on_time, " +
      " SUM(CASE WHEN g.arrived_on_time IS NOT NULL AND g.arrived_on_time <> '' THEN 1 ELSE 0 END)::int AS answered" +
      base + " GROUP BY 1 ORDER BY n DESC", params);

    const [total, onTime, rating, service, state, city, employee] =
      await Promise.all([totalQ, onTimeQ, ratingQ, serviceQ, stateQ, cityQ, employeeQ]);

    res.json({
      total: total.rows[0].n,
      onTime: onTime.rows[0].on_time || 0,
      onTimeAnswered: onTime.rows[0].answered || 0,
      byRating: rating.rows,
      byService: service.rows,
      byState: state.rows,
      byCity: city.rows,
      byEmployee: employee.rows
    });
  } catch (err) {
    console.error('GET /api/geico/stats failed:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// POST /api/geico/run - build/send the weekly report (key-protected)
//   body: { dryRun, startIso, endIso, recipients, mailbox }
router.post('/run', keyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const summary = await runWeeklyReport({
      dryRun: b.dryRun === true, startIso: b.startIso, endIso: b.endIso,
      recipients: Array.isArray(b.recipients) && b.recipients.length ? b.recipients : undefined,
      mailbox: b.mailbox
    });
    res.json({ ok: true, summary: summary });
  } catch (err) {
    console.error('POST /api/geico/run failed:', err);
    res.status(500).json({ error: err.message || 'Failed to run report' });
  }
});

// POST /api/geico/ingest - backfill a date range into the DB (key-protected)
//   body: { startIso, endIso, mailbox }
router.post('/ingest', keyAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.startIso || !b.endIso) return res.status(400).json({ error: 'startIso and endIso are required' });
    const summary = await ingestRange({ startIso: b.startIso, endIso: b.endIso, mailbox: b.mailbox });
    res.json({ ok: true, summary: summary });
  } catch (err) {
    console.error('POST /api/geico/ingest failed:', err);
    res.status(500).json({ error: err.message || 'Failed to ingest' });
  }
});

// PUT /api/geico/assign-employee - credit ONE survey to a real Nova user from
// the dropdown on the survey table (admin/manager).
//   body: { po_number, user_id }   user_id null/empty clears the row.
// A manual pick is stamped employee_source='manual', which the CSV import then
// refuses to overwrite - a human decision outranks a bulk file.
router.put('/assign-employee', adminMgr, async (req, res) => {
  const po = (req.body && req.body.po_number != null) ? String(req.body.po_number).trim() : '';
  if (!po) return res.status(400).json({ error: 'po_number is required' });
  const rawId = req.body ? req.body.user_id : null;
  const userId = (rawId === null || rawId === undefined || rawId === '') ? null : parseInt(rawId, 10);
  if (userId !== null && (isNaN(userId) || userId <= 0)) return res.status(400).json({ error: 'user_id is not valid' });
  try {
    const survey = await pool.query('SELECT id, employee_name, employee_user_id FROM geico_surveys WHERE po_number = $1', [po]);
    if (!survey.rows.length) return res.status(404).json({ error: 'That PO number is not in the survey table.' });
    const before = survey.rows[0];

    if (userId === null) {
      await pool.query(
        'UPDATE geico_surveys SET employee_name = NULL, employee_user_id = NULL, employee_source = NULL, updated_at = NOW() WHERE id = $1',
        [before.id]);
      await logAudit({
        entity_type: 'geico_survey', entity_id: before.id, entity_number: po, action: 'employee_cleared',
        user_id: req.user.id, user_name: req.user.name,
        details: { from: before.employee_name || null, from_user_id: before.employee_user_id || null }
      });
      return res.json({ po_number: po, employee_name: null, employee_user_id: null, employee_source: null });
    }

    const u = await pool.query('SELECT id, name FROM users WHERE id = $1', [userId]);
    if (!u.rows.length) return res.status(400).json({ error: 'That user does not exist.' });
    const name = u.rows[0].name;
    await pool.query(
      "UPDATE geico_surveys SET employee_name = $1, employee_user_id = $2, employee_source = 'manual', updated_at = NOW() WHERE id = $3",
      [name, userId, before.id]);
    await logAudit({
      entity_type: 'geico_survey', entity_id: before.id, entity_number: po, action: 'employee_assigned',
      user_id: req.user.id, user_name: req.user.name,
      details: { to: name, to_user_id: userId, from: before.employee_name || null, from_user_id: before.employee_user_id || null }
    });
    res.json({ po_number: po, employee_name: name, employee_user_id: userId, employee_source: 'manual' });
  } catch (err) {
    console.error('PUT /api/geico/assign-employee failed:', err.message);
    res.status(500).json({ error: 'Failed to assign the employee' });
  }
});

// POST /api/geico/import-employees - reverse import: attach employee names by PO # (admin/manager)
//   body: { rows: [{ po_number, employee_name }] }
// Each imported name is run through the roster matcher, so "Benson, Chris" from
// Geico and a dropdown pick of "Chris Benson" land on the SAME person instead of
// two rows on the leaderboard. A name nobody matches is still stored, as text.
// Rows a human already set by hand are left alone and counted in manualKept.
router.post('/import-employees', adminMgr, async (req, res) => {
  try {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No rows provided' });
    const resolver = await buildEmployeeResolver();
    let updated = 0, skipped = 0, notFound = 0, matched = 0, unmatched = 0, manualKept = 0;
    const notFoundList = [];
    const unmatchedNames = {};
    for (let i = 0; i < rows.length; i++) {
      const po = (rows[i].po_number == null ? '' : String(rows[i].po_number)).trim();
      const emp = (rows[i].employee_name == null ? '' : String(rows[i].employee_name)).trim();
      if (!po || !emp) { skipped++; continue; }
      const existing = await pool.query('SELECT id, employee_source FROM geico_surveys WHERE po_number = $1', [po]);
      if (!existing.rows.length) { notFound++; if (notFoundList.length < 25) notFoundList.push(po); continue; }
      if (existing.rows[0].employee_source === 'manual') { manualKept++; continue; }
      const hit = resolver.resolve(emp);
      if (hit.user_id) matched++; else { unmatched++; unmatchedNames[emp] = 1; }
      const r = await pool.query(
        "UPDATE geico_surveys SET employee_name = $1, employee_user_id = $2, employee_source = 'import', updated_at = NOW() WHERE id = $3",
        [hit.user_id ? hit.name : emp, hit.user_id, existing.rows[0].id]);
      updated += r.rowCount;
    }
    res.json({
      ok: true, updated, skipped, notFound, notFoundList,
      matched, unmatched, manualKept,
      unmatchedNames: Object.keys(unmatchedNames).slice(0, 25)
    });
  } catch (err) {
    console.error('POST /api/geico/import-employees failed:', err);
    res.status(500).json({ error: 'Failed to import employees' });
  }
});

// POST /api/geico/file-complaint - open a Customer Feedback complaint for one
// survey by hand. Poor/Fair surveys file themselves on a schedule
// (jobs/geicoComplaints.js); this is for surveys from before that job was
// switched on, and for the occasional better-rated survey that still needs
// working. The UNIQUE(source, external_ref) index makes a double click harmless
// - it comes back as the existing record.
//   body: { po_number }
router.post('/file-complaint', requireAuth, requirePermission('manage_feedback'), async (req, res) => {
  const po = (req.body && req.body.po_number != null) ? String(req.body.po_number).trim() : '';
  if (!po) return res.status(400).json({ error: 'po_number is required' });
  try {
    const { SURVEY_COLUMNS, fileComplaintForSurvey } = require('../jobs/geicoComplaints');
    const { rows } = await pool.query(SURVEY_COLUMNS + 'WHERE g.po_number = $1 LIMIT 1', [po]);
    if (!rows.length) return res.status(404).json({ error: 'That PO number is not in the survey table.' });
    const result = await fileComplaintForSurvey(rows[0]);
    if (!result || !result.id) return res.status(500).json({ error: 'Could not file the complaint. Check the server log.' });
    res.json({ id: result.id, duplicate: !!result.duplicate, po_number: po });
  } catch (err) {
    console.error('POST /api/geico/file-complaint failed:', err.message);
    res.status(500).json({ error: 'Failed to file complaint: ' + err.message });
  }
});

module.exports = router;
