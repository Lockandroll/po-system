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
// Point a test profile at a second Twilio number wired to this endpoint and the
// entire loop runs end to end for about three cents, without ever appearing in a
// real client's call log. It can be made to fail on purpose, which matters more
// than the happy path: rejecting the id, going silent, and reading back a
// confirmation that does not match are all code paths that otherwise ship
// untested.
//
// Deliberately NOT signature-verified: it is an inbound call handler, and the
// number that reaches it is one we own and configure.
//
//   ?mode=ok       normal, confirms and reads back an authorization number
//   ?mode=reject   rejects whatever id is entered
//   ?mode=silent   says nothing at all
//   ?mode=wrong    confirms with wording that will not match a phrase
// ---------------------------------------------------------------------------
var FAKE_AUTH = 'SC 77 4419 0093';

router.post('/fake-ivr', function (req, res) {
  var mode = String(req.query.mode || 'ok').toLowerCase();
  var digits = String(req.body.Digits || '');

  if (mode === 'silent') {
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
      '<Pause length="12"/><Hangup/></Response>');
  }

  // First leg: greet and collect. Any DTMF at all satisfies the Gather; the
  // script under test is what decides which keys get sent.
  if (!req.query.step) {
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
      '<Gather input="dtmf" timeout="8" numDigits="20" finishOnKey="#" ' +
      'action="/api/twilio/voice/fake-ivr?step=2&amp;mode=' + encodeURIComponent(mode) + '" method="POST">' +
      '<Say>Thank you for calling the vendor check in line. For English, press one. ' +
      'Please enter your identification number followed by the pound key.</Say>' +
      '</Gather>' +
      '<Say>We did not receive any input. Goodbye.</Say><Hangup/></Response>');
  }

  if (req.query.step === '2') {
    if (mode === 'reject') {
      return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
        '<Say>That identification number was not recognized. Please re-enter your number, ' +
        'followed by the pound key.</Say><Pause length="6"/><Hangup/></Response>');
    }
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
      '<Gather input="dtmf" timeout="8" numDigits="20" finishOnKey="#" ' +
      'action="/api/twilio/voice/fake-ivr?step=3&amp;mode=' + encodeURIComponent(mode) + '" method="POST">' +
      '<Say>Thank you. Now enter your work order number, followed by the pound key.</Say>' +
      '</Gather>' +
      '<Say>We did not receive a work order number. Goodbye.</Say><Hangup/></Response>');
  }

  if (mode === 'wrong') {
    return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
      '<Say>Your request has been noted. Goodbye.</Say><Hangup/></Response>');
  }

  return twiml(res, '<?xml version="1.0" encoding="UTF-8"?>\n<Response>' +
    '<Say>Work order ' + digits.split('').join(' ') + ' received. You are checked in at this time. ' +
    'Your authorization number is ' + FAKE_AUTH + '. Thank you.</Say>' +
    '<Pause length="1"/><Hangup/></Response>');
});

// A GET on the fake IVR so a human can eyeball it in a browser without dialling.
router.get('/fake-ivr', function (req, res) {
  res.type('text/plain').send(
    'Nova test phone tree.\n\n' +
    'Point a Twilio number at POST ' + (twilio.webhookBase() || '') + '/api/twilio/voice/fake-ivr\n' +
    'Modes: ?mode=ok (default), ?mode=reject, ?mode=silent, ?mode=wrong\n'
  );
});

module.exports = router;
