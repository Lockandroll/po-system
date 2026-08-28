// Fleet document resolution - the ONE place that decides which vault files apply
// to a vehicle and what colour that fact is.
//
// Three callers depend on this agreeing with itself: the chips in the Fleet
// Registry list, the Documents card on the vehicle page, and the "needs
// attention" banner. They must never diverge, so none of them computes a status
// of its own - they all read what this module returns.
//
// It also has to agree with something it does not own: the vault's own expiry
// colouring (docExpiryCell in public/js/app.js) and the nightly reminder email
// (jobs/docExpiry.js). leadDate() below is a deliberate copy of the one in
// jobs/docExpiry.js, down to using setMonth for months rather than 30 days. If
// you change one, change all three or the registry will call a file amber on a
// day the email does not.

const { pool } = require('../db');

// Registration is per-vehicle and needs matching. Insurance is usually one card
// for the whole fleet. Both are just labels on a link row - nothing else in the
// system cares which is which except the display order below.
const KINDS = ['registration', 'insurance'];
const KIND_LABEL = { registration: 'Registration', insurance: 'Insurance' };

// Calendar date in America/New_York, matching the cron timezone that sends the
// reminder emails. Using UTC here would flip a truck to "expired" for the five
// hours either side of midnight that the email does not agree with.
function etToday() {
  var s = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' });
  return s.slice(0, 10);
}

function leadDate(expISO, num, unit) {
  var d = new Date(String(expISO).slice(0, 10) + 'T00:00:00');
  num = parseInt(num, 10) || 0;
  if (unit === 'days') d.setDate(d.getDate() - num);
  else if (unit === 'weeks') d.setDate(d.getDate() - num * 7);
  else if (unit === 'months') d.setMonth(d.getMonth() - num);
  return d;
}

// One document's state. A file with no expiry recorded is 'current' and dated
// false - it is on file, we just cannot say anything about when it lapses. Note
// that today counts as EXPIRED, matching the vault list and the cron.
function statusFor(doc, todayISO) {
  var raw = doc && doc.expires_on ? String(doc.expires_on).slice(0, 10) : '';
  if (!raw) return { state: 'current', dated: false, expires_on: null, days: null };
  var exp = new Date(raw + 'T00:00:00');
  if (isNaN(exp.getTime())) return { state: 'current', dated: false, expires_on: null, days: null };
  var today = new Date((todayISO || etToday()) + 'T00:00:00');
  var days = Math.round((exp.getTime() - today.getTime()) / 86400000);
  if (today.getTime() >= exp.getTime()) return { state: 'expired', dated: true, expires_on: raw, days: days };
  var lead = leadDate(raw, doc.reminder_lead_num, doc.reminder_lead_unit);
  if (today.getTime() >= lead.getTime()) return { state: 'expiring', dated: true, expires_on: raw, days: days };
  return { state: 'current', dated: true, expires_on: raw, days: days };
}

// Several documents of the same kind on one vehicle is normal and good: last
// year's registration is still attached when this year's goes on. The vehicle is
// covered if ANY of them is, so the best state wins rather than the worst. That
// is the whole reason a renewal does not have to be a deletion.
var RANK = { current: 0, expiring: 1, expired: 2, missing: 3 };

function rollup(docs, todayISO) {
  if (!docs || !docs.length) return { state: 'missing', dated: false, expires_on: null, days: null, count: 0 };
  var best = null;
  docs.forEach(function (d) {
    var s = statusFor(d, todayISO);
    if (!best) { best = s; return; }
    if (RANK[s.state] < RANK[best.state]) { best = s; return; }
    // Same state: show the one that runs out last, so the chip reflects the
    // document actually keeping the truck legal.
    if (RANK[s.state] === RANK[best.state] && s.dated && best.dated && s.expires_on > best.expires_on) best = s;
    // A dated document beats an undated one at the same state - it says more.
    if (RANK[s.state] === RANK[best.state] && s.dated && !best.dated) best = s;
  });
  best.count = docs.length;
  return best;
}

// Folder breadcrumb ("Fleet / Registrations") for display. The tree is small and
// this is called once per request, so a full load beats a recursive CTE.
async function folderPaths() {
  const { rows } = await pool.query('SELECT id, parent_id, name FROM document_folders');
  const byId = new Map();
  rows.forEach(function (r) { byId.set(r.id, r); });
  const cache = new Map();
  return function pathOf(id) {
    if (id == null) return '';
    if (cache.has(id)) return cache.get(id);
    var parts = [], seen = {}, cur = id;
    while (cur != null && byId.has(cur) && !seen[cur]) {
      seen[cur] = true;
      parts.unshift(byId.get(cur).name);
      cur = byId.get(cur).parent_id;
    }
    var out = parts.join(' / ');
    cache.set(id, out);
    return out;
  };
}

const DOC_COLS =
  ' d.id AS document_id, d.name, d.mime_type, d.size_bytes, d.folder_id, d.emailable,' +
  " to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on," +
  ' d.reminder_lead_num, d.reminder_lead_unit ';

// Every document that applies to one vehicle: the ones linked to it directly,
// plus any marked as covering the whole fleet. Fleet-wide files apply to ACTIVE
// vehicles only - a van that has been sold is not on the policy any more, and
// showing it a current insurance card would be a lie with legal weight.
async function docsForVehicle(vehicleId, opts) {
  opts = opts || {};
  const todayISO = opts.todayISO || etToday();
  const pathOf = await folderPaths();

  const linked = (await pool.query(
    'SELECT vd.id AS link_id, vd.kind, vd.link_source, vd.created_by_name, vd.created_at AS linked_at,' + DOC_COLS +
    ' FROM vehicle_documents vd JOIN documents d ON d.id = vd.document_id' +
    " WHERE vd.vehicle_id = $1 AND d.status = 'ready'" +
    ' ORDER BY d.expires_on DESC NULLS LAST, d.name ASC',
    [vehicleId]
  )).rows;

  var fleet = [];
  if (opts.vehicleActive) {
    fleet = (await pool.query(
      'SELECT NULL::integer AS link_id, d.fleet_kind AS kind,' +
      " 'fleet' AS link_source, NULL::varchar AS created_by_name, d.updated_at AS linked_at," + DOC_COLS +
      " FROM documents d WHERE d.fleet_scope = true AND d.status = 'ready' AND d.fleet_kind IS NOT NULL" +
      ' ORDER BY d.expires_on DESC NULLS LAST, d.name ASC'
    )).rows;
    // A file that is both fleet-wide AND explicitly linked to this vehicle would
    // otherwise appear twice. The explicit link wins - it carries who attached it.
    var seen = {};
    linked.forEach(function (r) { seen[r.document_id] = true; });
    fleet = fleet.filter(function (r) { return !seen[r.document_id]; });
  }

  const all = linked.concat(fleet);
  if (!all.length) return [];

  // How many vehicles each file covers, for the "covers 12 vehicles" line.
  const ids = all.map(function (r) { return r.document_id; });
  const counts = (await pool.query(
    'SELECT document_id, COUNT(DISTINCT vehicle_id)::int AS n FROM vehicle_documents WHERE document_id = ANY($1::int[]) GROUP BY document_id',
    [ids]
  )).rows;
  const countBy = {};
  counts.forEach(function (c) { countBy[c.document_id] = c.n; });
  const activeCount = opts.activeVehicleCount == null ? null : opts.activeVehicleCount;

  all.forEach(function (r) {
    r.kind_label = KIND_LABEL[r.kind] || r.kind;
    r.folder_path = pathOf(r.folder_id);
    r.status = statusFor(r, todayISO);
    r.covers = r.link_source === 'fleet' ? activeCount : (countBy[r.document_id] || 1);
    r.size_bytes = r.size_bytes == null ? 0 : Number(r.size_bytes);
  });
  all.sort(function (a, b) {
    var ka = KINDS.indexOf(a.kind), kb = KINDS.indexOf(b.kind);
    if (ka !== kb) return (ka < 0 ? 99 : ka) - (kb < 0 ? 99 : kb);
    return String(a.name).localeCompare(String(b.name));
  });
  return all;
}

// Per-kind rollup for a list of vehicles, in two queries rather than two per
// vehicle - this feeds the registry list, which renders the whole fleet at once.
// vehicles: [{ id, active }]
async function summaryForVehicles(vehicles, opts) {
  opts = opts || {};
  const todayISO = opts.todayISO || etToday();
  const out = {};
  if (!vehicles || !vehicles.length) return out;
  const ids = vehicles.map(function (v) { return v.id; });

  const linked = (await pool.query(
    'SELECT vd.vehicle_id, vd.kind,' +
    " to_char(d.expires_on, 'YYYY-MM-DD') AS expires_on, d.reminder_lead_num, d.reminder_lead_unit" +
    ' FROM vehicle_documents vd JOIN documents d ON d.id = vd.document_id' +
    " WHERE d.status = 'ready' AND vd.vehicle_id = ANY($1::int[])",
    [ids]
  )).rows;

  const fleet = (await pool.query(
    "SELECT fleet_kind AS kind, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, reminder_lead_num, reminder_lead_unit" +
    " FROM documents WHERE fleet_scope = true AND status = 'ready' AND fleet_kind IS NOT NULL"
  )).rows;

  const byVehicle = {};
  ids.forEach(function (id) { byVehicle[id] = { registration: [], insurance: [] }; });
  linked.forEach(function (r) {
    if (byVehicle[r.vehicle_id] && byVehicle[r.vehicle_id][r.kind]) byVehicle[r.vehicle_id][r.kind].push(r);
  });
  vehicles.forEach(function (v) {
    if (!v.active) return;
    fleet.forEach(function (r) { if (byVehicle[v.id] && byVehicle[v.id][r.kind]) byVehicle[v.id][r.kind].push(r); });
  });

  ids.forEach(function (id) {
    out[id] = {};
    KINDS.forEach(function (k) { out[id][k] = rollup(byVehicle[id][k], todayISO); });
  });
  return out;
}

// The banner counts. Sold and inactive vehicles are excluded - nobody needs to
// be told the van they sold in March has a lapsed plate.
function countsNeedingAttention(summary, vehicles) {
  var expired = 0, expiring = 0, missing = 0;
  (vehicles || []).forEach(function (v) {
    if (!v.active) return;
    var s = summary[v.id];
    if (!s) return;
    var states = KINDS.map(function (k) { return s[k] ? s[k].state : 'missing'; });
    if (states.indexOf('expired') !== -1) expired++;
    else if (states.indexOf('expiring') !== -1) expiring++;
    else if (states.indexOf('missing') !== -1) missing++;
  });
  return { expired: expired, expiring: expiring, missing: missing, total: expired + expiring + missing };
}

module.exports = {
  KINDS: KINDS,
  KIND_LABEL: KIND_LABEL,
  etToday: etToday,
  leadDate: leadDate,
  statusFor: statusFor,
  rollup: rollup,
  docsForVehicle: docsForVehicle,
  summaryForVehicles: summaryForVehicles,
  countsNeedingAttention: countsNeedingAttention
};
