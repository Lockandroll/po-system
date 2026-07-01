const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { sendEmail, emailTemplate } = require('../utils/email');

const router = express.Router();

const VALID_ROLES = ['locksmith', 'locksmith_coordinator', 'roadside_technician', 'manager', 'admin', 'owner'];

const ROLE_LABELS = {
  locksmith: 'Locksmith',
  locksmith_coordinator: 'Locksmith Coordinator',
  roadside_technician: 'Roadside Technician',
  manager: 'Manager',
  admin: 'Admin',
  owner: 'Owner'
};

async function setUserCities(userId, codes) {
  if (!Array.isArray(codes)) return null;
  const clean = Array.from(new Set(codes.map(function (c) { return String(c || '').trim().slice(0, 3); }).filter(Boolean)));
  await pool.query('DELETE FROM user_cities WHERE user_id=$1', [userId]);
  for (const c of clean) await pool.query('INSERT INTO user_cities (user_id, city_code) VALUES ($1,$2) ON CONFLICT (user_id, city_code) DO NOTHING', [userId, c]);
  return clean;
}

// Create an invite token and email the new user a link to set their own password.
async function sendInvite(user, invitedByName) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token=$2, expires_at=$3, used=false',
    [user.id, token, expires]
  );
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  const inviteUrl = appUrl + '/?reset=' + token;
  const html = emailTemplate({
    badge: 'Welcome',
    badgeColor: 'green',
    title: 'You\'ve been invited to Nova',
    body: 'Hi ' + user.name + ', an account has been created for you' +
          (invitedByName ? ' by ' + invitedByName : '') +
          ' on Nova, the Lock and Roll operations platform. Click below to set your password and finish setting up your account. This link expires in 7 days.',
    details: [
      { label: 'Email', value: user.email },
      { label: 'Role', value: ROLE_LABELS[user.role] || user.role }
    ],
    buttonText: 'Set Your Password',
    buttonUrl: inviteUrl,
    footerNote: 'If you weren\'t expecting this invitation, you can ignore this email.'
  });
  await sendEmail([user.email], 'Welcome to Nova — set your password', html);
}

// List all users (admin only)
router.get('/', requireAuth, requirePermission('view_users'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, pay_type, supervisor_id, org_level, extra_perms, created_at, last_login_at, last_seen_at FROM users ORDER BY active DESC, name ASC'
  );
  const mc = await pool.query('SELECT user_id, city_code FROM user_cities');
  const byU = {};
  mc.rows.forEach(function (r) { (byU[r.user_id] = byU[r.user_id] || []).push((r.city_code || '').trim()); });
  rows.forEach(function (u) { u.city_codes = byU[u.id] || []; });
  res.json(rows);
});

// Per-user grantable permissions. Only these may be set via the user form so the
// checkbox UI can never accidentally elevate someone to manage_users/settings.
const GRANTABLE_PERMS = ['manage_schedule'];
function cleanExtraPerms(v) {
  if (!Array.isArray(v)) return null; // null = caller didn't send it; leave unchanged
  const out = [];
  v.forEach(function (p) { if (GRANTABLE_PERMS.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p); });
  return out;
}

// Create user (admin only)
router.post('/', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const { name, email, password, role, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, pay_type, supervisor_id, title, org_level } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: 'Name, email, and role are required' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: ' + VALID_ROLES.join(', ') + '.' });
  }
  if (role === 'owner' && !req.user.isOwner) {
    const _oc = (await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'owner' AND active = true")).rows[0].n;
    if (_oc > 0) return res.status(403).json({ error: 'Only an owner can grant the Owner role.' });
  }
  // Password is optional — if none is set, the user picks one via the invite link.
  // A random hash is stored so the account can never be logged into until the invite is used.
  const rawPassword = password || crypto.randomBytes(24).toString('hex');
  const password_hash = await bcrypt.hash(rawPassword, 12);
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, extra_perms, pay_type, supervisor_id, title, org_level) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, extra_perms, pay_type, supervisor_id, org_level',
      [name, email, password_hash, role, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms) || [], (pay_type || 'hourly'), (supervisor_id || null), (title || null), (org_level || null)]
    );
    const newUser = rows[0];
    newUser.city_codes = (await setUserCities(newUser.id, req.body.city_codes)) || [];
    try {
      await sendInvite(newUser, req.user && req.user.name);
    } catch (e) {
      console.error('Invite email failed:', e);
    }
    res.status(201).json(newUser);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already in use' });
    throw err;
  }
});

// Update user (admin only)
router.put('/:id', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const { name, email, role, password, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, pay_type, supervisor_id, title, org_level } = req.body;
  const { id } = req.params;
  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be one of: ' + VALID_ROLES.join(', ') + '.' });
  }
  const _target = (await pool.query('SELECT role FROM users WHERE id=$1', [id])).rows[0];
  if (_target && _target.role === 'owner' && !req.user.isOwner) {
    return res.status(403).json({ error: 'Only an owner can manage owner accounts.' });
  }
  if (role === 'owner' && (!_target || _target.role !== 'owner') && !req.user.isOwner) {
    const _oc = (await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'owner' AND active = true")).rows[0].n;
    if (_oc > 0) return res.status(403).json({ error: 'Only an owner can grant the Owner role.' });
  }
  let query, params;
  if (password) {
    const password_hash = await bcrypt.hash(password, 12);
    query = 'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4, phone=$5, receive_emails=$6, receive_sms=$7, pulsar_name=$8, hide_from_schedule=$9, extra_perms=COALESCE($10, extra_perms), pay_type=COALESCE($11, pay_type), supervisor_id=$12, title=$13, org_level=$14 WHERE id=$15 RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, extra_perms, pay_type, supervisor_id, org_level';
    params = [name, email, role, password_hash, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms), (pay_type || null), (supervisor_id || null), (title || null), (org_level || null), id];
  } else {
    query = 'UPDATE users SET name=$1, email=$2, role=$3, phone=$4, receive_emails=$5, receive_sms=$6, pulsar_name=$7, hide_from_schedule=$8, extra_perms=COALESCE($9, extra_perms), pay_type=COALESCE($10, pay_type), supervisor_id=$11, title=$12, org_level=$13 WHERE id=$14 RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, extra_perms, pay_type, supervisor_id, org_level';
    params = [name, email, role, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms), (pay_type || null), (supervisor_id || null), (title || null), (org_level || null), id];
  }
  try {
    const { rows } = await pool.query(query, params);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    const _cc = await setUserCities(rows[0].id, req.body.city_codes);
    if (_cc) rows[0].city_codes = _cc;
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Email already in use' });
    throw err;
  }
});

// Deactivate user (admin only)
router.post('/:id/deactivate', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot deactivate your own account' });
  }
  const _t = (await pool.query('SELECT role FROM users WHERE id=$1', [id])).rows[0];
  if (_t && _t.role === 'owner' && !req.user.isOwner) return res.status(403).json({ error: 'Only an owner can deactivate an owner account.' });
  const { rows } = await pool.query('UPDATE users SET active=false WHERE id=$1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Reactivate user (admin only)
router.post('/:id/reactivate', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query('UPDATE users SET active=true WHERE id=$1 RETURNING id', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
});

// Delete user (admin only — only if no POs)
router.delete('/:id', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const _t2 = (await pool.query('SELECT role FROM users WHERE id=$1', [id])).rows[0];
  if (_t2 && _t2.role === 'owner' && !req.user.isOwner) return res.status(403).json({ error: 'Only an owner can delete an owner account.' });
  const { rows: poRows } = await pool.query('SELECT COUNT(*) FROM purchase_orders WHERE requester_id=$1', [id]);
  if (parseInt(poRows[0].count) > 0) {
    return res.status(400).json({ error: 'Cannot delete user — they have existing purchase orders. Deactivate instead.' });
  }
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Cannot delete user — they have related records (quotes, repairs, deposits, etc.). Deactivate instead.' });
    }
    throw err;
  }
  res.json({ success: true });
});

module.exports = router;
