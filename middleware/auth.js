const jwt = require('jsonwebtoken');
const permissions = require('../utils/permissions');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    // Issue a fresh 24h token on every request (rolling expiry)
    const { iat, exp, ...claims } = payload;
    const newToken = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.setHeader('X-New-Token', newToken);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
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
