const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

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
  res.json({ token, user });
});

// Login with lockout and 2FA
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];

  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Check lockout
  if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
    const mins = Math.ceil((new Date(user.lockout_until) - new Date()) / 60000);
    return res.status(423).json({ error: 'Account locked due to too many failed attempts. Try again in ' + mins + ' minute(s).' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);

  if (!valid) {
    const attempts = (user.failed_attempts || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      const lockout_until = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      await pool.query('UPDATE users SET failed_attempts=$1, lockout_until=$2 WHERE id=$3', [attempts, lockout_until, user.id]);
      return res.status(423).json({ error: 'Too many failed attempts. Account locked for ' + LOCKOUT_MINUTES + ' minutes.' });
    }
    await pool.query('UPDATE users SET failed_attempts=$1 WHERE id=$2', [attempts, user.id]);
    return res.status(401).json({ error: 'Invalid email or password. ' + (MAX_ATTEMPTS - attempts) + ' attempt(s) remaining.' });
  }

  if (user.active === false) {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact an administrator.' });
  }

  // Reset lockout on success
  await pool.query('UPDATE users SET failed_attempts=0, lockout_until=NULL WHERE id=$1', [user.id]);

  // Generate and send 2FA code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  await pool.query(
    'INSERT INTO two_factor_codes (user_id, code, expires_at) VALUES ($1, $2, $3) ' +
    'ON CONFLICT (user_id) DO UPDATE SET code=$2, expires_at=$3, used=false',
    [user.id, code, codeExpires]
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

// Verify 2FA code and return JWT
router.post('/verify-2fa', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'User ID and code required' });

  const { rows } = await pool.query(
    'SELECT * FROM two_factor_codes WHERE user_id=$1 AND used=false AND expires_at > NOW()',
    [userId]
  );
  if (!rows[0] || rows[0].code !== String(code)) {
    return res.status(401).json({ error: 'Invalid or expired code. Please try logging in again.' });
  }

  await pool.query('UPDATE two_factor_codes SET used=true WHERE user_id=$1', [userId]);

  const { rows: userRows } = await pool.query(
    'SELECT id, name, email, role, active FROM users WHERE id=$1',
    [userId]
  );
  const user = userRows[0];
  if (!user || user.active === false) {
    return res.status(403).json({ error: 'Account not found or deactivated' });
  }

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// Forgot password — send reset email
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const { rows } = await pool.query('SELECT id, name FROM users WHERE email=$1 AND active=true', [email]);
  // Always return success to prevent email enumeration
  if (!rows[0]) return res.json({ success: true });
  const user = rows[0];
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token=$2, expires_at=$3, used=false',
    [user.id, token, expires]
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
  const { rows } = await pool.query(
    'SELECT pr.user_id FROM password_resets pr WHERE pr.token=$1 AND pr.expires_at > NOW() AND pr.used=false',
    [token]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset link' });
  const password_hash = await bcrypt.hash(password, 12);
  await pool.query('UPDATE users SET password_hash=$1, failed_attempts=0, lockout_until=NULL WHERE id=$2', [password_hash, rows[0].user_id]);
  await pool.query('UPDATE password_resets SET used=true WHERE token=$1', [token]);
  res.json({ success: true });
});

// Get current user
router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, role, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json(rows[0]);
});

// Check if setup is needed
router.get('/setup-needed', async (req, res) => {
  const { rows } = await pool.query('SELECT COUNT(*) FROM users');
  res.json({ needed: parseInt(rows[0].count) === 0 });
});

module.exports = router;
