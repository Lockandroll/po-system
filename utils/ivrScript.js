// utils/ivrScript.js
//
// An account's phone tree is DATA, not code. A profile stores an ordered list of
// steps; this module turns that list into TwiML, previews it for a human, and
// judges the transcript that comes back. Nothing in here talks to Twilio or the
// database, which is what makes it testable without either. No backticks.
//
// Step shapes (JSON, stored on ivr_profiles.checkin_steps / checkout_steps):
//   { "type": "wait",   "seconds": 5 }
//   { "type": "press",  "digits": "1",       "label": "English" }
//   { "type": "send",   "field": "wo_number","suffix": "#" }   <- value from the job
//   { "type": "send",   "value": "4471",     "suffix": "#" }   <- literal
//   { "type": "listen", "seconds": 20 }                        <- always last

// Twilio's <Play digits> accepts ONLY these characters. Everything else is
// dropped, which is deliberate: a work order number is routinely printed as
// "4419-88213" and the dash would otherwise be sent as nothing useful, or throw.
//   w = 0.5s pause between tones, W = 1s.
//
// NOTE the character class has no space in it. An earlier version was written as
// [^0-9A-Dw W#*] for readability and the space inside it was, of course, a
// literal allowed character - so "(800) 555-0142" normalized to "800 5550142"
// and would have been sent to Twilio with a space in the middle.
var DTMF_OK = /[^0-9A-DwW#*]/g;

function normalizeDigits(s) {
  if (s == null) return '';
  return String(s).replace(DTMF_OK, '');
}

// The fields a step may pull from the job. Kept as a whitelist rather than a
// free-text lookup so a profile can never be pointed at, say, a password column.
var FIELDS = {
  wo_number: 'Work Order #',
  po_number: 'PO #',
  claim_id: 'Claim / Ref ID',
  store_number: 'Store #',
  account_number: 'Account #',
  checkin_reference: 'Check-In PIN (work order)',
  checkin_tracking: 'Check-In Tracking # (work order)',
  tech_reference: 'Technician ID',
  num_technicians: 'Number of technicians'
};

function fieldLabel(k) { return FIELDS[k] || k; }
function fieldList() {
  return Object.keys(FIELDS).map(function (k) { return { key: k, label: FIELDS[k] }; });
}

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function clampSeconds(n, dflt, max) {
  var v = parseInt(n, 10);
  if (!isFinite(v) || v < 1) v = dflt;
  if (v > max) v = max;
  return v;
}

// Resolve a step's outgoing digits against the job. Returns '' when the step
// points at a field the job does not have, which validate() and render() both
// treat as a hard error rather than dialling a half-finished sequence.
function stepDigits(step, values) {
  values = values || {};
  var raw = (step.field ? values[step.field] : step.value);
  return normalizeDigits(raw);
}

// Every step, resolved, in order. The single source of truth behind both the
// TwiML and the on-screen preview, so what a manager sees is what gets dialled.
function resolve(steps, values) {
  var out = [];
  (steps || []).forEach(function (step, i) {
    var t = String(step && step.type || '').toLowerCase();
    if (t === 'wait') {
      out.push({ i: i, type: 'wait', seconds: clampSeconds(step.seconds, 3, 60), label: step.label || '' });
    } else if (t === 'press') {
      out.push({ i: i, type: 'press', digits: normalizeDigits(step.digits), label: step.label || '' });
    } else if (t === 'send') {
      var d = stepDigits(step, values);
      out.push({
        i: i, type: 'send', digits: d, suffix: normalizeDigits(step.suffix || ''),
        field: step.field || null, missing: !d,
        label: step.label || (step.field ? fieldLabel(step.field) : '')
      });
    } else if (t === 'listen') {
      out.push({ i: i, type: 'listen', seconds: clampSeconds(step.seconds, 20, 120), label: step.label || '' });
    } else {
      out.push({ i: i, type: 'unknown', raw: t, label: '' });
    }
  });
  return out;
}

// Errors a human has to fix, not warnings. An empty array means dialable.
//
// There are two legitimate ways to terminate an entry: a suffix on the send step,
// or a separate press step after it. Both are supported because both read
// naturally to different people. What is NEVER right is doing both, and that
// mistake is invisible on screen - which is exactly why it is caught here rather
// than left to be discovered on a live call.
//
// It matters because the double tone is a RACE, not a clean failure. The first
// pound ends the tree's collection and sends it off to fetch its next prompt;
// whether the second lands in that gap and is discarded, or arrives just inside
// the next prompt and ends it empty, comes down to a few hundred milliseconds of
// somebody else's network. A script that works four times out of five is worse
// than one that never works.
function validate(steps, values) {
  var errs = [];
  var list = resolve(steps, values);
  if (!list.length) { errs.push('The script has no steps.'); return errs; }
  list.forEach(function (s, idx) {
    if (s.type === 'unknown') errs.push('Step ' + (s.i + 1) + ' has an unrecognised type.');
    if (s.type === 'press' && !s.digits) errs.push('Step ' + (s.i + 1) + ' presses nothing.');
    if (s.type === 'send' && s.missing) {
      // Say what to DO about it. "This job does not have it" is a fact; the
      // person reading it wants the next move, and there are only two.
      errs.push('Step ' + (s.i + 1) + ' sends ' + (s.field ? fieldLabel(s.field) : 'a value') +
        ', which this job does not have. Type it onto the work order, or re-parse the ' +
        'work order to pull it off the paperwork.');
    }
    // send-with-suffix immediately followed by a press of that same key
    if (s.type === 'send' && s.suffix) {
      var nxt = list[idx + 1];
      if (nxt && nxt.type === 'press' && nxt.digits === s.suffix) {
        errs.push('Step ' + (s.i + 1) + ' already ends with ' + s.suffix + ', and step ' + (nxt.i + 1) +
          ' presses ' + nxt.digits + ' again. Send it twice and the tree may drop the next prompt. ' +
          'Either clear the "then" box on step ' + (s.i + 1) + ' or delete step ' + (nxt.i + 1) + '.');
      }
    }
    // the same key pressed twice in a row on its own
    if (s.type === 'press' && s.digits) {
      var prev = list[idx - 1];
      if (prev && prev.type === 'press' && prev.digits === s.digits) {
        errs.push('Steps ' + (prev.i + 1) + ' and ' + (s.i + 1) + ' both press ' + s.digits +
          ' with nothing in between. That is almost never intended.');
      }
    }
  });
  return errs;
}

// The TwiML Twilio fetches when the call connects.
//
// Two deliberate choices. There is no <Gather> anywhere, because Twilio does not
// allow digits inside one. And the script always ends with a listen window and a
// <Hangup/>: that trailing pause is what keeps the line open long enough to
// record the tree saying "you are checked in", which is the only thing that
// makes the call count for anything.
function renderTwiml(steps, values, opts) {
  opts = opts || {};
  var list = resolve(steps, values);
  var body = [];
  var sawListen = false;
  list.forEach(function (s) {
    if (s.type === 'wait') body.push('  <Pause length="' + s.seconds + '"/>');
    else if (s.type === 'press' && s.digits) body.push('  <Play digits="' + xmlEscape(s.digits) + '"/>');
    else if (s.type === 'send' && s.digits) body.push('  <Play digits="' + xmlEscape('wwww' + s.digits + s.suffix) + '"/>');
    else if (s.type === 'listen') { sawListen = true; body.push('  <Pause length="' + s.seconds + '"/>'); }
  });
  if (!sawListen) body.push('  <Pause length="' + clampSeconds(opts.listenSeconds, 20, 120) + '"/>');
  body.push('  <Hangup/>');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n' + body.join('\n') + '\n</Response>';
}

// What the setup screen shows. Prints the NORMALIZED digits on purpose: if a
// work order number loses its dash on the way to the keypad, the person writing
// the script should find that out here and not at two in the morning.
function preview(steps, values, phoneNumber) {
  var parts = [];
  if (phoneNumber) parts.push('dial ' + phoneNumber);
  resolve(steps, values).forEach(function (s) {
    if (s.type === 'wait') parts.push('wait ' + s.seconds + 's');
    else if (s.type === 'press') parts.push('press ' + s.digits);
    else if (s.type === 'send') parts.push((s.digits || '(missing)') + s.suffix);
    else if (s.type === 'listen') parts.push('listen ' + s.seconds + 's');
  });
  return parts.join(' -> ');
}

// ---- Judging the call -----------------------------------------------------

function normalizeTranscript(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9#*'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phrases are stored as one string, separated by ; or newlines, because that is
// what a person can actually maintain in a text box.
function parsePhrases(raw) {
  if (Array.isArray(raw)) raw = raw.join(';');
  return String(raw == null ? '' : raw)
    .split(/[;\n]+/)
    .map(function (p) { return normalizeTranscript(p); })
    .filter(function (p) { return p.length > 0; });
}

// The rule the whole system hangs off: a call is confirmed ONLY when the tree
// said so. "The call connected" is not evidence of anything.
function matchConfirmation(transcript, phrasesRaw) {
  var hay = normalizeTranscript(transcript);
  var phrases = parsePhrases(phrasesRaw);
  if (!hay) return { matched: false, phrase: null, reason: 'no_transcript' };
  if (!phrases.length) return { matched: false, phrase: null, reason: 'no_phrases_configured' };
  for (var i = 0; i < phrases.length; i++) {
    if (hay.indexOf(phrases[i]) !== -1) return { matched: true, phrase: phrases[i], reason: null };
  }
  return { matched: false, phrase: null, reason: 'phrase_not_heard' };
}

// What the tree said INSTEAD, translated into the next thing to do.
//
// "Nova never heard the confirmation phrase" is true of every failure and
// therefore useful for none of them. The first live test failed with a
// transcript that ended "Nothing was entered. Goodbye." - which is not a
// mystery at all, it is a tree telling you a keypress landed in the wrong
// prompt. This turns the handful of things trees actually say into the one
// sentence that shortens the next attempt.
//
// Deliberately a small list of phrases that mean the same thing on every tree.
// It is a hint printed under the transcript, never an input to the verdict:
// nothing here can confirm a check-in or clear a flag.
var SIGNALS = [
  { any: ['no longer in service', 'has been disconnected', 'not in service', 'is not a working number'],
    say: 'That number is dead. Get the current check-in number off a recent work order before dialling again.' },
  { any: ['leave a message', 'after the tone', 'after the beep', 'voice mail', 'voicemail', 'not available to take your call'],
    say: 'That is a voicemail box, not a phone tree. Nova only dials trees. Check the number on the work order.' },
  { any: ['nothing was entered', 'no entry was received', 'did not receive any input', 'we did not receive', 'i did not get that', 'we did not get that', 'no input was received'],
    say: 'The tree heard nothing where it expected digits, which almost always means a keypress landed while it was still reading the prompt before. Add a second or two to the wait in front of that step.' },
  { any: ['not recognized', 'not valid', 'is invalid', 'was not found', 'no record', 'could not be found'],
    say: 'The tree got the digits but did not like them. Read them back off the transcript: if they are short, the wait before that step is too short and the front of the number is being clipped.' },
  { any: ['please try again', 'let us try that again', 'one more time'],
    say: 'The tree asked to start that entry over, so the script and the tree are out of step from that point on.' },
  { any: ['press 1 for', 'press one for', 'main menu', 'for english press', 'for english, press'],
    say: 'The recording ends on a menu, so the call never got past it. Either the first wait is too short and the keypress went out before the tree answered, or the menu wants a pound after the key.' },
  { any: ['transferring', 'please hold', 'one moment', 'representative', 'agent will be with you'],
    say: 'That path leads to a person. Nova is only ever meant to talk to a tree - change the steps so it stays inside the automated menu.' }
];

function diagnose(transcript) {
  var hay = normalizeTranscript(transcript);
  if (!hay) return 'There is no transcript, so the recording never arrived or the line was silent.';
  if (hay.split(' ').length < 6) return 'The tree barely said anything. It may have answered and hung up, or the recording was cut short.';
  // Late signals first: what a tree says last is what went wrong.
  var best = null;
  SIGNALS.forEach(function (sig) {
    sig.any.forEach(function (phrase) {
      var at = hay.lastIndexOf(phrase);
      if (at !== -1 && (!best || at > best.at)) best = { at: at, say: sig.say };
    });
  });
  return best ? best.say : null;
}

// The confirmation / authorization number the tree reads back at check-out.
// Stored as a plain regex on the profile but never shown to a manager as one -
// the setup screen builds it from a highlighted example (see the mockups).
//
// Never throws on a bad pattern. A profile with a broken capture must still be
// able to check somebody in; the number is evidence, not the outcome.
// Capture reads a LIGHTLY normalized transcript on purpose: lower-cased and
// whitespace-collapsed, but with punctuation intact. matchConfirmation strips
// punctuation because a phrase should match however the tree pronounces it, and
// running capture over that same text was a bug - the full stop after
// "authorization number is SC 77 4419 0093." is the only thing telling a greedy
// pattern where the number ends, and without it the capture swallowed
// "THANK YOU" as well.
function normalizeForCapture(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

function captureValue(transcript, pattern) {
  var pat = String(pattern == null ? '' : pattern).trim();
  if (!pat) return null;
  var hay = normalizeForCapture(transcript);
  try {
    var re = new RegExp(pat, 'i');
    var m = re.exec(hay);
    if (!m) return null;
    var val = (m[1] != null ? m[1] : m[0]);
    val = String(val).trim().toUpperCase();
    return val || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  normalizeDigits: normalizeDigits,
  xmlEscape: xmlEscape,
  fieldLabel: fieldLabel,
  fieldList: fieldList,
  resolve: resolve,
  validate: validate,
  renderTwiml: renderTwiml,
  preview: preview,
  normalizeTranscript: normalizeTranscript,
  normalizeForCapture: normalizeForCapture,
  parsePhrases: parsePhrases,
  matchConfirmation: matchConfirmation,
  diagnose: diagnose,
  captureValue: captureValue
};
