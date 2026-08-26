'use strict';
/*
 * Per-field wording rubrics, and the SOP policy suggester.
 *
 * Two things are under test and neither needs a database or a network:
 *
 *   1. utils/recordCheck.js - each field is now judged on what THAT field is
 *      for. The bug this replaces was one prompt for all three fields, which
 *      told "What must change" to add dates and specific incidents. That field's
 *      job is the forward-looking expectation; the date lives in the incident
 *      description and was already there. So the assertions below are mostly
 *      about what each prompt REFUSES to ask for.
 *
 *   2. utils/policySuggest.js - retrieval, then the model, then a quote check.
 *      verifyCandidates() is the load-bearing half: a candidate whose quote is
 *      not verbatim in the excerpt it cited is dropped, because an invented
 *      clause number on a disciplinary notice is worse than no citation at all.
 *
 *   node test-record-check-policy.js
 *
 * House style: string concatenation only, no template literals.
 */

// Must be cleared BEFORE the modules load: with a key present, checkField and
// suggest would try to reach api.anthropic.com.
delete process.env.ANTHROPIC_API_KEY;

var rc = require('./utils/recordCheck');
var ps = require('./utils/policySuggest');

var PASS = 0, FAIL = 0;
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; console.error('  FAIL  ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function has(hay, needle, label) { ok(String(hay).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1, label + '  (missing: ' + needle + ')'); }
function lacks(hay, needle, label) { ok(String(hay).toLowerCase().indexOf(String(needle).toLowerCase()) === -1, label + '  (unexpected: ' + needle + ')'); }

async function main() {
console.log('Wording rubrics and policy suggestion');
console.log('-------------------------------------');
console.log('');
console.log('Each field is judged on its own job');

eq(rc.FIELD_ORDER.join(','), 'body,corrective_action,consequence', 'the three fields are the three on the form');
Object.keys(rc.FIELD_RUBRIC).forEach(function (f) {
  ok(rc.FIELD_ORDER.indexOf(f) !== -1, 'rubric "' + f + '" matches a real field');
  ok(!!rc.FIELD_LABEL[f], 'rubric "' + f + '" has the label the manager sees');
});

var body = rc.systemFor('body');
var corr = rc.systemFor('corrective_action');
var cons = rc.systemFor('consequence');

eq(rc.systemFor('nonsense'), null, 'a field with no rubric gets no prompt rather than a generic one');

// Each prompt names its own field and only its own field as the thing under review.
has(body, 'You are reviewing the field "Description of the incident" and NOTHING ELSE', 'the incident prompt scopes itself');
has(corr, 'You are reviewing the field "What must change" and NOTHING ELSE', 'the corrective action prompt scopes itself');
has(cons, 'You are reviewing the field "Consequence if it does not" and NOTHING ELSE', 'the consequence prompt scopes itself');

// THE REGRESSION. What must change must never be told to add dates or examples.
has(corr, 'you must NOT raise it here: dates, times, or specific past occurrences',
    'What must change is explicitly forbidden from asking for dates');
has(corr, 'Do not ask this field to cite examples', 'and from asking for past examples');
has(corr, 'forward-looking', 'because its job is the forward-looking expectation');
has(corr, 'not a second telling of the incident', 'and it says so in as many words');

// The incident description is where dates DO belong.
has(body, 'no date, or no time where the timing is the point', 'a missing date is an amber on the incident description');
has(body, 'NOT your job in this field: whether the expectation going forward is measurable',
    'and the incident description is not asked to be measurable');

// The consequence is judged against the ladder, not against the incident.
has(cons, 'progressive discipline ladder', 'the consequence is judged against the ladder');
has(cons, 'skipping rungs', 'skipping rungs is an amber');
has(cons, 'NOT your job in this field: whether the incident is dated', 'and it is not asked about dates either');

// Universal reds are identical in all three, assembled rather than copied.
['protected class', 'workers compensation', 'threats of harm', 'character judgments'].forEach(function (needle) {
  has(body, needle, 'incident prompt carries the universal red: ' + needle);
  has(corr, needle, 'corrective prompt carries the universal red: ' + needle);
  has(cons, needle, 'consequence prompt carries the universal red: ' + needle);
});

// Field-specific reds land only where they belong.
has(corr, 'working off the clock', 'demanding unlawful work is red on the corrective action');
lacks(body, 'working off the clock', 'and is not raised on the incident description');
has(cons, 'reporting the person to the police', 'a consequence outside employment is red on the consequence');
lacks(corr, 'reporting the person to the police', 'and not on the corrective action');
has(cons, 'punishment for a protected activity', 'retaliation-shaped consequences are red');

// Everything ends with the same shape rule, so one field cannot drift.
[body, corr, cons].forEach(function (p, i) {
  has(p, 'Respond with ONLY a JSON object', 'prompt ' + i + ' asks for JSON only');
  has(p, 'at most 4 flags', 'prompt ' + i + ' caps the flag count');
  has(p, 'If the problem you have spotted would be fixed by editing a different field, do not return it',
      'prompt ' + i + ' refuses cross-field advice outright');
});

console.log('');
console.log('Each field sees the rest of the notice, marked off limits');

var ctx = rc.contextBlock('corrective_action', {
  body: 'On 08/25/2026 Austin did not enroute an assigned Geico call for 20 minutes.',
  consequence: 'Any further occurrence will result in a First Written Warning.'
});
has(ctx, 'Do not review these fields', 'the context block says not to review what is in it');
has(ctx, '[Description of the incident] On 08/25/2026', 'the incident is passed through verbatim');
has(ctx, '[Consequence if it does not] Any further occurrence', 'so is the consequence');
lacks(ctx, '[What must change]', 'the field under review is not repeated back to itself');

var partial = rc.contextBlock('body', { corrective_action: '', consequence: '' });
has(partial, '(not written yet)', 'an empty sibling is shown as empty rather than omitted');
lacks(partial, '[Description of the incident]', 'and the field under review is still left out');

console.log('');
console.log('With no API key nothing reaches the network');

var out = await rc.checkField('body', 'Some text', { levelLabel: 'Verbal Warning (documented)' }, {});
eq(out.checked, false, 'an unreachable model leaves the field unchecked');
eq(out.reds, 0, 'and contributes no red flags');
var rec = await rc.checkRecord({ body: 'Some text', corrective_action: 'Be on time.' }, {});
eq(rec.available, false, 'the whole check reports itself unavailable');
eq(rec.reds, 0, 'so nothing is blocked by a check that never ran');
var empty = await rc.checkField('body', '   ', {}, {});
eq(empty.checked, false, 'an empty field is not sent anywhere at all');

console.log('');
console.log('Keywords for retrieval');

var kw = ps.keywords('On 08/25/2026, Austin did not accept a Geico call that was 90 minutes old. ' +
  'Once assigned, he did not enroute the call for 20 minutes.');
ok(kw.indexOf('geico') !== -1, 'a distinctive word survives');
ok(kw.indexOf('enroute') !== -1, 'so does the one that will actually match an SOP');
ok(kw.indexOf('the') === -1, 'noise words are dropped');
ok(kw.indexOf('did') === -1, 'so are the ones in every incident ever written');
ok(kw.indexOf('employee') === -1, 'including the word "employee" itself');
eq(kw.filter(function (x) { return x === 'call'; }).length, 1, 'a repeated word appears once');
ok(kw.every(function (x) { return x.length >= 3; }), 'nothing shorter than three characters');
ok(kw.every(function (x) { return /^[a-z0-9]+$/.test(x); }), 'punctuation cannot reach the tsquery');
var long = [];
for (var i = 0; i < 200; i++) long.push('word' + i);
eq(ps.keywords(long.join(' ')).length, 30, 'the term list is capped');
eq(ps.keywords('').length, 0, 'no text, no terms');

console.log('');
console.log('Quoting is normalised for style, not for content');

eq(ps.normalise('  The  quick\nbrown ' + String.fromCharCode(8220) + 'fox' + String.fromCharCode(8221) + ' '),
   'the quick brown "fox"', 'whitespace, case and curly quotes are levelled');
eq(ps.normalise('a' + String.fromCharCode(8212) + 'b'), 'a-b', 'and dash style');

console.log('');
console.log('A candidate has to be quotable or it does not exist');

var EXCERPTS = [
  { sop_id: 4, title: 'SOP-9 Dispatch and Enroute',
    content: 'Technicians must enroute an assigned call within 10 minutes of acceptance. ' +
             'The customer must be contacted before enrouting.' },
  { sop_id: 7, title: 'SOP-14 Attendance and Punctuality',
    content: 'Employees are expected to be on shift at their scheduled start time.' }
];

var good = ps.verifyCandidates({ candidates: [
  { doc: 1, quote: 'Technicians must enroute an assigned call within 10 minutes of acceptance.', why: '20 minutes exceeds it' }
] }, EXCERPTS);
eq(good.length, 1, 'a real quote survives');
eq(good[0].sop_id, 4, 'and carries the SOP id from the excerpt, never from the model');
eq(good[0].title, 'SOP-9 Dispatch and Enroute', 'the title comes from the excerpt too');
has(good[0].why, '20 minutes', 'the reasoning is passed through');

eq(ps.verifyCandidates({ candidates: [
  { doc: 1, quote: 'Technicians must enroute within 5 minutes per section 4.2 of this policy.', why: 'x' }
] }, EXCERPTS).length, 0, 'a plausible clause that is not in the document is dropped');

eq(ps.verifyCandidates({ candidates: [{ doc: 9, quote: EXCERPTS[0].content, why: 'x' }] }, EXCERPTS).length, 0,
   'a citation of an excerpt that was never shown is dropped');
eq(ps.verifyCandidates({ candidates: [{ doc: 0, quote: EXCERPTS[0].content, why: 'x' }] }, EXCERPTS).length, 0,
   'the numbering is 1-based, and 0 is not a document');
eq(ps.verifyCandidates({ candidates: [{ doc: 1, quote: 'must enroute', why: 'x' }] }, EXCERPTS).length, 0,
   'a two-word fragment proves nothing and is dropped');

// Whitespace and quote style differences are not forgery.
eq(ps.verifyCandidates({ candidates: [
  { doc: 1, quote: 'Technicians   must  enroute an assigned call\nwithin 10 minutes of acceptance.', why: 'x' }
] }, EXCERPTS).length, 1, 'reflowed whitespace still counts as quoted');

// Cross-citation: the right words, the wrong document.
eq(ps.verifyCandidates({ candidates: [
  { doc: 2, quote: 'Technicians must enroute an assigned call within 10 minutes of acceptance.', why: 'x' }
] }, EXCERPTS).length, 0, 'a real quote attributed to the wrong SOP is still dropped');

var dupe = ps.verifyCandidates({ candidates: [
  { doc: 1, quote: 'Technicians must enroute an assigned call within 10 minutes of acceptance.', why: 'first' },
  { doc: 1, quote: 'The customer must be contacted before enrouting.', why: 'second' }
] }, EXCERPTS);
eq(dupe.length, 1, 'one SOP is offered once, not once per clause');
has(dupe[0].why, 'first', 'and it is the best one that survives');

var many = [];
for (var j = 0; j < 8; j++) many.push({ doc: 1, quote: EXCERPTS[0].content, why: 'x' + j });
ok(ps.verifyCandidates({ candidates: many }, EXCERPTS).length <= ps.MAX_CANDIDATES, 'the list is capped');

eq(ps.verifyCandidates(null, EXCERPTS).length, 0, 'a null response is an empty list, not a crash');
eq(ps.verifyCandidates({ candidates: 'nope' }, EXCERPTS).length, 0, 'so is a malformed one');
eq(ps.verifyCandidates({ candidates: [{ doc: 1 }] }, EXCERPTS).length, 0, 'a candidate with no quote at all is dropped');

console.log('');
console.log('Retrieval');

// Rows come back from the UNION carrying which side they were found on.
var CHUNKS = [];
[1, 1, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].forEach(function (id, n) {
  CHUNKS.push({ source: 'sop', ref_id: id, title: 'SOP ' + id, content: 'chunk ' + n, rank: 1 });
});
// ...and a vault policy document that happens to share an id with a SOP, ranked
// high enough to actually be reached. If the per-document budget were keyed on
// the id alone these two would fight over the same three slots, which is the bug
// this row exists to catch.
CHUNKS.splice(4, 0, { source: 'document', ref_id: 1, title: 'Dispatch Policy.pdf', content: 'vault chunk', rank: 1 });
var calls = [];
var fakePool = { query: function (sql, params) { calls.push({ sql: sql, params: params }); return Promise.resolve({ rows: CHUNKS }); } };

var got = await ps.retrieve(fakePool, 'austin did not enroute the geico call');
ok(got.length <= 12, 'no more than twelve excerpts go to the model  (got ' + got.length + ')');
eq(got.filter(function (x) { return x.source === 'sop' && x.sop_id === 1; }).length, 3,
   'one long SOP cannot take more than three slots');
eq(got.filter(function (x) { return x.source === 'document' && x.document_id === 1; }).length, 1,
   'and a vault document with the same id keeps its own budget');
var vault = got.filter(function (x) { return x.source === 'document'; })[0];
eq(vault.sop_id, null, 'a vault excerpt carries no SOP id');
eq(vault.document_id, 1, 'only a document id');
has(calls[0].sql, 'd.active = true', 'only active SOPs are searched');
has(calls[0].sql, 'sop_chunks', 'against the same index Neurolock uses');
has(calls[0].sql, 'UNION ALL', 'and the policy folders are searched in the same pass');
has(calls[0].sql, 'WITH RECURSIVE policy_tree', 'through the recursive policy tree');
has(calls[0].sql, "doc.status = 'ready'", 'ignoring uploads that never finished');
lacks(calls[0].params[0], ',', 'the terms reach Postgres as a plain word list');

var boomPool = { query: function () { return Promise.reject(new Error('relation "sop_chunks" does not exist')); } };
eq((await ps.retrieve(boomPool, 'anything')).length, 0, 'a database without the SOP tables returns nothing rather than throwing');

// The fallback that matters: document_chunks missing must not cost the SOP
// results too, or a half-deployed migration silently turns the feature off.
var halfDeployed = {
  tries: 0,
  query: function (sql) {
    this.tries++;
    if (String(sql).indexOf('document_chunks') !== -1) {
      return Promise.reject(new Error('relation "document_chunks" does not exist'));
    }
    return Promise.resolve({ rows: [{ source: 'sop', ref_id: 2, title: 'SOP 2', content: 'still here', rank: 1 }] });
  }
};
var fellBack = await ps.retrieve(halfDeployed, 'austin did not enroute the geico call');
eq(fellBack.length, 1, 'with the vault tables missing the SOP results still come back');
eq(fellBack[0].sop_id, 2, 'from the SOP library');
eq(halfDeployed.tries, 2, 'after exactly one retry, not a loop');
eq((await ps.retrieve(fakePool, '   ')).length, 0, 'no keywords, no query');

console.log('');
console.log('suggest() short-circuits before it spends anything');

var noText = await ps.suggest(fakePool, { body: '   ' });
eq(noText.reason, 'no_text', 'an empty incident is refused up front');
eq(noText.candidates.length, 0, 'with nothing suggested');
var noKey = await ps.suggest(fakePool, { body: 'Austin did not enroute the Geico call for 20 minutes.' });
eq(noKey.reason, 'no_key', 'with no API key it says so, rather than failing silently');
eq(noKey.available, false, 'and reports itself unavailable');

var emptyPool = { query: function () { return Promise.resolve({ rows: [] }); } };
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
var noMatch = await ps.suggest(emptyPool, { body: 'Austin did not enroute the Geico call for 20 minutes.' });
delete process.env.ANTHROPIC_API_KEY;
eq(noMatch.reason, 'no_match', 'retrieval finding nothing means the model is never called');
eq(noMatch.available, true, 'and that is a working answer, not an outage');
eq(noMatch.searched, 0, 'nothing was searched through');

console.log('');
console.log('Wired into the routes');

var fs = require('fs');
var ROUTES = fs.readFileSync('routes/employeeRecords.js', 'utf8');
lacks(ROUTES, String.fromCharCode(96), 'the route file is still backtick-free');
has(ROUTES, "require('../utils/policySuggest')", 'the route file uses the suggester');
has(ROUTES, "router.post('/policy-suggest', requireAuth, requirePermission('create_employee_note')",
    'suggesting a policy needs the same permission as writing the note');
has(ROUTES, 'policies: await activePolicies()', 'meta carries the SOP library for the dropdown');
has(ROUTES, "SELECT id, title FROM sop_documents WHERE active = true", 'only active SOPs, titles only');
has(ROUTES, "res.json({ available: false, reason: 'ai_failed', candidates: [] })",
    'a failed suggestion never 500s the form');
has(ROUTES, 'parseInt(b.sop_id, 10) || null', 'the draft still persists the SOP id it was given');

var FRONT = fs.readFileSync('public/js/employeeRecords.js', 'utf8');
has(FRONT, 'sop_id: citation().sop_id', 'the form sends the SOP id alongside the label');
has(FRONT, 'policy_document_id: citation().policy_document_id', 'or the vault document id, never both');
has(FRONT, '<optgroup label=', 'and the two sources are grouped in the dropdown');
has(FRONT, "onchange=\"erSopChanged()\"", 'switching to Other reveals the free-text box');
lacks(FRONT, String.fromCharCode(96), 'and the front end is backtick-free too');

console.log('');
console.log(PASS + ' passed, ' + FAIL + ' failed');
process.exit(FAIL ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
