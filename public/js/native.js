// ===========================================================================
//  Nova - native shell bridge
// ---------------------------------------------------------------------------
//  Loaded by every Nova page. In a browser it does nothing at all. Inside the
//  Android app it turns on the three things a browser will not do:
//
//    1. background GPS that keeps reporting with the phone locked
//    2. external links opening in the phone's browser instead of trapping the
//       tech inside the app with no back button
//    3. a plain-language disclosure before location is ever collected
//
//  Nova is served from the live site and the shell just points at it, so this
//  file ships with a normal deploy. There is no new app build for a change in
//  here, which is the entire reason the shell was built this way.
//
//  Classic script like app.js: everything global, no modules, no bundler.
// ===========================================================================

var NOVA_DISCLOSURE_KEY = 'nova_location_disclosure_v1';

function novaIsNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
}
function novaPlugin(name) {
  try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null; }
  catch (e) { return null; }
}
function novaPlatform() {
  try { return (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web'; }
  catch (e) { return 'web'; }
}

// ---------------------------------------------------------------------------
//  1. External links
// ---------------------------------------------------------------------------
// A WebView follows an off-site link in place. The tech taps a Google Maps link
// and Nova is simply gone, with no back button and no way home short of killing
// the app. Anything that is not Nova goes to the system browser instead.
function novaIsExternal(url) {
  try {
    var u = new URL(url, window.location.href);
    if (u.protocol === 'tel:' || u.protocol === 'mailto:' || u.protocol === 'sms:') return false; // the OS handles these
    return u.host !== window.location.host;
  } catch (e) { return false; }
}

function novaOpenExternal(url) {
  var Browser = novaPlugin('Browser');
  if (Browser && Browser.open) { Browser.open({ url: url }); return true; }
  return false;
}

function novaInstallLinkHandling() {
  if (!novaIsNative()) return;

  // Covers every existing window.open call site without touching any of them.
  var origOpen = window.open;
  window.open = function (url, name, features) {
    if (url && novaIsExternal(url) && novaOpenExternal(String(url))) return null;
    return origOpen.apply(window, arguments);
  };

  // Covers plain <a target="_blank"> and anything added later.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    if (!novaIsExternal(href)) return;
    if (novaOpenExternal(a.href)) e.preventDefault();
  }, true);
}

// ---------------------------------------------------------------------------
//  2. The disclosure
// ---------------------------------------------------------------------------
// Shown once, before the very first location permission prompt, in words a tech
// can actually read. Google Play requires a prominent disclosure for this kind
// of collection, and more to the point the crew deserves to be told plainly
// rather than discovering it.
function novaDisclosureAccepted() {
  try { return localStorage.getItem(NOVA_DISCLOSURE_KEY) === '1'; } catch (e) { return false; }
}

// Singleton. Two things can ask at nearly the same moment (the duty toggle and
// the board's own refresh), and two stacked dialogs means dismissing one leaves
// a second one behind with no explanation. Everyone waits on the same promise.
var _novaDiscPromise = null;

function novaShowDisclosure() {
  if (novaDisclosureAccepted()) return Promise.resolve(true);
  if (_novaDiscPromise) return _novaDiscPromise;
  _novaDiscPromise = new Promise(function (resolve) {
    var existing = document.getElementById('nova-disclosure');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var wrap = document.createElement('div');
    wrap.className = 'modal-overlay';
    wrap.id = 'nova-disclosure';
    wrap.innerHTML =
      '<div class="modal">' +
        '<div class="modal-header"><span class="modal-title">Before you go on duty</span></div>' +
        '<div class="modal-body" style="line-height:1.65">' +
          '<p style="margin-top:0"><b>Nova collects your location, including while the app is closed or ' +
            'the screen is off,</b> so dispatch can send the closest tech to a call and tell a customer ' +
            'how far out you are.</p>' +
          '<p>It only happens while you are <b>ready to accept calls</b>. Turn that off and collection stops, ' +
            'every time. The server will not store a position for anyone who is off duty.</p>' +
          '<p>While it is running, Android shows a notification so you can always see it is on. ' +
            'Your route is kept for 90 days and then deleted.</p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" id="nova-disc-no">Not now</button>' +
          '<button class="btn btn-primary" id="nova-disc-yes">I understand, continue</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    function close(ok) {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (ok) { try { localStorage.setItem(NOVA_DISCLOSURE_KEY, '1'); } catch (e) {} }
      _novaDiscPromise = null;
      resolve(ok);
    }
    document.getElementById('nova-disc-yes').onclick = function () { close(true); };
    document.getElementById('nova-disc-no').onclick = function () { close(false); };
  });
  return _novaDiscPromise;
}

// ---------------------------------------------------------------------------
//  3. Background location
// ---------------------------------------------------------------------------
// The watcher runs in a foreground service with a persistent notification. That
// notification is not a nuisance to be hidden, it is the honest signal that
// tracking is on, and it is also why the app does NOT need Android's
// ACCESS_BACKGROUND_LOCATION permission - which in turn means no special Play
// Store background-location review.
var _novaWatcherId = null;
var _novaStarting = null;
var _novaStopWanted = false;

// ONE watcher, ever. The duty toggle, the board refresh and the location card
// can all ask at the same moment; without a single shared in-flight promise
// each of them starts its own foreground service. Three services means three
// times the battery for the same information, and only one of them gets torn
// down on stop. The guard has to be taken BEFORE the disclosure is awaited,
// because that await is exactly where the callers pile up.
function novaStartNativeTracking(cfg) {
  if (!novaIsNative()) return Promise.resolve(false);
  var BG = novaPlugin('BackgroundGeolocation');
  if (!BG || !BG.addWatcher) return Promise.resolve(false);
  if (_novaWatcherId) return Promise.resolve(true);
  if (_novaStarting) return _novaStarting;

  _novaStopWanted = false;
  _novaStarting = (async function () {
    var ok = await novaShowDisclosure();
    if (!ok) return false;
    if (_novaWatcherId) return true;

    var distance = (cfg && cfg.distanceMeters) || 50;
    try {
      var id = await BG.addWatcher({
        backgroundTitle: 'Nova is sharing your location',
        backgroundMessage: 'Only while you are ready to accept calls.',
        requestPermissions: true,
        stale: false,
        distanceFilter: distance
      }, function (location, error) {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') novaLocationDenied(BG);
          return;
        }
        if (!location) return;
        // Into the same queue the browser path uses, so there is one batching,
        // retry and dedupe implementation rather than two that drift apart.
        if (typeof novaLocQueueFix === 'function') {
          novaLocQueueFix({
            coords: {
              latitude: location.latitude,
              longitude: location.longitude,
              accuracy: location.accuracy,
              altitude: location.altitude,
              speed: location.speed,
              heading: location.bearing
            },
            timestamp: location.time || Date.now()
          });
        }
      });
      _novaWatcherId = id;
      // A tech can tap Ready and then Not Ready before the permission dialog is
      // even answered. If that happened while we were starting, honour it now
      // rather than leaving a service running that nobody asked for.
      if (_novaStopWanted) { await novaStopNativeTracking(); return false; }
      return true;
    } catch (e) {
      _novaWatcherId = null;
      return false;
    }
  })();

  var p = _novaStarting;
  p.then(function () { if (_novaStarting === p) _novaStarting = null; },
         function () { if (_novaStarting === p) _novaStarting = null; });
  return p;
}

async function novaStopNativeTracking() {
  _novaStopWanted = true;
  var BG = novaPlugin('BackgroundGeolocation');
  if (!BG || !_novaWatcherId) { _novaWatcherId = null; return; }
  var id = _novaWatcherId;
  _novaWatcherId = null;
  try { await BG.removeWatcher({ id: id }); } catch (e) {}
}

function novaLocationDenied(BG) {
  // The tech said no, or Android revoked it. Say so where they will see it and
  // offer the one action that fixes it, rather than failing quietly forever.
  if (typeof showToast === 'function') {
    showToast('Nova cannot see your location. Dispatch will not know where you are.', 'error');
  }
  if (typeof novaConfirm === 'function') {
    novaConfirm('Nova does not have permission to use your location. Open the app settings to allow it?')
      .then(function (yes) { if (yes && BG && BG.openSettings) BG.openSettings(); });
  }
}

function novaNativeTrackingRunning() { return !!_novaWatcherId; }

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
(function () {
  if (!novaIsNative()) return;
  document.documentElement.setAttribute('data-nova-native', novaPlatform());
  novaInstallLinkHandling();
})();
