// test-ai-ivr.js
//
// The AI navigator, exercised without Twilio, without Anthropic and without a
// phone. Run it before anything dials:
//
//   node test-ai-ivr.js            offline, free, deterministic
//   node test-ai-ivr.js --live     same trees, but the REAL model decides
//                                  (needs ANTHROPIC_API_KEY; costs a few cents)
//
// The offline pass proves the plumbing and every guard rail: the interlock that
// hangs up on a human before the model is ever asked, the validator that turns
// a malformed action into an abort, the quote rule that refuses an invented
// confirmation, and the turn budget. None of that depends on how clever the
// model is, and all of it is what stops a bad turn becoming a false check-in.
//
// The --live pass is the other half: it shows whether the model can actually get
// through a tree it has not seen, including the two that go wrong on purpose.
//
// No backticks in this file.

var brain = require('./utils/ivrBrain');
var ivr = require('./utils/ivrScript');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
function section(t) { console.log('\n== ' + t); }

// ---------------------------------------------------------------------------
// 1. The interlock. Checked before the model on every turn, so none of these
//    ever costs a token and none of them can be talked out of.
// ---------------------------------------------------------------------------
section('the interlock');
ok('transfer stops the call', !!brain.hardStop('Please hold, a representative will be with you shortly.'));
eq('transfer names itself', brain.hardStop('Transferring you now.').reason, 'human_on_the_line');
eq('voicemail names itself', brain.hardStop('Please leave a message after the tone.').reason, 'voicemail');
eq('dead number names itself', brain.hardStop('The number you have dialed is no longer in service.').reason, 'number_dead');
ok('a normal prompt passes', brain.hardStop('For English, press 1.') === null);
ok('silence passes', brain.hardStop('') === null);
ok('a checked-in message passes', brain.hardStop('You are checked in at this time.') === null);

// ---------------------------------------------------------------------------
// 2. The validator. Six verbs, and a send may only name a value Nova resolved.
// ---------------------------------------------------------------------------
section('the action contract');
var VALUES = { checkin_reference: '62163', checkin_tracking: '360493481' };
var CTX = { values: VALUES, labels: { checkin_reference: 'Check-In PIN', checkin_tracking: 'Tracking #' } };

eq('press keeps its key', brain.validateAction({ action: 'press', digits: '1' }, CTX).digits, '1');
eq('press strips rubbish', brain.validateAction({ action: 'press', digits: '(1)' }, CTX).digits, '1');
eq('press nothing aborts', brain.validateAction({ action: 'press', digits: '' }, CTX).action, 'abort');
eq('send resolves the value', brain.validateAction({ action: 'send', field: 'checkin_tracking', suffix: '#' }, CTX).digits, '360493481');
eq('send keeps the suffix', brain.validateAction({ action: 'send', field: 'checkin_tracking', suffix: '#' }, CTX).suffix, '#');
eq('send of an unknown field aborts', brain.validateAction({ action: 'send', field: 'social_security' }, CTX).action, 'abort');
ok('and says why', /not one of the values/.test(brain.validateAction({ action: 'send', field: 'nope' }, CTX).error || ''));
eq('an invented action aborts', brain.validateAction({ action: 'transfer_me' }, CTX).action, 'abort');
eq('nothing at all aborts', brain.validateAction(null, CTX).action, 'abort');
eq('a raw digit string is not a path', brain.validateAction({ action: 'send', digits: '5551212' }, CTX).action, 'abort');
eq('wait is clamped', brain.validateAction({ action: 'wait', seconds: 900 }, CTX).seconds, 20);
eq('listen has a floor', brain.validateAction({ action: 'listen', seconds: 0 }, CTX).seconds, 8);
eq('confirm without a quote aborts', brain.validateAction({ action: 'confirm' }, CTX).action, 'abort');
eq('confirm with a quote survives', brain.validateAction({ action: 'confirm', quote: 'you are checked in at this time' }, CTX).action, 'confirm');

// ---------------------------------------------------------------------------
// 3. The quote rule. This is the one that makes "the model judges" survivable.
// ---------------------------------------------------------------------------
section('the quote rule');
var HEARD = 'P I N 6 2 1 6 3, work order 3 6 0 4 9 3 4 8 1. You are checked in at this time. Your authorization number is SC 77 4419 0093. Thank you.';
ok('a real quote passes', brain.verifyQuote('You are checked in at this time', HEARD).ok);
ok('punctuation does not matter', brain.verifyQuote('you are checked in, at this time.', HEARD).ok);
eq('an invented quote fails', brain.verifyQuote('your check in has been recorded successfully', HEARD).reason, 'quote_not_in_transcript');
eq('a two word quote is refused', brain.verifyQuote('checked in', HEARD).reason, 'quote_too_short');
eq('no transcript fails', brain.verifyQuote('you are checked in at this time', '').reason, 'no_transcript');
ok('the auth number is found', brain.verifyAuth('SC 77 4419 0093', HEARD));
ok('an invented auth number is not', !brain.verifyAuth('SC 11 2222 3333', HEARD));

// ---------------------------------------------------------------------------
// 4. Whole calls, against trees that behave the way real ones do.
//
// The fake model reads the SAME prompt the real one gets and nothing else,
// which is the point: if buildPrompt ever stops carrying what a decision needs,
// these stop passing.
// ---------------------------------------------------------------------------
function heardFromPrompt(p) {
  var m = /THE TREE JUST SAID\n  ([\s\S]*?)\n\nYou have/.exec(p);
  return m ? m[1] : '';
}
function keysFromPrompt(p) {
  var m = /VALUES YOU MAY SEND[^\n]*\n([\s\S]*?)\n\nTHE CALL SO FAR/.exec(p);
  if (!m) return [];
  return m[1].split('\n').map(function (l) { return (/^\s{2}(\w+)\s/.exec(l) || [])[1]; }).filter(Boolean);
}

// A deliberately literal stand-in. It is not pretending to be smart; it is
// pretending to be a model that follows the contract, so the harness around it
// is what gets tested.
function cannedModel(prompt) {
  var heard = heardFromPrompt(prompt).toLowerCase();
  var keys = keysFromPrompt(prompt);
  var out;
  if (/press 1|for english/.test(heard)) out = { action: 'press', digits: '1', reason: 'language menu', confidence: 'high' };
  else if (/pin/.test(heard) && /enter/.test(heard) && keys.indexOf('checkin_reference') !== -1) out = { action: 'send', field: 'checkin_reference', suffix: '#', confidence: 'high' };
  else if (/(tracking|work order)/.test(heard) && /enter/.test(heard) && keys.indexOf('checkin_tracking') !== -1) out = { action: 'send', field: 'checkin_tracking', suffix: '#', confidence: 'high' };
  else if (/press pound to confirm/.test(heard)) out = { action: 'press', digits: '#', confidence: 'high' };
  else if (/you are checked in at this time/.test(heard)) out = { action: 'confirm', quote: 'You are checked in at this time', auth_number: 'SC 77 4419 0093', confidence: 'high' };
  else if (/not recognized|try again|was not valid/.test(heard)) out = { action: 'abort', reason: 'the tree rejected the entry' };
  else if (/region code|zone number/.test(heard)) out = { action: 'abort', reason: 'the tree wants a value this job does not have' };
  else if (!heard || heard === '(silence)') out = { action: 'wait', seconds: 2 };
  else out = { action: 'listen', seconds: 6 };
  return Promise.resolve({ text: JSON.stringify(out) });
}

// The loop, in the same order routes/twilioVoice.js runs it: hear, decide,
// act, hear again.
async function runCall(tree, opts) {
  opts = opts || {};
  var turns = [];
  var budget = opts.maxTurns || 12;
  var heard = tree(null, turns);
  for (var i = 0; i < budget + 2; i++) {
    var act = await brain.decide({
      direction: opts.direction || 'in',
      values: opts.values || VALUES,
      labels: CTX.labels,
      heard: heard,
      turns: turns,
      turnsLeft: budget - turns.length,
      playbook: opts.playbook || null
    }, { callModel: opts.model || cannedModel });

    turns.push({ n: turns.length + 1, heard: heard, action: act.action, digits: act.digits, field: act.field, suffix: act.suffix });

    if (act.action === 'confirm') {
      var live = turns.map(function (t) { return t.heard; }).join(' ');
      var v = brain.verifyQuote(act.quote, live);
      return { outcome: v.ok ? 'confirmed' : 'failed', why: v.ok ? null : v.reason, turns: turns, act: act };
    }
    if (act.action === 'abort') return { outcome: 'failed', why: act.hard_stop || act.reason, turns: turns, act: act };
    if (turns.length >= budget) return { outcome: 'failed', why: 'budget', turns: turns, act: act };

    heard = tree(act, turns);
  }
  return { outcome: 'failed', why: 'ran off the end', turns: turns };
}

// -- the trees --------------------------------------------------------------

// ServiceChannel, as Academy prints it.
function academyTree(act) {
  if (!act) return 'Thank you for calling the vendor check in line. For English, press 1.';
  if (act.action === 'press' && act.digits === '1') return 'Please enter your unique PIN number, followed by the pound key.';
  if (act.action === 'send' && act.field === 'checkin_reference') return 'Thank you. Now enter your work order or tracking number, followed by the pound key.';
  if (act.action === 'send' && act.field === 'checkin_tracking') return 'You entered 3 6 0 4 9 3 4 8 1. Press pound to confirm your arrival.';
  if (act.action === 'press' && act.digits === '#') return 'You are checked in at this time. Your authorization number is SC 77 4419 0093. Thank you.';
  return 'We did not get that.';
}

// The same tree, but it re-prompts the PIN once. This is the case the scripted
// path cannot survive: every tone after the re-prompt lands one prompt late.
function rePromptTree(act, turns) {
  if (!act) return 'Thank you for calling the vendor check in line. For English, press 1.';
  if (act.action === 'press' && act.digits === '1') return 'Please enter your unique PIN number, followed by the pound key.';
  if (act.action === 'send' && act.field === 'checkin_reference') {
    var already = turns.filter(function (t) { return t.field === 'checkin_reference'; }).length;
    if (already < 2) return 'We did not get all of that. Please enter your unique PIN number again, followed by the pound key.';
    return 'Thank you. Now enter your work order or tracking number, followed by the pound key.';
  }
  if (act.action === 'send' && act.field === 'checkin_tracking') return 'You entered 3 6 0 4 9 3 4 8 1. Press pound to confirm your arrival.';
  if (act.action === 'press' && act.digits === '#') return 'You are checked in at this time. Thank you.';
  return 'We did not get that.';
}

// The two entries in the other order. A script would send the PIN into the
// tracking prompt and never recover.
function reorderedTree(act) {
  if (!act) return 'Vendor check in. For English, press 1.';
  if (act.action === 'press' && act.digits === '1') return 'Please enter your tracking number, followed by the pound key.';
  if (act.action === 'send' && act.field === 'checkin_tracking') return 'Now enter your PIN number, followed by the pound key.';
  if (act.action === 'send' && act.field === 'checkin_reference') return 'You are checked in at this time. Thank you.';
  return 'We did not get that.';
}

function rejectTree(act) {
  if (!act) return 'Vendor check in. For English, press 1.';
  if (act.action === 'press' && act.digits === '1') return 'Please enter your unique PIN number, followed by the pound key.';
  return 'That PIN number was not recognized. Please check your work order and try again. Goodbye.';
}

function unknownValueTree(act) {
  if (!act) return 'Vendor check in. For English, press 1.';
  if (act.action === 'press' && act.digits === '1') return 'Please enter your four digit region code, followed by the pound key.';
  return 'We did not get that.';
}

function transferTree(act) {
  if (!act) return 'Vendor check in. For English, press 1.';
  return 'One moment please, a representative will be with you shortly.';
}

function chattyTree() { return 'Your call is important to us. Please continue to hold.'; }

// A model that fabricates a confirmation. The whole point of the quote rule.
function lyingModel(prompt) {
  var heard = heardFromPrompt(prompt).toLowerCase();
  if (/press 1|for english/.test(heard)) return Promise.resolve({ text: JSON.stringify({ action: 'press', digits: '1' }) });
  return Promise.resolve({ text: JSON.stringify({ action: 'confirm', quote: 'your check in has been recorded successfully' }) });
}

async function offlineCalls() {
  section('whole calls, offline');

  var a = await runCall(academyTree);
  eq('academy tree confirms', a.outcome, 'confirmed');
  eq('academy took five turns', a.turns.length, 5);
  eq('academy signature', brain.actionSignature(a.turns), 'p1|scheckin_reference#|scheckin_tracking#|p#');

  var r = await runCall(rePromptTree);
  eq('a re-prompt still confirms', r.outcome, 'confirmed');
  ok('and it sent the PIN twice', r.turns.filter(function (t) { return t.field === 'checkin_reference'; }).length === 2);

  var o = await runCall(reorderedTree);
  eq('a re-ordered tree still confirms', o.outcome, 'confirmed');
  eq('and in the order the tree asked', brain.actionSignature(o.turns), 'p1|scheckin_tracking#|scheckin_reference#');

  var j = await runCall(rejectTree);
  eq('a rejected entry fails', j.outcome, 'failed');
  ok('and says the tree rejected it', /rejected/.test(j.why || ''));

  var u = await runCall(unknownValueTree);
  eq('a value we do not have fails', u.outcome, 'failed');

  var t = await runCall(transferTree);
  eq('a transfer fails', t.outcome, 'failed');
  eq('by the interlock, not the model', t.why, 'human_on_the_line');
  eq('and it hung up on turn two', t.turns.length, 2);

  var c = await runCall(chattyTree, { maxTurns: 4 });
  eq('a tree that never confirms runs out', c.outcome, 'failed');
  eq('at the budget', c.why, 'budget');
  eq('having used exactly the budget', c.turns.length, 4);

  var l = await runCall(academyTree, { model: lyingModel });
  eq('an invented confirmation is NOT a check-in', l.outcome, 'failed');
  eq('and is named as such', l.why, 'quote_not_in_transcript');
}

// ---------------------------------------------------------------------------
// 5. The TwiML each turn produces.
// ---------------------------------------------------------------------------
function twimlChecks() {
  section('the TwiML');
  var send = brain.turnTwiml({ action: 'send', digits: '62163', suffix: '#' }, { actionUrl: 'https://x/api/twilio/voice/ai/7/turn' });
  ok('digits are played outside the gather', /<Play digits="wwww62163#"\/>[\s\S]*<Gather/.test(send));
  ok('the gather listens for speech', /input="speech"/.test(send));
  ok('silence still calls back', /actionOnEmptyResult="true"/.test(send));
  ok('no digits inside the gather', !/<Gather[^>]*>[\s\S]*<Play/.test(send));
  var press = brain.turnTwiml({ action: 'press', digits: '1' }, { actionUrl: 'https://x/t' });
  ok('a press plays the bare key', /<Play digits="1"\/>/.test(press));
  var wait = brain.turnTwiml({ action: 'wait', seconds: 3 }, { actionUrl: 'https://x/t' });
  ok('a wait pauses', /<Pause length="3"\/>/.test(wait));
  ok('the url is escaped', /action="https:\/\/x\/t"/.test(wait));
  ok('hangup is a hangup', /<Hangup\/>/.test(brain.hangupTwiml()));
}

// ---------------------------------------------------------------------------
// 6. Optional: the real model, same trees.
// ---------------------------------------------------------------------------
async function liveCalls() {
  section('whole calls, LIVE model');
  if (!process.env.ANTHROPIC_API_KEY) { console.log('  skipped: ANTHROPIC_API_KEY is not set'); return; }
  var model = function (prompt, opts) { return brain.callClaude(prompt, opts); };
  var cases = [
    ['academy', academyTree, 'confirmed'],
    ['re-prompt', rePromptTree, 'confirmed'],
    ['re-ordered', reorderedTree, 'confirmed'],
    ['rejected entry', rejectTree, 'failed'],
    ['transfer', transferTree, 'failed']
  ];
  for (var i = 0; i < cases.length; i++) {
    var name = cases[i][0];
    var res = await runCall(cases[i][1], { model: model });
    eq('live: ' + name, res.outcome, cases[i][2]);
    console.log('       ' + brain.actionSignature(res.turns) + (res.why ? '   (' + res.why + ')' : ''));
  }
}

(async function () {
  await offlineCalls();
  twimlChecks();
  if (process.argv.indexOf('--live') !== -1) await liveCalls();
  console.log('\n' + pass + '/' + (pass + fail) + ' assertions pass' + (fail ? '  -- ' + fail + ' FAILED' : ''));
  process.exit(fail ? 1 : 0);
})();
