// ===========================================================================
//  Nova - Live Map + location reporting
// ---------------------------------------------------------------------------
//  Two halves in one file:
//    1. novaLocCard()  - the tech's side. A card on the Time Clock screen that
//       shows what is being shared and lets them turn browser sharing on.
//    2. renderLiveMap() - the dispatcher's side. Everyone on a map.
//
//  This is a CLASSIC script like app.js, so everything here is global and the
//  inline onclick handlers keep working. Top-level const/let in app.js are NOT
//  window properties, so refer to them by bare identifier (see the note in
//  nova-frontend-structure): use a typeof state check to guard.
// ===========================================================================

var NOVA_LOC_KEY = 'nova_share_location';
var _novaLocWatch = null;
var _novaLocTimer = null;
var _novaLocCfg = null;
var _novaLocQueue = [];
var _novaLocLast = null;
var _novaLocSending = false;

function novaLocNative() {
  if (typeof novaIsNative === 'function') return novaIsNative();
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}
function novaLocOptedIn() {
  if (novaLocNative()) return true; // the app exists to do this
  try { return localStorage.getItem(NOVA_LOC_KEY) === '1'; } catch (e) { return false; }
}
function novaLocSetOptIn(on) {
  try { localStorage.setItem(NOVA_LOC_KEY, on ? '1' : '0'); } catch (e) {}
}

// ---------------------------------------------------------------------------
//  Reporting
// ---------------------------------------------------------------------------
// Fixes go into a queue and are posted in batches. If the network is down the
// queue keeps them and the next successful post carries the backlog, which is
// the same shape the native plugin will use, so this code does not change when
// the Android shell arrives.
function novaLocQueueFix(pos) {
  if (!pos || !pos.coords) return;
  var c = pos.coords;
  var fix = {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: c.accuracy,
    speed: (c.speed === null || isNaN(c.speed)) ? null : c.speed,
    heading: (c.heading === null || isNaN(c.heading)) ? null : c.heading,
    altitude: (c.altitude === null || isNaN(c.altitude)) ? null : c.altitude,
    recorded_at: new Date(pos.timestamp || Date.now()).toISOString()
  };
  // Skip a fix that has not moved far enough. Saves battery and stops a parked
  // truck from drawing a fuzzy blob on the map.
  // A parked truck is the cheapest thing to track: we simply do not report it.
  // That is where "last seen 4 minutes ago" comes from, and it is deliberate -
  // the distance filter saves far more battery than a slower interval does.
  // The idle floor is how stale a STATIONARY tech is allowed to look.
  var minM = (_novaLocCfg && _novaLocCfg.distanceMeters) || 0;
  var idleMin = (_novaLocCfg && _novaLocCfg.idleMinutes) || 2;
  if (_novaLocLast && minM > 0 && novaLocMeters(_novaLocLast, fix) < minM) {
    var gapMin = (new Date(fix.recorded_at) - new Date(_novaLocLast.recorded_at)) / 60000;
    if (gapMin < idleMin) return;
  }
  fix.is_moving = _novaLocLast ? (novaLocMeters(_novaLocLast, fix) >= 25) : null;
  _novaLocLast = fix;
  _novaLocQueue.push(fix);
  if (_novaLocQueue.length > 500) _novaLocQueue = _novaLocQueue.slice(-500);
  novaLocFlush();
}

function novaLocMeters(a, b) {
  var R = 6371000;
  var dLat = (b.lat - a.lat) * Math.PI / 180;
  var dLon = (b.lon - a.lon) * Math.PI / 180;
  var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function novaLocFlush() {
  if (_novaLocSending || !_novaLocQueue.length) return;
  if (typeof api !== 'function') return;
  _novaLocSending = true;
  var batch = _novaLocQueue.slice(0);
  try {
    var r = await api('POST', '/locations/ping', {
      source: novaLocNative() ? 'android' : 'pwa',
      pings: batch
    });
    // Only drop what we actually sent; anything queued during the request stays.
    _novaLocQueue = _novaLocQueue.slice(batch.length);
    if (r && r.config) {
      _novaLocCfg = r.config;
      // The server can turn tracking off, or say we are off the clock. Either
      // way, stop burning the GPS until something changes.
      if (!r.tracking) novaLocStop();
    }
  } catch (e) {
    // Keep the queue. A dead zone is exactly what the buffer is for.
  }
  _novaLocSending = false;
}

async function novaLocStart(force) {
  if (_novaLocWatch !== null) return true;
  if (!novaLocOptedIn() && !force) return false;

  var me = null;
  try { me = await api('GET', '/locations/me'); } catch (e) { return false; }
  _novaLocCfg = me && me.config;
  if (!me || !me.tracking) return false;

  // In the app, hand off to the native watcher. It survives a locked screen,
  // which is the whole reason the shell exists; the browser path below cannot.
  if (novaLocNative() && typeof novaStartNativeTracking === 'function') {
    var started = await novaStartNativeTracking(_novaLocCfg);
    if (started) {
      // Still run the flush timer so a queue built in a dead zone drains.
      if (!_novaLocTimer) {
        var everyNative = Math.max(15, (_novaLocCfg && _novaLocCfg.intervalSeconds) || 45) * 1000;
        _novaLocTimer = setInterval(novaLocFlush, everyNative);
      }
      return true;
    }
    return false;
  }

  if (!navigator.geolocation) return false;

  _novaLocWatch = navigator.geolocation.watchPosition(novaLocQueueFix, function (err) {
    if (err && err.code === 1) { novaLocSetOptIn(false); novaLocStop(); }
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });

  // A heartbeat, so a stationary tech still reports and the queue still drains.
  var everyMs = Math.max(15, (_novaLocCfg && _novaLocCfg.intervalSeconds) || 45) * 1000;
  _novaLocTimer = setInterval(function () {
    novaLocFlush();
    navigator.geolocation.getCurrentPosition(novaLocQueueFix, function () {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 25000 });
  }, everyMs);
  return true;
}

function novaLocStop() {
  if (_novaLocWatch !== null) { try { navigator.geolocation.clearWatch(_novaLocWatch); } catch (e) {} _novaLocWatch = null; }
  if (_novaLocTimer) { clearInterval(_novaLocTimer); _novaLocTimer = null; }
  if (typeof novaStopNativeTracking === 'function') novaStopNativeTracking();
}

// ---------------------------------------------------------------------------
//  The tech's card (Time Clock screen)
// ---------------------------------------------------------------------------
// Nobody should have to wonder whether they are being tracked. This says it
// plainly, in the one place they already look every morning.
async function novaLocCard(host) {
  if (!host) return;
  var me = null;
  try { me = await api('GET', '/locations/me'); } catch (e) { host.innerHTML = ''; return; }
  if (!me || !me.config || !me.config.enabled) { host.innerHTML = ''; return; }

  var on = novaLocOptedIn();
  var sharing = on && me.tracking;
  var dot = sharing ? '#22c55e' : '#71717a';
  var headline = !me.ready ? 'Not sharing - you are not accepting calls'
    : (!on ? 'Not sharing - turn it on below'
    : 'Sharing your location with dispatch');

  var lastLine = '';
  if (me.last && me.last.recorded_at) {
    var mins = Math.max(0, Math.round((Date.now() - new Date(me.last.recorded_at).getTime()) / 60000));
    lastLine = '<div class="lm-meta">Last position sent ' + (mins < 1 ? 'less than a minute' : mins + ' minute' + (mins === 1 ? '' : 's')) + ' ago.</div>';
  }

  host.innerHTML =
    '<div class="disp-job" style="margin-top:14px">' +
      '<div style="font-weight:800;margin-bottom:8px">Location sharing</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + dot + ';flex:none"></span>' +
        '<span style="font-weight:700">' + escHtml(headline) + '</span>' +
      '</div>' +
      '<div class="lm-meta" style="line-height:1.55">' +
        'Your position is only recorded while you are <b>ready to accept calls</b>. Turn that off and it stops, ' +
        'every time, because the server will not store a position for anyone who is off duty. ' +
        'History is kept ' + (me.retentionDays || 90) + ' days and then deleted.' +
      '</div>' +
      lastLine +
      (novaLocNative() ? '' :
        '<div class="disp-acts">' +
          '<button class="disp-btn" onclick="novaLocToggle()">' + (on ? 'Turn off sharing' : 'Turn on sharing') + '</button>' +
        '</div>' +
        '<div class="lm-meta">In the browser this only works while Nova is open on screen. ' +
          'The Nova app keeps reporting with the phone locked.</div>') +
      (novaLocNative()
        ? '<div class="lm-meta">Running in the Nova app, so this keeps working with your phone locked and in your pocket. ' +
          'Android shows a notification the whole time it is on.</div>'
        : '') +
    '</div>';
}

async function novaLocToggle() {
  var on = novaLocOptedIn();
  if (on) {
    novaLocSetOptIn(false);
    novaLocStop();
  } else {
    novaLocSetOptIn(true);
    var started = await novaLocStart(true);
    if (!started && typeof showToast === 'function') {
      showToast('Could not start location sharing. Check that Nova is allowed to use your location, and that you are marked ready to accept calls.', 'error');
    }
  }
  var host = document.getElementById('disp-loc') || document.getElementById('tc-loc');
  if (host) novaLocCard(host);
}

// ---------------------------------------------------------------------------
//  LIVE MAP
// ---------------------------------------------------------------------------
var _lmMap = null;
var _lmMarkers = {};
var _lmTimer = null;
var _lmData = null;
var _lmSelected = null;
var _lmTrailLayer = null;
var _lmTab = 'live';
var _lmTrailUser = null;
var _lmTrailDate = null;

var LM_STATUS = {
  moving:   { color: '#22c55e', label: 'Moving' },
  stopped:  { color: '#3b82f6', label: 'Stopped' },
  stale:    { color: '#a1a1aa', label: 'No recent fix' },
  off_duty: { color: '#52525b', label: 'Off duty' },
  no_fix:   { color: '#f59e0b', label: 'Never reported' }
};

function lmInjectStyles() {
  if (document.getElementById('lm-styles')) return;
  var css =
    '#lm-map{width:100%;height:100%;min-height:380px;border-radius:12px;background:var(--bg-elevated,#222)}' +
    '.lm-wrap{display:flex;gap:14px;align-items:stretch;height:calc(100vh - 190px);min-height:460px}' +
    '.lm-side{width:290px;flex:none;overflow:auto;display:flex;flex-direction:column;gap:8px}' +
    '.lm-mapbox{flex:1;min-width:0;position:relative}' +
    '.lm-tech{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .12s}' +
    '.lm-tech:hover{border-color:var(--primary,#f97316)}' +
    '.lm-tech.sel{border-color:var(--primary,#f97316);box-shadow:0 0 0 1px var(--primary,#f97316) inset}' +
    '.lm-tech-name{font-weight:700;display:flex;align-items:center;gap:8px;color:var(--text,#f0f0f0)}' +
    '.lm-dot{width:9px;height:9px;border-radius:50%;flex:none}' +
    '.lm-meta{font-size:12px;color:var(--text-muted-color,#888);margin-top:3px}' +
    '.lm-more{background:transparent;border:1px dashed var(--border,#2e2e2e);border-radius:10px;padding:9px 12px;color:var(--text-muted-color,#888);font-size:12px;cursor:pointer;text-align:left}' +
    '.lm-more:hover{color:var(--text,#f0f0f0);border-color:var(--primary,#f97316)}' +
    '.lm-pin{border-radius:50%;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.5)}' +
    '.leaflet-tooltip.lm-label{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e);border-left-width:3px;color:var(--text,#f0f0f0);padding:3px 7px;border-radius:6px;font-size:11px;line-height:1.35;box-shadow:0 2px 6px rgba(0,0,0,.55);white-space:nowrap;font-weight:600}' +
    '.leaflet-tooltip.lm-label:before{display:none}' +
    '.lm-label b{font-size:12px;display:block;font-weight:800}' +
    '.lm-label span{font-weight:500;color:var(--text-muted-color,#888)}' +
    '.lm-label i{font-style:normal;font-weight:700}' +
    '.lm-tilewarn{position:absolute;left:58px;right:12px;top:12px;z-index:500;background:var(--bg-card,#1a1a1a);border:1px solid var(--warning,#f59e0b);border-radius:10px;padding:11px 14px;font-size:13px;line-height:1.5;color:var(--text-dim,#bbb);box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,.5))}' +
    '.lm-tilewarn a{color:var(--primary,#f97316)}' +
    '.lm-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text-muted-color,#888);margin:10px 2px 0}' +
    '.lm-tabs{display:flex;gap:6px;margin-bottom:12px}' +
    '.lm-tab{padding:7px 14px;border-radius:8px;border:1px solid var(--border,#2e2e2e);background:transparent;color:var(--text-dim,#bbb);cursor:pointer;font-weight:600}' +
    '.lm-tab.active{background:var(--primary,#f97316);border-color:var(--primary,#f97316);color:#fff}' +
    '.leaflet-popup-content-wrapper{background:var(--bg-card,#1a1a1a);color:var(--text,#f0f0f0);border:1px solid var(--border,#2e2e2e);box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,.5))}' +
    '.leaflet-popup-tip{background:var(--bg-card,#1a1a1a);border:1px solid var(--border,#2e2e2e)}' +
    '.leaflet-container a.leaflet-popup-close-button{color:var(--text-muted-color,#888)}' +
    '.leaflet-popup-content a{color:var(--primary,#f97316)}' +
    '.leaflet-control-attribution{background:rgba(0,0,0,.55) !important;color:var(--text-muted-color,#888) !important}' +
    '.leaflet-control-attribution a{color:var(--text-dim,#bbb) !important}' +
    '.leaflet-bar a{background:var(--bg-card,#1a1a1a);color:var(--text,#f0f0f0);border-bottom-color:var(--border,#2e2e2e)}' +
    '.leaflet-bar a:hover{background:var(--bg-elevated,#222);color:var(--text,#f0f0f0)}' +
    '@media (max-width:820px){.lm-wrap{flex-direction:column;height:auto}.lm-side{width:100%;max-height:230px}.lm-mapbox{height:60vh}}';
  var el = document.createElement('style');
  el.id = 'lm-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

// Leaflet is vendored locally (public/vendor/leaflet) rather than pulled from a
// CDN: Nova's opt-in CSP only allows scripts from 'self', and a map that needs
// the open internet to draw is no use on a bad connection.
function lmLoadLeaflet() {
  if (window.L) {
    var mine0 = document.getElementById('lm-styles');
    if (mine0) document.head.appendChild(mine0);
    return Promise.resolve(true);
  }
  return new Promise(function (resolve) {
    if (!document.getElementById('lm-leaflet-css')) {
      var link = document.createElement('link');
      link.id = 'lm-leaflet-css';
      link.rel = 'stylesheet';
      link.href = '/vendor/leaflet/leaflet.css';
      document.head.appendChild(link);
    }
    // Leaflet's own stylesheet must land BEFORE ours or it wins the cascade and
    // the popups come back white on a dark app. Re-appending the existing style
    // element moves it to the end of head.
    var mine = document.getElementById('lm-styles');
    if (mine) document.head.appendChild(mine);
    var s = document.createElement('script');
    s.src = '/vendor/leaflet/leaflet.js';
    s.onload = function () { resolve(!!window.L); };
    s.onerror = function () { resolve(false); };
    document.head.appendChild(s);
  });
}


// ---------------------------------------------------------------------------
//  Basemap tiles
// ---------------------------------------------------------------------------
// The pins, the routes and the stops are drawn by Nova. The STREETS behind them
// are images fetched from a tile server. If that fetch fails - blocked network,
// a bad URL in Settings, a provider that has cut us off - Leaflet just leaves
// the background empty, and an empty dark square looks exactly like a broken
// feature. So we watch the tile requests and say so out loud.
function lmAddTiles(map, tile) {
  var loaded = 0, failed = 0, told = false;
  var layer = L.tileLayer(tile.url, { attribution: tile.attribution, maxZoom: 19 });
  layer.on('tileload', function () {
    loaded++;
    lmTileBanner(false);
  });
  layer.on('tileerror', function () {
    failed++;
    // Three failures with nothing loaded is not a flaky tile, it is no basemap.
    if (!told && loaded === 0 && failed >= 3) { told = true; lmTileBanner(true); }
  });
  layer.addTo(map);
  return layer;
}

function lmTileBanner(show) {
  var box = document.querySelector('.lm-mapbox');
  if (!box) return;
  var el = document.getElementById('lm-tilewarn');
  if (!show) { if (el) el.parentNode.removeChild(el); return; }
  if (el) return;
  el = document.createElement('div');
  el.id = 'lm-tilewarn';
  el.className = 'lm-tilewarn';
  el.innerHTML = '<b>No street map loading.</b> Everything below still works - the pins and routes are Nova\'s own data, ' +
    'only the map images behind them are missing. Usually the tile source in ' +
    '<a href="#" onclick="navigate(&quot;location-settings&quot;);return false;">Settings &gt; Location Tracking</a> ' +
    'is unreachable from this network.';
  box.appendChild(el);
}

function lmAgeText(t) {
  if (t === null || t === undefined) return 'never';
  if (t < 1) return 'just now';
  if (t < 60) return t + 'm ago';
  var h = Math.floor(t / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}


// ---------------------------------------------------------------------------
//  Traffic
// ---------------------------------------------------------------------------
// A second, transparent tile layer painted over the basemap. It lands in
// Leaflet's tilePane, which sits UNDER the markers, so congestion colours the
// roads without ever competing with the pins for attention.
//
// Off by default and keyed, so it costs nothing until someone turns it on.
var _lmTrafficLayer = null;
var _lmTrafficCfg = null;

function lmTrafficOn() {
  try { return localStorage.getItem('nova_map_traffic') === '1'; } catch (e) { return false; }
}
function lmSetTraffic(on) {
  try { localStorage.setItem('nova_map_traffic', on ? '1' : '0'); } catch (e) {}
}

function lmApplyTraffic() {
  if (!_lmMap) return;
  var want = lmTrafficOn() && _lmTrafficCfg && _lmTrafficCfg.enabled && _lmTrafficCfg.url;
  if (want && !_lmTrafficLayer) {
    _lmTrafficLayer = L.tileLayer(_lmTrafficCfg.url, {
      maxZoom: 22, opacity: 0.75, zIndex: 5,
      attribution: 'Traffic &copy; TomTom'
    }).addTo(_lmMap);
  } else if (!want && _lmTrafficLayer) {
    _lmMap.removeLayer(_lmTrafficLayer);
    _lmTrafficLayer = null;
  }
  var b = document.getElementById('lm-trafficbtn');
  if (b) {
    b.textContent = lmTrafficOn() ? 'Traffic on' : 'Traffic off';
    // Hidden rather than shown-and-broken when no key is configured: a dead
    // button that does nothing is worse than no button.
    b.style.display = (_lmTrafficCfg && _lmTrafficCfg.enabled) ? '' : 'none';
  }
}

function lmToggleTraffic() {
  lmSetTraffic(!lmTrafficOn());
  lmApplyTraffic();
}

// ---------------------------------------------------------------------------
//  Permanent labels
// ---------------------------------------------------------------------------
// A pin on its own tells a dispatcher almost nothing at a glance. The label is
// the part you actually read: who, how fresh, and how many calls they have had.
//
// Labels collide when the crew is packed into one part of town, so they are a
// toggle AND they switch themselves off when zoomed out far enough that they
// would just be a pile of overlapping boxes.
var LM_LABEL_MIN_ZOOM = 11;

function lmLabelsOn() {
  try { return localStorage.getItem('nova_map_labels') !== '0'; } catch (e) { return true; }
}
function lmSetLabels(on) {
  try { localStorage.setItem('nova_map_labels', on ? '1' : '0'); } catch (e) {}
}
function lmToggleLabels() {
  lmSetLabels(!lmLabelsOn());
  lmApplyLabels();
  var b = document.getElementById('lm-labelbtn');
  if (b) b.textContent = lmLabelsOn() ? 'Labels on' : 'Labels off';
}

// Short name: a first name and an initial fits; a full name pushes the box wide
// enough to cover the tech parked next to them.
function lmShortName(name) {
  var parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '?';
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0);
}

function lmLabelHtml(t) {
  var st = LM_STATUS[t.status] || LM_STATUS.no_fix;
  var calls = t.calls_today || 0;
  var open = t.open_calls || 0;
  var bits = '<b>' + escHtml(lmShortName(t.name)) + '</b>' +
    '<span>' + lmAgeText(t.age_minutes) + '</span>' +
    '<span> &middot; </span><i style="color:' + st.color + '">' + calls + (calls === 1 ? ' call' : ' calls') + '</i>';
  if (open) bits += '<span> &middot; </span><i style="color:#f97316">' + open + ' open</i>';
  return bits;
}

// Bind, update or drop each label to match the toggle and the current zoom.
function lmApplyLabels() {
  if (!_lmMap) return;
  var want = lmLabelsOn() && _lmMap.getZoom() >= LM_LABEL_MIN_ZOOM;
  var byId = {};
  ((_lmData && _lmData.techs) || []).forEach(function (t) { byId[t.user_id] = t; });
  Object.keys(_lmMarkers).forEach(function (id) {
    var m = _lmMarkers[id];
    var t = byId[id];
    if (!want || !t) { if (m.getTooltip()) m.unbindTooltip(); return; }
    var st = LM_STATUS[t.status] || LM_STATUS.no_fix;
    if (m.getTooltip()) {
      m.setTooltipContent(lmLabelHtml(t));
    } else {
      m.bindTooltip(lmLabelHtml(t), {
        permanent: true, direction: 'top', offset: [0, -11],
        className: 'lm-label', opacity: 1, interactive: false
      });
    }
    var el = m.getTooltip() && m.getTooltip().getElement();
    if (el) el.style.borderLeftColor = st.color;
  });
}

function lmStop() {
  if (_lmTimer) { clearInterval(_lmTimer); _lmTimer = null; }
}

async function renderLiveMap(content) {
  lmInjectStyles();
  lmStop();
  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Live Map</div>' +
      '<div class="page-subtitle">Where the crew is right now. Positions are only recorded while a tech is ready to accept calls.</div></div></div>' +
    '<div class="lm-tabs">' +
      '<button class="lm-tab' + (_lmTab === 'live' ? ' active' : '') + '" onclick="lmSetTab(\'live\')">Live</button>' +
      '<button class="lm-tab' + (_lmTab === 'history' ? ' active' : '') + '" onclick="lmSetTab(\'history\')">History</button>' +
    '</div>' +
    '<div id="lm-host"></div>';

  var host = document.getElementById('lm-host');
  var ok = await lmLoadLeaflet();
  if (!ok) {
    host.innerHTML = '<div class="card"><div class="card-body">The map library could not be loaded. Check that /vendor/leaflet/leaflet.js deployed with the app.</div></div>';
    return;
  }
  if (_lmTab === 'history') return lmRenderHistory(host);
  return lmRenderLive(host);
}

function lmSetTab(t) {
  _lmTab = t;
  lmStop();
  _lmMap = null; _lmMarkers = {}; _lmTrailLayer = null;
  if (typeof render === 'function') render();
}

async function lmRenderLive(host) {
  host.innerHTML =
    '<div class="lm-wrap">' +
      '<div class="lm-side" id="lm-side"><div class="text-muted" style="padding:8px">Loading crew...</div></div>' +
      '<div class="lm-mapbox"><div id="lm-map"></div></div>' +
    '</div>' +
    '<div class="lm-legend" id="lm-legend">' +
      '<button class="lm-more" id="lm-labelbtn" style="padding:4px 10px" onclick="lmToggleLabels()">' +
        (lmLabelsOn() ? 'Labels on' : 'Labels off') + '</button>' +
      '<button class="lm-more" id="lm-trafficbtn" style="padding:4px 10px;display:none" onclick="lmToggleTraffic()">' +
        (lmTrafficOn() ? 'Traffic on' : 'Traffic off') + '</button>' +
    '</div>';

  // insertAdjacentHTML, not innerHTML: the Labels button already lives in here.
  document.getElementById('lm-legend').insertAdjacentHTML('beforeend', Object.keys(LM_STATUS).map(function (k) {
    return '<span style="display:inline-flex;align-items:center;gap:6px">' +
      '<span class="lm-dot" style="background:' + LM_STATUS[k].color + '"></span>' + LM_STATUS[k].label + '</span>';
  }).join(''));

  await lmRefresh(true);

  // Refresh while the view is open; pause when the tab is hidden so a dispatcher
  // who walks away is not polling all night.
  _lmTimer = setInterval(function () {
    if (document.hidden) return;
    if (typeof state !== 'undefined' && state.currentView !== 'live-map') { lmStop(); return; }
    lmRefresh(false);
  }, 20000);
}

async function lmRefresh(fit) {
  var data;
  try { data = await api('GET', '/locations/live'); }
  catch (e) {
    var side = document.getElementById('lm-side');
    if (side) side.innerHTML = '<div class="text-muted" style="padding:8px">Could not load positions.</div>';
    return;
  }
  _lmData = data;
  _lmTrafficCfg = data.traffic || { enabled: false };
  var mapEl = document.getElementById('lm-map');
  if (!mapEl) { lmStop(); return; }

  if (!_lmMap) {
    _lmMap = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([32.7765, -79.9311], 10);
    lmAddTiles(_lmMap, data.tile);
    // Labels are pointless once the pins are on top of each other.
    _lmMap.on('zoomend', lmApplyLabels);
  }

  var withFix = data.techs.filter(function (t) { return t.lat !== null && t.lon !== null; });
  var seen = {};
  withFix.forEach(function (t) {
    seen[t.user_id] = 1;
    var st = LM_STATUS[t.status] || LM_STATUS.no_fix;
    var m = _lmMarkers[t.user_id];
    var icon = L.divIcon({
      className: '',
      html: '<div class="lm-pin" style="width:18px;height:18px;background:' + st.color + '"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
    if (m) {
      m.setLatLng([t.lat, t.lon]);
      m.setIcon(icon);
    } else {
      m = L.marker([t.lat, t.lon], { icon: icon, title: t.name }).addTo(_lmMap);
      _lmMarkers[t.user_id] = m;
    }
    m.bindPopup(lmPopupHtml(t));
  });
  Object.keys(_lmMarkers).forEach(function (id) {
    if (!seen[id]) { _lmMap.removeLayer(_lmMarkers[id]); delete _lmMarkers[id]; }
  });

  if (fit && withFix.length) {
    _lmMap.fitBounds(withFix.map(function (t) { return [t.lat, t.lon]; }), { padding: [40, 40], maxZoom: 14 });
  }
  lmApplyTraffic();
  lmApplyLabels();
  lmRenderSide(data);
}

function lmPopupHtml(t) {
  var st = LM_STATUS[t.status] || LM_STATUS.no_fix;
  var bits = [];
  bits.push('<div style="font-weight:800;font-size:14px;margin-bottom:2px">' + escHtml(t.name) + '</div>');
  bits.push('<div style="font-size:12px;color:' + st.color + ';font-weight:700;margin-bottom:6px">' + st.label +
    ' &middot; ' + lmAgeText(t.age_minutes) + '</div>');
  if (t.city_name) bits.push('<div style="font-size:12px">' + escHtml(t.city_name) + '</div>');
  if (t.job) bits.push('<div style="font-size:12px;margin-top:4px">On: ' + escHtml(t.job.store || t.job.ref || ('WO #' + t.job.id)) + '</div>');
  if (t.accuracy_m !== null && t.accuracy_m !== undefined) bits.push('<div style="font-size:11px;color:#8b8b8b;margin-top:4px">Accurate to about ' + Math.round(t.accuracy_m) + 'm</div>');
  if (t.battery_pct !== null && t.battery_pct !== undefined) bits.push('<div style="font-size:11px;color:' + (t.battery_pct < 20 ? '#f87171' : '#8b8b8b') + '">Battery ' + t.battery_pct + '%</div>');
  var acts = [];
  if (t.phone) acts.push('<a href="tel:' + escHtml(t.phone) + '" style="font-size:12px">Call</a>');
  acts.push('<a href="#" onclick="lmShowTrail(' + t.user_id + ');return false;" style="font-size:12px">Today\'s route</a>');
  bits.push('<div style="margin-top:8px;display:flex;gap:12px">' + acts.join('') + '</div>');
  return bits.join('');
}

var _lmShowAll = false;

// Nothing clears duty overnight (nights are a real shift here), so a very long
// "ready" is almost always a forgotten toggle. Say so on the row rather than
// letting dispatch keep sending calls to someone who went home.
var LM_LONG_DUTY_HOURS = 16;

function lmDutyText(t) {
  if (!t.on_duty) return '';
  if (t.hours_on_duty === null || t.hours_on_duty === undefined) return ' &middot; ready';
  var h = t.hours_on_duty;
  var txt = ' &middot; ready ' + (h < 1 ? Math.max(1, Math.round(h * 60)) + 'm' : (Math.round(h * 10) / 10) + 'h');
  if (h >= LM_LONG_DUTY_HOURS) txt += ' <span style="color:#f59e0b">(probably forgot)</span>';
  return txt;
}

function lmTechRow(t) {
  var st = LM_STATUS[t.status] || LM_STATUS.no_fix;
  var meta = st.label + ' &middot; ' + lmAgeText(t.age_minutes) + lmDutyText(t);
  if (t.city_name) meta = escHtml(t.city_name) + ' &middot; ' + meta;
  return '<div class="lm-tech' + (_lmSelected === t.user_id ? ' sel' : '') + '" onclick="lmFocus(' + t.user_id + ')">' +
    '<div class="lm-tech-name"><span class="lm-dot" style="background:' + st.color + '"></span>' + escHtml(t.name) + '</div>' +
    '<div class="lm-meta">' + meta + '</div>' +
    (t.job ? '<div class="lm-meta">On: ' + escHtml(t.job.store || t.job.ref || ('WO #' + t.job.id)) + '</div>' : '') +
    '</div>';
}

function lmRenderSide(data) {
  var side = document.getElementById('lm-side');
  if (!side) return;
  if (!data.techs.length) {
    side.innerHTML = '<div class="text-muted" style="padding:8px">Nobody to show yet.</div>';
    return;
  }
  // Office staff and anyone who has never installed the app would otherwise fill
  // the rail with rows that say "never". Someone ON DUTY with NO position is the
  // exception: that is a phone that has stopped reporting while dispatch thinks
  // they are available, which is exactly what you want to see. The rest folds
  // behind a count.
  var shown = [], hidden = [];
  data.techs.forEach(function (t) {
    if (t.on_duty || t.lat !== null) shown.push(t); else hidden.push(t);
  });
  var html = shown.map(lmTechRow).join('');
  if (!shown.length) html = '<div class="text-muted" style="padding:8px">Nobody is accepting calls right now.</div>';
  if (hidden.length) {
    html += _lmShowAll
      ? hidden.map(lmTechRow).join('') + '<button class="lm-more" onclick="lmToggleAll()">Hide the ' + hidden.length + ' not reporting</button>'
      : '<button class="lm-more" onclick="lmToggleAll()">' + hidden.length + ' more not reporting - show</button>';
  }
  side.innerHTML = html;
}

function lmToggleAll() {
  _lmShowAll = !_lmShowAll;
  if (_lmData) lmRenderSide(_lmData);
}

function lmFocus(userId) {
  _lmSelected = userId;
  var t = (_lmData && _lmData.techs || []).filter(function (x) { return x.user_id === userId; })[0];
  if (t && t.lat !== null && _lmMap) {
    _lmMap.setView([t.lat, t.lon], Math.max(_lmMap.getZoom(), 14));
    var m = _lmMarkers[userId];
    if (m) m.openPopup();
  }
  if (_lmData) lmRenderSide(_lmData);
}

function lmShowTrail(userId) {
  _lmTrailUser = userId;
  _lmTab = 'history';
  lmSetTab('history');
}

// ---------------------------------------------------------------------------
//  History
// ---------------------------------------------------------------------------
// "Today" means the SHOP's today, not the viewer's. The server filters trails in
// America/New_York; a browser in another timezone (or anyone looking just after
// midnight) would otherwise ask for a date the server does not agree with and
// get an empty day back.
function lmTodayStr() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  } catch (e) {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
}

async function lmRenderHistory(host) {
  var people = [];
  try {
    var live = await api('GET', '/locations/live');
    people = live.techs || [];
  } catch (e) {}
  if (!_lmTrailUser && people.length) _lmTrailUser = people[0].user_id;
  if (!_lmTrailDate) _lmTrailDate = lmTodayStr();

  host.innerHTML =
    '<div class="card" style="margin-bottom:12px"><div class="card-body" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
      '<div><label style="display:block;font-size:12px;margin-bottom:4px" class="text-muted">Technician</label>' +
        '<select id="lm-h-user" onchange="lmHistoryLoad()">' +
          people.map(function (p) { return '<option value="' + p.user_id + '"' + (p.user_id === _lmTrailUser ? ' selected' : '') + '>' + escHtml(p.name) + '</option>'; }).join('') +
        '</select></div>' +
      '<div><label style="display:block;font-size:12px;margin-bottom:4px" class="text-muted">Date</label>' +
        '<input type="date" id="lm-h-date" value="' + _lmTrailDate + '" onchange="lmHistoryLoad()"></div>' +
      '<div id="lm-h-summary" class="text-muted" style="font-size:13px"></div>' +
    '</div></div>' +
    '<div class="lm-wrap">' +
      '<div class="lm-side" id="lm-h-stops"><div class="text-muted" style="padding:8px">Pick a tech and a date.</div></div>' +
      '<div class="lm-mapbox"><div id="lm-map"></div></div>' +
    '</div>';

  if (people.length) lmHistoryLoad();
}

async function lmHistoryLoad() {
  var uSel = document.getElementById('lm-h-user');
  var dSel = document.getElementById('lm-h-date');
  if (uSel) _lmTrailUser = parseInt(uSel.value, 10);
  if (dSel) _lmTrailDate = dSel.value;
  if (!_lmTrailUser || !_lmTrailDate) return;

  var mapEl = document.getElementById('lm-map');
  if (!mapEl) return;
  if (!_lmMap) {
    _lmMap = L.map(mapEl).setView([32.7765, -79.9311], 10);
    var tile = (_lmData && _lmData.tile) || { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors' };
    lmAddTiles(_lmMap, tile);
  }
  if (_lmTrailLayer) { _lmMap.removeLayer(_lmTrailLayer); _lmTrailLayer = null; }

  var d;
  try { d = await api('GET', '/locations/trail/' + _lmTrailUser + '?from=' + _lmTrailDate + '&to=' + _lmTrailDate); }
  catch (e) {
    document.getElementById('lm-h-stops').innerHTML = '<div class="text-muted" style="padding:8px">' + escHtml(e.message || 'Could not load that route.') + '</div>';
    return;
  }

  var pts = d.points || [];
  var summary = document.getElementById('lm-h-summary');
  if (summary) {
    summary.innerHTML = pts.length
      ? pts.length + ' positions, ' + (d.stops || []).length + ' stop' + ((d.stops || []).length === 1 ? '' : 's') +
        (d.truncated ? ' (showing the first 5000)' : '')
      : 'No positions recorded for that day.';
  }

  var stopsHost = document.getElementById('lm-h-stops');
  if (!pts.length) {
    if (stopsHost) stopsHost.innerHTML = '<div class="text-muted" style="padding:8px">Nothing recorded. Either they were not marked ready to accept calls, or the app was not reporting.</div>';
    return;
  }

  _lmTrailLayer = L.layerGroup().addTo(_lmMap);
  L.polyline(pts.map(function (p) { return [p.lat, p.lon]; }), { color: '#f97316', weight: 3, opacity: 0.85 }).addTo(_lmTrailLayer);

  // Stops first, then start/end, so the green start pin is not buried under the
  // blue stop marker that sits on the same spot.
  (d.stops || []).forEach(function (st) {
    L.circleMarker([st.lat, st.lon], { radius: 9, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9 })
      .bindPopup('Stopped ' + st.minutes + ' min<br>' + lmClock(st.from) + ' to ' + lmClock(st.to))
      .addTo(_lmTrailLayer);
  });

  L.circleMarker([pts[0].lat, pts[0].lon], { radius: 7, color: '#fff', weight: 3, fillColor: '#22c55e', fillOpacity: 1 })
    .bindPopup('Start ' + lmClock(pts[0].recorded_at)).addTo(_lmTrailLayer);
  var last = pts[pts.length - 1];
  L.circleMarker([last.lat, last.lon], { radius: 7, color: '#fff', weight: 3, fillColor: '#ef4444', fillOpacity: 1 })
    .bindPopup('End ' + lmClock(last.recorded_at)).addTo(_lmTrailLayer);

  _lmMap.fitBounds(pts.map(function (p) { return [p.lat, p.lon]; }), { padding: [40, 40] });

  if (stopsHost) {
    stopsHost.innerHTML = (d.stops || []).length
      ? (d.stops || []).map(function (s, i) {
          return '<div class="lm-tech" onclick="lmZoomStop(' + s.lat + ',' + s.lon + ')">' +
            '<div class="lm-tech-name"><span class="lm-dot" style="background:#3b82f6"></span>Stop ' + (i + 1) + '</div>' +
            '<div class="lm-meta">' + lmClock(s.from) + ' to ' + lmClock(s.to) + ' &middot; ' + s.minutes + ' min</div></div>';
        }).join('')
      : '<div class="text-muted" style="padding:8px">Moving the whole time, no stops over 5 minutes.</div>';
  }
}

function lmZoomStop(lat, lon) {
  if (_lmMap) _lmMap.setView([lat, lon], 17);
}

function lmClock(t) {
  try {
    return new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch (e) { return String(t); }
}

// ---------------------------------------------------------------------------
//  Settings > Location Tracking
// ---------------------------------------------------------------------------
async function renderLocationSettings(content) {
  var d;
  try { d = await api('GET', '/locations/settings'); }
  catch (e) { content.innerHTML = '<div class="card"><div class="card-body">Could not load location settings.</div></div>'; return; }
  var s = d.settings || {};
  function fld(key, label, help, type) {
    return '<div style="margin-bottom:18px;max-width:520px">' +
      '<label style="display:block;font-weight:600;margin-bottom:4px">' + escHtml(label) + '</label>' +
      '<input id="ls-' + key + '" type="' + (type || 'text') + '" value="' + escHtml(String(s[key] === undefined ? '' : s[key])) + '" style="width:100%">' +
      '<div class="text-muted" style="font-size:12px;margin-top:5px">' + help + '</div></div>';
  }
  function chk(key, label, help) {
    var on = String(s[key]) === '1' || String(s[key]).toLowerCase() === 'true';
    return '<div style="margin-bottom:18px;max-width:520px">' +
      '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer">' +
        '<input id="ls-' + key + '" type="checkbox"' + (on ? ' checked' : '') + ' style="width:auto;margin-top:3px">' +
        '<span><span style="font-weight:600">' + escHtml(label) + '</span>' +
        '<div class="text-muted" style="font-size:12px;margin-top:3px">' + help + '</div></span>' +
      '</label></div>';
  }

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Location Tracking</div>' +
      '<div class="page-subtitle">What the phones report, and how long it is kept.</div></div></div>' +
    '<div id="settings-error"></div><div id="settings-success"></div>' +
    '<div class="card"><div class="card-body">' +
      chk('location_enabled', 'Location tracking is on',
        'The master switch. Turn this off and every phone stops reporting on its next check-in, with no app update needed.') +
      chk('location_require_ready', 'Only track while ready to accept calls',
        'Enforced on the server, not the phone. Leave this on. Techs here do not punch a time clock, so this is the switch: ' +
        'a tech marks themselves ready when they start, and Nova stores nothing for anyone who is off duty. ' +
        'It is what makes the promise you make to the crew actually true, and turning it off means recording where people are on their own time.') +
      fld('location_ping_seconds', 'Seconds between positions', 'How often a moving phone reports. 45 is a good balance. Lower drains battery fast.', 'number') +
      fld('location_distance_meters', 'Minimum movement (meters)', 'A phone that has not moved this far does not report. This saves more battery than the interval does. 50 is about half a block.', 'number') +
      fld('location_max_accuracy_m', 'Reject fixes worse than (meters)', 'A cell-tower fix can be off by kilometers. Anything less accurate than this is thrown away instead of drawing a lie on the map.', 'number') +
      fld('location_idle_minutes', 'Report a parked tech at least every (minutes)', 'A tech who has not moved does not report, which is where most of the battery saving comes from. This is the longest a stationary tech is allowed to look stale on the map. 2 is a good balance; raising it saves battery, lowering it makes a parked truck look fresher.', 'number') +
      fld('location_stale_minutes', 'Call a position stale after (minutes)', 'How long before the map greys out a pin and stops claiming it knows where someone is.', 'number') +
      fld('location_retention_days', 'Keep route history for (days)', 'Older breadcrumbs are deleted nightly. Current positions are never swept. 90 days is the default.', 'number') +
      fld('location_tile_url', 'Map tile URL', 'Where the STREET IMAGES behind the pins come from. The default is OpenStreetMap: free, no key, no account. If your network blocks it or you want a different look, paste a MapTiler or Google tiles URL here instead - no code change, no deploy. Keep the {z}/{x}/{y} placeholders, they are how the map asks for each square.') +
      '<div style="margin:-8px 0 20px;max-width:520px">' +
        '<button class="btn btn-secondary" onclick="testLocationTiles()">Test map tiles</button>' +
        '<span id="ls-tiletest" style="margin-left:10px;font-size:13px"></span>' +
        '<div class="text-muted" style="font-size:12px;margin-top:6px">Fetches one map square from the URL above and tells you whether it arrived. Run this from a computer on the same network the crew uses.</div>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border,#2e2e2e);margin:22px 0 18px;padding-top:18px;max-width:520px">' +
        '<div style="font-weight:800;margin-bottom:4px">Live traffic</div>' +
        '<div class="text-muted" style="font-size:12px;line-height:1.55">OpenStreetMap has no traffic data, so congestion needs a ' +
          'separate provider. A free TomTom developer key covers a dispatcher or two: sign up at ' +
          '<a href="https://developer.tomtom.com" target="_blank" rel="noopener">developer.tomtom.com</a>, ' +
          'no card needed, then paste the key below. Restrict it to your own domain in their portal while you are there. ' +
          'Traffic paints the roads underneath the pins, so it never covers a tech.</div>' +
      '</div>' +
      chk('location_traffic_enabled', 'Offer live traffic on the map', 'Turns the Traffic button on for dispatchers. Each of them still chooses whether to switch the layer on, and it stays off until they do.') +
      fld('location_traffic_key', 'Traffic provider key', 'Paste the key here. Leave it blank and the Traffic button never appears.') +
      fld('location_traffic_url', 'Traffic tile URL', 'Where the congestion images come from. {key} is replaced with the key above. The default is TomTom flow; swap it for HERE or another provider by pasting their tile URL.') +
      fld('location_tile_attribution', 'Map attribution', 'Credit line shown in the map corner. Most tile providers require this.') +
      '<button class="btn btn-primary" onclick="saveLocationSettings()">Save</button>' +
    '</div></div>';
}


// Loads a single real tile from whatever URL is currently in the box. This is
// the difference between "the map is broken" and "the map images are coming
// from somewhere this network cannot reach", which are very different problems.
function testLocationTiles() {
  var el = document.getElementById('ls-tiletest');
  var input = document.getElementById('ls-location_tile_url');
  if (!el || !input) return;
  var url = String(input.value || '').trim();
  if (!url) { el.innerHTML = '<span style="color:var(--danger,#ef4444)">Enter a tile URL first.</span>'; return; }

  // Downtown Charleston at zoom 13, the tile every provider has.
  var test = url.replace('{s}', 'a').replace('{z}', '13').replace('{x}', '2350').replace('{y}', '3311')
                .replace('{r}', '').replace('{quadkey}', '');
  el.innerHTML = '<span class="text-muted">Checking...</span>';

  var done = false;
  var img = new Image();
  var timer = setTimeout(function () {
    if (done) return;
    done = true;
    el.innerHTML = '<span style="color:var(--warning,#f59e0b)">No answer after 10 seconds.</span> ' +
      '<span class="text-muted">Treat that as blocked.</span>';
  }, 10000);

  img.onload = function () {
    if (done) return;
    done = true; clearTimeout(timer);
    el.innerHTML = '<span style="color:var(--success,#22c55e)">Tiles are loading.</span> ' +
      '<span class="text-muted">The Live Map will show streets.</span>';
  };
  img.onerror = function () {
    if (done) return;
    done = true; clearTimeout(timer);
    el.innerHTML = '<span style="color:var(--danger,#ef4444)">That tile did not load.</span> ' +
      '<span class="text-muted">The map will draw pins and routes on an empty background until this is fixed. ' +
      'Check the URL, or that this network allows the tile server.</span>';
  };
  img.src = test;
}

async function saveLocationSettings() {
  var keys = ['location_enabled', 'location_require_ready', 'location_ping_seconds', 'location_distance_meters',
    'location_max_accuracy_m', 'location_idle_minutes', 'location_stale_minutes', 'location_retention_days', 'location_tile_url', 'location_tile_attribution',
    'location_traffic_enabled', 'location_traffic_key', 'location_traffic_url'];
  var body = {};
  keys.forEach(function (k) {
    var el = document.getElementById('ls-' + k);
    if (!el) return;
    body[k] = (el.type === 'checkbox') ? (el.checked ? '1' : '0') : el.value;
  });
  try {
    await api('POST', '/locations/settings', body);
    if (typeof apiBustCache === 'function') apiBustCache('/locations');
    if (typeof showToast === 'function') showToast('Location settings saved.', 'success');
  } catch (e) {
    if (typeof showToast === 'function') showToast(e.message || 'Could not save.', 'error');
  }
}
