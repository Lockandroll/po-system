const { pool } = require('../db');

// Centralized notification recipient resolution.
// Rules are stored as a single JSON object in settings under this key.
// Shape per event:
//   broadcast events:  { "users": [1,2,3], "email": true, "sms": true }
//   requester events:  { "email": true, "sms": true }   // recipient is always the requester
// When an event has NO rule configured, callers fall back to legacy behavior
// (broadcastRecipients uses defaultWhere; requesterChannels returns both channels on).
var SETTING_KEY = 'notification_rules';

async function getRules() {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [SETTING_KEY]);
    if (!rows.length || !rows[0].value) return {};
    const parsed = JSON.parse(rows[0].value);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.error('Failed to load notification rules:', e.message);
    return {};
  }
}

// Broadcast event recipients.
// eventKey:     the rule key, e.g. 'po_submitted'
// defaultWhere: SQL WHERE clause (no 'WHERE' keyword) used ONLY when no rule is
//               configured for this event. Must be a trusted constant, never user input.
// Returns { emails: [...], phones: [...] }.
async function broadcastRecipients(eventKey, defaultWhere) {
  const rules = await getRules();
  const rule = rules[eventKey];

  if (rule && Array.isArray(rule.users)) {
    if (!rule.users.length) return { emails: [], phones: [] };
    const { rows } = await pool.query(
      'SELECT email, phone FROM users WHERE active = true AND id = ANY($1::int[])',
      [rule.users]
    );
    const emails = rule.email === false ? [] : rows.map(function (r) { return r.email; }).filter(Boolean);
    const phones = rule.sms === false ? [] : rows.map(function (r) { return r.phone; }).filter(Boolean);
    return { emails: emails, phones: phones };
  }

  // Fallback: legacy behavior — query by role and honor each user's personal prefs.
  const res = await pool.query(
    'SELECT email, phone, receive_emails, receive_sms FROM users WHERE active = true AND (' + defaultWhere + ')'
  );
  const dEmails = res.rows.filter(function (r) { return r.receive_emails; }).map(function (r) { return r.email; }).filter(Boolean);
  const dPhones = res.rows.filter(function (r) { return r.receive_sms && r.phone; }).map(function (r) { return r.phone; }).filter(Boolean);
  return { emails: dEmails, phones: dPhones };
}

// Requester (outcome) event channel switches. Returns { email: bool, sms: bool }.
// Defaults to both channels enabled when no rule is configured.
async function requesterChannels(eventKey) {
  const rules = await getRules();
  const rule = rules[eventKey];
  if (!rule) return { email: true, sms: true };
  return { email: rule.email !== false, sms: rule.sms !== false };
}

module.exports = {
  getRules: getRules,
  broadcastRecipients: broadcastRecipients,
  requesterChannels: requesterChannels
};
