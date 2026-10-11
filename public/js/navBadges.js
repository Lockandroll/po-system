// Sidebar badges (2026-10-11).
//
// Tony: "Can you put the number of items to address as badges on the menu?
// Like all the way up to People ... a locksmith should not see the badge for a
// write up to another employee."
//
// The server (routes/navCounts.js) decides what counts and for whom; every
// number it sends is something that is waiting on THIS person. This file only
// draws them:
//
//   - each row gets its own count,
//   - each section header (and nested sub-section) gets the SUM of the rows
//     under it that this person can actually see, so "People 3" always equals
//     what you find when you open People,
//   - the mobile hamburger gets the grand total, so a closed drawer still says
//     something is waiting.
//
// How it gets onto the menu: navModel() is a function declaration in app.js,
// so it is reassignable from here (employeeRecords.js uses the same trick), and
// buildNavHtml drops labels into the HTML unescaped, so a badge rides along on
// the label without app.js's nav code changing. Everything is wrapped so a bad
// response can only ever mean "no badges", never a broken sidebar.
//
// Refresh: on first paint, every 90 seconds while the tab is visible, when the
// tab comes back into view, and shortly after any write (approve, sign, etc.)
// so the badge you just cleared goes away without a reload.
//
// House style: string concatenation, no template literals (CLAUDE.md 1.1).

(function () {
  'use strict';

  // Tells employeeRecords.js to stop stamping its own two badges; this module
  // now owns every sidebar count, including those.
  window.NOVA_NAV_BADGES = true;

  var NB = { items: {}, total: 0, loaded: false, inflight: null, lastAt: 0, timer: null, writeTimer: null };
  var POLL_MS = 90000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function injectCss() {
    if (document.getElementById('nb-css')) return;
    var st = document.createElement('style');
    st.id = 'nb-css';
    st.textContent = [
      '.nb-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:auto;border-radius:9px;background:#ef4444;color:#fff;font-size:11px;font-weight:800;line-height:1;flex-shrink:0;font-variant-numeric:tabular-nums}',
      // Section totals are a softer tone than the rows so the eye goes to the
      // row that actually needs the click once the section is open.
      '.nb-count.nb-sum{background:rgba(239,68,68,0.18);color:#f87171;border:1px solid rgba(239,68,68,0.45)}',
      '.nav-section-header .s-label,.nav-subsection-header .s-label{flex:1;min-width:0}',
      '.nav-section-header .s-label .nb-count,.nav-subsection-header .s-label .nb-count{margin-right:6px}',
      '.hamburger{position:relative}',
      '.nb-ham{position:absolute;top:-4px;right:-6px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:800;line-height:16px;text-align:center;pointer-events:none}'
    ].join('');
    document.head.appendChild(st);
  }

  function signedIn() {
    return typeof state !== 'undefined' && state && state.token && state.user &&
      !(state.user.onboarding_status && state.user.onboarding_status !== 'complete');
  }

  function badge(n, title, sum) {
    if (!n || n < 1) return '';
    var shown = n > 99 ? '99+' : String(n);
    return '<span class="nb-count' + (sum ? ' nb-sum' : '') + '" title="' + esc(title) + '">' + shown + '</span>';
  }

  function rowTitle(entry) {
    return (entry.parts || []).map(function (p) { return p.n + ' ' + p.label; }).join(' · ');
  }

  // Walks the model, stamps each row, and returns the total under this level.
  // Only rows present in the model are counted - the model is already filtered
  // by permission, so a count for a row you cannot see never reaches a header.
  function stamp(nodes) {
    var sum = 0;
    for (var i = 0; i < (nodes || []).length; i++) {
      var n = nodes[i];
      if (!n || n.type === 'new' || n.type === 'link') continue;
      if (String(n.label).indexOf('nb-count') !== -1) continue; // already stamped
      if (n.type === 'group' || n.type === 'subgroup') {
        var s = stamp(n.children);
        if (s > 0) n.label = n.label + badge(s, s + ' waiting on you', true);
        sum += s;
        continue;
      }
      var e = n.view ? NB.items[n.view] : null;
      if (e && e.n > 0) {
        n.label = n.label + badge(e.n, rowTitle(e), false);
        sum += e.n;
      }
    }
    return sum;
  }

  function paintHamburger(total) {
    try {
      var h = document.querySelector('.hamburger');
      if (!h) return;
      var b = h.querySelector('.nb-ham');
      if (!total) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('span'); b.className = 'nb-ham'; h.appendChild(b); }
      b.textContent = total > 99 ? '99+' : String(total);
    } catch (e) {}
  }

  function redrawNav() {
    try {
      var nav = document.querySelector('.sidebar-nav');
      if (nav && typeof buildNavHtml === 'function') nav.innerHTML = buildNavHtml();
    } catch (e) {}
  }

  function same(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  function refresh(fresh) {
    if (!signedIn()) return Promise.resolve(0);
    if (NB.inflight) return NB.inflight;
    NB.inflight = (async function () {
      try {
        // _apiFetch rather than api(): this must never answer from the GET
        // cache, and a background poll should not flash the progress bar.
        var d = await _apiFetch('GET', '/nav/counts' + (fresh ? '?fresh=1' : ''), null, true);
        var items = (d && d.items) || {};
        var changed = !NB.loaded || !same(items, NB.items);
        NB.items = items;
        NB.loaded = true;
        NB.lastAt = Date.now();
        if (changed) redrawNav();
      } catch (e) {
        // Fail quiet: a badge is not worth an error on somebody's screen.
        NB.lastAt = Date.now();
      }
      NB.inflight = null;
      return NB.total;
    })();
    return NB.inflight;
  }

  // Wrap navModel. Runs on every sidebar paint (render and redrawNav alike).
  var origNavModel = window.navModel;
  if (typeof origNavModel === 'function') {
    window.navModel = function () {
      var model = origNavModel.apply(this, arguments);
      try {
        injectCss();
        // A different person on the same tab (View As, or a new sign-in) must
        // never inherit the last person's numbers.
        var who = (state.user && state.user.id) + ':' + (state.viewAsId || '') + ':' + (state.user && state.user.role);
        if (NB.who !== who) { NB.who = who; NB.items = {}; NB.loaded = false; NB.lastAt = 0; }
        if (!NB.loaded && !NB.inflight) refresh(false);
        else if (Date.now() - NB.lastAt > 30000 && !NB.inflight) refresh(false);
        NB.total = stamp(model);
        // render() writes the hamburger AFTER it builds the nav, so paint it on
        // the next tick when the button exists.
        var t = NB.total;
        setTimeout(function () { paintHamburger(t); }, 0);
      } catch (e) {}
      return model;
    };
  }

  // After any write, look again - that is usually the moment a badge clears
  // (approved the PO, signed the notice). Debounced so a save that fires three
  // requests asks once.
  var origApi = window.api;
  if (typeof origApi === 'function') {
    window.api = function (method) {
      var p = origApi.apply(this, arguments);
      if (String(method).toUpperCase() !== 'GET') {
        Promise.resolve(p).then(function () {
          clearTimeout(NB.writeTimer);
          NB.writeTimer = setTimeout(function () { refresh(true); }, 1200);
        }, function () {});
      }
      return p;
    };
  }

  function startPoll() {
    if (NB.timer) return;
    NB.timer = setInterval(function () {
      if (document.visibilityState === 'visible') refresh(false);
    }, POLL_MS);
  }
  startPoll();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - NB.lastAt > 15000) refresh(true);
  });

  // Signing out (or switching user) must not show the last person's numbers.
  var origLogout = window.logout;
  if (typeof origLogout === 'function') {
    window.logout = function () {
      NB.items = {}; NB.total = 0; NB.loaded = false; NB.lastAt = 0;
      return origLogout.apply(this, arguments);
    };
  }

  // For tests and for other modules that want to nudge a refresh.
  window.navBadgesRefresh = function () { return refresh(true); };
  window._navBadges = { state: NB, stamp: stamp };
})();
