// ===========================================================================
//  Nova - Dispatch board + duty status ("ready to accept calls")
// ---------------------------------------------------------------------------
//  Techs here do not punch a time clock. "Ready to accept calls" is the switch
//  that decides three things: whether the board is visible, whether dispatch
//  treats you as available, and whether Nova stores your position at all.
//
//  There is NO automatic overnight clear - nights are a real shift - so the
//  board reports how long someone has been marked ready instead, and dispatch
//  can clear a forgotten toggle by hand.
//
//  Classic script like app.js: everything global, inline onclick handlers work.
// ===========================================================================

var _dispDuty = null;
var _dispJobs = [];
var _dispCanManage = false;
var _dispCrew = [];
var _dispTimer = null;
var _dispShowDone = false;
var _dispCities = [];

var DISP_STATUS = {
  new:       { label: 'Unassigned',    color: '#f59e0b' },
  assigned:  { label: 'Not accepted',  color: '#ef4444' },
  accepted:  { label: 'Accepted',      color: '#3b82f6' },
  enroute:   { label: 'On the way',    color: '#a855f7' },
  onscene:   { label: 'On scene',      color: '#22c55e' },
  done:      { label: 'Done',          color: '#71717a' },
  goa:       { label: 'GOA',           color: '#f97316' },
  cancelled: { label: 'Cancelled',     color: '#52525b' }
};
// What a tech's own job offers next, in the tech's own words. Accept is its own
// step: "I have read this" is a different fact from "I have left", and dispatch
// needs both.
var DISP_NEXT = {
  assigned: { to: 'accepted', label: 'Accept call' },
  accepted: { to: 'enroute',  label: 'On my way' },
  enroute:  { to: 'onscene',  label: 'I have arrived' },
  onscene:  { to: 'done',     label: 'Job complete' }
};
var DISP_GOA_FROM = ['accepted', 'enroute', 'onscene'];
var _dispCanAssign = false;
var _dispAcceptMins = 2;
var _dispSeenIds = {};
var _dispMe = null;

function dispInjectStyles() {
  if (document.getElementById('disp-styles')) return;
  var css =
    '.disp-duty{display:flex;align-items:center;gap:16px;flex-wrap:wrap;background:var(--bg-card,#1a1a1a);' +
      'border:1px solid var(--border,#2e2e2e);border-radius:12px;padding:16px 18px;margin-bottom:16px}' +
    '.disp-duty.on{border-color:#22c55e;box-shadow:0 0 0 1px #22c55e inset}' +
    '.disp-dutydot{width:14px;height:14px;border-radius:50%;flex:none}' +
    '.disp-dutytxt{font-weight:800;font-size:16px}' +
    '.disp-dutysub{font-size:12px;color:var(--text-muted-color,#888);margin-top:2px}' +
    '.disp-big{margin-left:auto;padding:13px 26px;border-radius:10px;border:0;font-weight:800;font-size:15px;' +
      'cursor:pointer;color:#fff;min-width:190px}' +
    '.disp-gate{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:12px;' +
      'padding:34px 26px;text-align:center;max-width:560px;margin:0 auto}' +
    '.disp-gate h3{margin:0 0 8px;font-size:19px}' +
    '.disp-gate p{color:var(--text-muted-color,#888);font-size:14px;line-height:1.6;margin:0 auto 18px;max-width:430px}' +
    '.disp-cols{display:flex;gap:14px;align-items:flex-start}' +
    '.disp-main{flex:1;min-width:0}' +
    '.disp-side{width:270px;flex:none}' +
    '.disp-job{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;' +
      'padding:12px 14px;margin-bottom:9px}' +
    '.disp-job.mine{border-color:var(--primary,#f97316)}' +
    '.disp-job.urgent{border-left:4px solid #ef4444}' +
    '.disp-job.late{box-shadow:0 0 0 1px #f59e0b inset}' +
    '.disp-jobhead{display:flex;align-items:center;gap:9px;flex-wrap:wrap}' +
    '.disp-chip{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:20px}' +
    '.disp-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--text-muted-color,#888)}' +
    '.disp-cust{font-weight:700;font-size:15px}' +
    '.disp-line{font-size:13px;color:var(--text-dim,#bbb);margin-top:3px}' +
    '.disp-muted{font-size:12px;color:var(--text-muted-color,#888);margin-top:4px}' +
    '.disp-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}' +
    '.disp-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--border,#2e2e2e);background:transparent;' +
      'color:var(--text-dim,#bbb);font-weight:600;font-size:13px;cursor:pointer}' +
    '.disp-btn:hover{border-color:var(--primary,#f97316);color:var(--text,#f0f0f0)}' +
    '.disp-btn.go{background:var(--primary,#f97316);border-color:var(--primary,#f97316);color:#fff}' +
    '.disp-crew{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;padding:9px 12px;margin-bottom:7px}' +
    '.disp-crewname{font-weight:700;display:flex;align-items:center;gap:8px;font-size:14px}' +
    '.disp-warn{color:#f59e0b}' +
    '.disp-sec{font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.07em;' +
      'color:var(--text-muted-color,#888);margin:16px 2px 8px}' +
    '@media (max-width:860px){.disp-cols{flex-direction:column}.disp-side{width:100%}.disp-big{margin-left:0;width:100%}}';
  var el = document.createElement('style');
  el.id = 'disp-styles';
  el.textContent = css;
  document.head.appendChild(el);
}


// ---------------------------------------------------------------------------
//  Sound (dispatcher desk only)
// ---------------------------------------------------------------------------
// Tones are generated, not loaded, so there is no audio file to ship, nothing to
// 404, and it works with the app offline. Browsers refuse to make noise until
// the user has interacted with the page, so the first click anywhere arms it.
//
// Only three things earn a sound. If everything beeps, people mute it within a
// week and then the alerts are worse than none.
var _dispAudio = null;
var _dispArmed = false;

function dispSoundOn() {
  try { return localStorage.getItem('nova_dispatch_sound') !== '0'; } catch (e) { return true; }
}
function dispSetSound(on) {
  try { localStorage.setItem('nova_dispatch_sound', on ? '1' : '0'); } catch (e) {}
}
function dispArmAudio() {
  if (_dispArmed) return;
  _dispArmed = true;
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) { _dispAudio = new Ctx(); if (_dispAudio.state === 'suspended') _dispAudio.resume(); }
  } catch (e) { _dispAudio = null; }
}

// notes = [[frequency, startOffsetSeconds, durationSeconds], ...]
function dispTone(notes) {
  if (!dispSoundOn()) return;
  dispArmAudio();
  if (!_dispAudio) return;
  try {
    if (_dispAudio.state === 'suspended') _dispAudio.resume();
    var t0 = _dispAudio.currentTime;
    notes.forEach(function (n) {
      var osc = _dispAudio.createOscillator();
      var gain = _dispAudio.createGain();
      osc.type = 'sine';
      osc.frequency.value = n[0];
      // Ramped, not switched. A square-edged gain change clicks, and a click on
      // every alert is what makes people reach for the mute button.
      gain.gain.setValueAtTime(0.0001, t0 + n[1]);
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + n[1] + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + n[2]);
      osc.connect(gain); gain.connect(_dispAudio.destination);
      osc.start(t0 + n[1]); osc.stop(t0 + n[1] + n[2] + 0.05);
    });
  } catch (e) {}
}

function dispSoundNewCall()   { dispTone([[784, 0, 0.16], [1046, 0.17, 0.22]]); }        // rising two-tone
function dispSoundOverdue()   { dispTone([[880, 0, 0.13], [880, 0.19, 0.13], [880, 0.38, 0.2]]); } // insistent triple
function dispSoundUnaccepted(){ dispTone([[660, 0, 0.15], [523, 0.18, 0.28]]); }         // falling, "something is wrong"

// Fires the right sound for what actually changed since the last refresh.
var _dispPrev = null;
function dispSoundForChanges(jobs) {
  if (!_dispCanManage) return;             // techs get a push, not a desk beep
  if (_dispPrev === null) { _dispPrev = dispSnapshot(jobs); return; }  // no noise on first load
  var now = dispSnapshot(jobs);
  var newCall = false, overdue = false, unaccepted = false;
  Object.keys(now).forEach(function (id) {
    var was = _dispPrev[id];
    if (!was) { if (now[id].status === 'new') newCall = true; return; }
    if (!was.overdueUnassigned && now[id].overdueUnassigned) overdue = true;
    if (!was.overdueAccept && now[id].overdueAccept) unaccepted = true;
  });
  _dispPrev = now;
  // One sound per refresh, most urgent wins. Three alerts stacking on top of
  // each other is noise, not information.
  if (overdue) dispSoundOverdue();
  else if (unaccepted) dispSoundUnaccepted();
  else if (newCall) dispSoundNewCall();
}

function dispSnapshot(jobs) {
  var out = {};
  jobs.forEach(function (j) {
    out[j.id] = {
      status: j.status,
      overdueUnassigned: !!j.unassigned_alert_at,
      overdueAccept: dispAcceptOverdue(j)
    };
  });
  return out;
}

// Amber the moment the clock runs out, whether or not the cron has caught up.
function dispAcceptOverdue(j) {
  if (j.status !== 'assigned' || !j.assigned_at || j.accepted_at) return false;
  return (Date.now() - new Date(j.assigned_at).getTime()) / 60000 >= (_dispAcceptMins || 2);
}

function dispStop() { if (_dispTimer) { clearInterval(_dispTimer); _dispTimer = null; } }

// A tech marked ready for most of a day has almost certainly forgotten to turn
// it off. We do not clear it for them (a night shift is real work), we say so.
var DISP_LONG_HOURS = 16;
function dispHrs(h) {
  if (h === null || h === undefined) return '';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
  return (Math.round(h * 10) / 10) + 'h';
}


// ---------------------------------------------------------------------------
//  Modal (matches Nova's existing .modal-overlay markup, no new CSS)
// ---------------------------------------------------------------------------
function dispModal(title, bodyHtml, okLabel, onOk) {
  dispCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'disp-modal';
  overlay.innerHTML =
    '<div class="modal">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="dispCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="dispCloseModal()">Cancel</button>' +
        '<button class="btn btn-primary" id="disp-modal-ok">' + escHtml(okLabel) + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  var ok = document.getElementById('disp-modal-ok');
  if (ok) ok.onclick = onOk;
}
function dispCloseModal() {
  var m = document.getElementById('disp-modal');
  if (m) m.parentNode.removeChild(m);
}

async function renderDispatch(content) {
  dispInjectStyles();
  document.addEventListener('click', dispArmAudio, { once: true });
  dispStop();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Dispatch</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';

  try { _dispDuty = await api('GET', '/dispatch/duty'); }
  catch (e) { content.innerHTML = '<div class="card"><div class="card-body">Could not load dispatch.</div></div>'; return; }
  _dispCanManage = !!_dispDuty.canManage;

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Dispatch</div>' +
      '<div class="page-subtitle">' +
        (_dispCanManage ? 'Live board. Assign a call to whoever is ready and closest.'
                        : 'Your calls, and what the rest of the crew is on.') +
      '</div></div></div>' +
    '<div id="disp-duty"></div>' +
    '<div id="disp-body"></div>';

  dispRenderDuty();

  if (!_dispDuty.ready && !_dispCanManage) return dispRenderGate();
  await dispLoadBoard();

  _dispTimer = setInterval(function () {
    if (document.hidden) return;
    if (typeof state !== 'undefined' && state.currentView !== 'dispatch') { dispStop(); return; }
    dispLoadBoard();
  }, 20000);
}

// ---------------------------------------------------------------------------
//  The duty switch
// ---------------------------------------------------------------------------
function dispRenderDuty() {
  var host = document.getElementById('disp-duty');
  if (!host) return;
  var on = !!_dispDuty.ready;
  var h = _dispDuty.hours_on_duty;
  var longOn = on && h !== null && h >= DISP_LONG_HOURS;

  host.innerHTML =
    '<div class="disp-duty' + (on ? ' on' : '') + '">' +
      '<span class="disp-dutydot" style="background:' + (on ? '#22c55e' : '#71717a') + '"></span>' +
      '<div>' +
        '<div class="disp-dutytxt">' + (on ? 'Ready to accept calls' : 'Not accepting calls') + '</div>' +
        '<div class="disp-dutysub">' +
          (on
            ? ('On duty ' + dispHrs(h) + '. Dispatch can send you work and Nova is sharing your position.' +
               (longOn ? ' <span class="disp-warn">That is a long stretch - turn it off if you are done.</span>' : ''))
            : 'Nova is not recording your location. Turn this on when you start.') +
        '</div>' +
      '</div>' +
      '<button class="disp-big" style="background:' + (on ? '#ef4444' : '#22c55e') + '" onclick="dispToggleDuty()">' +
        (on ? 'Stop accepting calls' : 'Ready to accept calls') +
      '</button>' +
    '</div>';
}

async function dispToggleDuty() {
  var want = !_dispDuty.ready;
  try { _dispDuty = Object.assign(_dispDuty, await api('POST', '/dispatch/duty', { ready: want })); }
  catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not change your status.', 'error');
    return;
  }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  // Start or stop the browser location watcher to match, so the switch really
  // means what it says instead of only being a flag on the server.
  try {
    if (_dispDuty.ready) { if (typeof novaLocStart === 'function') novaLocStart(true); }
    else if (typeof novaLocStop === 'function') novaLocStop();
  } catch (e) {}
  if (typeof render === 'function') render();
}

function dispRenderGate() {
  var body = document.getElementById('disp-body');
  if (!body) return;
  body.innerHTML =
    '<div class="disp-gate">' +
      '<h3>The board opens when you do</h3>' +
      '<p>Calls, addresses and customer details stay hidden until you are ready to accept work. ' +
         'Tap the green button above when you start your day, and turn it off when you are done.</p>' +
      '<div id="disp-loc" style="text-align:left"></div>' +
    '</div>';
  if (typeof novaLocCard === 'function') novaLocCard(document.getElementById('disp-loc'));
}

// ---------------------------------------------------------------------------
//  The board
// ---------------------------------------------------------------------------
async function dispLoadBoard() {
  var body = document.getElementById('disp-body');
  if (!body) return;
  var data, crew = { people: [] };
  try {
    data = await api('GET', '/dispatch/jobs' + (_dispShowDone ? '?done=1' : ''));
    crew = await api('GET', '/dispatch/duty/all');
  } catch (e) {
    body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message || 'Could not load the board.') + '</div></div>';
    return;
  }
  _dispJobs = data.jobs || [];
  _dispCanManage = !!data.canManage;
  _dispCanAssign = !!data.canAssign;
  if (data.acceptTimeoutMinutes) _dispAcceptMins = data.acceptTimeoutMinutes;
  _dispCrew = crew.people || [];
  dispSoundForChanges(_dispJobs);
  dispReportViews(_dispJobs);
  if (_dispCanManage && !_dispCities.length) {
    try { _dispCities = await api('GET', '/cities'); } catch (e) { _dispCities = []; }
  }
  var me = data.me;
  _dispMe = me;

  var mine = _dispJobs.filter(function (j) { return j.assigned_to === me; });
  var others = _dispJobs.filter(function (j) { return j.assigned_to !== me; });

  body.innerHTML =
    '<div class="disp-cols">' +
      '<div class="disp-main">' +
        (_dispCanManage
          ? '<div style="display:flex;gap:9px;flex-wrap:wrap;margin-bottom:12px">' +
              '<button class="disp-btn go" onclick="dispNewJob()">New call</button>' +
              '<button class="disp-btn" onclick="dispToggleDone()">' + (_dispShowDone ? 'Hide closed' : 'Show closed (7 days)') + '</button>' +
              '<button class="disp-btn" onclick="dispToggleSound()">' + (dispSoundOn() ? 'Sound on' : 'Sound off') + '</button>' +
            '</div>'
          : '') +
        (mine.length ? '<div class="disp-sec">Your calls</div>' + mine.map(function (j) { return dispJobHtml(j, true); }).join('') : '') +
        '<div class="disp-sec">' + (mine.length ? 'Everyone else' : 'All calls') + '</div>' +
        (others.length ? others.map(function (j) { return dispJobHtml(j, false); }).join('')
                       : '<div class="text-muted" style="padding:10px 2px">Nothing on the board.</div>') +
      '</div>' +
      '<div class="disp-side">' +
        '<div class="disp-sec" style="margin-top:0">Who is ready</div>' +
        dispCrewHtml() +
      '</div>' +
    '</div>';
}


// Tell the server which calls actually reached this person's screen. Sent once
// per call per session: the point is proving they saw it, not counting refreshes.
function dispReportViews(jobs) {
  var fresh = jobs.map(function (j) { return j.id; }).filter(function (id) { return !_dispSeenIds[id]; });
  if (!fresh.length) return;
  fresh.forEach(function (id) { _dispSeenIds[id] = 1; });
  api('POST', '/dispatch/viewed', { ids: fresh }).catch(function () {
    // If it did not land, let it be retried on the next board load.
    fresh.forEach(function (id) { delete _dispSeenIds[id]; });
  });
}

// "Seen 9:02 by Mike" is the line that settles an argument about whether a call
// was ever noticed. Dispatch sees the whole list; a tech sees only their own.
function dispViewsLine(j) {
  if (!j.views || !j.views.length) {
    return j.assigned_to ? '<div class="disp-muted disp-warn">Not opened yet</div>' : '';
  }
  var list = _dispCanManage ? j.views : j.views.filter(function (v) { return v.user_id === _dispMe; });
  if (!list.length) return '';
  return '<div class="disp-muted">Seen ' + list.map(function (v) {
    return escHtml(v.name.split(' ')[0]) + ' ' + dispClock(v.first_at) + (v.views > 1 ? ' (' + v.views + 'x)' : '');
  }).join(', ') + '</div>';
}

function dispClock(t) {
  try { return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}


function dispToggleSound() {
  var on = !dispSoundOn();
  dispSetSound(on);
  if (on) { dispArmAudio(); dispSoundNewCall(); }   // let them hear what they just turned on
  dispLoadBoard();
}

function dispToggleDone() { _dispShowDone = !_dispShowDone; dispLoadBoard(); }

function dispJobHtml(j, isMine) {
  var st = DISP_STATUS[j.status] || DISP_STATUS.new;
  var lateAccept = dispAcceptOverdue(j);
  var bits = [];

  bits.push('<div class="disp-jobhead">' +
    '<span class="disp-chip" style="background:' + st.color + '22;color:' + st.color + '">' + st.label + '</span>' +
    (j.priority === 'urgent' ? '<span class="disp-chip" style="background:#ef444422;color:#ef4444">Urgent</span>' : '') +
    (lateAccept ? '<span class="disp-chip" style="background:#f59e0b22;color:#f59e0b">No answer ' + _dispAcceptMins + 'm</span>' : '') +
    (j.unassigned_alert_at ? '<span class="disp-chip" style="background:#ef444422;color:#ef4444">Sitting</span>' : '') +
    '<span class="disp-num">' + escHtml(j.job_number || ('#' + j.id)) + '</span>' +
    (j.city_name ? '<span class="disp-num">' + escHtml(j.city_name) + '</span>' : '') +
    '</div>');

  bits.push('<div class="disp-cust" style="margin-top:6px">' + escHtml(j.customer_name || 'No name given') + '</div>');
  if (j.service_type) bits.push('<div class="disp-line">' + escHtml(j.service_type) + '</div>');
  if (j.address) {
    var q = encodeURIComponent([j.address, j.city_state_zip].filter(Boolean).join(', '));
    bits.push('<div class="disp-line"><a href="https://www.google.com/maps/search/?api=1&query=' + q +
      '" target="_blank" rel="noopener">' + escHtml([j.address, j.city_state_zip].filter(Boolean).join(', ')) + '</a></div>');
  }
  // The number itself is NOT here for a tech - see stripPhone() on the server.
  // Managers get it as text because dispatch reads numbers back all day.
  if (j.customer_phone) {
    bits.push('<div class="disp-line"><a href="tel:' + escHtml(j.customer_phone) + '">' + escHtml(j.customer_phone) + '</a></div>');
  }
  if (j.notes) bits.push('<div class="disp-muted">' + escHtml(j.notes) + '</div>');
  bits.push('<div class="disp-muted">' + (j.assigned_name ? 'Tech: ' + escHtml(j.assigned_name) : 'Nobody assigned yet') + '</div>');
  if (j.status === 'goa' && j.goa_note) bits.push('<div class="disp-muted">GOA: ' + escHtml(j.goa_note) + '</div>');
  bits.push(dispViewsLine(j));
  bits.push(dispTimesLine(j));

  var acts = [];
  if (isMine && DISP_NEXT[j.status]) {
    var nx = DISP_NEXT[j.status];
    acts.push('<button class="disp-btn go" onclick="dispAdvance(' + j.id + ',&quot;' + nx.to + '&quot;)">' + nx.label + '</button>');
  }
  // Calling never shows the number. The button asks the server for it, the
  // server writes down that this person asked, and then the phone dials.
  if (j.has_phone || j.customer_phone) {
    acts.push('<button class="disp-btn" onclick="dispCallCustomer(' + j.id + ')">Call customer</button>');
  }
  if (isMine && DISP_GOA_FROM.indexOf(j.status) !== -1) {
    acts.push('<button class="disp-btn" onclick="dispGoa(' + j.id + ')">GOA</button>');
  }
  if (_dispCanAssign) {
    acts.push('<button class="disp-btn" onclick="dispAssign(' + j.id + ')">' + (j.assigned_to ? 'Reassign' : 'Assign') + '</button>');
  }
  if (_dispCanManage && j.status !== 'done' && j.status !== 'cancelled' && j.status !== 'goa') {
    acts.push('<button class="disp-btn" onclick="dispCancel(' + j.id + ')">Cancel</button>');
  }
  if (acts.length) bits.push('<div class="disp-acts">' + acts.join('') + '</div>');

  return '<div class="disp-job' + (isMine ? ' mine' : '') +
    (j.priority === 'urgent' ? ' urgent' : '') +
    (lateAccept ? ' late' : '') + '">' + bits.join('') + '</div>';
}

// The timeline, in the order it happened, only showing what has happened.
function dispTimesLine(j) {
  var parts = [];
  if (j.assigned_at) parts.push('sent ' + dispClock(j.assigned_at));
  if (j.accepted_at) parts.push('accepted ' + dispClock(j.accepted_at));
  if (j.enroute_at) parts.push('rolling ' + dispClock(j.enroute_at));
  if (j.arrived_at) parts.push('arrived ' + dispClock(j.arrived_at));
  if (j.completed_at) parts.push('done ' + dispClock(j.completed_at));
  if (j.goa_at) parts.push('GOA ' + dispClock(j.goa_at));
  return parts.length ? '<div class="disp-muted">' + parts.join(' &middot; ') + '</div>' : '';
}

async function dispCallCustomer(id) {
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/call', {}); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'No number on this call.', 'error'); return; }
  if (!r || !r.phone) return;
  window.location.href = 'tel:' + String(r.phone).replace(/[^0-9+]/g, '');
}

async function dispGoa(id) {
  var note = await novaPrompt('Mark this call Gone On Arrival. Anything worth noting?');
  if (note === null) return;
  try { await api('POST', '/dispatch/jobs/' + id + '/status', { status: 'goa', note: note }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

function dispCrewHtml() {
  var ready = _dispCrew.filter(function (p) { return p.ready; });
  var off = _dispCrew.filter(function (p) { return !p.ready; });
  var html = '';
  if (!ready.length) html += '<div class="text-muted" style="padding:6px 2px;font-size:13px">Nobody is accepting calls right now.</div>';
  html += ready.map(function (p) {
    var longOn = p.hours_on_duty !== null && p.hours_on_duty >= DISP_LONG_HOURS;
    return '<div class="disp-crew">' +
      '<div class="disp-crewname"><span class="disp-dutydot" style="width:9px;height:9px;background:#22c55e"></span>' + escHtml(p.name) + '</div>' +
      '<div class="disp-muted">Ready ' + dispHrs(p.hours_on_duty) +
        (longOn ? ' <span class="disp-warn">- probably forgot</span>' : '') +
        (p.home_city ? ' &middot; ' + escHtml(p.home_city) : '') + '</div>' +
      (_dispCanManage ? '<div class="disp-acts"><button class="disp-btn" onclick="dispClearDuty(' + p.user_id + ')">Mark not ready</button></div>' : '') +
      '</div>';
  }).join('');
  if (off.length) {
    html += '<div class="disp-sec">Off duty</div>' +
      off.map(function (p) {
        return '<div class="disp-crew"><div class="disp-crewname">' +
          '<span class="disp-dutydot" style="width:9px;height:9px;background:#52525b"></span>' + escHtml(p.name) + '</div></div>';
      }).join('');
  }
  return html;
}

async function dispAdvance(id, to) {
  try { await api('POST', '/dispatch/jobs/' + id + '/status', { status: to }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message || 'Could not update that call.', 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

async function dispClearDuty(userId) {
  if (!(await novaConfirm('Mark this person as not accepting calls? Their location tracking stops too.'))) return;
  try { await api('POST', '/dispatch/duty/' + userId + '/clear', {}); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

async function dispCancel(id) {
  var reason = await novaPrompt('Why is this call being cancelled?');
  if (reason === null) return;
  try { await api('POST', '/dispatch/jobs/' + id + '/cancel', { reason: reason }); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

// ---------------------------------------------------------------------------
//  New call / assign
// ---------------------------------------------------------------------------
function dispNewJob() {
  var cities = _dispCities || [];
  var cityOpts = '<option value="">City...</option>' + cities.map(function (c) {
    return '<option value="' + escHtml((c.code || '').trim()) + '">' + escHtml(c.name) + '</option>';
  }).join('');
  var techOpts = '<option value="">Assign later</option>' +
    _dispCrew.map(function (p) {
      return '<option value="' + p.user_id + '">' + escHtml(p.name) + (p.ready ? ' (ready)' : ' (off duty)') + '</option>';
    }).join('');

  dispModal('New call',
    '<div class="form-group"><label>Customer</label><input id="dj-name" placeholder="Name on the call"></div>' +
    '<div class="form-group"><label>Phone</label><input id="dj-phone" placeholder="(555) 555-5555"></div>' +
    '<div class="form-group"><label>Service</label><input id="dj-service" placeholder="Lockout, jump start, key made..."></div>' +
    '<div class="form-group"><label>Address</label><input id="dj-addr" placeholder="Street address"></div>' +
    '<div class="form-group"><label>City / State / Zip</label><input id="dj-csz" placeholder="Charleston, SC 29401"></div>' +
    '<div style="display:flex;gap:10px">' +
      '<div class="form-group" style="flex:1"><label>Our city</label><select id="dj-city">' + cityOpts + '</select></div>' +
      '<div class="form-group" style="flex:1"><label>Priority</label><select id="dj-pri">' +
        '<option value="normal">Normal</option><option value="urgent">Urgent</option><option value="low">Low</option>' +
      '</select></div>' +
    '</div>' +
    '<div class="form-group"><label>Send to</label><select id="dj-tech">' + techOpts + '</select></div>' +
    '<div class="form-group"><label>Notes</label><textarea id="dj-notes" rows="3" placeholder="Gate code, vehicle, anything the tech needs"></textarea></div>',
    'Create call', dispSaveJob);
}

async function dispSaveJob() {
  function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  var body = {
    customer_name: v('dj-name'), customer_phone: v('dj-phone'), service_type: v('dj-service'),
    address: v('dj-addr'), city_state_zip: v('dj-csz'), city_code: v('dj-city'),
    priority: v('dj-pri'), notes: v('dj-notes')
  };
  var tech = v('dj-tech');
  if (tech) body.assigned_to = parseInt(tech, 10);
  if (!body.customer_name && !body.address) {
    if (typeof showToast === 'function') showToast('Give the call a customer name or an address.', 'error');
    return;
  }
  try { await api('POST', '/dispatch/jobs', body); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  dispCloseModal();
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}

function dispAssign(id) {
  var opts = '<option value="">Nobody (put it back on the board)</option>' +
    _dispCrew.map(function (p) {
      return '<option value="' + p.user_id + '">' + escHtml(p.name) + (p.ready ? ' (ready)' : ' (off duty)') + '</option>';
    }).join('');
  dispModal('Assign call',
    '<div class="form-group"><label>Send to</label><select id="dj-assign">' + opts + '</select></div>' +
    '<div class="text-muted" style="font-size:12px">A tech who is off duty will not see the call ' +
      'and is not sharing their location.</div>',
    'Assign', function () { dispSaveAssign(id); });
}

async function dispSaveAssign(id) {
  var e = document.getElementById('dj-assign');
  var uid = e && e.value ? parseInt(e.value, 10) : null;
  var r;
  try { r = await api('POST', '/dispatch/jobs/' + id + '/assign', { user_id: uid }); }
  catch (err) { if (typeof showToast === 'function') showToast(err.message, 'error'); return; }
  dispCloseModal();
  if (r && r.warning && typeof showToast === 'function') showToast(r.warning, 'error');
  if (typeof apiBustCache === 'function') apiBustCache('/dispatch');
  dispLoadBoard();
}
