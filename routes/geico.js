const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { runWeeklyReport, ingestRange } = require('../jobs/geicoIngest');

const adminMgr = [requireAuth, requireRole('admin', 'manager')];

// Shared-secret guard for the action endpoints (so they can be curl-tested
// without a logged-in session). Header: x-report-key: <REPORT_API_KEY>
function keyAuth(req, res, next) {
  const expected = process.env.REPORT_API_KEY;
  if (!expected) return res.status(500).json({ error: 'REPORT_API_KEY is not configured' });
  if (req.headers['x-report-key'] !== expected) return res.status(401).json({ error: 'Invalid or missing report key' });
  next();
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

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const offset = parseInt(req.query.offset, 10) || 0;

    const sql =
      "SELECT g.id, to_char(g.date_received,'YYYY-MM-DD') AS date_received, g.account_number, " +
      "       g.city_code, COALESCE(c.name,'') AS city_name, g.po_number, g.service, g.loss_state, " +
      "       to_char(g.date_of_dispatch,'MM/DD/YYYY') AS date_of_dispatch, g.arrived_on_time, " +
      "       g.time_to_arrive, g.rating " +
      "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code " +
      whereSql + " ORDER BY g.date_received DESC, c.name ASC NULLS LAST " +
      "LIMIT " + limit + " OFFSET " + offset;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/geico failed:', err);
    res.status(500).json({ error: 'Failed to load surveys' });
  }
});

// GET /api/geico/stats - summary breakdowns (admin/manager)
router.get('/stats', adminMgr, async (req, res) => {
  try {
    const where = [];
    const params = [];
    function add(cond, val) { params.push(val); where.push(cond.replace('$$', '$' + params.length)); }
    if (req.query.from) add('date_received >= $$', req.query.from);
    if (req.query.to)   add('date_received < $$', req.query.to);
    if (req.query.city_code)  add('city_code = $$', req.query.city_code);
    if (req.query.service)    add('service = $$', req.query.service);
    if (req.query.rating)     add('rating = $$', req.query.rating);
    if (req.query.loss_state) add('loss_state = $$', req.query.loss_state);
    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const base = ' FROM geico_surveys g ' + whereSql;
    const totalQ = pool.query('SELECT COUNT(*)::int AS n' + base, params);
    const onTimeQ = pool.query(
      "SELECT " +
      " SUM(CASE WHEN arrived_on_time ILIKE 'yes' THEN 1 ELSE 0 END)::int AS on_time, " +
      " SUM(CASE WHEN arrived_on_time IS NOT NULL AND arrived_on_time <> '' THEN 1 ELSE 0 END)::int AS answered" +
      base, params);
    const ratingQ = pool.query("SELECT COALESCE(NULLIF(g.rating,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const serviceQ = pool.query("SELECT COALESCE(NULLIF(g.service,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const stateQ = pool.query("SELECT COALESCE(NULLIF(g.loss_state,''),'(none)') AS k, COUNT(*)::int AS n" + base + " GROUP BY 1 ORDER BY n DESC", params);
    const cityQ = pool.query(
      "SELECT COALESCE(c.name,'(unmatched)') AS k, COUNT(*)::int AS n " +
      "FROM geico_surveys g LEFT JOIN cities c ON c.code = g.city_code " +
      whereSql + " GROUP BY 1 ORDER BY n DESC", params);

    const [total, onTime, rating, service, state, city] =
      await Promise.all([totalQ, onTimeQ, ratingQ, serviceQ, stateQ, cityQ]);

    res.json({
      total: total.rows[0].n,
      onTime: onTime.rows[0].on_time || 0,
      onTimeAnswered: onTime.rows[0].answered || 0,
      byRating: rating.rows,
      byService: service.rows,
      byState: state.rows,
      byCity: city.rows
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

module.exports = router;
