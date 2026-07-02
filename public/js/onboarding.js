// public/js/onboarding.js
// Onboarding module frontend: the locked new-hire track (renderOnboardingMode)
// and the admin path builder + progress dashboard (renderOnboardingAdmin).
// No backticks in this file. Apostrophes inside HTML strings use &#39;.

(function () {
  'use strict';

  var CSS = '' +
    '.onb-wrap{max-width:780px;margin:0 auto;padding:28px 16px 60px}' +
    '.onb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;flex-wrap:wrap}' +
    '.onb-logo{font-size:22px;font-weight:800;color:var(--primary,#f97316);letter-spacing:0.5px}' +
    '.onb-title{font-size:26px;font-weight:800;margin:18px 0 4px}' +
    '.onb-sub{color:var(--text-muted-color,#9ca3af);font-size:14px;margin-bottom:18px}' +
    '.onb-bar{height:10px;border-radius:6px;background:var(--bg-card,#1c1c1c);overflow:hidden;margin:14px 0 22px;border:1px solid var(--border,#2a2a2a)}' +
    '.onb-bar>div{height:100%;background:var(--primary,#f97316);border-radius:6px;transition:width .6s cubic-bezier(.34,1.2,.64,1)}' +
    '.onb-steps{display:flex;flex-direction:column;gap:8px;margin-bottom:24px}' +
    '.onb-step{display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;border:1px solid var(--border,#2a2a2a);background:var(--bg-card,#161616);font-size:14px}' +
    '.onb-step.done{opacity:.65}' +
    '.onb-step.current{border-color:var(--primary,#f97316);box-shadow:0 0 0 1px var(--primary,#f97316)}' +
    '.onb-step.locked{opacity:.4}' +
    '.onb-dot{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a)}' +
    '.onb-step.done .onb-dot{background:#16a34a;border-color:#16a34a;color:#fff}' +
    '.onb-step.current .onb-dot{background:var(--primary,#f97316);border-color:var(--primary,#f97316);color:#111}' +
    '.onb-card{border:1px solid var(--border,#2a2a2a);background:var(--bg-card,#161616);border-radius:14px;padding:22px}' +
    '.onb-card h2{margin:0 0 6px;font-size:19px}' +
    '.onb-desc{color:var(--text-muted-color,#9ca3af);font-size:14px;margin-bottom:16px}' +
    '.onb-btn{background:var(--primary,#f97316);color:#111;border:none;border-radius:8px;padding:12px 22px;font-size:15px;font-weight:700;cursor:pointer}' +
    '.onb-btn:disabled{opacity:.45;cursor:not-allowed}' +
    '.onb-btn.ghost{background:transparent;color:var(--text-muted-color,#9ca3af);border:1px solid var(--border,#2a2a2a);font-weight:600}' +
    '.onb-sop{max-height:420px;overflow:auto;white-space:pre-wrap;background:var(--bg,#0f0f0f);border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:16px;font-size:14px;line-height:1.6;margin-bottom:14px}' +
    '.onb-q{border:1px solid var(--border,#2a2a2a);border-radius:10px;padding:14px;margin-bottom:12px}' +
    '.onb-q .p{font-weight:600;margin-bottom:10px}' +
    '.onb-q label{display:block;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px}' +
    '.onb-q label:hover{background:var(--bg,#0f0f0f)}' +
    '.onb-q.good{border-color:#16a34a}.onb-q.bad{border-color:#ef4444}' +
    '.onb-video{width:100%;border-radius:10px;background:#000;max-height:430px;margin-bottom:14px}' +
    '.onb-note{font-size:13px;color:var(--text-muted-color,#9ca3af);margin-top:10px}' +
    '.onb-cele{position:fixed;inset:0;background:var(--bg,#0f0f0f);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999;overflow:hidden}' +
    '.onb-cele h1{font-size:42px;margin:10px 0 6px}' +
    '.onb-conf{position:absolute;top:-20px;width:10px;height:16px;border-radius:2px;animation:onbFall linear forwards}' +
    '@keyframes onbFall{to{transform:translateY(110vh) rotate(720deg)}}' +
    '.onb-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.4px}' +
    '.onb-pill.ready{background:#dcfce7;color:#15803d}' +
    '.onb-pill.busy{background:#fff3e8;color:#c2520a}';

  function injectCss() {
    if (document.getElementById('onb-css')) return;
    var st = document.createElement('style');
    st.id = 'onb-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  function stepIcon(t) {
    if (t === 'video') return '🎬';
    if (t === 'sop_read') return '📘';
    if (t === 'quiz') return '❓';
    return '📌';
  }
  function clearPoll() { if (window._onbPoll) { clearInterval(window._onbPoll); window._onbPoll = null; } }
  function firstName(n) { return String(n || '').split(' ')[0]; }

  // ============================ NEW-HIRE TRACK =============================

  window.renderOnboardingMode = async function (app) {
    injectCss(); clearPoll();
    var data;
    try { data = await api('GET', '/onboarding/me'); }
    catch (e) { app.innerHTML = '<div class="onb-wrap"><div class="onb-card">Could not load onboarding: ' + escHtml(e.message || '') + '</div></div>'; return; }

    if (data.onboarding_status === 'complete') { return renderOnbCelebration(app); }

    var total = (data.steps || []).length;
    var done = (data.steps || []).filter(function (s) { return s.status === 'done'; }).length;
    var pct = total ? Math.round((done / total) * 100) : 0;

    var stepsHtml = (data.steps || []).map(function (s, i) {
      var mark = s.status === 'done' ? '✓' : (i + 1);
      return '<div class="onb-step ' + s.status + '"><div class="onb-dot">' + mark + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-weight:600">' + stepIcon(s.type) + ' ' + escHtml(s.title) + '</div></div>' +
        (s.status === 'done' && s.score != null ? '<span class="onb-note">' + s.score + '%</span>' : '') +
        '</div>';
    }).join('');

    var body;
    if (data.all_steps_done) {
      body = '<div class="onb-card" style="text-align:center">' +
        '<div style="font-size:42px;margin-bottom:8px">🕐</div>' +
        '<h2>All steps complete!</h2>' +
        '<div class="onb-desc">Waiting on ' + escHtml(data.supervisor_name || 'your supervisor') + ' to sign off. We told them you are ready — the moment they approve, Nova unlocks for you.</div>' +
        '<div class="onb-note">This screen checks automatically every 20 seconds.</div>' +
        '</div>';
    } else if (data.current) {
      body = renderOnbCurrent(data.current);
    } else {
      body = '<div class="onb-card"><h2>Nothing to do yet</h2><div class="onb-desc">Your onboarding path has no steps. Check back soon, or ask your manager.</div></div>';
    }

    app.innerHTML =
      '<div class="onb-wrap">' +
        '<div class="onb-head">' +
          '<span class="onb-logo">Nova</span>' +
          '<span style="display:flex;gap:8px">' +
            '<button class="onb-btn ghost" onclick="onbToggleClock()">🕐 Time Clock</button>' +
            '<button class="onb-btn ghost" onclick="logout()">Sign out</button>' +
          '</span>' +
        '</div>' +
        '<div id="onb-clock" style="display:none;margin-bottom:18px"></div>' +
        '<div class="onb-title">Welcome, ' + escHtml(firstName(data.name)) + ' 👋</div>' +
        '<div class="onb-sub">Let&#39;s get you set up. Work through each step — Nova unlocks when you finish and ' + escHtml(data.supervisor_name || 'your supervisor') + ' signs off.</div>' +
        '<div class="onb-bar"><div style="width:' + pct + '%"></div></div>' +
        '<div class="onb-note" style="margin:-14px 0 16px">' + done + ' of ' + total + ' steps complete</div>' +
        '<div class="onb-steps">' + stepsHtml + '</div>' +
        '<div id="onb-body">' + body + '</div>' +
      '</div>';

    if (data.all_steps_done) {
      window._onbPoll = setInterval(async function () {
        try {
          var d = await api('GET', '/onboarding/me');
          if (d.onboarding_status === 'complete') { clearPoll(); renderOnbCelebration(document.getElementById('app')); }
        } catch (e) {}
      }, 20000);
    } else if (data.current) {
      onbStartTimers(data.current);
    }
  };

  function renderOnbCurrent(cur) {
    var inner = '';
    if (cur.type === 'video') {
      inner = (cur.video_url
          ? '<video class="onb-video" controls playsinline preload="metadata" src="' + escHtml(cur.video_url) + '"></video>'
          : '<div class="onb-note">' + escHtml(cur.video_error || 'Video unavailable — tell your manager.') + '</div>') +
        '<button class="onb-btn" id="onb-continue" disabled onclick="onbCompleteStep(' + cur.id + ')">Continue</button>' +
        '<div class="onb-note" id="onb-timer-note"></div>';
    } else if (cur.type === 'sop_read') {
      inner = '<div class="onb-sop" id="onb-sop">' + escHtml(cur.sop_content || 'This SOP has no text.') + '</div>' +
        '<button class="onb-btn" id="onb-continue" disabled onclick="onbCompleteStep(' + cur.id + ')">Mark as read</button>' +
        '<div class="onb-note" id="onb-timer-note">Read to the bottom to continue.</div>';
    } else if (cur.type === 'quiz') {
      inner = '<div id="onb-quiz">' +
        '<div class="onb-note" style="margin-bottom:14px">Pass mark: <b>' + (cur.pass_score || 80) + '%</b>' + (cur.attempts ? ' · Attempts so far: ' + cur.attempts : '') + '. You can retry as many times as you need — the questions change every time.</div>' +
        '<button class="onb-btn" onclick="onbStartQuiz(' + cur.id + ')">' + (cur.attempts ? 'Try again with fresh questions' : 'Start the quiz') + '</button>' +
        '</div>';
    }
    return '<div class="onb-card"><h2>' + stepIcon(cur.type) + ' ' + escHtml(cur.title) + '</h2>' +
      (cur.description ? '<div class="onb-desc">' + escHtml(cur.description) + '</div>' : '') + inner + '</div>';
  }

  function onbStartTimers(cur) {
    var btn = document.getElementById('onb-continue');
    if (!btn) return;
    var waitLeft = cur.min_seconds || 0;
    var scrolled = cur.type !== 'sop_read';
    var note = document.getElementById('onb-timer-note');
    var sop = document.getElementById('onb-sop');
    if (sop) {
      if (sop.scrollHeight <= sop.clientHeight + 8) scrolled = true;
      sop.addEventListener('scroll', function () {
        if (sop.scrollTop + sop.clientHeight >= sop.scrollHeight - 12) { scrolled = true; refresh(); }
      });
    }
    function refresh() {
      if (waitLeft <= 0 && scrolled) {
        btn.disabled = false;
        if (note) note.textContent = '';
      } else if (note) {
        var bits = [];
        if (waitLeft > 0) bits.push(waitLeft + 's');
        if (!scrolled) bits.push('read to the bottom');
        note.textContent = 'Continue unlocks in: ' + bits.join(' · ');
      }
    }
    refresh();
    if (waitLeft > 0) {
      var iv = setInterval(function () {
        waitLeft--;
        if (waitLeft <= 0) clearInterval(iv);
        refresh();
      }, 1000);
    }
  }

  window.onbCompleteStep = async function (id) {
    try { await api('POST', '/onboarding/steps/' + id + '/complete', {}); showToast('Step complete!', 'success'); renderOnboardingMode(document.getElementById('app')); }
    catch (e) { showToast(e.message || 'Could not complete step.', 'error'); }
  };

  window.onbStartQuiz = async function (stepId) {
    var box = document.getElementById('onb-quiz');
    if (box) box.innerHTML = '<div class="onb-note">Writing your questions…</div>';
    var qz;
    try { qz = await api('POST', '/onboarding/steps/' + stepId + '/quiz/start', {}); }
    catch (e) { if (box) box.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Quiz failed to load.') + '</div><button class="onb-btn" style="margin-top:10px" onclick="onbStartQuiz(' + stepId + ')">Try again</button>'; return; }
    window._onbAttempt = qz;
    var html = qz.questions.map(function (q) {
      return '<div class="onb-q" id="onb-q-' + q.n + '"><div class="p">' + (q.n + 1) + '. ' + escHtml(q.prompt) + '</div>' +
        q.options.map(function (o, oi) {
          return '<label><input type="radio" name="onbq' + q.n + '" value="' + oi + '" style="margin-right:8px">' + escHtml(o) + '</label>';
        }).join('') + '</div>';
    }).join('');
    if (box) box.innerHTML = html +
      '<button class="onb-btn" onclick="onbSubmitQuiz(' + qz.attempt_id + ',' + qz.questions.length + ',' + stepId + ')">Submit answers</button>' +
      '<div class="onb-note" id="onb-quiz-note"></div>';
  };

  window.onbSubmitQuiz = async function (attemptId, count, stepId) {
    var answers = [];
    for (var i = 0; i < count; i++) {
      var sel = document.querySelector('input[name="onbq' + i + '"]:checked');
      if (!sel) { var nn = document.getElementById('onb-quiz-note'); if (nn) nn.textContent = 'Answer every question first.'; return; }
      answers.push(parseInt(sel.value, 10));
    }
    var r;
    try { r = await api('POST', '/onboarding/quiz-attempts/' + attemptId + '/submit', { answers: answers }); }
    catch (e) { showToast(e.message || 'Submit failed.', 'error'); return; }
    (r.results || []).forEach(function (res) {
      var el = document.getElementById('onb-q-' + res.n);
      if (el) el.className = 'onb-q ' + (res.correct ? 'good' : 'bad');
    });
    var note = document.getElementById('onb-quiz-note');
    if (r.passed) {
      if (note) note.innerHTML = '<b style="color:#16a34a">Passed with ' + r.score + '%!</b> Moving on…';
      setTimeout(function () { renderOnboardingMode(document.getElementById('app')); }, 1600);
    } else {
      if (note) note.innerHTML = '<b style="color:#ef4444">' + r.score + '%</b> — you need ' + r.need + '%. No sweat: retry with a fresh set of questions.';
      var box = document.getElementById('onb-quiz');
      if (box) {
        var btn = document.createElement('button');
        btn.className = 'onb-btn';
        btn.style.marginTop = '10px';
        btn.textContent = 'Try again with fresh questions';
        btn.onclick = function () { onbStartQuiz(stepId); };
        box.appendChild(btn);
      }
    }
  };

  window.onbToggleClock = function () {
    var el = document.getElementById('onb-clock');
    if (!el) return;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      el.innerHTML = '<div class="onb-card"><div class="loading">Loading…</div></div>';
      try { renderTimeClock(el.firstChild); } catch (e) { el.firstChild.innerHTML = 'Time clock unavailable: ' + escHtml(e.message || ''); }
    } else {
      el.style.display = 'none';
    }
  };

  function renderOnbCelebration(app) {
    injectCss(); clearPoll();
    if (state && state.user) {
      state.user.onboarding_status = 'complete';
      try { localStorage.setItem('po_user', JSON.stringify(state.user)); } catch (e) {}
    }
    var conf = '';
    var colors = ['#f97316', '#fbbf24', '#22c55e', '#3b82f6', '#ec4899', '#a78bfa'];
    for (var i = 0; i < 70; i++) {
      conf += '<div class="onb-conf" style="left:' + (Math.random() * 100) + 'vw;background:' + colors[i % colors.length] +
        ';animation-duration:' + (2.4 + Math.random() * 2.6) + 's;animation-delay:' + (Math.random() * 1.8) + 's"></div>';
    }
    app.innerHTML = '<div class="onb-cele">' + conf +
      '<div style="font-size:64px">🎉</div>' +
      '<h1>You&#39;re in!</h1>' +
      '<div class="onb-sub" style="text-align:center;max-width:420px">Onboarding complete. Welcome to the Lock and Roll team — the full Nova app is now yours.</div>' +
      '<button class="onb-btn" style="margin-top:18px;font-size:17px;padding:14px 34px" onclick="onbEnterNova()">Enter Nova →</button>' +
      '</div>';
  }
  window.onbEnterNova = function () {
    clearPoll();
    state.currentView = 'home';
    render();
  };

  // ============================ ADMIN VIEW =================================

  window.renderOnboardingAdmin = async function (content) {
    injectCss(); clearPoll();
    window._onbTab = window._onbTab || 'hires';
    var tabs = '<div style="display:flex;gap:8px;margin-bottom:18px">' +
      '<button class="onb-btn' + (window._onbTab === 'hires' ? '' : ' ghost') + '" onclick="onbTab(\'hires\')">New Hires</button>' +
      '<button class="onb-btn' + (window._onbTab === 'path' ? '' : ' ghost') + '" onclick="onbTab(\'path\')">Onboarding Path</button>' +
      '</div>';
    content.innerHTML = '<h1 style="margin-bottom:14px">Onboarding</h1>' + tabs + '<div id="onb-admin-body"><div class="loading">Loading…</div></div>';
    var body = document.getElementById('onb-admin-body');
    if (window._onbTab === 'hires') await onbAdminHires(body);
    else await onbAdminPath(body);
  };
  window.onbTab = function (t) { window._onbTab = t; renderOnboardingAdmin(document.getElementById('content')); };

  async function onbAdminHires(body) {
    var data, users = [];
    try { data = await api('GET', '/onboarding/admin/progress'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { users = await api('GET', '/users'); } catch (e) {}
    var inOnb = {};
    (data.users || []).forEach(function (u) { inOnb[u.id] = true; });
    var opts = (users || []).filter(function (u) { return u.active !== false && !inOnb[u.id] && u.role !== 'owner'; })
      .map(function (u) { return '<option value="' + u.id + '">' + escHtml(u.name) + '</option>'; }).join('');

    var rows = (data.users || []).map(function (u) {
      var pct = u.steps_total ? Math.round((u.steps_done / u.steps_total) * 100) : 0;
      return '<tr>' +
        '<td><b>' + escHtml(u.name) + '</b><br><span class="onb-note">' + escHtml(u.supervisor_name ? 'Reports to ' + u.supervisor_name : 'No supervisor set') + '</span></td>' +
        '<td style="min-width:140px"><div class="onb-bar" style="margin:0 0 4px"><div style="width:' + pct + '%"></div></div><span class="onb-note">' + u.steps_done + ' / ' + u.steps_total + '</span></td>' +
        '<td>' + (u.ready_for_signoff ? '<span class="onb-pill ready">READY FOR SIGN-OFF</span>' : '<span class="onb-pill busy">' + escHtml(u.current_step || 'Not started') + '</span>') + '</td>' +
        '<td style="white-space:nowrap">' +
          (u.ready_for_signoff && u.can_sign_off ? '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbSignOff(' + u.id + ',\'' + escHtml(u.name).replace(/'/g, '') + '\')">Sign off &amp; unlock</button> ' : '') +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbDetail(' + u.id + ')">Details</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbRemove(' + u.id + ')">Remove</button>' +
        '</td></tr>' +
        '<tr id="onb-detail-' + u.id + '" style="display:none"><td colspan="4"></td></tr>';
    }).join('');

    body.innerHTML =
      '<div class="onb-card" style="margin-bottom:18px"><h2>Enroll someone</h2>' +
      '<div class="onb-desc">Enrolling locks their account to the onboarding track until every step is done and a supervisor signs off. They keep time clock access.</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<select id="onb-enroll-user" style="flex:1;min-width:200px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (opts || '<option value="">No one available</option>') + '</select>' +
      '<button class="onb-btn" onclick="onbEnroll()">Enroll</button></div></div>' +
      ((data.users || []).length
        ? '<div class="onb-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse" class="onb-table"><thead><tr><th style="text-align:left;padding:12px 14px">New hire</th><th style="text-align:left;padding:12px 14px">Progress</th><th style="text-align:left;padding:12px 14px">Status</th><th style="text-align:left;padding:12px 14px">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="onb-card"><div class="onb-desc" style="margin:0">Nobody is in onboarding right now.</div></div>');
  }

  window.onbEnroll = async function () {
    var sel = document.getElementById('onb-enroll-user');
    if (!sel || !sel.value) return;
    if (!window.confirm('Enroll this person? Their Nova access is locked to the onboarding track until sign-off.')) return;
    try { await api('POST', '/onboarding/admin/enroll', { user_id: parseInt(sel.value, 10) }); showToast('Enrolled.', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Enroll failed.', 'error'); }
  };
  window.onbSignOff = async function (id, name) {
    if (!window.confirm('Sign off ' + name + '? This unlocks full Nova access for them immediately.')) return;
    try { await api('POST', '/onboarding/admin/users/' + id + '/signoff', {}); showToast(name + ' is unlocked. 🎉', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Sign-off failed.', 'error'); }
  };
  window.onbRemove = async function (id) {
    if (!window.confirm('Remove them from onboarding? Their full access unlocks WITHOUT sign-off.')) return;
    try { await api('POST', '/onboarding/admin/users/' + id + '/remove', {}); showToast('Removed from onboarding.', 'info'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
  window.onbDetail = async function (id) {
    var row = document.getElementById('onb-detail-' + id);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = '';
    row.firstChild.innerHTML = '<div class="onb-note" style="padding:10px 14px">Loading…</div>';
    try {
      var steps = await api('GET', '/onboarding/admin/users/' + id + '/detail');
      row.firstChild.innerHTML = '<div style="padding:8px 14px 14px">' + steps.map(function (s) {
        return '<div class="onb-note" style="padding:3px 0">' + (s.status === 'done' ? '✅' : '⬜') + ' ' + stepIcon(s.type) + ' ' + escHtml(s.title) +
          (s.score != null ? ' — best ' + s.score + '%' : '') + (s.attempts ? ' (' + s.attempts + ' attempt' + (s.attempts === 1 ? '' : 's') + ')' : '') + '</div>';
      }).join('') + '</div>';
    } catch (e) { row.firstChild.innerHTML = '<div class="onb-note" style="padding:10px 14px">' + escHtml(e.message || 'Failed') + '</div>'; }
  };

  async function onbAdminPath(body) {
    var steps = [], sops = [];
    try { steps = await api('GET', '/onboarding/admin/steps'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { sops = await api('GET', '/onboarding/admin/sops'); } catch (e) {}
    window._onbSteps = steps;
    var sopOpts = (sops || []).map(function (s) { return '<option value="' + s.id + '">' + escHtml(s.title) + '</option>'; }).join('');

    var rows = steps.map(function (s, i) {
      var meta = [];
      if (s.type === 'quiz') { var c = s.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = {}; } } meta.push((c.question_count || 3) + ' questions, pass ' + (c.pass_score || 80) + '%'); }
      if (s.sop_title) meta.push('SOP: ' + s.sop_title);
      return '<div class="onb-step" style="opacity:1">' +
        '<div class="onb-dot">' + (i + 1) + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-weight:600">' + stepIcon(s.type) + ' ' + escHtml(s.title) + '</div>' +
        (meta.length ? '<div class="onb-note">' + escHtml(meta.join(' · ')) + '</div>' : '') + '</div>' +
        '<button class="onb-btn ghost" style="padding:6px 10px" ' + (i === 0 ? 'disabled' : '') + ' onclick="onbMove(' + s.id + ',-1)">↑</button>' +
        '<button class="onb-btn ghost" style="padding:6px 10px" ' + (i === steps.length - 1 ? 'disabled' : '') + ' onclick="onbMove(' + s.id + ',1)">↓</button>' +
        '<button class="onb-btn ghost" style="padding:6px 10px" onclick="onbDeleteStep(' + s.id + ')">✕</button>' +
        '</div>';
    }).join('');

    body.innerHTML =
      '<div class="onb-steps">' + (rows || '<div class="onb-note">No steps yet — add the first one below.</div>') + '</div>' +
      '<div class="onb-note" style="margin:-8px 0 18px">The supervisor sign-off gate is automatic and always comes last — you do not add it as a step.</div>' +
      '<div class="onb-card"><h2>Add a step</h2>' +
      '<div style="display:grid;gap:10px;grid-template-columns:1fr 1fr">' +
      '<select id="onb-new-type" onchange="onbTypeFields()" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
        '<option value="video">Video</option><option value="sop_read">Read an SOP</option><option value="quiz">Quiz on an SOP</option></select>' +
      '<input id="onb-new-title" placeholder="Step title" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
      '<input id="onb-new-desc" placeholder="Short description (optional)" style="grid-column:1/-1;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
      '<div id="onb-f-sop" style="display:none;grid-column:1/-1"><select id="onb-new-sop" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (sopOpts || '<option value="">No SOPs uploaded yet</option>') + '</select></div>' +
      '<div id="onb-f-video" style="grid-column:1/-1"><input type="file" id="onb-new-video" accept="video/*" style="width:100%;color:var(--text)"><div class="onb-note" id="onb-vid-note"></div></div>' +
      '<div id="onb-f-quiz" style="display:none;grid-column:1/-1;display:none"><div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<label class="onb-note">Questions <input id="onb-new-qcount" type="number" min="1" max="10" value="3" style="width:70px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px"></label>' +
        '<label class="onb-note">Pass % <input id="onb-new-pass" type="number" min="1" max="100" value="80" style="width:70px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px"></label>' +
      '</div></div>' +
      '<label class="onb-note" style="grid-column:1/-1">Minimum seconds before Continue unlocks <input id="onb-new-min" type="number" min="0" max="7200" value="30" style="width:90px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px"></label>' +
      '</div>' +
      '<button class="onb-btn" style="margin-top:14px" id="onb-add-btn" onclick="onbAddStep()">Add step</button></div>';
    onbTypeFields();
  }

  window.onbTypeFields = function () {
    var t = (document.getElementById('onb-new-type') || {}).value;
    var f = function (id, show) { var el = document.getElementById(id); if (el) el.style.display = show ? 'block' : 'none'; };
    f('onb-f-sop', t === 'sop_read' || t === 'quiz');
    f('onb-f-video', t === 'video');
    f('onb-f-quiz', t === 'quiz');
  };

  window.onbAddStep = async function () {
    var t = document.getElementById('onb-new-type').value;
    var title = document.getElementById('onb-new-title').value.trim();
    if (!title) { showToast('Give the step a title.', 'error'); return; }
    var payload = { type: t, title: title, description: document.getElementById('onb-new-desc').value.trim(), min_seconds: parseInt(document.getElementById('onb-new-min').value, 10) || 0 };
    if (t === 'sop_read' || t === 'quiz') {
      payload.sop_id = parseInt((document.getElementById('onb-new-sop') || {}).value, 10);
      if (!payload.sop_id) { showToast('Pick an SOP.', 'error'); return; }
    }
    if (t === 'quiz') {
      payload.question_count = parseInt(document.getElementById('onb-new-qcount').value, 10) || 3;
      payload.pass_score = parseInt(document.getElementById('onb-new-pass').value, 10) || 80;
    }
    var btn = document.getElementById('onb-add-btn');
    if (t === 'video') {
      var fi = document.getElementById('onb-new-video');
      if (!fi || !fi.files || !fi.files.length) { showToast('Choose a video file.', 'error'); return; }
      var file = fi.files[0];
      var note = document.getElementById('onb-vid-note');
      try {
        btn.disabled = true;
        if (note) note.textContent = 'Getting upload link…';
        var up = await api('POST', '/onboarding/admin/video-upload-url', { name: file.name, mime_type: file.type || 'video/mp4' });
        if (note) note.textContent = 'Uploading ' + Math.round(file.size / 1048576) + ' MB…';
        var putRes = await fetch(up.uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'video/mp4' } });
        if (!putRes.ok) throw new Error('Upload failed (' + putRes.status + '). Check the R2 bucket CORS settings.');
        payload.video_key = up.key;
        if (note) note.textContent = 'Uploaded ✓';
      } catch (e) { btn.disabled = false; if (note) note.textContent = ''; showToast(e.message || 'Video upload failed.', 'error'); return; }
    }
    try { await api('POST', '/onboarding/admin/steps', payload); showToast('Step added.', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed to add step.', 'error'); }
    finally { if (btn) btn.disabled = false; }
  };

  window.onbMove = async function (id, dir) {
    var steps = window._onbSteps || [];
    var ids = steps.map(function (s) { return s.id; });
    var i = ids.indexOf(id);
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j >= ids.length) return;
    var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    try { await api('POST', '/onboarding/admin/steps/reorder', { ids: ids }); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Reorder failed.', 'error'); }
  };
  window.onbDeleteStep = async function (id) {
    if (!window.confirm('Remove this step from the path?')) return;
    try { await api('DELETE', '/onboarding/admin/steps/' + id); showToast('Step removed.', 'info'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
})();
