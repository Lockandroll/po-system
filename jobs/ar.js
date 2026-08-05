const cron = require('node-cron');
const { pool } = require('../db');

const TZ = 'America/New_York';

// ---------------------------------------------------------------------------
//  Collections
// ---------------------------------------------------------------------------
// An invoice past its terms raises a normal Nova task. Deliberately a TASK and
// not a second follow-up queue: the task module already has assignment, due
// dates, reminders, overdue escalation and a place people actually look. A
// bespoke collections inbox would be a screen nobody opens on a Tuesday.
//
// One task per invoice, ever. The guard is the invoice number inside the title,
// which is why the title format below must not be changed casually - a reworded
// title is a duplicate task on every overdue invoice the next morning.
function collectionsTitle(invoiceNumber) {
  return 'Collections: invoice ' + invoiceNumber;
}

async function runCollections() {
  try {
    // Who owns collections. Falls back to nobody rather than dumping fifty
    // tasks on whichever admin happens to sort first.
    const owner = await pool.query(
      "SELECT value FROM settings WHERE key = 'ar_collections_user_id'");
    const ownerId = owner.rows.length ? parseInt(owner.rows[0].value, 10) || null : null;

    const r = await pool.query(
      'SELECT b.invoice_id, b.invoice_number, b.account_name, b.balance, b.due_on, ' +
      '       (CURRENT_DATE - b.due_on)::int AS days_late ' +
      'FROM ar_invoice_balances b JOIN vendors v ON v.id = b.account_id ' +
      'WHERE v.ar_enabled = true AND b.balance > 0.004 AND b.due_on < CURRENT_DATE ' +
      'ORDER BY b.due_on LIMIT 200');

    var made = 0;
    for (var i = 0; i < r.rows.length; i++) {
      const inv = r.rows[i];
      const title = collectionsTitle(inv.invoice_number);
      const dupe = await pool.query('SELECT 1 FROM tasks WHERE title = $1 LIMIT 1', [title]);
      if (dupe.rows.length) continue;
      await pool.query(
        'INSERT INTO tasks (title, description, status, priority, assigned_to, due_date) ' +
        "VALUES ($1, $2, 'todo', $3, $4, CURRENT_DATE)",
        [title,
          inv.account_name + ' owes $' + Number(inv.balance).toFixed(2) + ' on invoice ' +
          inv.invoice_number + '. Due ' + String(inv.due_on).slice(0, 10) + ', now ' +
          inv.days_late + ' day' + (inv.days_late === 1 ? '' : 's') + ' late.',
          inv.days_late > 60 ? 'high' : 'medium', ownerId]);
      made++;
    }
    if (made) console.log('A/R: raised ' + made + ' collections task(s).');
  } catch (e) {
    // A missing view or an empty A/R install must never take the cron process
    // down with it.
    console.error('runCollections error:', e.message);
  }
}

// ---------------------------------------------------------------------------
//  Statement day
// ---------------------------------------------------------------------------
// Flags the accounts whose statement day is today. Sending is left to the
// existing email path rather than opening a second one here; this job's job is
// to know WHEN, not to reinvent HOW.
async function runStatementDay() {
  try {
    const r = await pool.query(
      'SELECT v.id, v.name, v.ar_contact_email, ' +
      '       COALESCE((SELECT SUM(balance) FROM ar_invoice_balances b WHERE b.account_id = v.id), 0) AS balance ' +
      'FROM vendors v WHERE v.ar_enabled = true AND v.ar_statement_day = EXTRACT(DAY FROM CURRENT_DATE)::int');
    const due = r.rows.filter(function (x) { return Number(x.balance) > 0.004; });
    if (due.length) {
      console.log('A/R: ' + due.length + ' account(s) are due a statement today: ' +
        due.map(function (x) { return x.name; }).join(', '));
    }
    return due;
  } catch (e) {
    console.error('runStatementDay error:', e.message);
    return [];
  }
}

function startArJobs() {
  // Once a day, early, so the tasks are waiting when somebody sits down rather
  // than appearing halfway through the morning.
  cron.schedule('15 7 * * *', runCollections, { timezone: TZ });
  cron.schedule('30 7 * * *', runStatementDay, { timezone: TZ });
  console.log('A/R jobs scheduled (collections 07:15, statements 07:30).');
}

module.exports = { startArJobs, runCollections, runStatementDay, collectionsTitle };
