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
    '.onb-q label{display:block;background:#1f1f1f;border:1px solid #333;border-radius:8px;padding:12px 14px;margin-bottom:8px;cursor:pointer;font-size:14px;transition:border-color .12s, background .12s, box-shadow .12s}' +
    '.onb-q label:hover{border-color:#555}' +
    '.onb-q label input{display:none}' +
    '.onb-q.good{border-color:#16a34a}.onb-q.bad{border-color:#ef4444}' +
    '.onb-video{width:100%;border-radius:10px;background:#000;max-height:430px;margin-bottom:14px}' +
    '.onb-note{font-size:13px;color:var(--text-muted-color,#9ca3af);margin-top:10px}' +
    '.onb-cele{position:fixed;inset:0;background:var(--bg,#0f0f0f);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999;overflow:hidden}' +
    '.onb-cele h1{font-size:42px;margin:10px 0 6px}' +
    '.onb-conf{position:absolute;top:-20px;width:10px;height:16px;border-radius:2px;animation:onbFall linear forwards}' +
    '@keyframes onbFall{to{transform:translateY(110vh) rotate(720deg)}}' +
    '.onb-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.4px}' +
    '.onb-pill.ready{background:#dcfce7;color:#15803d}' +
    '.onb-pill.busy{background:#fff3e8;color:#c2520a}' +
    '.onb-doc{border:1px solid var(--border,#2a2a2a);border-radius:10px;overflow:hidden;background:var(--bg,#0f0f0f);margin-bottom:14px;height:min(70vh,560px)}' +
    '.onb-doc iframe{width:100%;height:100%;border:0;display:block;background:#fff}' +
    '.onb-doc-fallback{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;height:auto;padding:34px 16px;gap:6px}' +
    '.onb-fw{position:absolute;inset:0;width:100%;height:100%;display:block}';

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
  function clearPoll() { if (window._onbPoll) { clearInterval(window._onbPoll); window._onbPoll = null; } stopFireworks(); }
  function firstName(n) { return String(n || '').split(' ')[0]; }
  // Show the app version on the onboarding screen (trainees never see the
  // sidebar badge). Flags when the browser is running a stale cached build.
  function onbShowVersion() {
    var el = document.getElementById('onb-version');
    if (!el) return;
    var pServer = fetch('/api/version', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return d && d.version; })
      .catch(function () { return null; });
    var pRun = (typeof getServiceWorkerVersion === 'function')
      ? getServiceWorkerVersion().catch(function () { return null; })
      : Promise.resolve(null);
    Promise.all([pRun, pServer]).then(function (arr) {
      var running = arr[0], server = arr[1];
      if (!running && !server) { el.textContent = ''; return; }
      if (running && server && String(running) !== String(server)) {
        el.textContent = 'v' + running + ' \u00b7 server v' + server + ' — hard-refresh';
        el.style.color = '#f59e0b';
        el.title = 'This browser is running a cached older version. Hard-refresh (Ctrl+Shift+R) to load server v' + server + '.';
      } else {
        el.textContent = 'v' + (running || server);
      }
    });
  }

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
          '<span style="display:flex;align-items:baseline;gap:8px"><span class="onb-logo">Nova</span><span id="onb-version" style="font-size:11px;color:var(--text-muted-color,#9ca3af);opacity:.75"></span></span>' +
          '<span style="display:flex;gap:8px">' +
            '<button class="onb-btn ghost" onclick="onbToggleClock()">🕐 Time Clock</button>' +
            '<button class="onb-btn ghost" onclick="logout()">Sign out</button>' +
          '</span>' +
        '</div>' +
        '<div id="onb-clock" style="display:none;margin-bottom:18px"></div>' +
        '<div class="onb-title">Welcome, ' + escHtml(firstName(data.name)) + ' 👋</div>' +
        '<div class="onb-sub">Let&#39;s get you set up. Work through each step — Nova unlocks when you finish and ' + escHtml(data.supervisor_name || 'your supervisor') + ' signs off.</div>' +
        '<div class="onb-bar"><div style="width:' + pct + '%"></div></div>' +
        '<div class="onb-note" style="margin:-14px 0 16px">Step ' + Math.min(done + 1, total || 1) + ' of ' + (total || 1) + '</div>' +
        '<div id="onb-body">' + body + '</div>' +
      '</div>';

    onbShowVersion();

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
      var reader;
      if (cur.sop_doc_url) {
        var mime = cur.sop_doc_mime || '';
        var docName = escHtml(cur.sop_doc_name || 'the document');
        if (mime.indexOf('pdf') !== -1 || mime.indexOf('image/') === 0) {
          reader = '<div class="onb-doc"><iframe src="' + escHtml(cur.sop_doc_url) + '" title="' + docName + '"></iframe></div>' +
            '<div class="onb-note" style="margin-top:0"><a href="' + escHtml(cur.sop_doc_url) + '" target="_blank" rel="noopener" style="color:var(--primary,#f97316)">Open ' + docName + ' in a new tab &#8599;</a></div>';
        } else {
          reader = '<div class="onb-doc onb-doc-fallback"><div style="font-size:40px">&#128196;</div>' +
            '<div style="font-weight:600">' + docName + '</div>' +
            '<a class="onb-btn" href="' + escHtml(cur.sop_doc_url) + '" target="_blank" rel="noopener" style="margin-top:6px">Open the document &#8599;</a></div>';
        }
      } else {
        reader = '<div class="onb-sop" id="onb-sop">' + escHtml(cur.sop_content || 'This SOP has no text.') + '</div>';
      }
      inner = reader +
        '<button class="onb-btn" id="onb-continue" disabled onclick="onbCompleteStep(' + cur.id + ')">Mark as read</button>' +
        '<div class="onb-note" id="onb-timer-note">' + (cur.sop_doc_url ? '' : 'Read to the bottom to continue.') + '</div>';
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
    var scrolled = cur.type !== 'sop_read' || !!cur.sop_doc_url;
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
          return '<label><input type="radio" name="onbq' + q.n + '" value="' + oi + '">' + escHtml(o) + '</label>';
        }).join('') + '</div>';
    }).join('');
    if (box) box.innerHTML = '<form id="onb-quiz-form" onchange="onbQuizHighlight(this)">' + html + '</form>' +
      '<button class="onb-btn" id="onb-quiz-submit" onclick="onbSubmitQuiz(' + qz.attempt_id + ',' + qz.questions.length + ',' + stepId + ')">Submit answers</button>' +
      '<div class="onb-note" id="onb-quiz-note"></div>';
  };

  window.onbQuizHighlight = function (form) {
    var labels = form.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      var r = labels[i].querySelector('input');
      if (r && r.checked) {
        labels[i].style.borderColor = 'var(--primary,#f97316)';
        labels[i].style.background = 'rgba(249,115,22,0.28)';
        labels[i].style.boxShadow = '0 0 0 2px var(--primary,#f97316)';
        labels[i].style.color = '#fff';
      } else {
        labels[i].style.borderColor = '#333';
        labels[i].style.background = '#1f1f1f';
        labels[i].style.boxShadow = 'none';
        labels[i].style.color = '';
      }
    }
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
      if (!el) return;
      el.className = 'onb-q ' + (res.correct ? 'good' : 'bad');
      var picked = answers[res.n];
      var labels = el.querySelectorAll('label');
      for (var li = 0; li < labels.length; li++) {
        var lab = labels[li];
        var input = lab.querySelector('input');
        if (input) input.disabled = true;
        var isCorrect = (li === res.correct_index);
        var isPicked = (li === picked);
        if (isCorrect) {
          lab.style.background = 'rgba(34,197,94,.15)';
          lab.style.borderColor = '#22c55e';
          lab.style.boxShadow = '0 0 0 2px #16a34a';
          lab.style.color = '#22c55e';
          lab.insertAdjacentHTML('beforeend', ' <span style="font-size:12px;font-weight:700">&#10003; Correct answer</span>');
        } else if (isPicked) {
          lab.style.background = 'rgba(239,68,68,.13)';
          lab.style.borderColor = '#ef4444';
          lab.style.boxShadow = 'none';
          lab.style.color = '#f87171';
          lab.insertAdjacentHTML('beforeend', ' <span style="font-size:12px">&#10007; Your answer</span>');
        } else {
          lab.style.boxShadow = 'none';
          lab.style.opacity = '.5';
        }
      }
    });
    var submitBtn = document.getElementById('onb-quiz-submit');
    if (submitBtn) submitBtn.style.display = 'none';
    var note = document.getElementById('onb-quiz-note');
    if (r.passed) {
      try { onbConfettiBurst(); } catch (e) {}
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

  window.onbConfettiBurst = function () {
    injectCss();
    var colors = ['#f97316', '#fbbf24', '#22c55e', '#3b82f6', '#ec4899', '#a78bfa'];
    var pieces = '';
    for (var i = 0; i < 90; i++) {
      pieces += '<div class="onb-conf" style="left:' + (Math.random() * 100) + 'vw;background:' + colors[i % colors.length] +
        ';animation-duration:' + (1.8 + Math.random() * 1.8) + 's;animation-delay:' + (Math.random() * 0.4) + 's"></div>';
    }
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1000;overflow:hidden';
    wrap.innerHTML = pieces;
    document.body.appendChild(wrap);
    setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 4200);
  };

  function stopFireworks() {
    window._onbFwStop = true;
    if (window._onbFwRaf) { cancelAnimationFrame(window._onbFwRaf); window._onbFwRaf = null; }
  }

  window.onbFireworks = function (canvas) {
    if (!canvas || !canvas.getContext) return;
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = window.devicePixelRatio || 1;
    function resize() {
      W = canvas.clientWidth || window.innerWidth;
      H = canvas.clientHeight || window.innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    var colors = ['#f97316', '#fbbf24', '#22c55e', '#3b82f6', '#ec4899', '#a78bfa', '#ffffff'];
    var rockets = [], sparks = [];
    function launch() {
      rockets.push({ x: W * (0.15 + Math.random() * 0.7), y: H, vy: -(6.5 + Math.random() * 2.5),
        ty: H * (0.14 + Math.random() * 0.32), color: colors[(Math.random() * colors.length) | 0] });
    }
    function explode(x, y, color) {
      var n = 34 + (Math.random() * 26 | 0);
      for (var i = 0; i < n; i++) {
        var a = (Math.PI * 2) * (i / n), sp = 1.4 + Math.random() * 3.2;
        sparks.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: color });
      }
    }
    window._onbFwStop = false;
    function frame() {
      if (window._onbFwStop) return;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(15,15,15,0.28)';
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      if (Math.random() < 0.06) launch();
      for (var i = rockets.length - 1; i >= 0; i--) {
        var r = rockets[i];
        r.y += r.vy; r.vy += 0.06;
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(r.x, r.y, 2.2, 0, Math.PI * 2); ctx.fill();
        if (r.y <= r.ty || r.vy >= 0) { explode(r.x, r.y, r.color); rockets.splice(i, 1); }
      }
      for (var j = sparks.length - 1; j >= 0; j--) {
        var s = sparks[j];
        s.x += s.vx; s.y += s.vy; s.vy += 0.04; s.vx *= 0.99; s.vy *= 0.99; s.life -= 0.012;
        if (s.life <= 0) { sparks.splice(j, 1); continue; }
        ctx.globalAlpha = Math.max(0, s.life);
        ctx.fillStyle = s.color;
        ctx.beginPath(); ctx.arc(s.x, s.y, 2.1, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
      window._onbFwRaf = requestAnimationFrame(frame);
    }
    launch(); launch();
    window._onbFwRaf = requestAnimationFrame(frame);
  };

  function renderOnbCelebration(app) {
    injectCss(); clearPoll();
    if (state && state.user) {
      state.user.onboarding_status = 'complete';
      try { localStorage.setItem('po_user', JSON.stringify(state.user)); } catch (e) {}
    }
    app.innerHTML = '<div class="onb-cele">' +
      '<canvas class="onb-fw" id="onb-fw"></canvas>' +
      '<div style="position:relative;z-index:2;display:flex;flex-direction:column;align-items:center">' +
        '<div style="font-size:64px">🎉</div>' +
        '<h1>You&#39;re in!</h1>' +
        '<div class="onb-sub" style="text-align:center;max-width:420px">Onboarding complete. Welcome to the Lock and Roll team — the full Nova app is now yours.</div>' +
        '<button class="onb-btn" style="margin-top:18px;font-size:17px;padding:14px 34px" onclick="onbEnterNova()">Enter Nova →</button>' +
      '</div>' +
      '</div>';
    try { onbFireworks(document.getElementById('onb-fw')); } catch (e) {}
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
      '<button class="onb-btn' + (window._onbTab === 'completion' ? '' : ' ghost') + '" onclick="onbTab(\'completion\')">Completion</button>' +
      '</div>';
    content.innerHTML = '<h1 style="margin-bottom:14px">Onboarding</h1>' + tabs + '<div id="onb-admin-body"><div class="loading">Loading…</div></div>';
    var body = document.getElementById('onb-admin-body');
    if (window._onbTab === 'hires') await onbAdminHires(body);
    else if (window._onbTab === 'completion') await onbAdminCompletion(body);
    else await onbAdminPath(body);
  };
  window.onbTab = function (t) { window._onbTab = t; renderOnboardingAdmin(document.getElementById('content')); };

  async function onbAdminHires(body) {
    var data, users = [];
    try { data = await api('GET', '/onboarding/admin/progress'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { users = await api('GET', '/users'); } catch (e) {}
    window._onbProgress = data.users || [];
    window._onbUsers = users;
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
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbOverride(' + u.id + ')">Completion' + (u.completion_override ? ' •' : '') + '</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbRemove(' + u.id + ')">Remove</button>' +
        '</td></tr>' +
        '<tr id="onb-detail-' + u.id + '" style="display:none"><td colspan="4"></td></tr>' +
        '<tr id="onb-ovr-' + u.id + '" style="display:none"><td colspan="4"></td></tr>';
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
    var vdocs = [];
    try { vdocs = await api('GET', '/onboarding/admin/vault-docs'); } catch (e) {}
    window._onbSteps = steps;
    var sopOpts = (sops || []).map(function (s) { return '<option value="' + s.id + '">' + escHtml(s.title) + '</option>'; }).join('');
    var docOpts = (vdocs || []).map(function (d) { return '<option value="' + d.id + '">' + escHtml(d.name) + '</option>'; }).join('');

    var rows = steps.map(function (s, i) {
      var meta = [];
      if (s.type === 'quiz') { var c = s.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = {}; } } meta.push((c.question_count || 3) + ' questions, pass ' + (c.pass_score || 80) + '%'); }
      if (s.type === 'sop_read' && s.doc_title) meta.push('Document: ' + s.doc_title);
      else if (s.sop_title) meta.push('SOP: ' + s.sop_title);
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
      '<div id="onb-f-doc" style="display:none;grid-column:1/-1"><select id="onb-new-doc" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (docOpts || '<option value="">No files in the Standard Operating Procedures vault folder</option>') + '</select><div class="onb-note">The new hire reads this document. Pulled from Document Vault &rsaquo; Standard Operating Procedures.</div></div>' +
      '<div id="onb-f-sop" style="display:none;grid-column:1/-1"><select id="onb-new-sop" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (sopOpts || '<option value="">No SOPs in the library yet</option>') + '</select><div class="onb-note">Quiz questions are generated from this SOP&#39;s text in the SOP library.</div></div>' +
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
    f('onb-f-doc', t === 'sop_read');
    f('onb-f-sop', t === 'quiz');
    f('onb-f-video', t === 'video');
    f('onb-f-quiz', t === 'quiz');
  };

  window.onbAddStep = async function () {
    var t = document.getElementById('onb-new-type').value;
    var title = document.getElementById('onb-new-title').value.trim();
    if (!title) { showToast('Give the step a title.', 'error'); return; }
    var payload = { type: t, title: title, description: document.getElementById('onb-new-desc').value.trim(), min_seconds: parseInt(document.getElementById('onb-new-min').value, 10) || 0 };
    if (t === 'sop_read') {
      payload.document_id = parseInt((document.getElementById('onb-new-doc') || {}).value, 10);
      if (!payload.document_id) { showToast('Pick a document from the vault.', 'error'); return; }
    }
    if (t === 'quiz') {
      payload.sop_id = parseInt((document.getElementById('onb-new-sop') || {}).value, 10);
      if (!payload.sop_id) { showToast('Pick an SOP for the quiz.', 'error'); return; }
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

  // ---- Completion action config -------------------------------------------
  var INP = 'background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px';
  function userOptions(users, selectedId, placeholder) {
    var o = placeholder ? '<option value="">' + escHtml(placeholder) + '</option>' : '';
    (users || []).forEach(function (u) {
      if (u.active === false) return;
      o += '<option value="' + u.id + '"' + (String(u.id) === String(selectedId) ? ' selected' : '') + '>' + escHtml(u.name) + '</option>';
    });
    return o;
  }
  function prioOptions(sel) {
    return ['low', 'medium', 'high'].map(function (p) {
      return '<option value="' + p + '"' + (p === sel ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
    }).join('');
  }
  var PLACEHOLDER_HINT = 'Placeholders: {{name}} (new hire), {{role}}, {{date}}, {{signer}}, {{recipient}}';

  async function onbAdminCompletion(body) {
    var conf, users = [];
    try { conf = await api('GET', '/onboarding/admin/completion'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { users = await api('GET', '/users'); } catch (e) {}
    window._onbUsers = users;
    body.innerHTML =
      '<div class="onb-card">' +
      '<h2>When a new hire finishes onboarding</h2>' +
      '<div class="onb-desc">On supervisor sign-off, notify a chosen person and create a task for them. This is the global default — you can override it per hire from the New Hires tab.</div>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">' +
        '<input type="checkbox" id="onc-enabled"' + (conf.enabled ? ' checked' : '') + '> <b>Enable completion notification &amp; task</b></label>' +
      '<div style="display:grid;gap:12px">' +
        '<div><div class="onb-note" style="margin-bottom:4px">Notify &amp; assign to</div>' +
          '<select id="onc-recipient" style="width:100%;' + INP + '">' + userOptions(users, conf.recipient_id, 'Pick a person…') + '</select></div>' +
        '<div style="display:flex;gap:18px;flex-wrap:wrap">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="onc-notify"' + (conf.notify !== false ? ' checked' : '') + '> Send notification (email / SMS / push)</label>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="onc-task"' + (conf.create_task !== false ? ' checked' : '') + '> Create a task</label>' +
        '</div>' +
        '<div><div class="onb-note" style="margin-bottom:4px">Task title</div>' +
          '<input id="onc-title" value="' + escHtml(conf.task_title || '') + '" style="width:100%;' + INP + '"></div>' +
        '<div><div class="onb-note" style="margin-bottom:4px">Task description</div>' +
          '<textarea id="onc-desc" rows="4" style="width:100%;' + INP + ';resize:vertical">' + escHtml(conf.task_description || '') + '</textarea></div>' +
        '<div class="onb-note">' + escHtml(PLACEHOLDER_HINT) + '</div>' +
        '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">' +
          '<label class="onb-note">Priority<br><select id="onc-prio" style="' + INP + '">' + prioOptions(conf.task_priority || 'medium') + '</select></label>' +
          '<label class="onb-note">Due in (days after completion)<br><input id="onc-due" type="number" min="0" max="60" value="' + (conf.task_due_days != null ? conf.task_due_days : 3) + '" style="width:90px;' + INP + '"></label>' +
        '</div>' +
      '</div>' +
      '<button class="onb-btn" style="margin-top:16px" id="onc-save" onclick="onbSaveCompletion()">Save</button>' +
      '</div>';
  }

  function readCompletionForm() {
    return {
      enabled: !!(document.getElementById('onc-enabled') || {}).checked,
      recipient_id: parseInt((document.getElementById('onc-recipient') || {}).value, 10) || null,
      notify: !!(document.getElementById('onc-notify') || {}).checked,
      create_task: !!(document.getElementById('onc-task') || {}).checked,
      task_title: (document.getElementById('onc-title') || {}).value || '',
      task_description: (document.getElementById('onc-desc') || {}).value || '',
      task_priority: (document.getElementById('onc-prio') || {}).value || 'medium',
      task_due_days: parseInt((document.getElementById('onc-due') || {}).value, 10)
    };
  }
  window.onbSaveCompletion = async function () {
    var payload = readCompletionForm();
    if (payload.enabled && !payload.recipient_id) { showToast('Pick who to notify.', 'error'); return; }
    if (payload.enabled && !payload.notify && !payload.create_task) { showToast('Turn on notification, a task, or both.', 'error'); return; }
    var btn = document.getElementById('onc-save'); if (btn) btn.disabled = true;
    try { await api('PUT', '/onboarding/admin/completion', payload); showToast('Saved.', 'success'); }
    catch (e) { showToast(e.message || 'Save failed.', 'error'); }
    finally { if (btn) btn.disabled = false; }
  };

  // ---- Per-hire override (New Hires tab) ----------------------------------
  window.onbOverride = async function (id) {
    var row = document.getElementById('onb-ovr-' + id);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = '';
    var cell = row.firstChild;
    cell.innerHTML = '<div class="onb-note" style="padding:10px 14px">Loading…</div>';
    var hire = (window._onbProgress || []).filter(function (u) { return u.id === id; })[0] || {};
    var ov = hire.completion_override || {};
    var users = window._onbUsers || [];
    if (!users.length) { try { users = await api('GET', '/users'); window._onbUsers = users; } catch (e) {} }
    cell.innerHTML =
      '<div style="padding:12px 14px">' +
      '<div class="onb-note" style="margin-bottom:8px">Override the global completion action for <b>' + escHtml(hire.name || 'this hire') + '</b>. Leave a field blank to use the default.</div>' +
      '<div style="display:grid;gap:10px">' +
        '<select id="ovr-recipient-' + id + '" style="' + INP + '">' + userOptions(users, ov.recipient_id, 'Recipient — use default') + '</select>' +
        '<input id="ovr-title-' + id + '" value="' + escHtml(ov.task_title || '') + '" placeholder="Task title — use default" style="' + INP + '">' +
        '<textarea id="ovr-desc-' + id + '" rows="3" placeholder="Task description — use default" style="' + INP + ';resize:vertical">' + escHtml(ov.task_description || '') + '</textarea>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end">' +
          '<label class="onb-note">Priority<br><select id="ovr-prio-' + id + '" style="' + INP + '"><option value="">Default</option>' + prioOptions(ov.task_priority || '') + '</select></label>' +
          '<label class="onb-note">Due in days<br><input id="ovr-due-' + id + '" type="number" min="0" max="60" value="' + (ov.task_due_days != null ? ov.task_due_days : '') + '" placeholder="def" style="width:80px;' + INP + '"></label>' +
        '</div>' +
        '<div class="onb-note">' + escHtml(PLACEHOLDER_HINT) + '</div>' +
      '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px">' +
        '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbSaveOverride(' + id + ')">Save override</button>' +
        '<button class="onb-btn ghost" style="padding:8px 14px;font-size:13px" onclick="onbClearOverride(' + id + ')">Clear</button>' +
      '</div></div>';
  };
  window.onbSaveOverride = async function (id) {
    var prio = (document.getElementById('ovr-prio-' + id) || {}).value || '';
    var due = (document.getElementById('ovr-due-' + id) || {}).value;
    var override = {
      recipient_id: parseInt((document.getElementById('ovr-recipient-' + id) || {}).value, 10) || undefined,
      task_title: ((document.getElementById('ovr-title-' + id) || {}).value || '').trim() || undefined,
      task_description: ((document.getElementById('ovr-desc-' + id) || {}).value || '').trim() || undefined,
      task_priority: prio || undefined,
      task_due_days: (due === '' || due == null) ? undefined : parseInt(due, 10)
    };
    try { await api('PUT', '/onboarding/admin/users/' + id + '/completion-override', { override: override }); showToast('Override saved.', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Save failed.', 'error'); }
  };
  window.onbClearOverride = async function (id) {
    try { await api('PUT', '/onboarding/admin/users/' + id + '/completion-override', { override: null }); showToast('Override cleared.', 'info'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
})();
