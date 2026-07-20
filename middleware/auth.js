const jwt = require('jsonwebtoken');
const permissions = require('../utils/permissions');
const clientVersion = require('../utils/clientVersion');
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
  // ONE user read per request, shared by everything below (the onboarding gate, the
  // deactivation check, the permission revision, and requirePermission's extra_perms
  // lookup). Previously the onboarding gate and requirePermission each ran their own
  // query; this consolidates them rather than adding a new one.
  let urow = null;
  let userDbErr = false;
  try {
    const _ur = await pool.query(
      'SELECT id, role, active, extra_perms, onboarding_status, onboarding_phase, offboarding_restricted, session_epoch FROM users WHERE id = $1',
      [payload.id]
    );
    urow = _ur.rows.length ? _ur.rows[0] : null;
  } catch (e) { userDbErr = true; }
  req._userRow = urow;

  // Fail CLOSED on a DB read error: if the user lookup threw we cannot confirm the
  // account is still active, so deny rather than trust a stale JWT. Add-in tokens are
  // exempt on a transient error, mirroring the deactivation exemption below.
  if (userDbErr && !payload.addin) {
    return res.status(503).json({ error: 'Temporarily unavailable' });
  }
  // A deactivated account loses access on its very next request, even though its
  // JWT is still technically valid. Add-in tokens are exempt (they are service-ish
  // and are already scoped to /api/addin).
  if (urow && urow.active === false && !payload.addin) {
    return res.status(401).json({ error: 'Your account has been deactivated.', deactivated: true });
  }
  // Session revocation: a session_epoch bump (password reset, forced sign-out) makes
  // every token minted before the bump stale. The rolling re-sign spreads ...claims so
  // a still-valid session's `se` carries forward untouched.
  if (payload.se !== undefined && urow && Number(urow.session_epoch || 0) !== Number(payload.se)) {
    return res.status(401).json({ error: 'Session expired, please sign in again.', sessionExpired: true });
  }

  // Onboarding gate: a user still in onboarding may only reach a small whitelist
  // (auth, the onboarding track itself, push, and — in Phase 2 only — the time clock).
  // Phase 1 is paperwork with NO clock-in; Phase 2 is paid training, so the clock
  // opens only once the hire has advanced to Phase 2. Re-checked against the DB each
  // request so a supervisor sign-off (or phase advance) takes effect instantly.
  let onbActive = false;
  if (payload.onb) {
    if (userDbErr) {
      onbActive = true; /* fail closed on DB errors */
    } else {
      const _st = urow ? urow.onboarding_status : 'complete';
      onbActive = !!(_st && _st !== 'complete');
    }
    if (onbActive) {
      const _phase = (urow && urow.onboarding_phase) || 1;
      const _p = (req.originalUrl || req.url || '');
      const _clockOk = _phase === 2 && _p.indexOf('/api/timeclock') === 0;
      const _ok = _p.indexOf('/api/auth') === 0 || _p.indexOf('/api/onboarding') === 0 ||
        _clockOk || _p.indexOf('/api/push') === 0;
      if (!_ok) return res.status(403).json({ error: 'Finish onboarding to unlock this part of Nova.', onboarding: true });
    }
  }

  // Offboarding gate: once offboarding STARTS, the person keeps only a narrow slice
  // of Nova — the time clock and PTO (so they can still punch and their PTO keeps
  // tracking through their last day) plus auth/push. Everything else is closed off.
  // Full deactivation (active=false, handled above) is the FINAL step on the last
  // day. Re-checked against the DB each request, so access closes the instant
  // offboarding begins and reopens the instant it is cancelled. Add-in tokens exempt.
  if (urow && urow.offboarding_restricted === true && urow.active !== false && !payload.addin) {
    const _op = (req.originalUrl || req.url || '');
    const _offbOk =
      _op.indexOf('/api/auth') === 0 ||
      _op.indexOf('/api/timeclock') === 0 ||
      _op.indexOf('/api/pto') === 0 ||
      _op.indexOf('/api/push') === 0;
    if (!_offbOk) {
      return res.status(403).json({ error: 'Your Nova access is limited while offboarding is in progress. You can still use the time clock and view your PTO.', offboarding: true });
    }
  }
  // Authorization role comes from the DB row (source of truth), never a possibly-stale
  // JWT claim. Falls back to the token's role only if the row could not be read.
  const effRole = (urow && urow.role) ? urow.role : payload.role;
  // Issue a fresh 24h token on every request (rolling expiry) for the REAL user.
  const { iat, exp, onb, ...claims } = payload;
  if (onbActive) claims.onb = true;
  claims.role = effRole;
  const sessTtl = claims.addin ? '90d' : (claims.remember ? '30d' : '24h');
  res.setHeader('X-New-Token', jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: sessTtl }));

  // Permission revision. A short fingerprint of everything the client's can() depends
  // on: the user's role, their extra_perms, whether they are active, and the global
  // role_permissions matrix. The client compares it to the one it holds and, on a
  // mismatch, refetches its permissions and re-renders — so an admin's change takes
  // effect on the user's next click instead of on their next full page load.
  try {
    const _rev = await permissions.permsRev(urow || { role: payload.role, extra_perms: [], active: true });
    if (_rev) res.setHeader('X-Perms-Rev', _rev);
  } catch (e) { /* header is an optimization; never fail the request over it */ }

  // Minimum client version. When a deploy is backward-incompatible, an admin raises
  // client_min_version and any older client hard-resets its caches and reloads.
  try {
    const _mv = await clientVersion.minVersion();
    if (_mv) res.setHeader('X-Min-Version', _mv);
  } catch (e) { /* same */ }
  // Track activity for the real user (throttled to at most once per minute).
  pool.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '60 seconds')", [payload.id]).catch(function(){});
  // Real user; owner is coerced to admin-level for authorization.
  req.user = { id: payload.id, email: payload.email, name: payload.name, role: effRole };
  if (onbActive) req.user.onboarding = true;
  req.user.isOwner = (effRole === 'owner');
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
async function userHasExtraPerm(req, userId, perm) {
  // requireAuth already loaded the real user's row. Reuse it instead of re-querying —
  // but only when it belongs to the user we are actually checking. Under View-As,
  // req.user is the impersonated user while req._userRow is still the real admin, so
  // fall through to a fresh query in that case.
  const cached = req && req._userRow;
  if (cached && cached.id === userId) {
    return Array.isArray(cached.extra_perms) && cached.extra_perms.indexOf(perm) !== -1;
  }
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
      if (req.user.id && await userHasExtraPerm(req, req.user.id, perm)) return next();
      return res.status(403).json({ error: 'Forbidden' });
    } catch (e) {
      try { if (req.user && permissions.defaultHas(req.user.role, perm)) return next(); } catch (_) {}
      try { if (req.user && req.user.id && await userHasExtraPerm(req, req.user.id, perm)) return next(); } catch (_) {}
      return res.status(403).json({ error: 'Forbidden' });
    }
  };
}

module.exports = { requireAuth, requireRole, requirePermission };
