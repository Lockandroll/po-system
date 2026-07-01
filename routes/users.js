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
    'SELECT id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, hide_from_org, pay_type, supervisor_id, org_level, hire_date, pto_balance_hours, org_x, extra_perms, created_at, last_login_at, last_seen_at FROM users ORDER BY active DESC, name ASC'
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
  const { name, email, password, role, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, pay_type, supervisor_id, title, org_level, hide_from_org, hire_date } = req.body;
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
      'INSERT INTO users (name, email, password_hash, role, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, extra_perms, pay_type, supervisor_id, title, org_level, hide_from_org, hire_date) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, hide_from_org, extra_perms, pay_type, supervisor_id, org_level',
      [name, email, password_hash, role, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms) || [], (pay_type || 'hourly'), (supervisor_id || null), (title || null), (org_level || null), (hide_from_org === true), (hire_date || null)]
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
  const { name, email, role, password, phone, receive_emails, receive_sms, pulsar_name, hide_from_schedule, pay_type, supervisor_id, title, org_level, hide_from_org, hire_date } = req.body;
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
    query = 'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4, phone=$5, receive_emails=$6, receive_sms=$7, pulsar_name=$8, hide_from_schedule=$9, extra_perms=COALESCE($10, extra_perms), pay_type=COALESCE($11, pay_type), supervisor_id=$12, title=$13, org_level=$14, hide_from_org=$15, hire_date=$16 WHERE id=$17 RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, hide_from_org, extra_perms, pay_type, supervisor_id, org_level';
    params = [name, email, role, password_hash, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms), (pay_type || null), (supervisor_id || null), (title || null), (org_level || null), (hide_from_org === true), (hire_date || null), id];
  } else {
    query = 'UPDATE users SET name=$1, email=$2, role=$3, phone=$4, receive_emails=$5, receive_sms=$6, pulsar_name=$7, hide_from_schedule=$8, extra_perms=COALESCE($9, extra_perms), pay_type=COALESCE($10, pay_type), supervisor_id=$11, title=$12, org_level=$13, hide_from_org=$14, hire_date=$15 WHERE id=$16 RETURNING id, name, email, phone, role, title, active, receive_emails, receive_sms, pulsar_name, hide_from_schedule, hide_from_org, extra_perms, pay_type, supervisor_id, org_level';
    params = [name, email, role, phone || null, receive_emails !== false, receive_sms === true, pulsar_name || null, hide_from_schedule === true, cleanExtraPerms(req.body.extra_perms), (pay_type || null), (supervisor_id || null), (title || null), (org_level || null), (hide_from_org === true), (hire_date || null), id];
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

// Lightweight re-parent for the drag-and-drop org chart: updates ONLY the
// reporting line + level, nothing else on the user.
router.patch('/:id/org', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sets = [], vals = []; let i = 1;
  if (Object.prototype.hasOwnProperty.call(req.body, 'supervisor_id')) {
    let s = req.body.supervisor_id;
    s = (s === null || s === undefined || s === '') ? null : parseInt(s, 10);
    if (s === id) return res.status(400).json({ error: 'A person cannot report to themselves.' });
    sets.push('supervisor_id=$' + (i++)); vals.push(s);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'org_level')) {
    let l = req.body.org_level;
    l = (l === null || l === undefined || l === '') ? null : parseInt(l, 10);
    sets.push('org_level=$' + (i++)); vals.push(l);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'org_x')) {
    let x = req.body.org_x;
    x = (x === null || x === undefined || x === '') ? null : Math.round(parseFloat(x));
    sets.push('org_x=$' + (i++)); vals.push(x);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  const { rows } = await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id=$' + i + ' RETURNING id', vals);
  if (!rows.length) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

// ---- Bulk CSV import: create or update users, matched by email --------------
router.post('/import', requireAuth, requirePermission('manage_users'), async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'No rows to import' });
  const HRS = 8;
  const norm = function (v) { return (v === undefined || v === null) ? '' : String(v).trim(); };
  const asBool = function (v, dflt) { const s = norm(v).toLowerCase(); if (s === '') return dflt; return (s === 'true' || s === 'yes' || s === '1' || s === 'y'); };
  const allUsers = (await pool.query('SELECT id, LOWER(email) AS email FROM users')).rows;
  const emailToId = {}; allUsers.forEach(function (u) { emailToId[u.email] = u.id; });

  let created = 0, updated = 0; const errors = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const r = rows[idx] || {};
    const email = norm(r.email).toLowerCase();
    const name = norm(r.name);
    if (!email) { errors.push({ row: idx + 1, error: 'Missing email' }); continue; }
    try {
      const role = norm(r.role).toLowerCase();
      if (role && !VALID_ROLES.includes(role)) { errors.push({ row: idx + 1, email: email, error: 'Invalid role: ' + role }); continue; }
      const pay_type = ['hourly', 'salary', 'commission'].indexOf(norm(r.pay_type).toLowerCase()) !== -1 ? norm(r.pay_type).toLowerCase() : null;
      const phone = norm(r.phone) || null;
      const title = norm(r.title) || null;
      const org_level = norm(r.org_level) ? (parseInt(r.org_level, 10) || null) : null;
      const hire_date = /^\d{4}-\d{2}-\d{2}$/.test(norm(r.hire_date)) ? norm(r.hire_date) : null;
      const supEmail = norm(r.supervisor_email).toLowerCase();
      const supervisor_id = supEmail ? (emailToId[supEmail] || null) : null;
      if (supEmail && !supervisor_id) errors.push({ row: idx + 1, email: email, error: 'Supervisor not found: ' + supEmail + ' (left blank)' });
      const balRaw = norm(r.pto_balance_days);
      const setBal = balRaw !== '' && !isNaN(Number(balRaw));
      const recvE = asBool(r.receive_emails, true);
      const recvS = asBool(r.receive_sms, false);

      let userId = emailToId[email];
      if (userId) {
        const sets = ['email = $1']; const vals = [email]; let p = 2;
        if (name) { sets.push('name = $' + p); vals.push(name); p++; }
        if (role) { sets.push('role = $' + p); vals.push(role); p++; }
        if (phone !== null) { sets.push('phone = $' + p); vals.push(phone); p++; }
        if (title !== null) { sets.push('title = $' + p); vals.push(title); p++; }
        if (pay_type) { sets.push('pay_type = $' + p); vals.push(pay_type); p++; }
        if (org_level !== null) { sets.push('org_level = $' + p); vals.push(org_level); p++; }
        if (hire_date) { sets.push('hire_date = $' + p); vals.push(hire_date); p++; }
        if (supervisor_id) { sets.push('supervisor_id = $' + p); vals.push(supervisor_id); p++; }
        if (norm(r.receive_emails) !== '') { sets.push('receive_emails = $' + p); vals.push(recvE); p++; }
        if (norm(r.receive_sms) !== '') { sets.push('receive_sms = $' + p); vals.push(recvS); p++; }
        vals.push(userId);
        await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id = $' + p, vals);
        updated++;
      } else {
        if (!name) { errors.push({ row: idx + 1, email: email, error: 'New user needs a name' }); continue; }
        const roleFinal = role || 'locksmith';
        if (roleFinal === 'owner') { errors.push({ row: idx + 1, email: email, error: 'Cannot bulk-create an owner' }); continue; }
        const password_hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
        const ins = await pool.query(
          'INSERT INTO users (name, email, password_hash, role, phone, receive_emails, receive_sms, pay_type, supervisor_id, title, org_level, hire_date) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id',
          [name, email, password_hash, roleFinal, phone, recvE, recvS, (pay_type || 'hourly'), supervisor_id, title, org_level, hire_date]
        );
        userId = ins.rows[0].id;
        emailToId[email] = userId;
        created++;
      }

      if (norm(r.cities) !== '') { try { await setUserCities(userId, norm(r.cities).split(/[;|]/)); } catch (e) { /* ignore city errors */ } }

      if (setBal) {
        const targetHours = Number(balRaw) * HRS;
        const cur = await pool.query('SELECT COALESCE(pto_balance_hours,0) AS b FROM users WHERE id = $1', [userId]);
        const delta = targetHours - Number(cur.rows[0].b);
        if (delta !== 0) {
          await pool.query(
            'INSERT INTO pto_ledger (user_id, entry_date, kind, amount_hours, description, created_by) ' +
            "VALUES ($1, CURRENT_DATE, 'adjustment', $2, $3, $4)",
            [userId, delta, 'Opening balance set to ' + Number(balRaw) + ' days (CSV import)', req.user.id]
          );
          await pool.query('UPDATE users SET pto_balance_hours = $1 WHERE id = $2', [targetHours, userId]);
        }
      }
    } catch (e) {
      errors.push({ row: idx + 1, email: email, error: e.message });
    }
  }
  res.json({ created: created, updated: updated, errors: errors });
});

module.exports = router;
