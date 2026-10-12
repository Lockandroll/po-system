// utils/policySearch.js
// One place that searches the company's written policies for Nova AI.
//
// Two sources, searched as one:
//   1. the SOP library (sop_documents / sop_chunks), active rows only;
//   2. any Document Vault folder an admin flagged as a policy source
//      (documents / document_chunks under docText.POLICY_TREE_CTE).
//
// Used by:
//   - routes/ai.js POST /chat   (automatic retrieval stuffed into the prompt)
//   - routes/ai.js GET /policies + /policies/search, which back the
//     search_company_policies / list_company_policies tools in lib/novaTools.js,
//     so the agent (/agent), SMS and the MCP connector can all look a policy up.
//
// Why this exists (2026-10-12): Russ asked the agent for the maximum vacation
// days in the SOP and it said it had no tool for SOPs. Only /chat had retrieval;
// the tool-using agent had none. Tony: "The AI needs to be a source for the people."
//
// Exposure: same as /chat has always had. Every signed-in person already gets
// these excerpts in plain chat, so a tool that returns them is not a new door.
// The Vault side is ONLY folders flagged policy_source, never the whole Vault.
//
// No backticks anywhere (Windows-safe, see CLAUDE.md 1.1).

var docText = require('./docText');

// Words people use for the same policy. Full-text search will not connect
// "vacation" to a PTO policy on its own, and that is exactly the question
// that started this. Kept small on purpose; extend in settings if it grows.
var SYNONYMS = {
  vacation: 'pto paid time off leave',
  vacations: 'pto paid time off leave',
  pto: 'paid time off vacation leave',
  holiday: 'holidays pto',
  sick: 'pto illness leave call out',
  callout: 'call out absence attendance',
  late: 'tardy tardiness attendance',
  tardy: 'late attendance',
  uniform: 'dress code attire',
  dress: 'uniform attire',
  fired: 'termination discipline',
  termination: 'discipline separation',
  writeup: 'write up discipline disciplinary',
  pay: 'payroll wage compensation',
  payday: 'payroll pay period',
  overtime: 'ot payroll hours',
  phone: 'cell phone device',
  vehicle: 'van truck fleet driving',
  van: 'vehicle fleet',
  accident: 'incident crash vehicle',
  cash: 'deposit payment',
  refund: 'refunds return',
  max: 'maximum limit cap',
  maximum: 'max limit cap',
  limit: 'maximum cap'
};

function expandQuery(q) {
  var text = String(q || '').slice(0, 2000);
  var words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  var extra = [];
  for (var i = 0; i < words.length; i++) {
    if (Object.prototype.hasOwnProperty.call(SYNONYMS, words[i])) extra.push(SYNONYMS[words[i]]);
  }
  return extra.length ? (text + ' ' + extra.join(' ')) : text;
}

// OR the terms (better recall than websearch's default AND), rank by overlap.
var Q_CTE = "q AS (SELECT replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery AS tq)";

// $2 = optional title filter ('' = none). Matching is a case-insensitive contains.
var SOP_SELECT =
  "SELECT 'sop'::text AS source, d.id, d.title, COALESCE(d.version, 1) AS version, c.chunk_index, c.content, ts_rank(c.tsv, q.tq) AS rank " +
  "FROM sop_chunks c JOIN sop_documents d ON d.id = c.sop_id, q " +
  "WHERE d.active = true AND c.tsv @@ q.tq AND ($2 = '' OR d.title ILIKE '%' || $2 || '%')";
var VAULT_SELECT =
  "SELECT 'vault'::text AS source, doc.id, doc.name AS title, NULL::int AS version, dc.chunk_index, dc.content, ts_rank(dc.tsv, q.tq) AS rank " +
  "FROM document_chunks dc JOIN documents doc ON doc.id = dc.document_id, q " +
  "WHERE doc.status = 'ready' AND doc.folder_id IN (SELECT id FROM policy_tree) AND dc.tsv @@ q.tq " +
  "AND ($2 = '' OR doc.name ILIKE '%' || $2 || '%')";

// Read a whole document in order (title given, no query): first N chunks.
var SOP_READ =
  "SELECT 'sop'::text AS source, d.id, d.title, COALESCE(d.version, 1) AS version, c.chunk_index, c.content, 0::real AS rank " +
  "FROM sop_chunks c JOIN sop_documents d ON d.id = c.sop_id " +
  "WHERE d.active = true AND d.title ILIKE '%' || $1 || '%'";
var VAULT_READ =
  "SELECT 'vault'::text AS source, doc.id, doc.name AS title, NULL::int AS version, dc.chunk_index, dc.content, 0::real AS rank " +
  "FROM document_chunks dc JOIN documents doc ON doc.id = dc.document_id " +
  "WHERE doc.status = 'ready' AND doc.folder_id IN (SELECT id FROM policy_tree) AND doc.name ILIKE '%' || $1 || '%'";

function trimToBudget(rows, budget) {
  var out = [];
  var left = budget;
  for (var i = 0; i < rows.length; i++) {
    if (left <= 0) break;
    var r = rows[i];
    var chunk = String(r.content || '').slice(0, left);
    out.push({
      source: r.source, id: r.id, title: r.title, version: r.version,
      chunk_index: r.chunk_index, rank: r.rank != null ? Number(r.rank) : null, content: chunk
    });
    left -= chunk.length;
  }
  return out;
}

// searchPolicies(pool, query, opts) -> [{ source, id, title, version, chunk_index, rank, content }]
//   opts.limit  max chunks (default 12, max 40)
//   opts.budget max total characters returned (default 40000)
//   opts.title  restrict to documents whose title contains this
// With a title and no query, returns that document's text in order.
async function searchPolicies(pool, query, opts) {
  opts = opts || {};
  var limit = Math.max(1, Math.min(parseInt(opts.limit, 10) || 12, 40));
  var budget = Math.max(1000, Math.min(parseInt(opts.budget, 10) || 40000, 80000));
  var title = String(opts.title || '').trim().slice(0, 200);
  var q = String(query || '').trim();

  if (!q && title) {
    var read;
    try {
      read = await pool.query(
        docText.POLICY_TREE_CTE + ' ' + SOP_READ + ' UNION ALL ' + VAULT_READ +
        ' ORDER BY source, id, chunk_index LIMIT ' + limit,
        [title]
      );
    } catch (e) {
      read = await pool.query(SOP_READ + ' ORDER BY id, chunk_index LIMIT ' + limit, [title]);
    }
    return trimToBudget(read.rows, budget);
  }
  if (!q) return [];

  var expanded = expandQuery(q);
  var rows;
  try {
    rows = await pool.query(
      docText.POLICY_TREE_CTE + ', ' + Q_CTE + ' ' +
      SOP_SELECT + ' UNION ALL ' + VAULT_SELECT + ' ORDER BY rank DESC LIMIT ' + limit,
      [expanded, title]
    );
  } catch (e) {
    // A deployment without the document_chunks migration still answers from SOPs.
    console.error('Policy search (SOP+vault) failed, falling back to SOPs:', e.message);
    rows = await pool.query('WITH ' + Q_CTE + ' ' + SOP_SELECT + ' ORDER BY rank DESC LIMIT ' + limit, [expanded, title]);
  }
  return trimToBudget(rows.rows, budget);
}

// listPolicies(pool) -> [{ source, id, title, version, updated_at }]
async function listPolicies(pool) {
  var out = [];
  try {
    var s = await pool.query(
      'SELECT id, title, COALESCE(version, 1) AS version, COALESCE(updated_at, created_at) AS updated_at ' +
      'FROM sop_documents WHERE active = true ORDER BY title'
    );
    s.rows.forEach(function (r) { out.push({ source: 'sop', id: r.id, title: r.title, version: r.version, updated_at: r.updated_at }); });
  } catch (e) { console.error('listPolicies SOP read failed:', e.message); }
  try {
    var v = await pool.query(
      docText.POLICY_TREE_CTE +
      " SELECT d.id, d.name AS title FROM documents d WHERE d.status = 'ready' AND d.folder_id IN (SELECT id FROM policy_tree) ORDER BY d.name"
    );
    v.rows.forEach(function (r) { out.push({ source: 'vault', id: r.id, title: r.title }); });
  } catch (e) { /* no vault policy folders on this deployment */ }
  return out;
}

// How many policy documents exist at all (both sources).
async function countPolicies(pool) {
  var n = 0;
  try {
    var a = await pool.query('SELECT COUNT(*)::int AS n FROM sop_documents WHERE active = true');
    n += a.rows[0].n;
  } catch (e) {}
  try {
    var b = await pool.query(
      docText.POLICY_TREE_CTE +
      " SELECT COUNT(*)::int AS n FROM documents d WHERE d.status = 'ready' AND d.folder_id IN (SELECT id FROM policy_tree)"
    );
    n += b.rows[0].n;
  } catch (e) {}
  return n;
}

module.exports = {
  searchPolicies: searchPolicies,
  listPolicies: listPolicies,
  countPolicies: countPolicies,
  expandQuery: expandQuery
};
