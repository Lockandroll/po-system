/* Nova Voice - PUSH-TO-TALK to Nova AI on the radio.
   No wake word, no always-on listening. Nova only listens while you HOLD the
   Nova button (or the Nova PTT key) - and only when you are live on a channel.
   Release to send: the clip goes to ElevenLabs Scribe, then the Nova AI agent,
   and the spoken reply is broadcast on the channel so everyone hears it.
   Loaded after app.js and ptt.js. No backticks (Windows-safe). Vanilla JS.

   Depends on globals from app.js (state, navigate, showToast, api) and the
   window.NovaRadio bridge from ptt.js (isLive / talkRoom). */
(function () {
  'use strict';

  function LOG() {
    if (window.NOVA_VOICE_DEBUG === false) return;
    try { console.log.apply(console, ['[NovaVoice]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  var NV = {
    ready: false, checked: false,
    mic: null, rec: null, chunks: [], recMime: 'audio/webm',
    talking: false, busy: false, speaking: false,
    audioCtx: null, stopSpeak: null, capTimer: null,
    history: [], watch: null,
    key: (localStorage.getItem('nova_ptt_key') || 'Backquote'),
    learning: false
  };

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

  // ---- auth helpers (mirror app.js api() rolling-token behavior) --------------
  function tok() { return (typeof state !== 'undefined' && state.token) || localStorage.getItem('po_token'); }
  function pickToken(res) {
    var t = res.headers.get('X-New-Token');
    if (t) { if (typeof state !== 'undefined') state.token = t; localStorage.setItem('po_token', t); }
  }
  function safeJson(res) { return res.json().then(function (j) { return j; }, function () { return null; }); }
  function postBytes(path, blob, mime) {
    return fetch('/api' + path, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok(), 'Content-Type': mime }, body: blob })
      .then(function (res) { pickToken(res); if (!res.ok) return safeJson(res).then(function (e) { throw new Error((e && e.error) || ('HTTP ' + res.status)); }); return res.json(); });
  }
  function postSpeak(text) {
    return fetch('/api/voice/speak', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text }) })
      .then(function (res) { pickToken(res); if (!res.ok) return safeJson(res).then(function (e) { throw new Error((e && e.error) || ('HTTP ' + res.status)); }); return res.blob(); });
  }
  function toast(m, t) { try { if (window.showToast) showToast(m, t || 'info'); } catch (e) {} }

  // ---- mic + audio ------------------------------------------------------------
  function ensureAudioCtx() {
    if (!NV.audioCtx) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) NV.audioCtx = new AC(); }
    if (NV.audioCtx && NV.audioCtx.state === 'suspended') { try { NV.audioCtx.resume(); } catch (e) {} }
    return NV.audioCtx;
  }
  function ensureMic() {
    if (NV.mic && NV.mic.active) return Promise.resolve(NV.mic);
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (s) { NV.mic = s; return s; });
  }
  function pickMime() {
    var opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    for (var i = 0; i < opts.length; i++) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i]; } catch (e) {} }
    return '';
  }
  function beep(freq, ms) {
    var ctx = ensureAudioCtx(); if (!ctx) return;
    try { var o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = freq; g.gain.value = 0.05; o.connect(g); g.connect(ctx.destination); o.start(); setTimeout(function () { try { o.stop(); } catch (e) {} }, ms || 90); } catch (e) {}
  }

  // ---- push-to-talk -----------------------------------------------------------
  function liveOnChannel() { try { return !!(window.NovaRadio && window.NovaRadio.isLive && window.NovaRadio.isLive()); } catch (e) { return false; } }

  function startTalk() {
    if (NV.talking || NV.busy) return;
    if (!NV.ready) { toast('Nova voice is not configured (needs ELEVENLABS_API_KEY).', 'error'); return; }
    // If Nova is mid-reply, holding the button interrupts it so you can talk.
    if (NV.speaking && NV.stopSpeak) { var f = NV.stopSpeak; NV.stopSpeak = null; f(); }
    ensureAudioCtx();
    ensureMic().then(function (stream) {
      var mime = pickMime(); NV.recMime = mime || 'audio/webm';
      var mr; try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { toast('Cannot record on this device.', 'error'); return; }
      NV.chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) NV.chunks.push(e.data); };
      mr.onstop = function () { handleCommandAudio(new Blob(NV.chunks, { type: NV.recMime })); };
      NV.rec = mr; NV.talking = true;
      mr.start();
      beep(720, 70); setBtn('talk');
      LOG('talking (holding)...');
      NV.capTimer = setTimeout(function () { stopTalk(); }, 30000); // 30s safety cap
    }).catch(function (e) { LOG('mic failed:', e && e.message); toast('Microphone permission is needed for Nova.', 'error'); });
  }

  function stopTalk() {
    if (!NV.talking) return;
    NV.talking = false;
    if (NV.capTimer) { clearTimeout(NV.capTimer); NV.capTimer = null; }
    if (NV.rec && NV.rec.state !== 'inactive') { try { NV.rec.stop(); } catch (e) {} }
    NV.rec = null;
    setBtn('thinking'); LOG('released - transcribing');
  }

  function handleCommandAudio(blob) {
    if (!blob || blob.size < 1200) { setBtn('idle'); return; } // too short = accidental tap
    NV.busy = true;
    postBytes('/voice/transcribe', blob, NV.recMime).then(function (r) {
      var text = (r && r.text ? r.text.trim() : '');
      LOG('transcript:', text);
      if (!text) { NV.busy = false; setBtn('idle'); return; }
      routeCommand(text);
    }).catch(function (e) { LOG('transcribe failed:', e && e.message); NV.busy = false; setBtn('idle'); toast('Could not transcribe that.', 'error'); });
  }

  function routeCommand(text) {
    // Only treat as pure navigation for short "go to X" phrases; real requests
    // ("put me on the schedule 8 to 8") go to Nova's brain so it can act.
    var wordCount = text.trim().split(/\s+/).length;
    var navVerb = /^\s*(open|go to|goto|show|show me|pull up|take me to|navigate to|jump to|bring up|switch to)\b/i.test(text);
    if (navVerb || wordCount <= 3) {
      var nav = matchNav(text);
      if (nav) { try { if (window.navigate) navigate(nav.view, nav.param || null); } catch (e) {} return speakThen('Opening ' + nav.label + '.'); }
    }
    NV.history.push({ role: 'user', content: text });
    if (NV.history.length > 8) NV.history = NV.history.slice(-8);
    setBtn('thinking');
    api('POST', '/ai/agent', { messages: NV.history.slice() }).then(function (data) {
      var reply = (data && data.reply ? String(data.reply).trim() : '') || 'Done.';
      NV.history.push({ role: 'assistant', content: reply });
      speakThen(reply);
    }).catch(function (e) {
      var m = (e && e.message) || '';
      speakThen(/limit/i.test(m) ? 'You have reached your AI usage limit for now.' : (/config/i.test(m) ? 'The AI assistant is not configured.' : 'Sorry, something went wrong.'));
    });
  }

  // ---- speak (ElevenLabs) + broadcast on the channel --------------------------
  function speakThen(text) {
    LOG('Nova says:', text);
    NV.busy = false; NV.speaking = true; setBtn('speaking');
    postSpeak(text).then(function (mp3) { playAndBroadcast(mp3, finishSpeaking); })
      .catch(function () { toast('Nova: ' + text, 'info'); finishSpeaking(); });
  }
  function finishSpeaking() { NV.speaking = false; setBtn('idle'); }

  function playAndBroadcast(mp3Blob, onEnd) {
    var url = URL.createObjectURL(mp3Blob);
    var audio = new Audio(); audio.src = url;
    var ended = false, lkTrack = null, lkRoom = null;
    function done() {
      if (ended) return; ended = true;
      NV.stopSpeak = null;
      if (lkTrack && lkRoom) { try { lkRoom.localParticipant.unpublishTrack(lkTrack); } catch (e) {} }
      if (lkTrack) { try { lkTrack.stop(); } catch (e) {} }
      try { audio.pause(); } catch (e) {}
      try { URL.revokeObjectURL(url); } catch (e) {}
      if (onEnd) onEnd();
    }
    NV.stopSpeak = done; // holding the button while Nova talks stops it cleanly
    var room = null;
    try { room = window.NovaRadio && window.NovaRadio.talkRoom ? window.NovaRadio.talkRoom() : null; } catch (e) {}
    var LK = window.LivekitClient;
    var ctx = ensureAudioCtx();
    LOG('reply -', (room && LK && ctx) ? 'broadcasting to channel' : 'local playback only');
    if (room && LK && ctx) {
      try {
        var srcNode = ctx.createMediaElementSource(audio);
        var dest = ctx.createMediaStreamDestination();
        srcNode.connect(dest); srcNode.connect(ctx.destination);
        var msTrack = dest.stream.getAudioTracks()[0];
        lkTrack = new LK.LocalAudioTrack(msTrack); lkRoom = room;
        room.localParticipant.publishTrack(lkTrack).then(function () { audio.onended = done; audio.play().catch(function () { done(); }); },
          function () { audio.onended = done; audio.play().catch(function () { done(); }); });
        return;
      } catch (e) { /* fall through to local playback */ }
    }
    audio.onended = done; audio.play().catch(function () { done(); });
  }

  // ---- the button -------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('nova-voice-css')) return;
    var css = [
      '#nova-ptt{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;align-items:center;gap:6px;font-family:inherit;user-select:none;-webkit-user-select:none;touch-action:none}',
      '#nova-ptt .nptt-btn{min-width:230px;padding:14px 26px;border-radius:30px;border:2px solid #f97316;background:#1a1207;color:#f97316;font-weight:700;font-size:15px;letter-spacing:.3px;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5);text-align:center;transition:all .12s}',
      '#nova-ptt .nptt-btn:active{transform:scale(.98)}',
      '#nova-ptt.talk .nptt-btn{background:#3a0d0d;border-color:#ef4444;color:#fca5a5}',
      '#nova-ptt.thinking .nptt-btn{border-color:#eab308;color:#eab308}',
      '#nova-ptt.speaking .nptt-btn{border-color:#22c55e;color:#86efac}',
      '#nova-ptt .nptt-hint{font-size:11px;color:#9ca3af;background:rgba(0,0,0,.35);padding:3px 8px;border-radius:8px}'
    ].join('');
    var s = document.createElement('style'); s.id = 'nova-voice-css'; s.textContent = css; document.head.appendChild(s);
  }
  function ensureButton() {
    if (document.getElementById('nova-ptt')) return;
    injectStyles();
    var wrap = document.createElement('div'); wrap.id = 'nova-ptt';
    wrap.innerHTML = '<div class="nptt-btn">HOLD TO TALK TO NOVA</div><div class="nptt-hint">Hold the button (or your Nova key). Release to send.</div>';
    document.body.appendChild(wrap);
    var btn = wrap.querySelector('.nptt-btn');
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (x) {} startTalk(); });
    var up = function (e) { if (e) e.preventDefault(); stopTalk(); };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    setBtn(NV.speaking ? 'speaking' : (NV.busy ? 'thinking' : 'idle'));
  }
  function removeButton() {
    var el = document.getElementById('nova-ptt'); if (el) el.parentNode.removeChild(el);
  }
  function setBtn(mode) {
    var wrap = document.getElementById('nova-ptt'); if (!wrap) return;
    wrap.className = (mode === 'idle') ? '' : mode;
    var btn = wrap.querySelector('.nptt-btn');
    btn.textContent = mode === 'talk' ? 'LISTENING… (release to send)'
      : mode === 'thinking' ? 'THINKING…'
      : mode === 'speaking' ? 'NOVA IS ANSWERING…'
      : 'HOLD TO TALK TO NOVA';
  }

  // ---- hardware key (a physical PTT button usually emits a key) ---------------
  function typingInField(e) {
    var t = e.target; if (!t) return false;
    var tag = (t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
  }
  document.addEventListener('keydown', function (e) {
    if (NV.learning) { e.preventDefault(); NV.key = e.code; localStorage.setItem('nova_ptt_key', e.code); NV.learning = false; LOG('Nova key set to', e.code); toast('Nova button set to: ' + e.code, 'success'); return; }
    if (e.code !== NV.key || e.repeat || typingInField(e)) return;
    if (!liveOnChannel()) return;
    e.preventDefault(); startTalk();
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === NV.key && NV.talking) { e.preventDefault(); stopTalk(); }
  });
  // Unlock audio playback on any interaction.
  document.addEventListener('pointerdown', function () { if (NV.audioCtx && NV.audioCtx.state === 'suspended') { try { NV.audioCtx.resume(); } catch (e) {} } }, true);

  // ---- boot: show the button only while live on a channel ---------------------
  function startWatch() {
    if (NV.watch) return;
    NV.watch = setInterval(function () {
      if (!NV.ready) { removeButton(); return; }
      if (liveOnChannel()) ensureButton();
      else { if (NV.talking) stopTalk(); removeButton(); }
    }, 1200);
  }
  function checkConfig() {
    if (typeof state === 'undefined' || !state.token || !state.user) return;
    if (NV.checked) return;
    NV.checked = true;
    api('GET', '/voice/config').then(function (c) { NV.ready = !!(c && c.ready); LOG('config ready =', NV.ready); startWatch(); })
      .catch(function (e) { NV.ready = false; LOG('config check failed:', e && e.message); });
  }
  var boot = setInterval(function () { if (typeof state !== 'undefined' && state.token && state.user) { clearInterval(boot); checkConfig(); } }, 800);

  window.NovaVoice = {
    start: startTalk, stop: stopTalk,
    setKey: function (code) { NV.key = String(code); localStorage.setItem('nova_ptt_key', NV.key); LOG('Nova key =', NV.key); return NV.key; },
    learnKey: function () { NV.learning = true; toast('Press your Nova button now to bind it...', 'info'); LOG('learning next key press...'); },
    getKey: function () { return NV.key; }
  };
})();
