const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
    const activityQ = pool.query(
      'SELECT entity_type, entity_number, action, user_name, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 8'
    );
    const inspDueQ = isPrivileged
      ? pool.query("SELECT COUNT(*) AS c FROM vehicles v WHERE v.active = true AND v.inspection_exempt = false AND NOT EXISTS (SELECT 1 FROM users au WHERE au.id = v.assigned_user_id AND au.role IN ('admin','owner')) AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM'))").catch(function(){ return { rows: [{ c: 0 }] }; })
      : pool.query("SELECT COUNT(*) AS c FROM vehicles v JOIN users du ON v.assigned_user_id = du.id WHERE v.active = true AND v.inspection_exempt = false AND du.supervisor_id = $1 AND (du.role IS NULL OR du.role NOT IN ('admin','owner')) AND NOT EXISTS (SELECT 1 FROM vehicle_inspections i WHERE i.vehicle_id = v.id AND i.period_month = to_char(NOW() AT TIME ZONE 'America/New_York','YYYY-MM'))", [userId]).catch(function(){ return { rows: [{ c: 0 }] }; });

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
    const activity = results[7].rows;
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
