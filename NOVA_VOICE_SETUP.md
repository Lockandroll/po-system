# Nova Voice - "Hey Nova" Setup Guide

Hands-free voice for Nova AI, living inside the Radio (Zello) app. Say **"Hey Nova"**,
speak a command, and Nova either jumps you to a screen or answers out loud on the channel -
using the exact same brain (and tools) as Nova AI in the app.

**Pipeline:** wake word (browser) -> record -> **OpenAI Whisper** (STT) -> navigate *or* **Nova AI agent** -> **ElevenLabs** (TTS) -> played locally + broadcast to your live channel.

---

## What was built (already in the repo)

| File | Change |
|---|---|
| `routes/voice.js` | **NEW** - `POST /api/voice/transcribe` (Whisper) + `POST /api/voice/speak` (ElevenLabs). No new npm deps. |
| `public/js/nova-voice.js` | **NEW** - wake-word listener, command capture, nav parser, agent call, broadcast playback, floating mic button. |
| `public/js/ptt.js` | **EDITED** - added `window.NovaRadio` bridge so voice can broadcast on the live channel. (Backup: `ptt.js.bak-novavoice`.) |
| `.env.example` | **EDITED** - documents the new keys. |
| `server.js` | **EDITED** - registered `app.use('/api/voice', require('./routes/voice'));`. |
| `public/index.html` | **EDITED** - added `<script src="/js/nova-voice.js"></script>` after ptt.js. |
| `public/sw.js` | **EDITED** - bumped cache to `nova-v127` and precached `/js/nova-voice.js`. |

**All wiring is already applied in the repo.** Nothing to paste - you just need the API keys and a push.

---

## Step 1 - (done) Wiring is already in the repo

The three edits that used to be manual (the `server.js` route, the `index.html` script tag, and
the `sw.js` cache bump) are already made and committed-ready. Skip straight to the keys.

---

## Step 2 - Get the two API keys

**OpenAI (Whisper / speech-to-text)**
1. Go to https://platform.openai.com/api-keys
2. Create a secret key, copy it (starts with `sk-`).
3. Make sure the account has a little billing credit - Whisper is ~$0.006 per minute of audio.

**ElevenLabs (voice / text-to-speech)** - you are already in here.
1. Profile -> **API Keys** -> copy your key.
2. Voices -> pick the voice you want Nova to speak in -> copy its **Voice ID**.
   (If you skip this, Nova uses the "Rachel" preset.)

---

## Step 3 - Add Railway variables

In Railway -> your service -> **Variables**, add:

    OPENAI_API_KEY        = sk-...            (required)
    ELEVENLABS_API_KEY    = your-key          (required)
    ELEVENLABS_VOICE_ID   = your-voice-id     (optional; defaults to Rachel)

Optional tuning (leave off unless you want to change them):

    ELEVENLABS_MODEL      = eleven_turbo_v2_5   (low-latency default)
    OPENAI_STT_MODEL      = whisper-1

---

## Step 4 - Commit, push, deploy

Commit `routes/voice.js`, `public/js/nova-voice.js`, `public/js/ptt.js`, and your three
one-liner edits in **GitHub Desktop**, push to `main`. Railway auto-deploys.

---

## Step 5 - Test it

1. Hard-refresh the site (or reinstall the PWA) and log in.
2. A round button appears bottom-left. Click it -> allow the microphone -> it turns green and says **"Listening for Hey Nova."**
3. **Navigation:** say *"Hey Nova, open my tasks."* -> it jumps to Tasks and confirms out loud.
4. **Ask it something:** say *"Hey Nova, how many open purchase orders are there?"* -> Nova answers in voice.
5. **Broadcast:** open **Radio**, go live on a channel, then ask Nova something. The reply plays to the whole channel (and to you).
6. If the wake word ever misses, just **tap the green mic** to talk to Nova directly.
   The **X** turns voice mode off.

---

## Good things to say

- "Hey Nova, **open** quotes / fleet / the schedule / the running list / documents / the radio."
- "Hey Nova, **new** purchase order / new quote / new task / new vehicle repair."
- "Hey Nova, **what are my tasks for today?**"
- "Hey Nova, **create a task** to call the Kwikset rep tomorrow." (uses the same action tools as Nova AI)
- "Hey Nova, **how is our Geico survey performance this month?**"

Anything that is not a navigation phrase goes to the Nova AI agent, so it can answer trade
questions and take actions exactly like the assistant in the app.

---

## Notes & limits

- **Wake word** uses the browser speech engine - works in **Chrome / Edge / Android Chrome**. On Safari/iOS there is no wake word, but the **tap-the-mic** path still works (Whisper does the transcription either way).
- **Broadcast** requires you to be **live on a channel**. If you are not, Nova just plays the reply on your own device.
- Voice requests that hit the AI agent **count against the daily/monthly AI limits** (same as text chat).
- Nova pauses its own ears while it is talking, so it will not trigger itself.
- **Change the voice** anytime by swapping `ELEVENLABS_VOICE_ID` in Railway - no code change.

## Rollback

If anything misbehaves: remove the `nova-voice.js` script tag from `index.html` (voice disappears,
nothing else affected), or restore `public/js/ptt.js.bak-novavoice`. The `/api/voice` route is
inert without the keys.
