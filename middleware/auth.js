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
  // Add-in tokens are long-lived; limit them to the /api/addin/* surface so a
  // leaked token cannot reach the rest of the API.
  if (payload.addin && (req.originalUrl || req.url || '').indexOf('/api/addin') !== 0) {
    return res.status(403).json({ error: 'This token is limited to Outlook add-in actions.' });
  }
  // Onboarding gate: a user still in onboarding may only reach a small whitelist
  // (auth, the onboarding track itself, push, and — in Phase 2 only — the time clock).
  // Phase 1 is paperwork with NO clock-in; Phase 2 is paid training, so the clock
  // opens only once the hire has advanced to Phase 2. Re-checked against the DB each
  // request so a supervisor sign-off (or phase advance) takes effect instantly.
  let onbActive = false;
  if (payload.onb) {
    let _phase = 1;
    try {
      const _or = await pool.query('SELECT onboarding_status, onboarding_phase FROM users WHERE id = $1', [payload.id]);
      const _st = _or.rows.length ? _or.rows[0].onboarding_status : 'complete';
      _phase = _or.rows.length ? (_or.rows[0].onboarding_phase || 1) : 1;
      onbActive = (_st && _st !== 'complete');
    } catch (e) { onbActive = true; /* fail closed on DB errors */ }
    if (onbActive) {
      const _p = (req.originalUrl || req.url || '');
      const _clockOk = _phase === 2 && _p.indexOf('/api/timeclock') === 0;
      const _ok = _p.indexOf('/api/auth') === 0 || _p.indexOf('/api/onboarding') === 0 ||
        _clockOk || _p.indexOf('/api/push') === 0;
      if (!_ok) return res.status(403).json({ error: 'Finish onboarding to unlock this part of Nova.', onboarding: true });
    }
  }
  // Issue a fresh 24h token on every request (rolling expiry) for the REAL user.
  const { iat, exp, onb, ...claims } = payload;
  if (onbActive) claims.onb = true;
  const sessTtl = claims.addin ? '90d' : (claims.remember ? '30d' : '24h');
  res.setHeader('X-New-Token', jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: sessTtl }));
  // Track activity for the real user (throttled to at most once per minute).
  pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '60 seconds')", [payload.id]).catch(function(){});
  // Real user; owner is coerced to admin-level for authorization.
  req.user = { id: payload.id, email: payload.email, name: payload.name, role: payload.role };
  if (onbActive) req.user.onboarding = true;
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

// Per-user permission grants live in users.extra_perms (TEXT[]). These let an
// admin give an individual a capability (e.g. manage_schedule) without changing
// their role. Only checked when the role itself lacks the permission.
async function userHasExtraPerm(userId, perm) {
  try {
    const r = await pool.query('SELECT extra_perms FROM users WHERE id = $1', [userId]);
    const ep = r.rows.length ? r.rows[0].extra_perms : null;
    return Array.isArray(ep) && ep.indexOf(perm) !== -1;
  } catch (e) { return false; }
}

function requirePermission(perm) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const ok = await permissions.hasPermission(req.user.role, perm);
      if (ok) return next();
      if (req.user.id && await userHasExtraPerm(req.user.id, perm)) return next();
      return res.status(403).json({ error: 'Forbidden' });
    } catch (e) {
      try { if (req.user && permissions.defaultHas(req.user.role, perm)) return next(); } catch (_) {}
      try { if (req.user && req.user.id && await userHasExtraPerm(req.user.id, perm)) return next(); } catch (_) {}
      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

module.exports = { requireAuth, requireRole, requirePermission };
