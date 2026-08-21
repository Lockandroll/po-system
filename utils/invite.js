// Invite email — the "set your password" link a brand-new Nova account gets.
//
// This used to live inside routes/users.js. It moved here when the New Hires
// roster grew its own "Resend invite" button (a hire deleted the original email
// and there was no way to send another one without going to Users → find them →
// Resend). Two routers now send the exact same email:
//
//   routes/users.js      create user · create new hire · bulk import · Users → Resend invite
//   routes/onboarding.js New Hires roster → Resend invite
//
// One copy so the 7-day expiry, the wording and the token hashing can never
// drift apart between the two paths.
//
// House style: string concatenation, no template literals (see CLAUDE.md §1.1).

const crypto = require('crypto');
const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('./email');

// Same sha256 helper as routes/auth.js and routes/users.js — invite/reset tokens
// are stored HASHED at rest; only the raw token is ever emailed.
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

const ROLE_LABELS = {
  locksmith: 'Locksmith',
  locksmith_coordinator: 'Locksmith Coordinator',
  dispatcher: 'Dispatcher',
  roadside_technician: 'Roadside Technician',
  manager: 'Manager',
  admin: 'Admin',
  owner: 'Owner'
};

// Mint a fresh set-password token and email the link.
//
// Note this does NOT touch users.password_hash. If the person already has a
// working password it keeps working until they actually click the link — which
// is what makes it safe to resend to a hire who has logged in before.
//
// password_resets is keyed on user_id (ON CONFLICT DO UPDATE), so each resend
// silently retires the previous link. Deliberate: an old link left live in an
// inbox is a standing way into the account.
//
// Returns true if Resend accepted the message, false if it did not. Callers that
// only fire-and-forget can ignore it; the resend buttons use it so the admin is
// not told "sent" when nothing left the building.
async function sendInvite(user, invitedByName) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  await pool.query(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET token=$2, expires_at=$3, used=false',
    [user.id, hashToken(token), expires]
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
  return await sendEmail([user.email], 'Welcome to Nova — set your password', html);
}

module.exports = { sendInvite, ROLE_LABELS };
