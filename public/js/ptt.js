/* Nova PTT (Radio) frontend module. Loaded after app.js; uses its globals:
   api(), state, can(), escHtml(), showToast(), navigate(). View: 'ptt'.
   Styles are namespaced with .ptt- so they cannot collide with the app.
   No backticks in this file. Apostrophes in HTML strings use &#39;.

   Model: one TALK connection (publish + subscribe; PTT toggles the outbound
   mic, which is published once at join then muted, so keying is an instant
   unmute) plus any number of MONITOR connections (scan mode: listen-only
   tokens minted by Nova with canPublish:false, audio mixes together).
   While keyed up, the client records its own mic (MediaRecorder) and uploads
   the clip to R2 via presigned URL for the Radio Log.
   The floating bar lives on document.body, outside #app, so it survives
   render() and keeps the radio usable anywhere in Nova. */
(function () {
  'use strict';

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.umd.min.js';
  var TALK_RETRY = [2000, 4000, 8000, 15000, 30000, 30000];
  var MON_RETRY = [3000, 8000, 20000];
  var MIN_CLIP_MS = 400;

  var PTT = {
    channels: [],
    configured: true,
    canRecord: false,
    talk: null,            // {room, channel, audioEls}
    monitors: {},          // code -> {room, channel, audioEls, attempt, timer}
    connecting: false,
    talking: false,
    wantDisconnect: false,
    reconnectAttempt: 0,
    reconnectTimer: null,
    reconnectWasAuto: false,
    opChain: Promise.resolve(),
    sdkPromise: null,
    rec: null,             // in-flight MediaRecorder session
    playingId: null,
    logChan: '',
    logDate: ''
  };

  // ---- styles --------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('ptt-styles')) return;
    var css = [
      '.ptt-wrap{max-width:960px}',
      '.ptt-sub{color:var(--text-dim,#9a9a9a);font-size:13px;margin:2px 0 18px}',
      '.ptt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px;margin-bottom:18px}',
      '.ptt-chan{position:relative;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:14px;cursor:pointer;user-select:none;transition:border-color .15s}',
      '.ptt-chan:hover{border-color:var(--primary,#f97316)}',
      '.ptt-chan.live{border-color:var(--primary,#f97316);box-shadow:0 0 0 1px var(--primary,#f97316)}',
      '.ptt-chan.mon{border-color:#22c55e}',
      '.ptt-chan-top{display:flex;align-items:center;gap:8px}',
      '.ptt-dot{width:10px;height:10px;border-radius:50%;flex:none}',
      '.ptt-chan-name{font-weight:700;font-size:14px}',
      '.ptt-chan-code{color:var(--text-dim,#9a9a9a);font-size:11px;letter-spacing:.6px;margin-top:3px}',
      '.ptt-chip{display:inline-block;margin-left:auto;background:var(--primary,#f97316);color:#0f0f0f;font-size:10px;font-weight:800;border-radius:999px;padding:2px 8px;letter-spacing:.5px}',
      '.ptt-chip.g{background:#22c55e}',
      '.ptt-mon-btn{position:absolute;bottom:10px;right:10px;background:none;border:1px solid var(--border,#2a2a2a);border-radius:999px;color:var(--text-dim,#9a9a9a);font-size:11px;font-weight:700;padding:3px 10px;cursor:pointer}',
      '.ptt-mon-btn:hover{border-color:#22c55e;color:#22c55e}',
      '.ptt-mon-btn.on{background:#22c55e;border-color:#22c55e;color:#0f0f0f}',
      '.ptt-speak{position:absolute;top:10px;right:10px;width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;display:none}',
      '.ptt-chan.speaking .ptt-speak{display:block}',
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
      '.ptt-log{margin-top:18px}',
      '.ptt-log-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}',
      '.ptt-log-head h3{margin:0;font-size:16px;flex:1}',
      '.ptt-log-head select,.ptt-log-head input{width:auto;padding:6px 10px;font-size:13px;margin:0}',
      '.ptt-log-list{display:flex;flex-direction:column;gap:6px}',
      '.ptt-rec{display:flex;align-items:center;gap:10px;background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:8px 12px;font-size:13px}',
      '.ptt-rec .t{color:var(--text-dim,#9a9a9a);font-size:12px;min-width:118px}',
      '.ptt-rec .c{font-size:10px;font-weight:800;letter-spacing:.5px;border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:2px 8px}',
      '.ptt-rec .n{flex:1;font-weight:600}',
      '.ptt-rec .d{color:var(--text-dim,#9a9a9a);font-size:12px}',
      '.ptt-play{background:none;border:1px solid var(--primary,#f97316);color:var(--primary,#f97316);border-radius:999px;width:30px;height:30px;cursor:pointer;font-size:12px;flex:none}',
      '.ptt-play.playing{background:var(--primary,#f97316);color:#0f0f0f}',
      '@keyframes ptt-pulse{0%{box-shadow:0 0 0 0 rgba(249,115,22,.45)}70%{box-shadow:0 0 0 18px rgba(249,115,22,0)}100%{box-shadow:0 0 0 0 rgba(249,115,22,0)}}',
      '@keyframes ptt-blink{50%{opacity:.35}}',
      '#ptt-bar{position:fixed;bottom:18px;right:18px;z-index:9000;display:none;align-items:center;gap:10px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:8px 10px 8px 14px;box-shadow:0 8px 30px rgba(0,0,0,.45)}',
      '#ptt-bar .ptt-bar-name{font-size:12px;font-weight:700;cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#ptt-bar .ptt-bar-talk{width:42px;height:42px;border-radius:50%;border:2px solid var(--primary,#f97316);background:transparent;color:var(--primary,#f97316);cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center}',
      '#ptt-bar .ptt-bar-talk.onair{background:var(--primary,#f97316);color:#0f0f0f;animation:ptt-pulse 1.2s infinite}',
      '#ptt-bar .ptt-bar-talk.off{border-color:var(--border,#2a2a2a);color:var(--border,#2a2a2a);cursor:default}',
      '#ptt-bar .ptt-bar-x{background:none;border:none;color:var(--text-dim,#9a9a9a);cursor:pointer;font-size:15px;padding:4px}',
      '#ptt-bar .ptt-bar-x:hover{color:#ef4444}'
    ].join('\n');
    var el = document.createElement('style');
    el.id = 'ptt-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ---- SDK / audio sink ----------------------------------------------------
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

  // ---- shared room wiring ---------------------------------------------------
  function wireRoom(handle) {
    var RE = window.LivekitClient.RoomEvent;
    var room = handle.room;
    room.on(RE.TrackSubscribed, function (track) {
      if (track.kind === 'audio') {
        var el = track.attach();
        handle.audioEls.push(el);
        audioSink().appendChild(el);
      }
      refreshLive();
    });
    room.on(RE.TrackUnsubscribed, function (track) {
      (track.detach() || []).forEach(function (el) {
        var i = handle.audioEls.indexOf(el);
        if (i !== -1) handle.audioEls.splice(i, 1);
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
    room.on(RE.Disconnected, function () {
      if (handle.kind === 'talk') handleTalkDisconnect(handle);
      else handleMonitorDisconnect(handle);
    });
  }

  function killAudio(handle) {
    (handle.audioEls || []).forEach(function (el) {
      try { el.pause(); } catch (e) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    handle.audioEls = [];
  }

  // ---- TALK connection -------------------------------------------------------
  async function joinTalk(code) {
    if (PTT.connecting) return;
    if (PTT.monitors[code]) stopMonitor(code, true); /* cannot hold both: same identity */
    var prevTalk = PTT.talk ? PTT.talk.channel.code : null;
    if (PTT.talk) await leaveTalk(true);
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
        stopMicTrackOnMute: false,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      var handle = { kind: 'talk', room: room, channel: data.channel, audioEls: [] };
      wireRoom(handle);
      await room.connect(data.url, data.token);
      PTT.talk = handle;
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch (me) {
        showToast('Microphone unavailable: ' + (me && me.message ? me.message : me), 'error');
      }
      PTT.connecting = false;
      PTT.reconnectAttempt = 0;
      refreshLive(); updateBar();
      if (!PTT.reconnectWasAuto) showToast('Live on ' + data.channel.name, 'success');
      PTT.reconnectWasAuto = false;
      /* Zello-style: keep hearing the channel you just switched away from. */
      if (prevTalk && prevTalk !== code && !PTT.monitors[prevTalk]) {
        startMonitor(prevTalk, true).catch(function () {});
      }
    } catch (e) {
      PTT.connecting = false;
      if (PTT.talk) { killAudio(PTT.talk); try { PTT.talk.room.disconnect(); } catch (x) {} }
      PTT.talk = null;
      refreshLive(); updateBar();
      showToast('Could not join channel: ' + (e && e.message ? e.message : e), 'error');
      throw e;
    }
  }

  async function leaveTalk(silent) {
    clearTimeout(PTT.reconnectTimer);
    PTT.reconnectTimer = null;
    PTT.reconnectAttempt = 0;
    PTT.wantDisconnect = true;
    var handle = PTT.talk;
    PTT.talk = null;
    PTT.talking = false;
    if (handle) {
      killAudio(handle);
      try { await handle.room.disconnect(); } catch (e) {}
      if (!silent) showToast('Left ' + handle.channel.name, 'success');
    }
    refreshLive(); updateBar();
  }

  function handleTalkDisconnect(handle) {
    if (PTT.wantDisconnect || PTT.talk !== handle) return;
    killAudio(handle);
    var ch = handle.channel;
    PTT.talk = null;
    PTT.talking = false;
    refreshLive(); updateBar();
    if (PTT.reconnectAttempt >= TALK_RETRY.length) {
      refreshLive(); updateBar();
      showToast('Radio disconnected and could not reconnect. Rejoin the channel manually.', 'error');
      return;
    }
    var delay = TALK_RETRY[PTT.reconnectAttempt];
    PTT.reconnectAttempt++;
    if (PTT.reconnectAttempt === 1) showToast('Radio lost connection - reconnecting...', 'error');
    PTT.reconnectTimer = setTimeout(async function () {
      if (PTT.wantDisconnect || PTT.talk) return;
      PTT.reconnectWasAuto = true;
      try { await joinTalk(ch.code); }
      catch (e) { handleTalkDisconnect(handle); }
    }, delay);
  }

  // ---- MONITOR connections (scan mode) ---------------------------------------
  async function startMonitor(code, isRetry) {
    if (PTT.monitors[code]) return;
    if (PTT.talk && PTT.talk.channel.code === code) { showToast('You are already live on that channel.', 'error'); return; }
    try {
      await loadSdk();
      var data = await api('POST', '/ptt/token', { channel: code, listen: true });
      var LK = window.LivekitClient;
      var room = new LK.Room({});
      var handle = { kind: 'monitor', room: room, channel: data.channel, audioEls: [], attempt: 0, timer: null };
      PTT.monitors[code] = handle;
      wireRoom(handle);
      await room.connect(data.url, data.token);
      handle.attempt = 0;
      refreshLive(); updateBar();
      if (!isRetry) showToast('Listening to ' + data.channel.name, 'success');
    } catch (e) {
      delete PTT.monitors[code];
      refreshLive(); updateBar();
      if (!isRetry) showToast('Could not monitor channel: ' + (e && e.message ? e.message : e), 'error');
      throw e;
    }
  }

  function stopMonitor(code, silent) {
    var handle = PTT.monitors[code];
    if (!handle) return;
    delete PTT.monitors[code];
    handle.stopped = true;
    clearTimeout(handle.timer);
    killAudio(handle);
    try { handle.room.disconnect(); } catch (e) {}
    refreshLive(); updateBar();
    if (!silent) showToast('Stopped listening to ' + handle.channel.name, 'success');
  }

  function handleMonitorDisconnect(handle) {
    if (handle.stopped || PTT.monitors[handle.channel.code] !== handle) return;
    killAudio(handle);
    delete PTT.monitors[handle.channel.code];
    refreshLive(); updateBar();
    if (handle.attempt >= MON_RETRY.length) {
      showToast('Lost listener on ' + handle.channel.name + ' - gave up reconnecting.', 'error');
      return;
    }
    var delay = MON_RETRY[handle.attempt];
    handle.attempt++;
    setTimeout(async function () {
      if (PTT.monitors[handle.channel.code] || (PTT.talk && PTT.talk.channel.code === handle.channel.code)) return;
      try {
        await startMonitor(handle.channel.code, true);
        if (PTT.monitors[handle.channel.code]) PTT.monitors[handle.channel.code].attempt = handle.attempt;
      } catch (e) { handleMonitorDisconnect(handle); }
    }, delay);
  }

  function monitorCount() {
    var n = 0, k;
    for (k in PTT.monitors) if (PTT.monitors.hasOwnProperty(k)) n++;
    return n;
  }

  async function leaveAll(silent) {
    var k, codes = [];
    for (k in PTT.monitors) if (PTT.monitors.hasOwnProperty(k)) codes.push(k);
    codes.forEach(function (c) { stopMonitor(c, true); });
    await leaveTalk(silent);
  }

  // ---- push-to-talk + recording ----------------------------------------------
  function pickMime() {
    if (!window.MediaRecorder) return null;
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
    return null;
  }

  function startRec(handle) {
    if (!PTT.canRecord || !window.MediaRecorder) return;
    try {
      var LK = window.LivekitClient;
      var pub = handle.room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
      var mst = pub && pub.track && pub.track.mediaStreamTrack;
      if (!mst) return;
      var mime = pickMime();
      var mr = new MediaRecorder(new MediaStream([mst]), mime ? { mimeType: mime } : undefined);
      var sess = { mr: mr, chunks: [], startedAt: new Date(), channel: handle.channel.code, mime: mr.mimeType || mime || 'audio/webm' };
      mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) sess.chunks.push(ev.data); };
      mr.start();
      PTT.rec = sess;
    } catch (e) { PTT.rec = null; }
  }

  function stopRec() {
    var sess = PTT.rec;
    PTT.rec = null;
    if (!sess) return;
    var durationMs = Date.now() - sess.startedAt.getTime();
    try {
      sess.mr.onstop = function () {
        if (durationMs < MIN_CLIP_MS) return;
        var blob = new Blob(sess.chunks, { type: sess.mime });
        if (blob.size < 1000) return;
        uploadClip(blob, sess);
      };
      sess.mr.stop();
    } catch (e) {}
    function uploadClip(blob, s) {
      api('POST', '/ptt/recordings/presign', { channel: s.channel, mime: s.mime })
        .then(function (p) {
          return fetch(p.url, { method: 'PUT', headers: { 'Content-Type': s.mime }, body: blob })
            .then(function (r) {
              if (!r.ok) throw new Error('upload failed ' + r.status);
              return api('POST', '/ptt/recordings', {
                key: p.key, channel: s.channel, mime: s.mime,
                started_at: s.startedAt.toISOString(),
                duration_ms: Date.now() - s.startedAt.getTime()
              });
            });
        })
        .then(function () { if (window.state && state.currentView === 'ptt') pttLoadLog(); })
        .catch(function (e) { try { console.warn('PTT clip upload failed:', e); } catch (x) {} });
    }
  }

  function setTalking(on) {
    if (!PTT.talk || PTT.talking === on) return;
    if (on && PTT.connecting) return;
    PTT.talking = on;
    paintTalkState();
    var handle = PTT.talk;
    PTT.opChain = PTT.opChain.then(function () {
      if (handle !== PTT.talk) return;
      return handle.room.localParticipant.setMicrophoneEnabled(on).then(function () {
        if (handle !== PTT.talk) return;
        if (on) startRec(handle);
        else stopRec();
      }).catch(function (e) {
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
      if (bt) bt.className = 'ptt-bar-talk' + (PTT.talking ? ' onair' : '') + (PTT.talk ? '' : ' off');
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

  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' || e.repeat) return;
    if (!PTT.talk || !window.state || state.currentView !== 'ptt') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    setTalking(true);
  });
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && PTT.talking) setTalking(false);
  });
  window.addEventListener('blur', function () { if (PTT.talking) setTalking(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && PTT.talking) setTalking(false);
  });

  // ---- floating bar -----------------------------------------------------------
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
      '<button class="ptt-bar-x" title="Radio off (leave talk + monitors)">&#10005;</button>';
    document.body.appendChild(bar);
    bar.querySelector('.ptt-bar-name').addEventListener('click', function () {
      if (typeof navigate === 'function') navigate('ptt');
    });
    bar.querySelector('.ptt-bar-x').addEventListener('click', function () { leaveAll(false); });
    bindHold(bar.querySelector('.ptt-bar-talk'));
    return bar;
  }

  function updateBar() {
    injectStyles();
    var bar = ensureBar();
    if (window.state && !state.token && (PTT.talk || monitorCount())) { leaveAll(true); return; }
    var active = PTT.talk || PTT.connecting || PTT.reconnectTimer || monitorCount() > 0;
    var onPttPage = window.state && state.currentView === 'ptt' && state.token;
    if (!active || onPttPage) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    var dot = bar.querySelector('.ptt-dot');
    dot.style.background = (PTT.talk || monitorCount()) ? '#22c55e' : '#eab308';
    var name = bar.querySelector('.ptt-bar-name');
    var label = PTT.talk ? PTT.talk.channel.name : (PTT.connecting || PTT.reconnectTimer ? 'Connecting...' : 'Listening');
    var mc = monitorCount();
    if (mc) label += ' +' + mc;
    name.textContent = label;
    paintTalkState();
  }

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

  // ---- page --------------------------------------------------------------------
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
    PTT.canRecord = !!data.recording;
    if (state.currentView !== 'ptt') return;

    var h = '<div class="ptt-wrap"><h1>Radio</h1>' +
      '<div class="ptt-sub">Click a channel to make it your <b>talk</b> channel (hold the button or hold <b>Space</b> to transmit). Use <b>Listen</b> to hear other channels at the same time. Switching talk channels keeps the old one listening, Zello-style. The radio keeps running while you work elsewhere in Nova via the floating mic at the bottom right.' +
      (PTT.canRecord ? ' Transmissions are recorded to the Radio Log below.' : '') + '</div>';
    if (!PTT.configured) {
      h += '<div class="ptt-notice"><b>Not configured yet.</b> Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in Railway to turn the radio on. Channels are shown below for preview.</div>';
    }
    h += '<div class="ptt-grid" id="ptt-grid"></div>' +
      '<div id="ptt-live"></div>';
    h += '<div class="ptt-log" id="ptt-log">' +
        '<div class="ptt-log-head"><h3>Radio Log</h3>' +
          '<select id="ptt-log-chan" onchange="pttLogFilter()"><option value="">All channels</option></select>' +
          '<input type="date" id="ptt-log-date" onchange="pttLogFilter()" />' +
          '<button class="btn" onclick="pttLoadLog()" style="padding:6px 12px;font-size:13px">Refresh</button>' +
        '</div>' +
        '<div class="ptt-log-list" id="ptt-log-list"><div class="ptt-hint">' +
          (PTT.canRecord ? 'Loading...' : 'Recording is off - set the R2_* variables (already used by the Document Vault) to store transmissions.') +
        '</div></div>' +
      '</div>';
    h += '</div>';
    content.innerHTML = h;
    var sel = document.getElementById('ptt-log-chan');
    PTT.channels.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.code; o.textContent = c.name;
      if (PTT.logChan === c.code) o.selected = true;
      sel.appendChild(o);
    });
    if (PTT.logDate) document.getElementById('ptt-log-date').value = PTT.logDate;
    drawChannels();
    refreshLive();
    updateBar();
    pttLoadLog();
  };

  function chanSpeaking(code) {
    var h = (PTT.talk && PTT.talk.channel.code === code) ? PTT.talk : PTT.monitors[code];
    if (!h || !h.room) return false;
    var s = false;
    try {
      h.room.remoteParticipants.forEach(function (p) { if (p.isSpeaking) s = true; });
      if (h.room.localParticipant && h.room.localParticipant.isSpeaking) s = true;
    } catch (e) {}
    return s;
  }

  function drawChannels() {
    var grid = document.getElementById('ptt-grid');
    if (!grid) return;
    var h = '';
    for (var i = 0; i < PTT.channels.length; i++) {
      var c = PTT.channels[i];
      var live = PTT.talk && PTT.talk.channel.code === c.code;
      var mon = !!PTT.monitors[c.code];
      var cls = 'ptt-chan' + (live ? ' live' : '') + (mon ? ' mon' : '') + (chanSpeaking(c.code) ? ' speaking' : '');
      h += '<div class="' + cls + '" data-chan="' + escHtml(c.code) + '" onclick="' + (live ? 'pttLeave()' : 'pttJoin(\'' + escHtml(c.code) + '\')') + '">' +
        '<span class="ptt-speak"></span>' +
        '<div class="ptt-chan-top"><span class="ptt-dot" style="background:' + escHtml(c.color || '#f97316') + '"></span>' +
        '<span class="ptt-chan-name">' + escHtml(c.name) + '</span>' +
        (live ? '<span class="ptt-chip">LIVE</span>' : (mon ? '<span class="ptt-chip g">LISTENING</span>' : '')) +
        '</div><div class="ptt-chan-code">' + escHtml(c.code) + (live ? ' &middot; click to leave' : ' &middot; click to go live') + '</div>' +
        (live ? '' : '<button class="ptt-mon-btn' + (mon ? ' on' : '') + '" onclick="event.stopPropagation();pttMonitor(\'' + escHtml(c.code) + '\')">' + (mon ? 'Listening' : 'Listen') + '</button>') +
        '</div>';
    }
    if (!PTT.channels.length) h = '<div class="ptt-sub">No channels available for your account.</div>';
    grid.innerHTML = h;
  }

  function participantHtml() {
    var handle = PTT.talk;
    if (!handle) return '';
    var room = handle.room;
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

  function refreshLive() {
    paintTalkState();
    var el = document.getElementById('ptt-live');
    if (!el || !window.state || state.currentView !== 'ptt') return;
    drawChannels();
    if (!PTT.talk && !PTT.connecting && !PTT.reconnectTimer) { el.innerHTML = ''; return; }
    if (PTT.connecting || !PTT.talk) {
      el.innerHTML = '<div class="ptt-panel"><div class="ptt-status"><span class="ptt-dot warn"></span> ' +
        (PTT.connecting ? 'Connecting...' : 'Reconnecting...') + '</div></div>';
      return;
    }
    var room = PTT.talk.room;
    var reconnState = (room.state === 'reconnecting');
    var audioBlocked = (room.canPlaybackAudio === false);
    el.innerHTML =
      '<div class="ptt-panel">' +
        '<div class="ptt-status"><span class="ptt-dot ' + (reconnState ? 'warn' : 'ok') + '"></span> ' +
          (reconnState ? 'Reconnecting to ' : 'Live on ') + '<b>&nbsp;' + escHtml(PTT.talk.channel.name) + '</b></div>' +
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

  // ---- Radio Log -----------------------------------------------------------------
  function fmtDur(ms) {
    var s = Math.max(1, Math.round((ms || 0) / 1000));
    var m = Math.floor(s / 60);
    return m ? (m + 'm ' + (s % 60) + 's') : (s + 's');
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    } catch (e) { return String(iso); }
  }

  window.pttLoadLog = async function () {
    var list = document.getElementById('ptt-log-list');
    if (!list || !PTT.canRecord) return;
    var q = [];
    if (PTT.logChan) q.push('channel=' + encodeURIComponent(PTT.logChan));
    if (PTT.logDate) q.push('date=' + encodeURIComponent(PTT.logDate));
    var data;
    try {
      data = await api('GET', '/ptt/recordings' + (q.length ? '?' + q.join('&') : ''));
    } catch (e) {
      list.innerHTML = '<div class="ptt-hint">Could not load the log: ' + escHtml((e && e.message) ? e.message : String(e)) + '</div>';
      return;
    }
    var rows = (data && data.recordings) || [];
    if (!rows.length) { list.innerHTML = '<div class="ptt-hint">No transmissions logged' + (PTT.logDate ? ' for that day' : ' yet') + '.</div>'; return; }
    var h = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<div class="ptt-rec" id="ptt-rec-' + r.id + '">' +
        '<button class="ptt-play" onclick="pttPlay(' + r.id + ')" title="Play">&#9654;</button>' +
        '<span class="t">' + escHtml(fmtTime(r.started_at)) + '</span>' +
        '<span class="c">' + escHtml(r.channel_code) + '</span>' +
        '<span class="n">' + escHtml(r.user_name || ('User ' + r.user_id)) + '</span>' +
        '<span class="d">' + escHtml(fmtDur(r.duration_ms)) + '</span>' +
      '</div>';
    }
    list.innerHTML = h;
  };

  window.pttLogFilter = function () {
    var sel = document.getElementById('ptt-log-chan');
    var dt = document.getElementById('ptt-log-date');
    PTT.logChan = sel ? sel.value : '';
    PTT.logDate = dt ? dt.value : '';
    pttLoadLog();
  };

  var _player = null;
  window.pttPlay = async function (id) {
    if (!_player) { _player = document.createElement('audio'); _player.style.display = 'none'; document.body.appendChild(_player); }
    var mark = function (pid, on) {
      var row = document.getElementById('ptt-rec-' + pid);
      if (row) {
        var b = row.querySelector('.ptt-play');
        if (b) { b.className = 'ptt-play' + (on ? ' playing' : ''); b.innerHTML = on ? '&#9632;' : '&#9654;'; }
      }
    };
    if (PTT.playingId === id) {
      try { _player.pause(); } catch (e) {}
      mark(id, false); PTT.playingId = null; return;
    }
    if (PTT.playingId) { mark(PTT.playingId, false); }
    try {
      var d = await api('GET', '/ptt/recordings/' + id + '/url');
      PTT.playingId = id;
      mark(id, true);
      _player.src = d.url;
      _player.onended = function () { mark(id, false); if (PTT.playingId === id) PTT.playingId = null; };
      await _player.play();
    } catch (e) {
      mark(id, false); PTT.playingId = null;
      showToast('Could not play recording: ' + (e && e.message ? e.message : e), 'error');
    }
  };

  // ---- inline handlers --------------------------------------------------------
  window.pttJoin = function (code) { joinTalk(code).catch(function () {}); };
  window.pttLeave = function () { leaveTalk(false); };
  window.pttMonitor = function (code) {
    if (PTT.monitors[code]) stopMonitor(code, false);
    else startMonitor(code, false).catch(function () {});
  };
  window.pttEnableAudio = function () {
    if (PTT.talk && PTT.talk.room.startAudio) PTT.talk.room.startAudio().then(refreshLive).catch(function () {});
    var k;
    for (k in PTT.monitors) {
      if (PTT.monitors.hasOwnProperty(k) && PTT.monitors[k].room.startAudio) {
        PTT.monitors[k].room.startAudio().catch(function () {});
      }
    }
  };
})();
