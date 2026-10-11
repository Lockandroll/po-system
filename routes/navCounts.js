// Sidebar badges: how many things are waiting on THIS person, per menu row.
//
// Tony, 2026-10-11: "Can you put the number of items to address as badges on
// the menu? Like all the way up to People ... a locksmith should not see the
// badge for a write up to another employee."
//
// One rule shapes every counter in here: A BADGE IS SOMETHING THAT IS YOUR
// MOVE. Not "things you are allowed to look at" - things that are stuck until
// you act. So every counter is gated by the same permission as the action it
// stands for, and scoped by the same rule the module itself uses. Where that
// rule is private to a module (PTO's reporting line, onboarding's canSignOff,
// the inspection reviewer, the employee-records scope), the module exports its
// own navCount() and this file only calls it. Restating those rules here is how
// the badge and the screen would start to disagree.
//
// The client (public/js/navBadges.js) stamps each count onto its row and adds
// the rows up onto the section header, so "People 3" is just the sum of the
// People rows this person can actually see.
//
// Every counter is wrapped on its own. One that throws becomes a zero; it never
// takes the rest down and never turns into an error on somebody's screen. A
// badge is not worth a 500.

const express = require('express');
const { pool } = require('../db');
const { requireAuth, userHasExtraPerm } = require('../middleware/auth');
const permissions = require('../utils/permissions');

const router = express.Router();

// Short per-person cache. The sidebar asks on every paint, on a timer, and
// after every write; most of those land inside the same few seconds. A write
// asks with ?fresh=1 so the badge you just cleared clears straight away.
var CACHE = {};
var CACHE_MS = 20000;

function etTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) {
    console.error('[nav-counts] counter failed:', e && e.message);
    return fallback;
  }
}

async function one(sql, params) {
  const r = await pool.query(sql, params || []);
  return (r.rows[0] && parseInt(r.rows[0].n, 10)) || 0;
}

async function compute(req) {
  const user = req.user;
  var permMemo = {};
  async function has(perm) {
    if (permMemo[perm] !== undefined) return permMemo[perm];
    var ok = false;
    try {
      ok = await permissions.hasPermission(user.role, perm);
      if (!ok && user.id) ok = await userHasExtraPerm(req, user.id, perm);
    } catch (e) { ok = false; }
    permMemo[perm] = ok;
    return ok;
  }
  var isAdminMgr = user.role === 'admin' || user.role === 'manager' || user.isOwner;

  var items = {};
  function put(view, parts) {
    parts = parts.filter(function (p) { return p.n > 0; });
    if (!parts.length) return;
    var n = parts.reduce(function (s, p) { return s + p.n; }, 0);
    items[view] = { n: n, parts: parts };
  }

  var jobs = [];

  // Purchase Orders. Anyone who can approve sees every submitted PO (that is
  // what the PO Dashboard shows them); the orderer sees the approved ones that
  // are theirs to place - the same rule POST /:id/order enforces.
  jobs.push(safe(async function () {
    var parts = [];
    if (await has('approve_po')) {
      parts.push({ key: 'approve', label: 'to approve', n: await one("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'submitted'") });
    }
    if (await has('view_pos')) {
      parts.push({ key: 'order', label: 'to order', n: await one("SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'approved' AND orderer_id = $1", [user.id]) });
    }
    put('dashboard', parts);
  }));

  // Vehicle repairs waiting on approval. vr_number IS NULL rows are the old
  // phantom records the list hides, so they never count either.
  jobs.push(safe(async function () {
    if (!(await has('approve_vr'))) return;
    put('vr-dashboard', [{ key: 'approve', label: 'to approve', n: await one("SELECT COUNT(*) AS n FROM vehicle_repairs WHERE status = 'submitted' AND vr_number IS NOT NULL") }]);
  }));

  // Refunds: requested ones need a decision, approved ones still need the money
  // to actually go back (the "approved but never issued" queue).
  jobs.push(safe(async function () {
    if (!(await has('approve_refund'))) return;
    put('refunds', [
      { key: 'approve', label: 'to approve', n: await one("SELECT COUNT(*) AS n FROM invoice_refunds WHERE status = 'requested'") },
      { key: 'issue', label: 'approved, not issued', n: await one("SELECT COUNT(*) AS n FROM invoice_refunds WHERE status = 'approved'") }
    ]);
  }));

  // Time off.
  jobs.push(safe(async function () {
    if (!(await has('view_pto'))) return;
    put('pto', [{ key: 'approve', label: 'to approve', n: await require('./pto').navCount(user) }]);
  }));

  // Onboarding.
  jobs.push(safe(async function () {
    if (!(await has('manage_onboarding'))) return;
    var o = await require('./onboarding').navCount(user);
    put('onboarding-admin', [
      { key: 'review', label: 'Phase 1 to review', n: o.review },
      { key: 'start', label: 'ready to start Phase 2', n: o.start },
      { key: 'signoff', label: 'ready for final sign-off', n: o.signoff }
    ]);
  }));

  // Employee records (write-ups, shout-outs) and my own file.
  var memoSign = safe(async function () {
    return await one(
      "SELECT COUNT(*) AS n FROM memo_recipients r JOIN memos m ON m.id = r.memo_id " +
      "WHERE r.user_id = $1 AND m.status = 'sent' AND r.completed_at IS NULL AND r.excused_at IS NULL",
      [user.id]
    );
  }, 0);
  jobs.push(safe(async function () {
    var e = await require('./employeeRecords').navCount(user, has);
    put('employee-files', [
      { key: 'wording', label: 'write-up wording to approve', n: e.wording },
      { key: 'administer', label: 'ready to administer', n: e.administer },
      { key: 'shoutouts', label: 'shout-outs to review', n: e.shoutouts }
    ]);
    put('my-documents', [
      { key: 'sign', label: 'notice to sign', n: e.sign },
      { key: 'memos', label: 'memo to sign', n: await memoSign }
    ]);
  }));

  // Tasks: mine that are past due. Same "mine" as GET /tasks/counts, which
  // includes a teammate's tasks while I am their PTO backup.
  jobs.push(safe(async function () {
    if (!(await has('view_tasks'))) return;
    put('tasks', [{ key: 'overdue', label: 'overdue', n: await one(
      "SELECT COUNT(*) AS n FROM tasks WHERE NOT is_template AND status <> 'done' AND due_date IS NOT NULL AND due_date < CURRENT_DATE " +
      "AND ( assigned_to = $1 OR secondary_assignee_id = $1 " +
      "OR EXISTS (SELECT 1 FROM users u JOIN pto_requests p ON p.user_id = u.id " +
      "WHERE u.id = tasks.assigned_to AND u.default_backup_id = $1 AND p.status = 'approved' " +
      "AND $2::date BETWEEN p.start_date AND p.end_date) )",
      [user.id, etTodayStr()]
    ) }]);
  }));

  // Vehicle inspections.
  jobs.push(safe(async function () {
    if (!(await has('view_inspections'))) return;
    var i = await require('./inspections').navCount(user, await has('manage_inspections'));
    put('inspections', [
      { key: 'due', label: 'due this month', n: i.due },
      { key: 'review', label: 'to sign off', n: i.review }
    ]);
  }));

  // Equipment.
  jobs.push(safe(async function () {
    if (!(await has('view_assets'))) return;
    var canDecide = (await has('approve_asset_replacement')) || (await has('manage_assets'));
    var a = await require('./assets').navCount(req, canDecide);
    put('my-equipment', [{ key: 'acks', label: 'to sign', n: a.acks }]);
    put('asset-requests', [{ key: 'requests', label: 'to decide', n: a.requests }]);
  }));

  // Customer feedback: complaints in my cities nobody has picked up yet, plus
  // open ones assigned to me. City scope is the same rule as routes/feedback.js
  // (admin/owner unrestricted, everyone else their user_cities).
  jobs.push(safe(async function () {
    if (!(await has('view_feedback'))) return;
    var open = "status NOT IN ('resolved','closed')";
    var n;
    if (user.role === 'admin' || user.isOwner) {
      n = await one("SELECT COUNT(*) AS n FROM customer_feedback WHERE " + open +
        " AND (assigned_to = $1 OR (status = 'new' AND assigned_to IS NULL))", [user.id]);
    } else {
      n = await one("SELECT COUNT(*) AS n FROM customer_feedback WHERE " + open +
        " AND (assigned_to = $1 OR (status = 'new' AND assigned_to IS NULL AND city_code IN (SELECT city_code FROM user_cities WHERE user_id = $1)))",
        [user.id]);
    }
    put('feedback', [{ key: 'open', label: 'to handle', n: n }]);
  }));

  // Suggestions nobody has looked at. Managers and admins are the only ones who
  // can read the list (routes/suggestions.js), so they are the only ones counted.
  jobs.push(safe(async function () {
    if (!isAdminMgr) return;
    put('suggestions', [{ key: 'open', label: 'new', n: await one("SELECT COUNT(*) AS n FROM suggestions WHERE status = 'open'") }]);
  }));

  await Promise.all(jobs);
  var total = 0;
  Object.keys(items).forEach(function (k) { total += items[k].n; });
  return { items: items, total: total, at: new Date().toISOString() };
}

router.get('/counts', requireAuth, async (req, res) => {
  var key = req.user.id + ':' + req.user.role + (req.viewingAs ? ':va' : '');
  var hit = CACHE[key];
  if (hit && req.query.fresh !== '1' && (Date.now() - hit.t) < CACHE_MS) return res.json(hit.data);
  try {
    var data = await compute(req);
    CACHE[key] = { t: Date.now(), data: data };
    res.json(data);
  } catch (e) {
    console.error('[nav-counts] failed:', e && e.message);
    res.json({ items: {}, total: 0 });
  }
});

router._compute = compute;
module.exports = router;
