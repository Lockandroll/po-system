const { pool } = require('../db');
const { sendEmail, emailTemplate } = require('./email');
const notify = require('./notify');
const push = require('./push');

// "Feedback resolved" notification, sent when a customer feedback record moves
// into a closed state (status 'resolved' or 'closed').
//
// GEICO ERS surveys and Google reviews each get their OWN email - distinct
// subject, badge and notification rule - so Tony can route (and read) them
// separately from ordinary complaints. Every other source uses the generic
// resolved email. The rule key drives recipients through the same Settings ->
// notification rules system every other Nova alert uses, defaulting to
// admins/owners when nothing is configured for the event.
//
// Sent at most once per resolution. notified_resolved_at is claimed in the SAME
// UPDATE that checks it, so two callers racing over one close cannot both send.
// The PATCH handler clears notified_resolved_at when a record is reopened, so a
// record that is reopened and resolved again notifies again.
//
// Fire and forget: nothing here throws. A notification failing must never fail
// the resolution that triggered it.

function money(v) { return '$' + (parseFloat(v) || 0).toFixed(2); }
function esc(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// source -> how this resolution is presented and routed.
function presentation(source) {
  if (source === 'geico_survey') {
    return { eventKey: 'feedback_resolved_geico', kind: 'GEICO ERS survey', badge: 'GEICO Survey Resolved' };
  }
  if (source === 'google_review') {
    return { eventKey: 'feedback_resolved_google', kind: 'Google review', badge: 'Google Review Resolved' };
  }
  return { eventKey: 'feedback_resolved', kind: 'customer feedback', badge: 'Feedback Resolved' };
}

async function notifyFeedbackResolved(feedbackId, actor) {
  try {
    // Claim the send. Only rows that are actually closed and not yet notified
    // pass; the claim and the guard are one statement, so it is race-safe.
    const claim = await pool.query(
      "UPDATE customer_feedback SET notified_resolved_at = NOW() " +
      "WHERE id = $1 AND status IN ('resolved','closed') AND notified_resolved_at IS NULL RETURNING *",
      [feedbackId]
    );
    if (!claim.rows.length) return false;
    const f = claim.rows[0];

    // Pull the human-readable names the raw row only holds as ids.
    const names = await pool.query(
      'SELECT c.name AS city_name, t.name AS tech_name, a.name AS assigned_name ' +
      'FROM customer_feedback f ' +
      'LEFT JOIN cities c ON c.code = f.city_code ' +
      'LEFT JOIN users t ON t.id = f.tech_user_id ' +
      'LEFT JOIN users a ON a.id = f.assigned_to ' +
      'WHERE f.id = $1',
      [feedbackId]
    );
    const n = names.rows[0] || {};

    const p = presentation(f.source);
    const customer = f.customer_name || 'Unknown customer';
    const resolver = (actor && actor.name) ? actor.name : 'A manager';
    const statusLabel = String(f.status || '').replace(/_/g, ' ');
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const recordUrl = appUrl + '/?view=feedback&id=' + f.id;

    // Recipients + channels, per source, via the shared Settings rules.
    const _q = await notify.broadcastRecipients(p.eventKey, "role IN ('admin','owner')");

    try {
      await push.sendPushToUsers(_q.userIds, {
        title: p.badge,
        body: resolver + ' resolved a ' + p.kind + ' from ' + customer + '.',
        url: '/?view=feedback&id=' + f.id
      });
    } catch (e) { console.error('Feedback resolved push failed:', e.message); }

    if (!(_q.emails && _q.emails.length)) return true;

    const techValue = f.no_tech ? 'No tech assigned' : (n.tech_name || f.tech_name_raw || 'Unknown');
    const faultValue = f.no_tech ? '—' : (f.tech_at_fault === true ? 'Yes' : f.tech_at_fault === false ? 'No' : 'TBD');
    const details = [
      { label: 'Source', value: p.kind },
      { label: 'Customer', value: customer },
      { label: 'City', value: n.city_name || f.city_code || 'Unknown' },
      { label: 'Tech', value: techValue },
      { label: 'Tech at fault', value: faultValue },
      { label: 'Category', value: f.category || '—' },
      { label: 'Severity', value: f.severity || 'unrated' },
      { label: 'Total damages', value: money(f.total_damages) },
      { label: 'Refunded', value: f.refunded ? (money(f.refunded_amount) + ' refunded') : 'No' },
      { label: 'Final status', value: statusLabel },
      { label: 'Resolved by', value: resolver }
    ];
    if (f.resolved_notes) details.push({ label: 'Resolution notes', value: f.resolved_notes });

    const html = emailTemplate({
      badge: p.badge, badgeColor: 'green',
      title: 'A ' + p.kind + ' was resolved',
      body: '<strong>' + esc(resolver) + '</strong> resolved a ' + esc(p.kind) +
            ' from <strong>' + esc(customer) + '</strong>' +
            (n.city_name ? ' (' + esc(n.city_name) + ')' : '') + '.',
      details: details,
      buttonText: 'View Feedback',
      buttonUrl: recordUrl,
      footerNote: 'Sent when a ' + p.kind + ' is marked resolved or closed.'
    });

    const subjectLead = f.source === 'geico_survey' ? 'Resolved GEICO ERS survey'
      : f.source === 'google_review' ? 'Resolved Google review'
      : 'Resolved customer feedback';
    await sendEmail(_q.emails, subjectLead + ': ' + customer, html);
    return true;
  } catch (e) {
    console.error('Feedback resolved notify failed:', e.message);
    return false;
  }
}

module.exports = { notifyFeedbackResolved: notifyFeedbackResolved };
