// utils/twilioVoice.js
//
// Outbound voice, in the same shape utils/sms.js already uses: native fetch,
// HTTP Basic auth, no npm dependency. Voice is the same Twilio credentials
// against /Calls.json instead of /Messages.json. No backticks.
//
// Deliberately dumb. It places a call, checks a signature, and fetches bytes.
// Every decision about WHAT to dial and whether it worked lives elsewhere
// (utils/ivrScript.js and routes/checkins.js), so this file has nothing in it
// worth arguing about.

var crypto = require('crypto');

var API = 'https://api.twilio.com/2010-04-01/Accounts/';

function sid() { return (process.env.TWILIO_ACCOUNT_SID || '').trim(); }
function token() { return (process.env.TWILIO_AUTH_TOKEN || '').trim(); }

// The voice number is deliberately its own variable. TWILIO_FROM_NUMBER carries
// SMS two-factor; if that number is ever reassigned or flagged, check-in calls
// must not die with it. Falls back to it only so a first deploy is not dead on
// arrival, and status() reports when it is running on the fallback.
function fromNumber() {
  return (process.env.TWILIO_VOICE_FROM_NUMBER || process.env.TWILIO_FROM_NUMBER || '').trim();
}
function usingSmsNumber() {
  return !process.env.TWILIO_VOICE_FROM_NUMBER && !!process.env.TWILIO_FROM_NUMBER;
}

// Media URLs enforce HTTP Basic auth. An API key pair is preferred over the
// account auth token, so a leaked recording credential can be rotated without
// invalidating every other Twilio call Nova makes.
function mediaAuth() {
  var k = (process.env.TWILIO_API_KEY_SID || '').trim();
  var s = (process.env.TWILIO_API_KEY_SECRET || '').trim();
  if (k && s) return 'Basic ' + Buffer.from(k + ':' + s).toString('base64');
  return 'Basic ' + Buffer.from(sid() + ':' + token()).toString('base64');
}

function configured() { return !!(sid() && token() && fromNumber()); }

function status() {
  return {
    configured: configured(),
    account: !!sid(),
    auth: !!token(),
    from: fromNumber() || null,
    using_sms_number: usingSmsNumber(),
    webhook_base: webhookBase() || null
  };
}

// The base Twilio will call back on. An explicit variable rather than req,
// because the signature below is checked against the EXACT url and a proxy
// rewriting the scheme is a silent 401 on every callback. Same reasoning as
// SQUARE_WEBHOOK_URL in routes/square.js.
function webhookBase() {
  var b = (process.env.TWILIO_WEBHOOK_BASE || process.env.APP_URL || '').trim();
  return b.replace(/\/+$/, '');
}

function authHeader() {
  return 'Basic ' + Buffer.from(sid() + ':' + token()).toString('base64');
}

// POST /Calls.json
//
// No MachineDetection. Nova only ever dials a predetermined phone tree that has
// already been recorded and scripted, so there is no human to detect. What keeps
// that true is the allow-list in routes/checkins.js, not a detector.
async function placeCall(opts) {
  if (!configured()) throw new Error('Twilio voice is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VOICE_FROM_NUMBER).');
  if (!opts || !opts.to) throw new Error('No number to call.');
  if (!opts.url) throw new Error('No TwiML url.');

  var form = {
    To: String(opts.to),
    From: opts.from || fromNumber(),
    Url: opts.url,
    Method: 'POST',
    Timeout: String(opts.ringTimeout || 30),
    TimeLimit: String(opts.timeLimit || parseInt(process.env.CHECKIN_MAX_CALL_SECONDS, 10) || 180)
  };
  if (opts.statusCallback) {
    form.StatusCallback = opts.statusCallback;
    form.StatusCallbackMethod = 'POST';
    // Repeated keys, which URLSearchParams handles by appending.
    form.__statusEvents = ['initiated', 'ringing', 'answered', 'completed'];
  }
  if (opts.record) {
    form.Record = 'true';
    form.RecordingChannels = opts.recordingChannels || 'dual';
    if (opts.recordingCallback) {
      form.RecordingStatusCallback = opts.recordingCallback;
      form.RecordingStatusCallbackMethod = 'POST';
      form.RecordingStatusCallbackEvent = 'completed';
    }
  }

  var body = new URLSearchParams();
  Object.keys(form).forEach(function (k) {
    if (k === '__statusEvents') return;
    body.append(k, form[k]);
  });
  if (form.__statusEvents) {
    form.__statusEvents.forEach(function (e) { body.append('StatusCallbackEvent', e); });
  }

  var r = await fetch(API + sid() + '/Calls.json', {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  var text = await r.text();
  if (!r.ok) {
    var msg = text;
    try { var j = JSON.parse(text); if (j && j.message) msg = j.message + (j.code ? ' (Twilio ' + j.code + ')' : ''); } catch (e) { /* keep raw */ }
    throw new Error('Twilio refused the call: ' + String(msg).slice(0, 400));
  }
  var data = {};
  try { data = JSON.parse(text); } catch (e) { /* Twilio always returns JSON here */ }
  return { sid: data.sid || null, status: data.status || null, raw: data };
}

async function getCall(callSid) {
  if (!configured() || !callSid) return null;
  var r = await fetch(API + sid() + '/Calls/' + encodeURIComponent(callSid) + '.json', {
    headers: { Authorization: authHeader() }
  });
  if (!r.ok) return null;
  return r.json();
}

// ---- Webhook signatures ---------------------------------------------------
//
// base64(HMAC-SHA1(authToken, fullUrl + each POST param name and value, sorted
// by name, concatenated with no delimiter)).
//
// Note this is over the PARSED form parameters, not the raw body, so unlike the
// Resend and Square webhooks this router does not need express.raw.
function expectedSignature(url, params) {
  var data = String(url);
  Object.keys(params || {}).sort().forEach(function (k) {
    data += k + (params[k] == null ? '' : String(params[k]));
  });
  return crypto.createHmac('sha1', token()).update(Buffer.from(data, 'utf8')).digest('base64');
}

function validateSignature(url, params, signature) {
  if (!token()) return process.env.NODE_ENV !== 'production'; // fail CLOSED in production
  if (!signature) return false;
  try {
    var a = Buffer.from(String(signature));
    var b = Buffer.from(expectedSignature(url, params));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

// ---- Recordings -----------------------------------------------------------

async function fetchRecording(recordingUrl, format) {
  if (!recordingUrl) throw new Error('No recording url.');
  var ext = (format === 'wav' ? '.wav' : '.mp3');
  var url = String(recordingUrl).replace(/\.(mp3|wav)$/i, '') + ext;
  var r = await fetch(url, { headers: { Authorization: mediaAuth() } });
  if (!r.ok) throw new Error('Could not download the recording (' + r.status + ').');
  var buf = Buffer.from(await r.arrayBuffer());
  return { buffer: buf, mime: ext === '.wav' ? 'audio/wav' : 'audio/mpeg', ext: ext.slice(1) };
}

// Once the audio is safely in R2 there is no reason to leave a second copy at
// Twilio. Best effort: a failed delete must never fail a check-in.
async function deleteRecording(recordingSid) {
  if (!configured() || !recordingSid) return false;
  try {
    var r = await fetch(API + sid() + '/Recordings/' + encodeURIComponent(recordingSid) + '.json', {
      method: 'DELETE', headers: { Authorization: authHeader() }
    });
    return r.ok || r.status === 404;
  } catch (e) { return false; }
}

module.exports = {
  configured: configured,
  status: status,
  fromNumber: fromNumber,
  webhookBase: webhookBase,
  placeCall: placeCall,
  getCall: getCall,
  expectedSignature: expectedSignature,
  validateSignature: validateSignature,
  fetchRecording: fetchRecording,
  deleteRecording: deleteRecording
};
