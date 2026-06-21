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

const WO_RETENTION_DAYS = parseInt(process.env.WORK_ORDER_RETENTION_DAYS, 10) > 0
  ? parseInt(process.env.WORK_ORDER_RETENTION_DAYS, 10)
  : 180; // ~6 months

async function purgeOldWorkOrders() {
  try {
    const res = await pool.query(
      'DELETE FROM work_orders WHERE created_at < NOW() - make_interval(days => $1)',
      [WO_RETENTION_DAYS]
    );
    if (res.rowCount) {
      console.log('[cleanup] Deleted ' + res.rowCount + ' work_orders older than ' + WO_RETENTION_DAYS + ' days');
    }
  } catch (err) {
    console.error('[cleanup] work_orders purge failed:', err.message);
  }
}

function startCleanup() {
  // Run once shortly after boot, then daily in the early morning.
  setTimeout(purgeOldAuditLogs, 30000);
  setTimeout(purgeOldWorkOrders, 35000);
  cron.schedule('15 3 * * *', purgeOldAuditLogs);
  cron.schedule('20 3 * * *', purgeOldWorkOrders);
}

module.exports = { startCleanup, purgeOldAuditLogs, purgeOldWorkOrders };
