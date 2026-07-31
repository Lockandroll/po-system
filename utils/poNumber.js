// Shared purchase-order numbering.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
//
// The same three helpers were already duplicated byte-for-byte in
// routes/pos.js and routes/running.js. routes/assets.js would have been a
// third copy, so they live here now. The existing two files still carry their
// own copies and are untouched on purpose: changing working PO creation is not
// worth the risk in the same change that introduces a new module. When someone
// next has reason to touch pos.js or running.js, delete their local copies and
// require this instead.
//
// Format: CITY-YYYY-NNNN-INITIALS, e.g. CHS-2026-0417-DW
//
// The sequence is GLOBAL per calendar year, not per city. That is existing
// behaviour and is deliberately preserved here so numbers minted by this module
// interleave correctly with numbers minted by the other two.
//
// generatePONumber is NOT race-safe on its own: two concurrent callers read the
// same MAX and produce the same number. Safety comes from the UNIQUE index on
// purchase_orders.po_number plus a retry loop in the caller, which must catch
// Postgres error 23505 and try again. See withPoNumberRetry below.
const { pool } = require('../db');

function getInitials(name) {
  return (name || '').split(' ').map(function (w) { return w[0] || ''; }).join('').toUpperCase().slice(0, 3);
}

function computeTotal(items) {
  return (items || []).reduce(function (sum, i) {
    return sum + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0);
  }, 0);
}

async function generatePONumber(cityCode, userInitials) {
  const year = new Date().getFullYear();
  const { rows } = await pool.query(
    "SELECT MAX(CAST(SPLIT_PART(po_number, '-', 3) AS INTEGER)) as maxseq FROM purchase_orders WHERE EXTRACT(YEAR FROM created_at) = $1",
    [year]
  );
  const seq = String((rows[0].maxseq || 0) + 1).padStart(4, '0');
  return cityCode + '-' + year + '-' + seq + '-' + userInitials;
}

// Runs fn(po_number) inside the standard 10-attempt unique-collision retry.
// fn must do its own BEGIN/COMMIT and must ROLLBACK before throwing, exactly
// like the loops in pos.js and running.js.
async function withPoNumberRetry(cityCode, userInitials, fn) {
  var lastErr = null;
  for (var attempt = 0; attempt < 10; attempt++) {
    const po_number = await generatePONumber(cityCode, userInitials);
    try {
      return await fn(po_number);
    } catch (err) {
      lastErr = err;
      if (err && err.code === '23505' && attempt < 9) continue;
      throw err;
    }
  }
  throw lastErr || new Error('Could not allocate a PO number');
}

module.exports = {
  getInitials: getInitials,
  computeTotal: computeTotal,
  generatePONumber: generatePONumber,
  withPoNumberRetry: withPoNumberRetry
};
