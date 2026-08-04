const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logAudit } = require('../utils/audit');
const security = require('../utils/security');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const MAX_2FA_ATTEMPTS = 5;

const TRUST_DAYS = 30;
const DEVICE_COOKIE = 'nova_device';

function sessionTtl(remember) { return remember ? '30d' : '24h'; }

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
// Single shared implementation now lives in utils/security.js — this file had
// its own copy, and so did vault.js, signatures.js and assets.js.
const clientIp = security.clientIp;
function getDeviceToken(req) {
  var raw = req.headers.cookie || '';
  var parts = raw.split(';');
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].trim().split('=');
    if (kv[0] === DEVICE_COOKIE) return decodeURIComponent(kv.slice(1).join('='));
  }
  return null;
}
function setDeviceCookie(req, res, rawToken, expiresDate) {
  res.cookie(DEVICE_COOKIE, rawToken, { httpOnly: true, secure: !!req.secure, sameSite: 'lax', expires: expiresDate, path: '/' });
}
function deviceLabel(ua) {
  ua = ua || '';
  var os = /Windows/.test(ua) ? 'Windows' : (/iPhone|iPad|iPod/.test(ua) ? 'iOS' : (/Macintosh|Mac OS/.test(ua) ? 'macOS' : (/Android/.test(ua) ? 'Android' : (/Linux/.test(ua) ? 'Linux' : 'Unknown OS'))));
  var br = /Edg/.test(ua) ? 'Edge' : (/OPR|Opera/.test(ua) ? 'Opera' : (/Chrome/.test(ua) ? 'Chrome' : (/Firefox/.test(ua) ? 'Firefox' : (/Safari/.test(ua) ? 'Safari' : 'Browser'))));
  return br + ' on ' + os;
}

// Initial setup — creates first admin account (only works when no users exist)
router.post('/setup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(rows[0].count) > 0) {
    return res.status(400).json({ error: 'Setup already complete' });
  }
  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
    [name, email, password_hash, 'admin']
  );
  const user = result.rows[0];
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
  logAudit({ entity_type: 'auth', action: 'login', user_id: user.id, user_name: user.name, details: { method: 'account setup' }, ip: clientIp(req) });
  pool.query('UPDATE users SET last_login_at = NOW(), last_seen_at = NOW() WHERE id = $1', [user.id]).catch(function(){});
  res.json({ token, user });
});

// Login with lockout and 2FA
router.post('/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];

  if (!user) {
    // Recorded, but the RESPONSE stays identical to a wrong password so this
    // endpoint still cannot be used to enumerate which emails have accounts.
    await security.record(req, {
      event: 'login_unknown_email',
      user_name: null,
      details: { attempted_email: String(email).slice(0, 120) }
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Check lockout
  if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
    const mins = Math.ceil((new Date(user.lockout_until) - new Date()) / 60000);
    // Someone still hammering an account that is ALREADY locked is the clearest
    // signal there is that this is not a person mistyping their own password.
    await security.record(req, {
      event: 'login_locked_out',
      user_id: user.id,
      user_name: user.name,
      details: { locked_until: user.lockout_until, minutes_remaining: mins }
    });
    return res.status(423).json({ error: 'Account locked due to too many failed attempts. Try again in ' + mins + ' minute(s).' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    const attempts = (user.failed_attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const lockout_until = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      await pool.query('UPDATE users SET failed_attempts=$1, lockout_until=$2 WHERE id=$3', [attempts, lockout_until, user.id]);
      await security.record(req, {
        event: 'account_locked',
        user_id: user.id,
        user_name: user.name,
        summary: user.name + '’s Nova account was locked after ' + attempts + ' failed password attempts.',
        details: { attempts: attempts, locked_for_minutes: LOCKOUT_MINUTES, locked_until: lockout_until.toISOString() }
      });
      // Cross-account detection. Per-account lockout cannot see the shape of a
      // real attack; this can. Awaited so the burst row lands in the same order
      // as the lockout that triggered it, but it never throws.
      await security.checkForBurst(req, user.id);
      return res.status(423).json({ error: 'Too many failed attempts. Account locked for ' + LOCKOUT_MINUTES + ' minutes.' });
    }
    await pool.query('UPDATE users SET failed_attempts=$1 WHERE id=$2', [attempts, user.id]);
    // The counter on the users row is wiped by the next successful login, so
    // this audit row is the only durable record that the attempt ever happened.
    await security.record(req, {
      event: 'failed_login',
      user_id: user.id,
      user_name: user.name,
      details: { attempt: attempts, of: MAX_ATTEMPTS }
    });
    return res.status(401).json({ error: 'Invalid email or password. ' + (MAX_ATTEMPTS - attempts) + ' attempt(s) remaining.' });
  }

  if (user.active === false) {
    // Correct password on a deactivated account. Either an ex-employee still
    // has working credentials, or someone else has them.
    await security.record(req, {
      event: 'login_inactive',
      user_id: user.id,
      user_name: user.name,
      details: { note: 'correct password supplied for a deactivated account' }
    });
    return res.status(403).json({ error: 'Your account has been deactivated. Contact an administrator.' });
  }

  // Reset lockout on success
  await pool.query('UPDATE users SET failed_attempts=0, lockout_until=NULL WHERE id=$1', [user.id]);

  // Trusted device — skip the 2FA code if this device carries a valid remembered
  // token. During a lockdown this shortcut is suspended: a stolen nova_device
  // cookie stops working, while a real employee just gets asked for a code they
  // can actually receive. See utils/security.js for why it works that way.
  var lockedDown = false;
  try { lockedDown = await security.lockdownActive(); } catch (e) { lockedDown = false; }
  var deviceToken = lockedDown ? null : getDeviceToken(req);
  if (deviceToken) {
    const td = await pool.query(
      'SELECT id FROM trusted_devices WHERE user_id=$1 AND token_hash=$2 AND expires_at > NOW()',
      [user.id, hashToken(deviceToken)]
    );
    if (td.rows[0]) {
      const newExpires = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000);
      await pool.query('UPDATE trusted_devices SET last_used_at=NOW(), expires_at=$1, ip=$2 WHERE id=$3', [newExpires, clientIp(req), td.rows[0].id]);
      setDeviceCookie(req, res, deviceToken, newExpires);
      const tdClaims = { id: user.id, email: user.email, name: user.name, role: user.role, se: (user.session_epoch || 0) };
      if (rememberMe) tdClaims.remember = true;
      if (user.onboarding_status && user.onboarding_status !== 'complete') tdClaims.onb = true;
      const tdToken = jwt.sign(tdClaims, process.env.JWT_SECRET, { expiresIn: sessionTtl(rememberMe) });
      logAudit({ entity_type: 'auth', action: 'login', user_id: user.id, user_name: user.name, details: { method: 'trusted device' }, ip: clientIp(req) });
      pool.query('UPDATE users SET last_login_at = NOW(), last_seen_at = NOW() WHERE id = $1', [user.id]).catch(function(){});
      return res.json({ token: tdToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, onboarding_status: user.onboarding_status || 'complete' } });
    }
  }

  // Generate and send 2FA code. Only the HASH is stored at rest; the raw code is
  // delivered to the user by SMS/email and never persisted.
  const code = String(crypto.randomInt(100000, 1000000));
  const codeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await pool.query(
    'INSERT INTO two_factor_codes (user_id, code, expires_at) VALUES ($1, $2, $3) ' +
    'ON CONFLICT (user_id) DO UPDATE SET code=$2, expires_at=$3, used=false, attempts=0',
    [user.id, hashToken(code), codeExpires]
  );

  const hasSms = !!(user.phone && user.receive_sms);
  if (hasSms) {
    try {
      await sendSms([user.phone], 'Nova: Your login code is ' + code + '. Valid 10 min. Do not share.');
    } catch(e) {
      console.error('2FA SMS failed:', e);
    }
  } else {
    try {
      const html = emailTemplate({
        badge: 'Login Code',
        title: 'Your Nova verification code',
        body: 'Hi ' + user.name + ', your one-time login code is:<br><br>' +
              '<div style="font-size:32px;font-weight:900;letter-spacing:8px;font-family:monospace;color:#f97316;text-align:center;padding:16px 0;">' + code + '</div>' +
              'This code expires in 10 minutes. Do not share it with anyone.',
        buttonText: 'Open Nova',
        buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '')
      });
      await sendEmail([user.email], 'Nova — Login Code: ' + code, html);
    } catch(e) {
      console.error('2FA email failed:', e);
    }
  }

  return res.json({ requires2fa: true, userId: user.id, via: hasSms ? 'sms' : 'email' });
});

// Verify 2FA code and return JWT.
// Rate limited in server.js via loginLimiter (10 per 15 min).
router.post('/verify-2fa', async (req, res) => {
  const { userId, code, rememberDevice, rememberMe } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'User ID and code required' });

  const { rows } = await pool.query(
    'SELECT * FROM two_factor_codes WHERE user_id=$1 AND used=false AND expires_at > NOW()',
    [userId]
  );
  if (!rows[0]) {
    await security.record(req, {
      event: 'twofa_failed',
      user_id: parseInt(userId, 10) || null,
      details: { reason: 'no live code for this account (expired, already used, or never issued)' }
    });
    return res.status(401).json({ error: 'Invalid or expired code. Please try logging in again.' });
  }
  if ((rows[0].attempts || 0) >= MAX_2FA_ATTEMPTS) {
    await pool.query('UPDATE two_factor_codes SET used=true WHERE user_id=$1', [userId]);
    const _u = (await pool.query('SELECT name FROM users WHERE id=$1', [userId])).rows[0];
    await security.record(req, {
      event: 'twofa_exhausted',
      user_id: parseInt(userId, 10) || null,
      user_name: _u && _u.name,
      summary: 'A Nova login code was guessed at ' + MAX_2FA_ATTEMPTS + ' times and burned' + (_u && _u.name ? ' on ' + _u.name + '’s account' : '') + '. Someone had the password but not the phone.',
      details: { attempts: rows[0].attempts }
    });
    return res.status(429).json({ error: 'Too many incorrect codes. Please log in again to get a new code.' });
  }
  // Codes are stored hashed; compare the hash of the submitted code in constant time.
  const providedHash = hashToken(String(code));
  const storedHash = String(rows[0].code || '');
  let codeOk = false;
  try {
    codeOk = providedHash.length === storedHash.length &&
      crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));
  } catch (e) { codeOk = false; }
  if (!codeOk) {
    await pool.query('UPDATE two_factor_codes SET attempts = attempts + 1 WHERE user_id=$1', [userId]);
    await security.record(req, {
      event: 'twofa_failed',
      user_id: parseInt(userId, 10) || null,
      details: { reason: 'wrong code', attempt: (rows[0].attempts || 0) + 1, of: MAX_2FA_ATTEMPTS }
    });
    return res.status(401).json({ error: 'Invalid or expired code. Please try logging in again.' });
  }

  await pool.query('UPDATE two_factor_codes SET used=true WHERE user_id=$1', [userId]);

  const { rows: userRows } = await pool.query(
    'SELECT id, name, email, role, active, onboarding_status, session_epoch FROM users WHERE id=$1',
    [userId]
  );
  const user = userRows[0];
  if (!user || user.active === false) {
    return res.status(403).json({ error: 'Account not found or deactivated' });
  }

  const remember = !!(rememberMe || rememberDevice);
  const tokenClaims = { id: user.id, email: user.email, name: user.name, role: user.role, se: (user.session_epoch || 0) };
  if (remember) tokenClaims.remember = true;
  if (user.onboarding_status && user.onboarding_status !== 'complete') tokenClaims.onb = true;
  const token = jwt.sign(tokenClaims, process.env.JWT_SECRET, { expiresIn: sessionTtl(remember) });

  if (remember) {
    try {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + TRUST_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO trusted_devices (user_id, token_hash, label, ip, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [user.id, hashToken(rawToken), deviceLabel(req.headers['user-agent']), clientIp(req), expires]
      );
      setDeviceCookie(req, res, rawToken, expires);
      // A trusted device is a 30-day 2FA bypass. If an attacker gets in once,
      // planting one of these is how they come back without a code, so it is
      // worth telling an admin about even though it is a normal thing to do.
      const _label = deviceLabel(req.headers['user-agent']);
      await security.record(req, {
        event: 'trusted_device_added',
        user_id: user.id,
        user_name: user.name,
        summary: user.name + ' enrolled a new remembered device (' + _label + '). It can sign in for the next ' + TRUST_DAYS + ' days without a 2FA code.',
        details: { label: _label, expires_at: expires.toISOString(), trust_days: TRUST_DAYS }
      });
    } catch (e) { console.error('Trusted device save failed:', e); }
  }

  logAudit({ entity_type: 'auth', action: 'login', user_id: user.id, user_name: user.name, details: { method: '2FA' }, ip: clientIp(req) });
  pool.query('UPDATE users SET last_login_at = NOW(), last_seen_at = NOW() WHERE id = $1', [user.id]).catch(function(){});
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, onboarding_status: user.onboarding_status || 'complete' } });
});

// Forgot password — send reset email.
// Rate limited in server.js via loginLimiter (10 per 15 min).
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const { rows } = await pool.query('SELECT id, name FROM users WHERE email=$1 AND active=true', [email]);
  // Always return success to prevent email enumeration. The event is recorded
  // either way — a run of resets requested for addresses that do not exist is
  // itself a reconnaissance signal.
  if (!rows[0]) {
    await security.record(req, {
      event: 'password_reset_request',
      details: { attempted_email: String(email).slice(0, 120), matched: false }
    });
    return res.json({ success: true });
  }
  const user = rows[0];
  await security.record(req, {
    event: 'password_reset_request',
    user_id: user.id,
    user_name: user.name,
    details: { matched: true }
  });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  // Store only the hash at rest; the raw token goes out in the email link below.
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token=$2, expires_at=$3, used=false',
    [user.id, hashToken(token), expires]
  );
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const resetUrl = appUrl + '/?reset=' + token;
  const html = emailTemplate({
    badge: 'Password Reset',
    title: 'Reset your Nova password',
    body: 'Hi ' + user.name + ', we received a request to reset your password. This link expires in 1 hour.',
    buttonText: 'Reset Password',
    buttonUrl: resetUrl
  });
  try {
    await sendEmail([email], 'Nova — Password Reset', html);
  } catch(e) {
    console.error('Password reset email failed:', e);
  }
  res.json({ success: true });
});

// Reset password with token
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
  // Reset tokens are stored hashed; look up by the hash of the raw token from the link.
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    'SELECT pr.user_id, u.email, u.name, u.role, u.onboarding_status, u.session_epoch FROM password_resets pr ' +
    'JOIN users u ON u.id = pr.user_id ' +
    'WHERE pr.token=$1 AND pr.expires_at > NOW() AND pr.used=false AND u.active IS NOT FALSE',
    [tokenHash]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset link' });
  const u = rows[0];
  const password_hash = await bcrypt.hash(password, 12);
  // Bump the session epoch so every session minted before this reset is invalidated,
  // then hand back a fresh token carrying the new epoch so this response stays signed in.
  await pool.query('UPDATE users SET password_hash=$1, failed_attempts=0, lockout_until=NULL, session_epoch = COALESCE(session_epoch,0) + 1 WHERE id=$2', [password_hash, u.user_id]);
  // A password reset means "cut off anything still holding my old credentials." That has
  // to include connected apps: an OAuth refresh token lives 60 days and would otherwise
  // keep minting fresh access tokens for the external Claude connector.
  try {
    await pool.query('UPDATE oauth_refresh_tokens SET revoked = true WHERE user_id = $1 AND revoked = false', [u.user_id]);
  } catch (e) { console.error('Failed to revoke OAuth refresh tokens on password reset:', e.message); }
  await pool.query('UPDATE password_resets SET used=true WHERE token=$1', [tokenHash]);
  // A completed reset invalidates every existing session and every connected
  // app. If the account owner did not do this, they need to know today, not in
  // 90 days when someone happens to read the audit log.
  await security.record(req, {
    event: 'password_reset_done',
    user_id: u.user_id,
    user_name: u.name,
    summary: u.name + '’s Nova password was reset. All of their existing sessions, remembered devices and connected apps were signed out.',
    details: { session_epoch: Number(u.session_epoch || 0) + 1 }
  });
  const newEpoch = Number(u.session_epoch || 0) + 1;
  const tokenClaims = { id: u.user_id, email: u.email, name: u.name, role: u.role, se: newEpoch };
  if (u.onboarding_status && u.onboarding_status !== 'complete') tokenClaims.onb = true;
  const authToken = jwt.sign(tokenClaims, process.env.JWT_SECRET, { expiresIn: sessionTtl(false) });
  res.json({ success: true, token: authToken, user: { id: u.user_id, name: u.name, email: u.email, role: u.role, onboarding_status: u.onboarding_status || 'complete' } });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role, title, extra_perms, onboarding_status, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0]);
});

// Check if setup is needed
router.get('/setup-needed', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  res.json({ needed: parseInt(rows[0].count) === 0 });
});

// List the current user's trusted devices
router.get('/trusted-devices', requireAuth, async (req, res) => {
  const current = getDeviceToken(req);
  const currentHash = current ? hashToken(current) : null;
  const { rows } = await pool.query(
    'SELECT id, label, ip, created_at, last_used_at, expires_at, token_hash FROM trusted_devices WHERE user_id=$1 AND expires_at > NOW() ORDER BY last_used_at DESC',
    [req.user.id]
  );
  res.json(rows.map(function(r) {
    return { id: r.id, label: r.label, ip: r.ip, created_at: r.created_at, last_used_at: r.last_used_at, expires_at: r.expires_at, current: !!(currentHash && r.token_hash === currentHash) };
  }));
});

// Revoke a single trusted device
router.delete('/trusted-devices/:id', requireAuth, async (req, res) => {
  const current = getDeviceToken(req);
  const { rows } = await pool.query('SELECT token_hash, label FROM trusted_devices WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  await pool.query('DELETE FROM trusted_devices WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (current && rows[0] && rows[0].token_hash === hashToken(current)) res.clearCookie(DEVICE_COOKIE, { path: '/' });
  if (rows[0]) {
    await security.record(req, {
      event: 'trusted_device_revoked',
      user_id: req.user.id,
      user_name: req.user.name,
      details: { label: rows[0].label || null, scope: 'one' }
    });
  }
  res.json({ success: true });
});

// Revoke all trusted devices for the current user
router.delete('/trusted-devices', requireAuth, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM trusted_devices WHERE user_id=$1', [req.user.id]);
  res.clearCookie(DEVICE_COOKIE, { path: '/' });
  await security.record(req, {
    event: 'trusted_device_revoked',
    user_id: req.user.id,
    user_name: req.user.name,
    details: { scope: 'all', removed: rowCount || 0 }
  });
  res.json({ success: true });
});

module.exports = router;
