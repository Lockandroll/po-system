const express = require('express');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const security = require('../utils/security');

const router = express.Router();

// GET audit logs (admin only)
router.get('/', requireAuth, requirePermission('view_audit'), async (req, res) => {
  try {
    const { entity_type, limit } = req.query;
    let query = 'SELECT * FROM audit_logs';
    const params = [];
    if (entity_type) {
      params.push(entity_type);
      query += ' WHERE entity_type = $' + params.length;
    }
    // Raised from 500. Security events are far chattier than the PO/quote rows
    // this endpoint was sized for — a single brute-force run can produce
    // hundreds — and a cap that silently hides them defeats the point.
    const cap = Math.min(Math.max(parseInt(limit, 10) || 1500, 1), 5000);
    query += ' ORDER BY created_at DESC LIMIT ' + cap;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ---- Security overview ------------------------------------------------------
// Everything an admin needs to answer "is something happening right now?" in a
// single request: currently locked accounts, recent attack signal, every live
// trusted device (a 30-day 2FA bypass that had NO admin view at all before),
// and the lockdown state.
router.get('/security/summary', requireAuth, requirePermission('view_audit'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);

    const lockedQ = pool.query(
      'SELECT id, name, email, role, failed_attempts, lockout_until, last_login_at ' +
      'FROM users WHERE lockout_until IS NOT NULL AND lockout_until > NOW() ORDER BY lockout_until DESC'
    );
    const attemptsQ = pool.query(
      'SELECT id, name, email, role, failed_attempts FROM users ' +
      'WHERE COALESCE(failed_attempts,0) > 0 ORDER BY failed_attempts DESC LIMIT 50'
    );
    const countsQ = pool.query(
      "SELECT action, COUNT(*)::int AS n FROM audit_logs " +
      "WHERE entity_type = 'auth' AND created_at > NOW() - make_interval(days => $1) GROUP BY action",
      [days]
    );
    // Distinct login IPs per user. This is the single highest-value forensic
    // view Nova has: a successful login from an IP a person has never used
    // before is the strongest compromise signal in the whole dataset.
    const ipsQ = pool.query(
      "SELECT user_id, user_name, ip, COUNT(*)::int AS logins, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen " +
      "FROM audit_logs WHERE entity_type = 'auth' AND action = 'login' AND ip IS NOT NULL " +
      "AND created_at > NOW() - make_interval(days => $1) " +
      "GROUP BY user_id, user_name, ip ORDER BY user_name NULLS LAST, logins DESC",
      [days]
    );
    const devicesQ = pool.query(
      'SELECT td.id, td.user_id, u.name AS user_name, u.role, td.label, td.ip, td.created_at, td.last_used_at, td.expires_at ' +
      'FROM trusted_devices td JOIN users u ON u.id = td.user_id ' +
      'WHERE td.expires_at > NOW() ORDER BY td.created_at DESC'
    );
    const oldestQ = pool.query("SELECT MIN(created_at) AS oldest FROM audit_logs WHERE entity_type = 'auth'");

    const r = await Promise.all([lockedQ, attemptsQ, countsQ, ipsQ, devicesQ, oldestQ]);
    const counts = {};
    r[2].rows.forEach(function (row) { counts[row.action] = row.n; });

    let lockdown = { armed: false, active: false, until: null };
    try { lockdown = await security.lockdownStatus(); } catch (e) {}

    res.json({
      days: days,
      locked_accounts: r[0].rows,
      accounts_with_failed_attempts: r[1].rows,
      event_counts: counts,
      login_ips: r[3].rows,
      trusted_devices: r[4].rows,
      // How far back the evidence actually goes. Without this the whole page
      // reads as "nothing happened" when the truth may be "nothing was kept".
      oldest_security_row: r[5].rows[0] ? r[5].rows[0].oldest : null,
      lockdown: lockdown,
      thresholds: {
        burst_accounts: security.BURST_ACCOUNTS,
        burst_window_minutes: security.BURST_WINDOW_MIN,
        lockdown_minutes: security.LOCKDOWN_MINUTES
      }
    });
  } catch (err) {
    console.error('security summary failed:', err);
    res.status(500).json({ error: 'Failed to load the security summary' });
  }
});

// Arm / disarm automatic lockdown, or end one that is currently running.
router.post('/security/lockdown', requireAuth, requirePermission('manage_settings'), async (req, res) => {
  try {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'armed')) {
      await security.setSetting('security_auto_lockdown', req.body.armed === true ? 'true' : 'false');
    }
    if (req.body && req.body.clear === true) {
      await security.clearLockdown();
    }
    // Arming and disarming the only automatic defence Nova has is itself worth
    // a log line — otherwise it could be quietly switched off before an attack.
    await security.record(req, {
      event: 'lockdown_engaged',
      user_id: req.user.id,
      user_name: req.user.name,
      alert: false,
      details: {
        manual: true,
        armed: req.body ? req.body.armed : undefined,
        cleared: !!(req.body && req.body.clear)
      }
    });
    res.json(await security.lockdownStatus());
  } catch (err) {
    console.error('lockdown update failed:', err);
    res.status(500).json({ error: 'Could not update the lockdown setting' });
  }
});

module.exports = router;
