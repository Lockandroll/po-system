/* Nova PTT (Radio) frontend module - Zello-style UI. Loaded after app.js;
   uses its globals: api(), state, escHtml(), showToast(), navigate().
   Styles namespaced .ptt-. No backticks. Apostrophes in HTML use &#39;.

   Layout mirrors Zello: three tabs (Recents / Channels / People) showing one
   list at a time, and a focused Talk screen when you tap an item - big PTT
   button, who is here, and that item's own history. Connections: one TALK
   room (mic published once at join, muted; keying = instant unmute), any
   number of LISTEN rooms (scan), a personal-inbox room while the radio is on,
   and warm DM rooms into other people's inboxes. Keyed audio is recorded
   client-side and uploaded to R2 for the log. */
(function () {
  'use strict';
  try {

  var SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2.19.2/dist/livekit-client.umd.min.js';
  var TALK_RETRY = [2000, 4000, 8000, 15000, 30000, 30000];
  var MON_RETRY = [3000, 8000, 20000];
  var MIN_CLIP_MS = 400;

  var PTT = {
    channels: [], configured: true, canRecord: false,
    talk: null, monitors: {}, connecting: false, talking: false,
    wantDisconnect: false, reconnectAttempt: 0, reconnectTimer: null, reconnectWasAuto: false,
    opChain: Promise.resolve(), sdkPromise: null,
    rec: null, playingId: null,
    inbox: null, dms: {}, dmHold: 0, people: [], canDirect: false,
    logRows: [], newCount: 0, pollTimer: null,
    tab: 'channels', sel: null, // {type:'channel',code} | {type:'person',id,name,online}
    dragging: false
  };

  // ---- styles --------------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('ptt-styles')) return;
    var css = [
      '.ptt-wrap{max-width:560px}',
      '.ptt-sub{color:var(--text-dim,#9a9a9a);font-size:13px;margin:2px 0 14px}',
      '.ptt-tabs{display:flex;gap:6px;margin-bottom:12px}',
      '.ptt-tab{flex:1;text-align:center;padding:9px 0;border-radius:999px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);color:var(--text-dim,#9a9a9a);cursor:pointer;font-weight:700;font-size:13px;user-select:none;position:relative}',
      '.ptt-tab:hover{color:var(--text,#ededed)}',
      '.ptt-tab.active{background:var(--primary,#f97316);color:#0f0f0f;border-color:var(--primary,#f97316)}',
      '.ptt-badge{display:inline-block;min-width:17px;text-align:center;background:var(--primary,#f97316);color:#0f0f0f;font-size:10px;font-weight:800;border-radius:999px;padding:2px 5px;margin-left:6px;vertical-align:1px}',
      '.ptt-tab.active .ptt-badge{background:#0f0f0f;color:var(--primary,#f97316)}',
      '.ptt-list{display:flex;flex-direction:column;gap:6px}',
      '.ptt-row{display:flex;align-items:center;gap:10px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:12px;padding:11px 13px;cursor:pointer;user-select:none;font-size:14px;transition:border-color .12s}',
      '.ptt-row:hover{border-color:var(--primary,#f97316)}',
      '.ptt-row.live{border-color:var(--primary,#f97316);box-shadow:0 0 0 1px var(--primary,#f97316)}',
      '.ptt-row.mon{border-color:#22c55e}',
      '.ptt-dot{width:10px;height:10px;border-radius:50%;flex:none}',
      '.ptt-row .nm{flex:1;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ptt-row .sub{color:var(--text-dim,#9a9a9a);font-size:11px;font-weight:400;display:block;margin-top:1px}',
      '.ptt-row .spk{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;flex:none;display:none}',
      '.ptt-row.speaking .spk{display:block}',
      '.ptt-chip{background:var(--primary,#f97316);color:#0f0f0f;font-size:10px;font-weight:800;border-radius:999px;padding:2px 8px;letter-spacing:.5px;flex:none}',
      '.ptt-listen{background:none;border:1px solid var(--border,#2a2a2a);border-radius:999px;color:var(--text-dim,#9a9a9a);font-size:11px;font-weight:700;padding:4px 11px;cursor:pointer;flex:none}',
      '.ptt-listen:hover{border-color:#22c55e;color:#22c55e}',
      '.ptt-listen.on{background:#22c55e;border-color:#22c55e;color:#0f0f0f}',
      '.ptt-pdot{width:9px;height:9px;border-radius:50%;background:#3f3f46;flex:none}',
      '.ptt-row.on .ptt-pdot{background:#22c55e;box-shadow:0 0 6px #22c55e}',
      '.ptt-chev{color:var(--text-dim,#9a9a9a);flex:none;font-size:16px}',
      '.ptt-grab{color:var(--text-dim,#9a9a9a);cursor:grab;flex:none;font-size:14px;padding:0 2px;user-select:none}',
      '.ptt-row.dragover{border-top:2px solid var(--primary,#f97316)}',
      '.ptt-row.dragging{opacity:.45}',
      /* talk screen */
      '.ptt-talkhead{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
      '.ptt-back{background:none;border:1px solid var(--border,#2a2a2a);border-radius:10px;color:var(--text,#ededed);width:34px;height:34px;cursor:pointer;font-size:16px;flex:none}',
      '.ptt-back:hover{border-color:var(--primary,#f97316)}',
      '.ptt-talkhead .tname{font-size:18px;font-weight:800;flex:1}',
      '.ptt-status{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim,#9a9a9a);margin-bottom:12px}',
      '.ptt-status .ptt-dot.ok{background:#22c55e}',
      '.ptt-status .ptt-dot.warn{background:#eab308;animation:ptt-blink 1s infinite}',
      '.ptt-status .ptt-dot.off{background:#3f3f46}',
      '.ptt-panel{background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:14px;padding:18px}',
      '.ptt-people{display:flex;flex-wrap:wrap;gap:8px;margin:2px 0 14px}',
      '.ptt-person{background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600}',
      '.ptt-person.speaking{border-color:#22c55e;color:#22c55e}',
      '.ptt-talkrow{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0 4px}',
      '.ptt-talk{width:150px;height:150px;border-radius:50%;border:2px solid var(--primary,#f97316);background:transparent;color:var(--primary,#f97316);font-weight:800;font-size:13px;letter-spacing:.5px;cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none;transition:transform .08s}',
      '.ptt-talk:active{transform:scale(.97)}',
      '.ptt-talk.onair{background:var(--primary,#f97316);color:#0f0f0f;animation:ptt-pulse 1.2s infinite}',
      '.ptt-talk.connecting{border-color:#eab308;color:#eab308}',
      '.ptt-hint{color:var(--text-dim,#9a9a9a);font-size:12px}',
      '.ptt-actions{display:flex;gap:8px;justify-content:center;margin-top:12px}',
      '.ptt-notice{background:rgba(234,179,8,.08);border:1px solid rgba(234,179,8,.35);border-radius:12px;padding:12px 14px;font-size:13px;margin-bottom:14px}',
      '.ptt-hist{margin-top:16px}',
      '.ptt-hist h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--text-dim,#9a9a9a)}',
      '.ptt-log-list{display:flex;flex-direction:column;gap:6px}',
      '.ptt-rec{display:flex;align-items:center;gap:10px;background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:8px 12px;font-size:13px}',
      '.ptt-rec.new{border-color:var(--primary,#f97316)}',
      '.ptt-rec .t{color:var(--text-dim,#9a9a9a);font-size:12px;min-width:112px}',
      '.ptt-rec .c{font-size:10px;font-weight:800;letter-spacing:.5px;border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:2px 8px;flex:none}',
      '.ptt-rec .n{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ptt-rec .d{color:var(--text-dim,#9a9a9a);font-size:12px}',
      '.ptt-rec .newchip{background:var(--primary,#f97316);color:#0f0f0f;font-size:9px;font-weight:800;border-radius:999px;padding:2px 6px;letter-spacing:.5px}',
      '.ptt-play{background:none;border:1px solid var(--primary,#f97316);color:var(--primary,#f97316);border-radius:999px;width:30px;height:30px;cursor:pointer;font-size:12px;flex:none}',
      '.ptt-play.playing{background:var(--primary,#f97316);color:#0f0f0f}',
      /* echo row */
      '.ptt-echo-btn{background:none;border:1px solid var(--border,#2a2a2a);border-radius:999px;color:var(--text-dim,#9a9a9a);font-size:11px;font-weight:700;padding:4px 11px;cursor:pointer;flex:none;touch-action:none;-webkit-user-select:none;user-select:none}',
      '.ptt-echo-btn:hover{border-color:#8b5cf6;color:#8b5cf6}',
      '.ptt-echo-btn.rec{background:#ef4444;border-color:#ef4444;color:#fff;animation:ptt-blink 1s infinite}',
      '.ptt-echo-btn.play{background:#8b5cf6;border-color:#8b5cf6;color:#fff}',
      '@keyframes ptt-pulse{0%{box-shadow:0 0 0 0 rgba(249,115,22,.45)}70%{box-shadow:0 0 0 18px rgba(249,115,22,0)}100%{box-shadow:0 0 0 0 rgba(249,115,22,0)}}',
      '@keyframes ptt-blink{50%{opacity:.35}}',
      /* floating bar */
      '#ptt-bar{position:fixed;bottom:18px;right:80px;z-index:8400;display:none;align-items:center;gap:10px;background:var(--bg-elevated,#171717);border:1px solid var(--border,#2a2a2a);border-radius:999px;padding:8px 10px 8px 14px;box-shadow:0 8px 30px rgba(0,0,0,.45)}',
      '#ptt-bar .ptt-bar-name{font-size:12px;font-weight:700;cursor:pointer;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#ptt-bar .ptt-bar-new{background:var(--primary,#f97316);color:#0f0f0f;font-size:10px;font-weight:800;border-radius:999px;padding:2px 7px;cursor:pointer}',
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

  // ---- SDK / audio sink ------------------------------------------------------
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

  // ---- shared room wiring ------------------------------------------------------
  function wireRoom(handle) {
    var RE = window.LivekitClient.RoomEvent;
    var room = handle.room;
    room.on(RE.TrackSubscribed, function (track, publication, participant) {
      if (track.kind === 'audio') {
        var el = track.attach();
        handle.audioEls.push(el);
        audioSink().appendChild(el);
        if (handle.kind === 'inbox' && participant) {
          showToast('Direct transmission from ' + (participant.name || ('User ' + participant.identity)), 'success');
        }
      }
      refreshUI();
    });
    room.on(RE.TrackUnsubscribed, function (track) {
      (track.detach() || []).forEach(function (el) {
        var i = handle.audioEls.indexOf(el);
        if (i !== -1) handle.audioEls.splice(i, 1);
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      refreshUI();
    });
    room.on(RE.ParticipantConnected, refreshUI);
    room.on(RE.ParticipantDisconnected, refreshUI);
    room.on(RE.ActiveSpeakersChanged, refreshUI);
    room.on(RE.Reconnecting, refreshUI);
    room.on(RE.Reconnected, refreshUI);
    if (RE.AudioPlaybackStatusChanged) room.on(RE.AudioPlaybackStatusChanged, refreshUI);
    room.on(RE.Disconnected, function () {
      if (handle.kind === 'talk') handleTalkDisconnect(handle);
      else if (handle.kind === 'monitor') handleMonitorDisconnect(handle);
      else if (handle.kind === 'inbox') {
        if (PTT.inbox === handle) PTT.inbox = null;
        killAudio(handle);
        if (!handle.stopped) setTimeout(function () { if (radioActive()) startInbox(); }, 5000);
      } else if (handle.kind === 'dm') {
        if (PTT.dms[handle.direct.id] === handle) delete PTT.dms[handle.direct.id];
        killAudio(handle);
      }
    });
  }

  function killAudio(handle) {
    (handle.audioEls || []).forEach(function (el) {
      try { el.pause(); } catch (e) {}
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    handle.audioEls = [];
  }

  // ---- TALK connection ----------------------------------------------------------
  async function joinTalk(code) {
    if (PTT.connecting) return;
    PTT.connecting = true; /* before teardown so a switch keeps the inbox */
    if (PTT.monitors[code]) stopMonitor(code, true); /* same identity cannot hold both */
    var prevTalk = PTT.talk ? PTT.talk.channel.code : null;
    if (PTT.talk) await leaveTalk(true);
    clearTimeout(PTT.reconnectTimer);
    PTT.reconnectTimer = null;
    PTT.wantDisconnect = false;
    refreshUI(); updateBar();
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
      ensurePoll();
      startInbox();
      sendHeartbeat(false);
      refreshUI(); updateBar();
      if (!PTT.reconnectWasAuto) showToast('Live on ' + data.channel.name, 'success');
      PTT.reconnectWasAuto = false;
      /* Zello-style: keep hearing the channel you switched away from. */
      if (prevTalk && prevTalk !== code && !PTT.monitors[prevTalk]) {
        startMonitor(prevTalk, true).catch(function () {});
      }
    } catch (e) {
      PTT.connecting = false;
      if (PTT.talk) { killAudio(PTT.talk); try { PTT.talk.room.disconnect(); } catch (x) {} }
      PTT.talk = null;
      refreshUI(); updateBar();
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
    syncRadio();
    refreshUI(); updateBar();
  }

  function handleTalkDisconnect(handle) {
    if (PTT.wantDisconnect || PTT.talk !== handle) return;
    killAudio(handle);
    var ch = handle.channel;
    PTT.talk = null;
    PTT.talking = false;
    refreshUI(); updateBar();
    if (PTT.reconnectAttempt >= TALK_RETRY.length) {
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

  // ---- MONITOR (listen) connections ------------------------------------------------
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
      ensurePoll();
      startInbox();
      sendHeartbeat(false);
      refreshUI(); updateBar();
      if (!isRetry) showToast('Listening to ' + data.channel.name, 'success');
    } catch (e) {
      delete PTT.monitors[code];
      refreshUI(); updateBar();
      if (!isRetry) showToast('Could not listen: ' + (e && e.message ? e.message : e), 'error');
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
    syncRadio();
    refreshUI(); updateBar();
    if (!silent) showToast('Stopped listening to ' + handle.channel.name, 'success');
  }

  function handleMonitorDisconnect(handle) {
    if (handle.stopped || PTT.monitors[handle.channel.code] !== handle) return;
    killAudio(handle);
    delete PTT.monitors[handle.channel.code];
    refreshUI(); updateBar();
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

  // ---- seen/unheard tracking --------------------------------------------------------
  function lastSeen() {
    try { return parseInt(localStorage.getItem('ptt_log_seen') || '0', 10) || 0; } catch (e) { return 0; }
  }
  function markSeen() {
    try { localStorage.setItem('ptt_log_seen', String(Date.now())); } catch (e) {}
    PTT.newCount = 0;
    updateBar();
    paintTabs();
  }
  function isNewRow(r) {
    if (!r || !r.started_at) return false;
    if (state.user && r.user_id === state.user.id) return false;
    return new Date(r.started_at).getTime() > lastSeen();
  }
  function newCountFor(key, isPerson) {
    var n = 0;
    for (var i = 0; i < PTT.logRows.length; i++) {
      var r = PTT.logRows[i];
      if (!isNewRow(r)) continue;
      if (isPerson) { if (r.channel_code === 'DIRECT' && r.dm_from === key) n++; }
      else { if (r.channel_code === key) n++; }
    }
    return n;
  }
  async function fetchLog() {
    if (!PTT.canRecord) return;
    try {
      var data = await api('GET', '/ptt/recordings');
      PTT.logRows = (data && data.recordings) || [];
      var n = 0;
      for (var i = 0; i < PTT.logRows.length; i++) if (isNewRow(PTT.logRows[i])) n++;
      PTT.newCount = n;
      updateBar();
    } catch (e) {}
  }
  async function pollTick() {
    if (!radioActive()) return;
    sendHeartbeat(false);
    await fetchLog();
    if (state.currentView === 'ptt') {
      await loadPeople();
      refreshUI();
    }
  }
  function ensurePoll() {
    if (PTT.pollTimer) return;
    PTT.pollTimer = setInterval(pollTick, 60000);
  }

  // ---- inbox / direct talk ---------------------------------------------------------
  function dmCount() {
    var n = 0, k;
    for (k in PTT.dms) if (PTT.dms.hasOwnProperty(k)) n++;
    return n;
  }
  function radioActive() {
    return !!(PTT.talk || PTT.connecting || PTT.reconnectTimer || monitorCount() || dmCount());
  }
  function syncRadio() {
    if (radioActive()) { startInbox(); }
    else { stopInbox(); closeDms(); sendHeartbeat(true); }
  }

  async function startInbox() {
    if (PTT.inbox || PTT._inboxConnecting || typeof state === 'undefined' || !state.user) return;
    PTT._inboxConnecting = true;
    try {
      await loadSdk();
      var data = await api('POST', '/ptt/token', { user: state.user.id, listen: true });
      var LK = window.LivekitClient;
      var room = new LK.Room({});
      var handle = { kind: 'inbox', room: room, channel: { code: 'INBOX', name: 'Direct' }, audioEls: [] };
      wireRoom(handle);
      await room.connect(data.url, data.token);
      PTT.inbox = handle;
    } catch (e) { PTT.inbox = null; }
    PTT._inboxConnecting = false;
  }
  function stopInbox() {
    var h = PTT.inbox;
    if (!h) return;
    PTT.inbox = null;
    h.stopped = true;
    killAudio(h);
    try { h.room.disconnect(); } catch (e) {}
  }

  function stopDm(id) {
    var h = PTT.dms[id];
    if (!h) return;
    delete PTT.dms[id];
    h.stopped = true;
    clearTimeout(h.idleTimer);
    killAudio(h);
    try { h.room.disconnect(); } catch (e) {}
  }
  function closeDms() {
    var k, ids = [];
    for (k in PTT.dms) if (PTT.dms.hasOwnProperty(k)) ids.push(k);
    ids.forEach(function (i) { stopDm(i); });
  }
  function touchDm(h) {
    clearTimeout(h.idleTimer);
    h.idleTimer = setTimeout(function () { stopDm(h.direct.id); syncRadio(); }, 5 * 60 * 1000);
  }
  async function ensureDm(id) {
    var h = PTT.dms[id];
    if (h && h.room.state === 'connected') { touchDm(h); return h; }
    if (h) stopDm(id);
    await loadSdk();
    var data = await api('POST', '/ptt/token', { user: id });
    var LK = window.LivekitClient;
    var room = new LK.Room({
      stopMicTrackOnMute: false,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    h = { kind: 'dm', room: room, direct: data.direct, channel: { code: 'DM', name: data.direct.name }, audioEls: [], idleTimer: null };
    PTT.dms[id] = h;
    wireRoom(h);
    await room.connect(data.url, data.token);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setMicrophoneEnabled(false);
    } catch (e) {}
    touchDm(h);
    return h;
  }
  function dmSetTalking(h, on) {
    PTT.opChain = PTT.opChain.then(function () {
      if (PTT.dms[h.direct.id] !== h) return;
      return h.room.localParticipant.setMicrophoneEnabled(on).then(function () {
        if (on) startRec(h, h.direct.id);
        else stopRec();
      }).catch(function (e) {
        if (on) showToast('Mic error: ' + (e && e.message ? e.message : e), 'error');
      });
    });
  }
  function paintPerson(id, mode) {
    var els = document.querySelectorAll('[data-pid="' + id + '"]');
    for (var i = 0; i < els.length; i++) {
      var b = els[i];
      var big = b.classList.contains('ptt-talk') || b.id === 'ptt-talk-btn';
      var base = big ? 'ptt-talk' : 'ptt-listen';
      b.className = base + (mode === 'onair' ? ' onair' : (mode === 'connecting' ? ' connecting' : ''));
      if (big) b.textContent = mode === 'onair' ? 'ON AIR' : (mode === 'connecting' ? 'CONNECTING...' : 'HOLD TO TALK');
    }
  }
  async function personDown(id, name) {
    if (PTT.talking || PTT.dmHold) return;
    PTT.dmHold = id;
    paintPerson(id, 'connecting');
    var h;
    try { h = await ensureDm(id); }
    catch (e) {
      if (PTT.dmHold === id) PTT.dmHold = 0;
      paintPerson(id, 'idle');
      showToast('Could not reach ' + name + ': ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    startInbox();
    sendHeartbeat(false);
    ensurePoll();
    if (PTT.dmHold !== id) { paintPerson(id, 'idle'); return; }
    paintPerson(id, 'onair');
    dmSetTalking(h, true);
  }
  function personUp(id) {
    if (PTT.dmHold !== id) return;
    PTT.dmHold = 0;
    paintPerson(id, 'idle');
    var h = PTT.dms[id];
    if (h) { dmSetTalking(h, false); touchDm(h); }
  }
  function bindPerson(el) {
    if (!el || el._pttP) return;
    el._pttP = true;
    var id = parseInt(el.getAttribute('data-pid'), 10);
    var name = el.getAttribute('data-pname') || '';
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      personDown(id, name);
    });
    var up = function (e) { if (e) e.stopPropagation(); personUp(id); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  function sendHeartbeat(off) {
    api('POST', '/ptt/heartbeat', off ? { off: true } : {}).catch(function () {});
  }
  async function loadPeople() {
    var data;
    try { data = await api('GET', '/ptt/people'); } catch (e) { return; }
    PTT.people = (data && data.people) || [];
    PTT.canDirect = !!(data && data.canDirect);
  }

  async function leaveAll(silent) {
    var k, codes = [];
    for (k in PTT.monitors) if (PTT.monitors.hasOwnProperty(k)) codes.push(k);
    codes.forEach(function (c) { stopMonitor(c, true); });
    closeDms();
    stopInbox();
    await leaveTalk(silent);
    sendHeartbeat(true);
  }

  // ---- recording (Radio Log) -----------------------------------------------------
  function pickMime() {
    if (!window.MediaRecorder) return null;
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
    return null;
  }

  function startRec(handle, dmTo) {
    if (!PTT.canRecord || !window.MediaRecorder) return;
    try {
      var LK = window.LivekitClient;
      var pub = handle.room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
      var mst = pub && pub.track && pub.track.mediaStreamTrack;
      if (!mst) return;
      var mime = pickMime();
      var mr = new MediaRecorder(new MediaStream([mst]), mime ? { mimeType: mime } : undefined);
      var sess = { mr: mr, chunks: [], startedAt: new Date(), channel: handle.channel.code, dmTo: dmTo || 0, mime: mr.mimeType || mime || 'audio/webm' };
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
      var presignBody = s.dmTo ? { user: s.dmTo, mime: s.mime } : { channel: s.channel, mime: s.mime };
      api('POST', '/ptt/recordings/presign', presignBody)
        .then(function (p) {
          return fetch(p.url, { method: 'PUT', headers: { 'Content-Type': s.mime }, body: blob })
            .then(function (r) {
              if (!r.ok) throw new Error('upload failed ' + r.status);
              var confirmBody = {
                key: p.key, mime: s.mime,
                started_at: s.startedAt.toISOString(),
                duration_ms: Date.now() - s.startedAt.getTime()
              };
              if (s.dmTo) confirmBody.user = s.dmTo; else confirmBody.channel = s.channel;
              return api('POST', '/ptt/recordings', confirmBody);
            });
        })
        .then(function () { fetchLog().then(function () { refreshUI(); }); })
        .catch(function (e) { try { console.warn('PTT clip upload failed:', e); } catch (x) {} });
    }
  }

  // ---- channel push-to-talk ---------------------------------------------------------
  function setTalking(on) {
    if (!PTT.talk || PTT.talking === on) return;
    if (on && (PTT.connecting || PTT.dmHold)) return;
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
    if (!on) refreshUI(); /* safe to re-render once the key is released */
  }

  function paintTalkState() {
    var big = document.getElementById('ptt-talk-btn');
    if (big && !big.getAttribute('data-pid')) {
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
    if (!PTT.talk || typeof state === 'undefined' || state.currentView !== 'ptt') return;
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

  // ---- echo test ----------------------------------------------------------------
  var ECHO = { mr: null, chunks: [], stream: null, playing: false };

  function paintEcho(mode) {
    var b = document.getElementById('ptt-echo-btn');
    if (!b) return;
    if (mode === 'rec') { b.className = 'ptt-echo-btn rec'; b.textContent = 'Recording...'; }
    else if (mode === 'play') { b.className = 'ptt-echo-btn play'; b.textContent = 'Playing back...'; }
    else { b.className = 'ptt-echo-btn'; b.innerHTML = 'Hold &amp; speak'; }
  }

  async function echoStart() {
    if (ECHO.mr || ECHO.playing) return;
    if (!window.MediaRecorder || !navigator.mediaDevices) { showToast('This browser cannot record audio.', 'error'); return; }
    try {
      ECHO.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      showToast('Microphone unavailable: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    var mime = pickMime();
    ECHO.chunks = [];
    try {
      ECHO.mr = new MediaRecorder(ECHO.stream, mime ? { mimeType: mime } : undefined);
    } catch (e) {
      (ECHO.stream.getTracks() || []).forEach(function (t) { t.stop(); });
      ECHO.stream = null;
      showToast('Could not start the recorder.', 'error');
      return;
    }
    ECHO.mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) ECHO.chunks.push(ev.data); };
    ECHO.mr.start();
    paintEcho('rec');
  }

  function echoStop() {
    var mr = ECHO.mr;
    if (!mr) return;
    ECHO.mr = null;
    mr.onstop = function () {
      ((ECHO.stream && ECHO.stream.getTracks()) || []).forEach(function (t) { t.stop(); });
      ECHO.stream = null;
      var blob = new Blob(ECHO.chunks, { type: mr.mimeType || 'audio/webm' });
      ECHO.chunks = [];
      if (blob.size < 1000) { paintEcho('idle'); return; }
      var url = URL.createObjectURL(blob);
      var a = new Audio(url);
      ECHO.playing = true;
      paintEcho('play');
      var done = function () { ECHO.playing = false; URL.revokeObjectURL(url); paintEcho('idle'); refreshUI(); };
      a.onended = done;
      a.onerror = done;
      a.play().catch(done);
    };
    try { mr.stop(); } catch (e) { paintEcho('idle'); }
  }

  function bindEcho(el) {
    if (!el || el._pttEcho) return;
    el._pttEcho = true;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      echoStart();
    });
    var up = function (e) { if (e) e.stopPropagation(); echoStop(); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ---- floating bar ---------------------------------------------------------------
  function ensureBar() {
    var bar = document.getElementById('ptt-bar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'ptt-bar';
    bar.innerHTML =
      '<span class="ptt-dot" style="background:#22c55e"></span>' +
      '<span class="ptt-bar-name" title="Open Radio"></span>' +
      '<span class="ptt-bar-new" style="display:none" title="Unheard transmissions - open the Radio"></span>' +
      '<button class="ptt-bar-talk" title="Hold to talk">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' +
      '</button>' +
      '<button class="ptt-bar-x" title="Radio off">&#10005;</button>';
    document.body.appendChild(bar);
    bar.querySelector('.ptt-bar-name').addEventListener('click', function () {
      if (typeof navigate === 'function') navigate('ptt');
    });
    bar.querySelector('.ptt-bar-new').addEventListener('click', function () {
      if (typeof navigate === 'function') navigate('ptt');
    });
    bar.querySelector('.ptt-bar-x').addEventListener('click', function () { leaveAll(false); });
    bindHold(bar.querySelector('.ptt-bar-talk'));
    return bar;
  }

  function updateBar() {
    injectStyles();
    var bar = ensureBar();
    if (!state.token && (PTT.talk || monitorCount() || dmCount())) { leaveAll(true); return; }
    var active = radioActive();
    var onPttPage = state.currentView === 'ptt' && state.token;
    if (!active || onPttPage) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    var dot = bar.querySelector('.ptt-dot');
    dot.style.background = (PTT.talk || monitorCount()) ? '#22c55e' : '#eab308';
    var name = bar.querySelector('.ptt-bar-name');
    var label = PTT.talk ? PTT.talk.channel.name : (PTT.connecting || PTT.reconnectTimer ? 'Connecting...' : 'Listening');
    var mc = monitorCount();
    if (mc) label += ' +' + mc;
    name.textContent = label;
    var nb = bar.querySelector('.ptt-bar-new');
    if (nb) {
      if (PTT.newCount > 0) { nb.style.display = 'inline-block'; nb.textContent = PTT.newCount + ' new'; }
      else nb.style.display = 'none';
    }
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

  // ---- page: Zello-style tabs + talk screen ------------------------------------------
  window.renderPTT = async function (content) {
    injectStyles();
    wrapNavigate();
    ensureBar();
    content.innerHTML = '<div class="ptt-wrap"><h1>Radio</h1><div class="ptt-sub">Loading...</div></div>';
    var data;
    try {
      data = await api('GET', '/ptt/channels');
    } catch (e) {
      content.innerHTML = '<div class="ptt-wrap"><h1>Radio</h1><div class="ptt-notice">Could not load: ' + escHtml((e && e.message) ? e.message : String(e)) + '</div></div>';
      return;
    }
    PTT.channels = data.channels || [];
    PTT.configured = !!data.configured;
    PTT.canRecord = !!data.recording;
    if (state.currentView !== 'ptt') return;

    var h = '<div class="ptt-wrap"><h1>Radio</h1>';
    if (!PTT.configured) {
      h += '<div class="ptt-notice"><b>Not configured yet.</b> Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in Railway.</div>';
    }
    h += '<div class="ptt-tabs" id="ptt-tabs"></div><div id="ptt-body"></div></div>';
    content.innerHTML = h;
    loadPeople().then(function () { refreshUI(); });
    fetchLog().then(function () { refreshUI(); });
    refreshUI();
    updateBar();
  };

  function paintTabs() {
    var el = document.getElementById('ptt-tabs');
    if (!el) return;
    if (PTT.sel) { el.style.display = 'none'; return; }
    el.style.display = 'flex';
    var recN = PTT.newCount;
    var tabs = [
      { id: 'recents', label: 'Recents' + (recN ? '<span class="ptt-badge">' + recN + '</span>' : '') },
      { id: 'channels', label: 'Channels' },
      { id: 'people', label: 'People' }
    ];
    el.innerHTML = tabs.map(function (t) {
      return '<div class="ptt-tab' + (PTT.tab === t.id ? ' active' : '') + '" onclick="pttTab(\'' + t.id + '\')">' + t.label + '</div>';
    }).join('');
  }

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

  /* Re-render the page body. Never while a key/button is held - replacing the
     held element would eat the pointerup and stick the transmitter open. */
  function refreshUI() {
    try {
      paintTalkState();
      if (typeof state === 'undefined' || state.currentView !== 'ptt') return;
      if (PTT.talking || PTT.dmHold || PTT.dragging || ECHO.mr || ECHO.playing) return;
      var body = document.getElementById('ptt-body');
      if (!body) return;
      paintTabs();
      if (PTT.sel) drawTalk(body);
      else if (PTT.tab === 'recents') drawRecents(body);
      else if (PTT.tab === 'people') drawPeopleList(body);
      else drawChannelsList(body);
    } catch (err) {
      /* Never blank the page silently - show what broke. */
      try { console.error('PTT refreshUI failed:', err); } catch (x) {}
      var b2 = document.getElementById('ptt-body');
      if (b2) b2.innerHTML = '<div class="ptt-notice"><b>Radio UI error:</b> ' + escHtml((err && err.message) ? err.message : String(err)) + '</div>';
    }
  }

  // ---- manual ordering (saved per device) ---------------------------------------------
  function orderGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]') || []; } catch (e) { return []; }
  }
  function orderSave(key, arr) {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch (e) {}
  }
  /* Sort items by the saved order; anything new keeps its default position at the end. */
  function applyOrder(items, key, idOf) {
    var saved = orderGet(key);
    if (!saved.length) return items.slice();
    var pos = {};
    for (var i = 0; i < saved.length; i++) pos[String(saved[i])] = i;
    return items.slice().sort(function (a, b) {
      var pa = pos.hasOwnProperty(String(idOf(a))) ? pos[String(idOf(a))] : 9999;
      var pb = pos.hasOwnProperty(String(idOf(b))) ? pos[String(idOf(b))] : 9999;
      return pa - pb;
    });
  }
  var DRAG = { id: null, key: null };
  function bindDrag(listEl, storeKey) {
    if (!listEl || listEl._pttDrag) return;
    listEl._pttDrag = true;
    listEl.addEventListener('dragstart', function (e) {
      var row = e.target.closest ? e.target.closest('.ptt-row[data-oid]') : null;
      if (!row) return;
      DRAG.id = row.getAttribute('data-oid');
      DRAG.key = storeKey;
      PTT.dragging = true;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', DRAG.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) {}
    });
    listEl.addEventListener('dragover', function (e) {
      if (!DRAG.id || DRAG.key !== storeKey) return;
      e.preventDefault();
      var row = e.target.closest ? e.target.closest('.ptt-row[data-oid]') : null;
      var rows = listEl.querySelectorAll('.ptt-row');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('dragover');
      if (row && row.getAttribute('data-oid') !== DRAG.id) row.classList.add('dragover');
    });
    listEl.addEventListener('drop', function (e) {
      if (!DRAG.id || DRAG.key !== storeKey) return;
      e.preventDefault();
      var row = e.target.closest ? e.target.closest('.ptt-row[data-oid]') : null;
      var rows = listEl.querySelectorAll('.ptt-row[data-oid]');
      var order = [];
      for (var i = 0; i < rows.length; i++) {
        var oid = rows[i].getAttribute('data-oid');
        if (oid !== DRAG.id) order.push(oid);
      }
      if (row && row.getAttribute('data-oid') !== DRAG.id) {
        var idx = order.indexOf(row.getAttribute('data-oid'));
        order.splice(idx, 0, DRAG.id);
      } else {
        order.push(DRAG.id);
      }
      orderSave(storeKey, order);
      DRAG.id = null; DRAG.key = null;
      PTT.dragging = false;
      refreshUI();
    });
    listEl.addEventListener('dragend', function () {
      DRAG.id = null; DRAG.key = null;
      PTT.dragging = false;
      refreshUI();
    });
  }

  // ---- lists ------------------------------------------------------------------------
  function drawChannelsList(body) {
    var chans = applyOrder(PTT.channels, 'ptt_order_channels', function (c) { return c.code; });
    var h = '<div class="ptt-list" id="ptt-chan-list">';
    for (var i = 0; i < chans.length; i++) {
      var c = chans[i];
      var live = PTT.talk && PTT.talk.channel.code === c.code;
      var mon = !!PTT.monitors[c.code];
      var n = newCountFor(c.code, false);
      h += '<div class="ptt-row' + (live ? ' live' : '') + (mon ? ' mon' : '') + (chanSpeaking(c.code) ? ' speaking' : '') + '" draggable="true" data-oid="' + escHtml(c.code) + '" onclick="pttOpenChan(\'' + escHtml(c.code) + '\')">' +
        '<span class="ptt-grab" title="Drag to reorder">&#8942;&#8942;</span>' +
        '<span class="ptt-dot" style="background:' + escHtml(c.color || '#f97316') + '"></span>' +
        '<span class="nm">' + escHtml(c.name) + '</span>' +
        '<span class="spk"></span>' +
        (n ? '<span class="ptt-badge">' + n + '</span>' : '') +
        (live ? '<span class="ptt-chip">LIVE</span>' :
          '<button class="ptt-listen' + (mon ? ' on' : '') + '" onclick="event.stopPropagation();pttListen(\'' + escHtml(c.code) + '\')">' + (mon ? 'Listening' : 'Listen') + '</button>') +
        '<span class="ptt-chev">&#8250;</span>' +
      '</div>';
    }
    if (!chans.length) h += '<div class="ptt-hint">No channels available for your account.</div>';
    h += '<div class="ptt-row" style="cursor:default">' +
      '<span class="ptt-dot" style="background:#8b5cf6"></span>' +
      '<span class="nm">Echo Test<span class="sub">Hold, speak, release &middot; hear yourself back</span></span>' +
      '<button class="ptt-echo-btn" id="ptt-echo-btn">Hold &amp; speak</button>' +
    '</div>';
    h += '</div>';
    body.innerHTML = h;
    bindEcho(document.getElementById('ptt-echo-btn'));
    bindDrag(document.getElementById('ptt-chan-list'), 'ptt_order_channels');
  }

  function drawPeopleList(body) {
    var me = (state.user) ? state.user.id : 0;
    var ppl = PTT.people.filter(function (p) { return p.id !== me; });
    ppl.sort(function (a, b) { return (b.online === true) - (a.online === true) || String(a.name).localeCompare(String(b.name)); });
    ppl = applyOrder(ppl, 'ptt_order_people', function (p) { return p.id; });
    var h = '<div class="ptt-list" id="ptt-ppl-list">';
    for (var i = 0; i < ppl.length; i++) {
      var pp = ppl[i];
      var n = newCountFor(pp.id, true);
      h += '<div class="ptt-row' + (pp.online ? ' on' : '') + '" draggable="true" data-oid="' + pp.id + '" onclick="pttOpenPerson(' + pp.id + ')">' +
        '<span class="ptt-grab" title="Drag to reorder">&#8942;&#8942;</span>' +
        '<span class="ptt-pdot" title="' + (pp.online ? 'Radio on' : 'Radio off') + '"></span>' +
        '<span class="nm">' + escHtml(pp.name) + (pp.online ? '' : '<span class="sub">Radio off &middot; they get it in their log</span>') + '</span>' +
        (n ? '<span class="ptt-badge">' + n + '</span>' : '') +
        '<span class="ptt-chev">&#8250;</span>' +
      '</div>';
    }
    if (!ppl.length) h += '<div class="ptt-hint">Nobody else here yet.</div>';
    h += '</div>';
    body.innerHTML = h;
    bindDrag(document.getElementById('ptt-ppl-list'), 'ptt_order_people');
  }

  function fmtDur(ms) {
    var s = Math.max(1, Math.round((ms || 0) / 1000));
    var m = Math.floor(s / 60);
    return m ? (m + 'm ' + (s % 60) + 's') : (s + 's');
  }
  function fmtTime(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return String(iso); }
  }

  function recRowHtml(r) {
    var isNew = isNewRow(r);
    var isDm = r.channel_code === 'DIRECT';
    var who = isDm
      ? (r.user_name || ('User ' + r.user_id)) + ' → ' + (r.dm_to_name || ('User ' + r.dm_to))
      : (r.user_name || ('User ' + r.user_id));
    return '<div class="ptt-rec' + (isNew ? ' new' : '') + '" id="ptt-rec-' + r.id + '">' +
      '<button class="ptt-play" onclick="pttPlay(' + r.id + ')" title="Play">&#9654;</button>' +
      '<span class="t">' + escHtml(fmtTime(r.started_at)) + '</span>' +
      '<span class="c">' + escHtml(isDm ? 'DM' : r.channel_code) + '</span>' +
      '<span class="n">' + escHtml(who) + '</span>' +
      (isNew ? '<span class="newchip">NEW</span>' : '') +
      '<span class="d">' + escHtml(fmtDur(r.duration_ms)) + '</span>' +
    '</div>';
  }

  function drawRecents(body) {
    var h = '<div class="ptt-log-list">';
    if (!PTT.canRecord) {
      h += '<div class="ptt-hint">Recording is off - set the R2_* variables (already used by the Document Vault) to store transmissions.</div>';
    } else if (!PTT.logRows.length) {
      h += '<div class="ptt-hint">No transmissions yet.</div>';
    } else {
      for (var i = 0; i < Math.min(PTT.logRows.length, 100); i++) h += recRowHtml(PTT.logRows[i]);
    }
    h += '</div>';
    body.innerHTML = h;
    markSeen(); /* you have looked at Recents; NEW chips stay for this render */
  }

  // ---- talk screen ---------------------------------------------------------------------
  function historyFor(sel) {
    var out = [];
    for (var i = 0; i < PTT.logRows.length && out.length < 12; i++) {
      var r = PTT.logRows[i];
      if (sel.type === 'channel') { if (r.channel_code === sel.code) out.push(r); }
      else { if (r.channel_code === 'DIRECT' && (r.dm_from === sel.id || r.dm_to === sel.id)) out.push(r); }
    }
    return out;
  }

  function participantHtml() {
    var handle = PTT.talk;
    if (!handle) return '';
    var room = handle.room;
    var items = [];
    var lp = room.localParticipant;
    items.push({ name: (lp.name || (state.user ? state.user.name : 'Me')) + ' (you)', speaking: !!lp.isSpeaking });
    room.remoteParticipants.forEach(function (p) {
      items.push({ name: p.name || ('User ' + p.identity), speaking: !!p.isSpeaking });
    });
    var h = '';
    for (var i = 0; i < items.length; i++) {
      h += '<span class="ptt-person' + (items[i].speaking ? ' speaking' : '') + '">' + escHtml(items[i].name) + '</span>';
    }
    var alone = items.length === 1 ? '<div class="ptt-hint" style="margin:0 0 12px">Nobody else is on this channel right now.</div>' : '';
    return '<div class="ptt-people">' + h + '</div>' + alone;
  }

  function drawTalk(body) {
    var sel = PTT.sel;
    if (!sel) return;
    var h = '<div class="ptt-talkhead"><button class="ptt-back" onclick="pttBack()">&#8249;</button>';
    if (sel.type === 'channel') {
      var live = PTT.talk && PTT.talk.channel.code === sel.code;
      var reconn = live && PTT.talk.room.state === 'reconnecting';
      var audioBlocked = live && (PTT.talk.room.canPlaybackAudio === false);
      h += '<span class="tname">' + escHtml(sel.name) + '</span></div>';
      h += '<div class="ptt-status"><span class="ptt-dot ' + (PTT.connecting ? 'warn' : (live ? (reconn ? 'warn' : 'ok') : 'off')) + '"></span> ' +
        (PTT.connecting ? 'Connecting...' : (live ? (reconn ? 'Reconnecting...' : 'Live - hold to talk') : 'Not connected')) + '</div>';
      h += '<div class="ptt-panel">' + (live ? participantHtml() : '') +
        '<div class="ptt-talkrow">' +
          (live
            ? '<button id="ptt-talk-btn" class="ptt-talk">HOLD TO TALK</button><div class="ptt-hint">Hold the button or hold Space. Release to listen.</div>'
            : '<button class="btn btn-primary" onclick="pttGoLive(\'' + escHtml(sel.code) + '\')">' + (PTT.connecting ? 'Connecting...' : 'Go live on this channel') + '</button>') +
        '</div>' +
        (audioBlocked ? '<div class="ptt-actions"><button class="btn btn-primary" onclick="pttEnableAudio()">Enable incoming audio</button></div>' : '') +
        (live ? '<div class="ptt-actions"><button class="btn" onclick="pttLeave()">Leave channel</button></div>' : '') +
      '</div>';
    } else {
      var pp = null;
      for (var i = 0; i < PTT.people.length; i++) if (PTT.people[i].id === sel.id) pp = PTT.people[i];
      var online = pp ? !!pp.online : false;
      h += '<span class="tname">' + escHtml(sel.name) + '</span></div>';
      h += '<div class="ptt-status"><span class="ptt-dot ' + (online ? 'ok' : 'off') + '"></span> ' +
        (online ? 'Radio on - hold to talk' : 'Radio off - your message lands in their log') + '</div>';
      h += '<div class="ptt-panel"><div class="ptt-talkrow">' +
        (PTT.canDirect
          ? '<button id="ptt-talk-btn" class="ptt-talk" data-pid="' + sel.id + '" data-pname="' + escHtml(sel.name) + '">HOLD TO TALK</button><div class="ptt-hint">Hold to speak directly to ' + escHtml(sel.name) + '. Release to listen.</div>'
          : '<div class="ptt-hint">You do not have permission for direct talk.</div>') +
      '</div></div>';
    }
    var hist = historyFor(sel);
    h += '<div class="ptt-hist"><h4>History</h4><div class="ptt-log-list">' +
      (hist.length ? hist.map(recRowHtml).join('') : '<div class="ptt-hint">Nothing here yet.</div>') +
      '</div></div>';
    body.innerHTML = h;
    if (sel.type === 'channel') {
      var btn = document.getElementById('ptt-talk-btn');
      if (btn) bindHold(btn);
    } else {
      var pbtn = document.getElementById('ptt-talk-btn');
      if (pbtn) bindPerson(pbtn);
    }
    paintTalkState();
  }

  // ---- inline handlers --------------------------------------------------------------
  window.pttTab = function (t) {
    PTT.tab = t;
    PTT.sel = null;
    refreshUI();
    if (t === 'people') loadPeople().then(refreshUI);
    if (t === 'recents') fetchLog().then(refreshUI);
  };
  window.pttBack = function () {
    PTT.sel = null;
    refreshUI();
  };
  window.pttOpenChan = function (code) {
    var c = null;
    for (var i = 0; i < PTT.channels.length; i++) if (PTT.channels[i].code === code) c = PTT.channels[i];
    if (!c) return;
    PTT.sel = { type: 'channel', code: c.code, name: c.name, color: c.color };
    refreshUI();
    /* Zello: tapping a channel selects AND connects it. */
    if (PTT.configured && (!PTT.talk || PTT.talk.channel.code !== code)) {
      joinTalk(code).catch(function () {});
    }
  };
  window.pttGoLive = function (code) {
    joinTalk(code).catch(function () {});
  };
  window.pttOpenPerson = function (id) {
    var pp = null;
    for (var i = 0; i < PTT.people.length; i++) if (PTT.people[i].id === id) pp = PTT.people[i];
    if (!pp) return;
    PTT.sel = { type: 'person', id: pp.id, name: pp.name };
    refreshUI();
  };
  window.pttListen = function (code) {
    if (PTT.monitors[code]) stopMonitor(code, false);
    else startMonitor(code, false).catch(function () {});
  };
  window.pttLeave = function () { leaveTalk(false); };
  window.pttEnableAudio = function () {
    if (PTT.talk && PTT.talk.room.startAudio) PTT.talk.room.startAudio().then(refreshUI).catch(function () {});
    var k;
    for (k in PTT.monitors) {
      if (PTT.monitors.hasOwnProperty(k) && PTT.monitors[k].room.startAudio) {
        PTT.monitors[k].room.startAudio().catch(function () {});
      }
    }
    if (PTT.inbox && PTT.inbox.room.startAudio) PTT.inbox.room.startAudio().catch(function () {});
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
  } catch (moduleErr) {
    try { console.error('PTT module failed to load:', moduleErr); } catch (x) {}
    window.renderPTT = window.renderPTT || function (content) {
      content.innerHTML = '<div style="padding:20px"><h1>Radio</h1><div style="color:#ef4444">Radio failed to load: ' + String(moduleErr && moduleErr.message ? moduleErr.message : moduleErr) + '</div></div>';
    };
  }
})();
