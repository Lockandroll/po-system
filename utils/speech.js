// utils/speech.js
//
// ElevenLabs Scribe, lifted out of routes/voice.js so a background job can use
// it. The transcribe endpoint there sits behind requireAuth, and the check-in
// recording pipeline has no request to authenticate - faking one to reach a
// helper is the kind of thing that looks fine until it does not. No backticks.
//
// Twilio's own transcription is $0.05/min and would be the single most expensive
// line item in the check-in project. Nova already pays for this key.

var ELEVEN_URL = 'https://api.elevenlabs.io/v1/speech-to-text';

function key() { return process.env.ELEVENLABS_API_KEY; }
function sttModel() { return process.env.ELEVENLABS_STT_MODEL || 'scribe_v2'; }
function configured() { return !!key(); }

function mimeToExt(mime) {
  if (!mime) return 'webm';
  if (mime.indexOf('webm') !== -1) return 'webm';
  if (mime.indexOf('ogg') !== -1) return 'ogg';
  if (mime.indexOf('mp4') !== -1 || mime.indexOf('m4a') !== -1) return 'mp4';
  if (mime.indexOf('mpeg') !== -1 || mime.indexOf('mp3') !== -1) return 'mp3';
  if (mime.indexOf('wav') !== -1) return 'wav';
  return 'webm';
}

// Returns the transcript text. Throws with a readable message on failure, so the
// caller can put it straight on a checkin_events row.
//
// opts.diarize defaults false. A phone tree is one speaker and our own leg emits
// nothing but DTMF tones, so speaker separation buys nothing and costs latency.
async function transcribe(audio, mime, opts) {
  opts = opts || {};
  if (!configured()) throw new Error('Speech-to-text is not configured (ELEVENLABS_API_KEY).');
  if (!audio || !audio.length) throw new Error('No audio to transcribe.');
  var type = mime || 'audio/mpeg';
  var form = new FormData();
  form.append('file', new Blob([audio], { type: type }), (opts.filename || 'audio') + '.' + mimeToExt(type));
  form.append('model_id', opts.model || sttModel());
  form.append('language_code', opts.language || 'en');
  form.append('num_speakers', String(opts.numSpeakers || 1));
  form.append('diarize', opts.diarize ? 'true' : 'false');
  form.append('tag_audio_events', 'false');

  var r = await fetch(ELEVEN_URL, {
    method: 'POST',
    headers: { 'xi-api-key': key() },   // FormData sets its own Content-Type
    body: form
  });
  if (!r.ok) {
    var errTxt = '';
    try { errTxt = await r.text(); } catch (e) { /* body already consumed or empty */ }
    throw new Error('Transcription failed (' + r.status + ') ' + String(errTxt).slice(0, 300));
  }
  var data = await r.json();
  return (data && data.text ? String(data.text).trim() : '');
}

module.exports = { configured: configured, transcribe: transcribe, mimeToExt: mimeToExt };
