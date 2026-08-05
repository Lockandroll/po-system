/* Nova - Coverage Zones
 * ---------------------------------------------------------------------------
 * Where you work, cut into zones, and what each zone does to the price and the
 * ETA. Zip lists today; drawn shapes once a geocoding provider is switched on.
 *
 * Zones may not overlap. That is not tidiness - it is what makes a zone match
 * unique, which is the only reason the overrides can be applied without a
 * precedence rule nobody would remember. The server refuses the save and names
 * the zone that already owns the zip.
 * --------------------------------------------------------------------------- */

var _cvCity = null;
var _cvCities = [];
var _cvZones = [];
var _cvGeo = { configured: false, provider: null };

function cvInjectStyles() {
  if (document.getElementById('cv-styles')) return;
  var css =
    '.cv-zone{border:1px solid var(--border);border-radius:var(--radius);padding:13px 15px;margin-bottom:12px;' +
      'background:var(--bg-card)}' +
    '.cv-zone.off{opacity:.55}' +
    '.cv-zhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
    '.cv-swatch{width:11px;height:11px;border-radius:3px;flex:0 0 auto}' +
    '.cv-zname{font-weight:700;font-size:14.5px}' +
    '.cv-kind{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;' +
      'color:var(--text-muted-color)}' +
    '.cv-zips{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}' +
    '.cv-zip{background:var(--bg-elevated);border:1px solid var(--border);border-radius:5px;' +
      'padding:3px 9px;font-size:12px;font-variant-numeric:tabular-nums}' +
    '.cv-adj{font-size:12px;color:var(--text-muted-color);margin-top:8px}' +
    '.cv-adj b{color:var(--text)}' +
    '.cv-note{font-size:12px;color:var(--text-muted-color);line-height:1.65}' +
    '.cv-lookup{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}' +
    '.cv-lookup .form-group{margin-bottom:0}' +
    '.cv-res{margin-top:12px;font-size:13.5px;line-height:1.6}' +
    '.cv-ooa{color:#f87171;font-weight:700}' +
    '.cv-in{color:#4ade80;font-weight:700}';
  var st = document.createElement('style');
  st.id = 'cv-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

var CV_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#14b8a6', '#ef4444', '#eab308'];

async function renderCoverage(content) {
  cvInjectStyles();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Coverage Zones</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';
  try {
    var ref = await api('GET', '/dispatch/reference');
    _cvCities = ref.cities || [];
  } catch (e) {
    content.innerHTML = '<div class="card"><div class="card-body">Could not load. ' + escHtml(e.message || '') + '</div></div>';
    return;
  }
  if (!_cvCity) _cvCity = ((_cvCities[0] || {}).code || '').trim();

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">Coverage Zones</div>' +
      '<div class="page-subtitle">Where you work, and what each zone does to the price and the ETA.</div></div>' +
      '<div class="flex-gap">' +
        '<select id="cv-city" onchange="cvPickCity(this.value)" style="width:auto">' +
          _cvCities.map(function (c) {
            var code = (c.code || '').trim();
            return '<option value="' + escHtml(code) + '"' + (code === _cvCity ? ' selected' : '') + '>' +
              escHtml(c.name) + '</option>';
          }).join('') +
        '</select>' +
        '<button class="btn btn-primary btn-sm" onclick="cvEditZone(null)">+ Zone</button>' +
      '</div>' +
    '</div>' +
    '<div id="cv-body"></div>';
  await cvLoad();
}

function cvPickCity(c) { _cvCity = c; cvLoad(); }

async function cvLoad() {
  var body = document.getElementById('cv-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading zones...</div></div>';
  var data;
  try { data = await api('GET', '/coverage?city=' + encodeURIComponent(_cvCity)); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _cvZones = data.zones || [];
  _cvGeo = data.geocoding || { configured: false };

  var zoneHtml = _cvZones.length ? _cvZones.map(function (z, i) {
    var col = CV_COLORS[i % CV_COLORS.length];
    var zips = (z.zips || []);
    var adj = [];
    if (z.eta_adjust_minutes) adj.push('ETA <b>' + (z.eta_adjust_minutes > 0 ? '+' : '') + z.eta_adjust_minutes + ' min</b>');
    if (z.price_adjust_type && z.price_adjust_value !== null) {
      adj.push('Price <b>' + (Number(z.price_adjust_value) > 0 ? '+' : '') +
        (z.price_adjust_type === 'flat' ? '$' + z.price_adjust_value : z.price_adjust_value + '%') + '</b>');
    }
    return '<div class="cv-zone' + (z.active ? '' : ' off') + '">' +
      '<div class="cv-zhead">' +
        '<span class="cv-swatch" style="background:' + col + '"></span>' +
        '<span class="cv-zname">' + escHtml(z.name) + '</span>' +
        '<span class="cv-kind">' + escHtml(z.kind) + (z.is_primary ? '' : ' &middot; extended') + '</span>' +
        (z.active ? '' : '<span class="cv-kind" style="color:#f87171">switched off</span>') +
        '<span style="margin-left:auto"></span>' +
        '<button class="btn btn-secondary btn-sm" onclick="cvEditZone(' + z.id + ')">Edit</button>' +
        (z.active ? '<button class="btn btn-ghost btn-sm" onclick="cvDeactivate(' + z.id + ')">Switch off</button>' : '') +
      '</div>' +
      (zips.length
        ? '<div class="cv-zips">' + zips.map(function (p) { return '<span class="cv-zip">' + escHtml(p) + '</span>'; }).join('') + '</div>'
        : '<div class="cv-note" style="margin-top:8px">Drawn shape</div>') +
      (adj.length ? '<div class="cv-adj">' + adj.join(' &middot; ') + '</div>'
                  : '<div class="cv-adj">Standard price and ETA</div>') +
      '</div>';
  }).join('') : '<div class="card"><div class="empty-state">No zones for this city yet.<br>' +
    '<span style="font-size:13px">Until you add one, every call here counts as out of area.</span></div></div>';

  body.innerHTML =
    '<div class="mk-cols" style="display:grid;grid-template-columns:1fr 340px;gap:16px;align-items:start">' +
      '<div>' + zoneHtml + '</div>' +
      '<div>' +
        '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
          '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
            'color:var(--primary);margin-bottom:10px">Check a zip</div>' +
          '<div class="cv-lookup">' +
            '<div class="form-group" style="flex:1"><input id="cv-zip-test" placeholder="32792"></div>' +
            '<button class="btn btn-secondary btn-sm" onclick="cvLookup()">Check</button>' +
          '</div>' +
          '<div id="cv-res" class="cv-res"></div>' +
        '</div></div>' +
        '<div class="card"><div class="card-body">' +
          '<div class="cv-note">' +
            '<b>Zones cannot overlap.</b> A zip belongs to exactly one live zone. That is what lets a ' +
            'zone change the price and the ETA without any question of which one wins.' +
            '<br><br><b>Zip is checked first</b>, before any drawn shape. Zip is exact and costs nothing; ' +
            'a shape needs an address converted to coordinates, which can fail - and a bad conversion ' +
            'moving a call into the wrong market is the wrong price, the wrong pay and the wrong ' +
            'royalty bucket.' +
            '<br><br>No zone at all means <b>out of area</b>. The call still gets taken; it just gets ' +
            'tagged.' +
          '</div>' +
          (_cvGeo.configured
            ? '<div style="margin-top:12px;font-size:12px;color:#4ade80">Drawn zones available (' +
              escHtml(_cvGeo.provider || '') + ')</div>'
            : '<div style="margin-top:12px;font-size:12px;color:var(--text-muted-color)">' +
              'Drawn shapes need a geocoding provider switched on. Zip zones work without one.</div>') +
        '</div></div>' +
      '</div>' +
    '</div>';
  var box = document.getElementById('cv-zip-test');
  if (box) box.addEventListener('keydown', function (e) { if (e.key === 'Enter') cvLookup(); });
}

async function cvLookup() {
  var zip = (document.getElementById('cv-zip-test') || {}).value || '';
  var out = document.getElementById('cv-res');
  if (!out) return;
  if (!zip.trim()) { out.innerHTML = ''; return; }
  var r;
  try { r = await api('GET', '/coverage/lookup?zip=' + encodeURIComponent(zip.trim()) + '&city_code=' + encodeURIComponent(_cvCity)); }
  catch (e) { out.innerHTML = escHtml(e.message); return; }
  if (r.out_of_area) {
    out.innerHTML = '<span class="cv-ooa">Out of area.</span> A call on this zip is taken, tagged, ' +
      'and priced with no zone adjustment.';
    return;
  }
  out.innerHTML = '<span class="cv-in">' + escHtml(r.zone.name) + '</span>' +
    '<div style="color:var(--text-muted-color);font-size:12.5px;margin-top:4px">Matched by ' +
      escHtml(r.matched_by) + '</div>' +
    (r.wrong_city ? '<div style="color:#fbbf24;margin-top:6px">That zip belongs to ' +
      escHtml(String(r.zone.city_code || '').trim()) + ', not the city you have selected.</div>' : '');
}

function cvEditZone(id) {
  var z = _cvZones.filter(function (x) { return x.id === id; })[0] || {};
  var zips = (z.zips || []).join(' ');
  dispModal(id ? 'Edit zone' : 'New zone',
    '<div class="form-group"><label>Name</label><input id="cv-name" value="' + escHtml(z.name || '') +
      '" placeholder="Orlando primary"></div>' +
    '<div class="form-group"><label>Zip codes</label>' +
      '<textarea id="cv-zips" rows="4" placeholder="32801 32803 32804">' + escHtml(zips) + '</textarea>' +
      '<div class="cv-note" style="margin-top:5px">Paste them however they come - commas, spaces or ' +
        'one per line. Anything that is not a zip is dropped rather than stored.</div></div>' +
    '<div style="display:flex;gap:10px">' +
      '<div class="form-group" style="flex:1"><label>ETA adjustment (min)</label>' +
        '<input id="cv-eta" value="' + escHtml(z.eta_adjust_minutes || '') + '" placeholder="0"></div>' +
      '<div class="form-group" style="flex:1"><label>Price adjustment</label>' +
        '<select id="cv-ptype">' +
          '<option value="">None</option>' +
          '<option value="flat"' + (z.price_adjust_type === 'flat' ? ' selected' : '') + '>Flat $</option>' +
          '<option value="percent"' + (z.price_adjust_type === 'percent' ? ' selected' : '') + '>Percent</option>' +
        '</select></div>' +
      '<div class="form-group" style="flex:1"><label>Amount</label>' +
        '<input id="cv-pval" value="' + escHtml(z.price_adjust_value === null || z.price_adjust_value === undefined ? '' : z.price_adjust_value) + '"></div>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:10px">' +
      '<input type="checkbox" id="cv-primary" style="width:16px;height:16px;padding:0;margin:0;' +
        'accent-color:var(--primary)"' + (z.is_primary === false ? '' : ' checked') + '>' +
      '<label for="cv-primary" style="margin:0;cursor:pointer">Primary coverage ' +
        '<span style="font-weight:400;font-size:.85em;color:var(--text-muted-color)">' +
        '(untick for the fringe you still run but charge more for)</span></label></div>' +
    '<div class="cv-note">A zone surcharge never applies to an EDU - a child or a pet locked in a ' +
      'vehicle stays free however far out it is. The ETA adjustment still does, because the distance ' +
      'is real.</div>',
    'Save', function () { cvSaveZone(id); });
}

async function cvSaveZone(id) {
  function v(x) { var e = document.getElementById(x); return e ? e.value : ''; }
  var body = {
    id: id || null, city_code: _cvCity, name: v('cv-name'), kind: 'zip', zips: v('cv-zips'),
    eta_adjust_minutes: v('cv-eta'), price_adjust_type: v('cv-ptype'), price_adjust_value: v('cv-pval'),
    is_primary: (document.getElementById('cv-primary') || {}).checked !== false
  };
  if (!body.name.trim()) {
    if (typeof showToast === 'function') showToast('Give the zone a name.', 'error');
    return;
  }
  try { await api('POST', '/coverage', body); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  dispCloseModal();
  if (typeof apiBustCache === 'function') apiBustCache('/coverage');
  cvLoad();
}

async function cvDeactivate(id) {
  if (!(await novaConfirm('Switch this zone off? Its zips become free for another zone, and calls ' +
      'already priced under it keep the price they were quoted.'))) return;
  try { await api('POST', '/coverage/' + id + '/deactivate', {}); }
  catch (e) { if (typeof showToast === 'function') showToast(e.message, 'error'); return; }
  if (typeof apiBustCache === 'function') apiBustCache('/coverage');
  cvLoad();
}
