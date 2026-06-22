const express = require('express');
const https = require('https');
const { pool } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

function norm(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function cleanRow(r) {
  r = r || {};
  var price = r.price;
  var parsed = (price === '' || price == null || isNaN(parseFloat(price))) ? null : parseFloat(price);
  return {
    item_number: (r.item_number == null ? '' : String(r.item_number)).trim().slice(0, 150),
    alias: (r.alias == null ? '' : String(r.alias)).trim().slice(0, 150),
    description: (r.description == null ? '' : String(r.description)).trim().slice(0, 500),
    price: parsed,
    preferred_vendor: (r.preferred_vendor == null ? '' : String(r.preferred_vendor)).trim().slice(0, 255)
  };
}

// GET /api/parts  — list or search (any authenticated user can search to build a PO/REQ)
router.get('/', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q) {
    const like = '%' + q + '%';
    const { rows } = await pool.query(
      'SELECT * FROM parts WHERE item_number ILIKE $1 OR alias ILIKE $1 OR description ILIKE $1 OR preferred_vendor ILIKE $1 ORDER BY description ASC LIMIT 500',
      [like]
    );
    return res.json(rows);
  }
  const { rows } = await pool.query('SELECT * FROM parts ORDER BY description ASC LIMIT 2000');
  res.json(rows);
});

// POST /api/parts — create one part
router.post('/', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  const r = cleanRow(req.body);
  if (!r.description) return res.status(400).json({ error: 'Description is required' });
  const { rows } = await pool.query(
    'INSERT INTO parts (item_number, alias, description, price, preferred_vendor) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [r.item_number || null, r.alias || null, r.description, r.price, r.preferred_vendor || null]
  );
  res.status(201).json(rows[0]);
});

// PUT /api/parts/:id — update a part
router.put('/:id', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  const r = cleanRow(req.body);
  if (!r.description) return res.status(400).json({ error: 'Description is required' });
  const { rows } = await pool.query(
    'UPDATE parts SET item_number=$1, alias=$2, description=$3, price=$4, preferred_vendor=$5, updated_at=NOW() WHERE id=$6 RETURNING *',
    [r.item_number || null, r.alias || null, r.description, r.price, r.preferred_vendor || null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Part not found' });
  res.json(rows[0]);
});

// DELETE /api/parts/:id
router.delete('/:id', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  await pool.query('DELETE FROM parts WHERE id=$1', [req.params.id]);
  res.json({ success: true });
});

// POST /api/parts/bulk-delete  — delete several parts at once. Body: { ids: [1,2,3] }
router.post('/bulk-delete', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x); }) : [];
  if (!ids.length) return res.status(400).json({ error: 'No parts selected.' });
  const r = await pool.query('DELETE FROM parts WHERE id = ANY($1::int[])', [ids]);
  res.json({ success: true, deleted: r.rowCount });
});

function callClaude(systemPrompt, userContent) {
  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const r = https.request(options, function(resp) {
      var data = '';
      resp.on('data', function(c) { data += c; });
      resp.on('end', function() {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.content && parsed.content[0] && parsed.content[0].text) {
            resolve(parsed.content[0].text);
          } else {
            reject(new Error('Unexpected AI response'));
          }
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

function extractJson(text) {
  var start = text.indexOf('[');
  var end = text.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

// POST /api/parts/check-duplicates
// Body: { rows: [{item_number, alias, description, price, preferred_vendor}, ...] }
// Returns: { results: [{index, row, status:'unique'|'duplicate', matches:[...]}], ai_used }
router.post('/check-duplicates', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  const incoming = Array.isArray(req.body.rows) ? req.body.rows.map(cleanRow) : [];
  if (!incoming.length) return res.json({ results: [], ai_used: false });

  const { rows: existing } = await pool.query('SELECT id, item_number, alias, description, preferred_vendor FROM parts');

  const results = incoming.map(function(row, idx) {
    return { index: idx, row: row, status: 'unique', matches: [] };
  });

  function pushMatch(target, m) {
    if (target.matches.some(function(x){ return x.kind === m.kind && x.ref === m.ref; })) return;
    target.matches.push(m);
    target.status = 'duplicate';
  }

  // Local normalized exact matching — reliable backstop, always runs.
  incoming.forEach(function(row, idx) {
    var ni = norm(row.item_number), na = norm(row.alias);
    existing.forEach(function(ep) {
      var ei = norm(ep.item_number), ea = norm(ep.alias);
      var hit = (ni && (ni === ei || ni === ea)) || (na && (na === ei || na === ea));
      if (hit) {
        pushMatch(results[idx], { kind: 'existing', ref: 'e' + ep.id, part_id: ep.id, item_number: ep.item_number, alias: ep.alias, description: ep.description, reason: 'Same item number or alias already in the catalog' });
      }
    });
    for (var j = 0; j < idx; j++) {
      var pr = incoming[j];
      var pi = norm(pr.item_number), pa = norm(pr.alias);
      var hit2 = (ni && (ni === pi || ni === pa)) || (na && (na === pi || na === pa));
      if (hit2) {
        pushMatch(results[idx], { kind: 'batch', ref: 'b' + j, batch_index: j, item_number: pr.item_number, alias: pr.alias, description: pr.description, reason: 'Duplicates another row in this file' });
      }
    }
  });

  // AI fuzzy pass — best-effort, bounded so prompts stay small.
  var ai_used = false;
  var MAX_EXISTING_FOR_AI = 1000;
  if (process.env.ANTHROPIC_API_KEY && existing.length <= MAX_EXISTING_FOR_AI && incoming.length <= 400) {
    try {
      var sys = 'You are a data-quality assistant for a locksmith company parts catalog. ' +
        'Compare newly imported parts against the existing catalog and against each other to find likely DUPLICATES, ' +
        'including near-duplicates from typos, spacing, or formatting differences (for example "HON-484" vs "HON484"), ' +
        'or the same physical part described differently. Two parts from DIFFERENT vendors with different item numbers are NOT duplicates unless the description clearly refers to the identical part. ' +
        'Respond with ONLY a JSON array, no prose. Each element: {"new_index": <int>, "duplicate_of": "existing:<id>" or "new:<int>", "confidence": "high" or "medium" or "low", "reason": "<short>"}. ' +
        'Only include rows you believe are duplicates. If none, return [].';
      var payload = {
        existing: existing.map(function(e){ return { id: e.id, item_number: e.item_number, alias: e.alias, description: e.description, preferred_vendor: e.preferred_vendor }; }),
        new_rows: incoming.map(function(r, i){ return { index: i, item_number: r.item_number, alias: r.alias, description: r.description, preferred_vendor: r.preferred_vendor }; })
      };
      var text = await callClaude(sys, 'Existing catalog and new rows to check:' + String.fromCharCode(10) + JSON.stringify(payload));
      var arr = extractJson(text);
      if (Array.isArray(arr)) {
        ai_used = true;
        arr.forEach(function(item) {
          if (!item || typeof item.new_index !== 'number' || !results[item.new_index]) return;
          var dof = String(item.duplicate_of || '');
          if (dof.indexOf('existing:') === 0) {
            var eid = parseInt(dof.slice(9), 10);
            var ep = existing.find(function(e){ return e.id === eid; });
            if (ep) pushMatch(results[item.new_index], { kind: 'existing', ref: 'e' + ep.id, part_id: ep.id, item_number: ep.item_number, alias: ep.alias, description: ep.description, reason: (item.reason || 'Likely duplicate') + ' (AI, ' + (item.confidence || 'medium') + ' confidence)' });
          } else if (dof.indexOf('new:') === 0) {
            var bi = parseInt(dof.slice(4), 10);
            if (incoming[bi]) pushMatch(results[item.new_index], { kind: 'batch', ref: 'b' + bi, batch_index: bi, item_number: incoming[bi].item_number, alias: incoming[bi].alias, description: incoming[bi].description, reason: (item.reason || 'Likely duplicate') + ' (AI, ' + (item.confidence || 'medium') + ' confidence)' });
          }
        });
      }
    } catch (e) {
      console.error('Parts AI duplicate check failed (using local matching only):', e.message);
    }
  }

  res.json({ results: results, ai_used: ai_used });
});

// POST /api/parts/bulk — insert the rows the importer chose to keep
router.post('/bulk', requireAuth, requirePermission('manage_parts'), async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.map(cleanRow).filter(function(r){ return r.description; }) : [];
  if (!rows.length) return res.status(400).json({ error: 'No valid rows to import (each row needs a description)' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      await client.query(
        'INSERT INTO parts (item_number, alias, description, price, preferred_vendor) VALUES ($1,$2,$3,$4,$5)',
        [r.item_number || null, r.alias || null, r.description, r.price, r.preferred_vendor || null]
      );
    }
    await client.query('COMMIT');
    res.status(201).json({ inserted: rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
