// Nova seasonal decorations — public/js/seasons.js
// Self-contained. Loads AFTER app.js so it may use the globals state, api, can, escHtml.
// HOUSE STYLE: string concatenation only, NEVER backticks/template literals (Windows
// corrupts backticks in .js). Every decoration is pointer-events:none so it can never
// intercept a click, and everything is wrapped in try/catch so a failure here can never
// take the app down.
//
// What it does: when the "seasonal_decor" company setting is enabled, it looks at today's
// date, finds the active holiday (Easter and Thanksgiving are computed each year), and
// lays light decorations onto the CHROME only — the Nova wordmark, a garland under the
// header, an avatar topper, an accent wash, and (playful look) drifting particles in a
// fixed background layer that shows through the transparent main pane but stays behind the
// opaque cards and the sidebar. Sign-in gets the fuller "playful" treatment; the app
// pages default to the "subtle" look. Respects prefers-reduced-motion. Ships OFF.

(function () {
  'use strict';
  if (window.__novaSeasonsLoaded) return;
  window.__novaSeasonsLoaded = true;

  var ROOT = document.documentElement;
  var reduce = false;
  try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches; } catch (e) {}

  // ---- config / state -------------------------------------------------------
  var CFG_KEY = 'nova_decor_cfg';     // cached {enabled,look} so the login screen can decorate pre-auth
  var OFF_KEY = 'nova_decor_off';     // per-user opt out on this device
  var cfg = { enabled: false, look: 'subtle' };
  var fetched = false;
  var builtSeason = null;             // season the bg layer was last built for
  var builtLook = null;

  function readCache() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) { var o = JSON.parse(raw); if (o && typeof o === 'object') cfg = { enabled: !!o.enabled, look: (o.look === 'playful' ? 'playful' : 'subtle') }; }
    } catch (e) {}
  }
  function writeCache() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function personallyOff() { try { return localStorage.getItem(OFF_KEY) === '1'; } catch (e) { return false; } }

  // ---- date -> active holiday ----------------------------------------------
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function easter(y) { // Western (Gregorian), Meeus/Jones/Butcher
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, mo - 1, da);
  }
  function thanksgiving(y) { // 4th Thursday of November
    var d = new Date(y, 10, 1);
    while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + 21);
    return midnight(d);
  }
  function activeHoliday(today) {
    var d = midnight(today);
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    var t = m * 100 + day;
    function within(a, b) { return t >= a && t <= b; }
    // order matters where windows can touch: St Patrick's beats an early Easter lead-up.
    if (within(208, 214)) return 'valentines';
    if (within(313, 317)) return 'stpatricks';
    var e = easter(y), es = new Date(e); es.setDate(es.getDate() - 7);
    if (d >= midnight(es) && d <= midnight(e)) return 'easter';
    if (within(701, 705)) return 'july4';
    if (within(901, 930)) return 'fall';
    if (within(1001, 1031)) return 'halloween';
    var tg = thanksgiving(y), ts = new Date(tg); ts.setDate(ts.getDate() - 3); var te = new Date(tg); te.setDate(te.getDate() + 1);
    if (d >= midnight(ts) && d <= midnight(te)) return 'thanksgiving';
    if (within(1201, 1225)) return 'christmas';
    if ((m === 12 && day >= 26) || (m === 1 && day <= 2)) return 'newyear';
    return null;
  }

  // ---- motif svgs -----------------------------------------------------------
  function motif(name, c) {
    switch (name) {
      case 'pumpkin': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6c-.6-2.2.6-3.4 2.4-3.2" fill="none" stroke="#7a9a3a" stroke-width="1.6" stroke-linecap="round"/><ellipse cx="8.6" cy="14.5" rx="4.6" ry="5.6" fill="#e2670f"/><ellipse cx="15.4" cy="14.5" rx="4.6" ry="5.6" fill="#e2670f"/><ellipse cx="12" cy="14.5" rx="5.4" ry="6.2" fill="#f97316"/><path d="M10.2 12.6l-1.6 2.2h3.2z" fill="#2a1400"/><path d="M13.8 12.6l1.6 2.2h-3.2z" fill="#2a1400"/><path d="M9.2 16.6c1.8 1.3 3.8 1.3 5.6 0" fill="none" stroke="#2a1400" stroke-width="1.2" stroke-linecap="round"/></svg>';
      case 'holly': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4c2.4 1.4 2.4 4.6 0 6.4-2.4-1.8-2.4-5 0-6.4Z" fill="#2bb56b"/><path d="M5.4 8.2c2.7-.5 4.7 1 5.8 2.9-2.1 1-4.2.4-5.3-1.6Z" fill="#1f9d55"/><path d="M18.6 8.2c-2.7-.5-4.7 1-5.8 2.9 2.1 1 4.2.4 5.3-1.6Z" fill="#1f9d55"/><circle cx="10.8" cy="13" r="1.7" fill="#e23b3b"/><circle cx="13.4" cy="13.2" r="1.7" fill="#e23b3b"/><circle cx="12" cy="15" r="1.7" fill="#c62828"/></svg>';
      case 'heart': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3C5.6 15.6 3.6 12 3.6 8.7 3.6 6.4 5.5 4.6 7.8 4.6c1.7 0 3.3 1 4.2 2.6 1-1.6 2.6-2.6 4.3-2.6 2.3 0 4.1 1.8 4.1 4.1 0 3.3-2 6.9-8.4 11.6z" fill="' + (c || '#e23b3b') + '"/></svg>';
      case 'shamrock': return '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="' + (c || '#22a559') + '"><circle cx="8.6" cy="9.8" r="3.7"/><circle cx="15.4" cy="9.8" r="3.7"/><circle cx="12" cy="6.4" r="3.7"/></g><path d="M12 10c0 4 0 5.5 0 9" stroke="#166534" stroke-width="1.4" fill="none"/></svg>';
      case 'egg': return '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="13" rx="6" ry="8" fill="' + (c || '#f5a7c8') + '"/><path d="M6.2 11.4h11.6" stroke="#ffffff" stroke-width="1.3" opacity=".85"/><path d="M6.7 15c1.3-1.3 2.7 1 4 0s2.7 1 4 0 2.6 .9 3.3 .3" stroke="#ffffff" stroke-width="1" fill="none" opacity=".7"/></svg>';
      case 'star': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.6 5.9 6.4.6-4.8 4.2 1.4 6.3L12 20.4 6 23.6l1.4-6.3L2.6 9.1l6.4-.6z" fill="' + (c || '#f3c14e') + '"/></svg>';
      case 'sparkle': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.7 7.8 7.8 2.2-7.8 2.2L12 22l-1.7-7.8L2.5 12l7.8-2.2z" fill="' + (c || '#f3c14e') + '"/></svg>';
      case 'leaf': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.5 3.2 2.6-1-.8 2.8 3-.3-1.8 2.3 2.6 1.2-2.6 1.2 1.4 2.2-3-.3.4 2.9-2.4-1.6L12 21l-.9-2.7-2.4 1.6.4-2.9-3 .3 1.4-2.2L5 12.4l2.6-1.2L5.8 8.9l3 .3-.8-2.8 2.6 1z" fill="' + (c || '#c2731a') + '"/></svg>';
      case 'acorn': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2.4" stroke="#5c3a17" stroke-width="1.5" stroke-linecap="round"/><path d="M8 10c0 3.6 1.9 7 4 8.2 2.1-1.2 4-4.6 4-8.2Z" fill="' + (c || '#a86a34') + '"/><path d="M5.8 8.4c0-2 2.8-3.4 6.2-3.4s6.2 1.4 6.2 3.4c0 .9-.6 1.5-1.7 1.5H7.5C6.4 9.9 5.8 9.3 5.8 8.4Z" fill="#5c3a17"/></svg>';
      case 'bat': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="' + (c || '#8a83a3') + '" d="M12 8.4c.8-1.7 1.5-2.6 2.3-2.6.1 1 .6 1.5 1.5 1.5.7 0 1.2-.4 1.7-1 .1 1.2-.3 2.1-1 2.7 1.1-.2 2 .1 2.7.8-1.5.1-2.4.9-2.8 2.1-1.1-1-2.5-1.5-4.1-1.5s-3 .5-4.1 1.5c-.4-1.2-1.3-2-2.8-2.1.7-.7 1.6-1 2.7-.8-.7-.6-1.1-1.5-1-2.7.5.6 1 1 1.7 1 .9 0 1.4-.5 1.5-1.5.8 0 1.5.9 2.3 2.6Z"/></svg>';
    }
    return '';
  }
  function topperSvg(name) {
    switch (name) {
      case 'santa': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 15C6 6.5 15.5 4.8 19.5 8.5L8.5 15.5Z" fill="#e23b3b"/><rect x="2.5" y="14" width="8.5" height="3.6" rx="1.8" fill="#fbfbfb"/><circle cx="19.6" cy="8.4" r="2.2" fill="#fbfbfb"/></svg>';
      case 'witch': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 16.5 15h-9Z" fill="#2a2440"/><path d="M7.5 13.5h9l.6 1.5h-10.2Z" fill="#3a3357"/><ellipse cx="12" cy="15.4" rx="8" ry="2.1" fill="#2a2440"/><rect x="9" y="12.4" width="6" height="2" fill="#8b5cf6"/></svg>';
      case 'partyhat': return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 18 18 6 18Z" fill="#f3c14e"/><path d="M12 3 15.2 18 8.8 18Z" fill="#e23b3b"/><circle cx="12" cy="3" r="1.7" fill="#4d9bf5"/><circle cx="10" cy="12" r="1" fill="#fff"/><circle cx="14" cy="15" r="1" fill="#fff"/></svg>';
      case 'heart': return motif('heart', '#e23b3b');
      case 'star': return motif('star', '#4d9bf5');
      case 'shamrock': return motif('shamrock');
    }
    return '';
  }

  // ---- holiday kit table ----------------------------------------------------
  var HOLIDAYS = {
    newyear:      { mark: 'sparkle',  accent: '#e3b64a', wash: 'rgba(212,175,55,.20)', garland: 'pennant-gold', particle: { shape: 'confetti', dir: 'fall', count: 46 }, topper: 'partyhat', greet: 'Happy New Year from Lock and Roll' },
    valentines:   { mark: 'heart',    accent: '#ec4899', wash: 'rgba(236,72,153,.18)', garland: 'heart',        particle: { shape: 'heart', dir: 'rise', count: 24 }, topper: 'heart',    greet: 'Happy Valentine’s Day' },
    stpatricks:   { mark: 'shamrock', accent: '#22a559', wash: 'rgba(34,165,89,.18)',  garland: 'shamrock',     particle: { shape: 'shamrock', dir: 'fall', count: 26 }, topper: 'shamrock', greet: 'Happy St. Patrick’s Day' },
    easter:       { mark: 'egg',      accent: '#a78bfa', wash: 'rgba(167,139,250,.18)',garland: 'egg',          particle: { shape: 'petal', dir: 'fall', count: 30 }, topper: null,       greet: 'Happy Easter from Lock and Roll' },
    july4:        { mark: 'star',     accent: '#5b9bf5', wash: 'rgba(59,111,212,.18)', garland: 'pennant-usa',  particle: { shape: 'star', dir: 'twk', count: 28 }, topper: 'star',     greet: 'Happy 4th of July from Lock and Roll' },
    fall:         { mark: 'acorn',    accent: '#d9822a', wash: 'rgba(200,130,30,.20)', garland: 'fallmix',      particle: { shape: 'leaf', dir: 'fall', count: 28 }, topper: null,       greet: 'Happy fall from Lock and Roll' },
    halloween:    { mark: 'pumpkin',  accent: '#9b7cf0', wash: 'rgba(139,92,246,.22)', garland: 'bat',          particle: { shape: 'bat', dir: 'drift', count: 5 }, topper: 'witch',    greet: 'Happy Halloween from Lock and Roll' },
    thanksgiving: { mark: 'leaf',     accent: '#d08a3a', wash: 'rgba(194,115,26,.20)', garland: 'leaf',         particle: { shape: 'leaf', dir: 'fall', count: 26 }, topper: null,       greet: 'Happy Thanksgiving from Lock and Roll' },
    christmas:    { mark: 'holly',    accent: '#34d27b', wash: 'rgba(37,163,92,.18)',  garland: 'bulb',         particle: { shape: 'snow', dir: 'fall', count: 40 }, topper: 'santa',    greet: 'Merry Christmas from Lock and Roll' }
  };
  var BULB = ['#ef4444', '#f3c14e', '#34d27b', '#4d9bf5'];
  var CONFETTI = ['#f3c14e', '#cbd5e1', '#f97316', '#e23b3b', '#4d9bf5', '#34d27b'];
  var PETAL = ['#f9a8d4', '#c4b5fd', '#fbcfe8', '#fda4af'];
  var LEAFC = ['#c2731a', '#d9481f', '#b45309', '#a16207'];
  var HEARTC = ['#e23b3b', '#ec4899', '#f472b6'];
  var STARC = ['#e23b3b', '#f1f5f9', '#4d9bf5'];
  var FALLC = ['#d9481f', '#c2731a', '#e0a53a', '#a16207'];

  // ---- one-time stylesheet --------------------------------------------------
  function injectStyle() {
    if (document.getElementById('nova-ss-style')) return;
    var css = ''
      + '.nova-ss-bg{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden;}'
      + '.nova-ss-wash{position:absolute;left:0;right:0;top:0;height:170px;}'
      + '.nova-ss-particle{position:absolute;will-change:transform;}'
      + '.nova-ss-particle svg{width:100%;height:100%;display:block;}'
      + '.nova-ss-fall{top:-16px;animation:novaSsFall linear infinite;}'
      + '.nova-ss-rise{bottom:-16px;animation:novaSsRise linear infinite;}'
      + '.nova-ss-drift{animation:novaSsDrift ease-in-out infinite;}'
      + '.nova-ss-twk{animation:novaSsTwk ease-in-out infinite;}'
      + '.nova-ss-snow{border-radius:50%;background:#fff;filter:blur(.3px);}'
      + '.nova-ss-confetti{border-radius:1px;}'
      + '.nova-ss-petal{border-radius:50% 0 50% 50%;}'
      + '.nova-ss-mark{display:inline-flex;vertical-align:middle;width:20px;height:20px;margin-left:7px;}'
      + '.nova-ss-mark svg{width:100%;height:100%;display:block;}'
      + '.sidebar-logo h1 .nova-ss-mark{filter:drop-shadow(0 0 6px var(--nova-ss-accent,transparent));}'
      + '.auth-logo h2 .nova-ss-mark{width:24px;height:24px;}'
      + '.nova-ss-garland{position:absolute;left:0;right:0;display:flex;justify-content:space-around;align-items:flex-start;padding:0 14px;pointer-events:none;z-index:3;}'
      + '.nova-ss-garland::before{content:"";position:absolute;left:8px;right:8px;top:1px;height:8px;border-bottom:1.5px solid var(--border);border-radius:0 0 55% 55%;z-index:-1;}'
      + '.nova-ss-garland-header{bottom:-9px;}'
      + '.nova-ss-garland-login{position:relative;bottom:auto;margin:-6px -4px 14px;height:15px;}'
      + '.nova-ss-bulb{position:relative;width:7px;height:10px;border-radius:52% 52% 50% 50%/62% 62% 40% 40%;top:6px;box-shadow:0 0 7px 1px currentColor;}'
      + '.nova-ss-bulb::before{content:"";position:absolute;top:-3px;left:2px;width:3px;height:3px;background:#3a3a3a;border-radius:2px;}'
      + '.nova-ss-pennant{width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:11px solid #f3c14e;margin-top:1px;}'
      + '.nova-ss-gitem{display:flex;flex-direction:column;align-items:center;transform-origin:top center;}'
      + '.nova-ss-gitem .nova-ss-thread{width:1px;height:8px;background:var(--border);}'
      + '.nova-ss-gitem .nova-ss-gm{width:16px;height:16px;margin-top:-1px;display:block;}'
      + '.nova-ss-gitem .nova-ss-gm svg{width:100%;height:100%;display:block;}'
      + '.nova-ss-topper{position:absolute;top:-11px;left:-8px;width:22px;height:22px;transform:rotate(-16deg);pointer-events:none;z-index:2;}'
      + '.nova-ss-topper svg{width:100%;height:100%;display:block;}'
      + '.nova-ss-loginfx{position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;}'
      + '.nova-ss-greet{text-align:center;font-size:12px;margin:14px 0 0;font-weight:600;}'
      // motion only in the playful look; app default (subtle) is static chrome
      + 'html[data-nova-look="playful"] .nova-ss-bulb{animation:novaSsTwinkle 2.6s ease-in-out infinite;}'
      + 'html[data-nova-look="playful"] .nova-ss-header-host .nova-ss-gitem{animation:novaSsSway 3.4s ease-in-out infinite;}'
      + '@keyframes novaSsFall{to{transform:translateY(var(--nova-ss-travel,780px)) translateX(var(--dx,0)) rotate(var(--sp,0deg));}}'
      + '@keyframes novaSsRise{to{transform:translateY(calc(-1 * var(--nova-ss-travel,780px))) translateX(var(--dx,0)) rotate(var(--sp,0deg));}}'
      + '@keyframes novaSsDrift{0%,100%{transform:translate(0,0);}50%{transform:translate(var(--dx,40px),var(--dy,-14px));}}'
      + '@keyframes novaSsTwk{0%,100%{opacity:.2;}50%{opacity:1;}}'
      + '@keyframes novaSsTwinkle{0%,100%{opacity:1;}50%{opacity:.35;}}'
      + '@keyframes novaSsSway{0%,100%{transform:rotate(-5deg);}50%{transform:rotate(5deg);}}'
      + '@media (prefers-reduced-motion:reduce){.nova-ss-particle{display:none!important;}.nova-ss-bulb,.nova-ss-gitem{animation:none!important;}}';
    var el = document.createElement('style');
    el.id = 'nova-ss-style';
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  // ---- builders -------------------------------------------------------------
  function fillGarland(host, type, playful) {
    host.innerHTML = '';
    if (!type) return;
    var i, n;
    if (type === 'bulb') {
      for (i = 0; i < 20; i++) { var b = document.createElement('span'); b.className = 'nova-ss-bulb'; b.style.color = BULB[i % 4]; b.style.background = BULB[i % 4]; b.style.animationDelay = (i * 0.2).toFixed(2) + 's'; host.appendChild(b); }
    } else if (type.indexOf('pennant') === 0) {
      var cols = (type === 'pennant-usa') ? ['#e23b3b', '#f1f5f9', '#4d9bf5'] : ['#e3b64a', '#f3c14e', '#caa032'];
      for (i = 0; i < 18; i++) { var p = document.createElement('span'); p.className = 'nova-ss-pennant'; p.style.borderTopColor = cols[i % cols.length]; host.appendChild(p); }
    } else {
      for (i = 0; i < 16; i++) {
        var it = document.createElement('span'); it.className = 'nova-ss-gitem'; it.style.animationDelay = (i * 0.18).toFixed(2) + 's';
        var th = document.createElement('span'); th.className = 'nova-ss-thread';
        var gm = document.createElement('span'); gm.className = 'nova-ss-gm';
        if (type === 'fallmix') gm.innerHTML = (i % 2 === 0) ? motif('leaf', FALLC[i % 4]) : motif('acorn');
        else gm.innerHTML = motif(type);
        it.appendChild(th); it.appendChild(gm); host.appendChild(it);
      }
    }
  }

  function fillParticles(layer, part, mult) {
    layer.innerHTML = '';
    if (!part || reduce) return;
    var n = Math.round(part.count * (mult || 1));
    for (var i = 0; i < n; i++) {
      var s = document.createElement('span');
      s.className = 'nova-ss-particle nova-ss-' + part.shape + ' nova-ss-' + part.dir;
      if (part.dir === 'drift') {
        var bs = (16 + Math.random() * 12);
        s.style.left = (5 + Math.random() * 80) + '%'; s.style.top = (8 + Math.random() * 60) + '%';
        s.style.width = bs + 'px'; s.style.height = bs + 'px'; s.style.opacity = '0.68';
        s.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
        s.style.setProperty('--dy', (-8 - Math.random() * 16).toFixed(0) + 'px');
        s.style.animationDuration = (12 + Math.random() * 8).toFixed(1) + 's';
        s.innerHTML = motif('bat', '#8a83a3');
      } else if (part.dir === 'twk') {
        var ss = (8 + Math.random() * 8);
        s.style.left = (Math.random() * 100) + '%'; s.style.top = (2 + Math.random() * 30) + '%';
        s.style.width = ss + 'px'; s.style.height = ss + 'px';
        s.style.animationDuration = (1.8 + Math.random() * 2.4).toFixed(1) + 's';
        s.style.animationDelay = (-Math.random() * 3).toFixed(1) + 's';
        s.innerHTML = motif('star', STARC[i % 3]);
      } else {
        s.style.left = (Math.random() * 100) + '%';
        var dur = (part.shape === 'snow') ? (9 + Math.random() * 8) : (8 + Math.random() * 8);
        s.style.animationDuration = dur.toFixed(1) + 's';
        s.style.animationDelay = (-Math.random() * dur).toFixed(1) + 's';
        s.style.setProperty('--dx', (Math.random() * 60 - 30).toFixed(0) + 'px');
        var sp = (Math.random() * 540 - 270).toFixed(0);
        if (part.shape === 'heart' || part.shape === 'petal') sp = '0';
        s.style.setProperty('--sp', sp + 'deg');
        if (part.shape === 'snow') { var z = (2 + Math.random() * 3.4); s.style.width = z + 'px'; s.style.height = z + 'px'; s.style.opacity = (0.55 + Math.random() * 0.4).toFixed(2); }
        else if (part.shape === 'confetti') { s.style.width = (4 + Math.random() * 4) + 'px'; s.style.height = (7 + Math.random() * 5) + 'px'; s.style.background = CONFETTI[i % 6]; s.style.opacity = '0.85'; s.style.setProperty('--sp', (Math.random() * 720 - 360).toFixed(0) + 'deg'); }
        else if (part.shape === 'petal') { var ps = (7 + Math.random() * 6); s.style.width = ps + 'px'; s.style.height = ps + 'px'; s.style.background = PETAL[i % 4]; s.style.opacity = '0.8'; }
        else { var sz = (12 + Math.random() * 8); s.style.width = sz + 'px'; s.style.height = sz + 'px'; s.style.opacity = (0.72 + Math.random() * 0.24).toFixed(2); var col = (part.shape === 'heart') ? HEARTC[i % 3] : (part.shape === 'leaf') ? LEAFC[i % 4] : null; s.innerHTML = motif(part.shape, col); }
      }
      layer.appendChild(s);
    }
  }

  // Body-level fixed background (wash + particles). Persists across app re-renders.
  function buildBg(season, look) {
    var old = document.getElementById('nova-ss-bg');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    if (!season) return;
    var kit = HOLIDAYS[season]; if (!kit) return;
    var bg = document.createElement('div'); bg.className = 'nova-ss-bg'; bg.id = 'nova-ss-bg';
    var wash = document.createElement('div'); wash.className = 'nova-ss-wash';
    wash.style.background = 'radial-gradient(600px 170px at 62% -50px, ' + kit.wash + ', transparent 72%)';
    bg.appendChild(wash);
    if (look === 'playful') { var pl = document.createElement('div'); pl.style.position = 'absolute'; pl.style.inset = '0'; fillParticles(pl, kit.particle, 1); bg.appendChild(pl); }
    document.body.appendChild(bg);
  }

  // In-#app / login decorations. Idempotent; tagged with the current season so a
  // re-render (which wipes them) reattaches, and a season change refreshes them.
  function decorate() {
    try {
      injectSettingsCard();  // must run even when decorations are OFF, so an admin can turn them on
      var season = ROOT.getAttribute('data-nova-season');
      if (!season) return;
      var kit = HOLIDAYS[season]; if (!kit) return;
      var tag = season;

      // wordmark mark (sidebar + login)
      var heads = [document.querySelector('.sidebar-logo h1'), document.querySelector('.auth-logo h2')];
      heads.forEach(function (h) {
        if (!h) return;
        var mk = h.querySelector('.nova-ss-mark');
        if (mk && mk.getAttribute('data-s') === tag) return;
        if (mk) mk.parentNode.removeChild(mk);
        var span = document.createElement('span'); span.className = 'nova-ss-mark'; span.setAttribute('data-s', tag); span.setAttribute('aria-hidden', 'true'); span.innerHTML = motif(kit.mark);
        h.appendChild(span);
      });

      // header garland
      var header = document.querySelector('.main-header');
      if (header) {
        header.classList.add('nova-ss-header-host');
        var g = header.querySelector('.nova-ss-garland');
        if (!g || g.getAttribute('data-s') !== tag) {
          if (g) g.parentNode.removeChild(g);
          g = document.createElement('div'); g.className = 'nova-ss-garland nova-ss-garland-header'; g.setAttribute('data-s', tag); g.setAttribute('aria-hidden', 'true');
          fillGarland(g, kit.garland, ROOT.getAttribute('data-nova-look') === 'playful');
          if (getComputedStyle(header).position === 'static') header.style.position = 'relative';
          header.appendChild(g);
        }
      }

      // avatar topper (playful only)
      var av = document.querySelector('.sidebar-user .avatar');
      if (av) {
        var tp = av.querySelector('.nova-ss-topper');
        var wantTopper = (ROOT.getAttribute('data-nova-look') === 'playful') && kit.topper;
        if (tp && (!wantTopper || tp.getAttribute('data-s') !== tag)) { tp.parentNode.removeChild(tp); tp = null; }
        if (wantTopper && !tp) {
          if (getComputedStyle(av).position === 'static') av.style.position = 'relative';
          tp = document.createElement('span'); tp.className = 'nova-ss-topper'; tp.setAttribute('data-s', tag); tp.setAttribute('aria-hidden', 'true'); tp.innerHTML = topperSvg(kit.topper);
          av.appendChild(tp);
        }
      }

      // login scene: the auth page has an opaque background that hides the body layer,
      // so give the sign-in card its own garland + particles + greeting (always playful).
      var authPage = document.querySelector('.auth-page');
      var authCard = document.querySelector('.auth-card');
      if (authPage && authCard) {
        if (getComputedStyle(authPage).position === 'static') authPage.style.position = 'relative';
        var fx = authPage.querySelector('.nova-ss-loginfx');
        if (!fx || fx.getAttribute('data-s') !== tag) {
          if (fx) fx.parentNode.removeChild(fx);
          fx = document.createElement('div'); fx.className = 'nova-ss-loginfx'; fx.setAttribute('data-s', tag); fx.setAttribute('aria-hidden', 'true');
          fillParticles(fx, kit.particle, 1.4);
          authPage.insertBefore(fx, authPage.firstChild);
        }
        var lg = authCard.querySelector('.nova-ss-garland-login');
        if (!lg || lg.getAttribute('data-s') !== tag) {
          if (lg) lg.parentNode.removeChild(lg);
          lg = document.createElement('div'); lg.className = 'nova-ss-garland nova-ss-garland-login'; lg.setAttribute('data-s', tag); lg.setAttribute('aria-hidden', 'true');
          fillGarland(lg, kit.garland, true);
          authCard.insertBefore(lg, authCard.firstChild);
        }
        var greetHost = authCard.querySelector('.auth-logo') || authCard;
        var gr = authCard.querySelector('.nova-ss-greet');
        if (!gr) { gr = document.createElement('p'); gr.className = 'nova-ss-greet'; greetHost.appendChild(gr); }
        gr.textContent = kit.greet || '';
        gr.style.color = kit.accent;
      }

    } catch (e) {}
  }

  // ---- apply / clear --------------------------------------------------------
  function clearAll() {
    ROOT.removeAttribute('data-nova-season');
    ROOT.removeAttribute('data-nova-look');
    ROOT.style.removeProperty('--nova-ss-accent');
    var bg = document.getElementById('nova-ss-bg'); if (bg && bg.parentNode) bg.parentNode.removeChild(bg);
    var kill = document.querySelectorAll('.nova-ss-mark,.nova-ss-garland,.nova-ss-topper,.nova-ss-loginfx,.nova-ss-greet');
    for (var i = 0; i < kill.length; i++) { if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]); }
    builtSeason = null; builtLook = null;
  }

  function applyState() {
    try {
      if (!cfg.enabled || personallyOff()) { clearAll(); return; }
      var season = activeHoliday(new Date());
      if (!season) { clearAll(); return; }
      var look = (cfg.look === 'playful') ? 'playful' : 'subtle';
      ROOT.setAttribute('data-nova-season', season);
      ROOT.setAttribute('data-nova-look', look);
      var kit = HOLIDAYS[season];
      if (kit) ROOT.style.setProperty('--nova-ss-accent', kit.accent);
      // travel distance for falling/rising particles = viewport height + margin
      ROOT.style.setProperty('--nova-ss-travel', (window.innerHeight + 60) + 'px');
      if (builtSeason !== season || builtLook !== look) { buildBg(season, look); builtSeason = season; builtLook = look; }
      decorate();
    } catch (e) {}
  }

  // ---- settings card (admin) + personal toggle ------------------------------
  function injectSettingsCard() {
    try {
      if (!window.state) return;
      var v = state.currentView;
      if (v !== 'company-info' && v !== 'settings') return;   // 'settings' redirects to company-info; that's the real settings page
      var content = document.getElementById('content');
      if (!content || document.getElementById('nova-ss-settings')) return;
      var canManage = (typeof can === 'function') && can('manage_settings');
      var card = document.createElement('div');
      card.className = 'card';
      card.id = 'nova-ss-settings';
      card.style.marginTop = '20px';
      var esc = (typeof escHtml === 'function') ? escHtml : function (x) { return String(x == null ? '' : x); };
      var active = activeHoliday(new Date());
      var activeLabel = active ? (active.charAt(0).toUpperCase() + active.slice(1)) : 'none right now';
      var html = ''
        + '<div class="card-body">'
        + '<h3 style="margin:0 0 4px;font-size:16px;">Holiday decorations</h3>'
        + '<p style="color:var(--text-muted-color);font-size:13px;margin:0 0 16px;">Light seasonal touches on the pages. They stay on the chrome, never over your data, and cycle by date. Active window today: <strong>' + esc(activeLabel) + '</strong>.</p>';
      if (canManage) {
        html += '<label style="display:flex;align-items:center;gap:10px;font-size:14px;margin-bottom:14px;cursor:pointer;">'
          + '<input type="checkbox" id="nova-ss-enabled" style="width:auto;margin:0;"' + (cfg.enabled ? ' checked' : '') + '> Turn holiday decorations on for everyone</label>'
          + '<div style="margin-bottom:14px;"><label style="display:block;font-size:13px;color:var(--text-dim);margin-bottom:6px;">Everyday look (sign-in always uses the fuller look)</label>'
          + '<select id="nova-ss-look" style="background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:14px;">'
          + '<option value="subtle"' + (cfg.look !== 'playful' ? ' selected' : '') + '>Subtle</option>'
          + '<option value="playful"' + (cfg.look === 'playful' ? ' selected' : '') + '>Playful</option></select></div>';
      }
      html += '<label style="display:flex;align-items:center;gap:10px;font-size:14px;color:var(--text-dim);cursor:pointer;">'
        + '<input type="checkbox" id="nova-ss-off" style="width:auto;margin:0;"' + (personallyOff() ? ' checked' : '') + '> Hide decorations just for me on this device</label>'
        + '<div id="nova-ss-saved" style="font-size:12px;color:var(--success);margin-top:10px;height:14px;"></div>'
        + '</div>';
      card.innerHTML = html;
      var ph = content.querySelector('.page-header');   // sit right under the page title, not buried at the bottom
      if (ph && ph.parentNode === content) content.insertBefore(card, ph.nextSibling);
      else content.insertBefore(card, content.firstChild);

      var saved = card.querySelector('#nova-ss-saved');
      function flash(t) { if (saved) { saved.textContent = t; setTimeout(function () { if (saved) saved.textContent = ''; }, 2200); } }

      var offBox = card.querySelector('#nova-ss-off');
      if (offBox) offBox.addEventListener('change', function () {
        try { if (offBox.checked) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY); } catch (e) {}
        applyState(); flash('Saved for you.');
      });

      if (canManage) {
        var enBox = card.querySelector('#nova-ss-enabled');
        var lookSel = card.querySelector('#nova-ss-look');
        function saveCfg() {
          cfg.enabled = !!(enBox && enBox.checked);
          cfg.look = (lookSel && lookSel.value === 'playful') ? 'playful' : 'subtle';
          writeCache();
          applyState();
          if (typeof api === 'function') {
            api('PUT', '/settings/seasonal_decor', { value: JSON.stringify({ enabled: cfg.enabled, look: cfg.look }) })
              .then(function () { flash('Saved for everyone.'); }, function () { flash('Could not save to the server.'); });
          }
        }
        if (enBox) enBox.addEventListener('change', saveCfg);
        if (lookSel) lookSel.addEventListener('change', saveCfg);
      }
    } catch (e) {}
  }

  // ---- config fetch ---------------------------------------------------------
  function fetchCfgOnce() {
    if (fetched) return;
    if (!window.state || !state.token || typeof api !== 'function') return;
    fetched = true;
    api('GET', '/settings').then(function (s) {
      var v = s && s.seasonal_decor;
      if (v) { try { var o = JSON.parse(v); cfg = { enabled: !!o.enabled, look: (o.look === 'playful' ? 'playful' : 'subtle') }; } catch (e) { cfg = { enabled: false, look: 'subtle' }; } }
      else { cfg = { enabled: false, look: 'subtle' }; }
      writeCache();
      applyState();
    }, function () {});
  }

  // ---- boot -----------------------------------------------------------------
  function boot() {
    injectStyle();
    readCache();
    applyState();      // paint from the cached config immediately (covers the login screen)
    decorate();        // ensure the Settings toggle shows even when decorations are off (cold load on Settings)
    fetchCfgOnce();    // refresh from the server once we have a token

    var pending = null;
    var app = document.getElementById('app');
    if (app && window.MutationObserver) {
      var obs = new MutationObserver(function () {
        if (pending) return;
        pending = setTimeout(function () { pending = null; decorate(); fetchCfgOnce(); }, 60);
      });
      obs.observe(app, { childList: true, subtree: true });
    }
    var rt = null;
    window.addEventListener('resize', function () { if (rt) return; rt = setTimeout(function () { rt = null; ROOT.style.setProperty('--nova-ss-travel', (window.innerHeight + 60) + 'px'); }, 300); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
