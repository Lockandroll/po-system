const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const org = require('../utils/org');

const router = express.Router();

// Distil an audit row's details JSON down to one short line for the dashboard
// activity feed, or '' when there is nothing worth saying.
//
// Why this exists: an action name alone can be actively misleading. A PTO
// approval logged as 'approved_override' tells you a rule was bypassed but not
// why, even though routes/pto.js REQUIRES a reason before it will let the
// approval through — the reason was always captured, just never displayed.
//
// This is an allowlist on purpose. Only the keys named below are ever echoed;
// anything else in details stays server-side. The feed is visible to every
// privileged viewer regardless of city or reporting line, so this stays terse
// and factual. The details column may arrive as JSON text or as a parsed object
// depending on the column type, so handle both.
function activityNote(row) {
  if (!row || !row.details) return '';
  var d = row.details;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch (e) { return ''; }
  }
  if (!d || typeof d !== 'object') return '';

  var parts = [];
  var reason = d.override_reason || d.reason || '';
  if (reason) {
    reason = String(reason).trim();
    // One line in a feed, not an essay. The full text is on the Audit Log page.
    if (reason.length > 140) reason = reason.slice(0, 137) + '...';
    if (reason) parts.push('"' + reason + '"');
  }
  if (d.coverage_used != null && d.coverage_cap != null) {
    parts.push('coverage ' + d.coverage_used + ' of ' + d.coverage_cap);
  }
  // Approving paid PTO that takes the employee's balance negative is a second,
  // separate override on the same action and is NOT reason-prompted, so flag it
  // explicitly rather than letting it hide behind the coverage reason.
  if (d.negative_override === true) parts.push('balance taken negative');
  return parts.join(' - ');
}

router.get('/', requireAuth, async function(req, res) {
  try {
    const isPrivileged = ['admin', 'manager'].includes(req.user.role);
    const userId = req.user.id;

    // Build all queries up front and run them concurrently (Promise.all) instead
    // of awaiting each in sequence — the dashboard makes ~8 independent reads and
    // sequential round-trips were stacking into multi-second load times.
    const pendingVRsQ = isPrivileged
      ? pool.query(
          'SELECT vr.id, vr.vr_number, vr.vehicle, vr.shop_name, vr.city_code, vr.total_amount, vr.created_at, u.name as requester_name ' +
          'FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id ' +
          "WHERE vr.status = 'submitted' ORDER BY vr.created_at ASC"
        )
      : pool.query(
          "SELECT id, vr_number, vehicle, shop_name, city_code, total_amount, status, created_at FROM vehicle_repairs WHERE requester_id = $1 AND status IN ('draft','submitted') ORDER BY created_at DESC LIMIT 5",
          [userId]
        );

    const pendingPOsQ = isPrivileged
      ? pool.query(
          'SELECT po.id, po.po_number, po.vendor_name, po.customer_name, po.city_code, po.total_amount, po.created_at, u.name as requester_name ' +
          'FROM purchase_orders po JOIN users u ON po.requester_id = u.id ' +
          "WHERE po.status = 'submitted' ORDER BY po.created_at ASC"
        )
      : pool.query(
          "SELECT id, po_number, vendor_name, customer_name, city_code, total_amount, status, created_at FROM purchase_orders WHERE requester_id = $1 AND status IN ('draft','submitted') ORDER BY created_at DESC LIMIT 5",
          [userId]
        );

    const vrStatsQ = pool.query(
      "SELECT COUNT(*) FILTER (WHERE status='submitted') as pending_vr, COUNT(*) FILTER (WHERE status='approved') as approved_vr FROM vehicle_repairs"
    );
    const poStatsQ = pool.query(
      "SELECT COUNT(*) as open_po, COALESCE(SUM(total_amount),0) as open_po_total FROM purchase_orders WHERE created_at >= date_trunc('month', NOW())"
    );
    const quoteStatsQ = pool.query(
      "SELECT COUNT(*) as active_quotes, COALESCE(SUM(total_amount),0) as quote_total FROM quotes WHERE created_at >= date_trunc('month', NOW())"
    );
    const fleetStatsQ = pool.query(
      "SELECT COUNT(*) as fleet_count FROM vehicles WHERE active = true"
    );
    const myTasksQ = pool.query(
      "SELECT id, title, status, priority, due_date FROM tasks WHERE assigned_to = $1 AND status <> 'done' ORDER BY (due_date IS NULL), due_date ASC, CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 12",
      [userId]
    ).catch(function() { return { rows: [] }; });
    // The activity feed is company-wide and EVERY role sees it, so the raw
    // audit details blob must never ship to the client here — it holds free
    // text (override reasons, denial reasons, changed emails) that has no
    // business on a locksmith's home screen. Privileged viewers get the row
    // WITH details so activityNote() below can distill one short, allowlisted
    // line; everyone else gets the same five columns as before. The full,
    // unfiltered detail lives on the Audit Log page behind view_audit.
    const activityQ = isPrivileged
      ? pool.query(
          'SELECT entity_type, entity_number, action, user_name, created_at, details FROM audit_logs ORDER BY created_at DESC LIMIT 8'
        )
      : pool.query(
          'SELECT entity_type, entity_number, action, user_name, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 8'
        );
    // Non-privileged viewers get their TEAM's vehicles: reporting downline plus
    // anyone based in a city they run (see utils/org.js). This was direct reports
    // only, so a coordinator with a lead under them counted nothing below depth 1.
    const inspTeamIds = isPrivileged ? [] : await org.teamIds(userId);
    const inspDueQ = isPrivileged
      ? pool.query("SELECT COUNT(*) AS c FROM vehicles v WHERE v.active = true AND v.inspection_exempt = false AND NOT EXISTS (SELECT 1 FROM users au WHERE au.id = v.assigned_user_id AND au.role IN ('admin','owner')) AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM'))").catch(function(){ return { rows: [{ c: 0 }] }; })
      : pool.query("SELECT COUNT(*) AS c FROM vehicles v JOIN users du ON v.assigned_user_id = du.id WHERE v.active = true AND v.inspection_exempt = false AND du.id = ANY($1::int[]) AND (du.role IS NULL OR du.role NOT IN ('admin','owner')) AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM'))", [inspTeamIds]).catch(function(){ return { rows: [{ c: 0 }] }; });

    const results = await Promise.all([
      pendingVRsQ, pendingPOsQ, vrStatsQ, poStatsQ, quoteStatsQ, fleetStatsQ, myTasksQ, activityQ, inspDueQ
    ]);
    const pendingVRs = results[0].rows;
    const pendingPOs = results[1].rows;
    const vrStats = results[2].rows;
    const poStats = results[3].rows;
    const quoteStats = results[4].rows;
    const fleetStats = results[5].rows;
    const myTasks = results[6].rows;
    // Replace details with the distilled note. The blob itself never ships.
    const activity = results[7].rows.map(function (r) {
      var note = activityNote(r);
      delete r.details;
      if (note) r.note = note;
      return r;
    });
    const inspDue = results[8].rows;

    res.json({
      pendingVRs,
      pendingPOs,
      myTasks,
      stats: {
        pending_vr: parseInt(vrStats[0].pending_vr) || 0,
        open_po: parseInt(poStats[0].open_po) || 0,
        open_po_total: parseFloat(poStats[0].open_po_total) || 0,
        active_quotes: parseInt(quoteStats[0].active_quotes) || 0,
        quote_total: parseFloat(quoteStats[0].quote_total) || 0,
        fleet_count: parseInt(fleetStats[0].fleet_count) || 0,
        inspections_due: parseInt(inspDue[0].c) || 0
      },
      activity
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;
