const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Secure Vault — owner-only, zero-knowledge credential store.
//
// Security model (defense in depth):
//   1. requireAuth          — valid Nova session (rolling JWT).
//   2. requireOwner         — ONLY the real owner role; blocked while previewing
//                             another user (View-As) so impersonation can't reach it.
//   3. Fresh 2FA challenge  — a new SMS/email code, separate from login 2FA.
//   4. Step-up re-auth      — the account password must be re-entered.
//   5. Short-lived gate JWT — issued only after (3)+(4); required on every data call.
//   6. Zero-knowledge crypto — the server stores ONLY salts + ciphertext. The
//      master password, recovery key, data key, and plaintext never leave the
//      browser. A DB dump or env leak reveals nothing.
//   7. Full audit logging   — every gate, unlock, view, copy, change is logged.
// ---------------------------------------------------------------------------

const GATE_TTL_MIN = 15;          // vault gate token lifetime
const CODE_TTL_MIN = 10;          // 2FA challenge code lifetime
const MAX_GATE_ATTEMPTS = 5;      // wrong code/password tries before code is burned

function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || req.ip || null;
}

function audit(req, action, details) {
  logAudit({
    entity_type: 'vault',
    action: action,
    user_id: req.user ? req.user.id : null,
    user_name: req.user ? req.user.name : null,
    details: Object.assign({ ip: clientIp(req) }, details || {})
  });
}

// Only the genuine owner, and not while previewing someone else's data.
function requireOwner(req, res, next) {
  if (!req.user || req.user.isOwner !== true || req.viewingAs) {
    return res.status(403).json({ error: 'Vault access is restricted to the owner.' });
  }
  next();
}

// Verify the short-lived gate token minted by /verify-gate. Without it the
// encrypted blobs are never released, even to the owner.
function requireVaultGate(req, res, next) {
  const t = req.headers['x-vault-token'];
  if (!t) return res.status(401).json({ error: 'Vault is locked.', locked: true });
  let payload;
  try {
    payload = jwt.verify(t, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Vault session expired. Unlock again.', locked: true });
  }
  if (payload.scope !== 'vault' || payload.id !== req.user.id) {
    return res.status(401).json({ error: 'Vault is locked.', locked: true });
  }
  next();
}

// Step 3: issue a fresh 2FA challenge to the owner's phone (or email fallback).
router.post('/challenge', requireAuth, requireOwner, async (req, res) => {
  const { rows } = await pool.query('SELECT id, name, email, phone, receive_sms FROM users WHERE id = $1', [req.user.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + CODE_TTL_MIN * 60 * 1000);
  await pool.query(
    'INSERT INTO vault_challenges (user_id, code, expires_at, attempts, created_at) VALUES ($1, $2, $3, 0, NOW()) ' +
    'ON CONFLICT (user_id) DO UPDATE SET code = $2, expires_at = $3, attempts = 0, created_at = NOW()',
    [user.id, code, expires]
  );

  const hasSms = !!(user.phone && user.receive_sms);
  if (hasSms) {
    try { await sendSms([user.phone], 'Nova Vault: Your unlock code is ' + code + '. Valid ' + CODE_TTL_MIN + ' min. Do not share.'); }
    catch (e) { console.error('Vault challenge SMS failed:', e.message); }
  } else {
    try {
      const html = emailTemplate({
        badge: 'Vault Unlock',
        title: 'Your Nova Vault unlock code',
        body: 'Hi ' + user.name + ', someone is unlocking the secure Vault. Your one-time code is:<br><br>' +
              '<div style="font-size:32px;font-weight:900;letter-spacing:8px;font-family:monospace;color:#f97316;text-align:center;padding:16px 0;">' + code + '</div>' +
              'This code expires in ' + CODE_TTL_MIN + ' minutes. If this was not you, change your password immediately.',
        buttonText: 'Open Nova',
        buttonUrl: (process.env.APP_URL || '').replace(/\/$/, '')
      });
      await sendEmail([user.email], 'Nova Vault — Unlock Code: ' + code, html);
    } catch (e) { console.error('Vault challenge email failed:', e.message); }
  }

  audit(req, 'challenge', { via: hasSms ? 'sms' : 'email' });
  res.json({ via: hasSms ? 'sms' : 'email' });
});

// Steps 4+5: verify the challenge code AND the account password, then mint the
// gate token. Also returns the (encrypted) vault config so the client can begin.
router.post('/verify-gate', requireAuth, requireOwner, async (req, res) => {
  const { code, password } = req.body || {};
  if (!code || !password) return res.status(400).json({ error: 'Code and password are required.' });

  const ch = await pool.query('SELECT code, attempts, expires_at FROM vault_challenges WHERE user_id = $1', [req.user.id]);
  if (!ch.rows[0] || new Date(ch.rows[0].expires_at) <= new Date()) {
    return res.status(401).json({ error: 'No active unlock code. Request a new one.' });
  }
  if ((ch.rows[0].attempts || 0) >= MAX_GATE_ATTEMPTS) {
    await pool.query('DELETE FROM vault_challenges WHERE user_id = $1', [req.user.id]);
    audit(req, 'gate_locked', {});
    return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
  }

  const u = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const passOk = u.rows[0] && await bcrypt.compare(password, u.rows[0].password_hash);
  const codeOk = ch.rows[0].code === String(code);

  if (!passOk || !codeOk) {
    await pool.query('UPDATE vault_challenges SET attempts = attempts + 1 WHERE user_id = $1', [req.user.id]);
    audit(req, 'gate_failed', { reason: !codeOk ? 'code' : 'password' });
    return res.status(401).json({ error: 'Incorrect code or password.' });
  }

  await pool.query('DELETE FROM vault_challenges WHERE user_id = $1', [req.user.id]);

  const vaultToken = jwt.sign({ id: req.user.id, scope: 'vault' }, process.env.JWT_SECRET, { expiresIn: GATE_TTL_MIN + 'm' });

  const cfg = await pool.query('SELECT kdf_salt, kdf_iterations, wrapped_dek FROM vault_config WHERE user_id = $1', [req.user.id]);
  const hasVault = cfg.rows.length > 0;

  audit(req, 'gate_passed', { hasVault: hasVault });
  res.json({
    vaultToken: vaultToken,
    expiresInMin: GATE_TTL_MIN,
    hasVault: hasVault,
    config: hasVault ? {
      kdf_salt: cfg.rows[0].kdf_salt,
      kdf_iterations: cfg.rows[0].kdf_iterations,
      wrapped_dek: cfg.rows[0].wrapped_dek
    } : null
  });
});

// First-time setup: store salts + wrapped data key. Client generated everything.
router.post('/setup', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { kdf_salt, kdf_iterations, wrapped_dek, recovery_salt, wrapped_dek_recovery } = req.body || {};
  if (!kdf_salt || !kdf_iterations || !wrapped_dek) {
    return res.status(400).json({ error: 'Missing vault setup material.' });
  }
  const existing = await pool.query('SELECT user_id FROM vault_config WHERE user_id = $1', [req.user.id]);
  if (existing.rows.length) return res.status(409).json({ error: 'Vault already exists.' });

  await pool.query(
    'INSERT INTO vault_config (user_id, kdf_salt, kdf_iterations, wrapped_dek, recovery_salt, wrapped_dek_recovery, created_at, updated_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())',
    [req.user.id, kdf_salt, parseInt(kdf_iterations, 10), wrapped_dek, recovery_salt || null, wrapped_dek_recovery || null]
  );
  audit(req, 'setup', {});
  res.json({ success: true });
});

// Re-wrap the data key under a new master password and/or recovery key. Used for
// "change master password" (client still holds the DEK) and recovery completion.
router.post('/rekey', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { kdf_salt, kdf_iterations, wrapped_dek, recovery_salt, wrapped_dek_recovery } = req.body || {};
  if (!kdf_salt || !kdf_iterations || !wrapped_dek) {
    return res.status(400).json({ error: 'Missing rekey material.' });
  }
  const existing = await pool.query('SELECT user_id FROM vault_config WHERE user_id = $1', [req.user.id]);
  if (!existing.rows.length) return res.status(404).json({ error: 'No vault to rekey.' });

  if (recovery_salt && wrapped_dek_recovery) {
    await pool.query(
      'UPDATE vault_config SET kdf_salt = $2, kdf_iterations = $3, wrapped_dek = $4, recovery_salt = $5, wrapped_dek_recovery = $6, updated_at = NOW() WHERE user_id = $1',
      [req.user.id, kdf_salt, parseInt(kdf_iterations, 10), wrapped_dek, recovery_salt, wrapped_dek_recovery]
    );
  } else {
    await pool.query(
      'UPDATE vault_config SET kdf_salt = $2, kdf_iterations = $3, wrapped_dek = $4, updated_at = NOW() WHERE user_id = $1',
      [req.user.id, kdf_salt, parseInt(kdf_iterations, 10), wrapped_dek]
    );
  }
  audit(req, 'rekey', { rotatedRecovery: !!(recovery_salt && wrapped_dek_recovery) });
  res.json({ success: true });
});

// Return the recovery blob so the client can attempt recovery-key decryption.
router.get('/recovery-blob', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const r = await pool.query('SELECT recovery_salt, wrapped_dek_recovery FROM vault_config WHERE user_id = $1', [req.user.id]);
  if (!r.rows[0] || !r.rows[0].wrapped_dek_recovery) {
    return res.status(404).json({ error: 'No recovery key is set for this vault.' });
  }
  audit(req, 'recovery_blob_fetched', {});
  res.json({ recovery_salt: r.rows[0].recovery_salt, wrapped_dek_recovery: r.rows[0].wrapped_dek_recovery });
});

// List encrypted entries (opaque to the server).
router.get('/entries', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, iv, ciphertext, created_at, updated_at FROM vault_entries WHERE user_id = $1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  audit(req, 'unlock', { count: rows.length });
  res.json(rows);
});

router.post('/entries', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { iv, ciphertext } = req.body || {};
  if (!iv || !ciphertext) return res.status(400).json({ error: 'Missing encrypted entry.' });
  const { rows } = await pool.query(
    'INSERT INTO vault_entries (user_id, iv, ciphertext, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, created_at, updated_at',
    [req.user.id, iv, ciphertext]
  );
  audit(req, 'create', { entry_id: rows[0].id });
  res.json(rows[0]);
});

router.put('/entries/:id', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { iv, ciphertext } = req.body || {};
  if (!iv || !ciphertext) return res.status(400).json({ error: 'Missing encrypted entry.' });
  const { rowCount } = await pool.query(
    'UPDATE vault_entries SET iv = $3, ciphertext = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2',
    [parseInt(req.params.id, 10), req.user.id, iv, ciphertext]
  );
  if (!rowCount) return res.status(404).json({ error: 'Entry not found.' });
  audit(req, 'update', { entry_id: parseInt(req.params.id, 10) });
  res.json({ success: true });
});

router.delete('/entries/:id', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM vault_entries WHERE id = $1 AND user_id = $2', [parseInt(req.params.id, 10), req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'Entry not found.' });
  audit(req, 'delete', { entry_id: parseInt(req.params.id, 10) });
  res.json({ success: true });
});

// Client-side activity logging (reveal/copy/lock) for the audit trail.
router.post('/audit', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const allowed = { view: 1, reveal: 1, copy: 1, lock: 1, autolock: 1, unlock_failed: 1 };
  const action = String((req.body || {}).action || '');
  if (!allowed[action]) return res.status(400).json({ error: 'Unknown action.' });
  audit(req, action, { entry_id: (req.body || {}).entry_id || null });
  res.json({ success: true });
});

// Destroy the entire vault (owner-initiated reset). Irreversible.
router.delete('/', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  await pool.query('DELETE FROM vault_entries WHERE user_id = $1', [req.user.id]);
  await pool.query('DELETE FROM vault_config WHERE user_id = $1', [req.user.id]);
  audit(req, 'reset', {});
  res.json({ success: true });
});

module.exports = router;
