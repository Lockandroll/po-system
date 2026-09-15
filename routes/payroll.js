// Payroll module API.
//
// Owner-only for now (see requireOwner below). Home of the Compliance Check:
// upload the Pulsar Event-to-Event CSVs + the Paychex journal, run the minimum-
// wage and overtime tests per state, and file the one-page PDF record.
//
// Access model: admin and owner both pass every requirePermission check in this
// app (owner is coerced to admin in middleware/auth.js), so a normal dark-ship
// permission would still let any admin in. Payroll must be OWNER-only for now,
// exactly like the Vault, so every route is gated on req.user.isOwner directly.
// The view_payroll / run_compliance_check / manage_payroll permissions exist in
// ALL_PERMS and have a row in Roles & Access for a future non-owner rollout;
// they are NOT consulted yet. To widen access later, swap requireOwner for
// requirePermission on the relevant routes.
//
// House style: string concatenation only, no template literals.

var express = require('express');
var router = express.Router();
var { pool } = require('../db');
var { requireAuth } = require('../middleware/auth');
var r2 = require('../utils/r2');
var pc = require('../utils/payrollCompliance');
var journal = require('../utils/payrollJournal');
var payrollPdf = require('../utils/payrollPdf');

// Owner-only gate. req.user.isOwner is set in middleware/auth.js and survives
// View-As correctly (an admin previewing an owner does not get isOwner).
function requireOwner(req, res, next) {
  if (!req.user || !req.user.isOwner) {
    return res.status(403).json({ error: 'Payroll is owner-only.' });
  }
  next();
}

router.use(requireAuth, requireOwner);

// ---- helpers -------------------------------------------------------------

function s503(res) { return res.status(503).json({ error: 'File storage is not configured. Add the R2_* variables in Railway.' }); }

// The applied and legal minimum wage for each state, for a given pay-period end.
// dateStr is 'YYYY-MM-DD' (lexicographic compare == chronological). Falls back
// to sensible defaults if the table is empty.
async function thresholdMaps(periodEnd) {
  var applied = { FL: 14, GA: 14, AL: 14 };
  var legal = { FL: 14, GA: 7.25, AL: 7.25 };
  try {
    var r = await pool.query('SELECT state, legal_min, applied_min, next_legal, next_applied, next_effective FROM payroll_thresholds');
    r.rows.forEach(function (row) {
      var st = row.state;
      var eff = row.next_effective ? String(row.next_effective).slice(0, 10) : null;
      var stepped = eff && periodEnd && String(periodEnd).slice(0, 10) >= eff;
      applied[st] = Number(stepped && row.next_applied != null ? row.next_applied : row.applied_min);
      legal[st] = Number(stepped && row.next_legal != null ? row.next_legal : row.legal_min);
    });
  } catch (e) { /* defaults */ }
  return { applied: applied, legal: legal };
}

async function getSetting(key, dflt) {
  try {
    var r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (r.rows.length && r.rows[0].value != null && String(r.rows[0].value).trim() !== '') return r.rows[0].value;
  } catch (e) {}
  return dflt;
}

function safeName(s) { return String(s || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80); }

// ---- thresholds ----------------------------------------------------------

router.get('/thresholds', async function (req, res) {
  try {
    var r = await pool.query('SELECT state, legal_min, applied_min, next_legal, next_applied, next_effective FROM payroll_thresholds ORDER BY state');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to load thresholds' }); }
});

router.put('/thresholds/:state', async function (req, res) {
  var st = String(req.params.state || '').toUpperCase().slice(0, 2);
  var b = req.body || {};
  try {
    await pool.query(
      'UPDATE payroll_thresholds SET applied_min = COALESCE($2, applied_min), legal_min = COALESCE($3, legal_min), ' +
      'next_applied = $4, next_legal = $5, next_effective = $6, updated_at = NOW(), updated_by = $7 WHERE state = $1',
      [st,
        b.applied_min != null ? Number(b.applied_min) : null,
        b.legal_min != null ? Number(b.legal_min) : null,
        b.next_applied != null ? Number(b.next_applied) : null,
        b.next_legal != null ? Number(b.next_legal) : null,
        b.next_effective || null,
        req.user.id]
    );
    var r = await pool.query('SELECT state, legal_min, applied_min, next_legal, next_applied, next_effective FROM payroll_thresholds ORDER BY state');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to save threshold' }); }
});

// ---- uploads -------------------------------------------------------------

// Presign an R2 upload for a CSV or the journal PDF. Browser PUTs the bytes to
// R2 directly, then hands the key back in POST /runs.
router.post('/uploads/url', async function (req, res) {
  if (!r2.configured()) return s503(res);
  var b = req.body || {};
  var kind = b.kind === 'journal' ? 'journal' : 'csv';
  var ct = kind === 'journal' ? 'application/pdf' : (b.contentType || 'text/csv');
  var key = 'payroll/uploads/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '-' + safeName(b.filename || (kind + (kind === 'journal' ? '.pdf' : '.csv')));
  try {
    var url = await r2.presignUpload(key, ct);
    res.json({ key: key, url: url });
  } catch (e) { res.status(500).json({ error: 'Could not presign upload' }); }
});

// ---- runs ----------------------------------------------------------------

// Create a run: parse the CSVs, read the journal for wages, match, and return a
// draft for review. Persists the run (draft) and its lines.
router.post('/runs', async function (req, res) {
  if (!r2.configured()) return s503(res);
  var b = req.body || {};
  var csvKeys = Array.isArray(b.csv_keys) ? b.csv_keys.filter(Boolean) : [];
  var journalKey = b.journal_key || null;
  if (!csvKeys.length) return res.status(400).json({ error: 'Upload at least one Event-to-Event CSV.' });
  if (!journalKey) return res.status(400).json({ error: 'Upload the Paychex payroll journal PDF.' });

  var otMethod = b.ot_method === 'full' ? 'full' : 'half';
  var periodStart = b.period_start || null;
  var periodEnd = b.period_end || null;

  // 1) Pulsar hours
  var texts = [];
  try {
    for (var i = 0; i < csvKeys.length; i++) {
      var buf = await r2.getObjectBuffer(csvKeys[i]);
      texts.push(buf.toString('utf8'));
    }
  } catch (e) { return res.status(400).json({ error: 'Could not read an uploaded CSV from storage.' }); }
  var pulsarRows = pc.parseAllCsvs(texts);
  if (!pulsarRows.length) return res.status(400).json({ error: 'No technician rows found in the CSVs. Check the export.' });

  // 2) Journal wages (AI read)
  var wagesByName = {};
  var journalError = null;
  try {
    var pdfBuf = await r2.getObjectBuffer(journalKey);
    wagesByName = await journal.extractWages(pdfBuf);
  } catch (e) { journalError = e.message || 'Could not read the payroll journal.'; }

  // 3) Match
  var m = pc.matchTechs(pulsarRows, wagesByName);
  var maps = await thresholdMaps(periodEnd);

  // 4) Persist run + lines
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    var runIns = await client.query(
      'INSERT INTO payroll_runs (period_start, period_end, check_date, review_date, ot_method, status, csv_keys, journal_key, created_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [periodStart, periodEnd, b.check_date || null, b.review_date || null, otMethod, 'draft', JSON.stringify(csvKeys), journalKey, req.user.id]
    );
    var runId = runIns.rows[0].id;

    // matched lines
    for (var j = 0; j < m.matched.length; j++) {
      var mt = m.matched[j];
      await client.query(
        'INSERT INTO payroll_run_lines (run_id, tech_name, tech_code, state, threshold, hours, wages, components, match_method, excluded) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)',
        [runId, mt.name, mt.code, mt.state, maps.applied[mt.state] || 14, mt.hours, mt.wages, mt.components, mt.matchMethod]
      );
    }
    // unmatched pulsar techs (hours but no wages found) - shown for review
    for (var k = 0; k < m.unmatchedPulsar.length; k++) {
      var up = m.unmatchedPulsar[k];
      await client.query(
        'INSERT INTO payroll_run_lines (run_id, tech_name, tech_code, state, threshold, hours, wages, components, match_method, excluded) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,false)',
        [runId, up.name, up.code, up.state, maps.applied[up.state] || 14, up.hours, 'No journal match - assign wages or exclude', 'unmatched']
      );
    }
    await client.query('COMMIT');

    res.json({
      run_id: runId,
      journal_error: journalError,
      unmatched_wages: m.unmatchedWages,
      matched_count: m.matched.length,
      unmatched_count: m.unmatchedPulsar.length
    });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to create the run.' });
  } finally {
    client.release();
  }
});

// List runs (the compliance log).
router.get('/runs', async function (req, res) {
  try {
    var r = await pool.query(
      'SELECT id, period_start, period_end, check_date, ot_method, status, status_minwage, status_ot, ' +
      'total_trueup, total_ot, roster_count, lowest_rate, pdf_key, filed_at, created_at ' +
      'FROM payroll_runs ORDER BY period_end DESC NULLS LAST, id DESC LIMIT 200'
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'Failed to load runs' }); }
});

// One run with its lines.
router.get('/runs/:id', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  try {
    var run = await pool.query('SELECT * FROM payroll_runs WHERE id = $1', [id]);
    if (!run.rows.length) return res.status(404).json({ error: 'Run not found' });
    var lines = await pool.query('SELECT * FROM payroll_run_lines WHERE run_id = $1 ORDER BY excluded, effective_rate NULLS LAST, tech_name', [id]);
    res.json({ run: run.rows[0], lines: lines.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load run' }); }
});

// Save the reviewed wages / state / exclusions before compute.
router.put('/runs/:id/wages', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  var lines = Array.isArray((req.body || {}).lines) ? req.body.lines : [];
  var client = await pool.connect();
  try {
    await client.query('BEGIN');
    // refresh thresholds for the run's period in case state changed
    var runR = await client.query('SELECT period_end FROM payroll_runs WHERE id = $1', [id]);
    var periodEnd = runR.rows.length ? runR.rows[0].period_end : null;
    var maps = await thresholdMaps(periodEnd);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var st = ln.state ? String(ln.state).toUpperCase().slice(0, 2) : null;
      await client.query(
        'UPDATE payroll_run_lines SET wages = COALESCE($2, wages), ' +
        'state = COALESCE($3, state), threshold = COALESCE($4, threshold), excluded = COALESCE($5, excluded) ' +
        'WHERE id = $1 AND run_id = $6',
        [ln.id,
          ln.wages != null ? Number(ln.wages) : null,
          st,
          st ? (maps.applied[st] || null) : null,
          (typeof ln.excluded === 'boolean') ? ln.excluded : null,
          id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to save wages' });
  } finally {
    client.release();
  }
});

// Run the minimum-wage and overtime math, persist the results.
router.post('/runs/:id/compute', async function (req, res) {
  var id = parseInt(req.params.id, 10);
  try {
    var runR = await pool.query('SELECT * FROM payroll_runs WHERE id = $1', [id]);
    if (!runR.rows.length) return res.status(404).json({ error: 'Run not found' });
    var run = runR.rows[0];
    var linesR = await pool.query('SELECT * FROM payroll_run_lines WHERE run_id = $1', [id]);
    var maps = await thresholdMaps(run.period_end);

    var input = linesR.rows.map(function (l) {
      return {
        id: l.id, name: l.tech_name, code: l.tech_code, state: l.state,
        hours: Number(l.hours), wages: Number(l.wages), components: l.components,
        threshold: maps.applied[l.state] || Number(l.threshold) || 14,
        excluded: l.excluded
      };
    });
    var result = pc.computeRun(input, run.ot_method, function (ln) { return maps.applied[ln.state] || Number(ln.threshold) || 14; });

    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (var i = 0; i < result.lines.length; i++) {
        var r = result.lines[i];
        await client.query(
          'UPDATE payroll_run_lines SET threshold=$2, effective_rate=$3, trueup=$4, flagged_minwage=$5, ' +
          'ot_hours=$6, reg_rate=$7, ot_premium_half=$8, ot_premium_full=$9, flagged_ot=$10 WHERE id=$1',
          [r.id, r.threshold, r.effective_rate, r.trueup, r.flagged_minwage, r.ot_hours, r.reg_rate, r.ot_premium_half, r.ot_premium_full, r.flagged_ot]
        );
      }
      await client.query(
        'UPDATE payroll_runs SET status=$2, status_minwage=$3, status_ot=$4, total_trueup=$5, total_ot=$6, ' +
        'roster_count=$7, lowest_rate=$8 WHERE id=$1',
        [id, 'computed', result.status_minwage, result.status_ot, result.total_trueup, result.total_ot, result.roster_count, result.lowest_rate]
      );
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }

    res.json({ run_id: id, result: result, thresholds: maps });
  } catch (e) { res.status(500).json({ error: 'Failed to compute' }); }
});

// Generate and file the one-page PDF record.
router.post('/runs/:id/file', async function (req, res) {
  if (!r2.configured()) return s503(res);
  var id = parseInt(req.params.id, 10);
  try {
    var runR = await pool.query('SELECT * FROM payroll_runs WHERE id = $1', [id]);
    if (!runR.rows.length) return res.status(404).json({ error: 'Run not found' });
    var run = runR.rows[0];
    if (run.status === 'draft') return res.status(400).json({ error: 'Compute the run before filing.' });

    var linesR = await pool.query(
      'SELECT * FROM payroll_run_lines WHERE run_id = $1 AND excluded = false ORDER BY effective_rate NULLS LAST, tech_name', [id]
    );
    var maps = await thresholdMaps(run.period_end);
    var lines = linesR.rows.map(function (l) {
      return {
        name: l.tech_name, code: l.tech_code, state: l.state,
        hours: Number(l.hours), wages: Number(l.wages), threshold: Number(l.threshold),
        effective_rate: Number(l.effective_rate), trueup: Number(l.trueup), flagged_minwage: l.flagged_minwage,
        ot_hours: Number(l.ot_hours), reg_rate: Number(l.reg_rate),
        ot_premium: run.ot_method === 'full' ? Number(l.ot_premium_full) : Number(l.ot_premium_half),
        flagged_ot: l.flagged_ot
      };
    });
    var runForPdf = {
      period_start: run.period_start, period_end: run.period_end, check_date: run.check_date, review_date: run.review_date,
      ot_method: run.ot_method, status_minwage: run.status_minwage, status_ot: run.status_ot,
      total_trueup: Number(run.total_trueup), total_ot: Number(run.total_ot), roster_count: run.roster_count,
      lowest_rate: Number(run.lowest_rate),
      minwage_violations: lines.filter(function (l) { return l.flagged_minwage; }).length,
      ot_count: lines.filter(function (l) { return l.flagged_ot; }).length
    };
    var thresholds = {};
    ['FL', 'GA', 'AL'].forEach(function (s) { thresholds[s] = { applied: maps.applied[s], legal: maps.legal[s] }; });

    var opts = {
      entity: await getSetting('payroll_entity', 'Lock and Roll LLC'),
      fein: await getSetting('payroll_fein', 'on file'),
      methodology: await getSetting('payroll_methodology', null),
      thresholds: thresholds
    };

    var buf = await payrollPdf.generate(runForPdf, lines, opts);
    var key = 'payroll/records/LAR_Compliance_' + String(run.period_start || '').slice(0, 10) + '_to_' + String(run.period_end || '').slice(0, 10) + '_run' + id + '.pdf';
    await r2.putObject(key, buf, 'application/pdf');
    await pool.query('UPDATE payroll_runs SET pdf_key=$2, status=$3, filed_at=NOW() WHERE id=$1', [id, key, 'filed']);
    res.json({ ok: true, pdf_key: key });
  } catch (e) { res.status(500).json({ error: 'Failed to file the record: ' + (e.message || 'unknown') }); }
});

// Presigned link to the filed PDF.
router.get('/runs/:id/pdf', async function (req, res) {
  if (!r2.configured()) return s503(res);
  var id = parseInt(req.params.id, 10);
  try {
    var r = await pool.query('SELECT pdf_key, period_start, period_end FROM payroll_runs WHERE id = $1', [id]);
    if (!r.rows.length || !r.rows[0].pdf_key) return res.status(404).json({ error: 'No filed record yet' });
    var fname = 'LAR_Compliance_' + String(r.rows[0].period_start || '').slice(0, 10) + '_to_' + String(r.rows[0].period_end || '').slice(0, 10) + '.pdf';
    var url = await r2.presignDownload(r.rows[0].pdf_key, fname, req.query.inline === '1', 300, 'application/pdf');
    res.json({ url: url });
  } catch (e) { res.status(500).json({ error: 'Failed to get record link' }); }
});

module.exports = router;
