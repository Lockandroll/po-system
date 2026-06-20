const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async function(req, res) {
  try {
    const isPrivileged = ['admin', 'manager'].includes(req.user.role);
    const userId = req.user.id;

    // Pending VRs (submitted, awaiting approval)
    let pendingVRs = [], pendingPOs = [];
    if (isPrivileged) {
      const { rows: vrs } = await pool.query(
        'SELECT vr.id, vr.vr_number, vr.vehicle, vr.shop_name, vr.city_code, vr.total_amount, vr.created_at, u.name as requester_name ' +
        'FROM vehicle_repairs vr JOIN users u ON vr.requester_id = u.id ' +
        "WHERE vr.status = 'submitted' ORDER BY vr.created_at ASC"
      );
      pendingVRs = vrs;

      const { rows: pos } = await pool.query(
        'SELECT po.id, po.po_number, po.vendor_name, po.customer_name, po.city_code, po.total_amount, po.created_at, u.name as requester_name ' +
        'FROM purchase_orders po JOIN users u ON po.requester_id = u.id ' +
        "WHERE po.status = 'submitted' ORDER BY po.created_at ASC"
      );
      pendingPOs = pos;
    } else {
      // Requesters see their own submitted items
      const { rows: vrs } = await pool.query(
        "SELECT id, vr_number, vehicle, shop_name, city_code, total_amount, status, created_at FROM vehicle_repairs WHERE requester_id = $1 AND status IN ('draft','submitted') ORDER BY created_at DESC LIMIT 5",
        [userId]
      );
      pendingVRs = vrs;
      const { rows: pos } = await pool.query(
        "SELECT id, po_number, vendor_name, customer_name, city_code, total_amount, status, created_at FROM purchase_orders WHERE requester_id = $1 AND status IN ('draft','submitted') ORDER BY created_at DESC LIMIT 5",
        [userId]
      );
      pendingPOs = pos;
    }

    // Stats
    const { rows: vrStats } = await pool.query(
      "SELECT COUNT(*) FILTER (WHERE status='submitted') as pending_vr, COUNT(*) FILTER (WHERE status='approved') as approved_vr FROM vehicle_repairs"
    );
    const { rows: poStats } = await pool.query(
      "SELECT COUNT(*) as open_po, COALESCE(SUM(total_amount),0) as open_po_total FROM purchase_orders WHERE created_at >= date_trunc('month', NOW())"
    );
    const { rows: quoteStats } = await pool.query(
      "SELECT COUNT(*) as active_quotes, COALESCE(SUM(total_amount),0) as quote_total FROM quotes WHERE created_at >= date_trunc('month', NOW())"
    );
    const { rows: fleetStats } = await pool.query(
      "SELECT COUNT(*) as fleet_count FROM vehicles WHERE active = true"
    );

    // Recent activity (audit log)
    const { rows: activity } = await pool.query(
      'SELECT entity_type, entity_number, action, user_name, created_at FROM audit_logs ORDER BY created_at DESC LIMIT 8'
    );

    res.json({
      pendingVRs,
      pendingPOs,
      stats: {
        pending_vr: parseInt(vrStats[0].pending_vr) || 0,
        open_po: parseInt(poStats[0].open_po) || 0,
        open_po_total: parseFloat(poStats[0].open_po_total) || 0,
        active_quotes: parseInt(quoteStats[0].active_quotes) || 0,
        quote_total: parseFloat(quoteStats[0].quote_total) || 0,
        fleet_count: parseInt(fleetStats[0].fleet_count) || 0
      },
      activity
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

module.exports = router;
