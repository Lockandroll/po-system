const cron = require('node-cron');
const { pool } = require('../db');
const quotes = require('../routes/quotes');

// Daily, 09:00 ET:
//   1. label any sent quote past its valid_until (the link stays live)
//   2. nudge the customer at 3 days and again at 7 days with no answer
//
// Deliberately capped at TWO nudges. A third email from a company you have not
// replied to twice is not a reminder, it is spam.
const NUDGE_DAYS = [3, 7];

async function runQuoteReminders() {
  var expired = 0, nudged = 0;
  try {
    // --- 1. mark quotes past their date ------------------------------------
    // This is a LABEL, not a lock. The approval link keeps working past this
    // point by design - see routes/quotes.js. All this does is stop the quote
    // sitting in the list looking like it is still live.
    const stale = (await pool.query(
      "SELECT id FROM quotes WHERE status IN ('sent','viewed','changes_requested') " +
      "AND valid_until IS NOT NULL AND valid_until < (NOW() AT TIME ZONE 'America/New_York')::date"
    )).rows;
    for (var i = 0; i < stale.length; i++) {
      try {
        await pool.query("UPDATE quotes SET status = 'expired', updated_at = NOW() WHERE id = $1", [stale[i].id]);
        await pool.query("INSERT INTO quote_events (quote_id, event_type, actor_name) VALUES ($1, 'expired', 'system')", [stale[i].id]);
        expired++;
      } catch (e) { console.error('[quoteReminders] expire failed:', e.message); }
    }

    // --- 2. nudge ----------------------------------------------------------
    // Only quotes the customer has not answered, that still have a live link,
    // and that have had fewer than NUDGE_DAYS.length reminders already.
    const due = (await pool.query(
      'SELECT q.*, u.name AS requester_name, u.email AS requester_email ' +
      'FROM quotes q JOIN users u ON q.requester_id = u.id ' +
      "WHERE q.status IN ('sent','viewed') " +
      '  AND q.approval_token IS NOT NULL ' +
      "  AND (q.valid_until IS NULL OR q.valid_until >= (NOW() AT TIME ZONE 'America/New_York')::date) " +
      '  AND q.sent_at IS NOT NULL ' +
      '  AND q.reminder_count < $1 ' +
      "  AND COALESCE(q.sent_to, q.customer_email) <> ''",
      [NUDGE_DAYS.length]
    )).rows;

    for (var j = 0; j < due.length; j++) {
      const q = due[j];
      const ageDays = Math.floor((Date.now() - new Date(q.sent_at).getTime()) / 86400000);
      const wantAt = NUDGE_DAYS[q.reminder_count];
      // reminder_count is the index of the nudge we owe them next, so a quote
      // that has had one nudge is only due again at the SECOND threshold.
      if (!(ageDays >= wantAt)) continue;
      // Never two nudges in one day, whatever the thresholds say.
      if (q.last_reminded_at && (Date.now() - new Date(q.last_reminded_at).getTime()) < 20 * 3600000) continue;

      try {
        const items = (await pool.query('SELECT * FROM quote_line_items WHERE quote_id = $1 ORDER BY id', [q.id])).rows;
        if (!items.length) continue;
        await quotes.sendQuoteEmail(q, items, { reminder: true });
        await pool.query('UPDATE quotes SET last_reminded_at = NOW(), reminder_count = reminder_count + 1 WHERE id = $1', [q.id]);
        await pool.query(
          "INSERT INTO quote_events (quote_id, event_type, actor_name, details) VALUES ($1, 'reminded', 'system', $2)",
          [q.id, JSON.stringify({ day: wantAt, to: q.sent_to || q.customer_email })]
        );
        nudged++;
      } catch (e) { console.error('[quoteReminders] nudge failed for quote ' + q.id + ':', e.message); }
    }

    console.log('[quoteReminders] Nudged ' + nudged + ' quote(s); ' + expired + ' passed their valid-through date (links still live).');
  } catch (err) {
    console.error('[quoteReminders] Job failed:', err.message);
  }
}

function startQuoteReminders() {
  cron.schedule('0 9 * * *', function () {
    console.log('[quoteReminders] Running daily quote reminder job...');
    runQuoteReminders();
  }, { timezone: 'America/New_York' });
  console.log('[quoteReminders] Daily quote reminder job scheduled (09:00 America/New_York)');
}

module.exports = { startQuoteReminders, runQuoteReminders };
