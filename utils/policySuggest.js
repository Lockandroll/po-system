// "Which policy did this break?" - answered from the SOP library, not from the
// model's memory.
//
// The shape here is retrieval first, model second, verification third:
//
//   1. RETRIEVE. The incident description is reduced to keywords and run
//      against sop_chunks, the same Postgres full-text index Neurolock searches
//      (routes/ai.js). Only ACTIVE documents. If retrieval returns nothing there
//      is nothing to suggest and the model is never called.
//   2. CHOOSE. The model sees the incident and the retrieved excerpts, numbered,
//      and picks from those excerpts. It is told plainly that returning an empty
//      list is the correct answer when nothing fits.
//   3. VERIFY. Every candidate must carry a quote copied out of the excerpt it
//      chose, and that quote is checked back against the excerpt text here. A
//      quote that is not in the source means the model WROTE the policy instead
//      of finding it, and the candidate is dropped without being shown.
//
// Step 3 is the point of the whole file. A confidently invented clause number on
// a disciplinary notice is worse than no suggestion at all: it is a citation the
// employee can disprove, in a document whose only value is being true. Same rule
// as utils/ivrBrain.js - the model may judge, but it must quote, and the quote
// is checked.
//
// Nothing here writes anything. The manager still picks the policy.
const https = require('https');
const docText = require('./docText');

var MODEL = process.env.RECORD_AI_MODEL || process.env.FEEDBACK_AI_MODEL || 'claude-opus-4-8';

var MAX_CHUNKS = 12;       // excerpts handed to the model
var MAX_PER_DOC = 3;       // so one long SOP cannot crowd out the rest
var CHUNK_CHARS = 2200;    // per excerpt
var MIN_QUOTE = 20;        // a quote shorter than this proves nothing
var MAX_CANDIDATES = 3;

// Short list on purpose. The tsvector already drops English stop words; this is
// only here to stop the query being dominated by the words that appear in every
// single incident description ever written.
var NOISE = ('the a an and or but if then than that this these those of to in on at for with by from as is ' +
  'are was were be been being he she they them his her their it its i we you not no do did does done have ' +
  'has had will would should could may might must can shall about after before during while when where who ' +
  'whom which what why how also very much many more most other some any each per said told asked employee ' +
  'employees staff member team').split(' ');

function keywords(text) {
  var seen = {}, out = [];
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .forEach(function (w) {
      if (!w || w.length < 3) return;
      if (NOISE.indexOf(w) !== -1) return;
      if (seen[w]) return;
      seen[w] = 1;
      out.push(w);
    });
  return out.slice(0, 30);
}

// Whitespace and quote style are not part of a quotation. Everything else is.
function normalise(s) {
  return String(s || '')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Two places hold policy: the SOP library (sop_documents, admin-uploaded text)
// and the Document Vault (files in a folder an admin flagged as a policy
// source). They are searched together and ranked together, because a manager
// citing a policy does not care which of the two an admin happened to put it in.
//
// Only ACTIVE SOPs and files under a policy-source folder are reachable. Nothing
// else in the vault is searched by this query, ever.
var QUERY_CTE = "q AS (SELECT replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery AS tq)";

var SOP_SELECT =
  "SELECT 'sop' AS source, d.id AS ref_id, d.title AS title, c.content, ts_rank(c.tsv, q.tq) AS rank " +
  'FROM sop_chunks c JOIN sop_documents d ON d.id = c.sop_id, q ' +
  'WHERE d.active = true AND c.tsv @@ q.tq';

var VAULT_SELECT =
  "SELECT 'document' AS source, dc.document_id AS ref_id, doc.name AS title, dc.content, ts_rank(dc.tsv, q.tq) AS rank " +
  'FROM document_chunks dc JOIN documents doc ON doc.id = dc.document_id, q ' +
  "WHERE doc.status = 'ready' AND doc.folder_id IN (SELECT id FROM policy_tree) AND dc.tsv @@ q.tq";

// The SOP excerpts most likely to cover this incident. Returns [] rather than
// throwing: a search that fails is a missing suggestion, not a broken form.
//
// The union is attempted first and falls back to SOPs alone. That fallback is
// not decoration - it is what keeps this working on a deployment where the
// document_chunks migration has not landed yet, instead of losing the SOP
// results too because one table is missing.
async function retrieve(pool, text) {
  var terms = keywords(text);
  if (!terms.length) return [];
  var rows = null;
  try {
    rows = (await pool.query(
      docText.POLICY_TREE_CTE + ', ' + QUERY_CTE + ' ' +
      SOP_SELECT + ' UNION ALL ' + VAULT_SELECT + ' ORDER BY rank DESC LIMIT 40',
      [terms.join(' ')]
    )).rows;
  } catch (e) {
    console.error('[policy-suggest] combined retrieval failed, falling back to SOPs:', e.message);
    try {
      rows = (await pool.query(
        'WITH ' + QUERY_CTE + ' ' + SOP_SELECT + ' ORDER BY rank DESC LIMIT 40',
        [terms.join(' ')]
      )).rows;
    } catch (e2) {
      console.error('[policy-suggest] retrieval failed:', e2.message);
      return [];
    }
  }

  var perDoc = {}, out = [];
  for (var i = 0; i < rows.length && out.length < MAX_CHUNKS; i++) {
    var r = rows[i];
    // Key the per-document cap by source AND id: SOP 4 and vault document 4 are
    // different documents and must not share a budget.
    var key = r.source + ':' + r.ref_id;
    perDoc[key] = (perDoc[key] || 0) + 1;
    if (perDoc[key] > MAX_PER_DOC) continue;
    out.push({
      source: r.source,
      ref_id: r.ref_id,
      sop_id: r.source === 'sop' ? r.ref_id : null,
      document_id: r.source === 'document' ? r.ref_id : null,
      title: r.title,
      content: String(r.content || '').slice(0, CHUNK_CHARS)
    });
  }
  return out;
}

var SYSTEM =
  'You match a described workplace incident to the company\'s own written policy, for Lock and Roll LLC, a ' +
  'Pop-A-Lock locksmith and roadside franchise. A manager is writing a disciplinary notice and needs to cite ' +
  'the policy the incident breached.\n\n' +
  'You are given the incident and a numbered list of excerpts from the company policy documents. You may ONLY ' +
  'choose from those excerpts. You have no other knowledge of this company\'s policies, and you must not use ' +
  'general knowledge of what a policy usually says.\n\n' +
  'Returning an empty list is a CORRECT and expected answer. If none of the excerpts actually covers the ' +
  'behaviour described, return no candidates. Do not stretch a loosely related policy to fit - a wrong ' +
  'citation on a notice is worse than none, because the employee can disprove it.\n\n' +
  'Every candidate MUST include a quote copied character for character out of the excerpt you chose. Do not ' +
  'paraphrase, do not tidy it up, do not join two separate sentences. The quote is checked against the ' +
  'source text and a candidate whose quote cannot be found is discarded.\n\n' +
  'Respond with ONLY a JSON object, no prose, no code fences. Schema: ' +
  '{"candidates":[{"doc":<the number of the excerpt>,"quote":"verbatim text from that excerpt, at least one ' +
  'full sentence","why":"one sentence saying how the incident breaches it, under 200 chars"}]}. ' +
  'At most ' + MAX_CANDIDATES + ' candidates, best first.';

function extractJson(textOut) {
  if (!textOut) return null;
  try { return JSON.parse(textOut); } catch (e) {}
  var start = textOut.indexOf('{');
  var end = textOut.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(textOut.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function callAnthropic(userText) {
  return new Promise(function (resolve) {
    if (!process.env.ANTHROPIC_API_KEY) { resolve(null); return; }
    var body = JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }]
    });
    var options = {
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
    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          resolve((parsed && parsed.content && parsed.content[0] && parsed.content[0].text) || '');
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(30000, function () { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Step 3, on its own so it can be tested without a model or a database. Given
// what the model returned and the excerpts it was shown, hand back only the
// candidates whose quote is genuinely in the excerpt they cited.
//
// Everything that is dropped is dropped silently. A list that says "here are two
// policies and one thing I might have made up" is not a better list.
function verifyCandidates(raw, excerpts) {
  var out = [], seen = {};
  var list = (raw && Array.isArray(raw.candidates)) ? raw.candidates : [];
  for (var i = 0; i < list.length && out.length < MAX_CANDIDATES; i++) {
    var c = list[i] || {};
    var idx = parseInt(c.doc, 10);
    // "doc" is 1-based because that is how the excerpts are numbered for the
    // model. An out-of-range number is a hallucinated citation.
    if (!(idx >= 1 && idx <= excerpts.length)) continue;
    var src = excerpts[idx - 1];
    var quote = String(c.quote || '').trim();
    if (quote.length < MIN_QUOTE) continue;
    if (normalise(src.content).indexOf(normalise(quote)) === -1) continue;
    var key = src.source + ':' + src.ref_id;
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({
      source: src.source,
      sop_id: src.sop_id || null,
      document_id: src.document_id || null,
      title: src.title,
      quote: quote.slice(0, 600),
      why: String(c.why || '').slice(0, 240)
    });
  }
  return out;
}

// The whole thing. Never throws. reason says why a list is empty, so the form
// can tell the difference between "the AI is off" and "your SOP library does not
// cover this yet", which are two very different things to do something about.
async function suggest(pool, opts) {
  opts = opts || {};
  var text = String(opts.body || '').trim();
  if (!text) return { available: false, reason: 'no_text', candidates: [] };
  if (!process.env.ANTHROPIC_API_KEY) return { available: false, reason: 'no_key', candidates: [] };

  var excerpts = await retrieve(pool, text);
  if (!excerpts.length) return { available: true, reason: 'no_match', candidates: [], searched: 0 };

  var numbered = excerpts.map(function (e, i) {
    return '[' + (i + 1) + '] ' + e.title + '\n' + e.content;
  }).join('\n\n---\n\n');

  var prompt =
    'Incident as the manager described it:\n"""\n' + text.slice(0, 6000) + '\n"""\n' +
    (opts.category ? ('\nCategory the manager chose: ' + String(opts.category).slice(0, 60) + '\n') : '') +
    '\nExcerpts from the policy documents:\n\n' + numbered;

  var out = await callAnthropic(prompt);
  var parsed = extractJson(out);
  if (!parsed) return { available: false, reason: 'ai_failed', candidates: [], searched: excerpts.length };

  var candidates = verifyCandidates(parsed, excerpts);
  return {
    available: true,
    reason: candidates.length ? 'ok' : 'no_match',
    candidates: candidates,
    searched: excerpts.length
  };
}

module.exports = {
  keywords: keywords,
  normalise: normalise,
  retrieve: retrieve,
  verifyCandidates: verifyCandidates,
  suggest: suggest,
  MIN_QUOTE: MIN_QUOTE,
  MAX_CANDIDATES: MAX_CANDIDATES
};
