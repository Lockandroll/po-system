// Shared rules for vehicle assignment and turn-in sheets.
//
// Pure: no database, no network, no Express. It lives out of
// routes/vehicleHandoffs.js so the rules that decide what a sheet still needs,
// who may touch it, and what a setting is allowed to look like can be read and
// tested on their own. Same split as utils/release.js and utils/property.js.
//
// The shape of a sheet, in one paragraph: a manager, admin or owner STARTS it
// (vehicle, driver, deadline, who fills it out). Whoever fills it out takes the
// photos, marks damage, answers the checklist. The DRIVER always initials the
// agreement and signs on their own login. The manager countersigns, and only then
// does Fleet change. A locksmith can never start a sheet or pick a van for
// himself (Tony, 2026-09-24).
//
// House style: string concatenation only, no template literals/backticks.

var KINDS = ['assign', 'turn_in'];
var STATUSES = ['awaiting_driver', 'in_progress', 'returned', 'flagged', 'ready_for_review', 'completed', 'voided'];
var OPEN_STATUSES = ['awaiting_driver', 'in_progress', 'returned', 'flagged', 'ready_for_review'];
// While a sheet is in one of these, whoever fills it out may still change it.
var EDITABLE_STATUSES = ['awaiting_driver', 'in_progress', 'returned', 'flagged'];
var FUEL_LEVELS = ['E', '1/4', '1/2', '3/4', 'F'];
var TURN_IN_REASONS = ['reassignment', 'separation', 'shop', 'sold_retired', 'other'];
var STATUS_LABEL = {
  awaiting_driver: 'Waiting on driver', in_progress: 'In progress', returned: 'Sent back to driver',
  flagged: 'Driver flagged a problem', ready_for_review: 'Ready for review', completed: 'Completed', voided: 'Voided'
};

var DEFAULT_PHOTO_SLOTS = [
  { key: 'front', label: 'Front', hint: 'Whole front, plate visible', required: true },
  { key: 'rear', label: 'Rear', hint: 'Whole back of the van, plate visible', required: true },
  { key: 'driver_side', label: 'Driver side', hint: 'Step back far enough to get the whole side', required: true },
  { key: 'passenger_side', label: 'Passenger side', hint: 'Step back far enough to get the whole side', required: true },
  { key: 'odometer', label: 'Odometer / dash', hint: 'Engine on, mileage readable', required: true },
  { key: 'interior', label: 'Interior / cab', hint: 'Seats and floor', required: true },
  { key: 'cargo', label: 'Cargo / shelving', hint: 'Open the rear doors', required: true },
  { key: 'camera', label: 'Camera unit', hint: 'Lens and mount', required: true }
];

var DEFAULT_CHECKLIST = [
  { key: 'keys', label: 'Keys', required: true, extra: 'count' },
  { key: 'fuel_card', label: 'Fuel card', required: true, extra: 'last4' },
  { key: 'registration', label: 'Registration in glovebox', required: true, extra: null },
  { key: 'insurance', label: 'Insurance card in glovebox', required: true, extra: null },
  { key: 'dash_camera', label: 'Dash camera present, lens clear', required: true, extra: null },
  { key: 'extinguisher', label: 'Fire extinguisher (charged)', required: true, extra: null },
  { key: 'first_aid', label: 'First-aid kit', required: false, extra: null },
  { key: 'spare_tire', label: 'Spare tire + jack', required: false, extra: null }
];

// Seeded once, on an empty library. After that the library belongs to whoever
// edits it in Settings; initDB never rewrites it.
var DEFAULT_AGREEMENTS = [
  {
    name: 'Standard Vehicle Use Agreement', use_on: 'assign', is_default: true,
    statements: [
      { key: 'camera', title: 'Vehicle camera', required: true,
        body: 'This vehicle has a camera system that records video, audio, location and speed, facing the road and the cab. Recordings may be reviewed by Lock and Roll at any time and used for safety, training, claims and discipline. I will not cover, unplug, move or tamper with it.' },
      { key: 'traffic_laws', title: 'Traffic laws', required: true,
        body: 'I will obey all traffic laws, posted speed limits and signals, and I will wear my seatbelt at all times while the vehicle is moving.' },
      { key: 'phone_use', title: 'Phone use', required: true,
        body: 'I will not text, email, or hold a phone while driving. Dispatch and navigation are hands-free only.' },
      { key: 'authorized_use', title: 'Authorized use', required: true,
        body: 'Only I may drive this vehicle. No unauthorized passengers. No personal use unless approved in writing.' },
      { key: 'tickets_accidents', title: 'Tickets and accidents', required: true,
        body: 'I am responsible for traffic and parking tickets I receive. I will report any accident, damage or ticket to my manager the same day.' }
    ]
  },
  {
    name: 'Turn-In Acknowledgment', use_on: 'turn_in', is_default: true,
    statements: [
      { key: 'condition', title: 'Condition', required: true,
        body: 'The photos, damage marks and checklist on this sheet show the vehicle as I am returning it.' },
      { key: 'belongings', title: 'Personal items', required: true,
        body: 'I have removed my personal belongings. Company tools and equipment listed on this sheet stay with the vehicle.' },
      { key: 'tickets', title: 'Open tickets', required: true,
        body: 'I have told my manager about every ticket, toll or incident from my time with this vehicle.' }
    ]
  }
];

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function isOpen(status) { return OPEN_STATUSES.indexOf(status) !== -1; }
function isEditable(status) { return EDITABLE_STATUSES.indexOf(status) !== -1; }

// Settings validators. They return a cleaned copy or throw a readable Error, so
// a half-broken list can never be saved (the partial-save lesson from the
// licensing register).
function cleanPhotoSlots(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Keep at least one photo slot.');
  if (list.length > 20) throw new Error('20 photo slots at most.');
  var seen = {};
  return list.map(function (s, i) {
    var label = String((s && s.label) || '').trim().slice(0, 60);
    if (!label) throw new Error('Photo slot ' + (i + 1) + ' needs a name.');
    var key = slugKey((s && s.key) || label) || ('slot_' + (i + 1));
    if (seen[key]) key = key + '_' + (i + 1);
    seen[key] = true;
    return { key: key, label: label, hint: String((s && s.hint) || '').trim().slice(0, 120), required: !(s && s.required === false) };
  });
}

function cleanChecklist(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Keep at least one checklist item.');
  if (list.length > 40) throw new Error('40 checklist items at most.');
  var seen = {};
  return list.map(function (s, i) {
    var label = String((s && s.label) || '').trim().slice(0, 80);
    if (!label) throw new Error('Checklist item ' + (i + 1) + ' needs a name.');
    var key = slugKey((s && s.key) || label) || ('item_' + (i + 1));
    if (seen[key]) key = key + '_' + (i + 1);
    seen[key] = true;
    var extra = (s && (s.extra === 'count' || s.extra === 'last4')) ? s.extra : null;
    return { key: key, label: label, required: !(s && s.required === false), extra: extra };
  });
}

function cleanStatements(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('An agreement needs at least one statement.');
  if (list.length > 30) throw new Error('30 statements at most.');
  var seen = {};
  return list.map(function (s, i) {
    var title = String((s && s.title) || '').trim().slice(0, 80);
    var body = String((s && s.body) || '').trim().slice(0, 2000);
    if (!title) throw new Error('Statement ' + (i + 1) + ' needs a title.');
    if (!body) throw new Error('Statement ' + (i + 1) + ' needs its wording.');
    var key = slugKey((s && s.key) || title) || ('s_' + (i + 1));
    if (seen[key]) key = key + '_' + (i + 1);
    seen[key] = true;
    return { key: key, title: title, body: body, required: !(s && s.required === false) };
  });
}

function sameStatements(a, b) {
  return JSON.stringify(cleanStatements(a)) === JSON.stringify(cleanStatements(b));
}

// Initials are what the driver types into each box: 1 to 4 letters.
function cleanInitials(s) {
  var v = String(s || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  return (v.length >= 1 && v.length <= 4) ? v : null;
}

// Frozen checklist on a sheet: the settings list plus the answers.
function freezeChecklist(list) {
  return (list || []).map(function (c) {
    return { key: c.key, label: c.label, required: c.required !== false, extra: c.extra || null, state: null, value: '', note: '' };
  });
}

// Merge answers from a request into the frozen checklist. Unknown keys are
// ignored; a state that is not present/missing is ignored.
function applyChecklist(frozen, answers) {
  var byKey = {};
  (answers || []).forEach(function (a) { if (a && a.key) byKey[a.key] = a; });
  return (frozen || []).map(function (c) {
    var a = byKey[c.key];
    if (!a) return c;
    var out = Object.assign({}, c);
    if (a.state === 'present' || a.state === 'missing' || a.state === null) out.state = a.state;
    if (a.value != null) out.value = String(a.value).slice(0, 20);
    if (a.note != null) out.note = String(a.note).slice(0, 200);
    return out;
  });
}

// Which photo slots have a usable photo. A slot counts only with a READY photo
// that has not been rejected or replaced.
function slotsCovered(photos) {
  var out = {};
  (photos || []).forEach(function (p) { if (p.status === 'ready' && p.slot_key) out[p.slot_key] = true; });
  return out;
}

// What the sheet still needs before the driver can sign. Human sentences, in the
// order the steps appear.
function missingForDriverSign(sheet, photos, agreements, marks) {
  var out = [];
  if (sheet.odometer == null || sheet.odometer === '') out.push('Enter the odometer reading.');
  if (!sheet.fuel_level) out.push('Pick the fuel level.');
  var covered = slotsCovered(photos);
  var owed = (sheet.photo_slots || []).filter(function (s) { return s.required !== false && !covered[s.key]; });
  if (owed.length) out.push('Take the ' + owed.map(function (s) { return s.label; }).join(', ') + ' photo' + (owed.length === 1 ? '' : 's') + '.');
  var rejected = (photos || []).filter(function (p) { return p.status === 'rejected'; });
  var redone = {};
  (photos || []).forEach(function (p) { if (p.replaces_photo_id && p.status === 'ready') redone[p.replaces_photo_id] = true; });
  var owedRetakes = rejected.filter(function (p) { return !redone[p.id]; });
  if (owedRetakes.length) out.push('Retake the photo' + (owedRetakes.length === 1 ? '' : 's') + ' your manager sent back.');
  if (!sheet.damage_reviewed_at) out.push('Check the damage marks.');
  (marks || []).forEach(function (m) {
    if (m.created_handoff_id === sheet.id && !m.photo_id && m.origin === 'driver') out.push('Take a close-up of damage mark #' + m.mark_no + '.');
  });
  var unanswered = (sheet.checklist || []).filter(function (c) { return c.required !== false && !c.state; });
  if (unanswered.length) out.push('Answer ' + unanswered.length + ' checklist item' + (unanswered.length === 1 ? '' : 's') + '.');
  (agreements || []).forEach(function (a) {
    var initials = a.initials || {};
    var left = (a.statements || []).filter(function (s) { return s.required !== false && !initials[s.key]; });
    if (left.length) out.push('Initial ' + left.length + ' statement' + (left.length === 1 ? '' : 's') + ' in ' + a.agreement_name + '.');
  });
  return out;
}

// What blocks the countersign. Everything the driver needed, plus the driver's
// signature (unless a manager is closing a turn-in without the driver), plus the
// manager's own damage check on a turn-in: a driver never grades their own damage.
function missingForCountersign(sheet, photos, agreements, marks) {
  var out = [];
  if (sheet.status !== 'ready_for_review' && !sheet.driver_not_present) out.push('The driver has not signed yet.');
  if (sheet.driver_not_present) {
    var base = missingForDriverSign(Object.assign({}, sheet, { damage_reviewed_at: sheet.damage_reviewed_at || sheet.manager_damage_checked_at }), photos, [], marks);
    out = out.concat(base);
    if (!sheet.driver_not_present_reason) out.push('Say why the driver is not signing.');
  }
  if (sheet.kind === 'turn_in' && !sheet.manager_damage_checked_at) out.push('Check the damage yourself (Damage tab, then Damage checked).');
  (marks || []).forEach(function (m) {
    if (m.origin === 'driver' && !m.confirmed && m.status === 'open') out.push('Confirm or remove damage mark #' + m.mark_no + ' that the driver added.');
  });
  return out;
}

// How a mark is coloured on a given sheet.
//   existing - already on file before this sheet
//   new      - found at this turn-in
//   driver   - added by the driver, waiting for the manager to confirm
//   repaired - closed by a repair
function markState(mark, sheet) {
  if (mark.status === 'repaired') return 'repaired';
  if (mark.origin === 'driver' && !mark.confirmed) return 'driver';
  if (sheet && mark.created_handoff_id === sheet.id && sheet.kind === 'turn_in') return 'new';
  return 'existing';
}

function numberPrefix(kind) { return kind === 'turn_in' ? 'VT' : 'VA'; }

module.exports = {
  KINDS: KINDS, STATUSES: STATUSES, OPEN_STATUSES: OPEN_STATUSES, EDITABLE_STATUSES: EDITABLE_STATUSES,
  FUEL_LEVELS: FUEL_LEVELS, TURN_IN_REASONS: TURN_IN_REASONS, STATUS_LABEL: STATUS_LABEL,
  DEFAULT_PHOTO_SLOTS: DEFAULT_PHOTO_SLOTS, DEFAULT_CHECKLIST: DEFAULT_CHECKLIST, DEFAULT_AGREEMENTS: DEFAULT_AGREEMENTS,
  esc: esc, slugKey: slugKey, isOpen: isOpen, isEditable: isEditable,
  cleanPhotoSlots: cleanPhotoSlots, cleanChecklist: cleanChecklist, cleanStatements: cleanStatements,
  sameStatements: sameStatements, cleanInitials: cleanInitials,
  freezeChecklist: freezeChecklist, applyChecklist: applyChecklist, slotsCovered: slotsCovered,
  missingForDriverSign: missingForDriverSign, missingForCountersign: missingForCountersign,
  markState: markState, numberPrefix: numberPrefix
};
