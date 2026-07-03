/* Nova PTT (Radio) frontend module. Loaded after app.js; uses its globals:
   api(), state, escHtml(), showToast(), navigate(). One nav entry ('ptt').
   Styles are namespaced with .ptt- so they cannot collide with the app.
   No backticks in this file. Apostrophes in HTML strings use &#39;.

   Mental model: the client holds the LiveKit connection open (subscribed to
   everyone) and push-to-talk only toggles the OUTBOUND mic. The mic track is
   published once at join (muted), so keying up is a fast unmute, not a
   republish. The floating bar lives on document.body, outside #app, so it
   survives render() and keeps the radio usable anywhere in Nova. */
(function () {
  'use strict';

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.umd.min.js';
  var RECONNECT_DELAYS = [2000, 4000, 8000, 15000, 30000, 30000];

  var PTT = {
    room: null,            // LiveKit Room while connected
    channel: null,         // {code,name,color} of the joined channel
    channels: [],          // channels this user may join (from Nova)
    configured: true,
    connecting: false,
    talking: false,
    wantDisconnect: false, // true while a user-initiated leave is in flight
    reconnectAttempt: 0,
    reconnectTimer: null,
    opChain: Promise.resolve(), // serializes mic on/off so fast taps cannot race
    sdkPromise: null
  };

  // ---- styles (injected once) ---------------------------------------------
  function injectStyles() {
    if (document.getElementById('ptt-styles')) return;
    var css = [
      '.ptt-wrap{max-width:900px}',
      '.ptt-sub{color:var(--text-dim,#9a9a9a);font-size:13px;margin:2px 0 18px}',
      '.ptt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:18px}',
      '.ptt-chan{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:14px;cursor:pointer;user-select:none;transition:border-color .15s}',
      '.ptt-chan:hover{border-color:var(--primary,#f97316)}',
      '.ptt-chan.live{border-color:var(--primary,#f97316);box-shadow:0 0 0 1px var(--primary,#f97316)}',
      '.ptt-chan-top{display:flex;align-items:center;gap:8px}',
      '.ptt-dot{width:10px;height:10px;border-radius:50%;flex:none}',
      '.ptt-chan-name{font-weight:700;font-size:14px}',
      '.ptt-chan-code{color:var(--text-dim,#9a9a9a);font-size:11px;letter-spacing:.6px;margin-top:3px}',
      '.ptt-chip{display:inline-block;margin-left:auto;background:var(--primary,#f97316);color:#0f0f0f;font-size:10px;font-weight:800;border-radius:999px;padding:2px 8px;letter-spacing:.5px}',
      '.ptt-panel{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:18px;margin-top:4px}',
      '.ptt-status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim,#9a9a9a);margin-bottom:12px}',
      '.ptt-status .ptt-dot.ok{background:#22c55e}',
      '.ptt-status .ptt-dot.warn{background:#eab308;animation:ptt-blink 1s infinite}',
      '.ptt-people{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 18px}',
      '.ptt-person{background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600}',
      '.ptt-person.speaking{border-color:#22c55e;color:#22c55e}',
      '.ptt-talkrow{display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 0 4px}',
      '.ptt-talk{width:130px;height:130px;border-radius:50%;border:2px solid var(--primary,#f97316);background:transparent;color:var(--primary,#f97316);font-weight:800;font-size:13px;letter-spacing:.5px;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;transition:transform .08s}',
      '.ptt-talk:active{transform:scale(.97)}',
      '.ptt-talk.onair{background:var(--primary,#f97316);color:#0f0f0f;animation:ptt-pulse 1.2s infinite}',
      '.ptt-hint{color:var(--text-dim,#9a9a9a);font-size:12px}',
      '.ptt-actions{display:flex;gap:8px;justify-content:center;margin-top:14px}',
      '.ptt-notice{background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.35);border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:16px}',
      '@keyframes ptt-pulse{0%{box-shadow:0 0 0 0 rgba(249,115,22,.45)}70%{box-shadow:0 0 0 18px rgba(249,115,22,0)}100%{box-shadow:0 0 0 0 rgba(249,115,22,0)}}',
      '@keyframes ptt-blink{50%{opacity:.35}}',
      /* floating bar (body-level, survives render()) */
      '#ptt-bar{position:fixed;bottom:18px;right:18px;z-index:9000;display:none;align-items:center;gap:10px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:8px 10px 8px 14px;box-shadow:0 8px 30px rgba(0,0,0,.45)}',
      '#ptt-bar .ptt-bar-name{font-size:12px;font-weight:700;cursor:pointer;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#ptt-bar .ptt-bar-talk{width:42px;height:42px;border-radius:50%;border:2px solid var(--primary,#f97316);background:transparent;color:var(--primary,#f97316);cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center}',
      '#ptt-bar .ptt-bar-talk.onair{background:var(--primary,#f97316);color:#0f0f0f;animation:ptt-pulse 1.2s infinite}',
      '#ptt-bar .ptt-bar-x{background:none;border:none;color:var(--text-dim,#9a9a9a);cursor:pointer;font-size:15px;padding:4px}',
      '#ptt-bar .ptt-bar-x:hover{color:#ef4444}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = 'ptt-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---- LiveKit SDK lazy loader --------------------------------------------
  function loadSdk() {
    if (window.LivekitClient) return Promise.resolve();
    if (PTT.sdkPromise) return PTT.sdkPromise;
    PTT.sdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SDK_URL;
      s.onload = function () {
        if (window.LivekitClient) resolve();
        else reject(new Error('LiveKit SDK loaded but global missing'));
      };
      s.onerror = function () {
        PTT.sdkPromise = null;
        reject(new Error('Could not load the LiveKit SDK (network/CDN blocked?)'));
      };
      document.head.appendChild(s);
    });
    return PTT.sdkPromise;
  }

  // ---- hidden sink for remote audio elements ------------------------------
  function audioSink() {
    var d = document.getElementById('ptt-audio');
    if (!d) {
      d = document.createElement('div');
      d.id = 'ptt-audio';
      d.style.display = 'none';
      document.body.appendChild(d);
    }
    return d;
  }

  // ---- connection ----------------------------------------------------------
  function wireRoom(room) {
    var RE = window.LivekitClient.RoomEvent;
    room.on(RE.TrackSubscribed, function (track) {
      if (track.kind === 'audio') {
        var el = track.attach();
        audioSink().appendChild(el);
      }
      refreshLive();
    });
    room.on(RE.TrackUnsubscribed, function (track) {
      (track.detach() || []).forEach(function (el) {
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      refreshLive();
    });
    room.on(RE.ParticipantConnected, refreshLive);
    room.on(RE.ParticipantDisconnected, refreshLive);
    room.on(RE.ActiveSpeakersChanged, refreshLive);
    room.on(RE.Reconnecting, refreshLive);
    room.on(RE.Reconnected, refreshLive);
    if (RE.AudioPlaybackStatusChanged) room.on(RE.AudioPlaybackStatusChanged, refreshLive);
    room.on(RE.Disconnected, function () { handleDisconnect(room); });
  }

  async function joinChannel(code) {
    if (PTT.connecting) return;
    if (PTT.room) await leaveChannel(true);
    clearTimeout(PTT.reconnectTimer);
    PTT.reconnectTimer = null;
    PTT.connecting = true;
    PTT.wantDisconnect = false;
    refreshLive(); updateBar();
    try {
      await loadSdk();
      var data = await api('POST', '/ptt/token', { channel: code });
      var LK = window.LivekitClient;
      var room = new LK.Room({
        stopMicTrackOnMute: false, /* keep the track alive when muted -> instant re-key */
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      wireRoom(room);
      await room.connect(data.url, data.token);
      PTT.room = room;
      PTT.channel = data.channel;
      /* Pre-warm: publish the mic once (permission prompt happens here), then
         mute. After this, talking is a fast unmute rather than a republish.
         Browser will show the mic-in-use indicator for the whole session. */
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch (me) {
        showToast('Microphone unavailable: ' + (me && me.message ? me.message : me), 'error');
      }
      PTT.connecting = false;
      PTT.reconnectAttempt = 0;
      refreshLive(); updateBar();
      if (!PTT.reconnectWasAuto) showToast('Joined ' + data.channel.name + ' radio', 'success');
      PTT.reconnectWasAuto = false;
    } catch (e) {
      PTT.connecting = false;
      if (PTT.room) { try { PTT.room.disconnect(); } catch (x) {} }
      PTT.room = null;
      refreshLive(); updateBar();
      showToast('Could not join channel: ' + (e && e.message ? e.message : e), 'error');
      throw e;
    }
  }

  async function leaveChannel(silent) {
    clearTimeout(PTT.reconnectTimer);
    PTT.reconnectTimer = null;
    PTT.reconnectAttempt = 0;
    PTT.wantDisconnect = true;
    var room = PTT.room;
    var ch = PTT.channel;
    PTT.room = null;
    PTT.channel = null;
    PTT.talking = false;
    if (room) { try { await room.disconnect(); } catch (e) {} }
    refreshLive(); updateBar();
    if (!silent && ch) showToast('Left ' + ch.name + ' radio', 'success');
  }

  function handleDisconnect(room) {
    if (PTT.wantDisconnect || (PTT.room && PTT.room !== room)) return; /* expected or stale */
    PTT.room = null;
    PTT.talking = false;
    var ch = PTT.channel;
    refreshLive(); updateBar();
    if (!ch) return;
    if (PTT.reconnectAttempt >= RECONNECT_DELAYS.length) {
      PTT.channel = null;
      refreshLive(); updateBar();
      showToast('Radio disconnected and could not reconnect. Rejoin the channel manually.', 'error');
      return;
    }
    var delay = RECONNECT_DELAYS[PTT.reconnectAttempt];
    PTT.reconnectAttempt++;
    if (PTT.reconnectAttempt === 1) showToast('Radio lost connection - reconnecting...', 'error');
    PTT.reconnectTimer = setTimeout(async function () {
      if (PTT.wantDisconnect || PTT.room) return;
      PTT.reconnectWasAuto = true;
      try { await joinChannel(ch.code); }
      catch (e) { handleDisconnect(null); /* schedule next attempt */ }
    }, delay);
  }

  // ---- push-to-talk --------------------------------------------------------
  function setTalking(on) {
    if (!PTT.room || PTT.talking === on) return;
    PTT.talking = on;
    paintTalkState();
    var room = PTT.room;
    PTT.opChain = PTT.opChain.then(function () {
      if (room !== PTT.room) return; /* left/reconnected since queued */
      return room.localParticipant.setMicrophoneEnabled(on).catch(function (e) {
        if (on) {
          PTT.talking = false;
          paintTalkState();
          showToast('Mic error: ' + (e && e.message ? e.message : e), 'error');
        }
      });
    });
  }

  function paintTalkState() {
    var big = document.getElementById('ptt-talk-btn');
    if (big) {
      big.className = 'ptt-talk' + (PTT.talking ? ' onair' : '');
      big.textContent = PTT.talking ? 'ON AIR' : 'HOLD TO TALK';
    }
    var bar = document.getElementById('ptt-bar');
    if (bar) {
      var bt = bar.querySelector('.ptt-bar-talk');
      if (bt) bt.className = 'ptt-bar-talk' + (PTT.talking ? ' onair' : '');
    }
  }

  function bindHold(el) {
    if (!el || el._pttBound) return;
    el._pttBound = true;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      setTalking(true);
    });
    var up = function () { setTalking(false); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  /* Spacebar = PTT while the Radio page is open (never while typing). */
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.repeat) return;
    if (!PTT.room || !window.state || state.currentView !== 'ptt') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    setTalking(true);
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && PTT.talking) setTalking(false);
  });
  /* Stuck-transmit guards: releasing focus releases the key. */
  window.addEventListener('blur', function () { if (PTT.talking) setTalking(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && PTT.talking) setTalking(false);
  });

  // ---- floating bar (works anywhere in Nova) -------------------------------
  function ensureBar() {
    var bar = document.getElementById('ptt-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'ptt-bar';
    bar.innerHTML =
      '<span class="ptt-dot" style="background:#22c55e"></span>' +
      '<span class="ptt-bar-name" title="Open Radio"></span>' +
      '<button class="ptt-bar-talk" title="Hold to talk">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' +
      '</button>' +
      '<button class="ptt-bar-x" title="Leave channel">&#10005;</button>';
    document.body.appendChild(bar);
    bar.querySelector('.ptt-bar-name').addEventListener('click', function () {
      if (typeof navigate === 'function') navigate('ptt');
    });
    bar.querySelector('.ptt-bar-x').addEventListener('click', function () { leaveChannel(false); });
    bindHold(bar.querySelector('.ptt-bar-talk'));
    return bar;
  }

  function updateBar() {
    injectStyles();
    var bar = ensureBar();
    /* Session ended (logout) -> drop the radio. */
    if (window.state && !state.token && PTT.room) { leaveChannel(true); return; }
    var active = PTT.room || PTT.connecting || PTT.reconnectTimer;
    var onPttPage = window.state && state.currentView === 'ptt' && state.token;
    if (!active || onPttPage) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    var dot = bar.querySelector('.ptt-dot');
    dot.style.background = PTT.room ? '#22c55e' : '#eab308';
    var name = bar.querySelector('.ptt-bar-name');
    name.textContent = PTT.channel ? PTT.channel.name : 'Connecting...';
    paintTalkState();
  }

  /* Refresh the bar whenever the app navigates. navigate() is a global
     function declaration in app.js (loaded before this file), so wrapping the
     window property intercepts every sidebar click. */
  function wrapNavigate() {
    if (typeof window.navigate !== 'function' || window.navigate._pttWrapped) return;
    var orig = window.navigate;
    var wrapped = function (view, param) {
      var r = orig(view, param);
      try { updateBar(); } catch (e) {}
      return r;
    };
    wrapped._pttWrapped = true;
    window.navigate = wrapped;
  }

  // ---- page ----------------------------------------------------------------
  window.renderPTT = async function (content) {
    injectStyles();
    wrapNavigate();
    ensureBar();
    content.innerHTML = '<div class="ptt-wrap"><h1>Radio</h1><div class="ptt-sub">Loading channels...</div></div>';
    var data;
    try {
      data = await api('GET', '/ptt/channels');
    } catch (e) {
      content.innerHTML = '<div class="ptt-wrap"><h1>Radio</h1><div class="ptt-notice">Could not load channels: ' + escHtml((e && e.message) ? e.message : String(e)) + '</div></div>';
      return;
    }
    PTT.channels = data.channels || [];
    PTT.configured = !!data.configured;
    if (state.currentView !== 'ptt') return; /* user navigated away mid-fetch */

    var h = '<div class="ptt-wrap"><h1>Radio</h1>' +
      '<div class="ptt-sub">Push-to-talk. Join a channel, then hold the button or hold <b>Space</b> to transmit. The radio keeps running while you work elsewhere in Nova - use the floating mic at the bottom right.</div>';
    if (!PTT.configured) {
      h += '<div class="ptt-notice"><b>Not configured yet.</b> Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in Railway to turn the radio on. Channels are shown below for preview.</div>';
    }
    h += '<div class="ptt-grid" id="ptt-grid"></div>' +
      '<div id="ptt-live"></div>' +
      '</div>';
    content.innerHTML = h;
    drawChannels();
    refreshLive();
    updateBar(); /* hides the bar while on this page */
  };

  function drawChannels() {
    var grid = document.getElementById('ptt-grid');
    if (!grid) return;
    var h = '';
    for (var i = 0; i < PTT.channels.length; i++) {
      var c = PTT.channels[i];
      var live = PTT.channel && PTT.channel.code === c.code;
      h += '<div class="ptt-chan' + (live ? ' live' : '') + '" onclick="' + (live ? 'pttLeave()' : 'pttJoin(\'' + escHtml(c.code) + '\')') + '">' +
        '<div class="ptt-chan-top"><span class="ptt-dot" style="background:' + escHtml(c.color || '#f97316') + '"></span>' +
        '<span class="ptt-chan-name">' + escHtml(c.name) + '</span>' +
        (live ? '<span class="ptt-chip">LIVE</span>' : '') +
        '</div><div class="ptt-chan-code">' + escHtml(c.code) + (live ? ' &middot; click to leave' : ' &middot; click to join') + '</div></div>';
    }
    if (!PTT.channels.length) h = '<div class="ptt-sub">No channels available for your account.</div>';
    grid.innerHTML = h;
  }

  function participantHtml() {
    var room = PTT.room;
    if (!room) return '';
    var items = [];
    var lp = room.localParticipant;
    items.push({ name: (lp.name || (window.state && state.user ? state.user.name : 'Me')) + ' (you)', speaking: !!lp.isSpeaking });
    room.remoteParticipants.forEach(function (p) {
      items.push({ name: p.name || ('User ' + p.identity), speaking: !!p.isSpeaking });
    });
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<span class="ptt-person' + (items[i].speaking ? ' speaking' : '') + '">' + escHtml(items[i].name) + '</span>';
    }
    var alone = items.length === 1 ? '<div class="ptt-hint" style="margin-top:2px">Nobody else is on this channel right now.</div>' : '';
    return '<div class="ptt-people">' + h + '</div>' + alone;
  }

  /* Re-draws the live panel on the Radio page (no-op elsewhere). */
  function refreshLive() {
    paintTalkState();
    var el = document.getElementById('ptt-live');
    if (!el || !window.state || state.currentView !== 'ptt') return;
    drawChannels(); /* keep LIVE chip in sync */
    if (!PTT.room && !PTT.connecting && !PTT.reconnectTimer) { el.innerHTML = ''; return; }
    if (PTT.connecting || !PTT.room) {
      el.innerHTML = '<div class="ptt-panel"><div class="ptt-status"><span class="ptt-dot warn"></span> ' +
        (PTT.connecting ? 'Connecting' : 'Reconnecting') + (PTT.channel ? ' to ' + escHtml(PTT.channel.name) : '') + '...</div></div>';
      return;
    }
    var room = PTT.room;
    var reconnState = (room.state === 'reconnecting');
    var audioBlocked = (room.canPlaybackAudio === false);
    el.innerHTML =
      '<div class="ptt-panel">' +
        '<div class="ptt-status"><span class="ptt-dot ' + (reconnState ? 'warn' : 'ok') + '"></span> ' +
          (reconnState ? 'Reconnecting to ' : 'Live on ') + '<b>&nbsp;' + escHtml(PTT.channel ? PTT.channel.name : '') + '</b></div>' +
        participantHtml() +
        '<div class="ptt-talkrow">' +
          '<button id="ptt-talk-btn" class="ptt-talk">HOLD TO TALK</button>' +
          '<div class="ptt-hint">Hold the button or hold Space. Release to listen.</div>' +
        '</div>' +
        (audioBlocked ? '<div class="ptt-actions"><button class="btn btn-primary" onclick="pttEnableAudio()">Enable incoming audio</button></div>' : '') +
        '<div class="ptt-actions"><button class="btn" onclick="pttLeave()">Leave channel</button></div>' +
      '</div>';
    bindHold(document.getElementById('ptt-talk-btn'));
    paintTalkState();
  }

  // ---- inline onclick handlers --------------------------------------------
  window.pttJoin = function (code) {
    joinChannel(code).catch(function () {});
  };
  window.pttLeave = function () {
    leaveChannel(false);
  };
  window.pttEnableAudio = function () {
    if (PTT.room && PTT.room.startAudio) PTT.room.startAudio().then(refreshLive).catch(function () {});
  };
})();
