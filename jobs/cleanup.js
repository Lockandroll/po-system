const cron = require('node-cron');
const { pool } = require('../db');

// How long to keep ordinary audit log rows (PO edited, quote created, and so on).
// Override with AUDIT_RETENTION_DAYS in Railway.
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS, 10) > 0
  ? parseInt(process.env.AUDIT_RETENTION_DAYS, 10)
  : 90;

// SECURITY ROWS ARE NEVER PURGED BY DEFAULT.
//
// 90 days is fine for "who edited this PO" and useless for "were we attacked".
// Breaches are routinely discovered months after the fact, and the answer used
// to have already been deleted by the time anyone thought to ask. These rows
// are small (a few hundred bytes each, a few thousand a year on a business this
// size), so keeping them costs almost nothing and throwing them away costs the
// only record there is.
//
// Set SECURITY_RETENTION_DAYS to a positive number to opt into a window
// instead (e.g. 730 for two years). 0, empty or unset means keep forever.
const SECURITY_ENTITY_TYPES = ['auth', 'vault'];
const _secRaw = parseInt(process.env.SECURITY_RETENTION_DAYS, 10);
const SECURITY_RETENTION_DAYS = (!isNaN(_secRaw) && _secRaw > 0) ? _secRaw : 0; // 0 = never purge

async function purgeOldAuditLogs() {
  try {
    // Ordinary rows: everything EXCEPT the security entity types.
    const res = await pool.query(
      'DELETE FROM audit_logs WHERE created_at < NOW() - make_interval(days => $1) AND NOT (entity_type = ANY($2::text[]))',
      [RETENTION_DAYS, SECURITY_ENTITY_TYPES]
    );
    if (res.rowCount) {
      console.log('[cleanup] Deleted ' + res.rowCount + ' audit_logs older than ' + RETENTION_DAYS + ' days');
    }
  } catch (err) {
    console.error('[cleanup] audit_logs purge failed:', err.message);
  }
  if (SECURITY_RETENTION_DAYS <= 0) return; // keep security history forever
  try {
    const res = await pool.query(
      'DELETE FROM audit_logs WHERE created_at < NOW() - make_interval(days => $1) AND entity_type = ANY($2::text[])',
      [SECURITY_RETENTION_DAYS, SECURITY_ENTITY_TYPES]
    );
    if (res.rowCount) {
      console.log('[cleanup] Deleted ' + res.rowCount + ' SECURITY audit_logs older than ' + SECURITY_RETENTION_DAYS + ' days');
    }
  } catch (err) {
    console.error('[cleanup] security audit_logs purge failed:', err.message);
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

// Inspection photos upload as they are shot, before the inspection row exists, and
// are adopted by it on submit. Someone who opens the form, takes three photos and
// then walks away leaves those three parked against a dead capture token, with bytes
// sitting in R2 that nothing will ever point at. Sweep them, then the spent tokens.
//
// Only ever touches rows with NO inspection_id. A photo that made it onto an
// inspection is evidence and is never cleaned up by a cron.
async function purgeOrphanInspectionPhotos() {
  var r2 = null;
  try { r2 = require('../utils/r2'); } catch (e) { r2 = null; }
  try {
    const { rows } = await pool.query(
      'SELECT id, r2_key FROM inspection_photos ' +
      'WHERE inspection_id IS NULL AND created_at < NOW() - make_interval(days => 2) LIMIT 500'
    );
    for (var i = 0; i < rows.length; i++) {
      if (r2 && r2.configured() && rows[i].r2_key) {
        try { await r2.deleteObject(rows[i].r2_key); }
        catch (e) { console.error('[cleanup] R2 delete failed for orphan photo ' + rows[i].id + ':', e.message); continue; }
      }
      await pool.query('DELETE FROM inspection_photos WHERE id = $1', [rows[i].id]);
    }
    if (rows.length) console.log('[cleanup] Removed ' + rows.length + ' unattached inspection photos');
  } catch (err) {
    console.error('[cleanup] orphan inspection photo purge failed:', err.message);
  }
  try {
    const res = await pool.query(
      'DELETE FROM inspection_capture_tokens WHERE inspection_id IS NULL AND expires_at < NOW() - make_interval(days => 2)'
    );
    if (res.rowCount) console.log('[cleanup] Deleted ' + res.rowCount + ' spent inspection capture tokens');
  } catch (err) {
    console.error('[cleanup] capture token purge failed:', err.message);
  }
}

function startCleanup() {
  // Run once shortly after boot, then daily in the early morning.
  setTimeout(purgeOldAuditLogs, 30000);
  setTimeout(purgeOldWorkOrders, 35000);
  setTimeout(purgeOrphanInspectionPhotos, 40000);
  cron.schedule('15 3 * * *', purgeOldAuditLogs);
  cron.schedule('20 3 * * *', purgeOldWorkOrders);
  cron.schedule('25 3 * * *', purgeOrphanInspectionPhotos);
}

module.exports = { startCleanup, purgeOldAuditLogs, purgeOldWorkOrders, purgeOrphanInspectionPhotos };
