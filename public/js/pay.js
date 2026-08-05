/* Nova - Tech Pay
 * ---------------------------------------------------------------------------
 * A GRADE is a saved pay table. Same grade names company-wide, a separate set
 * of rows per city - so a tech who transfers keeps their grade instead of
 * needing a new one invented for them.
 *
 * Two rules this screen exists to protect:
 *   1. Pay is frozen on the call at close-out. Nothing edited here can restate
 *      a call already paid.
 *   2. A call that matches no row pays $0 AND raises a flag. Silence is
 *      indistinguishable from a rate somebody meant to set at zero.
 * --------------------------------------------------------------------------- */

var _payTab = 'tables';
var _payRef = null;
var _payGrade = null;
var _payCity = null;
var _payRows = [];
var _payPeople = [];
var _payTarget = null;     // {grade_id} or {user_id, name} - whose table is open
var _payReport = null;
var _payFrom = null;
var _payTo = null;
// A tech holding only view_own_pay gets the report and nothing else. The server
// enforces the same thing; this just stops the screen offering tabs that would
// come back 403.
var _payOwnOnly = false;

function payInjectStyles() {
  if (document.getElementById('pay-styles')) return;
  var css =
    '.pay-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:16px}' +
    '.pay-tab{padding:9px 16px;font-size:13.5px;font-weight:600;cursor:pointer;border-bottom:2px solid transparent;' +
      'color:var(--text-muted-color)}' +
    '.pay-tab.on{color:var(--primary);border-bottom-color:var(--primary)}' +
    '.pay-row{display:grid;grid-template-columns:1fr 110px 150px 1fr auto;gap:12px;align-items:center;' +
      'padding:11px 14px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;' +
      'background:var(--bg-card)}' +
    '.pay-row.ovr{border-left:3px solid #f59e0b}' +
    '.pay-row.mult{border-left:3px solid #a855f7}' +
    '.pay-title{font-weight:700;font-size:14px}' +
    '.pay-amt{font-size:16px;font-weight:800;font-variant-numeric:tabular-nums;text-align:right}' +
    '.pay-type{font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;' +
      'color:var(--text-muted-color)}' +
    '.pay-scope{font-size:12px;color:var(--text-muted-color);line-height:1.5}' +
    '.pay-note{font-size:12px;color:var(--text-muted-color);line-height:1.65}' +
    '.pay-tot{display:grid;grid-template-columns:1fr auto;gap:6px 20px;font-size:14px;' +
      'font-variant-numeric:tabular-nums}' +
    '.pay-tot .lbl{color:var(--text-muted-color)}' +
    '.pay-tot .val{text-align:right;font-weight:700}' +
    '.pay-tot .grand{border-top:1px solid var(--border);padding-top:8px;margin-top:4px;font-size:17px;font-weight:800}' +
    '.pay-flag{color:#f87171;font-weight:700}' +
    '.pay-chip{display:inline-block;background:var(--bg-elevated);border:1px solid var(--border);' +
      'border-radius:5px;padding:2px 8px;font-size:11.5px;margin-right:5px}' +
    '.pay-warn{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.35);' +
      'border-radius:var(--radius);padding:11px 14px;font-size:13px;line-height:1.6;margin-bottom:14px}';
  var st = document.createElement('style');
  st.id = 'pay-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

// Own modal rather than borrowing dispatch's, and the OK handler is WRAPPED -
// assigning a function straight to onclick hands it the click Event as its
// first argument, which is exactly how a create once turned into an update of
// job NaN.
function payModal(title, bodyHtml, okLabel, onOk) {
  payCloseModal();
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'pay-modal';
  overlay.innerHTML =
    '<div class="modal" style="max-width:640px">' +
      '<div class="modal-header"><span class="modal-title">' + escHtml(title) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="payCloseModal()">&#x2715;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-secondary" onclick="payCloseModal()">Cancel</button>' +
        '<button class="btn btn-primary" id="pay-modal-ok">' + escHtml(okLabel) + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  var ok = document.getElementById('pay-modal-ok');
  if (ok) ok.onclick = function () { onOk(); };
}
function payCloseModal() {
  var m = document.getElementById('pay-modal');
  if (m) m.parentNode.removeChild(m);
}

function payVal(id) { var e = document.getElementById(id); return e ? e.value : ''; }
function payChecked(id) { var e = document.getElementById(id); return !!(e && e.checked); }
function payMoney(n) {
  var v = Number(n || 0);
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function payTypeInfo(key) {
  return ((_payRef && _payRef.labor_types) || []).filter(function (t) { return t.key === key; })[0] ||
    { key: key, label: key, unit: '$' };
}
function payIsMultiplier(key) { return key === 'holiday_additional' || key === 'out_of_area'; }

// ---------------------------------------------------------------------------
async function renderPay(content) {
  payInjectStyles();
  content.innerHTML = '<div class="page-header"><div><div class="page-title">Tech Pay</div>' +
    '<div class="page-subtitle">Loading...</div></div></div>';
  try { _payRef = await api('GET', '/pay/reference'); _payOwnOnly = false; }
  catch (e) {
    // 403 here means view_own_pay and nothing more. That is a valid state, not
    // an error - show them their own report.
    if (/403|forbidden|access/i.test(e.message || '')) { _payOwnOnly = true; _payRef = { grades: [], cities: [], services: [], labor_types: [], arrangements: [] }; }
    else {
      content.innerHTML = '<div class="card"><div class="card-body">Could not load. ' + escHtml(e.message || '') + '</div></div>';
      return;
    }
  }
  if (_payOwnOnly) _payTab = 'report';
  if (!_payCity) _payCity = (((_payRef.cities || [])[0] || {}).code || '').trim();
  if (!_payGrade && (_payRef.grades || []).length) _payGrade = _payRef.grades[0].id;
  if (!_payTarget) _payTarget = { grade_id: _payGrade };

  content.innerHTML =
    '<div class="page-header"><div><div class="page-title">' + (_payOwnOnly ? 'My Pay' : 'Tech Pay') + '</div>' +
      '<div class="page-subtitle">' +
      (_payOwnOnly ? 'What your closed calls paid, and which row paid them.' : 'What a call pays, and how it splits.') +
      '</div></div></div>' +
    (_payOwnOnly ? '' :
      '<div class="pay-tabs">' +
        '<div class="pay-tab' + (_payTab === 'tables' ? ' on' : '') + '" onclick="payGo(\'tables\')">Pay tables</div>' +
        '<div class="pay-tab' + (_payTab === 'people' ? ' on' : '') + '" onclick="payGo(\'people\')">People</div>' +
        '<div class="pay-tab' + (_payTab === 'report' ? ' on' : '') + '" onclick="payGo(\'report\')">Pay report</div>' +
      '</div>') +
    '<div id="pay-body"></div>';
  await payRender();
}

function payGo(t) { _payTab = t; renderPay(document.getElementById('content') || document.querySelector('.content')); }

async function payRender() {
  if (_payTab === 'people') return payLoadPeople();
  if (_payTab === 'report') return payRenderReport();
  return payLoadRows();
}

// ---------------------------------------------------------------------------
//  Pay tables
// ---------------------------------------------------------------------------
async function payLoadRows() {
  var body = document.getElementById('pay-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var qs = (_payTarget.user_id ? 'user_id=' + _payTarget.user_id : 'grade_id=' + _payTarget.grade_id) +
    '&city=' + encodeURIComponent(_payCity);
  var data;
  try { data = await api('GET', '/pay/rows?' + qs); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _payRows = data.rows || [];

  var base = _payRows.filter(function (r) { return !payIsMultiplier(r.labor_type); });
  var mult = _payRows.filter(function (r) { return payIsMultiplier(r.labor_type); });

  function rowHtml(r) {
    var info = payTypeInfo(r.labor_type);
    var scope = [];
    if (r.service_type_ids && r.service_type_ids.length) {
      scope.push(r.service_type_ids.map(function (id) {
        var s = (_payRef.services || []).filter(function (x) { return x.id === id; })[0];
        return s ? s.code : '#' + id;
      }).join(', '));
    } else scope.push('All services');
    if (r.account_id) scope.push(r.account_name || 'One account');
    else if (r.applies_public && r.applies_accounts) scope.push('Public + accounts');
    else if (r.applies_accounts) scope.push('Accounts only');
    else scope.push('Public only');
    scope.push(r.code_ids && r.code_ids.length ? 'TC ' + r.code_ids.join(', ') : 'All TCs');
    if (r.edu_only) scope.push('EDU only');
    return '<div class="pay-row' + (r.user_id ? ' ovr' : '') + (payIsMultiplier(r.labor_type) ? ' mult' : '') + '">' +
      '<div><div class="pay-title">' + escHtml(r.title) + '</div>' +
        (r.note ? '<div class="pay-scope">' + escHtml(r.note) + '</div>' : '') + '</div>' +
      '<div class="pay-amt">' + (info.unit === '%' ? Number(r.amount) + '%' : payMoney(r.amount)) + '</div>' +
      '<div class="pay-type">' + escHtml(info.label) + '</div>' +
      '<div class="pay-scope">' + escHtml(scope.join(' &middot; ')).replace(/&amp;middot;/g, '&middot;') + '</div>' +
      '<div class="flex-gap">' +
        '<button class="btn btn-secondary btn-sm" onclick="payEditRow(' + r.id + ')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="payDeleteRow(' + r.id + ')">Remove</button>' +
      '</div></div>';
  }

  var gradeOpts = (_payRef.grades || []).map(function (g) {
    return '<option value="g' + g.id + '"' + (!_payTarget.user_id && _payTarget.grade_id === g.id ? ' selected' : '') +
      '>' + escHtml(g.name) + '</option>';
  }).join('');
  var overrideOpt = _payTarget.user_id
    ? '<option value="u' + _payTarget.user_id + '" selected>' + escHtml(_payTarget.name || 'Override') + ' (override)</option>'
    : '';

  body.innerHTML =
    '<div class="flex-gap" style="margin-bottom:14px;flex-wrap:wrap">' +
      '<select onchange="payPickTable(this.value)" style="width:auto">' + gradeOpts + overrideOpt + '</select>' +
      '<select onchange="payPickCity(this.value)" style="width:auto">' +
        (_payRef.cities || []).map(function (c) {
          var code = (c.code || '').trim();
          return '<option value="' + escHtml(code) + '"' + (code === _payCity ? ' selected' : '') + '>' +
            escHtml(c.name) + '</option>';
        }).join('') +
      '</select>' +
      '<button class="btn btn-primary btn-sm" onclick="payEditRow(null)">+ Row</button>' +
      '<button class="btn btn-secondary btn-sm" onclick="payImport()">Import a table</button>' +
    '</div>' +
    (_payRows.length ? '' :
      '<div class="pay-warn"><b>This table is empty.</b> Every call closed by somebody on it will pay ' +
      '$0 and raise a flag on the pay report. Nothing is seeded on purpose - a seeded rate is a wrong ' +
      'number on somebody\'s paycheck.</div>') +
    '<div class="mk-cols" style="display:grid;grid-template-columns:1fr 320px;gap:16px;align-items:start"><div>' +
      (base.length ? base.map(rowHtml).join('') : '') +
      (mult.length
        ? '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
          'color:var(--text-muted-color);margin:18px 0 8px">Applied on top</div>' + mult.map(rowHtml).join('')
        : '') +
    '</div><div>' +
      '<div class="card"><div class="card-body"><div class="pay-note">' +
        '<b>Most specific wins.</b> A named service beats a list beats All services. One named account ' +
        'beats all accounts beats public-only. One time code beats All TCs. An EDU row beats everything.' +
        '<br><br><b>Two rows covering the same call are refused</b> when you save. That is what makes ' +
        'last month\'s numbers reproduce.' +
        '<br><br><b>Holiday and out-of-area are multipliers</b>, added on top of whichever row won. They ' +
        'never pay on their own - 100% of nothing is nothing.' +
        '<br><br><b>Pay is frozen when the call closes.</b> Editing a rate here never restates a call ' +
        'already paid.' +
      '</div></div></div>' +
    '</div></div>';
}

function payPickTable(v) {
  if (v.charAt(0) === 'u') _payTarget = { user_id: parseInt(v.slice(1), 10), name: _payTarget.name };
  else { _payGrade = parseInt(v.slice(1), 10); _payTarget = { grade_id: _payGrade }; }
  payLoadRows();
}
function payPickCity(c) { _payCity = c; payRender(); }

function payRowFormHtml(r) {
  r = r || {};
  var types = (_payRef.labor_types || []).filter(function (t) { return !t.dormant; });
  return '<div class="form-group"><label>Title</label>' +
      '<input id="pay-f-title" value="' + escHtml(r.title || '') + '" placeholder="Core call TC1">' +
      '<div class="pay-scope">This is what the tech sees on their pay report next to the call.</div></div>' +
    '<div style="display:grid;grid-template-columns:1fr 140px;gap:12px">' +
      '<div class="form-group"><label>Labor type</label><select id="pay-f-type" onchange="payTypeChanged()">' +
        types.map(function (t) {
          return '<option value="' + t.key + '"' + (r.labor_type === t.key ? ' selected' : '') + '>' +
            escHtml(t.label) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="form-group"><label id="pay-f-amtlbl">Amount</label>' +
        '<input id="pay-f-amount" value="' + (r.amount === undefined || r.amount === null ? '' : Number(r.amount)) + '"></div>' +
    '</div>' +
    '<div id="pay-f-help" class="pay-scope" style="margin:-6px 0 14px"></div>' +
    '<div class="form-group"><label>Services</label><select id="pay-f-services" multiple size="5">' +
      (_payRef.services || []).map(function (s) {
        var on = (r.service_type_ids || []).indexOf(s.id) !== -1;
        return '<option value="' + s.id + '"' + (on ? ' selected' : '') + '>' + escHtml(s.code + ' - ' + s.name) + '</option>';
      }).join('') + '</select>' +
      '<div class="pay-scope">Select none for every service.</div></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>Time codes</label>' +
        '<input id="pay-f-codes" value="' + ((r.code_ids || []).join(', ')) + '" placeholder="1, 2">' +
        '<div class="pay-scope">Blank for all.</div></div>' +
      '<div class="form-group"><label>Call source</label>' +
        '<label class="check"><input type="checkbox" id="pay-f-public"' +
          (r.applies_public === false ? '' : ' checked') + '> Public</label>' +
        '<label class="check"><input type="checkbox" id="pay-f-accounts"' +
          (r.applies_accounts === false ? '' : ' checked') + '> Accounts</label>' +
        '<label class="check"><input type="checkbox" id="pay-f-edu"' +
          (r.edu_only ? ' checked' : '') + '> EDU calls only</label></div>' +
    '</div>' +
    (_payTarget.user_id
      ? '<div class="form-group"><label>Why this person is off-grade</label>' +
        '<textarea id="pay-f-note" rows="2">' + escHtml(r.note || '') + '</textarea>' +
        '<div class="pay-scope">Required. An off-grade rate with no stated reason becomes ' +
        'unexplainable within a year, and then nobody dares change it.</div></div>'
      : '<input type="hidden" id="pay-f-note" value="">') +
    '<div id="pay-f-err" class="pay-warn" style="display:none"></div>';
}

function payTypeChanged() {
  var t = payTypeInfo(payVal('pay-f-type'));
  var lbl = document.getElementById('pay-f-amtlbl');
  var help = document.getElementById('pay-f-help');
  if (lbl) lbl.textContent = t.unit === '%' ? 'Percent' : 'Amount ($)';
  if (help) help.textContent = t.help || '';
}

function payEditRow(id) {
  var r = _payRows.filter(function (x) { return x.id === id; })[0] || null;
  payModal(r ? 'Edit pay row' : 'New pay row', payRowFormHtml(r), 'Save', function () { paySaveRow(id); });
  payTypeChanged();
}

async function paySaveRow(id) {
  var sel = document.getElementById('pay-f-services');
  var services = sel ? Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return parseInt(o.value, 10); }) : [];
  var payload = {
    id: id || null,
    grade_id: _payTarget.user_id ? null : _payTarget.grade_id,
    user_id: _payTarget.user_id || null,
    city_code: _payCity,
    title: payVal('pay-f-title'),
    labor_type: payVal('pay-f-type'),
    amount: payVal('pay-f-amount'),
    service_type_ids: services.length ? services : null,
    code_ids: payVal('pay-f-codes') || null,
    applies_public: payChecked('pay-f-public'),
    applies_accounts: payChecked('pay-f-accounts'),
    edu_only: payChecked('pay-f-edu'),
    note: payVal('pay-f-note')
  };
  var err = document.getElementById('pay-f-err');
  try {
    await api('POST', '/pay/rows', payload);
  } catch (e) {
    // The duplicate-scope refusal is the whole point of the guard, so it is
    // shown in place rather than as a toast that vanishes.
    if (err) { err.style.display = 'block'; err.innerHTML = escHtml(e.message || 'Could not save.'); }
    return;
  }
  payCloseModal();
  await payLoadRows();
}

async function payDeleteRow(id) {
  var r = _payRows.filter(function (x) { return x.id === id; })[0];
  if (!confirm('Remove "' + ((r && r.title) || 'this row') + '"?\n\nCalls already paid under it keep their figures.')) return;
  try { await api('POST', '/pay/rows/' + id + '/deactivate', {}); } catch (e) { alert(e.message); return; }
  await payLoadRows();
}

function payImport() {
  var gradeOpts = (_payRef.grades || []).map(function (g) {
    return '<option value="' + g.id + '">' + escHtml(g.name) + '</option>';
  }).join('');
  var cityOpts = (_payRef.cities || []).map(function (c) {
    var code = (c.code || '').trim();
    return '<option value="' + escHtml(code) + '">' + escHtml(c.name) + '</option>';
  }).join('');
  payModal('Import a table',
    '<div class="pay-note" style="margin-bottom:14px">Copies rows in as a starting point. Anything already ' +
      'in this table is left alone - an import that overwrote a rate somebody had tuned would be the worst ' +
      'kind of helpful.</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<div class="form-group"><label>From grade</label><select id="pay-i-grade">' + gradeOpts + '</select></div>' +
      '<div class="form-group"><label>From city</label><select id="pay-i-city">' + cityOpts + '</select></div>' +
    '</div><div id="pay-f-err" class="pay-warn" style="display:none"></div>',
    'Import', function () { payDoImport(); });
}

async function payDoImport() {
  var err = document.getElementById('pay-f-err');
  var out;
  try {
    out = await api('POST', '/pay/rows/import', {
      from_grade_id: parseInt(payVal('pay-i-grade'), 10),
      from_city: payVal('pay-i-city'),
      to_grade_id: _payTarget.user_id ? null : _payTarget.grade_id,
      to_user_id: _payTarget.user_id || null,
      to_city: _payCity
    });
  } catch (e) {
    if (err) { err.style.display = 'block'; err.innerHTML = escHtml(e.message || 'Could not import.'); }
    return;
  }
  payCloseModal();
  if (out.skipped && out.skipped.length) {
    alert('Copied ' + out.copied + ' row(s).\n\nLeft alone because this table already covers them:\n' +
      out.skipped.join('\n'));
  }
  await payLoadRows();
}

// ---------------------------------------------------------------------------
//  People
// ---------------------------------------------------------------------------
async function payLoadPeople() {
  var body = document.getElementById('pay-body');
  if (!body) return;
  body.innerHTML = '<div class="card"><div class="card-body">Loading...</div></div>';
  var data;
  try { data = await api('GET', '/pay/people'); }
  catch (e) { body.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _payPeople = data.people || [];

  body.innerHTML =
    '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>Name</th><th>City</th><th>Grade</th><th>Arrangement</th><th style="text-align:right">Vehicle</th>' +
      '<th>Override rows</th><th></th></tr></thead><tbody>' +
    _payPeople.map(function (p) {
      var arr = (_payRef.arrangements || []).filter(function (a) { return a.key === p.pay_arrangement; })[0];
      return '<tr>' +
        '<td>' + escHtml(p.name) + '</td>' +
        '<td>' + escHtml(p.home_city || '') + '</td>' +
        '<td>' + (p.grade_name ? escHtml(p.grade_name) : '<span class="pay-flag">Not set</span>') + '</td>' +
        '<td>' + escHtml((arr && arr.label) || 'Not set') + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums">' +
          (Number(p.vehicle_split_pct) ? Number(p.vehicle_split_pct) + '%' : '&mdash;') + '</td>' +
        '<td>' + (p.override_rows
          ? '<a href="#" onclick="payOpenOverrides(' + p.id + ',\'' + escHtml(p.name).replace(/'/g, '') + '\');return false">' +
            p.override_rows + '</a>'
          : '<a href="#" onclick="payOpenOverrides(' + p.id + ',\'' + escHtml(p.name).replace(/'/g, '') + '\');return false">add</a>') + '</td>' +
        '<td style="text-align:right"><button class="btn btn-secondary btn-sm" onclick="payEditPerson(' + p.id + ')">Edit</button></td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>' +
    '<div class="card" style="margin-top:16px"><div class="card-body"><div class="pay-note">' +
      '<b>The 70/30 split.</b> A tech driving their own vehicle has 30% of each call\'s pay recorded as ' +
      'vehicle reimbursement and 70% as job pay. Tips are always 100% job pay.' +
      '<br><br>The percentage is <b>stored per person</b>, not hardcoded - if it moves to 75/25 for one ' +
      'person that is a field edit here, and every call already paid keeps the split it was paid under.' +
      '<br><br><b>Check the 30% with your accountant before it reaches a paycheck.</b> Non-taxable vehicle ' +
      'money needs an accountable plan, and a flat percentage of revenue is the shape that gets ' +
      'challenged because it is not tied to miles actually driven.' +
    '</div></div></div>';
}

function payOpenOverrides(id, name) {
  _payTarget = { user_id: id, name: name };
  _payTab = 'tables';
  renderPay(document.getElementById('content') || document.querySelector('.content'));
}

function payEditPerson(id) {
  var p = _payPeople.filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  payModal('Pay setup - ' + p.name,
    '<div class="form-group"><label>Grade</label><select id="pay-p-grade">' +
      '<option value="">Not set</option>' +
      (_payRef.grades || []).map(function (g) {
        return '<option value="' + g.id + '"' + (p.pay_grade_id === g.id ? ' selected' : '') + '>' +
          escHtml(g.name) + '</option>';
      }).join('') + '</select></div>' +
    '<div class="form-group"><label>Arrangement</label><select id="pay-p-arr" onchange="payArrChanged()">' +
      (_payRef.arrangements || []).map(function (a) {
        return '<option value="' + a.key + '"' + (p.pay_arrangement === a.key ? ' selected' : '') + '>' +
          escHtml(a.label) + '</option>';
      }).join('') + '</select></div>' +
    '<div class="form-group"><label>Vehicle reimbursement %</label>' +
      '<input id="pay-p-split" value="' + Number(p.vehicle_split_pct || 0) + '">' +
      '<div class="pay-scope">30 is the standard for somebody driving their own vehicle. ' +
      'Company vehicle is 0.</div></div>' +
    '<div id="pay-f-err" class="pay-warn" style="display:none"></div>',
    'Save', function () { paySavePerson(id); });
}

function payArrChanged() {
  var a = payVal('pay-p-arr');
  var s = document.getElementById('pay-p-split');
  if (s) s.value = a === 'own_vehicle' ? 30 : 0;
}

async function paySavePerson(id) {
  var err = document.getElementById('pay-f-err');
  try {
    await api('POST', '/pay/people/' + id, {
      pay_grade_id: payVal('pay-p-grade') || null,
      pay_arrangement: payVal('pay-p-arr'),
      vehicle_split_pct: payVal('pay-p-split')
    });
  } catch (e) {
    if (err) { err.style.display = 'block'; err.innerHTML = escHtml(e.message || 'Could not save.'); }
    return;
  }
  payCloseModal();
  await payLoadPeople();
}

// ---------------------------------------------------------------------------
//  Pay report
// ---------------------------------------------------------------------------
function payDefaultRange() {
  var now = new Date();
  var first = new Date(now.getFullYear(), now.getMonth(), 1);
  function f(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  return { from: f(first), to: f(now) };
}

async function payRenderReport() {
  var body = document.getElementById('pay-body');
  if (!body) return;
  if (!_payFrom || !_payTo) { var d = payDefaultRange(); _payFrom = d.from; _payTo = d.to; }
  body.innerHTML =
    '<div class="flex-gap" style="margin-bottom:14px;flex-wrap:wrap;align-items:flex-end">' +
      '<div class="form-group" style="margin-bottom:0"><label>From</label>' +
        '<input type="date" id="pay-r-from" value="' + escHtml(_payFrom) + '"></div>' +
      '<div class="form-group" style="margin-bottom:0"><label>To</label>' +
        '<input type="date" id="pay-r-to" value="' + escHtml(_payTo) + '"></div>' +
      '<button class="btn btn-primary btn-sm" onclick="payRunReport()">Run</button>' +
    '</div><div id="pay-r-body"><div class="card"><div class="card-body">Pick a range and run it.</div></div></div>';
  await payRunReport();
}

async function payRunReport() {
  _payFrom = payVal('pay-r-from') || _payFrom;
  _payTo = payVal('pay-r-to') || _payTo;
  var out = document.getElementById('pay-r-body');
  if (!out) return;
  out.innerHTML = '<div class="card"><div class="card-body">Running...</div></div>';
  var d;
  try { d = await api('GET', '/pay/report?from=' + encodeURIComponent(_payFrom) + '&to=' + encodeURIComponent(_payTo)); }
  catch (e) { out.innerHTML = '<div class="card"><div class="card-body">' + escHtml(e.message) + '</div></div>'; return; }
  _payReport = d;

  var t = d.totals || {};
  var calls = d.calls || [];
  out.innerHTML =
    (t.unpaid
      ? '<div class="pay-warn"><b>' + t.unpaid + ' call' + (t.unpaid === 1 ? '' : 's') +
        ' matched no pay row</b> and paid $0. ' +
        (d.own_only
          ? 'That is almost certainly a gap in the rate table rather than what you were meant to be paid. ' +
            'They show as <span class="pay-flag">no row</span> below - worth raising before payroll runs.'
          : 'That is almost never what anyone meant - find them in the list below (they show as ' +
            '<span class="pay-flag">no row</span>) and fix the table before payroll runs.') +
        '</div>'
      : '') +
    '<div class="mk-cols" style="display:grid;grid-template-columns:1fr 300px;gap:16px;align-items:start"><div>' +
      '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>Closed</th><th>Call</th><th>Tech</th><th>Service</th><th>Paid by</th>' +
        '<th style="text-align:right">Job pay</th><th style="text-align:right">Vehicle</th>' +
        '<th style="text-align:right">Tips</th></tr></thead><tbody>' +
      (calls.length ? calls.map(function (c) {
        return '<tr>' +
          '<td>' + escHtml(String(c.closed_at || '').slice(0, 10)) + '</td>' +
          '<td>' + escHtml(c.job_number || ('#' + c.id)) + (c.status === 'goa' ? ' <span class="pay-chip">GOA</span>' : '') +
            (c.is_edu ? ' <span class="pay-chip">EDU</span>' : '') + '</td>' +
          '<td>' + escHtml(c.tech_name || '') + '</td>' +
          '<td>' + escHtml(c.service_type || '') + '</td>' +
          '<td>' + (c.pay_row_title ? escHtml(c.pay_row_title) : '<span class="pay-flag">no row</span>') + '</td>' +
          '<td style="text-align:right;font-variant-numeric:tabular-nums">' + payMoney(c.pay_job_amount) + '</td>' +
          '<td style="text-align:right;font-variant-numeric:tabular-nums">' + payMoney(c.pay_vehicle_amount) + '</td>' +
          '<td style="text-align:right;font-variant-numeric:tabular-nums">' + payMoney(c.pay_tip_amount) + '</td>' +
        '</tr>';
      }).join('') : '<tr><td colspan="8" style="text-align:center;padding:26px;color:var(--text-muted-color)">' +
        'No closed calls in this range.</td></tr>') +
      '</tbody></table></div>' +
    '</div><div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-body">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
          'color:var(--primary);margin-bottom:12px">Totals</div>' +
        '<div class="pay-tot">' +
          '<div class="lbl">Job Pay</div><div class="val">' + payMoney(t.job_pay) + '</div>' +
          '<div class="lbl">Vehicle Reimbursement</div><div class="val">' + payMoney(t.vehicle) + '</div>' +
          '<div class="lbl">Tips</div><div class="val">' + payMoney(t.tips) + '</div>' +
          '<div class="lbl grand">Total</div><div class="val grand">' + payMoney(t.total) + '</div>' +
        '</div>' +
        '<div class="pay-scope" style="margin-top:10px">' + (t.calls || 0) + ' call' +
          ((t.calls || 0) === 1 ? '' : 's') + '. Tips are inside Job Pay.</div>' +
      '</div></div>' +
      ((d.techs || []).length > 1 ? '<div class="card"><div class="card-body">' +
        '<div style="font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;' +
          'color:var(--text-muted-color);margin-bottom:10px">By tech</div>' +
        '<div class="pay-tot">' +
        d.techs.map(function (x) {
          return '<div class="lbl">' + escHtml(x.name) + (x.unpaid ? ' <span class="pay-flag">' + x.unpaid + '</span>' : '') +
            '</div><div class="val">' + payMoney(x.total) + '</div>';
        }).join('') +
        '</div></div></div>' : '') +
    '</div></div>';
}
