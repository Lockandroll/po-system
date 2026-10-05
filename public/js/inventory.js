// Parts Inventory screens (routes/inventory.js). Phase 1, 2026-10-05.
//
// House style: string concatenation only, no template literals (CLAUDE.md 1.1).
// Apostrophes inside HTML strings are &#39; (CLAUDE.md 1.2).
//
// Separate from the Equipment pages in app.js (asset-*): those are company
// tools issued to a tech and signed for. This is the parts and batteries that
// go onto invoices, on a city shelf or in a tech's van.
//
// The rule the whole module hangs off: a tech can ADD stock and can never
// subtract it. The only button that lowers a count is Adjust, which needs
// manage_inventory and a written reason, and the server enforces that whatever
// this file renders.
//
// Every value interpolated into an onclick is a number. Part names and notes
// never go into a JS string literal; rows are looked up from the cached arrays
// by index instead.

var _invt = { cfg: null, locations: [], stock: [], loc: null, addLines: [], addLoc: null, xfer: null, settings: [], timer: null };

function invtMoney(n) {
  var v = parseFloat(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2);
}
function invtCatTag(c) {
  var map = { locksmith: 'LOCK', battery: 'BATT', other: 'OTHER' };
  var k = c || 'locksmith';
  return '<span class="rf-tag ' + escHtml(k) + '">' + (map[k] || escHtml(String(k).toUpperCase())) + '</span>';
}
function invtStatusChip(s) {
  if (s === 'negative') return '<span class="badge" style="background:rgba(239,68,68,.15);color:var(--danger)">Negative</span>';
  if (s === 'out') return '<span class="badge" style="background:rgba(239,68,68,.12);color:var(--danger)">Out</span>';
  if (s === 'low') return '<span class="badge" style="background:rgba(245,158,11,.15);color:var(--warning)">Low</span>';
  return '<span class="badge" style="background:rgba(34,197,94,.12);color:var(--success)">OK</span>';
}
var INVT_REASON = {
  added: 'Added', received: 'Received', adjusted: 'Adjusted',
  transfer_in: 'Transfer in', transfer_out: 'Transfer out'
};
function invtReason(r) { return INVT_REASON[r] || escHtml(String(r || '').replace(/_/g, ' ')); }
function invtPartLabel(r) {
  return '<strong style="color:var(--text)">' + escHtml(r.description || r.part_label || 'Part') + '</strong>' +
    (r.item_number ? '<div class="mono" style="font-size:11px;color:var(--text-muted-color)">' + escHtml(r.item_number) + '</div>' : '');
}
function invtClose(btn) { var o = btn && btn.closest ? btn.closest('.modal-overlay') : null; if (o) o.remove(); }
function invtModal(id, title, body, footer) {
  var old = document.getElementById(id); if (old) old.remove();
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.id = id;
  ov.innerHTML = '<div class="modal">' +
    '<div class="modal-header"><span class="modal-title">' + title + '</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="invtClose(this)">&#10005;</button></div>' +
    '<div class="modal-body">' + body + '</div>' +
    '<div class="modal-footer">' + footer + '</div></div>';
  document.body.appendChild(ov);
  return ov;
}
async function invtConfig() {
  if (!_invt.cfg) _invt.cfg = await api('GET', '/inventory/config');
  return _invt.cfg;
}

// ---------------------------------------------------------------------------
// Inventory: every part x location in my cities (manager)
// ---------------------------------------------------------------------------
async function renderInventory(el) {
  try {
    var cfg = await invtConfig();
    _invt.locations = await api('GET', '/inventory/locations');
    var cities = [];
    _invt.locations.forEach(function (l) { if (cities.indexOf(l.city_code) === -1) cities.push(l.city_code); });
    el.innerHTML =
      '<div class="page-header">' +
        '<div><div class="page-title">Inventory</div><div class="page-subtitle">Parts and batteries on every shelf and van in your cities. Company tools live under Equipment.</div></div>' +
        '<div class="row-actions">' +
          '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;inventory-settings&#39;)">' + icons.settings + ' Part Settings</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="invtTransferModal(null)">' + NAVI.swap + ' Transfer</button>' +
          (cfg.can_add ? '<button class="btn btn-primary btn-sm" onclick="invtAddModal(null)">' + icons.plus + ' Add Stock</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="stats-grid" id="invt-stats"></div>' +
      '<div class="card">' +
        '<div class="card-body" style="border-bottom:1px solid var(--border)">' +
          '<div class="filter-bar">' +
            '<input type="text" id="invt-q" placeholder="Search part, item number, location..." style="flex:2;min-width:220px" oninput="invtFilterSoon()" />' +
            '<select id="invt-city" onchange="invtLoadStock()"><option value="">All Cities</option>' + cities.map(function (c) { return '<option value="' + escHtml(c) + '">' + escHtml(c) + '</option>'; }).join('') + '</select>' +
            '<select id="invt-kind" onchange="invtLoadStock()"><option value="">Shelves &amp; vans</option><option value="shelf">Shelves only</option><option value="van">Vans only</option></select>' +
            '<select id="invt-cat" onchange="invtLoadStock()"><option value="">All Categories</option><option value="locksmith">Locksmith</option><option value="battery">Battery</option><option value="other">Other</option></select>' +
            '<select id="invt-status" onchange="invtLoadStock()"><option value="">Any status</option><option value="low">Low or out</option><option value="negative">Negative</option></select>' +
          '</div>' +
          '<div id="invt-count" style="font-size:13px;color:var(--text-muted-color)"></div>' +
        '</div>' +
        '<div id="invt-table"><div class="loading">Loading&hellip;</div></div>' +
      '</div>';
    await invtLoadStock();
  } catch (err) {
    el.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}
function invtFilterSoon() { clearTimeout(_invt.timer); _invt.timer = setTimeout(invtLoadStock, 300); }
async function invtLoadStock() {
  var wrap = document.getElementById('invt-table');
  if (!wrap) return;
  function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
  var p = [];
  if (v('invt-q')) p.push('q=' + encodeURIComponent(v('invt-q')));
  if (v('invt-city')) p.push('city=' + encodeURIComponent(v('invt-city')));
  if (v('invt-kind')) p.push('kind=' + encodeURIComponent(v('invt-kind')));
  if (v('invt-cat')) p.push('category=' + encodeURIComponent(v('invt-cat')));
  if (v('invt-status')) p.push('status=' + encodeURIComponent(v('invt-status')));
  try {
    var d = await api('GET', '/inventory/stock' + (p.length ? '?' + p.join('&') : ''));
    _invt.stock = d.rows;
    var st = document.getElementById('invt-stats');
    if (st) st.innerHTML =
      '<div class="stat-card"><div class="stat-value">' + invtMoney(d.totals.value) + '</div><div class="stat-label">Value on hand</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + d.totals.units + '</div><div class="stat-label">Units on hand</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:' + (d.totals.low ? 'var(--warning)' : 'var(--text)') + '">' + d.totals.low + '</div><div class="stat-label">Low or out</div></div>' +
      '<div class="stat-card"><div class="stat-value" style="color:' + (d.totals.negative ? 'var(--danger)' : 'var(--text)') + '">' + d.totals.negative + '</div><div class="stat-label">Negative</div></div>';
    var cnt = document.getElementById('invt-count');
    if (cnt) cnt.innerHTML = '<strong>' + d.rows.length + '</strong> line' + (d.rows.length === 1 ? '' : 's') + (d.capped ? ' (showing the first 2000, narrow the filters)' : '');
    if (!d.rows.length) {
      wrap.innerHTML = '<div class="empty-state"><h3>Nothing counted yet</h3>' +
        '<p style="max-width:520px;margin:0 auto 18px">Stock fills in as techs add what is on their vans and you add what is on the shelf. ' +
        'Nobody has to stop for a counting weekend.</p>' +
        (_invt.cfg && _invt.cfg.can_add ? '<button class="btn btn-primary" onclick="invtAddModal(null)">Add Stock</button>' : '') + '</div>';
      return;
    }
    wrap.innerHTML = invtStockTable(d.rows, true, true);
  } catch (err) {
    wrap.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

// One table for both the company-wide list and a single location.
function invtStockTable(rows, showLocation, manage) {
  return '<div class="table-wrap"><table><thead><tr><th>Part</th><th>Cat</th>' + (showLocation ? '<th>Location</th>' : '') +
    '<th class="text-right">On hand</th><th class="text-right">Min</th><th class="text-right">Avg cost</th><th class="text-right">Value</th><th>Status</th><th></th></tr></thead><tbody>' +
    rows.map(function (r, i) {
      return '<tr><td>' + invtPartLabel(r) + '</td><td>' + invtCatTag(r.category) + '</td>' +
        (showLocation ? '<td style="white-space:nowrap"><a href="#" style="color:var(--primary);text-decoration:none" onclick="navigate(&#39;inventory-location&#39;,' + r.location_id + ');return false">' + escHtml(r.location_name) + '</a></td>' : '') +
        '<td class="text-right mono" style="font-weight:700;color:' + (r.qty_on_hand < 0 ? 'var(--danger)' : 'var(--text)') + '">' + r.qty_on_hand + '</td>' +
        '<td class="text-right mono" style="color:var(--text-muted-color)">' + (r.min_qty || '&mdash;') + '</td>' +
        '<td class="text-right mono">' + (r.avg_cost !== null && r.avg_cost !== undefined ? invtMoney(r.avg_cost) : '<span style="color:var(--text-muted-color)" title="No cost yet, valued at catalog cost">' + invtMoney(r.catalog_cost) + '</span>') + '</td>' +
        '<td class="text-right mono">' + invtMoney(r.value) + '</td>' +
        '<td>' + invtStatusChip(r.stock_status) + '</td>' +
        '<td style="white-space:nowrap">' +
          (manage ? '<button class="btn btn-ghost btn-sm" onclick="invtAdjustModal(' + i + ')">Adjust</button><button class="btn btn-ghost btn-sm" onclick="invtMinModal(' + i + ')">Min</button>' : '') +
          '<button class="btn btn-ghost btn-sm" onclick="invtLedgerModal(' + i + ')">Ledger</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

// ---------------------------------------------------------------------------
// By Location
// ---------------------------------------------------------------------------
async function renderInventoryLocations(el) {
  try {
    var rows = await api('GET', '/inventory/locations');
    _invt.locations = rows;
    var byCity = {};
    rows.forEach(function (l) { (byCity[l.city_code] = byCity[l.city_code] || []).push(l); });
    var cities = Object.keys(byCity).sort();
    el.innerHTML =
      '<div class="page-header"><div><div class="page-title">Inventory by Location</div>' +
      '<div class="page-subtitle">One shelf per city and one van per tech. Nova creates them on its own; vans follow the person, not the truck.</div></div>' +
      '<div class="row-actions"><button class="btn btn-secondary btn-sm" onclick="navigate(&#39;inventory&#39;)">All stock</button></div></div>' +
      (cities.length ? cities.map(function (c) {
        return '<div style="margin:18px 0 10px;font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--text-muted-color)">' + escHtml(c) + '</div>' +
          '<div class="asset-roster">' + byCity[c].map(function (l) {
            var warn = l.negative > 0 || l.low > 0;
            return '<div class="asset-rcard' + (warn ? ' warn' : '') + '">' +
              '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
                '<div class="avatar" style="font-size:12px">' + (l.kind === 'shelf' ? 'SH' : escHtml((l.user_name || '?').split(' ').map(function (w) { return w[0] || ''; }).join('').slice(0, 2).toUpperCase())) + '</div>' +
                '<div style="min-width:0"><div style="font-size:15px;font-weight:600;color:var(--text)">' + escHtml(l.name) + '</div>' +
                '<div style="font-size:12px;color:var(--text-muted-color)">' + (l.kind === 'shelf' ? 'City shelf' : 'Tech van' + (l.user_active === false ? ' &bull; inactive user' : '')) +
                  (l.last_move_at ? ' &bull; last move ' + escHtml(timeAgo(l.last_move_at)) : ' &bull; nothing yet') + '</div></div>' +
              '</div>' +
              '<div style="display:flex;gap:18px;margin-bottom:12px">' +
                '<div><div class="mono" style="font-size:18px;font-weight:700;color:var(--text)">' + invtMoney(l.value) + '</div><div class="asset-rlabel">Value</div></div>' +
                '<div><div class="mono" style="font-size:18px;font-weight:700;color:var(--text)">' + l.units + '</div><div class="asset-rlabel">Units</div></div>' +
                '<div><div class="mono" style="font-size:18px;font-weight:700;color:' + (l.low ? 'var(--warning)' : 'var(--text)') + '">' + l.low + '</div><div class="asset-rlabel">Low</div></div>' +
                '<div><div class="mono" style="font-size:18px;font-weight:700;color:' + (l.negative ? 'var(--danger)' : 'var(--text)') + '">' + l.negative + '</div><div class="asset-rlabel">Negative</div></div>' +
              '</div>' +
              '<div class="row-actions"><button class="btn btn-secondary btn-sm" style="flex:1;justify-content:center" onclick="navigate(&#39;inventory-location&#39;,' + l.id + ')">View stock</button></div>' +
            '</div>';
          }).join('') + '</div>';
      }).join('') : '<div class="empty-state"><h3>No locations in your cities</h3><p>Shelves appear for every active city you are assigned to, and vans for every tech with a home city there.</p></div>');
  } catch (err) {
    el.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

// ---------------------------------------------------------------------------
// One location (shelf or van). My Van is the same screen pointed at your own.
// ---------------------------------------------------------------------------
async function renderMyVan(el) {
  try {
    _invt.cfg = null;
    var cfg = await invtConfig();
    if (!cfg.my_van) {
      el.innerHTML = '<div class="page-header"><div><div class="page-title">My Van</div></div></div>' +
        '<div class="empty-state"><h3>No van on file</h3><p style="max-width:480px;margin:0 auto">Nova sets up your van automatically once you have a home city. Ask your manager to set it on your user account.</p></div>';
      return;
    }
    await renderInventoryLocation(el, cfg.my_van.id, true);
  } catch (err) {
    el.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

async function renderInventoryLocation(el, id, mine) {
  try {
    var d = await api('GET', '/inventory/locations/' + parseInt(id, 10));
    _invt.loc = d;
    _invt.stock = d.stock;
    var l = d.location;
    var own = l.kind === 'van' && l.user_id === state.user.id;
    var canAddHere = d.can_add && (own || d.can_manage);
    el.innerHTML =
      '<div class="page-header">' +
        '<div><div class="page-title">' + escHtml(mine ? 'My Van' : l.name) + '</div><div class="page-subtitle">' +
          (l.kind === 'shelf' ? 'City shelf' : 'Van') + ' &bull; ' + escHtml(l.city_code) +
          (own ? ' &bull; You can add what you are carrying. Only a manager can lower a count.' : '') + '</div></div>' +
        '<div class="row-actions">' +
          (mine ? '' : '<button class="btn btn-secondary btn-sm" onclick="navigate(&#39;inventory-locations&#39;)">&larr; Back</button>') +
          (d.can_manage ? '<button class="btn btn-secondary btn-sm" onclick="invtTransferModal(' + l.id + ')">' + NAVI.swap + ' Transfer</button>' : '') +
          (canAddHere ? '<button class="btn btn-primary btn-sm" onclick="invtAddModal(' + l.id + ')">' + icons.plus + ' Add Stock</button>' : '') +
        '</div>' +
      '</div>' +
      '<div class="stats-grid">' +
        '<div class="stat-card"><div class="stat-value">' + invtMoney(d.totals.value) + '</div><div class="stat-label">Value on hand</div></div>' +
        '<div class="stat-card"><div class="stat-value">' + d.totals.units + '</div><div class="stat-label">Units</div></div>' +
        '<div class="stat-card"><div class="stat-value" style="color:' + (d.totals.low ? 'var(--warning)' : 'var(--text)') + '">' + d.totals.low + '</div><div class="stat-label">Low or out</div></div>' +
        '<div class="stat-card"><div class="stat-value" style="color:' + (d.totals.negative ? 'var(--danger)' : 'var(--text)') + '">' + d.totals.negative + '</div><div class="stat-label">Negative</div></div>' +
      '</div>' +
      '<div class="card mb-4"><div class="card-header"><span class="card-title">On hand</span></div>' +
        (d.stock.length ? invtStockTable(d.stock, false, d.can_manage)
          : '<div class="empty-state"><h3>Nothing here yet</h3><p>' + (canAddHere ? 'Use Add Stock to enter what is ' + (l.kind === 'van' ? 'on the truck' : 'on the shelf') + ', part by part.' : 'Nothing has been added to this location.') + '</p></div>') +
      '</div>' +
      '<div class="card"><div class="card-header"><span class="card-title">Recent activity</span><span class="text-muted">Every change, permanent, with a name on it</span></div>' +
        (d.moves.length ? invtMovesTable(d.moves, true) : '<div class="empty-state"><p>No activity yet.</p></div>') +
      '</div>';
  } catch (err) {
    el.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>';
  }
}

function invtMovesTable(moves, showPart) {
  return '<div class="table-wrap"><table><thead><tr><th>When</th>' + (showPart ? '<th>Part</th>' : '') + '<th>What</th><th class="text-right">Change</th><th class="text-right">After</th><th class="text-right">Unit cost</th><th>By</th><th>Note</th></tr></thead><tbody>' +
    moves.map(function (m) {
      return '<tr><td style="white-space:nowrap">' + formatDateTime(m.created_at) + '</td>' +
        (showPart ? '<td>' + invtPartLabel(m) + '</td>' : '') +
        '<td>' + invtReason(m.reason) + '</td>' +
        '<td class="text-right mono" style="font-weight:700;color:' + (m.delta < 0 ? 'var(--danger)' : 'var(--success)') + '">' + (m.delta > 0 ? '+' : '') + m.delta + '</td>' +
        '<td class="text-right mono">' + m.qty_after + '</td>' +
        '<td class="text-right mono">' + (m.unit_cost !== null && m.unit_cost !== undefined ? invtMoney(m.unit_cost) : '&mdash;') + '</td>' +
        '<td style="white-space:nowrap">' + escHtml(m.user_name || '') + '</td>' +
        '<td style="color:var(--text-dim);font-size:12px">' + escHtml(m.note || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
}

// ---------------------------------------------------------------------------
// Add stock (the only write a technician has). Autosaves per CLAUDE.md 9.
// ---------------------------------------------------------------------------
function invtAddDraftKey(locId) { return 'inv-add:' + (locId || 'pick') + ':' + (state.user ? state.user.id : 0); }
var _invtAddSaveTimer = null;
function invtAddSaveDraft() {
  clearTimeout(_invtAddSaveTimer);
  _invtAddSaveTimer = setTimeout(function () {
    if (typeof novaDraftPut !== 'function') return;
    var key = invtAddDraftKey(_invt.addLoc);
    if (!_invt.addLines.length) { novaDraftDel(key); return; }
    var noteEl = document.getElementById('invt-add-note');
    novaDraftPut(key, { lines: _invt.addLines, note: noteEl ? noteEl.value : '', saved_at: Date.now() });
    var s = document.getElementById('invt-add-saved'); if (s) s.textContent = 'Saved';
  }, 400);
}

async function invtAddModal(locId) {
  var cfg = await invtConfig();
  _invt.addLoc = locId || null;
  _invt.addLines = [];
  var locs = [];
  if (!locId) {
    try { locs = await api('GET', '/inventory/locations'); } catch (e) { locs = []; }
    if (!locs.length) { showToast('There is nowhere you can add stock yet.', 'error'); return; }
    _invt.addLoc = locs[0].id;
  }
  var body =
    '<div id="invt-add-err"></div>' +
    (locId ? '' : '<div class="form-group"><label>Where is it? *</label><select id="invt-add-loc" onchange="invtAddLocChanged()">' +
      locs.map(function (l) { return '<option value="' + l.id + '">' + escHtml(l.city_code + ' - ' + l.name) + '</option>'; }).join('') + '</select></div>') +
    '<div class="form-group"><label>Find a part</label>' +
      '<input type="text" id="invt-add-q" placeholder="Item number or description" oninput="invtAddSearchSoon()" autocomplete="off" />' +
      '<div id="invt-add-results" style="max-height:200px;overflow:auto;margin-top:6px"></div></div>' +
    '<div id="invt-add-lines"></div>' +
    '<div class="form-group" style="margin-bottom:0"><label>Note <span style="font-weight:400;font-size:0.8em;color:var(--text-muted-color)">optional, e.g. where it came from</span></label>' +
      '<input type="text" id="invt-add-note" maxlength="300" oninput="invtAddSaveDraft()" placeholder="e.g. opening count, counter buy at Southern Lock" /></div>' +
    '<div style="font-size:12px;color:var(--text-muted-color);margin-top:10px">' +
      (cfg.can_manage ? 'Leave cost blank to use the running average (or the catalog cost for a first receipt). Type the price actually paid for a counter buy.'
        : 'This only ever adds. If something is wrong, tell your manager and they will correct it.') +
      ' <span id="invt-add-saved" style="margin-left:6px;color:var(--success)"></span></div>';
  invtModal('invt-add-modal', 'Add Stock', body,
    '<button class="btn btn-secondary" onclick="invtClose(this)">Cancel</button>' +
    '<button class="btn btn-primary" id="invt-add-go" onclick="invtAddSubmit(this)">Add to stock</button>');
  invtAddRenderLines();
  invtAddRestore();
}
function invtAddLocChanged() {
  var e = document.getElementById('invt-add-loc');
  _invt.addLoc = e ? parseInt(e.value, 10) : _invt.addLoc;
}
async function invtAddRestore() {
  if (typeof novaDraftGet !== 'function') return;
  var dr = await novaDraftGet(invtAddDraftKey(_invt.addLoc));
  if (!dr || !dr.lines || !dr.lines.length) return;
  var box = document.getElementById('invt-add-lines');
  if (!box) return;
  var bar = document.createElement('div');
  bar.className = 'alert alert-info';
  bar.style.marginBottom = '10px';
  bar.innerHTML = 'You have an unsent list of ' + dr.lines.length + ' part' + (dr.lines.length === 1 ? '' : 's') + '. ' +
    '<button class="btn btn-secondary btn-sm" id="invt-add-restore">Restore draft</button>';
  box.parentNode.insertBefore(bar, box);
  document.getElementById('invt-add-restore').onclick = function () {
    _invt.addLines = dr.lines;
    var n = document.getElementById('invt-add-note'); if (n && dr.note) n.value = dr.note;
    bar.remove();
    invtAddRenderLines();
  };
}
var _invtAddSearchTimer = null;
var _invtAddResults = [];
function invtAddSearchSoon() { clearTimeout(_invtAddSearchTimer); _invtAddSearchTimer = setTimeout(invtAddSearch, 250); }
async function invtAddSearch() {
  var q = (document.getElementById('invt-add-q') || {}).value || '';
  var box = document.getElementById('invt-add-results');
  if (!box) return;
  if (q.trim().length < 2) { box.innerHTML = ''; return; }
  try {
    _invtAddResults = await api('GET', '/inventory/parts?q=' + encodeURIComponent(q.trim()));
    box.innerHTML = _invtAddResults.length ? _invtAddResults.map(function (p, i) {
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-bottom:1px solid var(--border)">' +
        '<div style="flex:1;min-width:0">' + invtPartLabel(p) + '</div>' + invtCatTag(p.category) +
        '<button class="btn btn-secondary btn-sm" onclick="invtAddPick(' + i + ')">' + icons.plus + ' Add</button></div>';
    }).join('') : '<div style="font-size:13px;color:var(--text-muted-color);padding:6px">No tracked part matches. A part has to be on the Parts List first.</div>';
  } catch (err) { box.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>'; }
}
function invtAddPick(i) {
  var p = _invtAddResults[i]; if (!p) return;
  var have = _invt.addLines.filter(function (l) { return l.part_id === p.id; })[0];
  if (have) have.qty = (parseInt(have.qty, 10) || 0) + 1;
  else _invt.addLines.push({ part_id: p.id, description: p.description, item_number: p.item_number, qty: 1, unit_cost: '' });
  invtAddRenderLines();
  invtAddSaveDraft();
  var q = document.getElementById('invt-add-q'); if (q) { q.value = ''; q.focus(); }
  var box = document.getElementById('invt-add-results'); if (box) box.innerHTML = '';
}
function invtAddRenderLines() {
  var box = document.getElementById('invt-add-lines');
  if (!box) return;
  var manage = _invt.cfg && _invt.cfg.can_manage;
  if (!_invt.addLines.length) { box.innerHTML = '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:12px">No parts on the list yet.</div>'; return; }
  box.innerHTML = '<div class="table-wrap" style="margin-bottom:12px"><table><thead><tr><th>Part</th><th style="width:90px">Qty</th>' + (manage ? '<th style="width:110px">Unit cost</th>' : '') + '<th></th></tr></thead><tbody>' +
    _invt.addLines.map(function (l, i) {
      return '<tr><td>' + invtPartLabel(l) + '</td>' +
        '<td><input type="number" min="1" step="1" value="' + escHtml(String(l.qty)) + '" oninput="invtAddSet(' + i + ',&#39;qty&#39;,this.value)" style="width:80px" /></td>' +
        (manage ? '<td><input type="number" min="0" step="0.01" value="' + escHtml(String(l.unit_cost || '')) + '" placeholder="avg" oninput="invtAddSet(' + i + ',&#39;unit_cost&#39;,this.value)" style="width:100px" /></td>' : '') +
        '<td><button class="btn btn-ghost btn-sm" onclick="invtAddRemove(' + i + ')">&#10005;</button></td></tr>';
    }).join('') + '</tbody></table></div>';
}
function invtAddSet(i, k, v) { if (_invt.addLines[i]) { _invt.addLines[i][k] = v; invtAddSaveDraft(); } }
function invtAddRemove(i) { _invt.addLines.splice(i, 1); invtAddRenderLines(); invtAddSaveDraft(); }
async function invtAddSubmit(btn) {
  var err = document.getElementById('invt-add-err');
  if (!_invt.addLines.length) { if (err) err.innerHTML = '<div class="alert alert-error">Add at least one part.</div>'; return; }
  for (var i = 0; i < _invt.addLines.length; i++) {
    if (!/^\d+$/.test(String(_invt.addLines[i].qty).trim()) || parseInt(_invt.addLines[i].qty, 10) < 1) {
      if (err) err.innerHTML = '<div class="alert alert-error">Every quantity has to be a whole number of 1 or more. Stock can only be added here.</div>';
      return;
    }
  }
  btn.disabled = true; btn.textContent = 'Adding...';
  var key = invtAddDraftKey(_invt.addLoc);
  try {
    await api('POST', '/inventory/add', {
      location_id: _invt.addLoc,
      note: (document.getElementById('invt-add-note') || {}).value || '',
      lines: _invt.addLines.map(function (l) { return { part_id: l.part_id, qty: l.qty, unit_cost: l.unit_cost === '' ? null : l.unit_cost }; })
    });
    if (typeof novaDraftDel === 'function') novaDraftDel(key);
    var n = _invt.addLines.length;
    _invt.addLines = [];
    invtClose(btn);
    showToast('Added ' + n + ' part' + (n === 1 ? '' : 's') + ' to stock', 'success');
    render();
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Add to stock';
    if (err) err.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>';
  }
}

// ---------------------------------------------------------------------------
// Adjust / min / ledger (manager). Row index into _invt.stock.
// ---------------------------------------------------------------------------
function invtAdjustModal(i) {
  var r = _invt.stock[i]; if (!r) return;
  _invt.adjRow = r;
  invtModal('invt-adj-modal', 'Adjust count',
    '<div id="invt-adj-err"></div>' +
    '<div style="margin-bottom:14px">' + invtPartLabel(r) + '<div style="font-size:13px;color:var(--text-dim);margin-top:4px">' + escHtml(r.location_name) + ' &bull; currently <strong class="mono">' + r.qty_on_hand + '</strong></div></div>' +
    '<div class="form-group"><label>Correct count *</label><input type="number" step="1" id="invt-adj-to" value="' + r.qty_on_hand + '" /></div>' +
    '<div class="form-group" style="margin-bottom:0"><label>Why? *</label><input type="text" id="invt-adj-note" maxlength="300" placeholder="e.g. counted the van with Russ, 2 short" />' +
    '<div class="po-src" style="font-style:normal">Every adjustment is permanent and carries your name.</div></div>',
    '<button class="btn btn-secondary" onclick="invtClose(this)">Cancel</button><button class="btn btn-primary" onclick="invtAdjustSubmit(this)">Save adjustment</button>');
}
async function invtAdjustSubmit(btn) {
  var r = _invt.adjRow; if (!r) return;
  var err = document.getElementById('invt-adj-err');
  btn.disabled = true;
  try {
    await api('POST', '/inventory/adjust', {
      location_id: r.location_id, part_id: r.part_id, expected_qty: r.qty_on_hand,
      set_to: (document.getElementById('invt-adj-to') || {}).value,
      note: (document.getElementById('invt-adj-note') || {}).value || ''
    });
    invtClose(btn);
    showToast('Adjusted', 'success');
    render();
  } catch (e) {
    btn.disabled = false;
    if (err) err.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>';
  }
}
function invtMinModal(i) {
  var r = _invt.stock[i]; if (!r) return;
  _invt.adjRow = r;
  invtModal('invt-min-modal', 'Minimum on hand',
    '<div id="invt-min-err"></div><div style="margin-bottom:14px">' + invtPartLabel(r) + '<div style="font-size:13px;color:var(--text-dim);margin-top:4px">' + escHtml(r.location_name) + '</div></div>' +
    '<div class="form-group" style="margin-bottom:0"><label>Flag it Low below</label><input type="number" min="0" step="1" id="invt-min-v" value="' + (r.min_qty || 0) + '" />' +
    '<div class="po-src" style="font-style:normal">0 turns the Low flag off for this part here.</div></div>',
    '<button class="btn btn-secondary" onclick="invtClose(this)">Cancel</button><button class="btn btn-primary" onclick="invtMinSubmit(this)">Save</button>');
}
async function invtMinSubmit(btn) {
  var r = _invt.adjRow; if (!r) return;
  btn.disabled = true;
  try {
    await api('PUT', '/inventory/min', { location_id: r.location_id, part_id: r.part_id, min_qty: (document.getElementById('invt-min-v') || {}).value });
    invtClose(btn);
    render();
  } catch (e) {
    btn.disabled = false;
    var err = document.getElementById('invt-min-err'); if (err) err.innerHTML = '<div class="alert alert-error">' + escHtml(e.message) + '</div>';
  }
}
async function invtLedgerModal(i) {
  var r = _invt.stock[i]; if (!r) return;
  try {
    var moves = await api('GET', '/inventory/locations/' + r.location_id + '/moves?part_id=' + r.part_id);
    invtModal('invt-ledger-modal', 'Ledger', '<div style="margin-bottom:12px">' + invtPartLabel(r) + '<div style="font-size:13px;color:var(--text-dim);margin-top:4px">' + escHtml(r.location_name) + '</div></div>' +
      (moves.length ? invtMovesTable(moves, false) : '<p class="text-muted">No moves yet.</p>'),
      '<button class="btn btn-secondary" onclick="invtClose(this)">Close</button>');
    var m = document.querySelector('#invt-ledger-modal .modal'); if (m) m.style.maxWidth = '860px';
  } catch (e) { showToast(e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// Transfer: pick a source, type how many of each to move.
// ---------------------------------------------------------------------------
async function invtTransferModal(fromId) {
  try {
    var locs = await api('GET', '/inventory/locations');
    if (locs.length < 2) { showToast('You need at least two locations to transfer between.', 'error'); return; }
    _invt.xfer = { locs: locs, from: fromId || locs[0].id, stock: [] };
    var opts = function (sel) {
      return locs.map(function (l) { return '<option value="' + l.id + '"' + (l.id === sel ? ' selected' : '') + '>' + escHtml(l.city_code + ' - ' + l.name) + '</option>'; }).join('');
    };
    var to = locs.filter(function (l) { return l.id !== _invt.xfer.from; })[0];
    invtModal('invt-xfer-modal', 'Transfer stock',
      '<div id="invt-xfer-err"></div>' +
      '<div class="form-row">' +
        '<div class="form-group"><label>From *</label><select id="invt-xfer-from" onchange="invtXferFromChanged()">' + opts(_invt.xfer.from) + '</select></div>' +
        '<div class="form-group"><label>To *</label><select id="invt-xfer-to">' + opts(to ? to.id : null) + '</select></div>' +
      '</div>' +
      '<div id="invt-xfer-lines"><div class="loading">Loading&hellip;</div></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>Note</label><input type="text" id="invt-xfer-note" maxlength="300" placeholder="e.g. weekly restock for Steven" /></div>',
      '<button class="btn btn-secondary" onclick="invtClose(this)">Cancel</button><button class="btn btn-primary" onclick="invtXferSubmit(this)">Move it</button>');
    var m = document.querySelector('#invt-xfer-modal .modal'); if (m) m.style.maxWidth = '720px';
    await invtXferLoad();
  } catch (e) { showToast(e.message, 'error'); }
}
async function invtXferFromChanged() {
  var e = document.getElementById('invt-xfer-from');
  _invt.xfer.from = parseInt(e.value, 10);
  await invtXferLoad();
}
async function invtXferLoad() {
  var box = document.getElementById('invt-xfer-lines');
  if (!box) return;
  try {
    var d = await api('GET', '/inventory/locations/' + _invt.xfer.from);
    _invt.xfer.stock = d.stock.filter(function (r) { return r.qty_on_hand > 0; });
    box.innerHTML = _invt.xfer.stock.length
      ? '<div class="table-wrap" style="max-height:320px;overflow:auto;margin-bottom:12px"><table><thead><tr><th>Part</th><th class="text-right">Has</th><th style="width:100px">Move</th></tr></thead><tbody>' +
        _invt.xfer.stock.map(function (r, i) {
          return '<tr><td>' + invtPartLabel(r) + '</td><td class="text-right mono">' + r.qty_on_hand + '</td>' +
            '<td><input type="number" min="0" max="' + r.qty_on_hand + '" step="1" id="invt-xfer-q-' + i + '" placeholder="0" style="width:80px" /></td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div style="font-size:13px;color:var(--text-muted-color);margin-bottom:12px">Nothing on hand at that location to move.</div>';
  } catch (err) { box.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>'; }
}
async function invtXferSubmit(btn) {
  var err = document.getElementById('invt-xfer-err');
  var lines = [];
  for (var i = 0; i < _invt.xfer.stock.length; i++) {
    var e = document.getElementById('invt-xfer-q-' + i);
    var v = e ? String(e.value).trim() : '';
    if (!v || v === '0') continue;
    if (!/^\d+$/.test(v)) { if (err) err.innerHTML = '<div class="alert alert-error">Quantities must be whole numbers.</div>'; return; }
    lines.push({ part_id: _invt.xfer.stock[i].part_id, qty: parseInt(v, 10) });
  }
  if (!lines.length) { if (err) err.innerHTML = '<div class="alert alert-error">Type how many of at least one part to move.</div>'; return; }
  btn.disabled = true;
  try {
    var t = await api('POST', '/inventory/transfers', {
      from_location_id: _invt.xfer.from,
      to_location_id: parseInt((document.getElementById('invt-xfer-to') || {}).value, 10),
      note: (document.getElementById('invt-xfer-note') || {}).value || '',
      lines: lines
    });
    invtClose(btn);
    showToast('Transfer ' + (t.transfer_number || '') + ' done', 'success');
    render();
  } catch (e2) {
    btn.disabled = false;
    if (err) err.innerHTML = '<div class="alert alert-error">' + escHtml(e2.message) + '</div>';
  }
}

// ---------------------------------------------------------------------------
// Part settings: category and whether a part is counted at all.
// ---------------------------------------------------------------------------
async function renderInventorySettings(el) {
  el.innerHTML =
    '<div class="page-header"><div><div class="page-title">Part Settings</div>' +
    '<div class="page-subtitle">Which parts are Locksmith, Battery or Other, and which are counted. Untracked parts (shop rags, zip ties) stay off every count.</div></div>' +
    '<div class="row-actions"><button class="btn btn-secondary btn-sm" onclick="navigate(&#39;inventory&#39;)">&larr; Inventory</button></div></div>' +
    '<div class="card"><div class="card-body" style="border-bottom:1px solid var(--border)">' +
      '<div class="filter-bar">' +
        '<input type="text" id="invs-q" placeholder="Search parts..." style="flex:2;min-width:220px" oninput="invsLoadSoon()" />' +
        '<select id="invs-cat" onchange="invsLoad()"><option value="">All Categories</option><option value="locksmith">Locksmith</option><option value="battery">Battery</option><option value="other">Other</option></select>' +
      '</div>' +
      '<div class="filter-bar" style="margin-bottom:0;align-items:center">' +
        '<span style="font-size:13px;color:var(--text-muted-color)" id="invs-sel">0 selected</span>' +
        '<select id="invs-bulk-cat" style="max-width:180px"><option value="">Set category...</option><option value="locksmith">Locksmith</option><option value="battery">Battery</option><option value="other">Other</option></select>' +
        '<button class="btn btn-secondary btn-sm" onclick="invsBulk(&#39;cat&#39;)">Apply</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="invsBulk(&#39;on&#39;)">Track</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="invsBulk(&#39;off&#39;)">Stop tracking</button>' +
      '</div></div>' +
    '<div id="invs-table"><div class="loading">Loading&hellip;</div></div></div>';
  await invsLoad();
}
var _invsTimer = null;
function invsLoadSoon() { clearTimeout(_invsTimer); _invsTimer = setTimeout(invsLoad, 300); }
async function invsLoad() {
  var wrap = document.getElementById('invs-table');
  if (!wrap) return;
  var q = (document.getElementById('invs-q') || {}).value || '';
  var c = (document.getElementById('invs-cat') || {}).value || '';
  try {
    _invt.settings = await api('GET', '/inventory/part-settings?q=' + encodeURIComponent(q) + (c ? '&category=' + encodeURIComponent(c) : ''));
    wrap.innerHTML = _invt.settings.length
      ? '<div class="table-wrap"><table><thead><tr><th style="width:36px"><input type="checkbox" style="width:16px;height:16px;margin:0" onchange="invsAll(this.checked)" /></th><th>Part</th><th>Category</th><th>Tracked</th><th class="text-right">On hand</th></tr></thead><tbody>' +
        _invt.settings.map(function (p, i) {
          return '<tr><td><input type="checkbox" class="invs-cb" data-i="' + i + '" style="width:16px;height:16px;margin:0" onchange="invsCount()" /></td>' +
            '<td>' + invtPartLabel(p) + '</td>' +
            '<td><select onchange="invsSet(' + i + ',&#39;category&#39;,this.value)" style="max-width:150px">' +
              ['locksmith', 'battery', 'other'].map(function (k) { return '<option value="' + k + '"' + (p.category === k ? ' selected' : '') + '>' + k.charAt(0).toUpperCase() + k.slice(1) + '</option>'; }).join('') +
            '</select></td>' +
            '<td><input type="checkbox" style="width:16px;height:16px;margin:0"' + (p.track_inventory ? ' checked' : '') + ' onchange="invsSet(' + i + ',&#39;track&#39;,this.checked)" /></td>' +
            '<td class="text-right mono">' + p.on_hand + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty-state"><h3>No parts</h3><p>Parts come from the Parts List.</p></div>';
    invsCount();
  } catch (err) { wrap.innerHTML = '<div class="alert alert-error">' + escHtml(err.message) + '</div>'; }
}
function invsSelected() {
  var out = [];
  document.querySelectorAll('.invs-cb').forEach(function (cb) { if (cb.checked) { var p = _invt.settings[parseInt(cb.getAttribute('data-i'), 10)]; if (p) out.push(p.id); } });
  return out;
}
function invsCount() { var e = document.getElementById('invs-sel'); if (e) e.textContent = invsSelected().length + ' selected'; }
function invsAll(on) { document.querySelectorAll('.invs-cb').forEach(function (cb) { cb.checked = on; }); invsCount(); }
async function invsSet(i, k, v) {
  var p = _invt.settings[i]; if (!p) return;
  var body = { ids: [p.id] };
  if (k === 'category') body.category = v; else body.track_inventory = !!v;
  try { await api('POST', '/inventory/part-settings', body); showToast('Saved', 'success'); }
  catch (e) { showToast(e.message, 'error'); invsLoad(); }
}
async function invsBulk(what) {
  var ids = invsSelected();
  if (!ids.length) { showToast('Tick some parts first', 'error'); return; }
  var body = { ids: ids };
  if (what === 'cat') {
    var c = (document.getElementById('invs-bulk-cat') || {}).value;
    if (!c) { showToast('Pick a category', 'error'); return; }
    body.category = c;
  } else body.track_inventory = what === 'on';
  try { var r = await api('POST', '/inventory/part-settings', body); showToast('Updated ' + r.updated, 'success'); invsLoad(); }
  catch (e) { showToast(e.message, 'error'); }
}
