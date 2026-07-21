// public/js/onboarding.js
// Onboarding module frontend: the locked new-hire track (renderOnboardingMode)
// and the admin path builder + progress dashboard (renderOnboardingAdmin).
// No backticks in this file. Apostrophes inside HTML strings use &#39;.

(function () {
  'use strict';

  var CSS = '' +
    '.onb-wrap{max-width:780px;margin:0 auto;padding:calc(28px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 60px calc(16px + env(safe-area-inset-left))}' +
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
    '.onb-fw{position:absolute;inset:0;width:100%;height:100%;display:block}' +
    '.onb-slot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:11px 13px;border:1px solid var(--border,#2a2a2a);border-radius:10px;background:var(--bg,#0f0f0f);margin-bottom:9px}' +
    '.onb-slot.filled{border-color:#16a34a55}' +
    '.onb-slot.rejected{border-color:#ef444455}' +
    '.onb-slot-ic{width:32px;height:32px;border-radius:8px;background:var(--bg-card2,#1c1c1c);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}' +
    '.onb-slot.filled .onb-slot-ic{background:#16a34a22;color:#4ade80}' +
    '.onb-slot-b{flex:1 1 160px;min-width:0}.onb-slot-b b{font-size:14px}.onb-slot-b span{display:block;color:var(--text-muted-color,#9ca3af);font-size:12px;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.onb-slot-acts{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto;flex-wrap:wrap}' +
    '.onb-slot-send{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;white-space:nowrap;font-size:12px;color:var(--text-muted-color,#9ca3af);cursor:pointer;user-select:none}' +
    '.onb-slot-send input{margin:0;flex:0 0 auto;width:16px;height:16px;padding:0}' +
    '.onb-check input{margin:0;flex:0 0 auto;width:16px;height:16px;padding:0}' +
    '@media(max-width:640px){.onb-slot-acts{flex:1 0 100%;justify-content:flex-start;margin-left:44px}}' +
    '.onb-card,.onb-step,.onb-slot{max-width:100%;box-sizing:border-box}' +
    '.onb-card input,.onb-card select,.onb-card textarea{max-width:100%;box-sizing:border-box}' +
    '.onb-pk{display:flex;flex-direction:column;gap:1px}' +
    '.onb-pk-sec{font-size:12px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--primary,#f97316);margin:14px 0 6px;padding-bottom:5px;border-bottom:1px solid var(--border,#2a2a2a)}' +
    '.onb-pk-sec:first-child{margin-top:0}' +
    '.onb-pk-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 14px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.04)}' +
    '.onb-pk-k{flex:0 0 210px;max-width:100%;font-size:12.5px;color:var(--text-muted-color,#9ca3af)}' +
    '.onb-pk-v{flex:1 1 160px;min-width:0;font-size:13.5px;font-weight:600;word-break:break-word}' +
    '.onb-pk-v.empty{font-weight:400;color:var(--text-muted-color,#6b7280)}' +
    '.onb-pk-flag{flex:1 0 100%;font-size:12px;color:#fbbf24}' +
    '@media(max-width:640px){.onb-pk-k{flex:1 0 100%}}' +
    '.onb-slotpicks{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin:0 0 8px}' +
    '.onb-slotpick{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:9px;min-width:0;padding:11px 13px;border:1px solid var(--border,#2a2a2a);border-radius:9px;background:var(--bg,#0f0f0f);font-size:13px;line-height:1.35;cursor:pointer;user-select:none}' +
    '.onb-slotpick input{margin:0;flex:0 0 auto;width:16px;height:16px;padding:0}' +
    '.onb-slotpick span{flex:1 1 auto;min-width:0;white-space:normal;overflow-wrap:break-word;word-break:normal}' +
    '.onb-slotpick:hover{border-color:var(--primary,#f97316)}' +
    '.onb-slot-act{font-size:12.5px;font-weight:700;padding:6px 12px;border-radius:7px;border:1px solid var(--border,#2a2a2a);background:var(--bg-card,#161616);color:var(--text,#ededed);cursor:pointer;flex-shrink:0}' +
    '.onb-slot-act.done{background:#16a34a22;color:#4ade80;border-color:#16a34a55}' +
    '.onb-verify{border:1px solid var(--border,#2a2a2a);border-radius:10px;background:var(--bg,#0f0f0f);padding:12px 13px;margin:4px 0 12px}' +
    '.onb-verify .v-h{font-size:12px;font-weight:700;color:#cfd3d7;margin-bottom:7px}' +
    '.onb-verify .v-row{font-size:12.5px;padding:3px 0;color:var(--text-muted-color,#9ca3af)}' +
    '.onb-verify .v-row.ok{color:#86efac}.onb-verify .v-row.warn{color:#fbbf24}' +
    '.onb-grip{color:var(--text-muted-color,#9ca3af);font-size:15px;cursor:grab;padding:0 6px 0 0;user-select:none;flex-shrink:0}' +
    '.onb-drag{cursor:grab}' +
    '.onb-pdfpg{display:block;width:100%;height:auto;margin:0 auto 8px;box-shadow:0 1px 4px rgba(0,0,0,.4)}';

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

  // ---- PDF viewer (renders every page; iOS will not paginate a PDF in an iframe) ----
  var PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (window._pdfjsLoading) return window._pdfjsLoading;
    window._pdfjsLoading = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = PDFJS_SRC;
      sc.onload = function () { try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; } catch (e) {} resolve(window.pdfjsLib); };
      sc.onerror = function () { window._pdfjsLoading = null; reject(new Error('PDF viewer failed to load.')); };
      document.head.appendChild(sc);
    });
    return window._pdfjsLoading;
  }
  // Render every page of a PDF into container. src is { url, headers } or { data: ArrayBuffer }.
  async function onbRenderPdf(container, src, fallbackUrl) {
    if (!container) return;
    try {
      var lib = await loadPdfJs();
      var params = src.data ? { data: src.data } : { url: src.url, httpHeaders: src.headers || {} };
      var pdf = await lib.getDocument(params).promise;
      container.innerHTML = '';
      var wide = container.clientWidth || 700;
      for (var pnum = 1; pnum <= pdf.numPages; pnum++) {
        var page = await pdf.getPage(pnum);
        var base = page.getViewport({ scale: 1 });
        var scale = Math.max(0.2, (wide - 4) / base.width) * Math.min(2, (window.devicePixelRatio || 1));
        var vp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.className = 'onb-pdfpg';
        canvas.width = vp.width; canvas.height = vp.height;
        container.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
    } catch (e) {
      container.innerHTML = '<div class="onb-doc-fallback" style="height:100%;color:#ccc"><div style="font-size:40px">&#128196;</div>' +
        '<div class="onb-note">Could not display the PDF here.</div>' +
        (fallbackUrl ? '<a class="onb-btn" href="' + fallbackUrl + '" target="_blank" rel="noopener" style="margin-top:6px">Open it in a new tab &#8599;</a>' : '') + '</div>';
    }
  }
  // Hydrate the reading-doc PDF placeholder once it is in the DOM.
  function onbHydratePdf() {
    var el = document.getElementById('onb-pdf-reader');
    if (!el || el.getAttribute('data-hydrated')) return;
    el.setAttribute('data-hydrated', '1');
    var token = (window.state && state.token) ? state.token : '';
    onbRenderPdf(el, { url: '/api/onboarding/reading-doc', headers: { Authorization: 'Bearer ' + token } }, el.getAttribute('data-fallback') || '');
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
    if (data.phase2_pending) {
      // Phase 1 is APPROVED. Training is deliberately not self-serve — the manager
      // opens it when they sit down together. Say exactly that, so the hire is not
      // left wondering whether Nova is stuck.
      var _mgr = escHtml(data.supervisor_name || 'your manager');
      body = '<div class="onb-card" style="text-align:center">' +
        '<div style="font-size:42px;margin-bottom:8px">&#9989;</div>' +
        '<h2>Phase 1 complete</h2>' +
        '<div class="onb-desc">Your paperwork and documents are approved' +
          (data.phase1_approved_by ? ' by ' + escHtml(data.phase1_approved_by) : '') +
          '. Nice work — that part is done.</div>' +
        '<div class="onb-verify" style="text-align:left;margin:16px 0">' +
          '<div class="v-h">What happens next</div>' +
          '<div class="v-row ok">&#10003; Phase 2 is your training, and it starts <b>with ' + _mgr + '</b> — not on your own.</div>' +
          '<div class="v-row ok">&#10003; ' + _mgr + ' will open Phase 2 when the two of you are ready to begin.</div>' +
          '<div class="v-row ok">&#10003; Your training steps and the time clock unlock the moment they do.</div>' +
        '</div>' +
        '<div class="onb-desc" style="margin-bottom:0"><b>Nothing to do right now.</b> Reach out to ' + _mgr + ' to schedule your start if you have not already.</div>' +
        '<div class="onb-note">This screen unlocks itself as soon as they start you — it checks every 20 seconds.</div>' +
        '</div>';
    } else if (data.awaiting_review) {
      body = '<div class="onb-card" style="text-align:center">' +
        '<div style="font-size:42px;margin-bottom:8px">&#128203;</div>' +
        '<h2>Paperwork submitted</h2>' +
        '<div class="onb-desc">Your Phase 1 paperwork and documents are in. ' + escHtml(data.supervisor_name || 'Your manager') + ' has been notified to review them — they will approve it, then start Phase 2 training with you.</div>' +
        '<div class="onb-note">This screen checks automatically every 20 seconds.</div>' +
        '</div>';
    } else if (data.all_steps_done) {
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

    if (data.all_steps_done || data.awaiting_review || data.phase2_pending) {
      window._onbPoll = setInterval(async function () {
        try {
          var d = await api('GET', '/onboarding/me');
          if (d.onboarding_status === 'complete') { clearPoll(); renderOnbCelebration(document.getElementById('app')); return; }
          if (!!d.awaiting_review !== !!data.awaiting_review || !!d.phase2_pending !== !!data.phase2_pending || !!d.current !== !!data.current || d.phase !== data.phase) { clearPoll(); renderOnboardingMode(document.getElementById('app')); }
        } catch (e) {}
      }, 20000);
    } else if (data.current) {
      onbStartTimers(data.current);
      onbHydratePdf();
      if (data.current.type === 'quiz' && data.current.must_reread) onbShowReread(data.current.id, data.current);
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
    } else if (cur.type === 'sop_read' || cur.type === 'acknowledge') {
      var reader;
      if (cur.sop_doc_url) {
        var mime = cur.sop_doc_mime || '';
        var docName = escHtml(cur.sop_doc_name || 'the document');
        var _dn = String(cur.sop_doc_name || '').toLowerCase();
        var _isPdf = mime.indexOf('pdf') !== -1 || _dn.slice(-4) === '.pdf';
        var _isImg = mime.indexOf('image/') === 0 || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif'].some(function (x) { return _dn.slice(-x.length) === x; });
        if (_isPdf) {
          reader = '<div class="onb-doc" style="overflow:auto"><div id="onb-pdf-reader" data-pdf="1" data-fallback="' + escHtml(cur.sop_doc_url) + '"><div class="onb-note" style="padding:16px">Loading document\u2026</div></div></div>' +
            '<div class="onb-note" style="margin-top:0"><a href="' + escHtml(cur.sop_doc_url) + '" target="_blank" rel="noopener" style="color:var(--primary,#f97316)">Open ' + docName + ' in a new tab &#8599;</a></div>';
        } else if (_isImg) {
          reader = '<div class="onb-doc" style="overflow:auto;display:block"><img src="' + escHtml(cur.sop_doc_url) + '" alt="' + docName + '" style="width:100%;height:auto;display:block"></div>' +
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
        '<button class="onb-btn" id="onb-continue" disabled onclick="onbCompleteStep(' + cur.id + ')">' + (cur.type === 'acknowledge' ? 'Acknowledge and Continue' : 'Mark as read') + '</button>' +
        '<div class="onb-note" id="onb-timer-note">' + (cur.sop_doc_url ? '' : 'Read to the bottom to continue.') + '</div>';
    } else if (cur.type === 'quiz') {
      if (cur.must_reread) {
        inner = '<div id="onb-quiz"></div>';
      } else {
        inner = '<div id="onb-quiz">' +
          '<div class="onb-note" style="margin-bottom:14px">' + (cur.question_count || 5) + ' questions &middot; pass ' + (cur.pass_score || 80) + '%. Two tries, then you re-read the material before a fresh set.</div>' +
          '<button class="onb-btn" onclick="onbStartQuiz(' + cur.id + ')">' + (cur.attempts ? 'Try again with fresh questions' : 'Start the quiz') + '</button>' +
          '</div>';
      }
    } else if (cur.type === 'final_exam') {
      inner = '<div id="onb-quiz">' +
        '<div class="onb-note" style="margin-bottom:14px">Final exam &middot; ' + (cur.question_count || 20) + ' questions &middot; pass ' + (cur.pass_score || 80) + '%. Cumulative over everything you have read. Retake as many times as you need — fresh questions each time.</div>' +
        '<button class="onb-btn" onclick="onbStartQuiz(' + cur.id + ')">' + (cur.attempts ? 'Retake the exam' : 'Start the final exam') + '</button>' +
        '</div>';
    } else if (cur.type === 'form') {
      var _pdata = (cur.packet && cur.packet.data) || {};
      var _flags = (cur.packet && cur.packet.field_flags) || {};
      inner = (cur.prefilled ? '<div class="onb-note" style="background:#f9731618;border:1px solid #f9731655;border-radius:8px;padding:10px 12px;margin-bottom:14px;color:#fbbf24">We filled in what we could read from your uploaded documents — please review each field and correct anything that is off.</div>' : '') +
        (cur.fields || []).map(function (f) {
        var val = _pdata[f.key];
        var flg = _flags && _flags[f.key];
        var flagNote = flg ? '<div class="onb-note" style="color:#fbbf24">Sent back: ' + escHtml(String(flg)) + '</div>' : '';
        if (f.type === 'section') { return '<h3 style="font-size:15px;font-weight:700;margin:18px 0 4px;color:var(--primary,#f97316)">' + escHtml(f.label) + '</h3>' + (f.note ? '<div class="onb-note" style="margin-bottom:8px">' + escHtml(f.note) + '</div>' : ''); }
        if (f.type === 'ack') {
          return '<label class="onb-check" style="display:flex;align-items:flex-start;gap:10px;margin:8px 0 14px;font-size:13px"><input type="checkbox" id="pf_' + escHtml(f.key) + '"' + (val === true || val === 'true' ? ' checked' : '') + '><span>' + escHtml(f.label) + '</span></label>' + flagNote;
        }
        var input;
        if (f.type === 'select') {
          input = '<select id="pf_' + escHtml(f.key) + '" class="onb-pf" style="width:100%;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px">' + (f.options || []).map(function (o) { return '<option' + (String(val) === String(o) ? ' selected' : '') + '>' + escHtml(o) + '</option>'; }).join('') + '</select>';
        } else if (f.type === 'textarea') {
          input = '<textarea id="pf_' + escHtml(f.key) + '" class="onb-pf" style="width:100%;min-height:70px;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px">' + escHtml(val || '') + '</textarea>';
        } else {
          input = '<input id="pf_' + escHtml(f.key) + '" class="onb-pf" type="' + escHtml(f.type || 'text') + '" value="' + escHtml(val || '') + '" style="width:100%;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px">';
        }
        return '<div style="margin-bottom:12px"><label style="display:block;font-size:12.5px;color:var(--text-muted-color,#9ca3af);margin-bottom:5px;font-weight:600">' + escHtml(f.label) + (f.required ? ' *' : '') + '</label>' + input + flagNote + '</div>';
      }).join('') +
        '<button class="onb-btn" id="onb-continue" onclick="onbSubmitPacket(' + cur.id + ')">Submit</button><div class="onb-note" id="onb-pf-note"></div>';
    } else if (cur.type === 'document_upload') {
      var _up = cur.uploaded || {}; var _slots = cur.slots || [];
      var _allFilled = _slots.length > 0 && _slots.every(function (s) { var f = _up[s.key]; return f && f.review_status !== 'rejected'; });
      var _rows = _slots.map(function (s) {
        var f = _up[s.key]; var filled = !!f; var rej = filled && f.review_status === 'rejected';
        return '<div class="onb-slot' + (filled && !rej ? ' filled' : '') + (rej ? ' rejected' : '') + '">' +
          '<div class="onb-slot-ic">' + (filled && !rej ? '&#10003;' : '&#128206;') + '</div>' +
          '<div class="onb-slot-b"><b>' + escHtml(s.label) + '</b><span>' +
            (rej ? ('Sent back: ' + escHtml(f.reject_reason || 'please re-upload')) : (filled ? (escHtml(f.name || 'attached') + (f.expires_at ? ' · exp ' + escHtml(String(f.expires_at).slice(0, 10)) : '')) : (s.key === 'identity' ? 'SSN card or birth certificate — either one' : 'Photo or PDF'))) +
          '</span></div>' +
          '<button class="onb-slot-act' + (filled && !rej ? ' done' : '') + '" onclick="onbPickSlot(' + cur.id + ',&#39;' + escHtml(s.key) + '&#39;)">' + (filled && !rej ? 'Replace' : 'Choose file') + '</button>' +
        '</div>';
      }).join('');
      var _vhtml = '';
      if (cur.verify && (((cur.verify.ok || []).length) || ((cur.verify.warn || []).length))) {
        _vhtml = '<div class="onb-verify"><div class="v-h">Nova checked these automatically</div>' +
          (cur.verify.ok || []).map(function (m) { return '<div class="v-row ok">&#10003; ' + escHtml(m) + '</div>'; }).join('') +
          (cur.verify.warn || []).map(function (m) { return '<div class="v-row warn">&#9888; ' + escHtml(m) + '</div>'; }).join('') +
          '</div>';
      }
      inner = '<div class="onb-desc">Add a clear photo or scan of each item. These are encrypted and seen only by management. You can&#39;t continue until all are attached.</div>' +
        _rows + _vhtml +
        '<input type="file" id="onb-slot-file" accept="image/*,application/pdf" style="display:none">' +
        '<button class="onb-btn" id="onb-continue" ' + (_allFilled ? '' : 'disabled') + ' onclick="onbCompleteStep(' + cur.id + ')">Continue</button>' +
        '<div class="onb-note" id="onb-up-note"></div>';
    }
    return '<div class="onb-card"><h2>' + stepIcon(cur.type) + ' ' + escHtml(cur.title) + '</h2>' +
      (cur.description ? '<div class="onb-desc">' + escHtml(cur.description) + '</div>' : '') + inner + '</div>';
  }

  function onbStartTimers(cur) {
    if (cur.type === 'document_upload' || cur.type === 'form') return;
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

  function onbReadFileB64(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Could not read the file.')); };
      fr.readAsDataURL(file);
    });
  }
  window.onbPickSlot = function (stepId, slotKey) {
    var input = document.getElementById('onb-slot-file');
    if (!input) return;
    input.value = '';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (file) window.onbUploadSlot(stepId, slotKey, file);
    };
    input.click();
  };
  // Re-encode any image (incl. iPhone HEIC) to JPEG in the browser. HEIC/HEIF are
  // rejected by the vision API and were silently failing, so uploaded IDs never
  // auto-filled the packet. PDFs pass through untouched.
  function onbNormalizeUpload(file) {
    return new Promise(function (resolve) {
      var type = String(file.type || '').toLowerCase();
      if (type === 'application/pdf') { resolve({ blob: file, name: file.name || 'document.pdf', type: 'application/pdf' }); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          var scale = Math.min(1, 2200 / Math.max(w, h || 1));
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          try { URL.revokeObjectURL(url); } catch (x) {}
          canvas.toBlob(function (blob) {
            if (blob && blob.size) resolve({ blob: blob, name: String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', type: 'image/jpeg' });
            else resolve({ blob: file, name: file.name || 'upload', type: file.type || 'application/octet-stream' });
          }, 'image/jpeg', 0.9);
        } catch (e) { try { URL.revokeObjectURL(url); } catch (x) {} resolve({ blob: file, name: file.name || 'upload', type: file.type || 'application/octet-stream' }); }
      };
      img.onerror = function () { try { URL.revokeObjectURL(url); } catch (x) {} resolve({ blob: file, name: file.name || 'upload', type: file.type || 'application/octet-stream' }); };
      img.src = url;
    });
  }
  function onbBlobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Could not read the file.')); };
      fr.readAsDataURL(blob);
    });
  }
  window.onbUploadSlot = async function (stepId, slotKey, file) {
    var note = document.getElementById('onb-up-note');
    if (note) note.textContent = 'Preparing ' + (file.name || 'file') + '…';
    try {
      var norm = await onbNormalizeUpload(file);
      if (norm.blob.size > 15 * 1024 * 1024) { if (note) note.textContent = ''; showToast('That file is too large (max 15 MB).', 'error'); return; }
      if (note) note.textContent = 'Uploading ' + norm.name + '…';
      var dataUrl = await onbBlobToDataUrl(norm.blob);
      await api('POST', '/onboarding/steps/' + stepId + '/upload', { slot_key: slotKey, filename: norm.name, mime_type: norm.type, data: dataUrl });
      showToast('Uploaded.', 'success');
      renderOnboardingMode(document.getElementById('app'));
    } catch (e) {
      if (note) note.textContent = '';
      showToast(e.message || 'Upload failed.', 'error');
    }
  };


  function onbReaderHtml(d) {
    if (d.sop_doc_url) {
      var mime = d.sop_doc_mime || ''; var nm = escHtml(d.sop_doc_name || 'the document');
      if (mime.indexOf('pdf') !== -1)
        return '<div class="onb-doc" style="overflow:auto"><div id="onb-pdf-reader" data-pdf="1" data-fallback="' + escHtml(d.sop_doc_url) + '"><div class="onb-note" style="padding:16px">Loading document\u2026</div></div></div>';
      if (mime.indexOf('image/') === 0)
        return '<div class="onb-doc" style="overflow:auto;display:block"><img src="' + escHtml(d.sop_doc_url) + '" alt="' + nm + '" style="width:100%;height:auto;display:block"></div>';
      return '<div class="onb-doc onb-doc-fallback"><div style="font-size:40px">&#128196;</div><div style="font-weight:600">' + nm + '</div><a class="onb-btn" href="' + escHtml(d.sop_doc_url) + '" target="_blank" rel="noopener" style="margin-top:6px">Open the document &#8599;</a></div>';
    }
    return '<div class="onb-sop" id="onb-sop">' + escHtml(d.sop_content || 'Review the material with your manager.') + '</div>';
  }
  function onbRereadTimer(secs) {
    var btn = document.getElementById('onb-reread-btn'); var note = document.getElementById('onb-reread-note');
    var left = secs;
    function tick() { if (left <= 0) { if (btn) btn.disabled = false; if (note) note.textContent = ''; return; } if (note) note.textContent = 'New questions unlock in ' + left + 's'; }
    tick();
    var iv = setInterval(function () { left--; if (left <= 0) clearInterval(iv); tick(); }, 1000);
  }
  window.onbShowReread = function (stepId, d) {
    var box = document.getElementById('onb-quiz');
    if (!box) return;
    box.innerHTML = '<div class="onb-note" style="margin-bottom:10px;color:#fbbf24">You&#39;ve used both tries — re-read the material, then get a fresh set of questions.</div>' +
      onbReaderHtml(d || {}) +
      '<button class="onb-btn" id="onb-reread-btn" disabled onclick="onbQuizReread(' + stepId + ')">I&#39;ve re-read it — new questions</button>' +
      '<div class="onb-note" id="onb-reread-note"></div>';
    onbHydratePdf();
    onbRereadTimer(30);
  };
  window.onbQuizReread = async function (stepId) {
    try { await api('POST', '/onboarding/steps/' + stepId + '/quiz/reread', {}); onbStartQuiz(stepId); }
    catch (e) { showToast(e.message || 'Could not continue.', 'error'); }
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
      if (note) note.innerHTML = '<b style="color:#16a34a">Passed with ' + r.score + '%!</b> Review the answers below, then continue.';
      var passBox = document.getElementById('onb-quiz');
      if (passBox) {
        var contBtn = document.createElement('button');
        contBtn.className = 'onb-btn';
        contBtn.style.marginTop = '14px';
        contBtn.textContent = 'Continue';
        contBtn.onclick = function () { renderOnboardingMode(document.getElementById('app')); };
        passBox.appendChild(contBtn);
        try { contBtn.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      }
    } else if (r.revert_to_read) {
      if (note) note.innerHTML = '<b style="color:#ef4444">' + r.score + '%</b> — that is two misses. Re-read the material, then you will get a fresh set.';
      setTimeout(function () { onbShowReread(stepId, r.reading || {}); }, 2200);
    } else {
      if (note) note.innerHTML = '<b style="color:#ef4444">' + r.score + '%</b> — you need ' + r.need + '%. One more try with a fresh set of questions.';
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
      '<button class="onb-btn' + (window._onbTab === 'reviews' ? '' : ' ghost') + '" onclick="onbTab(\'reviews\')">Phase 1 Reviews</button>' +
      '<button class="onb-btn' + (window._onbTab === 'path' ? '' : ' ghost') + '" onclick="onbTab(\'path\')">Onboarding Path</button>' +
      '<button class="onb-btn' + (window._onbTab === 'completion' ? '' : ' ghost') + '" onclick="onbTab(\'completion\')">Completion</button>' +
      '<button class="onb-btn' + (window._onbTab === 'history' ? '' : ' ghost') + '" onclick="onbTab(\'history\')">History</button>' +
      '</div>';
    content.innerHTML = '<h1 style="margin-bottom:14px">Onboarding</h1>' + tabs + '<div id="onb-admin-body"><div class="loading">Loading…</div></div>';
    var body = document.getElementById('onb-admin-body');
    if (window._onbTab === 'hires') await onbAdminHires(body);
    else if (window._onbTab === 'reviews') await onbAdminReviews(body);
    else if (window._onbTab === 'completion') await onbAdminCompletion(body);
    else if (window._onbTab === 'history') await onbAdminHistory(body);
    else await onbAdminPath(body);
  };
  window.onbTab = function (t) { window._onbTab = t; renderOnboardingAdmin(document.getElementById('content')); };

  // ---- Phase 1 review (supervisor) ----
  async function onbAdminReviews(body) {
    var list;
    try { list = await api('GET', '/onboarding/admin/reviews'); }
    catch (e) { body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed to load reviews.') + '</div>'; return; }
    if (!list.length) { body.innerHTML = '<div class="onb-card"><div class="onb-desc">No Phase 1 paperwork is waiting on you right now.</div></div>'; return; }
    body.innerHTML = list.map(function (u) {
      return '<div class="onb-step" style="justify-content:space-between">' +
        '<div style="flex:1;min-width:0"><div style="font-weight:700">' + escHtml(u.name) + '</div><div class="onb-note">Submitted Phase 1 paperwork &amp; documents</div></div>' +
        '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbOpenReview(' + u.id + ')">Review</button>' +
        '</div>';
    }).join('');
  }
  window.onbOpenReview = async function (id) {
    window._onbReviewUser = id;
    window._onbReviewFrom = (window._onbTab === 'path' || window._onbTab === 'reviews') ? window._onbTab : 'reviews';
    var body = document.getElementById('onb-admin-body');
    if (body) body.innerHTML = '<div class="loading">Loading…</div>';
    var d;
    try { d = await api('GET', '/onboarding/admin/users/' + id + '/phase1'); }
    catch (e) { if (body) body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed.') + '</div>'; return; }
    var docs = d.documents || [];
    var v = d.verify || { ok: [], warn: [] };
    var vpanel = '';
    if ((v.ok || []).length || (v.warn || []).length) {
      vpanel = '<div class="onb-verify"><div class="v-h">Nova checked these automatically</div>' +
        (v.ok || []).map(function (m) { return '<div class="v-row ok">&#10003; ' + escHtml(m) + '</div>'; }).join('') +
        (v.warn || []).map(function (m) { return '<div class="v-row warn">&#9888; ' + escHtml(m) + '</div>'; }).join('') + '</div>';
    }
    var docRows = docs.map(function (doc) {
      var flagged = doc.verify_status === 'flagged' || doc.review_status === 'rejected';
      var meta = escHtml(doc.name || '') +
        (doc.expires_at ? ' &middot; exp ' + escHtml(String(doc.expires_at).slice(0, 10)) : '') +
        (doc.expiry_override ? ' &middot; expiry accepted by ' + escHtml(doc.expiry_override_name || 'a manager') : '');
      // An expired document blocks the hire at that upload step until they replace
      // it — or until a manager accepts it here.
      var acceptBtn = doc.expired
        ? '<button class="onb-slot-act" style="border-color:#f9731655;color:#fb923c" onclick="onbAcceptExpiry(' + doc.id + ')">Accept anyway</button>'
        : '';
      // Inline flex here as well as in the stylesheet: the actions group must never
      // shrink and the row must be free to wrap, whatever else is on the page.
      return '<div class="onb-slot' + (flagged ? ' rejected' : ' filled') + '" style="flex-wrap:wrap">' +
        '<div class="onb-slot-ic">' + (flagged ? '&#9888;' : '&#10003;') + '</div>' +
        '<div class="onb-slot-b" style="flex:1 1 160px;min-width:0"><b>' + escHtml(doc.slot_key || doc.category || 'document') + '</b><span>' + meta + '</span></div>' +
        '<div class="onb-slot-acts" style="display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:0 0 auto;flex-wrap:wrap">' +
          acceptBtn +
          '<button class="onb-slot-act" onclick="onbViewDoc(' + doc.id + ')">View</button>' +
          '<label class="onb-slot-send" style="display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;white-space:nowrap;font-size:12px;cursor:pointer"><input type="checkbox" class="onb-reopen-slot" value="' + escHtml(doc.slot_key || '') + '"><span>Send back</span></label>' +
        '</div>' +
        '</div>';
    }).join('');
    // Render the packet as the form the hire actually filled in — labelled, in the
    // original section order. (It used to dump raw JSON.) Manager-only fields are
    // skipped here; they live in the editable Employment details card below.
    var _pdata = (d.packet && d.packet.data) || {};
    var _pf = (d.packet_fields || []).filter(function (f) { return f.who !== 'manager'; });
    var packet;
    if (!d.packet) {
      packet = '<div class="onb-card" style="margin-bottom:12px"><div class="onb-note">No packet on file yet.</div></div>';
    } else if (!_pf.length) {
      packet = '<div class="onb-card" style="margin-bottom:12px"><h2 style="font-size:16px">New Hire Packet</h2><div class="onb-note">Submitted, but the packet form has no fields defined.</div></div>';
    } else {
      var _flags = (d.packet && d.packet.field_flags) || {};
      if (typeof _flags === 'string') { try { _flags = JSON.parse(_flags); } catch (e) { _flags = {}; } }
      var _rowsHtml = '';
      _pf.forEach(function (f) {
        if (f.type === 'section') {
          _rowsHtml += '<div class="onb-pk-sec">' + escHtml(f.label || '') + '</div>';
          return;
        }
        if (f.type === 'ack') {
          var acked = _pdata[f.key] === true || _pdata[f.key] === 'true';
          _rowsHtml += '<div class="onb-pk-row"><span class="onb-pk-k">Acknowledgment</span>' +
            '<span class="onb-pk-v">' + (acked
              ? '<span style="color:#4ade80">&#10003; Signed electronically</span>'
              : '<span style="color:#fbbf24">Not acknowledged</span>') + '</span></div>';
          return;
        }
        var v = _pdata[f.key];
        var blank = (v === undefined || v === null || String(v).trim() === '');
        var flag = _flags[f.key];
        _rowsHtml += '<div class="onb-pk-row">' +
          '<span class="onb-pk-k">' + escHtml(f.label || f.key) + '</span>' +
          '<span class="onb-pk-v' + (blank ? ' empty' : '') + '">' + (blank ? '—' : escHtml(String(v))) + '</span>' +
          (flag ? '<span class="onb-pk-flag">&#9888; ' + escHtml(String(flag)) + '</span>' : '') +
          '</div>';
      });
      packet = '<div class="onb-card" style="margin-bottom:12px"><h2 style="font-size:16px">New Hire Packet</h2>' +
        '<div class="onb-note" style="margin-bottom:10px">Submitted by the new hire. A blank line means they left it empty.</div>' +
        '<div class="onb-pk">' + _rowsHtml + '</div></div>';
    }
    var _mf = d.manager_fields || [];
    var _mdata = (d.packet && d.packet.data) || {};
    var managerCard = _mf.length ? ('<div class="onb-card" style="margin-bottom:12px"><h2 style="font-size:16px">Employment details</h2>' +
      '<div class="onb-note" style="margin-bottom:10px">You fill these in — the new hire never sees or edits them.</div>' +
      _mf.map(function (mfl) {
        var v = _mdata[mfl.key];
        var input;
        if (mfl.type === 'select') {
          input = '<select id="mf_' + escHtml(mfl.key) + '" class="onb-mf" style="width:100%;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px">' +
            (mfl.placeholder ? '<option value=""' + ((v == null || v === '') ? ' selected' : '') + '>' + escHtml(mfl.placeholder) + '</option>' : '') +
            (mfl.options || []).map(function (o) { return '<option' + (String(v) === String(o) ? ' selected' : '') + '>' + escHtml(o) + '</option>'; }).join('') +
            '</select>';
        } else if (mfl.type === 'multiselect') {
          var _sel = Array.isArray(v) ? v.map(function (x) { return String(x); }) : [];
          input = '<div class="onb-slotpicks" data-mf-multi="' + escHtml(mfl.key) + '" style="margin:0">' +
            ((mfl.options || []).length
              ? (mfl.options || []).map(function (o) { return '<label class="onb-slotpick"><input type="checkbox" class="onb-mf-ck" value="' + escHtml(o) + '"' + (_sel.indexOf(String(o)) !== -1 ? ' checked' : '') + '><span>' + escHtml(o) + '</span></label>'; }).join('')
              : '<div class="onb-note" style="margin:0">No active cities yet — add cities first.</div>') +
            '</div>';
        } else {
          var _dv = (v != null && v !== '') ? v : (mfl.default != null ? mfl.default : '');
          input = '<input id="mf_' + escHtml(mfl.key) + '" class="onb-mf" type="' + escHtml(mfl.type || 'text') + '" value="' + escHtml(String(_dv)) + '" style="width:100%;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px">';
        }
        var _note = mfl.note ? '<div class="onb-note" style="margin:5px 0 0">' + escHtml(mfl.note) + '</div>' : '';
        return '<div style="margin-bottom:10px"><label style="display:block;font-size:12.5px;color:var(--text-muted-color,#9ca3af);margin-bottom:5px;font-weight:600">' + escHtml(mfl.label) + '</label>' + input + _note + '</div>';
      }).join('') +
      '<button class="onb-btn" onclick="onbSavePacketDetails(' + id + ')">Save employment details</button></div>') : '';
    if (body) body.innerHTML =
      '<button class="onb-btn ghost" style="margin-bottom:12px" onclick="onbTab(\'' + (window._onbReviewFrom || 'reviews') + '\')">&#8592; Back</button>' +
      packet + managerCard +
      '<div class="onb-card" style="margin-bottom:12px"><h2 style="font-size:16px">Uploaded documents</h2>' + vpanel + (docRows || '<div class="onb-note">No documents uploaded.</div>') + '</div>' +
      '<div class="onb-card">' +
        '<textarea id="onb-reopen-note" placeholder="Note to the new hire (why you are sending items back)" style="width:100%;min-height:64px;background:var(--bg,#0f0f0f);color:var(--text,#ededed);border:1px solid var(--border,#2a2a2a);border-radius:8px;padding:10px;margin-bottom:12px"></textarea>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
          '<button class="onb-btn" style="background:#16a34a;color:#fff" onclick="onbApprovePhase1(' + id + ')">&#10003; Approve Phase 1</button>' +
          '<button class="onb-btn ghost" onclick="onbReopenPhase1(' + id + ')">Send flagged items back</button>' +
        '</div>' +
        '<div class="onb-note" style="margin-top:8px">Approving clears their paperwork — it does <b>not</b> start training. Phase 2 opens when you press <b>Start Phase 2</b> on the New hires list, so you begin it together. Sending back reopens only the items you check.</div>' +
      '</div>';
  };
  // In-app document viewer: renders an already-fetched blob (PDF/image) inside Nova
  // instead of opening an external browser tab. Keeps onboarding docs in-app and loads instantly.
  window.onbShowDocBlob = function (blob, name) {
    var url = URL.createObjectURL(blob);
    var type = (blob && blob.type) || '';
    var isImg = type.indexOf('image/') === 0;
    var isPdf = type.indexOf('pdf') !== -1;
    var title = escHtml(name || 'Document');
    var body = isImg
      ? '<div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:12px"><img src="' + url + '" alt="' + title + '" style="max-width:100%;max-height:100%;object-fit:contain" /></div>'
      : isPdf
        ? '<div id="onb-modal-pdf" style="flex:1;overflow:auto;background:#fff"><div class="onb-note" style="padding:16px;color:#333">Loading document\u2026</div></div>'
        : '<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:#ededed"><div style="font-size:40px">&#128196;</div><div>' + title + '</div><a href="' + url + '" download style="color:var(--primary,#f97316)">Download the file &#8595;</a></div>';
    var ov = document.createElement('div');
    ov.className = 'onb-doc-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;padding-top:env(safe-area-inset-top)';
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:#141414;border-bottom:1px solid #2a2a2a;color:#ededed">' +
        '<b style="flex:1;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + title + '</b>' +
        '<a href="' + url + '" target="_blank" rel="noopener" style="color:#9ca3af;font-size:13px;text-decoration:none">Open in tab &#8599;</a>' +
        '<button type="button" aria-label="Close" style="background:#2a2a2a;color:#fff;border:0;border-radius:8px;min-width:40px;min-height:40px;font-size:20px;cursor:pointer">&times;</button>' +
      '</div>' + body;
    var close = function () { try { URL.revokeObjectURL(url); } catch (e) {} if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    ov.querySelector('button').onclick = close;
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    if (isPdf) {
      var pc = ov.querySelector('#onb-modal-pdf');
      try { blob.arrayBuffer().then(function (buf) { onbRenderPdf(pc, { data: buf }, url); }).catch(function () {}); } catch (e) {}
    }
  };

  window.onbViewDoc = async function (docId) {
    try {
      var res = await fetch('/api/onboarding/admin/hr-doc/' + docId, { headers: { Authorization: 'Bearer ' + (state && state.token ? state.token : '') } });
      if (!res.ok) throw new Error('Could not open the document.');
      var blob = await res.blob();
      window.onbShowDocBlob(blob);
    } catch (e) { showToast(e.message || 'Could not open the document.', 'error'); }
  };
  window.onbDownloadRecord = async function (id) {
    try {
      var res = await fetch('/api/onboarding/admin/users/' + id + '/record.csv', { headers: { Authorization: 'Bearer ' + (state && state.token ? state.token : '') } });
      if (!res.ok) throw new Error('Could not export the record.');
      var blob = await res.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'onboarding-record-' + id + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { showToast(e.message || 'Export failed.', 'error'); }
  };

  window.onbAcceptExpiry = async function (docId) {
    if (!window.confirm('Accept this document even though it looks expired? They will be able to continue past that upload step. Your name is recorded on the override.')) return;
    var uid = window._onbReviewUser;
    try {
      await api('POST', '/onboarding/admin/documents/' + docId + '/accept-expiry', {});
      showToast('Accepted — they can continue.', 'success');
      if (uid) window.onbOpenReview(uid);
    } catch (e) { showToast(e.message || 'Could not accept the document.', 'error'); }
  };

  window.onbApprovePhase1 = async function (id) {
    try { await api('POST', '/onboarding/admin/users/' + id + '/phase1/approve', {}); showToast('Phase 1 approved. Press "Start Phase 2" on the New hires list when you are ready to begin training with them.', 'success'); window._onbTab = 'path'; renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Could not approve.', 'error'); }
  };
  window.onbReopenPhase1 = async function (id) {
    var slots = Array.prototype.slice.call(document.querySelectorAll('.onb-reopen-slot:checked')).map(function (c) { return c.value; }).filter(Boolean);
    var note = (document.getElementById('onb-reopen-note') || {}).value || '';
    if (!slots.length) { showToast('Check the items you want to send back.', 'error'); return; }
    try { await api('POST', '/onboarding/admin/users/' + id + '/phase1/reopen', { slots: slots, note: note }); showToast('Sent back to the new hire.', 'info'); window._onbTab = 'reviews'; renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Could not send back.', 'error'); }
  };


  async function onbAdminHistory(body) {
    var list;
    try { list = await api('GET', '/onboarding/admin/completed'); }
    catch (e) { body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed to load history.') + '</div>'; return; }
    if (!list.length) { body.innerHTML = '<div class="onb-card"><div class="onb-desc">No one has completed onboarding yet.</div></div>'; return; }
    var rows = list.map(function (u) {
      var when = u.completed_at ? String(u.completed_at).slice(0, 10) : '';
      var rl = (typeof roleLabel === 'function') ? roleLabel(u.role) : (u.role || '');
      return '<tr>' +
        '<td style="padding:11px 14px"><b>' + escHtml(u.name) + '</b><br><span class="onb-note">' + escHtml(rl) + '</span></td>' +
        '<td style="padding:11px 14px" class="onb-note">' + escHtml(when) + '</td>' +
        '<td style="padding:11px 14px" class="onb-note">' + escHtml(u.signed_off_by || '') + '</td>' +
        '<td style="padding:11px 14px;white-space:nowrap"><button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbDownloadRecord(' + u.id + ')">Record</button></td>' +
        '</tr>';
    }).join('');
    body.innerHTML = '<div class="onb-note" style="margin-bottom:12px">' + list.length + ' completed ' + (list.length === 1 ? 'hire' : 'hires') + '.</div>' +
      '<div class="onb-card" style="padding:0;overflow-x:auto"><table style="width:100%;border-collapse:collapse" class="onb-table">' +
      '<thead><tr><th style="text-align:left;padding:12px 14px">Name</th><th style="text-align:left;padding:12px 14px">Completed</th><th style="text-align:left;padding:12px 14px">Signed off by</th><th style="text-align:left;padding:12px 14px">Record</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

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
    var NHI = 'background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px';
    var NH_ROLES = [['locksmith', 'Locksmith'], ['locksmith_coordinator', 'Locksmith Coordinator'], ['dispatcher', 'Dispatcher'], ['roadside_technician', 'Roadside Technician'], ['manager', 'Manager'], ['admin', 'Admin']];
    var nhRoleOpts = NH_ROLES.map(function (r) { return '<option value="' + r[0] + '">' + r[1] + '</option>'; }).join('');
    var nhSupOpts = (users || []).filter(function (u) { return u.active !== false; }).map(function (u) { return '<option value="' + u.id + '">' + escHtml(u.name) + '</option>'; }).join('');

    var rows = (data.users || []).map(function (u) {
      var pct = u.steps_total ? Math.round((u.steps_done / u.steps_total) * 100) : 0;
      return '<tr>' +
        '<td><b>' + escHtml(u.name) + '</b><br><span class="onb-note">' + escHtml(u.supervisor_name ? 'Reports to ' + u.supervisor_name : 'No supervisor set') + '</span>' +
          '<br><span class="onb-note">' + escHtml('P1: ' + (u.phase1_approver_name || u.supervisor_name || 'admin') + ' \u00b7 P2: ' + (u.phase2_approver_name || u.supervisor_name || 'admin')) + '</span></td>' +
        '<td style="min-width:140px"><div class="onb-bar" style="margin:0 0 4px"><div style="width:' + pct + '%"></div></div><span class="onb-note">' + u.steps_done + ' / ' + u.steps_total + '</span></td>' +
        '<td>' + (u.ready_for_signoff
            ? '<span class="onb-pill ready">READY FOR SIGN-OFF</span>'
            : (u.awaiting_phase2_start
                ? '<span class="onb-pill ready">PHASE 1 APPROVED &middot; START PHASE 2</span>'
                : '<span class="onb-pill busy">' + escHtml(u.current_step || 'Not started') + '</span>')) + '</td>' +
        '<td style="white-space:nowrap">' +
          (u.ready_for_signoff && u.can_sign_off ? '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbSignOff(' + u.id + ',\'' + escHtml(u.name).replace(/'/g, '') + '\')">Sign off &amp; unlock</button> ' : '') +
          (u.awaiting_phase2_start && u.can_sign_off ? '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbStartPhase2(' + u.id + ',\'' + escHtml(u.name).replace(/'/g, '') + '\')">&#9654; Start Phase 2</button> ' : '') +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbDetail(' + u.id + ')">Details</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbOpenReview(' + u.id + ')">Docs</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbOverride(' + u.id + ')">Completion' + (u.completion_override ? ' •' : '') + '</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbDownloadRecord(' + u.id + ')">Record</button> ' +
          '<button class="onb-btn ghost" style="padding:8px 12px;font-size:13px" onclick="onbRemove(' + u.id + ')">Remove</button>' +
        '</td></tr>' +
        '<tr id="onb-detail-' + u.id + '" style="display:none"><td colspan="4"></td></tr>' +
        '<tr id="onb-ovr-' + u.id + '" style="display:none"><td colspan="4"></td></tr>';
    }).join('');

    body.innerHTML =
      '<div class="onb-card" style="margin-bottom:14px"><h2>Add a new hire</h2>' +
      '<div class="onb-desc">Creates their Nova account, emails them an invite to set a password, and enrolls them in onboarding — all in one step. No need to add them under Users first.</div>' +
      '<div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(240px,100%),1fr))">' +
        '<input id="nh-name" placeholder="Full name" style="' + NHI + '">' +
        '<input id="nh-email" type="email" placeholder="Email" style="' + NHI + '">' +
        '<input id="nh-phone" type="tel" placeholder="Mobile phone (for 2FA texts)" style="' + NHI + '">' +
        '<select id="nh-role" style="' + NHI + '">' + nhRoleOpts + '</select>' +
        '<select id="nh-supervisor" style="' + NHI + '"><option value="">Supervisor — who they report to</option>' + nhSupOpts + '</select>' +
        '<select id="nh-appr1" style="' + NHI + '"><option value="">Phase 1 approver — reviews their paperwork</option>' + nhSupOpts + '</select>' +
        '<select id="nh-appr2" style="' + NHI + '"><option value="">Phase 2 approver — starts training &amp; signs off</option>' + nhSupOpts + '</select>' +
      '</div>' +
      '<div class="onb-note" style="margin-top:8px">Leave an approver blank to fall back to their supervisor. The named approver is who gets the email — their supervisor and any admin can still step in.</div>' +
      '<button class="onb-btn" style="margin-top:12px" onclick="onbAddHire()">Add &amp; enroll</button></div>' +
      '<div class="onb-card" style="margin-bottom:18px"><h2 style="font-size:15px">Already in Nova? Enroll an existing user</h2>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<select id="onb-enroll-user" style="flex:1;min-width:200px;' + NHI + '">' + (opts || '<option value="">No one available</option>') + '</select>' +
      '<button class="onb-btn ghost" onclick="onbEnroll()">Enroll</button></div></div>' +
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
  window.onbAddHire = async function () {
    var name = ((document.getElementById('nh-name') || {}).value || '').trim();
    var email = ((document.getElementById('nh-email') || {}).value || '').trim();
    var phone = ((document.getElementById('nh-phone') || {}).value || '').trim();
    var role = (document.getElementById('nh-role') || {}).value;
    var supervisor_id = parseInt((document.getElementById('nh-supervisor') || {}).value, 10) || null;
    var phase1_approver_id = parseInt((document.getElementById('nh-appr1') || {}).value, 10) || null;
    var phase2_approver_id = parseInt((document.getElementById('nh-appr2') || {}).value, 10) || null;
    if (!name || !email || !role) { showToast('Name, email, and role are required.', 'error'); return; }
    try {
      await api('POST', '/users/new-hire', { name: name, email: email, phone: phone || null, role: role, supervisor_id: supervisor_id, phase1_approver_id: phase1_approver_id, phase2_approver_id: phase2_approver_id });
      showToast(name + ' added and enrolled.', 'success');
      renderOnboardingAdmin(document.getElementById('content'));
    } catch (e) { showToast(e.message || 'Could not add the new hire.', 'error'); }
  };
  window.onbSignOff = async function (id, name) {
    if (!window.confirm('Sign off ' + name + '? This unlocks full Nova access for them immediately.')) return;
    try { await api('POST', '/onboarding/admin/users/' + id + '/signoff', {}); showToast(name + ' is unlocked. 🎉', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Sign-off failed.', 'error'); }
  };
  window.onbStartPhase2 = async function (id, name) {
    if (!window.confirm('Start Phase 2 for ' + name + '? This unlocks their training steps and the time clock. Do this when you are ready to begin training with them.')) return;
    try { await api('POST', '/onboarding/admin/users/' + id + '/phase2/start', {}); showToast('Phase 2 started for ' + name + '.', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Could not start Phase 2.', 'error'); }
  };
  window.onbRemove = async function (id) {
    if (!window.confirm('Remove them from onboarding? Their full access unlocks WITHOUT sign-off.')) return;
    try { await api('POST', '/onboarding/admin/users/' + id + '/remove', {}); showToast('Removed from onboarding.', 'info'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };
  // Render every graded attempt for one quiz/exam step: each question with its
  // options, the correct answer (green ✓), and what the hire actually picked
  // (their pick tagged; a wrong pick shown red ✗). Newest attempt first.
  function onbRenderAttempts(list) {
    var ordered = (list || []).slice().sort(function (a, b) { return (b.attempt_id || 0) - (a.attempt_id || 0); });
    var total = ordered.length;
    if (!total) return '';
    return ordered.map(function (a, idx) {
      var when = '';
      if (a.submitted_at) { try { when = new Date(a.submitted_at).toLocaleString(); } catch (e) { when = ''; } }
      var head = '<div style="font-weight:600;font-size:13px;margin:8px 0 4px">Attempt ' + (total - idx) +
        ' — <span style="color:' + (a.passed ? '#16a34a' : '#dc2626') + '">' + (a.score == null ? '—' : a.score + '%') + ' ' + (a.passed ? 'Passed' : 'Failed') + '</span>' +
        (when ? ' <span style="color:#888;font-weight:400">&middot; ' + escHtml(when) + '</span>' : '') + '</div>';
      var qhtml = (a.questions || []).map(function (q, qi) {
        var opts = (q.options || []).map(function (opt, oi) {
          var isCorrect = oi === q.correct_index;
          var isChosen = oi === q.selected_index;
          var mark = isCorrect ? '&#10003;' : (isChosen ? '&#10007;' : '&nbsp;&nbsp;');
          var color = isCorrect ? '#16a34a' : (isChosen ? '#dc2626' : '#555');
          var weight = (isCorrect || isChosen) ? '600' : '400';
          var tag = isChosen ? ' <span style="color:#888;font-weight:400">(their answer)</span>' : '';
          return '<div style="padding:1px 0;color:' + color + ';font-weight:' + weight + '">' + mark + ' ' + escHtml(opt) + tag + '</div>';
        }).join('');
        var missed = (q.selected_index !== q.correct_index) ? ' <span style="color:#dc2626;font-weight:600">(missed)</span>' : '';
        return '<div style="margin:6px 0 8px"><div style="font-weight:600;font-size:13px">' + (qi + 1) + '. ' + escHtml(q.prompt) + missed + '</div>' + opts + '</div>';
      }).join('');
      return '<div style="border-left:2px solid #e5e7eb;padding-left:10px;margin:0 0 8px">' + head + qhtml + '</div>';
    }).join('');
  }
  window.onbToggleQA = function (uid, stepId) {
    var el = document.getElementById('onb-qa-' + uid + '-' + stepId);
    if (!el) return;
    var lnk = document.getElementById('onb-qa-lnk-' + uid + '-' + stepId);
    if (el.style.display === 'none') { el.style.display = ''; if (lnk) lnk.textContent = 'Hide questions & answers'; }
    else { el.style.display = 'none'; if (lnk) lnk.textContent = 'View questions & answers'; }
  };
  window.onbDetail = async function (id) {
    var row = document.getElementById('onb-detail-' + id);
    if (!row) return;
    if (row.style.display !== 'none') { row.style.display = 'none'; return; }
    row.style.display = '';
    row.firstChild.innerHTML = '<div class="onb-note" style="padding:10px 14px">Loading…</div>';
    try {
      var steps = await api('GET', '/onboarding/admin/users/' + id + '/detail');
      var attempts = [];
      try { attempts = await api('GET', '/onboarding/admin/users/' + id + '/attempts'); } catch (e) { attempts = []; }
      var byStep = {};
      (attempts || []).forEach(function (a) { (byStep[a.step_id] = byStep[a.step_id] || []).push(a); });
      row.firstChild.innerHTML = '<div style="padding:8px 14px 14px">' + steps.map(function (s) {
        var head = '<div class="onb-note" style="padding:3px 0">' + (s.status === 'done' ? '✅' : '⬜') + ' ' + stepIcon(s.type) + ' ' + escHtml(s.title) +
          (s.score != null ? ' — best ' + s.score + '%' : '') + (s.attempts ? ' (' + s.attempts + ' attempt' + (s.attempts === 1 ? '' : 's') + ')' : '');
        var att = byStep[s.id];
        if ((s.type === 'quiz' || s.type === 'final_exam') && att && att.length) {
          return head + ' &nbsp;<a href="#" id="onb-qa-lnk-' + id + '-' + s.id + '" onclick="onbToggleQA(' + id + ',' + s.id + ');return false;" style="color:#2563eb;text-decoration:underline">View questions &amp; answers</a></div>' +
            '<div id="onb-qa-' + id + '-' + s.id + '" style="display:none;margin:2px 0 12px 22px;padding:6px 0">' + onbRenderAttempts(att) + '</div>';
        }
        return head + '</div>';
      }).join('') + '</div>';
    } catch (e) { row.firstChild.innerHTML = '<div class="onb-note" style="padding:10px 14px">' + escHtml(e.message || 'Failed') + '</div>'; }
  };

  // Which required document(s) an upload step collects. Empty config.slots means
  // the legacy shape: one step that collects every document.
  function stepSlotKeys(s) {
    var c = s && s.config; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = null; } }
    var v = (c && c.slots) || [];
    return Array.isArray(v) ? v.map(function (x) { return (x && x.key) ? x.key : String(x); }) : [];
  }
  function slotLabel(key) {
    var cat = window._onbSlotCatalog || [];
    for (var i = 0; i < cat.length; i++) if (cat[i].key === key) return cat[i].label;
    return key;
  }

  async function onbAdminPath(body) {
    var steps = [], sops = [];
    try { steps = await api('GET', '/onboarding/admin/steps'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { sops = await api('GET', '/onboarding/admin/sops'); } catch (e) {}
    var vdocs = [];
    try { vdocs = await api('GET', '/onboarding/admin/vault-docs'); } catch (e) {}
    try { var _cat = await api('GET', '/onboarding/admin/slot-catalog'); window._onbSlotCatalog = _cat.slots || []; } catch (e) { window._onbSlotCatalog = []; }
    window._onbEditId = null;
    window._onbSteps = steps;
    var slotBoxes = (window._onbSlotCatalog || []).map(function (s) {
      return '<label class="onb-slotpick"><input type="checkbox" class="onb-new-slot" value="' + escHtml(s.key) + '"><span>' + escHtml(s.label) + '</span></label>';
    }).join('');
    var ONB_STEP_ROLES = ['locksmith', 'locksmith_coordinator', 'dispatcher', 'roadside_technician', 'manager', 'admin'];
    var roleBoxes = ONB_STEP_ROLES.map(function (r) {
      var lbl = (typeof roleLabel === 'function') ? roleLabel(r) : r;
      return '<label class="onb-slotpick"><input type="checkbox" class="onb-new-role" value="' + escHtml(r) + '"><span>' + escHtml(lbl) + '</span></label>';
    }).join('');
    // Any document no step claims would never be collected — say so plainly.
    var unclaimed = (window._onbSlotCatalog || []).filter(function (s) { return !s.claimed_by; });
    var legacy = steps.filter(function (s) { return s.type === 'document_upload' && !stepSlotKeys(s).length; });
    var sopOpts = (sops || []).map(function (s) { return '<option value="' + s.id + '">' + escHtml(s.title) + '</option>'; }).join('');
    var _docByFolder = {};
    (vdocs || []).forEach(function (d) { var g = d.folder || 'Other'; (_docByFolder[g] = _docByFolder[g] || []).push(d); });
    var docOpts = Object.keys(_docByFolder).map(function (g) {
      return '<optgroup label="' + escHtml(g) + '">' + _docByFolder[g].map(function (d) { return '<option value="' + d.id + '">' + escHtml(d.name) + '</option>'; }).join('') + '</optgroup>';
    }).join('');

    var rows = steps.map(function (s, i) {
      var meta = ['Phase ' + ((parseInt(s.phase, 10) === 2) ? 2 : 1)];
      if (Array.isArray(s.roles) && s.roles.length) meta.push('Roles: ' + s.roles.map(function (r) { return (typeof roleLabel === 'function') ? roleLabel(r) : r; }).join(', '));
      if (s.type === 'quiz') { var c = s.config || {}; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = {}; } } meta.push((c.question_count || 3) + ' questions, pass ' + (c.pass_score || 80) + '%'); }
      if (s.type === 'sop_read' && s.doc_title) meta.push('Document: ' + s.doc_title);
      else if (s.sop_title) meta.push('SOP: ' + s.sop_title);
      if (s.type === 'document_upload') {
        var sk = stepSlotKeys(s);
        meta.push(sk.length
          ? 'Collects: ' + sk.map(slotLabel).join(', ')
          : 'Collects: every document (nothing ticked)');
      }
      return '<div class="onb-step onb-drag" draggable="true" ondragstart="onbDragStart(event,' + s.id + ')" ondragover="onbDragOver(event)" ondragleave="onbDragLeave(event)" ondrop="onbDrop(event,' + s.id + ')" ondragend="onbDragEnd(event)" style="opacity:1">' +
        '<span class="onb-grip" title="Drag to reorder">&#9776;</span>' +
        '<div class="onb-dot">' + (i + 1) + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-weight:600">' + stepIcon(s.type) + ' ' + escHtml(s.title) + '</div>' +
        (meta.length ? '<div class="onb-note">' + escHtml(meta.join(' · ')) + '</div>' : '') + '</div>' +
        '<button class="onb-btn ghost" style="padding:6px 10px" onclick="onbEditStep(' + s.id + ')">Edit</button>' +
        '<button class="onb-btn ghost" style="padding:6px 10px" onclick="onbDeleteStep(' + s.id + ')">✕</button>' +
        '</div>';
    }).join('');

    var slotWarn = '';
    if (steps.filter(function (s) { return s.type === 'document_upload'; }).length > 1) {
      // Several upload steps is almost always a mistake: one step already shows the
      // hire a box per document on a single screen.
      slotWarn = '<div class="onb-verify" style="margin-bottom:14px"><div class="v-row warn">&#9888; ' +
        escHtml('You have ' + steps.filter(function (s) { return s.type === 'document_upload'; }).length + ' separate upload steps. You usually want just one — a single upload step already shows the new hire a box for each document on the same screen. Keep one step, tick every document it should collect, and delete the rest.') +
        '</div></div>';
    } else if (unclaimed.length && !legacy.length) {
      slotWarn = '<div class="onb-verify" style="margin-bottom:14px"><div class="v-row warn">&#9888; ' +
        escHtml('No step collects: ' + unclaimed.map(function (s) { return s.label; }).join(', ') + '.') +
        '</div></div>';
    }
    body.innerHTML =
      slotWarn +
      '<div class="onb-steps">' + (rows || '<div class="onb-note">No steps yet — add the first one below.</div>') + '</div>' +
      '<div class="onb-note" style="margin:-8px 0 18px">The supervisor sign-off gate is automatic and always comes last — you do not add it as a step.</div>' +
      '<div class="onb-card"><h2>Add a step</h2>' +
      '<div style="display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))">' +
      '<select id="onb-new-type" onchange="onbTypeFields()" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
        '<option value="video">Video</option><option value="sop_read">Read an SOP</option><option value="quiz">Quiz on an SOP</option><option value="document_upload">Upload required documents</option><option value="acknowledge">Read &amp; acknowledge (no quiz)</option><option value="final_exam">Final exam</option><option value="form">Complete a form / packet</option></select>' +
      '<input id="onb-new-title" placeholder="Step title" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
      '<select id="onb-new-phase" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px"><option value="1">Phase 1 &middot; Paperwork</option><option value="2">Phase 2 &middot; Training</option></select>' +
      '<input id="onb-new-desc" placeholder="Short description (optional)" style="grid-column:1/-1;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' +
      '<div id="onb-f-roles" style="grid-column:1/-1">' +
        '<div class="onb-note" style="margin-bottom:6px;font-weight:600">Who does this step apply to?</div>' +
        '<div class="onb-slotpicks">' + roleBoxes + '</div>' +
        '<div class="onb-note">Leave every role unticked and all new hires get this step. Tick one or more roles to show it only to hires with those roles.</div>' +
      '</div>' +
      '<div id="onb-f-doc" style="display:none;grid-column:1/-1"><select id="onb-new-doc" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (docOpts || '<option value="">No files in the Standard Operating Procedures vault folder</option>') + '</select><div class="onb-note">The new hire reads this document. Choose from any Document Vault folder.</div></div>' +
      '<div id="onb-f-sop" style="display:none;grid-column:1/-1"><select id="onb-new-sop" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px">' + (sopOpts || '<option value="">No SOPs in the library yet</option>') + '</select><div class="onb-note">Quiz questions are generated from this SOP&#39;s text in the SOP library.</div></div>' +
      '<div id="onb-f-video" style="grid-column:1/-1"><input type="file" id="onb-new-video" accept="video/*" style="width:100%;color:var(--text)"><div class="onb-note" id="onb-vid-note"></div></div>' +
      '<div id="onb-f-slots" style="display:none;grid-column:1/-1">' +
        '<div class="onb-note" style="margin-bottom:6px;font-weight:600">Which document(s) does this step collect?</div>' +
        '<div class="onb-slotpicks">' + (slotBoxes || '<span class="onb-note">No document types defined.</span>') + '</div>' +
        '<div class="onb-note">Normally: one upload step with all of these ticked. The new hire gets a box for each on one screen and uploads them together. Anything left unticked is never asked for.</div>' +
      '</div>' +
      '<div id="onb-f-quiz" style="display:none;grid-column:1/-1;display:none"><div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<label class="onb-note">Questions <input id="onb-new-qcount" type="number" min="1" max="50" value="5" style="width:70px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px"></label>' +
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
    f('onb-f-doc', t === 'sop_read' || t === 'acknowledge');
    f('onb-f-sop', t === 'quiz');
    f('onb-f-video', t === 'video');
    f('onb-f-quiz', t === 'quiz' || t === 'final_exam');
    f('onb-f-slots', t === 'document_upload');
  };

  window.onbAddStep = async function () {
    var t = document.getElementById('onb-new-type').value;
    var title = document.getElementById('onb-new-title').value.trim();
    if (!title) { showToast('Give the step a title.', 'error'); return; }
    var payload = { type: t, title: title, description: document.getElementById('onb-new-desc').value.trim(), min_seconds: parseInt(document.getElementById('onb-new-min').value, 10) || 0 };
    payload.phase = parseInt((document.getElementById('onb-new-phase') || {}).value, 10) === 2 ? 2 : 1;
    payload.roles = Array.prototype.slice.call(document.querySelectorAll('.onb-new-role:checked')).map(function (c) { return c.value; });
    if (t === 'document_upload' || t === 'form') payload.min_seconds = 0;
    if (t === 'document_upload') {
      payload.slots = Array.prototype.slice.call(document.querySelectorAll('.onb-new-slot:checked')).map(function (c) { return c.value; });
      if (!payload.slots.length) { showToast('Pick at least one document for this step to collect.', 'error'); return; }
    }
    if (t === 'sop_read' || t === 'acknowledge') {
      payload.document_id = parseInt((document.getElementById('onb-new-doc') || {}).value, 10);
      if (!payload.document_id) { showToast('Pick a document from the vault.', 'error'); return; }
    }
    if (t === 'quiz') {
      payload.sop_id = parseInt((document.getElementById('onb-new-sop') || {}).value, 10);
      if (!payload.sop_id) { showToast('Pick an SOP for the quiz.', 'error'); return; }
    }
    if (t === 'quiz' || t === 'final_exam') {
      payload.question_count = parseInt(document.getElementById('onb-new-qcount').value, 10) || (t === 'final_exam' ? 20 : 5);
      payload.pass_score = parseInt(document.getElementById('onb-new-pass').value, 10) || 80;
    }
    var btn = document.getElementById('onb-add-btn');
    if (t === 'video') {
      var fi = document.getElementById('onb-new-video');
      if ((!fi || !fi.files || !fi.files.length) && !window._onbEditId) { showToast('Choose a video file.', 'error'); return; }
      if (fi && fi.files && fi.files.length) {
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
    }
    try {
      if (window._onbEditId) { await api('PUT', '/onboarding/admin/steps/' + window._onbEditId, payload); showToast('Step updated.', 'success'); }
      else { await api('POST', '/onboarding/admin/steps', payload); showToast('Step added.', 'success'); }
      window._onbEditId = null;
      renderOnboardingAdmin(document.getElementById('content'));
    }
    catch (e) { showToast(e.message || 'Failed to save step.', 'error'); }
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
  var DEFAULT_TASK = {
    recipient: 'supervisor',
    title: 'Onboarding wrap-up for {{name}}',
    description: '{{name}} ({{role}}) finished onboarding on {{date}}, signed off by {{signer}}. Handle any remaining first-week items: equipment, accounts, keys, and schedule.',
    priority: 'medium',
    due_days: 3,
    notify: true
  };
  function cloneTask(t) { try { return JSON.parse(JSON.stringify(t || DEFAULT_TASK)); } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_TASK)); } }
  function prioOptions(sel) {
    return ['low', 'medium', 'high'].map(function (p) {
      return '<option value="' + p + '"' + (p === sel ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>';
    }).join('');
  }
  // Recipient dropdown: dynamic tokens first, then real people.
  function recipientOptions(users, selectedId) {
    var sel = (selectedId == null) ? '' : String(selectedId);
    var o = '<optgroup label="Dynamic">' +
      '<option value="supervisor"' + (sel === 'supervisor' ? ' selected' : '') + '>&#9656; New hire&#39;s manager (supervisor)</option>' +
      '<option value="signer"' + (sel === 'signer' ? ' selected' : '') + '>&#9656; Person who signs off</option>' +
      '</optgroup><optgroup label="People">';
    (users || []).forEach(function (u) {
      if (u.active === false) return;
      o += '<option value="' + u.id + '"' + (String(u.id) === sel ? ' selected' : '') + '>' + escHtml(u.name) + '</option>';
    });
    return o + '</optgroup>';
  }
  var PLACEHOLDER_HINT = 'Placeholders: {{name}} (new hire), {{role}}, {{date}}, {{signer}}, {{recipient}}';

  // ---- repeatable task-row editor (shared by global config + per-hire override)
  function taskArr(prefix) {
    window._onbTaskArrays = window._onbTaskArrays || {};
    if (!window._onbTaskArrays[prefix]) window._onbTaskArrays[prefix] = [];
    return window._onbTaskArrays[prefix];
  }
  function onbSyncTasks(prefix) {
    var arr = taskArr(prefix);
    for (var i = 0; i < arr.length; i++) {
      var g = function (s) { return document.getElementById(prefix + '-t-' + i + '-' + s); };
      var e;
      if ((e = g('recipient'))) arr[i].recipient = e.value;
      if ((e = g('title'))) arr[i].title = e.value;
      if ((e = g('desc'))) arr[i].description = e.value;
      if ((e = g('prio'))) arr[i].priority = e.value;
      if ((e = g('due'))) arr[i].due_days = parseInt(e.value, 10);
      if ((e = g('notify'))) arr[i].notify = !!e.checked;
    }
    return arr;
  }
  function onbRenderTasks(prefix) {
    var arr = taskArr(prefix);
    var users = window._onbUsers || [];
    var cont = document.getElementById(prefix + '-tasks');
    if (!cont) return;
    if (!arr.length) { cont.innerHTML = '<div class="onb-note" style="padding:8px 0">No tasks — Nova will do nothing on completion. Add one below.</div>'; return; }
    cont.innerHTML = arr.map(function (t, i) {
      return '<div class="onb-card" style="padding:14px;margin-bottom:12px;border:1px solid var(--border)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<b>Task ' + (i + 1) + '</b>' +
          '<button class="onb-btn ghost" style="padding:4px 10px;font-size:12px" onclick="onbRemoveTask(\'' + prefix + '\',' + i + ')">Remove</button>' +
        '</div>' +
        '<div style="display:grid;gap:10px">' +
          '<div><div class="onb-note" style="margin-bottom:4px">Assign &amp; notify</div>' +
            '<select id="' + prefix + '-t-' + i + '-recipient" style="width:100%;' + INP + '">' + recipientOptions(users, t.recipient) + '</select></div>' +
          '<div><div class="onb-note" style="margin-bottom:4px">Task title</div>' +
            '<input id="' + prefix + '-t-' + i + '-title" value="' + escHtml(t.title || '') + '" style="width:100%;' + INP + '"></div>' +
          '<div><div class="onb-note" style="margin-bottom:4px">Task description</div>' +
            '<textarea id="' + prefix + '-t-' + i + '-desc" rows="3" style="width:100%;' + INP + ';resize:vertical">' + escHtml(t.description || '') + '</textarea></div>' +
          '<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">' +
            '<label class="onb-note">Priority<br><select id="' + prefix + '-t-' + i + '-prio" style="' + INP + '">' + prioOptions(t.priority || 'medium') + '</select></label>' +
            '<label class="onb-note">Due in (days)<br><input id="' + prefix + '-t-' + i + '-due" type="number" min="0" max="60" value="' + (t.due_days != null ? t.due_days : 3) + '" style="width:90px;' + INP + '"></label>' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="' + prefix + '-t-' + i + '-notify"' + (t.notify !== false ? ' checked' : '') + '> Send notification</label>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  window.onbAddTask = function (prefix) {
    onbSyncTasks(prefix);
    taskArr(prefix).push(cloneTask(DEFAULT_TASK));
    onbRenderTasks(prefix);
  };
  window.onbRemoveTask = function (prefix, idx) {
    onbSyncTasks(prefix);
    taskArr(prefix).splice(idx, 1);
    onbRenderTasks(prefix);
  };

  async function onbAdminCompletion(body) {
    var conf, users = [];
    try { conf = await api('GET', '/onboarding/admin/completion'); } catch (e) { body.innerHTML = escHtml(e.message || 'Failed'); return; }
    try { users = await api('GET', '/users'); } catch (e) {}
    window._onbUsers = users;
    window._onbTaskArrays = window._onbTaskArrays || {};
    window._onbTaskArrays['onc'] = (conf.tasks && conf.tasks.length) ? conf.tasks.map(cloneTask) : [cloneTask(DEFAULT_TASK)];
    body.innerHTML =
      '<div class="onb-card">' +
      '<h2>When a new hire finishes onboarding</h2>' +
      '<div class="onb-desc">On supervisor sign-off, Nova creates each task below and (optionally) notifies its recipient. Assign a specific person, or pick a dynamic recipient like the new hire&#39;s manager. This is the global default — you can override it per hire from the New Hires tab.</div>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">' +
        '<input type="checkbox" id="onc-enabled"' + (conf.enabled ? ' checked' : '') + '> <b>Enable completion tasks &amp; notifications</b></label>' +
      '<div id="onc-tasks"></div>' +
      '<button class="onb-btn ghost" style="margin-top:2px" onclick="onbAddTask(\'onc\')">+ Add task</button>' +
      '<div class="onb-note" style="margin-top:12px">' + escHtml(PLACEHOLDER_HINT) + '</div>' +
      '<div style="margin-top:16px"><button class="onb-btn" id="onc-save" onclick="onbSaveCompletion()">Save</button></div>' +
      '</div>';
    onbRenderTasks('onc');
  }

  window.onbSaveCompletion = async function () {
    onbSyncTasks('onc');
    var enabled = !!(document.getElementById('onc-enabled') || {}).checked;
    var tasks = taskArr('onc').filter(function (t) { return t && t.recipient; });
    if (enabled && !tasks.length) { showToast('Add at least one task with a recipient.', 'error'); return; }
    var payload = { enabled: enabled, tasks: tasks };
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
    var prefix = 'ovr-' + id;
    window._onbTaskArrays = window._onbTaskArrays || {};
    window._onbTaskArrays[prefix] = (ov.tasks && ov.tasks.length) ? ov.tasks.map(cloneTask) : [];
    cell.innerHTML =
      '<div style="padding:12px 14px">' +
      '<div class="onb-note" style="margin-bottom:8px">Override the completion tasks for <b>' + escHtml(hire.name || 'this hire') + '</b>. Leave empty to use the global default.</div>' +
      '<div id="' + prefix + '-tasks"></div>' +
      '<button class="onb-btn ghost" style="padding:6px 12px;font-size:12px;margin-top:2px" onclick="onbAddTask(\'' + prefix + '\')">+ Add task</button>' +
      '<div class="onb-note" style="margin-top:10px">' + escHtml(PLACEHOLDER_HINT) + '</div>' +
      '<div style="margin-top:12px;display:flex;gap:8px">' +
        '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbSaveOverride(' + id + ')">Save override</button>' +
        '<button class="onb-btn ghost" style="padding:8px 14px;font-size:13px" onclick="onbClearOverride(' + id + ')">Clear</button>' +
      '</div></div>';
    onbRenderTasks(prefix);
  };
  window.onbSaveOverride = async function (id) {
    var prefix = 'ovr-' + id;
    onbSyncTasks(prefix);
    var tasks = taskArr(prefix).filter(function (t) { return t && t.recipient; });
    var override = tasks.length ? { tasks: tasks } : null;
    try { await api('PUT', '/onboarding/admin/users/' + id + '/completion-override', { override: override }); showToast('Override saved.', 'success'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Save failed.', 'error'); }
  };
  window.onbClearOverride = async function (id) {
    try { await api('PUT', '/onboarding/admin/users/' + id + '/completion-override', { override: null }); showToast('Override cleared.', 'info'); renderOnboardingAdmin(document.getElementById('content')); }
    catch (e) { showToast(e.message || 'Failed.', 'error'); }
  };

  // ================= EMPLOYEE FILES (management view) =================
  window.renderEmployeeFiles = async function (content) {
    injectCss(); clearPoll();
    content.innerHTML = '<h1 style="margin-bottom:6px">Employee Files</h1><div class="onb-note" style="margin-bottom:16px">Encrypted personnel documents. You see the people who report up to you; owners and admins see everyone.</div><div id="onb-ef-body"><div class="loading">Loading…</div></div>';
    var body = document.getElementById('onb-ef-body');
    var list;
    try { list = await api('GET', '/onboarding/admin/employees'); }
    catch (e) { body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed to load.') + '</div>'; return; }
    body.innerHTML = list.map(function (u) {
      return '<div class="onb-step" style="justify-content:space-between"><div style="flex:1;min-width:0"><div style="font-weight:700">' + escHtml(u.name) + '</div><div class="onb-note">' + (u.doc_count || 0) + ' document' + (u.doc_count === 1 ? '' : 's') + ' on file</div></div>' +
        '<button class="onb-btn" style="padding:8px 14px;font-size:13px" onclick="onbOpenFile(' + u.id + ')">Open file</button></div>';
    }).join('') || '<div class="onb-card"><div class="onb-desc">No employees you can view.</div></div>';
  };
  window.onbOpenFile = async function (id) {
    var body = document.getElementById('onb-ef-body');
    if (body) body.innerHTML = '<div class="loading">Loading…</div>';
    var d;
    try { d = await api('GET', '/onboarding/admin/employees/' + id + '/file'); }
    catch (e) { if (body) body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed.') + '</div>'; return; }
    var cats = ['identity', 'license', 'insurance', 'registration', 'packet', 'acknowledgment', 'review', 'disciplinary', 'tax', 'certification', 'other'];
    var byCat = {}; (d.documents || []).forEach(function (doc) { (byCat[doc.category] = byCat[doc.category] || []).push(doc); });
    var sections = cats.filter(function (c) { return byCat[c]; }).map(function (c) {
      return '<div class="onb-card" style="margin-bottom:10px"><h2 style="font-size:15px;text-transform:capitalize">' + escHtml(c) + '</h2>' +
        byCat[c].map(function (doc) {
          return '<div class="onb-slot filled"><div class="onb-slot-ic">&#128196;</div><div class="onb-slot-b"><b>' + escHtml(doc.name || 'document') + '</b><span>' + escHtml(doc.source || '') + (doc.expires_at ? ' &middot; exp ' + escHtml(String(doc.expires_at).slice(0, 10)) : '') + '</span></div>' +
            '<button class="onb-slot-act" onclick="onbViewDoc(' + doc.id + ')">View</button>' +
            '<button class="onb-slot-act" style="margin-left:8px;color:#f87171;border-color:#ef444455" onclick="onbDeleteFileDoc(' + doc.id + ',' + id + ')">Delete</button></div>';
        }).join('') + '</div>';
    }).join('');
    var catOpts = cats.map(function (c) { return '<option value="' + c + '">' + c.charAt(0).toUpperCase() + c.slice(1) + '</option>'; }).join('');
    var uploadForm = '<div class="onb-card"><h2 style="font-size:15px">Add a document</h2>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
        '<select id="onb-ef-cat" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:9px">' + catOpts + '</select>' +
        '<label class="onb-note">Expiration (optional) <input type="date" id="onb-ef-exp" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px"></label>' +
      '</div>' +
      '<input type="file" id="onb-ef-file" accept="image/*,application/pdf" style="display:block;color:var(--text);margin-bottom:10px">' +
      '<button class="onb-btn" onclick="onbUploadFileDoc(' + id + ')">Upload</button><div class="onb-note" id="onb-ef-note"></div></div>';
    if (body) body.innerHTML = '<button class="onb-btn ghost" style="margin-bottom:12px" onclick="renderEmployeeFiles(document.getElementById(\'content\'))">&#8592; All employees</button>' +
      '<h2 style="margin:0 0 12px">' + escHtml(d.user.name) + '</h2>' + (sections || '<div class="onb-note" style="margin-bottom:12px">No documents on file yet.</div>') + uploadForm;
  };
  window.onbUploadFileDoc = async function (id) {
    var fi = document.getElementById('onb-ef-file'); var note = document.getElementById('onb-ef-note');
    if (!fi || !fi.files || !fi.files.length) { showToast('Choose a file first.', 'error'); return; }
    var file = fi.files[0];
    if (file.size > 20 * 1024 * 1024) { showToast('That file is too large (max 20 MB).', 'error'); return; }
    if (note) note.textContent = 'Uploading ' + file.name + '...';
    try {
      var dataUrl = await onbReadFileB64(file);
      await api('POST', '/onboarding/admin/employees/' + id + '/upload', { category: (document.getElementById('onb-ef-cat') || {}).value, expires_at: (document.getElementById('onb-ef-exp') || {}).value, filename: file.name, mime_type: file.type || 'application/octet-stream', data: dataUrl });
      showToast('Uploaded.', 'success'); onbOpenFile(id);
    } catch (e) { if (note) note.textContent = ''; showToast(e.message || 'Upload failed.', 'error'); }
  };
  window.onbDeleteFileDoc = async function (docId, userId) {
    try { await api('DELETE', '/onboarding/admin/employees/hr-doc/' + docId, {}); showToast('Deleted.', 'info'); onbOpenFile(userId); }
    catch (e) { showToast(e.message || 'Could not delete.', 'error'); }
  };


  // ================= MY DOCUMENTS (employee self-view, read-only) =================
  window.renderMyFile = async function (content) {
    injectCss(); clearPoll();
    content.innerHTML = '<h1 style="margin-bottom:6px">My Documents</h1><div class="onb-note" style="margin-bottom:16px">Your personal documents on file. These are encrypted and visible only to you and management.</div><div id="onb-mine"><div class="loading">Loading…</div></div>';
    var body = document.getElementById('onb-mine');
    var d;
    try { d = await api('GET', '/onboarding/me/file'); }
    catch (e) { body.innerHTML = '<div class="onb-note">' + escHtml(e.message || 'Failed to load.') + '</div>'; return; }
    var docs = d.documents || [];
    if (!docs.length) { body.innerHTML = '<div class="onb-card"><div class="onb-desc">You have no documents on file yet.</div></div>'; return; }
    var cats = ['identity', 'license', 'insurance', 'registration', 'packet', 'acknowledgment', 'review', 'disciplinary', 'tax', 'certification', 'other'];
    var byCat = {}; docs.forEach(function (doc) { (byCat[doc.category] = byCat[doc.category] || []).push(doc); });
    body.innerHTML = cats.filter(function (c) { return byCat[c]; }).map(function (c) {
      return '<div class="onb-card" style="margin-bottom:10px"><h2 style="font-size:15px;text-transform:capitalize">' + escHtml(c) + '</h2>' +
        byCat[c].map(function (doc) {
          return '<div class="onb-slot filled"><div class="onb-slot-ic">&#128196;</div><div class="onb-slot-b"><b>' + escHtml(doc.name || 'document') + '</b><span>' + (doc.expires_at ? 'exp ' + escHtml(String(doc.expires_at).slice(0, 10)) : escHtml(doc.source || '')) + '</span></div><button class="onb-slot-act" onclick="onbViewMyDoc(' + doc.id + ')">View</button></div>';
        }).join('') + '</div>';
    }).join('');
  };
  window.onbViewMyDoc = async function (docId) {
    try {
      var res = await fetch('/api/onboarding/me/hr-doc/' + docId, { headers: { Authorization: 'Bearer ' + (state && state.token ? state.token : '') } });
      if (!res.ok) throw new Error('Could not open the document.');
      var blob = await res.blob();
      window.onbShowDocBlob(blob);
    } catch (e) { showToast(e.message || 'Could not open the document.', 'error'); }
  };


  window.onbSubmitPacket = async function (stepId) {
    var data = {};
    document.querySelectorAll('.onb-pf').forEach(function (el) { data[el.id.slice(3)] = el.value; });
    document.querySelectorAll('input[type="checkbox"][id^="pf_"]').forEach(function (el) { data[el.id.slice(3)] = el.checked; });
    try { await api('POST', '/onboarding/steps/' + stepId + '/packet', { data: data }); showToast('Packet submitted.', 'success'); renderOnboardingMode(document.getElementById('app')); }
    catch (e) { showToast(e.message || 'Could not submit.', 'error'); }
  };


  // ---- drag-and-drop reorder of onboarding steps ----
  window.onbDragStart = function (e, id) {
    window._onbDragId = id;
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(id)); } catch (x) {} }
    var el = e.currentTarget; if (el) el.style.opacity = '.45';
  };
  window.onbDragOver = function (e) {
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    var el = e.currentTarget; if (el) el.style.boxShadow = 'inset 0 2px 0 var(--primary,#f97316)';
  };
  window.onbDragLeave = function (e) { var el = e.currentTarget; if (el) el.style.boxShadow = ''; };
  window.onbDragEnd = function () {
    document.querySelectorAll('.onb-drag').forEach(function (el) { el.style.opacity = '1'; el.style.boxShadow = ''; });
  };
  window.onbDrop = async function (e, targetId) {
    e.preventDefault();
    var dragId = window._onbDragId; window._onbDragId = null;
    document.querySelectorAll('.onb-drag').forEach(function (el) { el.style.opacity = '1'; el.style.boxShadow = ''; });
    if (!dragId || dragId === targetId) return;
    var ids = (window._onbSteps || []).map(function (s) { return s.id; });
    var from = ids.indexOf(dragId); if (from === -1) return;
    ids.splice(from, 1);
    var t2 = ids.indexOf(targetId); if (t2 === -1) t2 = ids.length;
    ids.splice(t2, 0, dragId);
    try { await api('POST', '/onboarding/admin/steps/reorder', { ids: ids }); renderOnboardingAdmin(document.getElementById('content')); }
    catch (err) { showToast(err.message || 'Reorder failed.', 'error'); }
  };

  // ---- edit an existing step (reuses the Add-a-step form) ----
  window.onbEditStep = function (id) {
    var steps = window._onbSteps || [];
    var s = null; for (var i = 0; i < steps.length; i++) { if (steps[i].id === id) { s = steps[i]; break; } }
    if (!s) return;
    window._onbEditId = id;
    var c = s.config; if (typeof c === 'string') { try { c = JSON.parse(c); } catch (e) { c = {}; } } c = c || {};
    var g = function (idd) { return document.getElementById(idd); };
    var typeSel = g('onb-new-type'); if (typeSel) { typeSel.value = s.type; typeSel.disabled = true; }
    if (g('onb-new-title')) g('onb-new-title').value = s.title || '';
    if (g('onb-new-desc')) g('onb-new-desc').value = s.description || '';
    if (g('onb-new-phase')) g('onb-new-phase').value = String((parseInt(s.phase, 10) === 2) ? 2 : 1);
    var _sr = Array.isArray(s.roles) ? s.roles : [];
    Array.prototype.slice.call(document.querySelectorAll('.onb-new-role')).forEach(function (cb3) { cb3.checked = _sr.indexOf(cb3.value) !== -1; });
    if (g('onb-new-min')) g('onb-new-min').value = (c.min_seconds != null ? c.min_seconds : 30);
    onbTypeFields();
    if (s.type === 'quiz' || s.type === 'final_exam') {
      if (g('onb-new-qcount')) g('onb-new-qcount').value = c.question_count || (s.type === 'final_exam' ? 20 : 5);
      if (g('onb-new-pass')) g('onb-new-pass').value = c.pass_score || 80;
    }
    if (s.type === 'quiz' && g('onb-new-sop') && s.sop_id) g('onb-new-sop').value = s.sop_id;
    if ((s.type === 'sop_read' || s.type === 'acknowledge') && g('onb-new-doc') && c.document_id) g('onb-new-doc').value = c.document_id;
    if (s.type === 'document_upload') {
      var picked = stepSlotKeys(s);
      Array.prototype.slice.call(document.querySelectorAll('.onb-new-slot')).forEach(function (cb2) {
        cb2.checked = picked.indexOf(cb2.value) !== -1;
      });
    }
    var addBtn = g('onb-add-btn'); if (addBtn) addBtn.textContent = 'Save changes';
    if (addBtn && !g('onb-cancel-edit')) {
      var cb = document.createElement('button'); cb.id = 'onb-cancel-edit'; cb.className = 'onb-btn ghost'; cb.style.marginLeft = '8px'; cb.textContent = 'Cancel'; cb.onclick = function () { onbCancelEdit(); };
      addBtn.parentNode.insertBefore(cb, addBtn.nextSibling);
    }
    var card = addBtn && addBtn.closest ? addBtn.closest('.onb-card') : null; if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  window.onbCancelEdit = function () { window._onbEditId = null; renderOnboardingAdmin(document.getElementById('content')); };


  window.onbSavePacketDetails = async function (id) {
    var data = {};
    document.querySelectorAll('.onb-mf').forEach(function (el) { data[el.id.slice(3)] = el.value; });
    document.querySelectorAll('[data-mf-multi]').forEach(function (box) {
      data[box.getAttribute('data-mf-multi')] = Array.prototype.slice.call(box.querySelectorAll('.onb-mf-ck:checked')).map(function (c) { return c.value; });
    });
    try { await api('POST', '/onboarding/admin/users/' + id + '/packet-details', { data: data }); showToast('Employment details saved.', 'success'); }
    catch (e) { showToast(e.message || 'Could not save.', 'error'); }
  };

})();
