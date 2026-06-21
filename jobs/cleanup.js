const cron = require('node-cron');
const { pool } = require('../db');

// How long to keep audit log rows. Override with AUDIT_RETENTION_DAYS in Railway.
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS, 10) > 0
  ? parseInt(process.env.AUDIT_RETENTION_DAYS, 10)
  : 90;

async function purgeOldAuditLogs() {
  try {
    const res = await pool.query(
      'DELETE FROM audit_logs WHERE created_at < NOW() - make_interval(days => $1)',
      [RETENTION_DAYS]
    );
    if (res.rowCount) {
      console.log('[cleanup] Deleted ' + res.rowCount + ' audit_logs older than ' + RETENTION_DAYS + ' days');
    }
  } catch (err) {
    console.error('[cleanup] audit_logs purge failed:', err.message);
  }
}

function startCleanup() {
  // Run once ~30s after boot, then every day at 03:15 server time.
  setTimeout(purgeOldAuditLogs, 30000);
  cron.schedule('15 3 * * *', purgeOldAuditLogs);
}

module.exports = { startCleanup, purgeOldAuditLogs };
