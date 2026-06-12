const { pool } = require('../db');

async function logAudit({ entity_type, entity_id, entity_number, action, user_id, user_name, details }) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (entity_type, entity_id, entity_number, action, user_id, user_name, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [entity_type, entity_id || null, entity_number || null, action, user_id || null, user_name || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = { logAudit };
