/* Nova Voice - lives INSIDE the Zello channels. No button, no wake word, no
   always-on listening. When you transmit on a channel (hold the normal talk
   button / Space) and start with "Nova, ...", Nova hears that transmission,
   transcribes it with ElevenLabs Scribe, runs the Nova AI agent, and broadcasts
   the spoken reply on the channel. Transmissions that don't start with "Nova"
   are ignored. Loaded after app.js and ptt.js. No backticks. Vanilla JS.

   Trigger: the 'nova-ptt-talk' DOM event dispatched by ptt.js setTalking(). */
(function () {
  'use strict';

  function LOG() {
    if (window.NOVA_VOICE_DEBUG === false) return;
    try { console.log.apply(console, ['[NovaVoice]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  var NV = {
    ready: false, checked: false,
    mic: null, rec: null, chunks: [], recMime: 'audio/webm',
    capturing: false, busy: false, speaking: false,
    audioCtx: null, stopSpeak: null, capTimer: null,
    history: []
  };

  // Address regex: transmission must START by naming Nova. Scribe is accurate,
  // so "nova" comes through clean; we still allow a couple of near-cousins.
  var ADDR_RE = /^\s*(?:hey|hay|hi|hello|ok|okay|yo)?[\s,]*(?:nova|novah|no ?va|cordova)\b[\s,.:!?-]*/i;

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

  // ---- capture the channel transmission (driven by ptt.js talk events) --------
  function startCapture() {
    if (!NV.ready || NV.capturing || NV.busy) return;
    // If Nova is mid-reply and you key up again, stop Nova so you are heard.
    if (NV.speaking && NV.stopSpeak) { var f = NV.stopSpeak; NV.stopSpeak = null; f(); }
    ensureAudioCtx();
    ensureMic().then(function (stream) {
      var mime = pickMime(); NV.recMime = mime || 'audio/webm';
      var mr; try { mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); } catch (e) { return; }
      NV.chunks = [];
      mr.ondataavailable = function (e) { if (e.data && e.data.size) NV.chunks.push(e.data); };
      mr.onstop = function () { handleClip(new Blob(NV.chunks, { type: NV.recMime })); };
      NV.rec = mr; NV.capturing = true;
      mr.start();
      NV.capTimer = setTimeout(function () { stopCapture(); }, 30000);
    }).catch(function (e) { LOG('mic unavailable:', e && e.message); });
  }
  function stopCapture() {
    if (!NV.capturing) return;
    NV.capturing = false;
    if (NV.capTimer) { clearTimeout(NV.capTimer); NV.capTimer = null; }
    if (NV.rec && NV.rec.state !== 'inactive') { try { NV.rec.stop(); } catch (e) {} }
    NV.rec = null;
  }

  document.addEventListener('nova-ptt-talk', function (e) {
    var on = e && e.detail && e.detail.on;
    if (on) startCapture(); else stopCapture();
  });

  function handleClip(blob) {
    if (!blob || blob.size < 1400) return; // too short = keyed by accident
    postBytes('/voice/transcribe', blob, NV.recMime).then(function (r) {
      var text = (r && r.text ? r.text.trim() : '');
      if (!text) return;
      var m = text.match(ADDR_RE);
      if (!m) { LOG('transmission (not for Nova):', text); return; }
      var command = text.slice(m[0].length).trim();
      LOG('addressed to Nova:', command || '(nothing)');
      if (!command) return; // just said "Nova" with no request
      NV.busy = true;
      routeCommand(command);
    }).catch(function (e) { LOG('transcribe failed:', e && e.message); });
  }

  // ---- navigate locally, or ask the Nova AI agent -----------------------------
  function routeCommand(text) {
    var wordCount = text.trim().split(/\s+/).length;
    var navVerb = /^\s*(open|go to|goto|show|show me|pull up|take me to|navigate to|jump to|bring up|switch to)\b/i.test(text);
    if (navVerb || wordCount <= 3) {
      var nav = matchNav(text);
      if (nav) { try { if (window.navigate) navigate(nav.view, nav.param || null); } catch (e) {} return speakThen('Opening ' + nav.label + '.'); }
    }
    NV.history.push({ role: 'user', content: text });
    if (NV.history.length > 8) NV.history = NV.history.slice(-8);
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
    NV.busy = false; NV.speaking = true;
    postSpeak(text).then(function (mp3) { playAndBroadcast(mp3, finishSpeaking); })
      .catch(function () { toast('Nova: ' + text, 'info'); finishSpeaking(); });
  }
  function finishSpeaking() { NV.speaking = false; }

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
    NV.stopSpeak = done;
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
      } catch (e) { /* fall through */ }
    }
    audio.onended = done; audio.play().catch(function () { done(); });
  }

  // ---- boot -------------------------------------------------------------------
  document.addEventListener('pointerdown', function () { if (NV.audioCtx && NV.audioCtx.state === 'suspended') { try { NV.audioCtx.resume(); } catch (e) {} } }, true);

  function checkConfig() {
    if (typeof state === 'undefined' || !state.token || !state.user) return;
    if (NV.checked) return;
    NV.checked = true;
    api('GET', '/voice/config').then(function (c) { NV.ready = !!(c && c.ready); LOG('Nova Voice ready =', NV.ready, '- address the channel with "Nova, ..."'); })
      .catch(function (e) { NV.ready = false; LOG('config check failed:', e && e.message); });
  }
  var boot = setInterval(function () { if (typeof state !== 'undefined' && state.token && state.user) { clearInterval(boot); checkConfig(); } }, 800);

  window.NovaVoice = { ready: function () { return NV.ready; } };
})();
