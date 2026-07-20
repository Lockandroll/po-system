// Offboarding automation jobs
// Runs deactivations, cleanups, and quarterly check-ins

const { pool } = require('../db');
const { logAudit } = require('../utils/audit');

/**
 * Automatically deactivate users whose last day is today
 * Runs every hour at :00
 */
async function startAutoDeactivation() {
  const job = async () => {
    try {
      const result = await pool.query(`
        SELECT o.id, o.user_id, o.deactivate_mode
        FROM offboardings o
        WHERE o.status = 'active'
          AND o.deactivate_mode = 'end_of_last_day'
          AND o.last_day = CURRENT_DATE
      `);

      for (const ob of result.rows) {
        await pool.query('UPDATE users SET active = false WHERE id = $1', [ob.user_id]);
        await pool.query(
          'UPDATE offboardings SET status = $1, finalized_at = NOW() WHERE id = $2',
          ['pending_finalize', ob.id]
        );
        console.log(`[Offboarding] Auto-deactivated user ${ob.user_id}`);
      }
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
