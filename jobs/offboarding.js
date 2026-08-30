// Offboarding automation jobs
// Runs deactivations, cleanups, and quarterly check-ins

const { pool } = require('../db');
const { logAudit } = require('../utils/audit');

// Nobody stays clocked in after their access is cut. Close the open punch at the
// moment of the revoke and say why on the entry, so the final timesheet reads as a
// real shift rather than an entry that never ended. Breaks are closed the same way
// clock-out closes them, and worked minutes come out of the stored rows.
async function closeOpenPunch(db, userId, why) {
  const open = await db.query("SELECT id, clock_in_at FROM time_entries WHERE user_id = $1 AND status = 'open'", [userId]);
  for (const e of open.rows) {
    await db.query(
      "UPDATE time_breaks SET break_end_at = NOW(), minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - break_start_at))/60) WHERE entry_id = $1 AND break_end_at IS NULL",
      [e.id]
    );
    await db.query(
      "UPDATE time_entries SET clock_out_at = NOW(), status = 'closed', updated_at = NOW()," +
      " edit_reason = $2, edited_at = NOW()," +
      " worked_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in_at))/60)" +
      "   - COALESCE((SELECT SUM(minutes) FROM time_breaks WHERE entry_id = $1), 0))" +
      " WHERE id = $1",
      [e.id, why]
    );
  }
  return open.rows.length;
}


/**
 * Hourly: cut access on the revoke date, and move a record to pending finalize
 * once the last day has passed. The two are deliberately separate dates.
 */
async function startAutoDeactivation() {
  const job = async () => {
    // Two separate things happen around a departure and they are NOT the same day:
    // access is cut on the revoke date (which can be before the last day, or after
    // it if somebody is burning PTO), and the record only becomes ready to finalize
    // once the last day has actually passed.
    try {
      // 1. Cut access. '<=' rather than '=' so a day the app happened to be down,
      //    or a date set in the past, still gets acted on at the next tick.
      const revoke = await pool.query(`
        SELECT o.id, o.user_id, COALESCE(o.access_revoke_date, o.last_day) AS revoke_on
          FROM offboardings o
          JOIN users u ON u.id = o.user_id
         WHERE o.status IN ('active', 'pending_finalize')
           AND o.deactivate_mode <> 'on_finalize'
           AND COALESCE(o.access_revoke_date, o.last_day) <= CURRENT_DATE
           AND u.active = true
      `);

      for (const ob of revoke.rows) {
        await pool.query('UPDATE users SET active = false WHERE id = $1', [ob.user_id]);
        await pool.query('DELETE FROM trusted_devices WHERE user_id = $1', [ob.user_id]);
        const closed = await closeOpenPunch(pool, ob.user_id, 'Closed automatically when offboarding access was revoked');
        await pool.query(
          `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
           VALUES ($1, NULL, $2, $3, NOW())`,
          [ob.id, 'access_revoked', JSON.stringify({ trigger: 'scheduled', revoke_on: ob.revoke_on, punches_closed: closed })]
        );
        console.log('[Offboarding] Access revoked for user ' + ob.user_id + ' (due ' + ob.revoke_on + ')');
      }

      // 2. Last day is behind us: the record is now waiting on paperwork only.
      //    finalized_at is NOT set here - it means finalized, and the quarterly
      //    drill and the archive sweep both read it.
      const done = await pool.query(`
        UPDATE offboardings SET status = 'pending_finalize'
         WHERE status = 'active' AND last_day <= CURRENT_DATE
         RETURNING id
      `);
      if (done.rowCount) console.log('[Offboarding] ' + done.rowCount + ' record(s) moved to pending finalize');
    } catch (err) {
      console.error('[Offboarding] Auto-deactivation error:', err.message);
    }
  };

  // Run at :00 every hour
  setInterval(job, 60 * 60 * 1000);
  job(); // Run once at startup
}

/**
 * Quarterly drill: send check-in surveys to all finalized departures
 * Runs every 3 months on the 1st at 9 AM
 */
async function startQuarterlyDrill() {
  const job = async () => {
    try {
      // Find finalized offboardings from the previous quarter
      const quarterAgo = new Date();
      quarterAgo.setDate(1);
      quarterAgo.setMonth(quarterAgo.getMonth() - 3);
      const quarterEnd = new Date();
      quarterEnd.setDate(0); // Last day of previous month

      const result = await pool.query(`
        SELECT o.id, o.user_id, ei.id as interview_id
        FROM offboardings o
        LEFT JOIN exit_interviews ei ON o.id = ei.offboarding_id
        WHERE o.status = 'finalized'
          AND o.finalized_at >= $1
          AND o.finalized_at < $2
          AND (ei.id IS NULL OR ei.status = 'waived')
      `, [quarterAgo.toISOString(), quarterEnd.toISOString()]);

      console.log(`[Offboarding] Quarterly drill: ${result.rows.length} departures identified for follow-up`);

      for (const row of result.rows) {
        // Create new exit interview for follow-up if none exists
        if (!row.interview_id) {
          await pool.query(`
            INSERT INTO exit_interviews
            (offboarding_id, user_id, mode, status, token, token_expires_at)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [
            row.id,
            row.user_id,
            'quarterly_drill',
            'draft',
            require('crypto').randomBytes(32).toString('hex'),
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          ]);
        }
      }
    } catch (err) {
      console.error('[Offboarding] Quarterly drill error:', err.message);
    }
  };

  // Schedule for first of every month at 9 AM
  const scheduleNextRun = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 9, 0, 0);
    if (now > next) {
      next.setMonth(next.getMonth() + 1);
    }
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      job();
      scheduleNextRun(); // Reschedule
    }, delay);
  };

  scheduleNextRun();
}

/**
 * Cleanup: archive old finalized offboardings (> 2 years)
 * Runs daily at 2 AM
 */
async function startOffboardingCleanup() {
  const job = async () => {
    try {
      const twoYearsAgo = new Date();
      twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

      // Mark as archived (soft delete; allows historical querying)
      const result = await pool.query(
        `UPDATE offboardings SET archived = true WHERE status = $1 AND finalized_at < $2`,
        ['finalized', twoYearsAgo.toISOString()]
      );

      console.log(`[Offboarding] Cleanup: archived ${result.rowCount} old offboardings`);
    } catch (err) {
      console.error('[Offboarding] Cleanup error:', err.message);
    }
  };

  // Run at 2 AM daily
  const scheduleNextRun = () => {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 2, 0, 0);
    const delay = next.getTime() - now.getTime();
    setTimeout(() => {
      job();
      scheduleNextRun();
    }, delay);
  };

  scheduleNextRun();
}

module.exports = {
  startAutoDeactivation,
  startQuarterlyDrill,
  startOffboardingCleanup
};
