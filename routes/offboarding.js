const express = require('express');
const crypto = require('crypto');
const pool = require('../db').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

// Nobody stays clocked in after their access is cut. Close the open punch at the
// moment of the revoke and say why on the entry, so the final timesheet reads as a
// real shift rather than an entry that never ended. Breaks are closed the same way
// clock-out closes them, and worked minutes come out of the stored rows.
async function closeOpenPunch(db, userId, why) {
  const open = await db.query("SELECT id, clock_in_at FROM time_entries WHERE user_id = $1 AND status = 'open'", [userId]);
  for (const e of open.rows) {
    await db.query(
      "UPDATE time_breaks SET break_end_at = NOW(), minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - break_start_at))/60) WHERE entry_id = $1 AND break_end_at IS NULL",
      [e.id]
    );
    await db.query(
      "UPDATE time_entries SET clock_out_at = NOW(), status = 'closed', updated_at = NOW()," +
      " edit_reason = $2, edited_at = NOW()," +
      " worked_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - clock_in_at))/60)" +
      "   - COALESCE((SELECT SUM(minutes) FROM time_breaks WHERE entry_id = $1), 0))" +
      " WHERE id = $1",
      [e.id, why]
    );
  }
  return open.rows.length;
}


// A bare '/:id' route swallows every one-segment path that is declared after it
// ('/templates', '/questions', '/insights'), so those requests used to arrive as
// id='templates' and blew up on the integer comparison in Postgres. Gate the
// param routes on a numeric id and hand anything else to the next matching route.
// The one query that decides whose checklist has which steps. The wizard preview and
// the create both run it, so what you are shown is what gets written.
const composeStepsSql =
  "SELECT ts.* FROM offboarding_template_steps ts" +
  " JOIN offboarding_templates t ON t.id = ts.template_id" +
  " WHERE t.active = true" +
  "   AND (t.roles IS NULL OR $1 = ANY(t.roles))" +
  "   AND (t.employment_types IS NULL OR $2 = ANY(t.employment_types))" +
  "   AND (ts.roles IS NULL OR $1 = ANY(ts.roles))" +
  "   AND (ts.applies_to IS NULL OR $3 = ANY(ts.applies_to))" +
  " ORDER BY ts.position ASC";

function numericId(req, res, next) {
  return /^\d+$/.test(req.params.id) ? next() : next('route');
}

// ---- Org-tree scoping (mirrors onboarding's supervisor-chain visibility) ----
// "Their tree" = everyone who rolls up to this manager through users.supervisor_id
// (direct + indirect reports). Admins/owners are never scoped. Same hierarchy
// onboarding uses to decide who can see/act on a hire.
function isAdminLike(user) {
  return !!(user && (user.role === 'admin' || user.isOwner === true));
}
async function subtreeUserIds(managerId) {
  const r = await pool.query(
    'WITH RECURSIVE subtree AS (' +
    '  SELECT id FROM users WHERE supervisor_id = $1 ' +
    '  UNION ' +
    '  SELECT u.id FROM users u JOIN subtree s ON u.supervisor_id = s.id' +
    ') SELECT id FROM subtree',
    [managerId]
  );
  return r.rows.map(function (x) { return Number(x.id); });
}
// admin/owner → always; otherwise the target must be somewhere in the user's tree.
async function canReachUser(user, targetUserId) {
  if (isAdminLike(user)) return true;
  if (Number(targetUserId) === Number(user.id)) return false;
  const ids = await subtreeUserIds(user.id);
  return ids.indexOf(Number(targetUserId)) !== -1;
}

// ============================================================================
// LIFECYCLE & CRUD
// ============================================================================

/**
 * GET /api/offboarding
 * List offboardings with filters (status, type, year)
 * Managers see records where they hold steps; all others see only with permission
 */
router.get('/', requireAuth, requirePermission('view_offboarding'), async (req, res) => {
  try {
    const { status, type, year } = req.query;
    const params = [];
    let query = `
      SELECT o.*, u.name, u.email, u.role, COUNT(os.id) as total_steps,
             SUM(CASE WHEN os.status='done' THEN 1 ELSE 0 END) as done_steps
      FROM offboardings o
      JOIN users u ON o.user_id = u.id
      LEFT JOIN offboarding_steps os ON o.id = os.offboarding_id
      WHERE 1=1
    `;

    // Tree scoping: non-admins only see offboardings for people in their tree.
    if (!isAdminLike(req.user)) {
      const ids = await subtreeUserIds(req.user.id);
      if (!ids.length) return res.json([]);
      params.push(ids);
      query += ` AND o.user_id = ANY($${params.length}::int[])`;
    }

    if (status) {
      params.push(status);
      query += ` AND o.status = $${params.length}`;
    }
    if (type) {
      params.push(type);
      query += ` AND o.type = $${params.length}`;
    }
    if (year) {
      const y = parseInt(year, 10);
      params.push(`${y}-01-01`);
      params.push(`${y}-12-31`);
      query += ` AND o.last_day >= $${params.length - 1} AND o.last_day <= $${params.length}`;
    }

    query += ` GROUP BY o.id, u.id ORDER BY o.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /offboarding error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/offboarding/eligible
 * People this user may start an offboarding for. Admins/owners: everyone active;
 * managers: only their tree. Declared BEFORE '/:id' so it is not shadowed by it.
 */
router.get('/eligible', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    let rows;
    if (isAdminLike(req.user)) {
      rows = (await pool.query(
        'SELECT id, name, email, role FROM users WHERE active = true ORDER BY name ASC'
      )).rows;
    } else {
      const ids = await subtreeUserIds(req.user.id);
      if (!ids.length) return res.json([]);
      rows = (await pool.query(
        'SELECT id, name, email, role FROM users WHERE active = true AND id = ANY($1::int[]) ORDER BY name ASC',
        [ids]
      )).rows;
    }
    res.json(rows);
  } catch (err) {
    console.error('GET /offboarding/eligible error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/offboarding/preview?user_id=&type=
 * The exact checklist a Begin would create for this person: Core plus any role and
 * employment-type add-on, filtered by departure type. Same composition query the
 * create runs, so the wizard's preview cannot drift from what actually gets written.
 */
router.get('/preview', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10);
    const type = req.query.type || null;
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    const uRes = await pool.query('SELECT role, employment_type FROM users WHERE id = $1', [userId]);
    if (!uRes.rows.length) return res.status(404).json({ error: 'User not found' });
    if (!(await canReachUser(req.user, userId))) {
      return res.status(403).json({ error: 'You can only offboard people in your team.' });
    }

    const steps = await pool.query(composeStepsSql,
      [uRes.rows[0].role, uRes.rows[0].employment_type || 'full_time', type]);
    res.json({ steps: steps.rows });
  } catch (err) {
    console.error('GET /offboarding/preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding
 * Start wizard: create offboarding in draft status
 * Composes template (Core + role add-ons) into frozen steps
 */
router.post('/', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // reason_category is no longer collected from the manager - it is written from
    // the departing person's own exit form answer (see the submit handler). The
    // column still accepts one for older records and the API's other callers.
    const {
      user_id, type, notice_date, last_day, deactivate_mode, access_revoke_date,
      reason_category, reason_notes, eligible_for_rehire, rehire_notes, template_id
    } = req.body;

    // Validate user exists and is active
    const userRes = await client.query('SELECT role FROM users WHERE id = $1', [user_id]);
    if (!userRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }
    const userRole = userRes.rows[0].role;

    // Tree scoping: a non-admin may only offboard someone in their own tree.
    if (!(await canReachUser(req.user, user_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only offboard people in your team.' });
    }

    // Create offboarding record
    const obRes = await client.query(
      `INSERT INTO offboardings
       (user_id, type, status, notice_date, last_day, deactivate_mode, access_revoke_date,
        reason_category, reason_notes, eligible_for_rehire, rehire_notes,
        initiated_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       RETURNING *`,
      [user_id, type, 'draft', notice_date, last_day, deactivate_mode,
       access_revoke_date || last_day,
       reason_category, reason_notes, eligible_for_rehire, rehire_notes,
       req.user.id]
    );
    const offboarding = obRes.rows[0];

    // Get user's employment_type for filtering
    const empRes = await client.query(
      'SELECT employment_type FROM users WHERE id = $1',
      [user_id]
    );
    const empType = empRes.rows[0]?.employment_type || 'full_time';

    // Compose the checklist: one flat list, each step scoped by the roles it applies
    // to (NULL = everybody) and by departure type. Template-level scoping is still
    // honoured for any template that sets it.
    const templateRes = await client.query(composeStepsSql, [userRole, empType, type]);

    const lastDayObj = new Date(last_day);
    for (const step of templateRes.rows) {
      const dueDate = new Date(lastDayObj);
      dueDate.setDate(dueDate.getDate() + (step.due_offset_days || 0));

      await client.query(
        `INSERT INTO offboarding_steps
         (offboarding_id, template_step_id, title, description, category,
          assigned_to, due_date, required, wants_evidence, auto_key, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [offboarding.id, step.id, step.title, step.description, step.category,
         step.default_assignee_id, dueDate, step.required,
         step.wants_evidence, step.auto_key, step.position]
      );
    }

    await client.query('COMMIT');
    const fullOb = await pool.query(
      `SELECT o.*, u.name FROM offboardings o
       JOIN users u ON o.user_id = u.id WHERE o.id = $1`,
      [offboarding.id]
    );
    res.status(201).json(fullOb.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /offboarding error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/offboarding/:id
 * Fetch full offboarding with steps and events
 */
router.get('/:id', numericId, requireAuth, requirePermission('view_offboarding'), async (req, res) => {
  try {
    const obRes = await pool.query(
      `SELECT o.*, u.name, u.email FROM offboardings o
       JOIN users u ON o.user_id = u.id WHERE o.id = $1`,
      [req.params.id]
    );
    if (!obRes.rows.length) return res.status(404).json({ error: 'Not found' });

    // Tree scoping: non-admins can only open records for people in their tree.
    if (!(await canReachUser(req.user, obRes.rows[0].user_id))) {
      return res.status(403).json({ error: 'This person is outside your team.' });
    }

    const stepsRes = await pool.query(
      `SELECT * FROM offboarding_steps WHERE offboarding_id = $1 ORDER BY position`,
      [req.params.id]
    );

    const eventsRes = await pool.query(
      `SELECT e.*, u.name FROM offboarding_events e
       LEFT JOIN users u ON e.actor_id = u.id
       WHERE e.offboarding_id = $1 ORDER BY e.created_at DESC`,
      [req.params.id]
    );

    const interviewRes = await pool.query(
      `SELECT * FROM exit_interviews WHERE offboarding_id = $1`,
      [req.params.id]
    );

    res.json({
      ...obRes.rows[0],
      steps: stepsRes.rows,
      events: eventsRes.rows,
      interview: interviewRes.rows[0] || null
    });
  } catch (err) {
    console.error('GET /offboarding/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/offboarding/:id
 * Update record (dates, type, reason, rehire)
 * Recomputes step due dates from offsets
 */
router.patch('/:id', numericId, requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { notice_date, last_day, type, reason_category, reason_notes, eligible_for_rehire, access_revoke_date, deactivate_mode } = req.body;

    // Fetch current offboarding
    const currentRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    if (!currentRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const ob = currentRes.rows[0];
    const newLastDay = last_day || ob.last_day;

    // Update offboarding
    await client.query(
      `UPDATE offboardings
       SET notice_date = COALESCE($1, notice_date),
           last_day = COALESCE($2, last_day),
           type = COALESCE($3, type),
           reason_category = COALESCE($4, reason_category),
           reason_notes = COALESCE($5, reason_notes),
           eligible_for_rehire = COALESCE($6, eligible_for_rehire),
           access_revoke_date = COALESCE($8, access_revoke_date),
           deactivate_mode = COALESCE($9, deactivate_mode)
       WHERE id = $7`,
      [notice_date, last_day, type, reason_category, reason_notes, eligible_for_rehire, req.params.id,
       access_revoke_date, deactivate_mode]
    );

    // Moving the last day moves the date everything else keys off.
    if (last_day && ob.status !== 'cancelled') {
      await client.query('UPDATE users SET separation_date = $1 WHERE id = $2', [last_day, ob.user_id]);
    }

    // Recompute due dates if last_day changed
    if (last_day && last_day !== ob.last_day) {
      const stepsRes = await client.query(
        `SELECT os.*, ts.due_offset_days FROM offboarding_steps os
         LEFT JOIN offboarding_template_steps ts ON os.template_step_id = ts.id
         WHERE os.offboarding_id = $1`,
        [req.params.id]
      );

      const lastDayObj = new Date(newLastDay);
      for (const step of stepsRes.rows) {
        const offset = step.due_offset_days || 0;
        const dueDate = new Date(lastDayObj);
        dueDate.setDate(dueDate.getDate() + offset);

        await client.query(
          'UPDATE offboarding_steps SET due_date = $1 WHERE id = $2',
          [dueDate, step.id]
        );
      }
    }

    await client.query('COMMIT');
    const updated = await pool.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /offboarding/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/offboarding/:id/begin
 * draft → active: notifies assignees, fires events
 * For involuntary+immediate, runs deactivate_user automation first
 */
router.post('/:id/begin', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const obRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    if (!obRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const ob = obRes.rows[0];
    if (ob.status !== 'draft') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Already active' });
    }

    // For involuntary immediate termination, deactivate first
    if (ob.type === 'involuntary' && ob.deactivate_mode === 'immediate') {
      await client.query(
        `UPDATE users SET active = false WHERE id = $1`,
        [ob.user_id]
      );
      await client.query(
        `DELETE FROM trusted_devices WHERE user_id = $1`,
        [ob.user_id]
      );
      const closedNow = await closeOpenPunch(client, ob.user_id, 'Closed automatically when offboarding access was revoked');

      await client.query(
        `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [ob.id, req.user.id, 'access_revoked', JSON.stringify({ trigger: 'immediate', type: ob.type, punches_closed: closedNow })]
      );
    }

    // Update status
    await client.query(
      'UPDATE offboardings SET status = $1 WHERE id = $2',
      ['active', req.params.id]
    );

    // The date the rest of Nova reads: PTO stops accruing after it and the time
    // clock stops taking punches after it. Neither one deletes anything.
    await client.query('UPDATE users SET separation_date = $1 WHERE id = $2', [ob.last_day, ob.user_id]);

    // Log event
    await client.query(
      `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ob.id, req.user.id, 'started', JSON.stringify({ type: ob.type, deactivate_mode: ob.deactivate_mode })]
    );

    await client.query('COMMIT');
    res.json({ status: 'active', message: 'Offboarding begun' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /offboarding/:id/begin error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/offboarding/:id/cancel
 * Cancel offboarding with reason
 * Lists already-run automations for manual reversal
 */
router.post('/:id/cancel', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { reason } = req.body;
    const obRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    if (!obRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const ob = obRes.rows[0];
    if (ob.status === 'finalized' || ob.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot cancel terminal state' });
    }

    // Get completed automations for reversal notes
    const autoRes = await client.query(
      `SELECT DISTINCT kind FROM offboarding_events
       WHERE offboarding_id = $1 AND kind LIKE 'auto_%'
       ORDER BY created_at DESC`,
      [ob.id]
    );

    // If deactivated, flag for reactivation
    const manualSteps = [];
    for (const evt of autoRes.rows) {
      if (evt.kind === 'auto_deactivate') {
        manualSteps.push('Reactivate user account');
      }
      if (evt.kind === 'auto_clear_shifts') {
        manualSteps.push('Restore removed schedule shifts');
      }
      if (evt.kind === 'auto_cancel_pto') {
        manualSteps.push('Restore cancelled PTO');
      }
    }

    await client.query(
      `UPDATE offboardings SET status = $1, cancelled_reason = $2 WHERE id = $3`,
      ['cancelled', reason, req.params.id]
    );

    // They are staying: accrual and the time clock start working again. (Their
    // account is a separate question - see manual_reversals below.)
    await client.query('UPDATE users SET separation_date = NULL WHERE id = $1', [ob.user_id]);

    await client.query(
      `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ob.id, req.user.id, 'cancelled', JSON.stringify({ reason, manual_reversals: manualSteps })]
    );

    await client.query('COMMIT');
    res.json({ status: 'cancelled', manual_reversals: manualSteps });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /offboarding/:id/cancel error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// STEPS
// ============================================================================

/**
 * POST /api/offboarding/:id/steps
 * Add ad-hoc step to an offboarding
 */
router.post('/:id/steps', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { title, description, category, assigned_to, due_date, required } = req.body;

    const res2 = await pool.query(
      `INSERT INTO offboarding_steps
       (offboarding_id, title, description, category, assigned_to, due_date, required)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.params.id, title, description, category, assigned_to, due_date, required]
    );
    res.status(201).json(res2.rows[0]);
  } catch (err) {
    console.error('POST /offboarding/:id/steps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding/:id/steps/:sid/complete
 * Mark step done with optional note + evidence (R2)
 */
router.post('/:id/steps/:sid/complete', requireAuth, async (req, res) => {
  try {
    const { note, r2_keys } = req.body;
    const evidence = { note, r2_keys: r2_keys || [] };

    await pool.query(
      `UPDATE offboarding_steps
       SET status = $1, evidence = $2, completed_by = $3, completed_at = NOW()
       WHERE id = $4 AND offboarding_id = $5`,
      ['done', JSON.stringify(evidence), req.user.id, req.params.sid, req.params.id]
    );

    res.json({ status: 'done' });
  } catch (err) {
    console.error('POST /step complete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding/:id/steps/:sid/skip
 * Skip a step with reason (required steps log loudly)
 */
router.post('/:id/steps/:sid/skip', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { reason } = req.body;

    const stepRes = await pool.query(
      'SELECT required FROM offboarding_steps WHERE id = $1',
      [req.params.sid]
    );
    if (stepRes.rows.length && stepRes.rows[0].required) {
      console.warn(`AUDIT: Required step skipped by ${req.user.id}: ${reason}`);
    }

    await pool.query(
      `UPDATE offboarding_steps
       SET status = $1, skip_reason = $2
       WHERE id = $3 AND offboarding_id = $4`,
      ['skipped', reason, req.params.sid, req.params.id]
    );

    res.json({ status: 'skipped' });
  } catch (err) {
    console.error('POST /step skip error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// AUTOMATIONS
// ============================================================================

/**
 * POST /api/offboarding/:id/run/:auto_key
 * Execute automation: deactivate_user, clear_shifts, cancel_pto, vault_sweep, etc.
 * Result payload stored in offboarding_events
 */
router.post('/:id/run/:auto_key', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { id, auto_key } = req.params;
    const obRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [id]
    );
    if (!obRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Offboarding not found' });
    }

    const ob = obRes.rows[0];
    let result = { success: false };

    // Route to the appropriate automation
    switch (auto_key) {
      case 'deactivate_user': {
        await client.query(
          'UPDATE users SET active = false WHERE id = $1',
          [ob.user_id]
        );
        await client.query(
          'DELETE FROM trusted_devices WHERE user_id = $1',
          [ob.user_id]
        );
        result = { success: true, action: 'deactivated', user_id: ob.user_id };
        break;
      }
      case 'clear_future_shifts': {
        // shifts keys the person as user_id -- there is no assigned_to column.
        const shiftRes = await client.query(
          `SELECT COUNT(*)::int AS count FROM shifts
           WHERE user_id = $1 AND shift_date > $2`,
          [ob.user_id, ob.last_day]
        );
        const count = shiftRes.rows[0].count || 0;

        await client.query(
          `DELETE FROM shifts WHERE user_id = $1 AND shift_date > $2`,
          [ob.user_id, ob.last_day]
        );
        result = { success: true, action: 'cleared_shifts', count };
        break;
      }
      case 'cancel_future_pto': {
        // Cancel pending requests, manager-cancel approved, snapshot balance
        const ptoRes = await client.query(
          `SELECT pto_balance_hours FROM users WHERE id = $1`,
          [ob.user_id]
        );
        const balance = ptoRes.rows[0]?.pto_balance_hours || 0;

        await client.query(
          `UPDATE pto_requests SET status = $1 WHERE user_id = $2 AND status = $3`,
          ['declined', ob.user_id, 'pending']
        );

        await client.query(
          `UPDATE offboardings SET pto_balance_snapshot = $1 WHERE id = $2`,
          [balance, id]
        );

        result = { success: true, action: 'pto_cancelled', balance_snapshot: balance };
        break;
      }
      case 'vault_sweep': {
        // The Vault is a SHARED, zero-knowledge store: one data key wrapped to each
        // active member. There is no per-credential reveal log, so the sweep answers
        // the only question that matters -- was this person a member, and therefore
        // does the shared key (and everything under it) have to be rotated.
        const memRes = await client.query(
          'SELECT status FROM vault_members WHERE user_id = $1',
          [ob.user_id]
        );
        const wasMember = memRes.rows.length && memRes.rows[0].status === 'active';

        if (!memRes.rows.length) {
          result = { success: true, action: 'vault_sweep', vault_member: false, credentials_to_rotate: 0,
            note: 'Not a Vault member. Nothing to rotate.' };
          break;
        }

        const activeRes = await client.query(
          "SELECT COUNT(*)::int AS count FROM vault_members WHERE status = 'active'"
        );
        // Hard guard: never strip the last active member -- that orphans the shared
        // key and the Vault can only be reset (everything in it lost).
        if (wasMember && activeRes.rows[0].count <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'This is the last active Vault member. Enroll another owner before offboarding this one, or reset the Vault.' });
        }

        const entryRes = await client.query('SELECT COUNT(*)::int AS count FROM vault_entries');
        await client.query('DELETE FROM vault_members WHERE user_id = $1', [ob.user_id]);

        result = { success: true, action: 'vault_sweep', vault_member: true,
          credentials_to_rotate: entryRes.rows[0].count,
          note: 'Membership removed. The shared key was wrapped to this person, so every entry above must be rotated.' };
        break;
      }
      case 'timeclock_final_check': {
        // Nova's punches live in time_entries (no approval_status/entry_date columns);
        // week-level sign-off lives in time_week_approvals. Flag both kinds of loose end.
        const openRes = await client.query(
          `SELECT COUNT(*)::int AS count FROM time_entries
           WHERE user_id = $1 AND clock_out_at IS NULL`,
          [ob.user_id]
        );
        const weekRes = await client.query(
          `SELECT COUNT(*)::int AS count FROM time_entries te
           WHERE te.user_id = $1
             AND te.clock_in_at::date <= $2
             AND NOT EXISTS (
               SELECT 1 FROM time_week_approvals wa
               WHERE wa.user_id = te.user_id
                 AND wa.week_start = (te.clock_in_at::date - EXTRACT(DOW FROM te.clock_in_at)::int)
             )`,
          [ob.user_id, ob.last_day]
        );
        result = { success: true, action: 'timesheet_check',
          open_punches: openRes.rows[0].count || 0,
          unapproved_count: weekRes.rows[0].count || 0 };
        break;
      }
      case 'completion_packet': {
        // documents is the R2-backed Document Vault (name/r2_key/owner_id) -- it has
        // no content column, so the packet is returned to the browser to save/print
        // and its generation is recorded on the record instead of half-written here.
        const { generateCompletionPacket } = require('../utils/completionPacket');
        const packetHtml = await generateCompletionPacket(id);
        result = { success: true, action: 'packet_generated', packet_html: packetHtml };
        break;
      }
      case 'pto_payout_note': {
        // Snapshot the balance that has to be paid out and put it on the record so
        // payroll has one number to work from.
        const balRes = await client.query('SELECT pto_balance_hours FROM users WHERE id = $1', [ob.user_id]);
        const hours = Number(balRes.rows[0]?.pto_balance_hours || 0);
        await client.query(
          'UPDATE offboardings SET pto_balance_snapshot = $1 WHERE id = $2',
          [hours, id]
        );
        result = { success: true, action: 'pto_payout_noted', hours };
        break;
      }
      case 'reassign_open_tasks': {
        // Everything still open moves to the named person, else this person's
        // supervisor, else whoever started the offboarding.
        const supRes = await client.query('SELECT supervisor_id FROM users WHERE id = $1', [ob.user_id]);
        const target = Number(req.body?.assign_to) || supRes.rows[0]?.supervisor_id || ob.initiated_by;
        const openRes = await client.query(
          `UPDATE tasks SET assigned_to = $1, updated_at = NOW()
           WHERE assigned_to = $2 AND status <> 'completed'
           RETURNING id`,
          [target, ob.user_id]
        );
        await client.query(
          `UPDATE tasks SET secondary_assignee_id = NULL
           WHERE secondary_assignee_id = $1 AND status <> 'completed'`,
          [ob.user_id]
        );
        result = { success: true, action: 'tasks_reassigned', count: openRes.rows.length, assigned_to: target };
        break;
      }
      default:
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Unknown automation: ${auto_key}` });
    }

    // Mark the corresponding step as done and log the event
    await client.query(
      `UPDATE offboarding_steps SET status = $1, completed_by = $2, completed_at = NOW()
       WHERE offboarding_id = $3 AND auto_key = $4`,
      ['done', req.user.id, id, auto_key]
    );

    await client.query(
      `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ob.id, req.user.id, `auto_${auto_key}`, JSON.stringify(result)]
    );

    await client.query('COMMIT');
    res.json(result);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /run automation error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// FINALIZE
// ============================================================================

/**
 * POST /api/offboarding/:id/finalize
 * Move to finalized: blocks if required steps open, archives packet, locks record
 */
router.post('/:id/finalize', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const obRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    if (!obRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const ob = obRes.rows[0];

    // Check for open required steps
    const blockerRes = await client.query(
      `SELECT title FROM offboarding_steps
       WHERE offboarding_id = $1 AND required = true AND status = $2`,
      [req.params.id, 'pending']
    );

    if (blockerRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'Required steps incomplete',
        blockers: blockerRes.rows.map(r => r.title)
      });
    }

    // 'Only when I finalize' is a real mode on the record, but nothing ever acted on
    // it - a record could be finalized with the account still live. Do it here.
    let deactivatedNow = false;
    if (ob.deactivate_mode === 'on_finalize') {
      const uRes = await client.query('SELECT active FROM users WHERE id = $1', [ob.user_id]);
      if (uRes.rows.length && uRes.rows[0].active !== false) {
        await client.query('UPDATE users SET active = false WHERE id = $1', [ob.user_id]);
        await client.query('DELETE FROM trusted_devices WHERE user_id = $1', [ob.user_id]);
        const closedFin = await closeOpenPunch(client, ob.user_id, 'Closed automatically when the offboarding was finalized');
        await client.query(
          `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [ob.id, req.user.id, 'access_revoked', JSON.stringify({ trigger: 'on_finalize', punches_closed: closedFin })]
        );
        deactivatedNow = true;
      }
    }

    await client.query(
      'UPDATE users SET separation_date = COALESCE(separation_date, $1) WHERE id = $2',
      [ob.last_day, ob.user_id]
    );

    // Update offboarding
    await client.query(
      `UPDATE offboardings SET status = $1, finalized_by = $2, finalized_at = NOW()
       WHERE id = $3`,
      ['finalized', req.user.id, req.params.id]
    );

    // Log event
    await client.query(
      `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ob.id, req.user.id, 'finalized', JSON.stringify({ packet_archived: true })]
    );

    await client.query('COMMIT');
    res.json({ status: 'finalized', access_revoked: deactivatedNow });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /finalize error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// TEMPLATES & QUESTIONS
// ============================================================================

/**
 * GET /api/offboarding/templates
 */
router.get('/templates', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM offboarding_templates ORDER BY position ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding/templates
 */
router.post('/templates', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { name, roles, employment_types, active } = req.body;
    const result = await pool.query(
      `INSERT INTO offboarding_templates (name, roles, employment_types, active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, roles || null, employment_types || null, active !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /templates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/offboarding/templates/:tid
 */
router.get('/templates/:tid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const tmplRes = await pool.query(
      'SELECT * FROM offboarding_templates WHERE id = $1',
      [req.params.tid]
    );
    if (!tmplRes.rows.length) return res.status(404).json({ error: 'Template not found' });

    const stepsRes = await pool.query(
      'SELECT * FROM offboarding_template_steps WHERE template_id = $1 ORDER BY position',
      [req.params.tid]
    );

    res.json({ ...tmplRes.rows[0], steps: stepsRes.rows });
  } catch (err) {
    console.error('GET /templates/:tid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/offboarding/templates/:tid
 */
router.patch('/templates/:tid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { name, roles, employment_types, active } = req.body;
    const result = await pool.query(
      `UPDATE offboarding_templates
       SET name = COALESCE($1, name),
           roles = COALESCE($2, roles),
           employment_types = COALESCE($3, employment_types),
           active = COALESCE($4, active)
       WHERE id = $5 RETURNING *`,
      [name, roles, employment_types, active, req.params.tid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /templates/:tid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/offboarding/templates/:tid
 */
router.delete('/templates/:tid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    await pool.query('DELETE FROM offboarding_templates WHERE id = $1', [req.params.tid]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /templates/:tid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The checklist editor. One flat list of steps; each row carries the roles it
 * applies to (empty = everybody). Steps live on the Core template row, which is
 * just the container now that role scoping moved onto the step itself.
 *
 * Editing these NEVER touches an offboarding that is already running - live steps
 * are a frozen copy taken at create time, by design.
 */
const STEP_CATEGORIES = ['access', 'property', 'payroll', 'knowledge', 'interview', 'comms', 'hr', 'final'];
const AUTO_KEYS = ['deactivate_user', 'clear_future_shifts', 'cancel_future_pto', 'vault_sweep',
  'timeclock_final_check', 'pto_payout_note', 'reassign_open_tasks', 'completion_packet'];

async function coreTemplateId() {
  const r = await pool.query("SELECT id FROM offboarding_templates WHERE roles IS NULL AND active = true ORDER BY position, id LIMIT 1");
  if (r.rows.length) return r.rows[0].id;
  const ins = await pool.query("INSERT INTO offboarding_templates (name, active, position) VALUES ('Core', true, 0) RETURNING id");
  return ins.rows[0].id;
}

// Empty array from the client means "everybody" (NULL), not "nobody".
function arrOrNull(v) {
  if (!Array.isArray(v)) return null;
  const clean = v.filter(function (x) { return x != null && String(x).trim() !== ''; });
  return clean.length ? clean : null;
}

router.get('/template-steps', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ts.* FROM offboarding_template_steps ts
         JOIN offboarding_templates t ON t.id = ts.template_id
        WHERE t.active = true
        ORDER BY ts.position ASC, ts.id ASC`
    );
    res.json({ steps: result.rows, categories: STEP_CATEGORIES, auto_keys: AUTO_KEYS });
  } catch (err) {
    console.error('GET /template-steps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/template-steps', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Give the step a title.' });
    if (b.category && STEP_CATEGORIES.indexOf(b.category) === -1) return res.status(400).json({ error: 'Unknown category.' });
    if (b.auto_key && AUTO_KEYS.indexOf(b.auto_key) === -1) return res.status(400).json({ error: 'Unknown automation.' });

    const tid = await coreTemplateId();
    const posRes = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM offboarding_template_steps');
    const result = await pool.query(
      `INSERT INTO offboarding_template_steps
         (template_id, title, description, category, required, wants_evidence, auto_key, roles, applies_to, due_offset_days, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [tid, String(b.title).trim(), b.description || null, b.category || 'access', !!b.required,
       !!b.wants_evidence, b.auto_key || null, arrOrNull(b.roles), arrOrNull(b.applies_to),
       parseInt(b.due_offset_days, 10) || 0, posRes.rows[0].pos]
    );
    await logAudit({ entity_type: 'offboarding_template_step', entity_id: result.rows[0].id, action: 'added',
      user_id: req.user.id, user_name: req.user.name, details: { title: result.rows[0].title } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /template-steps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/template-steps/:sid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.category && STEP_CATEGORIES.indexOf(b.category) === -1) return res.status(400).json({ error: 'Unknown category.' });
    if (b.auto_key && AUTO_KEYS.indexOf(b.auto_key) === -1) return res.status(400).json({ error: 'Unknown automation.' });
    // roles/applies_to are set to exactly what came in (COALESCE would make
    // "applies to everybody" impossible to save once a scope had been set).
    const result = await pool.query(
      `UPDATE offboarding_template_steps SET
         title = COALESCE($1, title),
         description = $2,
         category = COALESCE($3, category),
         required = COALESCE($4, required),
         wants_evidence = COALESCE($5, wants_evidence),
         auto_key = $6,
         roles = $7,
         applies_to = $8,
         due_offset_days = COALESCE($9, due_offset_days)
       WHERE id = $10 RETURNING *`,
      [b.title ? String(b.title).trim() : null, b.description || null, b.category,
       typeof b.required === 'boolean' ? b.required : null,
       typeof b.wants_evidence === 'boolean' ? b.wants_evidence : null,
       b.auto_key || null, arrOrNull(b.roles), arrOrNull(b.applies_to),
       b.due_offset_days != null ? parseInt(b.due_offset_days, 10) : null, req.params.sid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Step not found' });
    await logAudit({ entity_type: 'offboarding_template_step', entity_id: parseInt(req.params.sid, 10), action: 'edited',
      user_id: req.user.id, user_name: req.user.name, details: { title: result.rows[0].title } });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /template-steps/:sid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/template-steps/:sid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM offboarding_template_steps WHERE id = $1 RETURNING title', [req.params.sid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Step not found' });
    await logAudit({ entity_type: 'offboarding_template_step', entity_id: parseInt(req.params.sid, 10), action: 'removed',
      user_id: req.user.id, user_name: req.user.name, details: { title: r.rows[0].title } });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /template-steps/:sid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reorder: the client sends the ids in the order it wants them.
router.post('/template-steps/reorder', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nothing to reorder.' });
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE offboarding_template_steps SET position = $1 WHERE id = $2', [i, ids[i]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /template-steps/reorder error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/offboarding/questions
 */
router.get('/questions', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM exit_interview_questions ORDER BY position ASC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /questions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding/questions
 */
const QTYPES = ['radio', 'select', 'text'];

// A choice question with no choices is a dead end on the form, so refuse it here
// rather than shipping an empty <select> to somebody on their last day.
function questionGuard(b) {
  if (b.qtype && QTYPES.indexOf(b.qtype) === -1) return 'Pick radio, select or text.';
  if (b.prompt !== undefined && !String(b.prompt || '').trim()) return 'Give the question a prompt.';
  if (b.qtype && b.qtype !== 'text') {
    const opts = (b.options && b.options.options) || [];
    if (!Array.isArray(opts) || opts.filter(function (o) { return String(o || '').trim(); }).length < 2) {
      return 'A multiple-choice question needs at least two answers.';
    }
  }
  return null;
}

router.post('/questions', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const b = req.body || {};
    const bad = questionGuard(b);
    if (bad) return res.status(400).json({ error: bad });
    const posRes = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM exit_interview_questions');
    const result = await pool.query(
      `INSERT INTO exit_interview_questions (prompt, qtype, options, applies_to, required, active, question_key, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [String(b.prompt).trim(), b.qtype, b.options ? JSON.stringify(b.options) : null, arrOrNull(b.applies_to),
       !!b.required, b.active !== false, b.question_key || null, posRes.rows[0].pos]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Another question is already feeding that tile.' });
    console.error('POST /questions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/offboarding/questions/:qid
 */
router.patch('/questions/:qid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const b = req.body || {};
    const bad = questionGuard(b);
    if (bad) return res.status(400).json({ error: bad });
    const result = await pool.query(
      `UPDATE exit_interview_questions
       SET prompt = COALESCE($1, prompt),
           qtype = COALESCE($2, qtype),
           options = COALESCE($3, options),
           applies_to = $4,
           required = COALESCE($5, required),
           active = COALESCE($6, active),
           question_key = $7
       WHERE id = $8 RETURNING *`,
      [b.prompt ? String(b.prompt).trim() : null, b.qtype, b.options ? JSON.stringify(b.options) : null,
       arrOrNull(b.applies_to), typeof b.required === 'boolean' ? b.required : null,
       typeof b.active === 'boolean' ? b.active : null, b.question_key || null, req.params.qid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Question not found' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Another question is already feeding that tile.' });
    console.error('PATCH /questions/:qid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Retiring a question keeps every answer already given, so it is a deactivation,
// never a delete. A question nobody has answered yet is genuinely removed.
router.delete('/questions/:qid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const used = await pool.query('SELECT COUNT(*)::int AS n FROM exit_interview_answers WHERE question_id = $1', [req.params.qid]);
    if (used.rows[0].n > 0) {
      const r = await pool.query('UPDATE exit_interview_questions SET active = false WHERE id = $1 RETURNING *', [req.params.qid]);
      if (!r.rows.length) return res.status(404).json({ error: 'Question not found' });
      return res.json({ retired: true, answers_kept: used.rows[0].n });
    }
    const r = await pool.query('DELETE FROM exit_interview_questions WHERE id = $1 RETURNING id', [req.params.qid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Question not found' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /questions/:qid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/questions/reorder', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Nothing to reorder.' });
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i++) {
      await client.query('UPDATE exit_interview_questions SET position = $1 WHERE id = $2', [i, ids[i]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: ids.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /questions/reorder error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// EXIT INTERVIEW
// ============================================================================

/**
 * POST /api/offboarding/:id/interview
 * Send (or waive) exit form
 */
router.post('/:id/interview', requireAuth, requirePermission('send_exit_form'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { mode, waive_reason } = req.body;
    const obRes = await client.query(
      'SELECT * FROM offboardings WHERE id = $1',
      [req.params.id]
    );
    if (!obRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }

    const ob = obRes.rows[0];
    let token = null;
    let interviewStatus = 'draft';

    if (mode === 'self_serve') {
      token = crypto.randomBytes(32).toString('hex');
      interviewStatus = 'sent';
    } else if (mode === 'waived') {
      interviewStatus = 'waived';
    }

    const interviewRes = await client.query(
      `INSERT INTO exit_interviews
       (offboarding_id, user_id, mode, status, token, token_expires_at, waive_reason)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '14 days', $6)
       ON CONFLICT (offboarding_id) DO UPDATE SET
         status = $4, token = $5, token_expires_at = NOW() + INTERVAL '14 days', waive_reason = $6
       RETURNING *`,
      [ob.id, ob.user_id, mode, interviewStatus, token, waive_reason || null]
    );

    await client.query(
      `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ob.id, req.user.id, `interview_${mode}`, JSON.stringify({ waive_reason })]
    );

    await client.query('COMMIT');
    res.json(interviewRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /interview error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/offboarding/exit/:token (PUBLIC — no auth required)
 * Fetch interview and questions for public form
 */
router.get('/exit/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const interviewRes = await pool.query(
      `SELECT ei.*, oi.type as interview_applies_to
       FROM exit_interviews ei
       JOIN offboardings oi ON ei.offboarding_id = oi.id
       WHERE ei.token = $1 AND ei.token_expires_at > NOW()`,
      [token]
    );
    if (!interviewRes.rows.length) {
      return res.status(404).json({ error: 'Token invalid or expired' });
    }

    const interview = interviewRes.rows[0];
    const applies_to = interview.interview_applies_to || 'voluntary';

    const questionsRes = await pool.query(
      `SELECT id, prompt, qtype, options, required, question_key, position
         FROM exit_interview_questions
        WHERE active = true
          AND (applies_to IS NULL OR $1 = ANY(applies_to))
        ORDER BY position ASC`,
      [applies_to]
    );

    // Get any existing answers
    const answersRes = await pool.query(
      `SELECT * FROM exit_interview_answers WHERE interview_id = $1`,
      [interview.id]
    );

    res.json({
      interview: {
        id: interview.id,
        status: interview.status,
        mode: interview.mode
      },
      questions: questionsRes.rows,
      answers: answersRes.rows || []
    });
  } catch (err) {
    console.error('GET /exit/:token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/offboarding/exit/:token (PUBLIC — no auth required)
 * Autosave or submit answers
 */
router.post('/exit/:token', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { token } = req.params;
    const { answers, submit } = req.body;

    const interviewRes = await client.query(
      `SELECT * FROM exit_interviews
       WHERE token = $1 AND token_expires_at > NOW()`,
      [token]
    );
    if (!interviewRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Token invalid or expired' });
    }

    const interview = interviewRes.rows[0];

    // Replace this interview's answers with the set that was just posted. (The old
    // ON CONFLICT (id) could never fire -- id is a fresh serial -- so every save
    // stacked another copy of every answer.)
    await client.query('DELETE FROM exit_interview_answers WHERE interview_id = $1', [interview.id]);
    for (const ans of answers || []) {
      await client.query(
        `INSERT INTO exit_interview_answers (interview_id, question_id, question_snapshot, value_num, value_text, answered_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [interview.id, ans.question_id, JSON.stringify(ans.question_snapshot), ans.value_num, ans.value_text]
      );
    }

    let newStatus = 'in_progress';
    if (submit) {
      newStatus = 'submitted';
      // Two answers are read outside the answers table: the would-you-work-here-again
      // one drives the Insights tile, and the reason is the departure reason of
      // record now that the manager no longer picks one. Both are found by
      // question_key, so an admin can reword either prompt without unhooking it.
      const keyed = await client.query(
        "SELECT id, question_key FROM exit_interview_questions WHERE question_key IN ('would_return','reason')"
      );
      const keyById = {};
      for (const row of keyed.rows) keyById[row.id] = row.question_key;

      let wouldReturn = null;
      let reasonGiven = null;
      for (const ans of answers || []) {
        const key = keyById[ans.question_id];
        const v = (ans.value_text || '').trim();
        if (!v) continue;
        if (key === 'would_return') {
          const low = v.toLowerCase();
          if (low.startsWith('yes')) wouldReturn = 'yes';
          else if (low.startsWith('maybe')) wouldReturn = 'maybe';
          else wouldReturn = 'no';
        } else if (key === 'reason') {
          reasonGiven = v;
        }
      }
      await client.query(
        `UPDATE exit_interviews SET status = $1, submitted_at = NOW(),
                would_return = COALESCE($3, would_return) WHERE id = $2`,
        [newStatus, interview.id, wouldReturn]
      );
      if (reasonGiven) {
        await client.query(
          'UPDATE offboardings SET reason_category = $1 WHERE id = $2',
          [reasonGiven, interview.offboarding_id]
        );
      }

      await client.query(
        `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
         VALUES ($1, NULL, $2, $3, NOW())`,
        [interview.offboarding_id, 'interview_submitted', JSON.stringify({ answer_count: answers?.length || 0 })]
      );
    } else {
      await client.query(
        `UPDATE exit_interviews SET status = $1 WHERE id = $2`,
        [newStatus, interview.id]
      );
    }

    await client.query('COMMIT');
    res.json({ status: newStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /exit/:token error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ============================================================================
// EXIT INTERVIEW RESPONSES & INSIGHTS (view_exit_interviews perm)
// ============================================================================

// ============================================================================
// EXIT INTERVIEW RESPONSES & INSIGHTS (separate router for /api/exit-interviews)
// ============================================================================

const exitInterviewRouter = express.Router();

/**
 * GET /api/exit-interviews
 * List all exit interview responses (raw table)
 */
exitInterviewRouter.get('/', requireAuth, requirePermission('view_exit_interviews'), async (req, res) => {
  try {
    const { year, city } = req.query;
    let query = `
      SELECT ei.id, u.name, u.email, u.role, u.hire_date, o.type, o.created_at,
             o.reason_category, o.last_day,
             ei.submitted_at, ei.would_return,
             (SELECT COUNT(*) FROM exit_interview_answers WHERE interview_id = ei.id) as answer_count
      FROM exit_interviews ei
      JOIN offboardings o ON ei.offboarding_id = o.id
      JOIN users u ON o.user_id = u.id
      WHERE ei.status IN ('submitted', 'waived')
    `;
    const params = [];

    if (year) {
      const y = parseInt(year);
      params.push(`${y}-01-01`);
      params.push(`${y}-12-31`);
      query += ` AND o.created_at >= $${params.length - 1} AND o.created_at <= $${params.length}`;
    }

    query += ` ORDER BY ei.submitted_at DESC NULLS LAST, ei.id DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /exit-interviews error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/exit-interviews/:id
 * Single interview with all answers
 */
exitInterviewRouter.get('/:id', numericId, requireAuth, requirePermission('view_exit_interviews'), async (req, res) => {
  try {
    const interviewRes = await pool.query(
      `SELECT ei.*, u.name FROM exit_interviews ei
       JOIN offboardings o ON ei.offboarding_id = o.id
       JOIN users u ON o.user_id = u.id
       WHERE ei.id = $1`,
      [req.params.id]
    );
    if (!interviewRes.rows.length) return res.status(404).json({ error: 'Not found' });

    const answersRes = await pool.query(
      `SELECT * FROM exit_interview_answers WHERE interview_id = $1`,
      [req.params.id]
    );

    res.json({ ...interviewRes.rows[0], answers: answersRes.rows });
  } catch (err) {
    console.error('GET /exit-interviews/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/exit-interviews/insights
 * Dashboard aggregates
 */
exitInterviewRouter.get('/insights', requireAuth, requirePermission('view_exit_interviews'), async (req, res) => {
  try {
    // Departures by role
    const roleRes = await pool.query(
      `SELECT u.role, COUNT(*) as count FROM offboardings o
       JOIN users u ON o.user_id = u.id
       WHERE o.status = 'finalized' GROUP BY u.role`
    );

    // Departures by tenure
    const tenureRes = await pool.query(
      `SELECT
         CASE
           WHEN u.hire_date IS NULL THEN 'unknown'
           WHEN (o.created_at::date - u.hire_date) < 90 THEN '<3mo'
           WHEN (o.created_at::date - u.hire_date) < 365 THEN '<1yr'
           WHEN (o.created_at::date - u.hire_date) < 1095 THEN '1-3yr'
           ELSE '3yr+'
         END as tenure_band, COUNT(*) as count
       FROM offboardings o
       JOIN users u ON o.user_id = u.id
       WHERE o.status = 'finalized' GROUP BY tenure_band`
    );

    // Would-return trend (last 30 days)
    const returnRes = await pool.query(
      `SELECT ei.would_return, COUNT(*) as count FROM exit_interviews ei
       WHERE ei.submitted_at > NOW() - INTERVAL '30 days'
       AND ei.status = 'submitted'
       GROUP BY ei.would_return`
    );

    // Reason distribution
    const reasonRes = await pool.query(
      `SELECT reason_category, COUNT(*) as count FROM offboardings
       WHERE status = 'finalized' AND reason_category IS NOT NULL
       GROUP BY reason_category`
    );

    res.json({
      departures_by_role: roleRes.rows,
      departures_by_tenure: tenureRes.rows,
      would_return_trend: returnRes.rows,
      reasons: reasonRes.rows,
      total_finalized: (await pool.query(
        'SELECT COUNT(*) as count FROM offboardings WHERE status = $1',
        ['finalized']
      )).rows[0].count
    });
  } catch (err) {
    console.error('GET /insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.exitInterviewRouter = exitInterviewRouter;
