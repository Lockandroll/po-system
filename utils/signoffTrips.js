// Shared trip creation for a sign-off series.
//
// A job that needs more than one visit gets one sheet per trip, linked by trip_group_id.
// Trip 1 is the original sheet; trips 2+ suffix its form number (-T2, -T3). Everything that
// belongs to a VISIT (times, techs, signature, photos, invoice #) starts empty, because the
// account manager signs for the visit that actually happened.
//
// This logic lived inline in routes/signoffs.js until the work order module needed the same
// thing: reopening a completed work order now offers the next sheet. Two copies of the INSERT
// is exactly how the form-number sequence drifts apart, so both routes call this.

const { pool } = require('../db');
const { logAudit } = require('./audit');

function groupIdOf(form) {
  return form.trip_group_id || form.id;
}

function tripFormNumber(baseNumber, tripNumber) {
  return String(baseNumber) + '-T' + tripNumber;
}

async function loadForm(id) {
  const { rows } = await pool.query('SELECT * FROM signoff_forms WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

// Every sheet on this job, plus the two rows a caller actually wants: the newest trip and
// whichever trip is still open (there can only ever be one).
async function seriesState(groupId) {
  const { rows } = await pool.query(
    'SELECT id, form_number, status, trip_number, assigned_to FROM signoff_forms ' +
    'WHERE trip_group_id = $1 ORDER BY trip_number ASC, id ASC',
    [groupId]
  );
  const open = rows.filter(function (r) { return r.status === 'pending'; })[0] || null;
  return { trips: rows, latest: rows.length ? rows[rows.length - 1] : null, open: open };
}

// The series a sheet id belongs to, without the caller having to load the sheet first.
async function seriesForSheet(sheetId) {
  const src = await loadForm(sheetId);
  if (!src) return null;
  const state = await seriesState(groupIdOf(src));
  state.groupId = groupIdOf(src);
  return state;
}

// Create the next trip on the job that srcId belongs to.
//
// opts:
//   userId, userName — for the audit entry
//   assignedTo       — an integer, null for unassigned, or undefined to inherit the source sheet's tech
//   trip_reason      — why the return visit is happening; shown on the sheet and in the email
//   via              — 'signoff' or 'work_order', recorded on the audit entry so we can tell
//                      later which door the trip came through
//
// Returns { trip } on success or { error, code } for the expected refusals. It does not throw
// for those, so both callers can hand the message straight back to the browser unchanged.
async function createNextTrip(srcId, opts) {
  opts = opts || {};
  const src = await loadForm(srcId);
  if (!src) return { error: 'Sign-off sheet not found', code: 404 };
  if (src.status !== 'completed') {
    return { error: 'Finish this sheet before adding the next trip.', code: 400 };
  }
  const groupId = groupIdOf(src);
  const state = await seriesState(groupId);
  // One live sheet per job — no two open trips at once.
  if (state.open) {
    return {
      error: 'Trip ' + state.open.form_number + ' is still open on this job. Complete it before adding another.',
      code: 400
    };
  }
  const agg = await pool.query(
    'SELECT MAX(trip_number) AS maxtrip, MIN(trip_base_number) AS base FROM signoff_forms WHERE trip_group_id = $1',
    [groupId]
  );
  const nextTrip = (agg.rows[0].maxtrip || 1) + 1;
  const base = agg.rows[0].base || src.trip_base_number || src.form_number;
  const form_number = tripFormNumber(base, nextTrip);
  // undefined means "same tech as the last trip". An explicit null means unassigned.
  const assigned = (opts.assignedTo === undefined) ? (src.assigned_to || null) : (opts.assignedTo || null);

  const { rows: ins } = await pool.query(
    'INSERT INTO signoff_forms (form_number, status, wo_number, po_number, account, store_name, store_number, address, city_state_zip, service_requested_by, notes, created_by, assigned_to, trip_group_id, trip_number, trip_base_number, trip_reason) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
    [form_number, 'pending', src.wo_number, src.po_number, src.account, src.store_name, src.store_number,
     src.address, src.city_state_zip, src.service_requested_by, src.notes, opts.userId || null, assigned,
     groupId, nextTrip, base, opts.trip_reason || null]
  );
  const trip = ins[0];

  try {
    await logAudit({
      entity_type: 'signoff', entity_id: trip.id, entity_number: form_number, action: 'trip_created',
      user_id: opts.userId || null, user_name: opts.userName || null,
      details: { trip_number: nextTrip, from: src.form_number, reason: opts.trip_reason || null, via: opts.via || 'signoff' }
    });
  } catch (e) {}

  // Point any work order on this job at the live trip so "Open Sign-Off" lands on the current sheet.
  try {
    await pool.query(
      'UPDATE work_orders SET signoff_id = $1, updated_at = NOW() ' +
      'WHERE signoff_id IN (SELECT id FROM signoff_forms WHERE trip_group_id = $2)',
      [trip.id, groupId]
    );
  } catch (e) { console.error('Repoint work order to new trip failed:', e && e.message); }

  return { trip: trip };
}

module.exports = {
  createNextTrip: createNextTrip,
  seriesState: seriesState,
  seriesForSheet: seriesForSheet,
  groupIdOf: groupIdOf,
  tripFormNumber: tripFormNumber
};
