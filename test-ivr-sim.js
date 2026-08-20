// test-ivr-sim.js
//
// A phone call, without the phone.
//
// The first live test failed and the transcript did not say why in so many
// words. It said this:
//
//   "...For English, press one. Para Espan- Please enter your unique PIN number
//    followed by the pound key. Thank you. Now enter your work- Nothing was
//    entered. Good-"
//
// Reading that back against the clock is what found the bug, and reading a
// transcript against a clock is exactly the kind of thing that should not be
// done by hand twice. So this harness does it: it renders the real outbound
// TwiML from a real profile, turns it into a stream of tones with timestamps,
// and feeds those tones to the real fake-ivr router through a real HTTP socket,
// with a <Gather> state machine in between that honours numDigits, finishOnKey,
// barge-in and timeout the way Twilio does.
//
// It then sweeps the two constants nobody controls - how fast Twilio plays a
// tone, and how fast <Say> reads a sentence - across the range they plausibly
// take. A script that only lands when a sentence reads at exactly 2.8 words a
// second is not a working script, it is a coincidence.

var express = require('express');
var http = require('http');
var assert = require('assert');
var ivr = require('./utils/ivrScript');

var voice = require('./utils/twilioVoice');
voice.webhookBase = function () { return ''; };

var failures = 0;
var checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL  ' + msg); }
}
function eqish(msg, got, want) { ok(got === want, msg + ' (got ' + JSON.stringify(got) + ')'); }

// --- The script Tony actually ran, and the job it ran against ---------------
var STEPS = [
  { type: 'wait', seconds: 6 },
  { type: 'press', digits: '1', label: 'English' },
  { type: 'wait', seconds: 3 },
  { type: 'send', field: 'checkin_reference', suffix: '#' },
  { type: 'wait', seconds: 3 },
  { type: 'send', field: 'checkin_tracking', suffix: '#' },
  { type: 'wait', seconds: 2 },
  { type: 'press', digits: '#', label: 'confirm' },
  { type: 'listen', seconds: 25 }
];
var VALUES = { checkin_reference: '62163', checkin_tracking: '360493481' };

// The check-out script. Identical up to the read-back, then 2 instead of pound,
// which is the branch that reads an authorization number back.
var STEPS_OUT = STEPS.map(function (s) {
  return (s.type === 'press' && s.digits === '#') ? { type: 'press', digits: '2', label: 'completing' } : s;
});

// --- Turning TwiML into a stream of tones ----------------------------------
// <Pause length="n"/> is n seconds. <Play digits="..."/> plays each tone for
// TONE seconds; w is half a second of silence, W is a whole one.
function toneStream(xml, TONE) {
  var events = [];
  var t = 0;
  var re = /<(Pause|Play|Hangup)([^>]*)\/>/g;
  var m;
  while ((m = re.exec(xml))) {
    if (m[1] === 'Pause') {
      t += parseFloat(/length="(\d+)"/.exec(m[2])[1]);
    } else if (m[1] === 'Play') {
      var d = /digits="([^"]*)"/.exec(m[2])[1];
      for (var i = 0; i < d.length; i++) {
        var c = d[i];
        if (c === 'w') t += 0.5;
        else if (c === 'W') t += 1;
        else { events.push({ at: t, key: c }); t += TONE; }
      }
    } else {
      events.push({ at: t, key: null, hangup: true });
    }
  }
  return events;
}

// --- The far end -----------------------------------------------------------
function parseGather(xml) {
  var g = /<Gather([^>]*)>([\s\S]*?)<\/Gather>/.exec(xml);
  function attr(src, n) { var r = new RegExp(n + '="([^"]*)"').exec(src); return r ? r[1] : null; }
  function says(src) {
    var out = [], s = /<Say>([\s\S]*?)<\/Say>/g, r;
    while ((r = s.exec(src))) out.push(r[1]);
    return out;
  }
  if (!g) return { gather: null, said: says(xml), hangup: /<Hangup\/>/.test(xml) };
  return {
    gather: {
      action: attr(g[1], 'action'),
      timeout: parseFloat(attr(g[1], 'timeout') || '5'),
      numDigits: attr(g[1], 'numDigits') ? parseInt(attr(g[1], 'numDigits'), 10) : null,
      finishOnKey: attr(g[1], 'finishOnKey') === null ? '#' : attr(g[1], 'finishOnKey'),
      prompt: says(g[2])[0] || ''
    },
    after: says(xml.slice(xml.indexOf('</Gather>'))),
    hangup: /<Hangup\/>/.test(xml)
  };
}

// Twilio's default voice reads at roughly WPS words a second. Close enough that
// a script with any margin at all survives being wrong about it, which is the
// property this harness is here to check.
function saySeconds(text, WPS) { return text.trim().split(/\s+/).length / WPS; }

function post(port, path, digits) {
  return new Promise(function (resolve, reject) {
    var body = 'CallSid=CAsim&Digits=' + encodeURIComponent(digits == null ? '' : digits);
    var req = http.request({
      port: port, path: path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, function (res) {
      var b = '';
      res.on('data', function (c) { b += c; });
      res.on('end', function () { resolve(b); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Walk the clock. Returns everything the far end SPOKE, in order, which is the
// closest thing this harness has to a recording.
async function runCall(port, mode, TONE, WPS, steps) {
  var xml = ivr.renderTwiml(steps || STEPS, VALUES, {});
  var tones = toneStream(xml, TONE);
  var idx = 0;
  var t = 0;
  var heard = [];
  var page = await post(port, '/api/twilio/voice/fake-ivr?mode=' + mode, '');

  for (var guard = 0; guard < 40; guard++) {
    var p = parseGather(page);
    if (!p.gather) { p.said.forEach(function (s) { heard.push(s); }); break; }

    var promptEnds = t + saySeconds(p.gather.prompt, WPS);
    var buf = '';
    var finished = null;      // 'finishkey' | 'numdigits' | 'timeout'
    var spoke = false;

    while (true) {
      var next = tones[idx];
      // The gather gives up TIMEOUT seconds after the prompt ends, or after the
      // last tone, whichever is later.
      var deadline = Math.max(promptEnds, t) + p.gather.timeout;
      if (!next || next.hangup || next.at > deadline) { finished = 'timeout'; t = deadline; break; }

      t = next.at;
      idx++;
      if (!spoke) { spoke = true; heard.push(p.gather.prompt); }   // barge-in, or it finished on its own

      if (p.gather.finishOnKey && next.key === p.gather.finishOnKey) { finished = 'finishkey'; break; }
      buf += next.key;
      if (p.gather.numDigits && buf.length >= p.gather.numDigits) { finished = 'numdigits'; break; }
    }
    if (!spoke) heard.push(p.gather.prompt);

    if (finished === 'timeout' && !buf) { p.after.forEach(function (s) { heard.push(s); }); break; }
    page = await post(port, p.gather.action.replace(/&amp;/g, '&'), buf);
  }
  return heard.join(' ');
}

// --- Go --------------------------------------------------------------------
(async function () {
  var app = express();
  app.use('/api/twilio/voice', require('./routes/twilioVoice'));
  var server = app.listen(0);
  await new Promise(function (r) { server.on('listening', r); });
  var port = server.address().port;

  console.log('\nThe exact script from the failed call, swept across timings');
  console.log('  tone/s  words/s  outcome');
  var everyOk = true;
  for (var TONE = 0.3; TONE <= 0.81; TONE += 0.1) {
    for (var WPS = 2.2; WPS <= 3.61; WPS += 0.35) {
      var said = await runCall(port, 'ok', TONE, WPS);
      var good = said.indexOf('You are checked in') !== -1;
      var reads = said.indexOf('P I N 6 2 1 6 3, work order 3 6 0 4 9 3 4 8 1') !== -1;
      if (!good || !reads) {
        everyOk = false;
        console.log('  ' + TONE.toFixed(1) + '     ' + WPS.toFixed(2) + '     FAILED: ' + said.slice(-90));
      }
      ok(good, 'confirms at tone=' + TONE.toFixed(1) + ' wps=' + WPS.toFixed(2));
      ok(reads, 'reads back both entries at tone=' + TONE.toFixed(1) + ' wps=' + WPS.toFixed(2));
    }
  }
  if (everyOk) console.log('  every combination reached "You are checked in" with both numbers read back');

  console.log('\nThe phrase Tony configured is the phrase the tree says');
  var transcript = await runCall(port, 'ok', 0.5, 2.8);
  var m = ivr.matchConfirmation(transcript, 'you are checked in; check in successful');
  ok(m.matched, 'matchConfirmation finds it (' + m.reason + ')');
  ok(ivr.captureValue(transcript, 'authorization number is ([A-Z0-9 ]+)') !== null ||
     transcript.indexOf('SC 77 4419 0093') !== -1, 'the authorization number is in the transcript');

  console.log('\nCheck-out reaches its own branch, and the capture pattern finds the number');
  for (var T2 = 0.3; T2 <= 0.81; T2 += 0.1) {
    for (var W2 = 2.2; W2 <= 3.61; W2 += 0.35) {
      var out = await runCall(port, 'ok', T2, W2, STEPS_OUT);
      ok(ivr.matchConfirmation(out, 'check out complete').matched,
         'check-out confirms at tone=' + T2.toFixed(1) + ' wps=' + W2.toFixed(2) + ' :: ' + out.slice(-70));
      ok(!ivr.matchConfirmation(out, 'you are checked in').matched,
         'check-out does NOT say the check-in phrase at tone=' + T2.toFixed(1) + ' wps=' + W2.toFixed(2));
    }
  }
  var outT = await runCall(port, 'ok', 0.5, 2.8, STEPS_OUT);
  eqish('capture pulls the authorization number',
        ivr.captureValue(outT, 'authorization number is ([a-z0-9 -]+)'), 'SC 77 4419 0093');
  console.log('  ' + outT.slice(-80));

  console.log('\nThe check-in script is untouched by the longer confirm prompt');
  var again = await runCall(port, 'ok', 0.5, 2.8);
  ok(again.indexOf('You are checked in') !== -1, 'check-in still confirms');
  ok(!ivr.matchConfirmation(again, 'check out complete').matched, 'check-in does NOT say the check-out phrase');

  console.log('\nThe other modes still behave');
  var wrong = await runCall(port, 'wrong', 0.5, 2.8);
  ok(wrong.indexOf('has been noted') !== -1, 'wrong mode reaches the end but does not confirm');
  ok(!ivr.matchConfirmation(wrong, 'you are checked in').matched, 'wrong mode fails the phrase check');
  var reject = await runCall(port, 'reject', 0.5, 2.8);
  ok(reject.indexOf('was not recognized') !== -1, 'reject mode rejects the PIN it was given');
  ok(reject.indexOf('6 2 1 6 3') !== -1, 'reject mode reads back the PIN it heard, not the language key');

  console.log('\nThe old tree, replayed, still reproduces the failure');
  // Same call, but every prompt built the way it was before: a menu that waits
  // for a pound it is never going to get.
  var realGather = parseGather;
  parseGather = function (xml) {
    var p = realGather(xml);
    if (p.gather) { p.gather.numDigits = 24; p.gather.finishOnKey = '#'; }
    return p;
  };
  var before = await runCall(port, 'ok', 0.5, 2.8);
  parseGather = realGather;
  ok(before.indexOf('Nothing was entered') !== -1, 'reproduces "Nothing was entered"');
  ok(before.indexOf('You are checked in') === -1, 'reproduces the failure to confirm');
  console.log('  ' + before.replace(/\s+/g, ' ').slice(0, 200));

  server.close();
  console.log('\n' + (failures ? failures + ' FAILED of ' : 'all ') + checks + ' assertions');
  process.exit(failures ? 1 : 0);
})();
