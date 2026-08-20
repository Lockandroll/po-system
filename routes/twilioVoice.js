// routes/twilioVoice.js
//
// Everything Twilio talks to. Mounted EARLY in server.js, beside /api/inbound
// and /api/square, with its own rate limiter: one call fires three callbacks and
// a burst of them should not be competing with the app for generalLimiter's
// budget. No backticks.
//
//   POST /api/twilio/voice/script/:id      -> the TwiML for a call in flight
//   POST /api/twilio/voice/status/:id      -> call lifecycle
//   POST /api/twilio/voice/recording/:id   -> the recording is ready
//   POST /api/twilio/voice/fake-ivr        -> a phone tree of our own, for testing
//
// Every one of the first three verifies X-Twilio-Signature and fails CLOSED in
// production. The signature is computed over the PARSED form parameters, not the
// raw body, which is why this router can use express.urlencoded where the Resend
// and Square webhooks need express.raw.

var express = require('express');
var { pool } = require('../db');
var twilio = require('../utils/twilioVoice');
var ivr = require('../utils/ivrScript');
var checkins = require('../utils/checkinEngine');

var router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '256kb' }));

function twiml(res, xml) {
  res.set('Content-Type', 'text/xml; charset=utf-8');
  res.send(xml);
}

function hangup(res, say) {
  twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
    (say ? '<Say>' + say + '</Say>' : '') + '<Hangup/></Response>');
}

// The url Twilio signed. Built from configuration rather than from req, because
// the signature is checked byte for byte and a proxy rewriting the scheme is a
// silent 401 on every callback. Same reasoning as SQUARE_WEBHOOK_URL.
function signedUrl(req) {
  var base = twilio.webhookBase();
  if (base) return base + req.originalUrl;
  return req.protocol + '://' + req.get('host') + req.originalUrl;
}

function verify(req, res, next) {
  var sig = req.get('X-Twilio-Signature');
  if (twilio.validateSignature(signedUrl(req), req.body || {}, sig)) return next();
  console.warn('[twilio-voice] bad signature on ' + req.originalUrl);
  return res.status(403).type('text/plain').send('bad signature');
}

// ---------------------------------------------------------------------------
// The script. Twilio fetches this when the call connects.
//
// Rendered per call from the stored profile rather than sent inline with the
// call, so changing an account's tree is a database edit and not a deploy.
// ---------------------------------------------------------------------------
router.post('/script/:id', verify, async function (req, res) {
  try {
    var ev = await checkins.loadEvent(req.params.id);
    if (!ev) return hangup(res);
    await checkins.markDialing(ev.id, req.body.CallSid || null);
    var xml = await checkins.renderScript(ev);
    return twiml(res, xml);
  } catch (err) {
    console.error('[twilio-voice] script:', err.message);
    return hangup(res);
  }
});

// ---------------------------------------------------------------------------
// Call lifecycle. Nothing here decides whether a check-in worked - that happens
// on the recording callback, from the transcript. A completed call is only ever
// evidence that the phone hung up.
// ---------------------------------------------------------------------------
router.post('/status/:id', verify, async function (req, res) {
  res.type('text/plain').send('ok');
  try {
    await checkins.onCallStatus(req.params.id, {
      call_sid: req.body.CallSid || null,
      call_status: req.body.CallStatus || null,
      duration: req.body.CallDuration ? parseInt(req.body.CallDuration, 10) : null
    });
  } catch (err) { console.error('[twilio-voice] status:', err.message); }
});

// ---------------------------------------------------------------------------
// The recording is ready. This is where the verdict is reached: pull the audio,
// store it, transcribe it, and look for the phrase the tree is supposed to say.
// Answered asynchronously so Twilio is never left waiting on ElevenLabs.
// ---------------------------------------------------------------------------
router.post('/recording/:id', verify, async function (req, res) {
  res.type('text/plain').send('ok');
  try {
    await checkins.onRecording(req.params.id, {
      recording_sid: req.body.RecordingSid || null,
      recording_url: req.body.RecordingUrl || null,
      duration: req.body.RecordingDuration ? parseInt(req.body.RecordingDuration, 10) : null
    });
  } catch (err) { console.error('[twilio-voice] recording:', err.message); }
});

// ---------------------------------------------------------------------------
// A phone tree of our own.
//
// Point a spare Twilio number at this endpoint and the whole loop runs end to
// end for about three cents, without ever appearing in a client's call log. That
// last part matters more than the money: dialling a real check-in line to test a
// script files a real check-in against a real job.
//
// The shape deliberately mirrors the ServiceChannel tree, which is the one Nova
// meets first: language, then PIN, then job number, then a confirm keypress. A
// test tree shaped differently from the real one proves very little.
//
// It ECHOES BACK the digits it received. If a wait is too short and only half a
// PIN arrives, that shows up in the transcript as the wrong number rather than
// as a mystery failure.
//
// Deliberately NOT signature-verified: it is an inbound call handler on a number
// we own and configure.
//
//   ?mode=ok       normal. Confirms and reads back an authorization number.
//   ?mode=reject   rejects the PIN, the way a real tree does with a bad one.
//   ?mode=silent   answers and says nothing at all.
//   ?mode=wrong    confirms, but with wording that will not match a phrase.
// ---------------------------------------------------------------------------
var FAKE_AUTH = 'SC 77 4419 0093';

function fakeDigits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, '').slice(0, 24); }
function spell(v) { return String(v || '').split('').join(' '); }

function fakeGather(res, step, mode, say, carry) {
  var q = '?step=' + step + '&amp;mode=' + encodeURIComponent(mode);
  Object.keys(carry || {}).forEach(function (k) { q += '&amp;' + k + '=' + encodeURIComponent(carry[k]); });
  twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
    '<Gather input="dtmf" timeout="10" numDigits="24" finishOnKey="#" ' +
    'action="/api/twilio/voice/fake-ivr' + q + '" method="POST">' +
    '<Say>' + say + '</Say>' +
    '</Gather>' +
    '<Say>Nothing was entered. Goodbye.</Say><Hangup/></Response>');
}

router.post('/fake-ivr', function (req, res) {
  var mode = String(req.query.mode || 'ok').toLowerCase();
  var step = String(req.query.step || 'start');
  var digits = fakeDigits(req.body.Digits);

  if (mode === 'silent') {
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response><Pause length="15"/><Hangup/></Response>');
  }

  if (step === 'start') {
    return fakeGather(res, 'pin', mode,
      'Thank you for calling the vendor check in line. For English, press 1. Para espanol, oprima 2.', {});
  }

  if (step === 'pin') {
    return fakeGather(res, 'job', mode,
      'Please enter your unique PIN number, followed by the pound key.', {});
  }

  if (step === 'job') {
    if (mode === 'reject') {
      return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
        '<Say>The PIN number ' + spell(digits) + ' was not recognized. ' +
        'Please check your work order and try again. Goodbye.</Say>' +
        '<Pause length="2"/><Hangup/></Response>');
    }
    return fakeGather(res, 'confirm', mode,
      'Thank you. Now enter your work order or tracking number, followed by the pound key.', { pin: digits });
  }

  if (step === 'confirm') {
    return fakeGather(res, 'done', mode,
      'You entered ' + spell(digits) + '. Press pound to confirm, or zero to re-enter.',
      { pin: fakeDigits(req.query.pin), job: digits });
  }

  // step === 'done'
  var pin = fakeDigits(req.query.pin);
  var job = fakeDigits(req.query.job);
  var heard = 'P I N ' + spell(pin) + ', work order ' + spell(job) + '. ';

  if (mode === 'wrong') {
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
      '<Say>' + heard + 'Your request has been noted. Goodbye.</Say><Hangup/></Response>');
  }

  return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
    '<Say>' + heard + 'You are checked in at this time. ' +
    'Your authorization number is ' + FAKE_AUTH + '. Thank you.</Say>' +
    '<Pause length="1"/><Hangup/></Response>');
});

// A GET so a human can eyeball it in a browser without dialling.
router.get('/fake-ivr', function (req, res) {
  res.type('text/plain').send(
    'Nova test phone tree.\n\n' +
    'Point a spare Twilio number at POST ' + (twilio.webhookBase() || '') + '/api/twilio/voice/fake-ivr\n\n' +
    'It asks, in this order:\n' +
    '  1. language        press 1\n' +
    '  2. unique PIN      digits then #\n' +
    '  3. work order      digits then #\n' +
    '  4. confirm         #\n' +
    'then reads back everything it heard, so a half-received PIN shows up in the\n' +
    'transcript instead of failing as a mystery.\n\n' +
    'Modes: ?mode=ok (default), ?mode=reject, ?mode=silent, ?mode=wrong\n'
  );
});

module.exports = router;
