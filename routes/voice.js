// routes/voice.js
// Nova Voice - the ears and mouth for Nova AI on the radio. One vendor:
// both proxies use ElevenLabs (no new npm deps; native fetch/FormData/Blob):
//   POST /api/voice/transcribe  audio bytes  -> ElevenLabs Scribe -> { text }
//   POST /api/voice/speak       { text }     -> ElevenLabs TTS   -> audio/mpeg
// The "brain" is unchanged: the client sends the transcript to the existing
// /api/ai/agent endpoint, then sends the reply here to be spoken. No backticks.

var express = require('express');
var { requireAuth } = require('../middleware/auth');

var router = express.Router();

// --- config --------------------------------------------------------------
var ELEVEN_KEY = function () { return process.env.ELEVENLABS_API_KEY; };
// Default voice = ElevenLabs "Rachel" (public preset). Override in Railway.
var VOICE_ID = function () { return String(process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM').trim(); };
var TTS_MODEL = function () { return process.env.ELEVENLABS_MODEL || 'eleven_turbo_v2_5'; };
// Scribe (speech-to-text). scribe_v2 is the current model; scribe_v1 also valid.
var STT_MODEL = function () { return process.env.ELEVENLABS_STT_MODEL || 'scribe_v2'; };

function mimeToExt(mime) {
  if (!mime) return 'webm';
  if (mime.indexOf('webm') !== -1) return 'webm';
  if (mime.indexOf('ogg') !== -1) return 'ogg';
  if (mime.indexOf('mp4') !== -1 || mime.indexOf('m4a') !== -1) return 'mp4';
  if (mime.indexOf('mpeg') !== -1 || mime.indexOf('mp3') !== -1) return 'mp3';
  if (mime.indexOf('wav') !== -1) return 'wav';
  return 'webm';
}

// GET /api/voice/config - lets the client know voice is wired up.
// One vendor now: a single ElevenLabs key powers both STT and TTS.
router.get('/config', requireAuth, function (req, res) {
  res.json({
    stt: !!ELEVEN_KEY(),
    tts: !!ELEVEN_KEY(),
    ready: !!ELEVEN_KEY()
  });
});

// POST /api/voice/transcribe
// Body: raw audio bytes (Content-Type is the recorder mime, e.g. audio/webm).
// Returns: { text }  (via ElevenLabs Scribe)
router.post('/transcribe', requireAuth, express.raw({ type: '*/*', limit: '25mb' }), async function (req, res) {
  if (!ELEVEN_KEY()) {
    return res.status(503).json({ error: 'Speech-to-text is not configured. Add ELEVENLABS_API_KEY in Railway Variables.' });
  }
  var audio = req.body;
  if (!audio || !audio.length) {
    return res.status(400).json({ error: 'No audio received.' });
  }
  try {
    var mime = req.headers['content-type'] || 'audio/webm';
    var ext = mimeToExt(mime);
    var form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), 'command.' + ext);
    form.append('model_id', STT_MODEL());
    form.append('language_code', 'en');       // single-speaker English commands
    form.append('num_speakers', '1');
    form.append('diarize', 'false');
    form.append('tag_audio_events', 'false');  // do not annotate (laughter) etc.

    var r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY() },  // FormData sets its own Content-Type
      body: form
    });
    if (!r.ok) {
      var errTxt = await r.text();
      console.error('Scribe error', r.status, errTxt);
      return res.status(502).json({ error: 'Transcription failed (' + r.status + ').' });
    }
    var data = await r.json();
    res.json({ text: (data && data.text ? String(data.text).trim() : '') });
  } catch (err) {
    console.error('transcribe error', err);
    res.status(500).json({ error: 'Transcription error.' });
  }
});

// POST /api/voice/speak
// Body: { text, voiceId?, broadcast? } -> streams back audio/mpeg (mp3).
router.post('/speak', requireAuth, express.json({ limit: '256kb' }), async function (req, res) {
  if (!ELEVEN_KEY()) {
    return res.status(503).json({ error: 'Text-to-speech is not configured. Add ELEVENLABS_API_KEY in Railway Variables.' });
  }
  var text = req.body && req.body.text;
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'No text to speak.' });
  }
  // Keep replies short enough for radio + cost control.
  text = String(text).trim().slice(0, 900);
  var voiceId = String((req.body && req.body.voiceId) || VOICE_ID()).trim();
  try {
    var payload = JSON.stringify({
      text: text,
      model_id: TTS_MODEL(),
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    });
    var r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?optimize_streaming_latency=2', {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY(),
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: payload
    });
    if (!r.ok) {
      var errTxt2 = await r.text();
      console.error('ElevenLabs TTS error', r.status, 'voiceId=' + voiceId, errTxt2);
      return res.status(502).json({ error: 'Text-to-speech failed (' + r.status + '). Check the ELEVENLABS_VOICE_ID.' });
    }
    var buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (err) {
    console.error('speak error', err);
    res.status(500).json({ error: 'Text-to-speech error.' });
  }
});

module.exports = router;
