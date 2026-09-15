// Receipt of Property - what the departing person handed back, and where each
// item went afterwards.
//
// Before this, the offboarding checklist had "Collect company credit cards" and
// "Inventory assigned tools" as checkboxes with a note field. Nothing recorded
// what came back or where it landed, so a $2,200 programmer and a fuel card
// were both satisfied by the same tick.
//
// This module does NOT own company property. Nova's property lives in several
// places on purpose - equipment in the Assets module, vans in Fleet,
// credentials in the Vault, and things like shop keys and badges nowhere at
// all - and unifying them is a much larger job than this. So the receipt is a
// VIEW plus a ledger of dispositions: tracked lines stay owned by Assets and
// are moved through its own primitives, untracked lines are recorded as text,
// and one page finally lists them together.
//
// The inventory primitives are imported from routes/assets.js rather than
// reimplemented. closeHolding / adjustStock / transferHoldingToUser are the only
// correct ways to move this stuff, and there must be one copy of each.
//
// Posting is a separate step from signing, deliberately. See POST /:id/post.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.
const express = require('express');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const propUtil = require('../utils/property');
const assets = require('./assets');
// The offboarding org-tree rule. See the scoping note on postReceipt below for
// why this, and not the Assets module's city scope, is what gates a receipt.
const { canReachUser } = require('./offboarding');

const router = express.Router();

const OUTCOMES = propUtil.OUTCOMES;
const DISPOSITIONS = propUtil.DISPOSITIONS;
const missingForPost = propUtil.missingForPost;

// ---------------------------------------------------------------- helpers

function trunc(s, n) {
  if (s == null) return null;
  const t = String(s);
  return t.length > n ? t.slice(0, n) : t;
}

async function logOffboardingEvent(offboardingId, actorId, kind, detail) {
  try {
    await pool.query(
      'INSERT INTO offboarding_events (offboarding_id, actor_id, kind, detail, created_at) VALUES ($1,$2,$3,$4,NOW())',
      [offboardingId, actorId || null, kind, JSON.stringify(detail || {})]
    );
  } catch (e) { console.error('[property] offboarding event:', e.message); }
}

// Year-sequenced, e.g. RCP-2026-0001.
async function generateReceiptNumber() {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(receipt_number, '-', 3) AS INTEGER)) AS maxseq FROM property_receipts WHERE receipt_number LIKE $1",
    ['RCP-' + year + '-%']
  );
  return 'RCP-' + year + '-' + String((rows[0].maxseq || 0) + 1).padStart(4, '0');
}

async function loadReceipt(id) {
  const { rows } = await pool.query(
    'SELECT r.*, o.last_day, o.status AS offboarding_status, u.name AS employee_name, u.title AS job_title, ' +
    '       u.home_city AS employee_city ' +
    'FROM property_receipts r ' +
    'JOIN offboardings o ON o.id = r.offboarding_id ' +
    'JOIN users u ON u.id = r.user_id WHERE r.id = $1',
    [id]
  );
  return rows.length ? rows[0] : null;
}

async function linesFor(receiptId) {
  const { rows } = await pool.query(
    'SELECT l.*, du.name AS dest_user_name FROM property_receipt_lines l ' +
    'LEFT JOIN users du ON du.id = l.dest_user_id ' +
    'WHERE l.receipt_id = $1 ORDER BY l.position ASC, l.id ASC',
    [receiptId]
  );
  return rows;
}

// Load, then check the caller may act on this person at all. Returns the row or
// sends the response itself.
async function loadForStaff(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!(id > 0)) { res.status(400).json({ error: 'Bad id' }); return null; }
  const r = await loadReceipt(id);
  if (!r) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!(await canReachUser(req.user, r.user_id))) {
    res.status(403).json({ error: 'This person is outside your team.' });
    return null;
  }
  return r;
}

function lockedMessage(r) {
  if (r.status === 'posted') return 'This receipt is posted. Reverse it first if something needs changing.';
  return null;
}

// Everything the person holds right now, in the shape the receipt draws.
// asset_holdings with returned_at IS NULL is the live answer to "what do they
// have" - there is no second list to keep in step.
async function openHoldings(userId) {
  const { rows } = await pool.query(
    'SELECT h.*, t.name, t.category, t.serialized, a.asset_tag, a.serial_number ' +
    'FROM asset_holdings h ' +
    'JOIN asset_types t ON t.id = h.asset_type_id ' +
    'LEFT JOIN assets a ON a.id = h.asset_id ' +
    'WHERE h.user_id = $1 AND h.returned_at IS NULL ' +
    'ORDER BY t.category ASC, t.name ASC',
    [userId]
  );
  return rows;
}

// ---------------------------------------------------------------- staff API

// GET /api/property/pickers - cities and people the dropdowns offer. One call so
// the editor does not fire three on open.
router.get('/pickers', requireAuth, requirePermission('view_offboarding'), async function (req, res) {
  try {
    const cities = (await pool.query(
      'SELECT code, name FROM cities WHERE active IS DISTINCT FROM false ORDER BY name ASC'
    )).rows;
    const people = (await pool.query(
      'SELECT id, name, title, role, home_city FROM users WHERE active = true ORDER BY name ASC'
    )).rows;
    res.json({ cities: cities, people: people });
  } catch (e) {
    console.error('GET /property/pickers:', e.message);
    res.status(500).json({ error: 'Failed to load the lists' });
  }
});

// GET /api/property/by-offboarding/:obId - the receipt for one offboarding, or
// null. What the card on the offboarding record calls.
router.get('/by-offboarding/:obId', requireAuth, requirePermission('view_offboarding'), async function (req, res) {
  try {
    const obId = parseInt(req.params.obId, 10);
    if (!(obId > 0)) return res.status(400).json({ error: 'Bad id' });
    const ob = (await pool.query('SELECT id, user_id FROM offboardings WHERE id = $1', [obId])).rows[0];
    if (!ob) return res.status(404).json({ error: 'Not found' });
    if (!(await canReachUser(req.user, ob.user_id))) {
      return res.status(403).json({ error: 'This person is outside your team.' });
    }
    const row = (await pool.query('SELECT id FROM property_receipts WHERE offboarding_id = $1', [obId])).rows[0];
    if (!row) {
      // Nothing started yet. Say how much is waiting, so the card can be honest
      // about the size of the job before anybody opens it.
      const held = await openHoldings(ob.user_id);
      return res.json({ receipt: null, lines: [], holdings_waiting: held.length });
    }
    const receipt = await loadReceipt(row.id);
    const lines = await linesFor(row.id);
    res.json({
      receipt: receipt,
      lines: lines,
      totals: propUtil.totals(lines),
      summary: propUtil.postSummary(lines, null),
      blockers: receipt.status === 'draft' ? missingForPost(lines) : []
    });
  } catch (e) {
    console.error('GET /property/by-offboarding:', e.message);
    res.status(500).json({ error: 'Failed to load the receipt' });
  }
});

// POST /api/property - start the receipt and pull in everything they hold.
// One per offboarding, enforced by a unique index as well as here.
router.post('/', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  const client = await pool.connect();
  try {
    const obId = parseInt(req.body && req.body.offboarding_id, 10);
    if (!(obId > 0)) return res.status(400).json({ error: 'offboarding_id is required' });
    const ob = (await pool.query('SELECT * FROM offboardings WHERE id = $1', [obId])).rows[0];
    if (!ob) return res.status(404).json({ error: 'Offboarding not found' });
    if (!(await canReachUser(req.user, ob.user_id))) {
      return res.status(403).json({ error: 'This person is outside your team.' });
    }
    const existing = (await pool.query('SELECT id FROM property_receipts WHERE offboarding_id = $1', [obId])).rows[0];
    if (existing) return res.json({ id: existing.id, existed: true });

    const held = await openHoldings(ob.user_id);
    const number = await generateReceiptNumber();

    await client.query('BEGIN');
    const ins = await client.query(
      "INSERT INTO property_receipts (offboarding_id, user_id, receipt_number, status, created_by) " +
      "VALUES ($1,$2,$3,'draft',$4) RETURNING id",
      [obId, ob.user_id, number, req.user.id]
    );
    const id = ins.rows[0].id;

    // Snapshot every line at the moment the receipt is opened - label, serial,
    // tag, qty, cost. Renaming a tool next year must not rewrite what somebody
    // signed. Same discipline as addAckLines() on the issuing side.
    for (var i = 0; i < held.length; i++) {
      const h = held[i];
      await client.query(
        'INSERT INTO property_receipt_lines ' +
        '(receipt_id, holding_id, asset_type_id, asset_id, label, serial_number, asset_tag, category, qty, ' +
        ' unit_cost, from_city_code, tracked, outcome, disposition, dest_city_code, position) ' +
        "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,'returned','stock',$12,$13)",
        [id, h.id, h.asset_type_id, h.asset_id || null, trunc(h.name || 'Equipment', 255),
         trunc(h.serial_number, 120), trunc(h.asset_tag, 40), h.category || null, h.qty || 1,
         h.unit_cost, h.city_code || null, h.city_code || null, i]
      );
    }
    await client.query('COMMIT');

    await logOffboardingEvent(obId, req.user.id, 'property_receipt_created',
      { receipt_number: number, lines: held.length });
    res.status(201).json({ id: id, receipt_number: number, lines: held.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    console.error('POST /property:', e.message);
    res.status(500).json({ error: 'Failed to start the receipt' });
  } finally { client.release(); }
});

// PUT /api/property/:id/lines - save the whole grid. Draft only: once posted,
// the lines are what the inventory movement was built from and what the
// signature attests to, so they stop being editable.
router.put('/:id/lines', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  const client = await pool.connect();
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    const locked = lockedMessage(r);
    if (locked) return res.status(400).json({ error: locked });
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : [];

    await client.query('BEGIN');
    for (var i = 0; i < lines.length; i++) {
      const l = lines[i] || {};
      const lineId = parseInt(l.id, 10);
      if (!(lineId > 0)) continue;
      await client.query(
        'UPDATE property_receipt_lines SET outcome = $1, disposition = $2, condition_in = $3, ' +
        'dest_city_code = $4, dest_user_id = $5, note = $6, qty = $7, position = $8 ' +
        'WHERE id = $9 AND receipt_id = $10',
        [OUTCOMES.indexOf(l.outcome) !== -1 ? l.outcome : 'returned',
         DISPOSITIONS.indexOf(l.disposition) !== -1 ? l.disposition : 'none',
         l.condition_in || null,
         l.dest_city_code ? String(l.dest_city_code).toUpperCase().slice(0, 3) : null,
         parseInt(l.dest_user_id, 10) || null,
         trunc(l.note, 1000),
         Math.max(1, parseInt(l.qty, 10) || 1),
         i, lineId, r.id]
      );
    }
    await client.query('UPDATE property_receipts SET notes = $1, updated_at = NOW() WHERE id = $2',
      [trunc((req.body || {}).notes, 4000), r.id]);
    await client.query('COMMIT');

    const fresh = await linesFor(r.id);
    res.json({ success: true, lines: fresh, totals: propUtil.totals(fresh), blockers: missingForPost(fresh) });
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    console.error('PUT /property/:id/lines:', e.message);
    res.status(500).json({ error: 'Failed to save the receipt' });
  } finally { client.release(); }
});

// POST /api/property/:id/lines - add one line by hand. This is how the fuel
// card, the shop keys and the badge get onto a receipt: they are real company
// property that the Assets module never issued, so there is no holding behind
// them and nothing moves in inventory when they are posted.
router.post('/:id/lines', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    const locked = lockedMessage(r);
    if (locked) return res.status(400).json({ error: locked });
    const label = String((req.body && req.body.label) || '').trim();
    if (!label) return res.status(400).json({ error: 'Give the item a name.' });
    const pos = (await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM property_receipt_lines WHERE receipt_id = $1', [r.id]
    )).rows[0].n;
    const ins = await pool.query(
      'INSERT INTO property_receipt_lines (receipt_id, label, serial_number, qty, tracked, outcome, disposition, note, position) ' +
      "VALUES ($1,$2,$3,$4,false,'returned','none',$5,$6) RETURNING *",
      [r.id, trunc(label, 255), trunc((req.body || {}).serial_number, 120),
       Math.max(1, parseInt((req.body || {}).qty, 10) || 1), trunc((req.body || {}).note, 1000), pos]
    );
    res.status(201).json(ins.rows[0]);
  } catch (e) {
    console.error('POST /property/:id/lines:', e.message);
    res.status(500).json({ error: 'Failed to add the line' });
  }
});

// DELETE /api/property/:id/lines/:lineId - only a hand-added line. A tracked
// line cannot be deleted off a receipt: it represents something the person
// actually holds, and letting it be removed is exactly how an item goes missing
// with the paperwork still looking complete. Mark it not returned instead.
router.delete('/:id/lines/:lineId', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    const locked = lockedMessage(r);
    if (locked) return res.status(400).json({ error: locked });
    const l = (await pool.query('SELECT * FROM property_receipt_lines WHERE id = $1 AND receipt_id = $2',
      [parseInt(req.params.lineId, 10), r.id])).rows[0];
    if (!l) return res.status(404).json({ error: 'Line not found' });
    if (l.tracked) {
      return res.status(400).json({
        error: 'That is equipment they actually hold, so it cannot be taken off the receipt. Mark it as not returned if it did not come back.'
      });
    }
    await pool.query('DELETE FROM property_receipt_lines WHERE id = $1', [l.id]);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE /property/:id/lines/:lineId:', e.message);
    res.status(500).json({ error: 'Failed to remove the line' });
  }
});

// Tick the checklist step this receipt stands for. Matched on auto_key, never
// on title - a manager can rename a step in Setup. Fails quiet: inventory that
// has already moved must not be undone by a checklist write.
async function completeChecklistStep(offboardingId, receipt, lineCount) {
  try {
    await pool.query(
      "UPDATE offboarding_steps SET status = 'done', completed_at = NOW(), evidence = $2 " +
      "WHERE offboarding_id = $1 AND auto_key = 'receipt_of_property' AND status <> 'done'",
      [offboardingId, JSON.stringify({
        note: 'Receipt ' + receipt.receipt_number + ' posted (' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + ').',
        receipt_id: receipt.id
      })]
    );
  } catch (e) { console.error('[property] step complete:', e.message); }
}

// POST /api/property/:id/post - the one that moves real inventory.
//
// WHY POSTING IS SEPARATE FROM SIGNING. The manager collects the gear on the
// last day; the person may not sign for days. If the holdings only closed on
// signature, Nova would spend that week insisting a departed tech still holds
// fourteen tools that are sitting on a shelf. So posting is its own action, done
// when the equipment is physically in hand, and the signature afterwards attests
// to the list as posted.
//
// SCOPING NOTE. The Assets module scopes by city; offboarding scopes by org
// tree, and the two disagree. This uses the ORG TREE: a manager offboarding
// their own report has to be able to account for that person's equipment
// wherever it happened to be issued, and the alternative leaves a tech's kit
// unclosable because it was issued in a city their manager does not run. Every
// stock move records the acting user, so the city manager can see who moved it.
router.post('/:id/post', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  const client = await pool.connect();
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    if (r.status === 'posted') return res.status(400).json({ error: 'This receipt is already posted.' });

    const lines = await linesFor(r.id);
    const problems = missingForPost(lines);
    if (problems.length) return res.status(400).json({ error: problems[0], blockers: problems });

    await client.query('BEGIN');
    var moved = 0, opened = 0;

    for (var i = 0; i < lines.length; i++) {
      const l = lines[i];

      // Untracked lines are a record, not a movement. Nothing in Assets knows
      // about a shop key, so posting one only freezes what was written down.
      if (!l.tracked || !l.holding_id) continue;

      const h = (await client.query('SELECT * FROM asset_holdings WHERE id = $1 FOR UPDATE', [l.holding_id])).rows[0];
      if (!h) continue;
      if (h.returned_at) {
        // Somebody returned it through the Assets screen while this receipt sat
        // in draft. That is not an error - the item is accounted for - so the
        // line is marked and the rest of the receipt carries on.
        await client.query("UPDATE property_receipt_lines SET posted_note = $1 WHERE id = $2",
          ['Already closed in Equipment before this receipt was posted.', l.id]);
        continue;
      }

      const city = propUtil.restockCity(l, h);
      const opts = propUtil.closeOptionsFor(l);
      opts.actor = req.user;
      opts.ref_type = 'property_receipt';
      opts.ref_id = r.id;
      opts.note = 'Offboarding receipt ' + r.receipt_number;

      // closeHolding restocks to the holding's own city. A manager may be
      // shelving it somewhere else, so it is handed a copy carrying the
      // destination rather than teaching closeHolding a second rule.
      const forClose = Object.assign({}, h, { city_code: city || h.city_code });
      await assets.closeHolding(client, forClose, opts);
      moved++;

      if (l.disposition === 'stock' && h.asset_id && city) {
        // A serialized unit's city_code is its OWNING location and closeHolding
        // does not touch it, so shelving it in another city has to say so.
        await client.query('UPDATE assets SET city_code = $1, updated_at = NOW() WHERE id = $2', [city, h.asset_id]);
      }

      if (l.disposition === 'person' && l.dest_user_id) {
        const nh = await assets.transferHoldingToUser(client, h, {
          to_user_id: l.dest_user_id, city_code: city, actor: req.user,
          condition: l.condition_in || null,
          notes: 'Taken on from ' + (r.employee_name || 'a departing employee') + ' on receipt ' + r.receipt_number
        });
        await client.query('UPDATE property_receipt_lines SET new_holding_id = $1 WHERE id = $2', [nh.id, l.id]);
        opened++;
      }

      if (l.disposition === 'retire' && h.asset_id) {
        await client.query(
          "UPDATE assets SET status = 'retired', active = false, updated_at = NOW() WHERE id = $1", [h.asset_id]);
      }
      if (l.outcome === 'kept' && h.asset_id) {
        // They keep it by agreement: it is not ours any more, so it comes off
        // the books rather than sitting forever as awaiting_return.
        await client.query(
          "UPDATE assets SET status = 'retired', active = false, updated_at = NOW() WHERE id = $1", [h.asset_id]);
      }
    }

    const t = propUtil.totals(lines);
    await client.query(
      "UPDATE property_receipts SET status = 'posted', posted_at = NOW(), posted_by = $1, " +
      'value_in_hand = $2, value_not_returned = $3, updated_at = NOW() WHERE id = $4',
      [req.user.id, t.value_in_hand, t.value_not_returned, r.id]
    );
    await client.query('COMMIT');

    await completeChecklistStep(r.offboarding_id, r, lines.length);
    await logOffboardingEvent(r.offboarding_id, req.user.id, 'property_receipt_posted', {
      receipt_number: r.receipt_number, holdings_closed: moved, holdings_opened: opened,
      not_returned: t.gone, value_not_returned: t.value_not_returned
    });
    try {
      await logAudit({ entity_type: 'property_receipt', entity_id: r.id, action: 'posted',
        user_id: req.user.id, user_name: req.user.name,
        details: { receipt: r.receipt_number, closed: moved, opened: opened } });
    } catch (e) {}

    res.json({ success: true, holdings_closed: moved, holdings_opened: opened, totals: t });
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    console.error('POST /property/:id/post:', e.message);
    res.status(400).json({ error: e.message || 'Failed to post the receipt' });
  } finally { client.release(); }
});

// POST /api/property/:id/reverse - undo a posted receipt.
//
// Posting moves live inventory, so it needs a way back. Stock is corrected with
// COMPENSATING asset_stock_moves rows rather than by deleting the originals -
// the ledger is the record of what happened, including the mistake, and a
// ledger you can delete from is not one.
router.post('/:id/reverse', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  const client = await pool.connect();
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    if (r.status !== 'posted') return res.status(400).json({ error: 'Only a posted receipt can be reversed.' });
    const reason = String((req.body && req.body.reason) || '').slice(0, 1000);
    const lines = await linesFor(r.id);

    await client.query('BEGIN');
    for (var i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l.tracked || !l.holding_id) continue;

      // Close the holding that was opened for somebody else, if there was one.
      if (l.new_holding_id) {
        const nh = (await client.query('SELECT * FROM asset_holdings WHERE id = $1', [l.new_holding_id])).rows[0];
        if (nh && !nh.returned_at) {
          await client.query(
            "UPDATE asset_holdings SET returned_at = NOW(), returned_reason = 'reversed', status = 'returned' WHERE id = $1",
            [nh.id]
          );
        }
        await client.query('UPDATE property_receipt_lines SET new_holding_id = NULL WHERE id = $1', [l.id]);
      }

      // Take back out whatever went onto a shelf.
      if (l.disposition === 'stock' && !l.asset_id && l.dest_city_code) {
        await assets.adjustStock(client, {
          asset_type_id: l.asset_type_id, city_code: l.dest_city_code, delta: -(l.qty || 1),
          reason: 'reversed', ref_type: 'property_receipt', ref_id: r.id, user: req.user,
          note: 'Receipt ' + r.receipt_number + ' reversed'
        });
      }

      // Reopen the original holding.
      await client.query(
        'UPDATE asset_holdings SET returned_at = NULL, returned_reason = NULL, condition_in = NULL, ' +
        "status = 'held' WHERE id = $1",
        [l.holding_id]
      );
      if (l.asset_id) {
        await client.query(
          "UPDATE assets SET assigned_user_id = $1, status = 'assigned', active = true, " +
          'city_code = COALESCE($2, city_code), updated_at = NOW() WHERE id = $3',
          [r.user_id, l.from_city_code || null, l.asset_id]
        );
      }
    }

    await client.query(
      "UPDATE property_receipts SET status = 'draft', posted_at = NULL, posted_by = NULL, " +
      'reversed_at = NOW(), reversed_by = $1, reversed_reason = $2, updated_at = NOW() WHERE id = $3',
      [req.user.id, reason || null, r.id]
    );
    // The checklist step goes back to pending with it: the thing it stood for is
    // no longer true.
    await client.query(
      "UPDATE offboarding_steps SET status = 'pending', completed_at = NULL, evidence = NULL " +
      "WHERE offboarding_id = $1 AND auto_key = 'receipt_of_property'",
      [r.offboarding_id]
    );
    await client.query('COMMIT');

    await logOffboardingEvent(r.offboarding_id, req.user.id, 'property_receipt_reversed',
      { receipt_number: r.receipt_number, reason: reason });
    try {
      await logAudit({ entity_type: 'property_receipt', entity_id: r.id, action: 'reversed',
        user_id: req.user.id, user_name: req.user.name, details: { reason: reason } });
    } catch (e) {}
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    console.error('POST /property/:id/reverse:', e.message);
    res.status(400).json({ error: e.message || 'Failed to reverse the receipt' });
  } finally { client.release(); }
});

// POST /api/property/:id/none - "there is nothing to hand back". Posts an empty
// receipt so the checklist step and the separation agreement are satisfied
// honestly, rather than by skipping a required step. Refused when they actually
// hold something, because that is the case this whole module exists for.
router.post('/:id/none', requireAuth, requirePermission('manage_offboarding'), async function (req, res) {
  try {
    const r = await loadForStaff(req, res);
    if (!r) return;
    if (r.status === 'posted') return res.status(400).json({ error: 'This receipt is already posted.' });
    const lines = await linesFor(r.id);
    const tracked = lines.filter(function (l) { return l.tracked; });
    if (tracked.length) {
      return res.status(400).json({
        error: 'They still hold ' + tracked.length + ' tracked item' + (tracked.length === 1 ? '' : 's') +
          '. Account for those first.'
      });
    }
    await pool.query(
      "UPDATE property_receipts SET status = 'posted', posted_at = NOW(), posted_by = $1, " +
      "nothing_to_return = true, value_in_hand = 0, value_not_returned = 0, updated_at = NOW() WHERE id = $2",
      [req.user.id, r.id]
    );
    await completeChecklistStep(r.offboarding_id, r, 0);
    await logOffboardingEvent(r.offboarding_id, req.user.id, 'property_receipt_posted',
      { receipt_number: r.receipt_number, nothing_to_return: true });
    res.json({ success: true, nothing_to_return: true });
  } catch (e) {
    console.error('POST /property/:id/none:', e.message);
    res.status(500).json({ error: 'Failed to close the receipt' });
  }
});

module.exports = router;
// routes/separation.js prints the posted lines onto the document the person
// signs, and refuses to send until the receipt is posted.
module.exports.linesFor = linesFor;
module.exports.loadReceipt = loadReceipt;
