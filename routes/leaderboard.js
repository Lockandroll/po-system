/*
 * Weekly leaderboards - the two Home-screen cards and the screen that feeds them.
 *
 *   GET  /api/leaderboard/home        every signed-in user: the two top-5 cards
 *   GET  /api/leaderboard             manage: every week uploaded, both metrics
 *   GET  /api/leaderboard/week/:id    manage: one week in full, plus the roster
 *   POST /api/leaderboard/preview     manage: read a sheet, guess its columns
 *   POST /api/leaderboard/import      manage: commit one week from that sheet
 *   POST /api/leaderboard/entry/:id   manage: link an unmatched name to a person
 *   DELETE /api/leaderboard/week/:id  manage: remove a week
 *
 * Two decisions worth knowing about:
 *
 * 1. /home is gated by requireAuth ONLY. These boards are recognition, the same
 *    as Recent Wins, and everybody is meant to see who won the week. Nothing
 *    private is derivable from them: they carry names and one number each, both
 *    of which came off a sheet a manager chose to publish.
 *
 * 2. preview and import each parse the file themselves, from the bytes the
 *    browser holds. The browser never sends numbers - only the columns a human
 *    picked. So what lands in the table is always what the FILE said, and a
 *    tampered-with or mis-edited preview cannot change a single figure.
 *
 * House style: string concatenation only, no template literals.
 */
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const LB = require('../utils/leaderboard');

const router = express.Router();
const manage = [requireAuth, requirePermission('manage_leaderboard')];

// A weekly roster sheet is a few hundred rows. Anything past these is either a
// mistake or the wrong file, and both are better refused than half-imported.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 5000;
const HOME_TOP = 5;

function bad(res, msg) { return res.status(400).json({ error: msg }); }

// The choices a human confirmed on the upload screen, defaulted from what Nova
// guessed. Written once and used by BOTH /preview and /import so the preview
// can never be produced by different rules than the import that follows it.
function chosen(b, a) {
  function pick(sent, fallback) {
    return (sent === undefined || sent === null || sent === '') ? fallback : parseInt(sent, 10);
  }
  var mode = (b.mode === 'count' || b.mode === 'sum') ? b.mode : a.mode;
  var sentCols = b.value_cols !== undefined ? b.value_cols : b.value_col;
  var statuses = b.status_values;
  if (statuses === undefined || statuses === null || statuses === '') statuses = a.suggestion.status_values;
  if (!Array.isArray(statuses)) statuses = String(statuses).split('|');
  return {
    mode: mode,
    header_row: pick(b.header_row, a.header_row),
    name_col: pick(b.name_col, a.suggestion.name),
    city_col: pick(b.city_col, a.suggestion.city),
    value_cols: (sentCols === undefined || sentCols === null || sentCols === '')
      ? a.suggestion.values : LB.valueColList(sentCols),
    match_col: pick(b.match_col, a.suggestion.match_col),
    match_text: b.match_text === undefined || b.match_text === null
      ? a.suggestion.match_text : String(b.match_text).trim().slice(0, 120),
    status_col: pick(b.status_col, a.suggestion.status_col),
    status_values: statuses.map(function (x) { return String(x).trim(); }).filter(Boolean)
  };
}

function ymd(v) {
  var s = String(v == null ? '' : v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// The browser sends the file as base64 (a data: URL's tail is accepted too).
// It never passes through R2: the sheet is read, turned into rows and thrown
// away - Nova keeps the numbers, not the spreadsheet.
function decodeFile(b64) {
  var s = String(b64 == null ? '' : b64);
  var comma = s.indexOf(',');
  if (s.slice(0, 5) === 'data:' && comma !== -1) s = s.slice(comma + 1);
  s = s.replace(/\s+/g, '');
  if (!s) { var e = new Error('No file was attached.'); e.userFacing = true; throw e; }
  var buf = Buffer.from(s, 'base64');
  if (!buf.length) { var e2 = new Error('That file came through empty.'); e2.userFacing = true; throw e2; }
  if (buf.length > MAX_BYTES) {
    var e3 = new Error('That file is larger than 8 MB. Trim it to the columns you need and try again.');
    e3.userFacing = true;
    throw e3;
  }
  return buf;
}

function fail(res, err, fallback) {
  if (err && err.userFacing) return res.status(400).json({ error: err.message });
  console.error('[leaderboard] ' + fallback + ':', err && err.message);
  return res.status(500).json({ error: fallback });
}

// Pick the sheet the caller asked for, or the first one with anything in it.
function pickSheet(book, wanted) {
  var sheets = book.sheets || [];
  if (wanted) {
    for (var i = 0; i < sheets.length; i++) if (sheets[i].name === wanted) return sheets[i];
  }
  for (var j = 0; j < sheets.length; j++) if ((sheets[j].grid || []).length > 1) return sheets[j];
  return sheets[0] || null;
}

async function roster() {
  const r = await pool.query(
    'SELECT id, name, pulsar_name, nickname, active, home_city FROM users ORDER BY name'
  );
  return r.rows;
}

/* ------------------------------------------------------------ the cards --- */

// One metric's latest published week, with the top N. Returns null when nobody
// has uploaded that metric yet, so the card can stay off the Home screen
// entirely rather than showing an empty box.
async function latestBoard(metric, meId, limit) {
  const w = await pool.query(
    'SELECT id, metric, week_start::text AS week_start, row_count, updated_at ' +
    'FROM leaderboard_weeks WHERE metric = $1 ORDER BY week_start DESC LIMIT 1', [metric]
  );
  if (!w.rows.length) return null;
  const week = w.rows[0];
  const e = await pool.query(
    'SELECT e.id, e.rank, e.user_id, e.raw_name, e.value, e.city_code, u.name AS user_name ' +
    'FROM leaderboard_entries e LEFT JOIN users u ON u.id = e.user_id ' +
    'WHERE e.week_id = $1 ORDER BY e.rank ASC LIMIT $2', [week.id, limit]
  );
  return {
    week_id: week.id,
    week_start: week.week_start,
    week_label: LB.weekLabel(week.week_start),
    row_count: week.row_count,
    updated_at: week.updated_at,
    top: e.rows.map(function (r) {
      return {
        rank: r.rank,
        // A linked row shows the person's CURRENT name; an unlinked one shows
        // exactly what the sheet said, because that is all Nova knows.
        name: r.user_name || r.raw_name,
        user_id: r.user_id,
        is_me: r.user_id != null && r.user_id === meId,
        value: Number(r.value),
        city_code: r.city_code || null
      };
    })
  };
}

router.get('/home', requireAuth, async function (req, res) {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || HOME_TOP, 20);
    const revenue = await latestBoard('revenue', req.user.id, limit);
    const batteries = await latestBoard('batteries', req.user.id, limit);
    res.json({ revenue: revenue, batteries: batteries });
  } catch (e) {
    // Same posture as /employee-records/wins: a Home-screen card is never worth
    // an error across somebody's whole dashboard.
    console.error('[leaderboard] home failed:', e.message);
    res.json({ revenue: null, batteries: null });
  }
});

/* ------------------------------------------------------ the admin screen -- */

router.get('/', manage, async function (req, res) {
  try {
    const r = await pool.query(
      'SELECT w.id, w.metric, w.week_start::text AS week_start, w.file_name, w.row_count, ' +
      '       w.matched_count, w.total_value, w.uploaded_by_name, w.created_at, w.updated_at, ' +
      '       (SELECT COALESCE(u.name, e.raw_name) FROM leaderboard_entries e ' +
      '          LEFT JOIN users u ON u.id = e.user_id ' +
      '         WHERE e.week_id = w.id ORDER BY e.rank ASC LIMIT 1) AS leader ' +
      'FROM leaderboard_weeks w ORDER BY w.week_start DESC, w.metric ASC LIMIT 200'
    );
    res.json({
      weeks: r.rows.map(function (w) {
        return {
          id: w.id, metric: w.metric, week_start: w.week_start, week_label: LB.weekLabel(w.week_start),
          file_name: w.file_name, row_count: w.row_count, matched_count: w.matched_count,
          total_value: Number(w.total_value), leader: w.leader,
          uploaded_by_name: w.uploaded_by_name, created_at: w.created_at, updated_at: w.updated_at
        };
      }),
      default_week: LB.lastMonday(),
      metrics: Object.keys(LB.METRICS).map(function (k) {
        return { key: k, label: LB.METRICS[k].label, unit: LB.METRICS[k].unit };
      })
    });
  } catch (e) { return fail(res, e, 'Failed to load leaderboards'); }
});

router.get('/week/:id', manage, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return bad(res, 'Which week?');
    const w = await pool.query(
      'SELECT id, metric, week_start::text AS week_start, file_name, sheet_name, name_column, ' +
      '       value_column, city_column, mode, match_column, match_text, status_column, ' +
      '       status_values, row_count, matched_count, total_value, uploaded_by_name, ' +
      '       created_at, updated_at FROM leaderboard_weeks WHERE id = $1', [id]
    );
    if (!w.rows.length) return res.status(404).json({ error: 'That week is not here.' });
    const e = await pool.query(
      'SELECT e.id, e.rank, e.user_id, e.raw_name, e.match_tier, e.value, e.city_code, u.name AS user_name ' +
      'FROM leaderboard_entries e LEFT JOIN users u ON u.id = e.user_id ' +
      'WHERE e.week_id = $1 ORDER BY e.rank ASC', [id]
    );
    const people = await pool.query(
      'SELECT id, name, home_city FROM users WHERE active IS NOT FALSE ORDER BY name'
    );
    const week = w.rows[0];
    res.json({
      week: Object.assign({}, week, { week_label: LB.weekLabel(week.week_start), total_value: Number(week.total_value) }),
      entries: e.rows.map(function (r) {
        return {
          id: r.id, rank: r.rank, user_id: r.user_id, raw_name: r.raw_name,
          name: r.user_name || r.raw_name, matched: r.user_id != null, match_tier: r.match_tier,
          value: Number(r.value), city_code: r.city_code || null
        };
      }),
      roster: people.rows
    });
  } catch (e) { return fail(res, e, 'Failed to load that week'); }
});

/* ------------------------------------------------------------- the read --- */

// Read the file and say what Nova THINKS the columns are. Stores nothing.
router.post('/preview', manage, async function (req, res) {
  try {
    const b = req.body || {};
    const metric = String(b.metric || 'revenue');
    if (!LB.isMetric(metric)) return bad(res, 'Unknown board.');
    const buf = decodeFile(b.file_base64);
    const book = await LB.readWorkbook(buf, b.filename || 'upload.xlsx');
    const sheet = pickSheet(book, b.sheet);
    if (!sheet || !(sheet.grid || []).length) return bad(res, 'That sheet is empty.');

    // A sheet the caller has already confirmed columns on re-analyses with
    // those columns, so the preview and the import agree row for row.
    // Revenue is a SET of columns summed (a Pulsar export splits the money four
    // ways). Batteries is a COUNT of rows matching a rule, because there is no
    // battery-quantity column to add.
    const a = LB.analyzeSheet(sheet.grid, metric, b.mode);
    const c = chosen(b, a);
    const ready = c.name_col >= 0 &&
      (c.mode === 'count' ? (c.match_col >= 0 && !!c.match_text) : c.value_cols.length > 0);

    var rows = [], skipped = { no_name: 0, no_value: 0, total_row: 0, no_match: 0, wrong_status: 0 }, resolved = [];
    if (ready) {
      const x = LB.extractRows(sheet.grid, {
        header_row: c.header_row, name_col: c.name_col, city_col: c.city_col, mode: c.mode,
        value_cols: c.value_cols, match_col: c.match_col, match_text: c.match_text,
        status_col: c.status_col, status_values: c.status_values
      });
      rows = x.rows; skipped = x.skipped;
      const resolver = LB.buildResolver(await roster());
      resolved = rows.slice(0, 25).map(function (r, i) {
        const hit = resolver.resolve(r.raw_name);
        return {
          rank: i + 1, raw_name: r.raw_name, value: r.value, city_code: r.city_code || null,
          lines: r.lines, user_id: hit.user_id, matched_name: hit.name, match_tier: hit.tier
        };
      });
    }

    res.json({
      sheets: (book.sheets || []).map(function (s) { return s.name; }),
      sheet: sheet.name,
      header_row: c.header_row,
      mode: c.mode,
      columns: a.columns,
      status_options: a.status_options || [],
      suggestion: {
        name: c.name_col, values: c.value_cols, city: c.city_col,
        match_col: c.match_col, match_text: c.match_text,
        status_col: c.status_col, status_values: c.status_values
      },
      auto: a.suggestion,
      preset_used: a.preset_used === true,
      confident: a.confident,
      preview: a.preview,
      rows_found: rows.length,
      unmatched: resolved.filter(function (r) { return !r.user_id; }).length,
      skipped: skipped,
      resolved: resolved
    });
  } catch (e) { return fail(res, e, 'Could not read that file'); }
});

/* ----------------------------------------------------------- the commit --- */

router.post('/import', manage, async function (req, res) {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const metric = String(b.metric || '');
    if (!LB.isMetric(metric)) return bad(res, 'Pick which board this file is for.');
    const week = ymd(b.week_start);
    if (!week) return bad(res, 'Pick the week this file covers.');

    const buf = decodeFile(b.file_base64);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const book = await LB.readWorkbook(buf, b.filename || 'upload.xlsx');
    const sheet = pickSheet(book, b.sheet);
    if (!sheet) return bad(res, 'That workbook has no sheets in it.');

    const a = LB.analyzeSheet(sheet.grid, metric, b.mode);
    const c = chosen(b, a);
    if (!(c.name_col >= 0)) return bad(res, 'Tell Nova which column holds the name.');
    if (c.mode === 'count') {
      if (!(c.match_col >= 0)) return bad(res, 'Tell Nova which column says what the call was.');
      if (!c.match_text) return bad(res, 'Tell Nova what that column has to contain, for example batt.');
      if (c.match_col === c.name_col) return bad(res, 'The name column cannot also be the one being matched.');
    } else {
      if (!c.value_cols.length) return bad(res, 'Tick at least one column for the number.');
      if (c.value_cols.indexOf(c.name_col) !== -1) return bad(res, 'The name column cannot also be one of the number columns.');
    }

    const x = LB.extractRows(sheet.grid, {
      header_row: c.header_row, name_col: c.name_col, city_col: c.city_col, mode: c.mode,
      value_cols: c.value_cols, match_col: c.match_col, match_text: c.match_text,
      status_col: c.status_col, status_values: c.status_values
    });
    if (!x.rows.length) {
      return bad(res, 'Nothing readable came out of that sheet. Check the header row and the columns you ticked.');
    }
    if (x.rows.length > MAX_ROWS) return bad(res, 'That sheet has more rows than a weekly board should. Check the file.');

    const resolver = LB.buildResolver(await roster());
    const rows = x.rows.map(function (r, i) {
      const hit = resolver.resolve(r.raw_name);
      return {
        rank: i + 1, raw_name: r.raw_name.slice(0, 255), value: r.value,
        city_code: (r.city_code || '').slice(0, 40) || null,
        user_id: hit.user_id, match_tier: hit.tier
      };
    });
    const matched = rows.filter(function (r) { return r.user_id != null; }).length;
    const total = rows.reduce(function (s, r) { return s + r.value; }, 0);

    const headers = a.columns;
    function headerOf(i) {
      for (var k = 0; k < headers.length; k++) if (headers[k].index === i) return headers[k].header;
      return null;
    }
    // What the week detail screen shows so somebody can see, months later,
    // exactly how this board was built.
    const valueLabel = (c.mode === 'count'
      ? ('rows where ' + (headerOf(c.match_col) || 'the matched column') + ' contains "' + c.match_text + '"' +
         (c.status_values.length ? (', ' + (headerOf(c.status_col) || 'status') + ' = ' + c.status_values.join(' / ')) : ''))
      : c.value_cols.map(headerOf).filter(Boolean).join(' + ')).slice(0, 500);

    await client.query('BEGIN');
    // Re-uploading a week REPLACES it. Uploading the wrong file is the likeliest
    // mistake on this screen and the fix has to be "upload the right one".
    const existing = await client.query(
      'SELECT id FROM leaderboard_weeks WHERE metric = $1 AND week_start = $2 FOR UPDATE', [metric, week]
    );
    var weekId;
    var replaced = false;
    if (existing.rows.length) {
      weekId = existing.rows[0].id;
      replaced = true;
      await client.query('DELETE FROM leaderboard_entries WHERE week_id = $1', [weekId]);
      await client.query(
        'UPDATE leaderboard_weeks SET file_name=$2, file_hash=$3, sheet_name=$4, name_column=$5, ' +
        'value_column=$6, city_column=$7, row_count=$8, matched_count=$9, total_value=$10, ' +
        'uploaded_by=$11, uploaded_by_name=$12, mode=$13, match_column=$14, match_text=$15, ' +
        'status_column=$16, status_values=$17, updated_at=NOW() WHERE id=$1',
        [weekId, String(b.filename || '').slice(0, 255), hash, sheet.name, headerOf(c.name_col),
         valueLabel, c.city_col >= 0 ? headerOf(c.city_col) : null, rows.length, matched,
         total, req.user.id, req.user.name, c.mode,
         c.mode === 'count' ? headerOf(c.match_col) : null,
         c.mode === 'count' ? c.match_text : null,
         c.mode === 'count' && c.status_col >= 0 ? headerOf(c.status_col) : null,
         c.mode === 'count' && c.status_values.length ? c.status_values.join('|') : null]
      );
    } else {
      const ins = await client.query(
        'INSERT INTO leaderboard_weeks (metric, week_start, file_name, file_hash, sheet_name, ' +
        'name_column, value_column, city_column, row_count, matched_count, total_value, ' +
        'uploaded_by, uploaded_by_name, mode, match_column, match_text, status_column, status_values) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id',
        [metric, week, String(b.filename || '').slice(0, 255), hash, sheet.name, headerOf(c.name_col),
         valueLabel, c.city_col >= 0 ? headerOf(c.city_col) : null, rows.length, matched,
         total, req.user.id, req.user.name, c.mode,
         c.mode === 'count' ? headerOf(c.match_col) : null,
         c.mode === 'count' ? c.match_text : null,
         c.mode === 'count' && c.status_col >= 0 ? headerOf(c.status_col) : null,
         c.mode === 'count' && c.status_values.length ? c.status_values.join('|') : null]
      );
      weekId = ins.rows[0].id;
    }

    for (var i = 0; i < rows.length; i++) {
      const r = rows[i];
      await client.query(
        'INSERT INTO leaderboard_entries (week_id, rank, user_id, raw_name, match_tier, value, city_code) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [weekId, r.rank, r.user_id, r.raw_name, r.match_tier, r.value, r.city_code]
      );
    }
    await client.query('COMMIT');

    await logAudit({
      entity_type: 'leaderboard', entity_id: weekId, entity_number: metric + ' ' + week,
      action: replaced ? 'edited' : 'created', user_id: req.user.id, user_name: req.user.name,
      details: { metric: metric, week_start: week, rows: rows.length, matched: matched,
                 file: String(b.filename || ''), rule: valueLabel, replaced: replaced },
      ip: req.ip
    });

    res.json({
      ok: true, week_id: weekId, replaced: replaced, rows: rows.length, matched: matched,
      unmatched: rows.length - matched, skipped: x.skipped
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return fail(res, e, 'Could not import that file');
  } finally {
    client.release();
  }
});

/* --------------------------------------------------- fixing a bad match --- */

/*
 * Point one row at a person (or unlink it). If another row in the same week is
 * ALREADY that person - "C. Benson" and "Benson, Chris" on the same sheet - the
 * two are merged and the board re-ranked, because otherwise linking a name is
 * how somebody ends up on the board twice with half their number each.
 */
router.post('/entry/:id', manage, async function (req, res) {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return bad(res, 'Which row?');
    const raw = (req.body || {}).user_id;
    const userId = (raw === null || raw === undefined || raw === '') ? null : parseInt(raw, 10);
    if (raw !== null && raw !== undefined && raw !== '' && !userId) return bad(res, 'That is not a person Nova knows.');

    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT e.id, e.week_id, e.raw_name, e.value FROM leaderboard_entries e WHERE e.id = $1 FOR UPDATE', [id]
    );
    if (!cur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'That row is not here.' }); }
    const row = cur.rows[0];

    if (userId) {
      const u = await client.query('SELECT id, name FROM users WHERE id = $1', [userId]);
      if (!u.rows.length) { await client.query('ROLLBACK'); return bad(res, 'That is not a person Nova knows.'); }
      const twin = await client.query(
        'SELECT id, value FROM leaderboard_entries WHERE week_id = $1 AND user_id = $2 AND id <> $3 ORDER BY id ASC',
        [row.week_id, userId, row.id]
      );
      if (twin.rows.length) {
        var merged = Number(row.value);
        for (var i = 0; i < twin.rows.length; i++) merged += Number(twin.rows[i].value);
        await client.query('DELETE FROM leaderboard_entries WHERE id = ANY($1::int[])',
          [twin.rows.map(function (t) { return t.id; })]);
        await client.query('UPDATE leaderboard_entries SET user_id=$2, match_tier=0, value=$3 WHERE id=$1',
          [row.id, userId, merged]);
      } else {
        // match_tier 0 means "a human said so", which outranks every guess the
        // importer can make.
        await client.query('UPDATE leaderboard_entries SET user_id=$2, match_tier=0 WHERE id=$1', [row.id, userId]);
      }
    } else {
      await client.query('UPDATE leaderboard_entries SET user_id=NULL, match_tier=NULL WHERE id=$1', [row.id]);
    }

    await rerank(client, row.week_id);
    await client.query('COMMIT');

    await logAudit({
      entity_type: 'leaderboard', entity_id: row.week_id, action: 'edited',
      user_id: req.user.id, user_name: req.user.name,
      details: { linked_row: row.raw_name, to_user_id: userId }, ip: req.ip
    });
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return fail(res, e, 'Could not update that row');
  } finally {
    client.release();
  }
});

// Rank is stored, not computed at read time, so the Home card is one ordered
// read. Anything that changes a value has to put the order back.
async function rerank(client, weekId) {
  const r = await client.query(
    'SELECT e.id, e.value, COALESCE(u.name, e.raw_name) AS label FROM leaderboard_entries e ' +
    'LEFT JOIN users u ON u.id = e.user_id WHERE e.week_id = $1', [weekId]
  );
  const rows = r.rows.slice().sort(function (a, b) {
    const av = Number(a.value), bv = Number(b.value);
    if (bv !== av) return bv - av;
    return String(a.label).localeCompare(String(b.label));
  });
  for (var i = 0; i < rows.length; i++) {
    await client.query('UPDATE leaderboard_entries SET rank = $2 WHERE id = $1', [rows[i].id, i + 1]);
  }
  const agg = await client.query(
    'SELECT COUNT(*)::int AS n, COUNT(user_id)::int AS matched, COALESCE(SUM(value),0) AS total ' +
    'FROM leaderboard_entries WHERE week_id = $1', [weekId]
  );
  await client.query(
    'UPDATE leaderboard_weeks SET row_count=$2, matched_count=$3, total_value=$4, updated_at=NOW() WHERE id=$1',
    [weekId, agg.rows[0].n, agg.rows[0].matched, agg.rows[0].total]
  );
}

router.delete('/week/:id', manage, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return bad(res, 'Which week?');
    const r = await pool.query(
      'DELETE FROM leaderboard_weeks WHERE id = $1 RETURNING metric, week_start::text AS week_start', [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'That week is not here.' });
    await logAudit({
      entity_type: 'leaderboard', entity_id: id,
      entity_number: r.rows[0].metric + ' ' + r.rows[0].week_start, action: 'deleted',
      user_id: req.user.id, user_name: req.user.name, details: r.rows[0], ip: req.ip
    });
    res.json({ ok: true });
  } catch (e) { return fail(res, e, 'Could not remove that week'); }
});

module.exports = router;
module.exports.rerank = rerank;
