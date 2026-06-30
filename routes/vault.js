const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');
const { sendSms } = require('../utils/sms');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Secure Vault — owner-only, SHARED, zero-knowledge credential store.
//
// One shared data key (DEK) encrypts every entry. Each owner has a personal
// keypair; the shared DEK is wrapped to each owner's PUBLIC key, and each
// owner's PRIVATE key is encrypted under their own master password (and their
// own recovery key). The server therefore stores ONLY: salts, public keys and
// ciphertext. Master passwords, recovery keys, private keys, the DEK, and all
// plaintext live solely in each owner's browser.
//
// Layered access control (every layer enforced server-side):
//   1. requireAuth        — valid Nova session.
//   2. requireOwner       — only the real owner role, never while previewing.
//   3. Fresh 2FA + step-up password — minted into a short-lived gate JWT.
//   4. requireVaultGate   — that gate JWT on every data call.
//   5. requireActiveMember — must be an APPROVED member of the shared vault.
//   6. Full audit logging.
//
// New owners are admitted ("enrolled") by an existing active owner wrapping the
// shared DEK to the newcomer's public key — done entirely in the browser, so the
// server never sees the DEK in the clear.
// ---------------------------------------------------------------------------

const GATE_TTL_MIN = 15;
const CODE_TTL_MIN = 10;
const MAX_GATE_ATTEMPTS = 5;

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

function requireOwner(req, res, next) {
  if (!req.user || req.user.isOwner !== true || req.viewingAs) {
    return res.status(403).json({ error: 'Vault access is restricted to owners.' });
  }
  next();
}

function requireVaultGate(req, res, next) {
  const t = req.headers['x-vault-token'];
  if (!t) return res.status(401).json({ error: 'Vault is locked.', locked: true });
  let payload;
  try { payload = jwt.verify(t, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Vault session expired. Unlock again.', locked: true }); }
  if (payload.scope !== 'vault' || payload.id !== req.user.id) {
    return res.status(401).json({ error: 'Vault is locked.', locked: true });
  }
  next();
}

// Must be an APPROVED member of the shared vault.
async function requireActiveMember(req, res, next) {
  const r = await pool.query("SELECT status FROM vault_members WHERE user_id = $1", [req.user.id]);
  if (!r.rows[0] || r.rows[0].status !== 'active') {
    return res.status(403).json({ error: 'You are not an active member of the vault.', notMember: true });
  }
  next();
}

async function vaultExists() {
  const r = await pool.query("SELECT 1 FROM vault_members WHERE status = 'active' LIMIT 1");
  return r.rows.length > 0;
}

// Step 3a: send a fresh one-time code to the owner.
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

// Steps 3b+3c: verify the code AND the account password, mint the gate token,
// and report whether a vault exists and what this owner's membership looks like.
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

  const exists = await vaultExists();
  const m = await pool.query(
    'SELECT status, kdf_salt, kdf_iterations, enc_private_key, wrapped_dek, public_key FROM vault_members WHERE user_id = $1',
    [req.user.id]
  );
  const membership = m.rows[0] || null;

  audit(req, 'gate_passed', { vaultExists: exists, member: membership ? membership.status : 'none' });
  res.json({
    vaultToken: vaultToken,
    expiresInMin: GATE_TTL_MIN,
    vaultExists: exists,
    membership: membership
  });
});

// First owner creates the shared vault (allowed only when none exists yet).
router.post('/setup', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { public_key, kdf_salt, kdf_iterations, enc_private_key, wrapped_dek, recovery_salt, enc_private_key_recovery } = req.body || {};
  if (!public_key || !kdf_salt || !kdf_iterations || !enc_private_key || !wrapped_dek) {
    return res.status(400).json({ error: 'Missing vault setup material.' });
  }
  if (await vaultExists()) return res.status(409).json({ error: 'A vault already exists. Request access instead.' });

  await pool.query(
    'INSERT INTO vault_members (user_id, status, public_key, kdf_salt, kdf_iterations, enc_private_key, wrapped_dek, recovery_salt, enc_private_key_recovery, approved_by, approved_at, created_at, updated_at) ' +
    "VALUES ($1, 'active', $2, $3, $4, $5, $6, $7, $8, $1, NOW(), NOW(), NOW()) " +
    'ON CONFLICT (user_id) DO UPDATE SET status=\'active\', public_key=$2, kdf_salt=$3, kdf_iterations=$4, enc_private_key=$5, wrapped_dek=$6, recovery_salt=$7, enc_private_key_recovery=$8, approved_by=$1, approved_at=NOW(), updated_at=NOW()',
    [req.user.id, public_key, kdf_salt, parseInt(kdf_iterations, 10), enc_private_key, wrapped_dek, recovery_salt || null, enc_private_key_recovery || null]
  );
  audit(req, 'setup', {});
  res.json({ success: true });
});

// A new owner requests access: they publish their public key and store their own
// (encrypted) private key. They get the DEK only once an existing owner approves.
router.post('/enroll-request', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { public_key, kdf_salt, kdf_iterations, enc_private_key, recovery_salt, enc_private_key_recovery } = req.body || {};
  if (!public_key || !kdf_salt || !kdf_iterations || !enc_private_key) {
    return res.status(400).json({ error: 'Missing enrollment material.' });
  }
  if (!(await vaultExists())) return res.status(409).json({ error: 'No vault exists yet.' });

  const existing = await pool.query('SELECT status FROM vault_members WHERE user_id = $1', [req.user.id]);
  if (existing.rows[0] && existing.rows[0].status === 'active') {
    return res.status(409).json({ error: 'You are already a member.' });
  }

  await pool.query(
    'INSERT INTO vault_members (user_id, status, public_key, kdf_salt, kdf_iterations, enc_private_key, wrapped_dek, recovery_salt, enc_private_key_recovery, created_at, updated_at) ' +
    "VALUES ($1, 'pending', $2, $3, $4, $5, NULL, $6, $7, NOW(), NOW()) " +
    'ON CONFLICT (user_id) DO UPDATE SET status=\'pending\', public_key=$2, kdf_salt=$3, kdf_iterations=$4, enc_private_key=$5, wrapped_dek=NULL, recovery_salt=$6, enc_private_key_recovery=$7, updated_at=NOW()',
    [req.user.id, public_key, kdf_salt, parseInt(kdf_iterations, 10), enc_private_key, recovery_salt || null, enc_private_key_recovery || null]
  );

  // Notify existing active owners that someone is waiting.
  try {
    const owners = await pool.query("SELECT u.email, u.name FROM vault_members vm JOIN users u ON u.id = vm.user_id WHERE vm.status = 'active'");
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    for (let i = 0; i < owners.rows.length; i++) {
      const html = emailTemplate({
        badge: 'Vault Access Request',
        title: 'An owner is requesting Vault access',
        body: (req.user.name || 'An owner') + ' has requested access to the shared Vault. Open the Vault and approve them if this is expected.',
        buttonText: 'Open Vault',
        buttonUrl: appUrl
      });
      sendEmail([owners.rows[i].email], 'Nova Vault — Access requested by ' + (req.user.name || 'an owner'), html).catch(function(){});
    }
  } catch (e) { console.error('Enroll notify failed:', e.message); }

  audit(req, 'enroll_request', {});
  res.json({ success: true });
});

// Existing active owner lists pending requests (with public keys to wrap to).
router.get('/pending', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT vm.user_id, vm.public_key, vm.created_at, u.name, u.email FROM vault_members vm JOIN users u ON u.id = vm.user_id WHERE vm.status = 'pending' ORDER BY vm.created_at",
    []
  );
  res.json(rows);
});

// Existing active owner approves a pending owner by handing over the DEK wrapped
// to that owner's public key (computed in the approver's browser).
router.post('/approve/:userId', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  const { wrapped_dek } = req.body || {};
  if (!wrapped_dek) return res.status(400).json({ error: 'Missing wrapped key.' });

  const t = await pool.query('SELECT status FROM vault_members WHERE user_id = $1', [targetId]);
  if (!t.rows[0] || t.rows[0].status !== 'pending') {
    return res.status(404).json({ error: 'No pending request for that user.' });
  }
  await pool.query(
    "UPDATE vault_members SET status = 'active', wrapped_dek = $2, approved_by = $3, approved_at = NOW(), updated_at = NOW() WHERE user_id = $1",
    [targetId, wrapped_dek, req.user.id]
  );
  audit(req, 'approve_member', { target_user_id: targetId });
  res.json({ success: true });
});

// Deny a pending request, or revoke an existing member's access. Note: revoking
// removes that owner's copy of the key; rotate the vault afterward for full
// forward security if the person should never decrypt old data again.
router.post('/revoke/:userId', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const targetId = parseInt(req.params.userId, 10);
  if (targetId === req.user.id) return res.status(400).json({ error: 'Use Leave Vault to remove yourself.' });
  const active = await pool.query("SELECT COUNT(*)::int AS n FROM vault_members WHERE status = 'active'");
  const target = await pool.query('SELECT status FROM vault_members WHERE user_id = $1', [targetId]);
  if (!target.rows[0]) return res.status(404).json({ error: 'Not a member.' });
  if (target.rows[0].status === 'active' && active.rows[0].n <= 1) {
    return res.status(400).json({ error: 'Cannot remove the last active owner.' });
  }
  await pool.query('DELETE FROM vault_members WHERE user_id = $1', [targetId]);
  audit(req, 'revoke_member', { target_user_id: targetId });
  res.json({ success: true });
});

// Member directory (for the manage-owners panel).
router.get('/members', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT vm.user_id, vm.status, vm.approved_at, u.name, u.email FROM vault_members vm JOIN users u ON u.id = vm.user_id ORDER BY vm.status, u.name',
    []
  );
  res.json(rows);
});

// Return this owner's recovery blob so they can recover with their recovery key.
router.get('/recovery-blob', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const r = await pool.query('SELECT recovery_salt, enc_private_key_recovery, wrapped_dek FROM vault_members WHERE user_id = $1', [req.user.id]);
  if (!r.rows[0] || !r.rows[0].enc_private_key_recovery) {
    return res.status(404).json({ error: 'No recovery key is set for your membership.' });
  }
  audit(req, 'recovery_blob_fetched', {});
  res.json({ recovery_salt: r.rows[0].recovery_salt, enc_private_key_recovery: r.rows[0].enc_private_key_recovery, wrapped_dek: r.rows[0].wrapped_dek });
});

// Re-encrypt this owner's own private key under a new master password (and/or
// recovery key). The shared DEK and other members are untouched.
router.post('/rekey', requireAuth, requireOwner, requireVaultGate, async (req, res) => {
  const { kdf_salt, kdf_iterations, enc_private_key, recovery_salt, enc_private_key_recovery } = req.body || {};
  if (!kdf_salt || !kdf_iterations || !enc_private_key) {
    return res.status(400).json({ error: 'Missing rekey material.' });
  }
  const existing = await pool.query('SELECT user_id FROM vault_members WHERE user_id = $1', [req.user.id]);
  if (!existing.rows.length) return res.status(404).json({ error: 'No membership to rekey.' });

  if (recovery_salt && enc_private_key_recovery) {
    await pool.query(
      'UPDATE vault_members SET kdf_salt=$2, kdf_iterations=$3, enc_private_key=$4, recovery_salt=$5, enc_private_key_recovery=$6, updated_at=NOW() WHERE user_id=$1',
      [req.user.id, kdf_salt, parseInt(kdf_iterations, 10), enc_private_key, recovery_salt, enc_private_key_recovery]
    );
  } else {
    await pool.query(
      'UPDATE vault_members SET kdf_salt=$2, kdf_iterations=$3, enc_private_key=$4, updated_at=NOW() WHERE user_id=$1',
      [req.user.id, kdf_salt, parseInt(kdf_iterations, 10), enc_private_key]
    );
  }
  audit(req, 'rekey', { rotatedRecovery: !!(recovery_salt && enc_private_key_recovery) });
  res.json({ success: true });
});

// Leave the vault (remove your own membership). Last active owner can't leave
// without resetting the vault.
router.post('/leave', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const active = await pool.query("SELECT COUNT(*)::int AS n FROM vault_members WHERE status = 'active'");
  if (active.rows[0].n <= 1) return res.status(400).json({ error: 'You are the last owner. Reset the vault instead.' });
  await pool.query('DELETE FROM vault_members WHERE user_id = $1', [req.user.id]);
  audit(req, 'leave', {});
  res.json({ success: true });
});

// ---- shared entries (every active member sees the same set) ----------------
router.get('/entries', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { rows } = await pool.query('SELECT id, iv, ciphertext, created_at, updated_at FROM vault_entries ORDER BY updated_at DESC', []);
  audit(req, 'unlock', { count: rows.length });
  res.json(rows);
});

router.post('/entries', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { iv, ciphertext } = req.body || {};
  if (!iv || !ciphertext) return res.status(400).json({ error: 'Missing encrypted entry.' });
  const { rows } = await pool.query(
    'INSERT INTO vault_entries (user_id, iv, ciphertext, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, created_at, updated_at',
    [req.user.id, iv, ciphertext]
  );
  audit(req, 'create', { entry_id: rows[0].id });
  res.json(rows[0]);
});

router.put('/entries/:id', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { iv, ciphertext } = req.body || {};
  if (!iv || !ciphertext) return res.status(400).json({ error: 'Missing encrypted entry.' });
  const { rowCount } = await pool.query(
    'UPDATE vault_entries SET iv = $2, ciphertext = $3, updated_at = NOW() WHERE id = $1',
    [parseInt(req.params.id, 10), iv, ciphertext]
  );
  if (!rowCount) return res.status(404).json({ error: 'Entry not found.' });
  audit(req, 'update', { entry_id: parseInt(req.params.id, 10) });
  res.json({ success: true });
});

router.delete('/entries/:id', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM vault_entries WHERE id = $1', [parseInt(req.params.id, 10)]);
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

// Destroy the ENTIRE shared vault — every entry and every member. Irreversible.
router.delete('/', requireAuth, requireOwner, requireVaultGate, requireActiveMember, async (req, res) => {
  await pool.query('DELETE FROM vault_entries', []);
  await pool.query('DELETE FROM vault_members', []);
  audit(req, 'reset', {});
  res.json({ success: true });
});

module.exports = router;
