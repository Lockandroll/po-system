// ---------------------------------------------------------------------------
// One-time back-out of the uniform PTO grant that was added to everyone.
//
// When PTO launched, every employee was given the SAME amount of PTO. This
// script reverses those grant lines: for each matched ledger row it posts a
// compensating 'reversal' line and lowers that person's cached balance by the
// same amount. It NEVER deletes anything (the ledger is append-only) and it is
// idempotent — running it twice will not double-reverse.
//
// SAFETY: it is DRY-RUN by default. It changes NOTHING until you add --commit.
//
// Run it INSIDE Railway (so it uses the same database as the app):
//   Railway service shell:   node scripts/backout_pto_grant.js            (dry run)
//                            node scripts/backout_pto_grant.js --commit   (apply)
//   Or from your machine:    railway run node scripts/backout_pto_grant.js
//
// Tune what counts as "the grant" with env vars (confirm against the dry-run's
// "All ledger lines dated ..." summary FIRST):
//   GRANT_DATE=2026-07-01     the entry_date the grant was posted on (default 2026-07-01)
//   GRANT_KINDS=adjustment,award   ledger kinds to treat as the grant (default)
//   GRANT_AMOUNT=40           only reverse rows with exactly this many hours (optional, most surgical)
//   FLOOR_AT_ZERO=1           don't let anyone's balance go below 0 (default: full reversal, may go negative)
//
// No backticks in this file.
// ---------------------------------------------------------------------------
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({
  connectionString: url,
  ssl: url.indexOf('railway.internal') !== -1 ? false : { rejectUnauthorized: false }
});

const GRANT_DATE = process.env.GRANT_DATE || '2026-07-01';
const MATCH_KINDS = (process.env.GRANT_KINDS || 'adjustment,award').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const MATCH_AMOUNT = (process.env.GRANT_AMOUNT !== undefined && process.env.GRANT_AMOUNT !== '') ? Number(process.env.GRANT_AMOUNT) : null;
const FLOOR_AT_ZERO = process.env.FLOOR_AT_ZERO === '1' || process.env.FLOOR_AT_ZERO === 'true';
const COMMIT = process.argv.indexOf('--commit') !== -1;
const TAG = 'Back-out of uniform PTO grant ' + GRANT_DATE;

function fmt(h) { var n = Number(h) || 0; return n.toFixed(2) + 'h (' + (n / 8).toFixed(2) + 'd)'; }

async function main() {
  if (!url) { console.error('DATABASE_URL is not set. Set it first, then run this again.'); process.exit(1); }

  // --scan: read-only. Prints every (date, type, amount) and how many people got it,
  // so a uniform grant stands out as one row that lots of people share. Changes nothing.
  if (process.argv.indexOf('--scan') !== -1) {
    const scan = await pool.query(
      "SELECT to_char(entry_date,'YYYY-MM-DD') AS d, kind, amount_hours, COUNT(*)::int AS people " +
      'FROM pto_ledger GROUP BY d, kind, amount_hours ORDER BY people DESC, d LIMIT 40'
    );
    console.log('=== Ledger scan: (date, type, amount) and how many people got it ===');
    console.log('The uniform grant is the row where LOTS of people got the exact same amount.');
    console.log('');
    scan.rows.forEach(function (r) {
      console.log('  ' + r.d + '   ' + String(r.kind).padEnd(11) + fmt(r.amount_hours).padEnd(20) + r.people + ' people');
    });
    await pool.end();
    return;
  }

  const ALL_DATES = (!GRANT_DATE || String(GRANT_DATE).toLowerCase() === 'all');

  console.log('Mode: ' + (COMMIT ? 'COMMIT (will write changes)' : 'DRY RUN (no changes)'));
  console.log('Target: ' + (ALL_DATES ? 'ALL dates' : ('date ' + GRANT_DATE)) + '   kinds: ' + MATCH_KINDS.join(', ') + (MATCH_AMOUNT !== null ? ('   amount filter: ' + MATCH_AMOUNT + 'h') : '') + (FLOOR_AT_ZERO ? '   floor-at-zero: ON' : ''));
  console.log('');

  // 1) Show the lines we are about to target, so you can confirm before committing.
  let summary;
  if (ALL_DATES) {
    summary = await pool.query(
      "SELECT to_char(entry_date,'YYYY-MM-DD') AS d, kind, amount_hours, COUNT(*)::int AS n FROM pto_ledger " +
      'WHERE kind = ANY($1::text[]) GROUP BY d, kind, amount_hours ORDER BY n DESC, d',
      [MATCH_KINDS]
    );
    console.log('=== ' + MATCH_KINDS.join('/') + ' lines across ALL dates (these are the target) ===');
    if (!summary.rows.length) console.log('  (none found)');
    summary.rows.forEach(function (r) {
      console.log('  ' + String(r.n).padStart(3) + ' x  ' + r.d + '  kind=' + r.kind + '  ' + fmt(r.amount_hours));
    });
  } else {
    summary = await pool.query(
      'SELECT kind, amount_hours, description, COUNT(*)::int AS n FROM pto_ledger WHERE entry_date = $1 ' +
      'GROUP BY kind, amount_hours, description ORDER BY n DESC, kind',
      [GRANT_DATE]
    );
    console.log('=== All pto_ledger lines dated ' + GRANT_DATE + ' ===');
    if (!summary.rows.length) console.log('  (none found on this date)');
    summary.rows.forEach(function (r) {
      console.log('  ' + String(r.n).padStart(3) + ' x  kind=' + r.kind + '  ' + fmt(r.amount_hours) + '  "' + (r.description || '') + '"');
    });
  }
  console.log('');

  // 1b) Consistency check. If the grant was applied as a raw balance UPDATE (no ledger
  // line), it will NOT show above but WILL show here as a balance-vs-ledger mismatch.
  const drift = await pool.query(
    'SELECT u.id, u.name, COALESCE(u.pto_balance_hours,0) AS bal, COALESCE(SUM(l.amount_hours),0) AS ledger_sum ' +
    'FROM users u LEFT JOIN pto_ledger l ON l.user_id = u.id ' +
    'GROUP BY u.id, u.name, u.pto_balance_hours ' +
    'HAVING COALESCE(u.pto_balance_hours,0) <> COALESCE(SUM(l.amount_hours),0) ORDER BY u.name'
  );
  console.log('=== Balance vs ledger consistency (should be empty) ===');
  if (!drift.rows.length) console.log('  OK — every cached balance matches its ledger sum.');
  drift.rows.forEach(function (r) {
    console.log('  ' + r.name + ': balance ' + fmt(r.bal) + ' vs ledger ' + fmt(r.ledger_sum) + '   (delta ' + fmt(Number(r.bal) - Number(r.ledger_sum)) + ')');
  });
  if (drift.rows.length) console.log('  NOTE: mismatches mean some balances were changed outside the ledger — tell me and I will adjust the back-out to match.');
  console.log('');

  // 2) Select the rows we would reverse.
  const params = [MATCH_KINDS];
  let where = 'l.kind = ANY($1::text[])';
  if (!ALL_DATES) { params.push(GRANT_DATE); where += ' AND l.entry_date = $' + params.length; }
  if (MATCH_AMOUNT !== null) { params.push(MATCH_AMOUNT); where += ' AND l.amount_hours = $' + params.length; }
  const rows = (await pool.query(
    "SELECT l.id, l.user_id, l.amount_hours, l.kind, l.description, to_char(l.entry_date,'YYYY-MM-DD') AS entry_ymd, u.name, COALESCE(u.pto_balance_hours,0) AS bal " +
    'FROM pto_ledger l JOIN users u ON u.id = l.user_id WHERE ' + where + ' ORDER BY u.name, l.id',
    params
  )).rows;

  console.log('=== Grant lines matched for back-out (' + rows.length + ' row(s)) ===');
  let totalRemove = 0, willGoNegative = 0;
  const plan = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var already = await pool.query(
      "SELECT 1 FROM pto_ledger WHERE user_id = $1 AND kind = 'reversal' AND description LIKE $2 LIMIT 1",
      [r.user_id, '%(ledger #' + r.id + ')']
    );
    if (already.rows.length) { console.log('  SKIP already-backed-out  ' + r.name + '  (source #' + r.id + ')'); continue; }
    var grant = Number(r.amount_hours) || 0;
    var bal = Number(r.bal) || 0;
    var remove = grant;
    if (FLOOR_AT_ZERO && remove > bal) remove = bal < 0 ? 0 : bal;
    var after = bal - remove;
    if (bal - grant < 0) willGoNegative++;
    totalRemove += remove;
    plan.push({ r: r, remove: remove });
    console.log('  ' + r.name + ': remove ' + fmt(remove) + '   balance ' + fmt(bal) + ' -> ' + fmt(after) + ((bal - grant < 0 && !FLOOR_AT_ZERO) ? '   <-- GOES NEGATIVE (used more than granted?)' : ''));
  }
  console.log('');
  console.log('Users to back out: ' + plan.length + '     Total PTO removed: ' + fmt(totalRemove));
  if (willGoNegative && !FLOOR_AT_ZERO) console.log('WARNING: ' + willGoNegative + ' user(s) would go negative (they already used some of the granted PTO). Set FLOOR_AT_ZERO=1 to stop at 0 instead.');
  console.log('');

  if (!COMMIT) {
    console.log('DRY RUN complete — nothing was changed. Re-run with --commit to apply.');
    await pool.end();
    return;
  }

  // 3) Apply: one transaction per user (reversal line + balance decrement).
  var applied = 0;
  for (var j = 0; j < plan.length; j++) {
    var row = plan[j].r, removeHrs = plan[j].remove;
    var client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        "INSERT INTO pto_ledger (user_id, entry_date, kind, amount_hours, description) VALUES ($1, $2, 'reversal', $3, $4)",
        [row.user_id, row.entry_ymd, -removeHrs, TAG + ' (ledger #' + row.id + ')']
      );
      await client.query('UPDATE users SET pto_balance_hours = COALESCE(pto_balance_hours,0) - $1 WHERE id = $2', [removeHrs, row.user_id]);
      await client.query('COMMIT');
      applied++;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (e2) {}
      console.error('  FAILED for ' + row.name + ' (user #' + row.user_id + '): ' + e.message);
    } finally { client.release(); }
  }
  console.log('Applied back-out to ' + applied + ' user(s). Done.');
  await pool.end();
}

main().catch(function (e) { console.error(e); process.exit(1); });
