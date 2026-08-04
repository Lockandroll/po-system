const { pool } = require('../db');

// Central audit writer.
//
// The ip argument is written to BOTH the dedicated audit_logs.ip column and
// into the details JSON. The column is what the Audit Log UI shows and what any
// forensic query should filter on; the details copy exists so the rows written
// before the column existed keep rendering identically, and so a row stays
// self-describing if it is ever exported as JSON on its own.
async function logAudit({ entity_type, entity_id, entity_number, action, user_id, user_name, details, ip }) {
  try {
    var det = details || null;
    if (ip) {
      det = det ? Object.assign({}, det) : {};
      if (det.ip === undefined) det.ip = ip;
    }
    await pool.query(
      'INSERT INTO audit_logs (entity_type, entity_id, entity_number, action, user_id, user_name, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [entity_type, entity_id || null, entity_number || null, action, user_id || null, user_name || null, det ? JSON.stringify(det) : null, ip || null]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = { logAudit };
