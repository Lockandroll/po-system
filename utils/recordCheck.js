// Wording check for the free-text fields on an employee record.
//
// One Anthropic call returns strict JSON: a list of flags, each red or amber,
// plus the green confirmations. Mirrors the direct-HTTPS pattern in
// utils/feedbackAI.js. It NEVER throws and it NEVER rewrites the stored text:
// the manager's words are what get saved. All this does is tell them what a
// lawyer would notice, and offer one suggested replacement they can take or
// leave.
//
// A red flag blocks submission. An amber one does not. That split is the whole
// design: the reds are the things that turn a notice into evidence against the
// company (protected classes, medical or leave reasons, threats, insults,
// judgments about the person rather than the behaviour), and the ambers are
// craft advice (guessing at intent, absolutes, missing dates, vagueness).
//
// If the API key is missing or the call fails, check() returns a null result and
// the caller treats the notice as unchecked rather than blocked. Losing the
// safety net must never stop a manager documenting something.
const https = require('https');

var MODEL = process.env.RECORD_AI_MODEL || process.env.FEEDBACK_AI_MODEL || 'claude-opus-4-8';

var FIELD_LABEL = {
  body: 'Description of the incident',
  corrective_action: 'What must change',
  consequence: 'Consequence if it does not'
};

var SYSTEM =
  'You review the wording of internal employee performance documentation for a locksmith and roadside ' +
  'service company (Lock and Roll, a Pop-A-Lock franchise). A manager has typed a field of a notice that ' +
  'will be shown to the employee and kept in their personnel file. ' +
  'You do NOT rewrite their facts and you do NOT soften the message. You point out wording that would ' +
  'weaken or endanger the document, and you confirm what is already good. ' +
  'Respond with ONLY a JSON object, no prose, no code fences. Schema: ' +
  '{"flags":[{"severity":"red"|"amber"|"green","title":"short bold label, under 60 chars",' +
  '"detail":"one or two plain sentences explaining it, under 300 chars"}],' +
  '"suggestion":{"replaces":"the exact substring of their text to replace, or empty string",' +
  '"text":"the replacement wording"} or null}. ' +
  'Return at most 5 flags. Always include at least one green flag when something is genuinely done well. ' +
  'Only offer a suggestion when you can improve specific wording without inventing facts; otherwise null. ' +
  'RED (these are serious): any reference to a protected class (race, colour, religion, sex, pregnancy, ' +
  'national origin, age, disability, genetic information, sexual orientation, gender identity, marital or ' +
  'veteran status); any reference to a medical condition, injury, workers compensation claim, doctor visit, ' +
  'FMLA or protected leave as a reason for the discipline; threats of harm; profanity; personal insults; ' +
  'and character judgments about the person ("lazy", "bad attitude", "does not care") in place of observed ' +
  'behaviour. ' +
  'AMBER (advice, not a blocker): asserting what the employee thought, felt or intended; absolutes and ' +
  'promises the company may not keep ("you will never", "this stays on your record forever"); missing ' +
  'dates, times or specifics; expectations that are not measurable; second-hand claims presented as fact. ' +
  'GREEN: dated and specific facts, a named business impact, a measurable expectation, neutral tone.';

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

function cleanFlags(raw) {
  if (!Array.isArray(raw)) return [];
  var out = [];
  for (var i = 0; i < raw.length && out.length < 5; i++) {
    var f = raw[i] || {};
    var sev = String(f.severity || '').toLowerCase();
    if (['red', 'amber', 'green'].indexOf(sev) === -1) continue;
    var title = String(f.title || '').slice(0, 80);
    if (!title) continue;
    out.push({ severity: sev, title: title, detail: String(f.detail || '').slice(0, 400) });
  }
  return out;
}

function cleanSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var text = String(raw.text || '').trim();
  if (!text) return null;
  return { replaces: String(raw.replaces || '').slice(0, 600), text: text.slice(0, 900) };
}

// Check ONE field. Resolves { field, flags, suggestion, reds, ambers, checked }
// or { field, checked:false } when the model could not be reached.
async function checkField(field, text, ctx) {
  var label = FIELD_LABEL[field] || field;
  var value = String(text || '').trim();
  if (!value) return { field: field, checked: false, flags: [], suggestion: null, reds: 0, ambers: 0 };
  var prompt =
    'Field: ' + label + '\n' +
    'Notice level: ' + ((ctx && ctx.levelLabel) || 'not stated') + '\n' +
    'Category: ' + ((ctx && ctx.category) || 'not stated') + '\n\n' +
    'The manager wrote:\n"""\n' + value.slice(0, 6000) + '\n"""';
  var out = await callAnthropic(prompt);
  var parsed = extractJson(out);
  if (!parsed) return { field: field, checked: false, flags: [], suggestion: null, reds: 0, ambers: 0 };
  var flags = cleanFlags(parsed.flags);
  var reds = 0, ambers = 0;
  flags.forEach(function (f) {
    if (f.severity === 'red') reds++;
    else if (f.severity === 'amber') ambers++;
  });
  return {
    field: field,
    checked: true,
    flags: flags,
    suggestion: cleanSuggestion(parsed.suggestion),
    reds: reds,
    ambers: ambers
  };
}

// Check every field present on a record. Fields run in parallel; a field that
// fails simply comes back unchecked.
async function checkRecord(fields, ctx) {
  var names = Object.keys(fields || {}).filter(function (k) { return FIELD_LABEL[k] && fields[k]; });
  if (!names.length) return { available: !!process.env.ANTHROPIC_API_KEY, fields: {}, reds: 0, ambers: 0, checked_at: new Date().toISOString() };
  var results = await Promise.all(names.map(function (n) { return checkField(n, fields[n], ctx); }));
  var byField = {}, reds = 0, ambers = 0, anyChecked = false;
  results.forEach(function (r) {
    byField[r.field] = r;
    reds += r.reds; ambers += r.ambers;
    if (r.checked) anyChecked = true;
  });
  return {
    available: anyChecked,
    fields: byField,
    reds: reds,
    ambers: ambers,
    checked_at: new Date().toISOString()
  };
}

module.exports = {
  FIELD_LABEL: FIELD_LABEL,
  checkField: checkField,
  checkRecord: checkRecord
};
