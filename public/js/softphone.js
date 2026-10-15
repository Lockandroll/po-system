// Phone in Nova (pilot, Tony 2026-10-14): answer GoTo calls in the browser.
// Server side: routes/softphone.js + utils/softphone.js.
//
// A small phone in the bottom-right corner for people with use_softphone, on a
// computer (not the phone app). Set up once: Connect GoTo, enter your extension,
// Turn on. Then calls to that extension ring here with Answer / Send to
// voicemail. In a call: timer, Mute, Hang up, and "Start new call" which opens
// New call with the caller's number filled in. Audio goes through the browser
// (headset), so the mic permission is asked the first time.
//
// Classic script, string building only. No backticks (Windows corruption rule).
(function () {
  'use strict';
  var S = { open: false, st: null, on: false, after: 0, polling: false, ring: null, call: null, pc: null, mic: null,
    muted: false, timer: null, busy: false, regTimer: null, err: '' };
  var ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

  function el(id) { return document.getElementById(id); }
  function esc(s) { return typeof escHtml === 'function' ? escHtml(s) : String(s == null ? '' : s); }
  function canUse() {
    try {
      if (typeof can !== 'function' || !can('use_softphone')) return false;
      if (typeof novaIsNative === 'function' && novaIsNative()) return false;
      return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    } catch (e) { return false; }
  }
  function wantOn(v) {
    try { if (v === undefined) return localStorage.getItem('nova_phone_on') === '1'; localStorage.setItem('nova_phone_on', v ? '1' : '0'); } catch (e) {}
    return false;
  }
  function fmtPhone(s) {
    var d = String(s || '').replace(/[^0-9]/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(s || 'Unknown number');
  }

  function css() {
    if (el('sp-styles')) return;
    var st = document.createElement('style');
    st.id = 'sp-styles';
    st.textContent =
      '#sp-root{position:fixed;right:16px;bottom:16px;z-index:9000;font-size:14px}' +
      '#sp-pill{display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-radius:20px;border:1px solid var(--border,#2e2e2e);' +
        'background:var(--bg-card,#1a1a1a);color:var(--text,#f0f0f0);font:inherit;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.45)}' +
      '#sp-pill .d{width:9px;height:9px;border-radius:50%;background:#71717a}' +
      '#sp-pill.on .d{background:#22c55e}#sp-pill.err .d{background:#f59e0b}' +
      '#sp-panel{position:absolute;right:0;bottom:50px;width:320px;max-width:calc(100vw - 32px);background:var(--bg-card,#1a1a1a);' +
        'border:1px solid var(--border,#2e2e2e);border-radius:14px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.55);color:var(--text,#f0f0f0)}' +
      '#sp-panel h4{margin:0 0 10px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted-color,#888)}' +
      '#sp-panel .sub{font-size:12.5px;color:var(--text-muted-color,#888);line-height:1.5}' +
      '#sp-panel .row{display:flex;gap:8px;margin-top:10px}#sp-panel .row .btn{flex:1;justify-content:center}' +
      '#sp-panel input{width:100%}' +
      '#sp-panel .err{margin-top:10px;font-size:12px;color:#fbbf24;word-break:break-word}' +
      '#sp-ring{position:fixed;right:16px;bottom:66px;z-index:9001;width:320px;max-width:calc(100vw - 32px);background:#14281b;border:2px solid #22c55e;' +
        'border-radius:14px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.6);color:#f0f0f0}' +
      '#sp-ring .who{font-size:20px;font-weight:800;margin:2px 0}#sp-ring .lbl{font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#4ade80}' +
      '#sp-ring .row{display:flex;gap:8px;margin-top:12px}#sp-ring .row button{flex:1;height:46px;border-radius:10px;border:0;font:inherit;font-weight:800;cursor:pointer}' +
      '#sp-ring .ans{background:#22c55e;color:#fff}#sp-ring .vm{background:transparent;color:#f0f0f0;border:1px solid #3a3a3a!important}' +
      '#sp-ring.incall{background:#1a1a1a;border-color:var(--primary,#f97316)}#sp-ring.incall .lbl{color:var(--primary,#f97316)}' +
      '#sp-ring .hang{background:#ef4444;color:#fff}#sp-ring .mute{background:transparent;color:#f0f0f0;border:1px solid #3a3a3a!important}' +
      '#sp-ring .mute.on{background:#f59e0b;color:#111}' +
      '#sp-ring .newc{margin-top:8px;width:100%;height:40px;border-radius:10px;border:1px solid #3a3a3a;background:transparent;color:#f0f0f0;font:inherit;font-weight:700;cursor:pointer}' +
      '@media (prefers-reduced-motion: no-preference){#sp-ring.ringing{animation:spPulse 1.2s ease-in-out infinite}}' +
      '@keyframes spPulse{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}50%{box-shadow:0 0 0 10px rgba(34,197,94,0)}}';
    document.head.appendChild(st);
  }

  function mount() {
    if (!canUse()) { var old = el('sp-root'); if (old) old.parentNode.removeChild(old); return; }
    css();
    if (el('sp-root')) return;
    var root = document.createElement('div');
    root.id = 'sp-root';
    root.innerHTML = '<div id="sp-panel" style="display:none" role="dialog" aria-label="Phone"></div>' +
      '<button type="button" id="sp-pill" aria-expanded="false" aria-controls="sp-panel"><span class="d" aria-hidden="true"></span><span id="sp-pill-t">Phone</span></button>';
    document.body.appendChild(root);
    el('sp-pill').addEventListener('click', function () { S.open = !S.open; drawPanel(); });
    loadStatus().then(function () { if (wantOn() && S.st && S.st.connected && S.st.extension) turnOn(true); });
  }

  async function loadStatus() {
    try { if (typeof apiBustCache === 'function') apiBustCache('/softphone'); S.st = await api('GET', '/softphone/status'); } catch (e) { S.st = null; }
    drawPill(); drawPanel();
  }
  function drawPill() {
    var p = el('sp-pill'); if (!p) return;
    var t = el('sp-pill-t');
    p.className = S.on ? 'on' : (S.err ? 'err' : '');
    if (t) t.textContent = S.call ? 'On a call' : (S.on ? 'Phone on' + (S.st && S.st.extension ? ' \u00b7 ' + S.st.extension : '') : 'Phone off');
    p.setAttribute('aria-expanded', S.open ? 'true' : 'false');
  }
  function drawPanel() {
    var box = el('sp-panel'); if (!box) return;
    box.style.display = S.open ? '' : 'none';
    drawPill();
    if (!S.open) return;
    var st = S.st || {};
    var h = '<h4>Phone in Nova (pilot)</h4>';
    if (!st.configured) {
      h += '<div class="sub">GoTo is not set up in Nova yet. Ask an admin.</div>';
    } else if (!st.connected) {
      h += '<div class="sub">Step 1: sign in to GoTo once so Nova can ring on your extension.</div>' +
        '<div class="row"><button type="button" class="btn btn-primary btn-sm" onclick="spConnect()">Connect GoTo</button></div>';
    } else if (!st.extension) {
      h += '<div class="sub">Step 2: your GoTo extension number.</div>' +
        '<div class="row"><input id="sp-ext" inputmode="numeric" placeholder="e.g. 1001" aria-label="GoTo extension"><button type="button" class="btn btn-primary btn-sm" onclick="spSaveExt()">Save</button></div>';
    } else {
      h += '<div class="sub">' + (S.on ? 'Calls to extension <b>' + esc(st.extension) + '</b> ring here. Use a headset.' :
        'Extension <b>' + esc(st.extension) + '</b>. Turn the phone on to take calls here.') +
        (st.greeted_at && S.on ? '<br>GoTo confirmed this phone ' + esc(new Date(st.greeted_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '.' : '') + '</div>' +
        '<div class="row">' + (S.on
          ? '<button type="button" class="btn btn-secondary btn-sm" onclick="spTurnOff()">Turn off</button>'
          : '<button type="button" class="btn btn-primary btn-sm" onclick="spTurnOn()"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Turning on...' : 'Turn on') + '</button>') +
        '</div>' +
        '<div class="row"><button type="button" class="btn btn-ghost btn-sm" onclick="spChangeExt()">Change extension</button>' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="spDisconnect()">Disconnect GoTo</button></div>';
    }
    var err = S.err || (st.last_error ? 'GoTo said: ' + st.last_error : '');
    if (err) h += '<div class="err" role="alert">' + esc(err) + '</div>';
    if (st.configured && !st.app_url_ok) h += '<div class="err">APP_URL is not an https address, so GoTo cannot reach Nova.</div>';
    box.innerHTML = h;
  }

  window.spConnect = async function () {
    try { var r = await api('GET', '/softphone/connect'); window.open(r.url, '_blank', 'noopener'); }
    catch (e) { S.err = e.message; drawPanel(); return; }
    S.err = 'Finish signing in on the GoTo tab, then come back here.';
    drawPanel();
    var tries = 0;
    var t = setInterval(async function () {
      tries++;
      await loadStatus();
      if ((S.st && S.st.connected) || tries > 60) { clearInterval(t); S.err = ''; drawPanel(); }
    }, 5000);
  };
  window.spSaveExt = async function () {
    var v = (el('sp-ext') || {}).value || '';
    try { await api('POST', '/softphone/extension', { extension: v }); S.err = ''; } catch (e) { S.err = e.message; }
    loadStatus();
  };
  window.spChangeExt = async function () {
    var v = typeof novaPrompt === 'function' ? await novaPrompt('Your GoTo extension number') : window.prompt('Your GoTo extension number');
    if (!v) return;
    try { await api('POST', '/softphone/extension', { extension: v }); S.err = ''; } catch (e) { S.err = e.message; }
    if (S.on) await turnOn(false);
    loadStatus();
  };
  window.spDisconnect = async function () {
    var ok = typeof novaConfirm === 'function' ? await novaConfirm('Disconnect your GoTo account from Nova? Calls will stop ringing here.') : window.confirm('Disconnect GoTo?');
    if (!ok) return;
    spTurnOff();
    try { await api('POST', '/softphone/disconnect', {}); } catch (e) {}
    loadStatus();
  };
  window.spTurnOn = function () { turnOn(false); };
  window.spTurnOff = function () {
    S.on = false; wantOn(false);
    clearInterval(S.regTimer); S.regTimer = null;
    drawPanel();
  };

  async function turnOn(quiet) {
    if (S.busy) return;
    S.busy = true; S.err = ''; drawPanel();
    try {
      await api('POST', '/softphone/register', {});
      S.on = true; wantOn(true);
      // Start from "now": old events are not new calls.
      try { var r = await pollOnce(0); S.after = r.length ? r[r.length - 1].id : S.after; } catch (e) {}
      loop();
      clearInterval(S.regTimer);
      // Re-register now and then so GoTo does not forget this phone.
      S.regTimer = setInterval(function () { if (S.on && !S.call) api('POST', '/softphone/register', {}).catch(function () {}); }, 25 * 60000);
    } catch (e) {
      S.on = false; S.err = e.message;
      if (!quiet && typeof showToast === 'function') showToast('Phone did not turn on: ' + e.message, 'error');
    }
    S.busy = false;
    loadStatus();
  }

  async function pollOnce(wait) {
    var res = await fetch('/api/softphone/events?after=' + S.after + '&wait=' + (wait || 0), {
      headers: state && state.token ? { Authorization: 'Bearer ' + state.token } : {} });
    if (!res.ok) throw new Error('events ' + res.status);
    var j = await res.json();
    return j.events || [];
  }
  async function loop() {
    if (S.polling) return;
    S.polling = true;
    while (S.on) {
      var evs = [];
      try { evs = await pollOnce(25000); }
      catch (e) { await new Promise(function (r) { setTimeout(r, 3000); }); continue; }
      evs.forEach(function (e) { S.after = Math.max(S.after, e.id); handle(e); });
    }
    S.polling = false;
  }

  function handle(e) {
    if (e.type === 'incoming') {
      if (S.call) return;                 // already on a call: GoTo rolls it on to voicemail / the next device
      S.ring = { id: e.call_id, name: e.name, number: e.number, at: Date.now() };
      drawRing(); ringTone(true);
      // GoTo stops offering an incoming call after ~30 s.
      setTimeout(function () { if (S.ring && S.ring.id === e.call_id) { S.ring = null; ringTone(false); drawRing(); } }, 32000);
    } else if (e.type === 'ended') {
      if (S.ring && S.ring.id === e.call_id) { S.ring = null; ringTone(false); drawRing(); }
      if (S.call && S.call.id === e.call_id) endLocal('Call ended');
    } else if (e.type === 'greetings') {
      loadStatus();
    }
  }

  // Generated ring (no audio file to ship): two short bursts every 2.5 s.
  var _ac = null, _ringT = null;
  function ringTone(on) {
    clearInterval(_ringT); _ringT = null;
    if (!on) return;
    function burst() {
      try {
        _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.35].forEach(function (off) {
          var o = _ac.createOscillator(), g = _ac.createGain();
          o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
          var t = _ac.currentTime + off;
          g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
          o.start(t); o.stop(t + 0.3);
        });
      } catch (x) {}
    }
    burst();
    _ringT = setInterval(burst, 2500);
  }

  function drawRing() {
    var box = el('sp-ring');
    if (!S.ring && !S.call) { if (box) box.parentNode.removeChild(box); drawPill(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'sp-ring'; box.setAttribute('role', 'alertdialog'); document.body.appendChild(box); }
    if (S.call) {
      box.className = 'incall';
      box.setAttribute('aria-label', 'On a call');
      box.innerHTML = '<div class="lbl">On a call</div><div class="who">' + esc(S.call.name || fmtPhone(S.call.number)) + '</div>' +
        '<div class="sub" style="font-size:13px;color:#bbb">' + esc(fmtPhone(S.call.number)) + ' &middot; <span id="sp-clock">0:00</span>' +
          (S.call.status ? ' &middot; ' + esc(S.call.status) : '') + '</div>' +
        '<div class="row"><button type="button" class="mute' + (S.muted ? ' on' : '') + '" onclick="spMute()" aria-pressed="' + S.muted + '">' + (S.muted ? 'Unmute' : 'Mute') + '</button>' +
          '<button type="button" class="hang" onclick="spHangup()">Hang up</button></div>' +
        '<button type="button" class="newc" onclick="spNewCall()">Start new call for this caller</button>';
      tick();
    } else {
      box.className = 'ringing';
      box.setAttribute('aria-label', 'Incoming call');
      box.innerHTML = '<div class="lbl">Incoming call</div><div class="who">' + esc(S.ring.name || fmtPhone(S.ring.number)) + '</div>' +
        '<div class="sub" style="font-size:13px;color:#bbb">' + esc(fmtPhone(S.ring.number)) + '</div>' +
        '<div class="row"><button type="button" class="ans" onclick="spAnswer()"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Connecting...' : 'Answer') + '</button>' +
          '<button type="button" class="vm" onclick="spReject()">Voicemail</button></div>';
      try { box.querySelector('.ans').focus(); } catch (x) {}
    }
    drawPill();
  }
  function tick() {
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      var c = el('sp-clock'); if (!c || !S.call) { clearInterval(S.timer); return; }
      var s = Math.floor((Date.now() - S.call.started) / 1000);
      c.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }, 1000);
  }

  function gathered(pc) {
    return new Promise(function (resolve) {
      if (pc.iceGatheringState === 'complete') return resolve();
      var done = false;
      function fin() { if (!done) { done = true; resolve(); } }
      pc.addEventListener('icegatheringstatechange', function () { if (pc.iceGatheringState === 'complete') fin(); });
      setTimeout(fin, 2500);   // GoTo needs the whole offer in one go; 2.5 s of candidates is plenty
    });
  }

  window.spAnswer = async function () {
    if (!S.ring || S.busy) return;
    var ring = S.ring;
    S.busy = true; ringTone(false); drawRing();
    try {
      S.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      var pc = new RTCPeerConnection({ iceServers: ICE });
      S.pc = pc;
      S.mic.getAudioTracks().forEach(function (t) { pc.addTrack(t, S.mic); });
      var audio = el('sp-audio');
      if (!audio) { audio = document.createElement('audio'); audio.id = 'sp-audio'; audio.autoplay = true; document.body.appendChild(audio); }
      pc.ontrack = function (ev) { audio.srcObject = ev.streams[0] || new MediaStream([ev.track]); };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed') endLocal('The audio connection failed.');
      };
      await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
      await gathered(pc);
      var r = await api('POST', '/softphone/answer', { call_id: ring.id, sdp: pc.localDescription.sdp });
      if (!r || !r.sdp) throw new Error('GoTo answered without audio details.');
      await pc.setRemoteDescription({ type: 'answer', sdp: r.sdp });
      S.call = { id: ring.id, name: ring.name, number: ring.number, started: Date.now(), status: r.status && r.status !== 'CONNECTING' ? r.status : '' };
      S.ring = null; S.muted = false;
    } catch (e) {
      cleanupMedia();
      S.ring = null;
      if (typeof showToast === 'function') showToast('Could not answer: ' + e.message, 'error');
      loadStatus();
    }
    S.busy = false;
    drawRing();
  };
  window.spReject = async function () {
    if (!S.ring) return;
    var id = S.ring.id;
    S.ring = null; ringTone(false); drawRing();
    try { await api('POST', '/softphone/reject', { call_id: id }); }
    catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); }
  };
  window.spHangup = async function () {
    if (!S.call) return;
    var id = S.call.id;
    endLocal('');
    try { await api('POST', '/softphone/hangup', { call_id: id }); } catch (e) {}
  };
  window.spMute = function () {
    S.muted = !S.muted;
    if (S.mic) S.mic.getAudioTracks().forEach(function (t) { t.enabled = !S.muted; });
    drawRing();
  };
  window.spNewCall = function () {
    if (!S.call) return;
    window._novaPop = { cnum: S.call.number || '', cnam: S.call.name || '', line: '' };
    if (typeof navigate === 'function') navigate('dispatch-new');
  };
  function cleanupMedia() {
    try { if (S.pc) S.pc.close(); } catch (e) {}
    try { if (S.mic) S.mic.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    S.pc = null; S.mic = null;
  }
  function endLocal(msg) {
    cleanupMedia();
    clearInterval(S.timer);
    S.call = null; S.muted = false;
    drawRing();
    if (msg && typeof showToast === 'function') showToast(msg, 'info');
  }

  // Leaving the page mid-call would leave GoTo thinking the call is up.
  window.addEventListener('beforeunload', function (e) {
    if (S.call) { e.preventDefault(); e.returnValue = ''; }
  });

  // Mount after sign-in and whenever permissions change; render() runs on both.
  var boot = setInterval(function () {
    if (typeof state === 'undefined' || !state.token || !state.user) {
      var r0 = el('sp-root'); if (r0) { S.on = false; r0.parentNode.removeChild(r0); }
      return;
    }
    mount();
  }, 2000);
  window.spState = S;
  window.spMount = mount;
  window.spHandle = handle;
})();
