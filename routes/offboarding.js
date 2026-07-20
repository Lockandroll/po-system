const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db').pool;
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();

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
 * POST /api/offboarding
 * Start wizard: create offboarding in draft status
 * Composes template (Core + role add-ons) into frozen steps
 */
router.post('/', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      user_id, type, notice_date, last_day, deactivate_mode,
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
       (user_id, type, status, notice_date, last_day, deactivate_mode,
        reason_category, reason_notes, eligible_for_rehire, rehire_notes,
        initiated_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING *`,
      [user_id, type, 'draft', notice_date, last_day, deactivate_mode,
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

    // Compose template: Core (roles=NULL) + role add-ons (roles includes this user's role)
    const templateRes = await client.query(
      `SELECT * FROM offboarding_template_steps
       WHERE template_id IN (
         SELECT id FROM offboarding_templates
         WHERE active = true
         AND (roles IS NULL OR $1 = ANY(roles))
         AND (employment_types IS NULL OR $2 = ANY(employment_types))
       )
       AND (applies_to IS NULL OR $3 = ANY(applies_to))
       ORDER BY position ASC`,
      [userRole, empType, type]
    );

    const lastDayObj = new Date(last_day);
    for (const step of templateRes.rows) {
      const dueDate = new Date(lastDayObj);
      dueDate.setDate(dueDate.getDate() + (step.due_offset_days || 0));

      await client.query(
        `INSERT INTO offboarding_steps
         (offboarding_id, template_step_id, title, description, category,
          assignee_kind, assigned_to, due_date, required, wants_evidence, auto_key, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [offboarding.id, step.id, step.title, step.description, step.category,
         step.assignee_kind, step.default_assignee_id, dueDate, step.required,
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
router.get('/:id', requireAuth, requirePermission('view_offboarding'), async (req, res) => {
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
router.patch('/:id', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { notice_date, last_day, type, reason_category, reason_notes, eligible_for_rehire } = req.body;

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
           eligible_for_rehire = COALESCE($6, eligible_for_rehire)
       WHERE id = $7`,
      [notice_date, last_day, type, reason_category, reason_notes, eligible_for_rehire, req.params.id]
    );

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

      await client.query(
        `INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [ob.id, req.user.id, 'deactivated_immediate', JSON.stringify({ type: ob.type })]
      );
    }

    // Update status
    await client.query(
      'UPDATE offboardings SET status = $1 WHERE id = $2',
      ['active', req.params.id]
    );

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
        const shiftRes = await client.query(
          `SELECT COUNT(*) as count FROM shifts
           WHERE assigned_to = $1 AND shift_date > $2`,
          [ob.user_id, ob.last_day]
        );
        const count = shiftRes.rows[0].count || 0;

        await client.query(
          `DELETE FROM shifts WHERE assigned_to = $1 AND shift_date > $2`,
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
        // Query vault audit for reveals, generate rotation checklist
        const auditRes = await client.query(
          `SELECT DISTINCT credential_id FROM vault_audit
           WHERE revealer_id = $1
           ORDER BY credential_id ASC`,
          [ob.user_id]
        );
        const credCount = auditRes.rows.length;

        // Hard guard: ensure not last owner-tier
        const ownerRes = await client.query(
          `SELECT COUNT(*) as count FROM vault_members
           WHERE tier = $1`,
          ['owner']
        );
        if (ownerRes.rows[0].count <= 1) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot remove last owner-tier vault member' });
        }

        result = { success: true, action: 'vault_sweep_generated', credentials_to_rotate: credCount };
        break;
      }
      case 'timeclock_final_check': {
        // Flag unapproved entries in final period
        const clockRes = await client.query(
          `SELECT COUNT(*) as count FROM timeclock_entries
           WHERE user_id = $1 AND approval_status = $2 AND entry_date <= $3`,
          [ob.user_id, 'pending', ob.last_day]
        );
        result = { success: true, action: 'timesheet_check', unapproved_count: clockRes.rows[0].count || 0 };
        break;
      }
      case 'completion_packet': {
        // Generate HTML completion packet
        const { generateCompletionPacket } = require('../utils/completionPacket');
        const packetHtml = await generateCompletionPacket(id);

        // Store packet in documents table (or return as downloadable)
        const docRes = await client.query(
          `INSERT INTO documents (user_id, title, content, doc_type, created_at)
           VALUES ($1, $2, $3, $4, NOW())
           RETURNING id`,
          [ob.user_id, `Offboarding Packet - ${new Date().toLocaleDateString()}`, packetHtml, 'offboarding_packet']
        );

        result = { success: true, action: 'packet_generated', document_id: docRes.rows[0]?.id, packet_html: packetHtml };
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
    res.json({ status: 'finalized' });
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
router.post('/questions', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { prompt, qtype, options, applies_to } = req.body;
    const result = await pool.query(
      `INSERT INTO exit_interview_questions (prompt, qtype, options, applies_to)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [prompt, qtype, options ? JSON.stringify(options) : null, applies_to || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('POST /questions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/offboarding/questions/:qid
 */
router.patch('/questions/:qid', requireAuth, requirePermission('manage_offboarding'), async (req, res) => {
  try {
    const { prompt, qtype, options, applies_to } = req.body;
    const result = await pool.query(
      `UPDATE exit_interview_questions
       SET prompt = COALESCE($1, prompt),
           qtype = COALESCE($2, qtype),
           options = COALESCE($3, options),
           applies_to = COALESCE($4, applies_to)
       WHERE id = $5 RETURNING *`,
      [prompt, qtype, options ? JSON.stringify(options) : undefined, applies_to, req.params.qid]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('PATCH /questions/:qid error:', err.message);
    res.status(500).json({ error: err.message });
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
      token = uuidv4();
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
      `SELECT ei.*, oi.applies_to as interview_applies_to
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
      `SELECT * FROM exit_interview_questions
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

    // Upsert answers
    for (const ans of answers || []) {
      await client.query(
        `INSERT INTO exit_interview_answers (interview_id, question_id, question_snapshot, value_num, value_text, answered_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET value_num = $4, value_text = $5, answered_at = NOW()`,
        [interview.id, ans.question_id, JSON.stringify(ans.question_snapshot), ans.value_num, ans.value_text]
      );
    }

    let newStatus = 'in_progress';
    if (submit) {
      newStatus = 'submitted';
      await client.query(
        `UPDATE exit_interviews SET status = $1, submitted_at = NOW() WHERE id = $2`,
        [newStatus, interview.id]
      );

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
      SELECT ei.id, u.name, u.email, o.type, o.created_at,
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

    query += ` ORDER BY ei.submitted_at DESC, ei.created_at DESC`;
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
exitInterviewRouter.get('/:id', requireAuth, requirePermission('view_exit_interviews'), async (req, res) => {
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
           WHEN EXTRACT(DAY FROM (o.created_at - u.hire_date)) < 90 THEN '<3mo'
           WHEN EXTRACT(DAY FROM (o.created_at - u.hire_date)) < 365 THEN '<1yr'
           WHEN EXTRACT(DAY FROM (o.created_at - u.hire_date)) < 1095 THEN '1-3yr'
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
