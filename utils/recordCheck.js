// Wording check for the free-text fields on an employee record.
//
// One Anthropic call PER FIELD, each with its own rubric. It NEVER throws and it
// NEVER rewrites the stored text: the manager's words are what get saved. All it
// does is tell them what a lawyer would notice, and offer one suggested
// replacement they can take or leave.
//
// A red flag blocks submission. An amber one does not. That split is the whole
// design: the reds are the things that turn a notice into evidence against the
// company (protected classes, medical or leave reasons, threats, insults,
// judgments about the person rather than the behaviour), and the ambers are
// craft advice.
//
// WHY EACH FIELD HAS ITS OWN RUBRIC
// ---------------------------------
// This used to be one prompt for all three fields, and it graded every field as
// though it were the incident narrative. The result was advice like "add dates
// and specific incidents" on "What must change" - a field whose entire job is to
// be forward-looking, where the date belongs three inches further up the page
// and was already there. Advice that is wrong about what a field is FOR trains
// people to ignore the check, which costs more than not having one.
//
// So each field now gets: what it is for, what it is judged on, and an explicit
// list of things that are NOT its job because they belong to a sibling field.
// Every call is also handed the other fields as read-only context, so the model
// can see the date is already stated rather than asking for it again.
//
// If the API key is missing or a call fails, that field comes back unchecked and
// the caller treats it as unchecked rather than blocked. Losing the safety net
// must never stop a manager documenting something.
const https = require('https');

var MODEL = process.env.RECORD_AI_MODEL || process.env.FEEDBACK_AI_MODEL || 'claude-opus-4-8';

var FIELD_LABEL = {
  body: 'Description of the incident',
  corrective_action: 'What must change',
  consequence: 'Consequence if it does not'
};

// The order fields appear on the form. Used to build the context block, so the
// model sees the notice the way the manager does.
var FIELD_ORDER = ['body', 'corrective_action', 'consequence'];

// Applies to every field, unchanged. These are the ones that turn a personnel
// file into an exhibit.
var UNIVERSAL_RED =
  'RED, in ANY field (these are serious and they block the notice): any reference to a protected class ' +
  '(race, colour, religion, sex, pregnancy, national origin, age, disability, genetic information, sexual ' +
  'orientation, gender identity, marital or veteran status); any reference to a medical condition, injury, ' +
  'workers compensation claim, doctor visit, FMLA or protected leave as a reason for the discipline; threats ' +
  'of harm; profanity; personal insults; and character judgments about the person ("lazy", "bad attitude", ' +
  '"does not care") in place of observed behaviour.';

// One entry per field. purpose = what the field is for, in the manager's terms.
// green/amber = what to praise and what to warn about IN THIS FIELD. red = what
// is disqualifying here on top of UNIVERSAL_RED. not_here = the sibling field's
// job, stated as a prohibition, because this is the failure that actually
// happened in production.
var FIELD_RUBRIC = {
  body: {
    purpose:
      'This field is the RECORD OF WHAT HAPPENED. Its job is to describe an observed event in enough detail ' +
      'that somebody reading the file in a year, who was not there, knows exactly what occurred and could ' +
      'tell whether it happened again. It is backward-looking and factual.',
    green:
      'GREEN here: a date, and a time where the timing is part of the offence; what was OBSERVED rather than ' +
      'concluded; the specific job, call, customer or shift it happened on; the effect on the business or the ' +
      'customer, stated plainly; neutral tone.',
    amber:
      'AMBER here: no date, or no time where the timing is the point; asserting what the employee thought, ' +
      'felt, intended or knew; second-hand claims written as established fact; vague quantities ("often", ' +
      '"several times", "regularly") where a count or a list of dates is available; an unfilled placeholder ' +
      'such as [X], TBD or a blank; stating that a standard was breached without saying what the standard is.',
    red: '',
    not_here:
      'NOT your job in this field: whether the expectation going forward is measurable, and whether the ' +
      'consequence is proportionate. Those are other fields and they are shown to you below as context.'
  },
  corrective_action: {
    purpose:
      'This field is the INSTRUCTION. Its job is to say what THIS employee must do differently from now on. ' +
      'It is forward-looking. It is not a second telling of the incident, and it is not a summary of the ' +
      'notice - the incident is already written in the field above.',
    green:
      'GREEN here: a specific required behaviour rather than an attitude; a standard somebody could actually ' +
      'measure against (a number, a deadline, a named procedure); something inside this employee\'s own ' +
      'control; a clear starting point (immediately, or a stated date).',
    amber:
      'AMBER here: re-telling the incident instead of stating the expectation; an expectation nobody could ' +
      'measure ("do better", "improve communication", "be more professional"); an expectation aimed at the ' +
      'department or at other people rather than at this employee; a threshold left as a placeholder or left ' +
      'out where the rule needs one; requiring an outcome the employee does not control rather than the ' +
      'behaviour they do.',
    red:
      'ALSO RED here: requiring anything unlawful or unsafe - working off the clock, skipping a legally ' +
      'required break, not taking protected leave, not reporting an injury, or driving in a way that breaks ' +
      'the law.',
    not_here:
      'NOT your job in this field, and you must NOT raise it here: dates, times, or specific past occurrences. ' +
      'Those belong in the incident description, which is shown to you below as context - if it is missing ' +
      'there, that is a flag on that field, not on this one. Do not ask this field to cite examples.'
  },
  consequence: {
    purpose:
      'This field is WHAT HAPPENS NEXT if the expectation is not met. Its job is to name the specific next ' +
      'step and to match where this notice sits on the progressive discipline ladder, which runs Verbal ' +
      'Warning, First Written, Second Written, Final Written (carries a suspension), Termination.',
    green:
      'GREEN here: names one specific next step; that step is the next rung up from this notice\'s level, or ' +
      'the same rung with a stated reason; neutral, unemotional wording; a stated window where the ladder ' +
      'has one.',
    amber:
      'AMBER here: vague outcomes ("further disciplinary action", "action will be taken", "consequences will ' +
      'follow"); skipping rungs - threatening termination on a verbal warning - without saying why; absolutes ' +
      'and promises the company may not be able to keep ("you will never", "this stays on your record ' +
      'forever"); a deadline with no date; a placeholder left in.',
    red:
      'ALSO RED here: any consequence outside the employment relationship (reporting the person to the ' +
      'police, personal threats, threats to their family or immigration status), and anything that reads as ' +
      'punishment for a protected activity such as filing a complaint, reporting a safety issue or claiming ' +
      'workers compensation.',
    not_here:
      'NOT your job in this field: whether the incident is dated, and whether the corrective action is ' +
      'measurable. Both are other fields and both are shown to you below as context.'
  }
};

var SCHEMA_RULES =
  'Respond with ONLY a JSON object, no prose, no code fences. Schema: ' +
  '{"flags":[{"severity":"red"|"amber"|"green","title":"short bold label, under 60 chars",' +
  '"detail":"one or two plain sentences explaining it, under 300 chars"}],' +
  '"suggestion":{"replaces":"the exact substring of their text to replace, or empty string",' +
  '"text":"the replacement wording"} or null}. ' +
  'Return at most 4 flags. Always include at least one green flag when something is genuinely done well. ' +
  'Only offer a suggestion when you can improve specific wording in THIS field without inventing facts; ' +
  'otherwise null.';

// Build the system prompt for one field. Assembled rather than stored whole so
// the universal rules cannot drift apart between fields.
function systemFor(field) {
  var r = FIELD_RUBRIC[field];
  if (!r) return null;
  return 'You review the wording of internal employee performance documentation for a locksmith and roadside ' +
    'service company (Lock and Roll, a Pop-A-Lock franchise). A manager has typed ONE FIELD of a notice that ' +
    'will be shown to the employee and kept in their personnel file.\n\n' +
    'You are reviewing the field "' + FIELD_LABEL[field] + '" and NOTHING ELSE.\n\n' +
    r.purpose + '\n\n' +
    r.not_here + '\n\n' +
    'You do NOT rewrite their facts and you do NOT soften the message. You point out wording that would ' +
    'weaken or endanger the document, and you confirm what is already good.\n\n' +
    UNIVERSAL_RED + (r.red ? ('\n\n' + r.red) : '') + '\n\n' +
    r.amber + '\n\n' + r.green + '\n\n' +
    'Every flag you return must be about the text of this field. If the problem you have spotted would be ' +
    'fixed by editing a different field, do not return it at all.\n\n' +
    SCHEMA_RULES;
}

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

function callAnthropic(system, userText) {
  return new Promise(function (resolve) {
    if (!process.env.ANTHROPIC_API_KEY) { resolve(null); return; }
    var body = JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: system,
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
  for (var i = 0; i < raw.length && out.length < 4; i++) {
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

// The other fields, verbatim, marked as off limits. This is what stops the
// corrective action being told to add a date that is already two fields up.
function contextBlock(field, fields) {
  var lines = [];
  FIELD_ORDER.forEach(function (f) {
    if (f === field) return;
    var v = String((fields && fields[f]) || '').trim();
    lines.push('[' + FIELD_LABEL[f] + '] ' + (v ? v.slice(0, 4000) : '(not written yet)'));
  });
  if (!lines.length) return '';
  return '\n\nThe rest of the notice, FOR CONTEXT ONLY. Do not review these fields and do not raise flags ' +
    'about them:\n' + lines.join('\n\n');
}

// Check ONE field. Resolves { field, flags, suggestion, reds, ambers, checked }
// or { field, checked:false } when the model could not be reached.
async function checkField(field, text, ctx, fields) {
  var system = systemFor(field);
  var value = String(text || '').trim();
  if (!system || !value) return { field: field, checked: false, flags: [], suggestion: null, reds: 0, ambers: 0 };
  var prompt =
    'Notice level: ' + ((ctx && ctx.levelLabel) || 'not stated') + '\n' +
    'Category: ' + ((ctx && ctx.category) || 'not stated') + '\n\n' +
    'The manager wrote this in "' + FIELD_LABEL[field] + '":\n"""\n' + value.slice(0, 6000) + '\n"""' +
    contextBlock(field, fields || {});
  var out = await callAnthropic(system, prompt);
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
    ambers: ambers,
    rubric: FIELD_LABEL[field]
  };
}

// Check every field present on a record. Fields run in parallel; a field that
// fails simply comes back unchecked. Each one is handed the whole record so it
// can see what the sibling fields already say.
async function checkRecord(fields, ctx) {
  var names = Object.keys(fields || {}).filter(function (k) { return FIELD_RUBRIC[k] && fields[k]; });
  if (!names.length) return { available: !!process.env.ANTHROPIC_API_KEY, fields: {}, reds: 0, ambers: 0, checked_at: new Date().toISOString() };
  var results = await Promise.all(names.map(function (n) { return checkField(n, fields[n], ctx, fields); }));
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
  FIELD_RUBRIC: FIELD_RUBRIC,
  FIELD_ORDER: FIELD_ORDER,
  systemFor: systemFor,
  contextBlock: contextBlock,
  checkField: checkField,
  checkRecord: checkRecord
};
