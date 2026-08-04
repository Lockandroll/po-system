// Nova security event recording, alerting and burst detection.
//
// WHY THIS FILE EXISTS
// Until 2026-08 a failed login left no trace anywhere in Nova: routes/auth.js
// incremented users.failed_attempts and returned, and that counter was reset to
// zero on the next successful login. A finished credential-stuffing run was
// therefore completely invisible after the fact. This module is the single
// place every security-relevant event is written down, and the single place
// that decides whether a human needs to be told about it.
//
// Three rules govern everything here:
//   1. Nothing in this file may ever throw into a request. A broken alert must
//      never stop someone from logging in. Every export swallows its own errors.
//   2. Nothing here blocks the response. Alerts are fired and forgotten.
//   3. Recording is unconditional; ALERTING is throttled. A brute-force run
//      should produce a full audit trail but at most one text message.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). String concatenation only.

const { pool } = require('../db');
const { logAudit } = require('./audit');
const notify = require('./notify');
const { sendEmail, emailTemplate } = require('./email');
const { sendSms } = require('./sms');

// Every security event Nova can raise. alertKey is the notification_rules key
// an admin can point at specific people in Settings -> Notifications; when no
// rule is configured the event falls back to defaultWhere. Events with no
// alertKey are recorded to the audit log only, never sent anywhere.
//
// The sms flag marks the events urgent enough to be worth a text at 2am. Deliberately
// only two: an account being locked out, and a burst across several accounts.
const EVENTS = {
  failed_login:            { label: 'Failed login' },
  login_locked_out:        { label: 'Login attempt on a locked account' },
  login_unknown_email:     { label: 'Login attempt for an unknown email' },
  login_inactive:          { label: 'Login attempt on a deactivated account' },
  account_locked:          { label: 'Account locked', alertKey: 'security_lockout', sms: true },
  twofa_failed:            { label: 'Wrong 2FA code' },
  twofa_exhausted:         { label: '2FA code burned after too many wrong tries', alertKey: 'security_lockout', sms: true },
  password_reset_request:  { label: 'Password reset requested' },
  password_reset_done:     { label: 'Password reset completed', alertKey: 'security_password_reset' },
  trusted_device_added:    { label: 'New trusted device (30-day 2FA bypass)', alertKey: 'security_new_device' },
  trusted_device_revoked:  { label: 'Trusted device revoked' },
  role_changed:            { label: 'Role or permissions changed', alertKey: 'security_role_changed' },
  user_created:            { label: 'User account created', alertKey: 'security_role_changed' },
  user_deactivated:        { label: 'User account deactivated' },
  user_reactivated:        { label: 'User account reactivated', alertKey: 'security_role_changed' },
  user_deleted:            { label: 'User account deleted', alertKey: 'security_role_changed' },
  users_bulk_imported:     { label: 'Users bulk-imported from CSV', alertKey: 'security_role_changed' },
  admin_unlocked_account:  { label: 'Admin cleared an account lockout' },
  admin_forced_signout:    { label: 'Admin forced a user to sign out everywhere' },
  attack_burst:            { label: 'Multiple accounts locked out at once', alertKey: 'security_lockout', sms: true },
  lockdown_engaged:        { label: 'Automatic lockdown engaged', alertKey: 'security_lockout', sms: true },
  // Connected apps (the OAuth 2.1 server behind the remote MCP). This whole
  // surface used to write nothing at all: client registration is unauthenticated
  // by protocol design, and token issuance had no audit anywhere.
  oauth_client_registered: { label: 'New connected app registered', alertKey: 'security_oauth' },
  oauth_connected:         { label: 'Someone connected an app to their account', alertKey: 'security_oauth' },
  oauth_failed_login:      { label: 'Failed login on the connect-an-app screen' },
  oauth_account_locked:    { label: 'Account locked from the connect-an-app screen', alertKey: 'security_lockout', sms: true },
  // A refresh token that was already rotated away being presented again means
  // somebody kept a copy. Standard OAuth token-theft detection.
  oauth_refresh_reuse:     { label: 'Revoked refresh token replayed', alertKey: 'security_oauth', sms: true },
  oauth_tokens_revoked:    { label: 'Connected app tokens revoked' },
  cors_blocked:            { label: 'Cross-origin request from an unapproved site' }
};

// Who hears about a security event when nobody has customised the rule. Trusted
// constant, never built from user input (it is interpolated into SQL by
// notify.broadcastRecipients).
const DEFAULT_SECURITY_AUDIENCE = "role IN ('admin', 'owner')";

// ---------------------------------------------------------------------------
// Client IP
// ---------------------------------------------------------------------------
// server.js sets trust proxy to 1, so req.ip is already the real client as far
// as Railway's edge is concerned. x-forwarded-for is read first anyway because
// the header is what the rest of the app has always recorded and changing it
// would make new rows incomparable with the historical ones.
function clientIp(req) {
  if (!req) return null;
  try {
    const fwd = ((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    return fwd || req.ip || null;
  } catch (e) { return null; }
}

function userAgent(req) {
  try { return String((req.headers && req.headers['user-agent']) || '').slice(0, 300) || null; }
  catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Alert throttle
// ---------------------------------------------------------------------------
// In-memory and therefore reset on every deploy, which is fine: its only job is
// to stop one brute-force run from sending fifty texts. Losing the state means
// at worst one extra alert after a restart. Keyed by event + subject so two
// different accounts locking out still produce two alerts.
const ALERT_WINDOW_MS = 30 * 60 * 1000;
const _lastAlert = new Map();

function alertThrottled(key) {
  const now = Date.now();
  const prev = _lastAlert.get(key);
  if (prev && (now - prev) < ALERT_WINDOW_MS) return true;
  _lastAlert.set(key, now);
  // Opportunistic sweep so the map cannot grow without bound on a long uptime.
  if (_lastAlert.size > 500) {
    for (const [k, t] of _lastAlert) { if ((now - t) > ALERT_WINDOW_MS) _lastAlert.delete(k); }
  }
  return false;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------
// record(req, opts) -> Promise<void>, never rejects.
//
//   event       key into EVENTS above
//   user_id     the account the event is ABOUT (may be null for unknown-email)
//   user_name   display name for the audit row
//   details     extra JSON for the audit row
//   actor       { id, name } when an admin did this TO someone else
//   alert       force alerting on (true) or off (false); defaults to whether
//               the event has an alertKey
//   summary     one line for the notification body; falls back to the label
async function record(req, opts) {
  opts = opts || {};
  const meta = EVENTS[opts.event] || { label: opts.event };
  const ip = opts.ip !== undefined ? opts.ip : clientIp(req);
  try {
    const det = Object.assign({}, opts.details || {});
    if (opts.actor && opts.actor.id) {
      det.by_user_id = opts.actor.id;
      det.by_user_name = opts.actor.name || null;
    }
    const ua = userAgent(req);
    if (ua && det.user_agent === undefined) det.user_agent = ua;
    await logAudit({
      entity_type: 'auth',
      entity_id: opts.user_id || null,
      action: opts.event,
      // The audit row is attributed to the ACTOR when an admin acted on someone
      // else, and to the subject otherwise. Without this an admin deleting an
      // account would look, in the log, like the account deleted itself.
      user_id: (opts.actor && opts.actor.id) || opts.user_id || null,
      user_name: (opts.actor && opts.actor.name) || opts.user_name || null,
      details: det,
      ip: ip
    });
  } catch (e) {
    console.error('[security] failed to record ' + opts.event + ':', e && e.message);
  }

  const wantAlert = (opts.alert === undefined) ? !!meta.alertKey : !!opts.alert;
  if (wantAlert && meta.alertKey) {
    // Fire and forget. A failed alert must never surface to the caller.
    sendAlert(meta, opts, ip).catch(function (e) {
      console.error('[security] alert failed for ' + opts.event + ':', e && e.message);
    });
  }
}

async function sendAlert(meta, opts, ip) {
  const throttleKey = meta.alertKey + ':' + (opts.user_id || opts.user_name || 'global');
  if (alertThrottled(throttleKey)) return;

  const who = opts.user_name || ('user #' + (opts.user_id || '?'));
  const summary = opts.summary || meta.label;
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  let recipients;
  try {
    recipients = await notify.broadcastRecipients(meta.alertKey, DEFAULT_SECURITY_AUDIENCE);
  } catch (e) {
    console.error('[security] could not resolve alert recipients:', e && e.message);
    return;
  }
  if (!recipients) return;

  const details = [
    { label: 'Account', value: who },
    { label: 'When', value: when + ' ET' }
  ];
  if (ip) details.push({ label: 'IP address', value: ip });
  if (opts.actor && opts.actor.name) details.push({ label: 'Performed by', value: opts.actor.name });

  if (recipients.emails && recipients.emails.length) {
    try {
      const html = emailTemplate({
        badge: 'Security',
        badgeColor: 'red',
        title: 'Nova security alert: ' + meta.label,
        body: summary + '<br><br>This is an automatic alert from Nova. If this was not expected, open the Audit Log and filter by Login &amp; Security.',
        details: details,
        buttonText: 'Open Nova',
        buttonUrl: (process.env.APP_URL || '').replace(/\/$/, ''),
        footerNote: 'You are receiving this because you are an admin on Nova. Change who gets security alerts under Settings -> Notifications.'
      });
      await sendEmail(recipients.emails, 'Nova security alert — ' + meta.label, html);
    } catch (e) {
      console.error('[security] alert email failed:', e && e.message);
    }
  }

  if (meta.sms && recipients.phones && recipients.phones.length) {
    try {
      await sendSms(recipients.phones, 'Nova security: ' + summary + (ip ? ' (IP ' + ip + ')' : ''));
    } catch (e) {
      console.error('[security] alert SMS failed:', e && e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------
async function getSetting(key) {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  } catch (e) { return null; }
}

async function setSetting(key, value) {
  try {
    await pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()',
      [key, value === null || value === undefined ? null : String(value)]
    );
  } catch (e) { console.error('[security] could not write setting ' + key + ':', e && e.message); }
}

// ---------------------------------------------------------------------------
// Burst detection + automatic lockdown
// ---------------------------------------------------------------------------
// Per-account lockout (5 tries, 15 minutes) has always existed, but it is blind
// to the shape of a real attack: five accounts each taking four wrong guesses
// looks exactly like five people mistyping. This closes that gap.
//
// WHAT LOCKDOWN ACTUALLY DOES, and what it deliberately does NOT do:
// it suspends the trusted-device 2FA bypass, so every login during the window
// has to pass a fresh code sent to the account's own phone or inbox. It does
// NOT block logins, does NOT lock accounts, and does NOT touch anyone's
// password. That asymmetry is the whole point: an attacker holding a stolen
// nova_device cookie is stopped cold, while a legitimate employee is merely
// asked for a code they can actually receive. An automated response that could
// lock the real staff out of their own operations platform would be worse than
// the attack it defends against.
//
// It is OFF by default. An admin arms it under Settings -> Notifications.
const BURST_WINDOW_MIN = 15;      // look back this far
const BURST_ACCOUNTS = 3;         // this many distinct accounts locked = a burst
const LOCKDOWN_MINUTES = 60;      // how long the trusted-device bypass stays off

const SET_AUTO = 'security_auto_lockdown';        // 'true' to arm
const SET_UNTIL = 'security_lockdown_until';      // ISO timestamp, or empty

// Called right after an account is locked. Never throws.
async function checkForBurst(req, lockedUserId) {
  try {
    const { rows } = await pool.query(
      "SELECT COUNT(DISTINCT entity_id)::int AS accounts, COUNT(DISTINCT ip)::int AS ips " +
      "FROM audit_logs " +
      "WHERE entity_type = 'auth' AND action = 'account_locked' " +
      "AND created_at > NOW() - make_interval(mins => $1)",
      [BURST_WINDOW_MIN]
    );
    const accounts = (rows[0] && rows[0].accounts) || 0;
    if (accounts < BURST_ACCOUNTS) return;

    const summary = accounts + ' different accounts have been locked out by failed logins in the last ' +
      BURST_WINDOW_MIN + ' minutes. That pattern is credential stuffing, not people mistyping.';
    await record(req, {
      event: 'attack_burst',
      user_id: lockedUserId || null,
      user_name: 'multiple accounts',
      summary: summary,
      details: { accounts: accounts, distinct_ips: (rows[0] && rows[0].ips) || 0, window_minutes: BURST_WINDOW_MIN }
    });

    const armed = String(await getSetting(SET_AUTO) || '').toLowerCase() === 'true';
    if (!armed) return;
    if (await lockdownActive()) return; // already on; do not keep extending it

    const until = new Date(Date.now() + LOCKDOWN_MINUTES * 60 * 1000);
    await setSetting(SET_UNTIL, until.toISOString());
    await record(req, {
      event: 'lockdown_engaged',
      user_id: null,
      user_name: 'Nova',
      summary: 'Automatic lockdown engaged for ' + LOCKDOWN_MINUTES + ' minutes. Remembered devices are suspended, so every login now needs a fresh 2FA code. Logins are NOT blocked.',
      details: { until: until.toISOString(), minutes: LOCKDOWN_MINUTES, trigger_accounts: accounts }
    });
  } catch (e) {
    console.error('[security] burst check failed:', e && e.message);
  }
}

// True while the trusted-device bypass is suspended. Fails OPEN (returns false)
// on a DB error: a settings table that cannot be read must not turn into an
// accidental company-wide 2FA storm.
async function lockdownActive() {
  try {
    const v = await getSetting(SET_UNTIL);
    if (!v) return false;
    const until = new Date(v);
    if (isNaN(until.getTime())) return false;
    return until > new Date();
  } catch (e) { return false; }
}

async function lockdownStatus() {
  const v = await getSetting(SET_UNTIL);
  const armed = String(await getSetting(SET_AUTO) || '').toLowerCase() === 'true';
  const until = v ? new Date(v) : null;
  const active = !!(until && !isNaN(until.getTime()) && until > new Date());
  return { armed: armed, active: active, until: active ? until.toISOString() : null };
}

async function clearLockdown() { await setSetting(SET_UNTIL, ''); }

module.exports = {
  EVENTS: EVENTS,
  clientIp: clientIp,
  record: record,
  checkForBurst: checkForBurst,
  lockdownActive: lockdownActive,
  lockdownStatus: lockdownStatus,
  clearLockdown: clearLockdown,
  getSetting: getSetting,
  setSetting: setSetting,
  BURST_WINDOW_MIN: BURST_WINDOW_MIN,
  BURST_ACCOUNTS: BURST_ACCOUNTS,
  LOCKDOWN_MINUTES: LOCKDOWN_MINUTES
};
