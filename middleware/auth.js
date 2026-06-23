const jwt = require('jsonwebtoken');
const permissions = require('../utils/permissions');
const { pool } = require('../db');

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  // Issue a fresh 24h token on every request (rolling expiry) for the REAL user.
  const { iat, exp, ...claims } = payload;
  res.setHeader('X-New-Token', jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '24h' }));
  // Track activity for the real user (throttled to at most once per minute).
  pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '60 seconds')", [payload.id]).catch(function(){});
  // Real user; owner is coerced to admin-level for authorization.
  req.user = { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
  req.user.isOwner = (payload.role === 'owner');
  if (req.user.isOwner) req.user.role = 'admin';
  // View-As: a real admin/owner can preview another user's ACTUAL data (read-only).
  // Writes are blocked while previewing; an admin may not impersonate an owner.
  const viewAs = req.headers['x-view-as'];
  if (viewAs && req.user.role === 'admin') {
    if (req.method !== 'GET') {
      return res.status(403).json({ error: 'Exit preview to make changes.' });
    }
    try {
      const r = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1 AND active = true', [parseInt(viewAs, 10)]);
      if (r.rows.length) {
        const t = r.rows[0];
        if (!(t.role === 'owner' && payload.role !== 'owner')) {
          req.user = { id: t.id, email: t.email, name: t.name, role: t.role };
          req.user.isOwner = (t.role === 'owner');
          if (req.user.isOwner) req.user.role = 'admin';
          req.viewingAs = true;
        }
      }
    } catch (e) { /* ignore; proceed as the real user */ }
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

function requirePermission(perm) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const ok = await permissions.hasPermission(req.user.role, perm);
      if (!ok) return res.status(403).json({ error: 'Forbidden' });
      return next();
    } catch (e) {
      try { if (req.user && permissions.defaultHas(req.user.role, perm)) return next(); } catch (_) {}
      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

module.exports = { requireAuth, requireRole, requirePermission };
