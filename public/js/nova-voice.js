/* Nova Voice - "Hey Nova" hands-free voice for Nova AI on the radio.
   Loaded after app.js and ptt.js. No backticks (Windows-safe). Vanilla JS.

   Pipeline:
     1) Web Speech API listens continuously for the wake phrase "Hey Nova".
     2) On wake, record the command with MediaRecorder + silence detection.
     3) POST the audio to /api/voice/transcribe (ElevenLabs Scribe) -> text.
     4) If the text is a navigation command, jump screens instantly.
        Otherwise send it to /api/ai/agent (the same Nova AI brain, tools).
     5) POST the reply to /api/voice/speak (ElevenLabs) -> mp3, then play it
        AND publish it to the live radio channel so the whole channel hears it.

   Depends on globals from app.js (state, navigate, showToast, api) and the
   window.NovaRadio bridge exposed by ptt.js for channel broadcast. */
(function () {
  'use strict';

  var NV = {
    ready: false, checked: false,
    wantListen: false,   // user has voice mode ON
    busy: false,         // capturing/processing a command
    speaking: false,     // Nova is talking (broadcasting)
    sr: null, noSR: false,
    mic: null,           // persistent MediaStream
    rec: null, chunks: [], recMime: 'audio/webm',
    capTimer: null, silenceRAF: null,
    audioCtx: null,
    history: [],         // short rolling conversation for the agent
    lastActivity: 0
  };

  var WAKE_RE = /\b(hey|hay|hi|hello|okay|ok|yo|a)\s*,?\s*(nova|novah|nova|neva|no va|nolva)\b/i;

  // ---- navigation vocabulary: spoken phrase -> app view -----------------------
  var NAV = [
    { re: /\b(new|create|start|add)\b.*\b(purchase order|p ?o)\b/i, view: 'new', label: 'a new purchase order' },
    { re: /\b(new|create|start|add)\b.*\bquote\b/i, view: 'new-quote', label: 'a new quote' },
    { re: /\b(new|create|start|add)\b.*\b(vehicle repair|repair|maintenance|v ?r)\b/i, view: 'new-vr', label: 'a new vehicle repair' },
    { re: /\b(new|create|start|add)\b.*\btask\b/i, view: 'new-task', label: 'a new task' },
    { re: /\bpurchase orders?\b|\bp ?o ?s\b|\bpo list\b/i, view: 'dashboard', label: 'Purchase Orders' },
    { re: /\bquotes?\b/i, view: 'quotes', label: 'Quotes' },
    { re: /\b(vehicle repairs?|vehicle maintenance|repairs?|v ?r)\b/i, view: 'vr-dashboard', label: 'Vehicle Repairs' },
    { re: /\bfleet( registry)?\b|\bvehicles?\b/i, view: 'fleet-registry', label: 'Fleet Registry' },
    { re: /\btasks?\b|\bto ?do\b/i, view: 'tasks', label: 'Tasks' },
    { re: /\bschedule\b|\bshifts?\b/i, view: 'schedule', label: 'the Schedule' },
    { re: /\btime ?clock\b|\bpunch (in|out)\b|\bclock (in|out)\b/i, view: 'timeclock', label: 'the Time Clock' },
    { re: /\b(running list|monthly req|monthly request)\b/i, view: 'running', label: 'the Running List' },
    { re: /\bpassword vault\b|\bcredential vault\b/i, view: 'vault', label: 'the Password Vault' },
    { re: /\b(documents?|document vault|file vault|files)\b/i, view: 'documents', label: 'Documents' },
    { re: /\b(s ?o ?ps?|procedures?|sop library)\b/i, view: 'sop-library', label: 'the SOP Library' },
    { re: /\breviews?\b/i, view: 'reviews', label: 'Reviews' },
    { re: /\bfeedback\b/i, view: 'feedback', label: 'Customer Feedback' },
    { re: /\bsuggestions?\b/i, view: 'suggestions', label: 'Suggestions' },
    { re: /\bdeposits?\b|\bcash drops?\b/i, view: 'deposits', label: 'Cash Deposits' },
    { re: /\bparts( list| catalog)?\b/i, view: 'parts-list', label: 'the Parts List' },
    { re: /\bwork orders?\b/i, view: 'work-orders', label: 'Work Orders' },
    { re: /\bsignatures?\b|\be ?sign\b/i, view: 'signatures', label: 'Signatures' },
    { re: /\borg chart\b|\borganization chart\b/i, view: 'org-chart', label: 'the Org Chart' },
    { re: /\bvendors?\b|\baccounts?\b/i, view: 'vendors', label: 'Vendors' },
    { re: /\busers?\b/i, view: 'users', label: 'Users' },
    { re: /\bsettings?\b/i, view: 'settings', label: 'Settings' },
    { re: /\b(radio|walkie|channels?|p ?t ?t)\b/i, view: 'ptt', label: 'the Radio' },
    { re: /\b(home|dashboard|main screen)\b/i, view: 'home', label: 'Home' }
  ];

  function matchNav(text) {
    for (var i = 0; i < NAV.length; i++) { if (NAV[i].re.test(text)) return NAV[i]; }
    return null;
  }

  // ---- auth helpers (mirror app.js api() rolling-token behavior) ---------------
  function tok() { return (window.state && state.token) || localStorage.getItem('po_token'); }
  function pickToken(res) {
    var t = res.headers.get('X-New-Token');
    if (t) { if (window.state) state.token = t; localStorage.setItem('po_token', t); }
  }
  function safeJson(res) { return res.json().then(function (j) { return j; }, function () { return null; }); }

  function postBytes(path, blob, mime) {
    return fetch('/api' + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok(), 'Content-Type': mime },
      body: blob
    }).then(function (res) {
      pickToken(res);
      if (!res.ok) return safeJson(res).then(function (e) { throw new Error((e && e.error) || ('HTTP ' + res.status)); });
      return res.json();
    });
  }
  function postSpeak(text) {
    return fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (res) {
      pickToken(res);
      if (!res.ok) return safeJson(res).then(function (e) { throw new Error((e && e.error) || ('HTTP ' + res.status)); });
      return res.blob();
    });
  }

  // ---- tiny UI ----------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('nova-voice-css')) return;
    var css = [
      '#nova-voice{position:fixed;left:14px;bottom:88px;z-index:9998;display:flex;align-items:center;gap:8px;font-family:inherit}',
      '#nova-voice .nv-btn{width:52px;height:52px;border-radius:50%;border:2px solid #3a3a3a;background:#161616;color:#9ca3af;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.5);transition:all .15s;font-size:22px;user-select:none}',
      '#nova-voice .nv-btn:hover{transform:translateY(-1px)}',
      '#nova-voice.on .nv-btn{border-color:#22c55e;color:#22c55e}',
      '#nova-voice.hearing .nv-btn{border-color:#3b82f6;color:#3b82f6;animation:nvpulse 1s infinite}',
      '#nova-voice.thinking .nv-btn{border-color:#eab308;color:#eab308;animation:nvpulse .8s infinite}',
      '#nova-voice.speaking .nv-btn{border-color:#f97316;color:#f97316;animation:nvpulse .7s infinite}',
      '#nova-voice .nv-status{background:#161616;border:1px solid #2a2a2a;color:#d1d5db;font-size:12px;padding:6px 10px;border-radius:14px;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 4px 14px rgba(0,0,0,.4)}',
      '#nova-voice .nv-off{width:22px;height:22px;border-radius:50%;border:1px solid #3a3a3a;background:#161616;color:#9ca3af;display:none;align-items:center;justify-content:center;cursor:pointer;font-size:12px}',
      '#nova-voice.on .nv-off,#nova-voice.hearing .nv-off,#nova-voice.thinking .nv-off,#nova-voice.speaking .nv-off{display:flex}',
      '@keyframes nvpulse{0%{box-shadow:0 0 0 0 rgba(59,130,246,.5)}70%{box-shadow:0 0 0 12px rgba(59,130,246,0)}100%{box-shadow:0 0 0 0 rgba(59,130,246,0)}}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'nova-voice-css'; s.textContent = css;
    document.head.appendChild(s);
  }

  function ensureUI() {
    if (document.getElementById('nova-voice')) return;
    injectStyles();
    var wrap = document.createElement('div');
    wrap.id = 'nova-voice';
    wrap.innerHTML =
      '<div class="nv-btn" title="Hey Nova voice">●</div>' +
      '<div class="nv-status" style="display:none"></div>' +
      '<div class="nv-off" title="Turn voice off">✕</div>';
    document.body.appendChild(wrap);
    wrap.querySelector('.nv-btn').addEventListener('click', onBtn);
    wrap.querySelector('.nv-off').addEventListener('click', function (e) { e.stopPropagation(); disable(); });
    setState('idle', '');
  }

  function setState(mode, msg) {
    var wrap = document.getElementById('nova-voice');
    if (!wrap) return;
    wrap.className = (mode === 'idle' && !NV.wantListen) ? '' :
      (mode === 'listening' || mode === 'idle') ? 'on' : mode;
    var btn = wrap.querySelector('.nv-btn');
    btn.textContent = NV.wantListen ? (NV.speaking ? '▶' : (NV.busy ? '…' : '🎙')) : '●';
    var st = wrap.querySelector('.nv-status');
    if (msg) { st.style.display = 'block'; st.textContent = msg; }
    else if (NV.wantListen) { st.style.display = 'block'; st.textContent = 'Listening for "Hey Nova"'; }
    else { st.style.display = 'none'; }
  }

  function toast(m, t) { try { if (window.showToast) showToast(m, t || 'info'); } catch (e) {} }

  // ---- master on/off ----------------------------------------------------------
  function onBtn() {
    if (!NV.wantListen) { enable(); }
    else if (!NV.busy && !NV.speaking) { onWake(true); } // manual trigger if wake missed
  }

  function enable() {
    if (!NV.ready) {
      toast('Nova Voice is not configured yet. An admin needs to add the ElevenLabs key.', 'error');
      return;
    }
    NV.wantListen = true;
    ensureAudioCtx();
    ensureMic().then(function () {
      startSR();
      setState('listening', '');
      toast('Nova Voice on — say "Hey Nova"', 'success');
    }).catch(function () {
      NV.wantListen = false;
      setState('idle', '');
      toast('Microphone permission is needed for Nova Voice.', 'error');
    });
  }

  function disable() {
    NV.wantListen = false;
    stopSR();
    stopCommand(true);
    if (NV.mic) { try { NV.mic.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} NV.mic = null; }
    setState('idle', '');
  }

  // ---- microphone + audio context --------------------------------------------
  function ensureAudioCtx() {
    if (!NV.audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) NV.audioCtx = new AC();
    }
    if (NV.audioCtx && NV.audioCtx.state === 'suspended') { try { NV.audioCtx.resume(); } catch (e) {} }
    return NV.audioCtx;
  }
  function ensureMic() {
    if (NV.mic && NV.mic.active) return Promise.resolve(NV.mic);
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (s) { NV.mic = s; return s; });
  }

  // ---- wake-word recognition (Web Speech) -------------------------------------
  function startSR() {
    var SRC = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SRC) { NV.noSR = true; toast('This browser has no wake-word engine — tap the mic to talk to Nova.', 'info'); return; }
    stopSR();
    var sr = new SRC();
    sr.continuous = true; sr.interimResults = true; sr.lang = 'en-US';
    sr.onresult = function (ev) {
      if (NV.busy || NV.speaking || !NV.wantListen) return;
      var txt = '';
      for (var i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript + ' ';
      if (WAKE_RE.test(txt)) { onWake(false); }
    };
    sr.onerror = function () { /* handled by onend restart */ };
    sr.onend = function () {
      if (NV.wantListen && !NV.busy && !NV.speaking) { try { sr.start(); } catch (e) {} }
    };
    NV.sr = sr;
    try { sr.start(); } catch (e) {}
  }
  function stopSR() {
    if (NV.sr) { try { NV.sr.onend = null; NV.sr.stop(); } catch (e) {} NV.sr = null; }
  }

  // ---- wake -> record command -------------------------------------------------
  function onWake(manual) {
    if (NV.busy || NV.speaking) return;
    NV.busy = true;
    stopSR(); // free the recognizer while we record + answer
    beep(880, 90);
    setState('hearing', manual ? 'Listening…' : 'Yes? Listening…');
    recordCommand();
  }

  function pickMime() {
    var opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < opts.length; i++) {
      try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch (e) {}
    }
    return '';
  }

  function recordCommand() {
    ensureMic().then(function (stream) {
      var mime = pickMime();
      NV.recMime = mime || 'audio/webm';
      var mr;
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
      catch (e) { return resetIdle('Could not start recording.'); }
      NV.chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) NV.chunks.push(e.data); };
      mr.onstop = function () {
        var blob = new Blob(NV.chunks, { type: NV.recMime });
        handleCommandAudio(blob);
      };
      NV.rec = mr;
      mr.start();
      NV.capTimer = setTimeout(function () { stopCommand(); }, 12000); // hard cap
      monitorSilence(stream);
    }).catch(function () { resetIdle('Microphone unavailable.'); });
  }

  function monitorSilence(stream) {
    var ctx = ensureAudioCtx();
    if (!ctx) return; // no analyser; rely on hard cap
    var src = ctx.createMediaStreamSource(stream);
    var an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    var buf = new Uint8Array(an.fftSize);
    var startedAt = Date.now();
    var spokeAt = 0;
    var lastLoud = 0;
    var THRESH = 0.018, SILENCE_MS = 1100, NO_SPEECH_MS = 3800;
    function tick() {
      if (!NV.rec || NV.rec.state === 'inactive') { try { src.disconnect(); } catch (e) {} return; }
      an.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      var rms = Math.sqrt(sum / buf.length);
      var now = Date.now();
      if (rms > THRESH) { if (!spokeAt) spokeAt = now; lastLoud = now; }
      if (spokeAt && (now - lastLoud) > SILENCE_MS) { try { src.disconnect(); } catch (e) {} stopCommand(); return; }
      if (!spokeAt && (now - startedAt) > NO_SPEECH_MS) { try { src.disconnect(); } catch (e) {} stopCommand(true); return; }
      NV.silenceRAF = requestAnimationFrame(tick);
    }
    NV.silenceRAF = requestAnimationFrame(tick);
  }

  function stopCommand(abort) {
    if (NV.capTimer) { clearTimeout(NV.capTimer); NV.capTimer = null; }
    if (NV.silenceRAF) { cancelAnimationFrame(NV.silenceRAF); NV.silenceRAF = null; }
    if (NV.rec && NV.rec.state !== 'inactive') { try { NV.rec.stop(); } catch (e) {} }
    NV.rec = null;
    if (abort === true) {
      // nothing was said; silently resume listening
      NV.chunks = [];
      NV.busy = false; NV.speaking = false;
      if (NV.wantListen) startSR();
      setState('listening', '');
    }
  }

  function handleCommandAudio(blob) {
    if (!blob || blob.size < 1400) { return resetIdle(''); }
    setState('thinking', 'Thinking…');
    postBytes('/voice/transcribe', blob, NV.recMime).then(function (r) {
      var text = (r && r.text ? r.text.trim() : '');
      // strip an accidental leading wake word Scribe may have caught
      text = text.replace(/^\s*(hey|hi|hello|ok|okay)?\s*,?\s*nova[\s,.:!-]*/i, '').trim();
      if (!text) { return speakThen("I did not catch that.", null); }
      routeCommand(text);
    }).catch(function (e) {
      resetIdle('Could not hear you (' + (e.message || 'error') + ').');
    });
  }

  // ---- decide: navigate locally, or ask the Nova AI agent ---------------------
  function routeCommand(text) {
    setState('thinking', text);
    var nav = matchNav(text);
    if (nav) {
      try { if (window.navigate) navigate(nav.view, nav.param || null); } catch (e) {}
      return speakThen('Opening ' + nav.label + '.', null);
    }
    // conversational / action request -> Nova AI agent (same brain, tools)
    NV.history.push({ role: 'user', content: text });
    if (NV.history.length > 8) NV.history = NV.history.slice(-8);
    api('POST', '/ai/agent', { messages: NV.history.slice() }).then(function (data) {
      var reply = (data && data.reply ? String(data.reply).trim() : '') || 'Done.';
      NV.history.push({ role: 'assistant', content: reply });
      speakThen(reply, null);
    }).catch(function (e) {
      var m = (e && e.message) || '';
      var say = /limit/i.test(m) ? 'You have reached your AI usage limit for now.'
        : /config/i.test(m) ? 'The AI assistant is not configured.'
        : 'Sorry, something went wrong.';
      speakThen(say, null);
    });
  }

  // ---- speak (ElevenLabs) + broadcast to the live channel ---------------------
  function speakThen(text, _cb) {
    setState('speaking', text.length > 60 ? text.slice(0, 57) + '…' : text);
    NV.speaking = true;
    postSpeak(text).then(function (mp3) {
      playAndBroadcast(mp3, finishSpeaking);
    }).catch(function () {
      // TTS failed; still show the answer as a toast so nothing is lost
      toast('Nova: ' + text, 'info');
      finishSpeaking();
    });
  }

  function finishSpeaking() {
    NV.speaking = false;
    NV.busy = false;
    NV.lastActivity = Date.now();
    if (NV.wantListen) { startSR(); setState('listening', ''); }
    else setState('idle', '');
  }

  function playAndBroadcast(mp3Blob, onEnd) {
    var url = URL.createObjectURL(mp3Blob);
    var audio = new Audio();
    audio.src = url;
    var ended = false;
    function done() {
      if (ended) return; ended = true;
      try { URL.revokeObjectURL(url); } catch (e) {}
      if (onEnd) onEnd();
    }
    var room = null;
    try { room = window.NovaRadio && window.NovaRadio.talkRoom ? window.NovaRadio.talkRoom() : null; } catch (e) {}
    var LK = window.LivekitClient;
    var ctx = ensureAudioCtx();

    if (room && LK && ctx) {
      // Route the mp3 through WebAudio: local monitor + a MediaStream we publish.
      try {
        var srcNode = ctx.createMediaElementSource(audio);
        var dest = ctx.createMediaStreamDestination();
        srcNode.connect(dest);
        srcNode.connect(ctx.destination); // asker hears it locally too
        var msTrack = dest.stream.getAudioTracks()[0];
        var lkTrack = new LK.LocalAudioTrack(msTrack);
        room.localParticipant.publishTrack(lkTrack).then(function () {
          audio.onended = function () {
            try { room.localParticipant.unpublishTrack(lkTrack); } catch (e) {}
            try { lkTrack.stop(); } catch (e) {}
            done();
          };
          audio.play().catch(function () { done(); });
        }, function () {
          // publish failed -> just play locally
          srcNode.connect(ctx.destination);
          audio.onended = done; audio.play().catch(function () { done(); });
        });
        return;
      } catch (e) { /* fall through to local playback */ }
    }
    // Local-only playback (not live on a channel, or no LiveKit).
    audio.onended = done;
    audio.play().catch(function () { done(); });
  }

  function resetIdle(msg) {
    NV.busy = false; NV.speaking = false;
    if (msg) toast(msg, 'info');
    if (NV.wantListen) { startSR(); setState('listening', ''); }
    else setState('idle', '');
  }

  function beep(freq, ms) {
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.value = 0.05;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(function () { try { o.stop(); } catch (e) {} }, ms || 100);
    } catch (e) {}
  }

  // ---- boot -------------------------------------------------------------------
  function checkConfig() {
    if (!window.state || !state.token || !state.user) return;
    if (NV.checked) return;
    NV.checked = true;
    api('GET', '/voice/config').then(function (c) {
      NV.ready = !!(c && c.ready);
      ensureUI();
      if (!NV.ready) setState('idle', '');
    }).catch(function () { /* voice route not deployed yet; stay silent */ });
  }

  // The app renders after login; poll briefly until we have a session.
  var boot = setInterval(function () {
    if (window.state && state.token && state.user) { clearInterval(boot); checkConfig(); }
  }, 800);

  window.NovaVoice = { enable: enable, disable: disable, trigger: function () { onWake(true); } };
})();
