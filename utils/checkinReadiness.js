// utils/checkinReadiness.js
//
// Can this call actually be completed?
//
// Nova does not dial until it can name every value the tree is going to ask for
// and say where each one came from. A call that dies halfway because nobody
// knew how many technicians were on site is worse than a call not placed: it has
// already told the tree something, and a half-finished entry is exactly what
// makes a tree read back "not recognized" on the next attempt.
//
// Pure. No database, no Twilio, no HTTP - the caller loads the rows and hands
// them in, which is what makes every branch here testable without either. Same
// reasoning as utils/ivrScript.js. No backticks in this file.
//
//   readiness(ctx) -> { ready, values[], ask[], blocked[] }
//   applyAnswers(state, answers) -> { values, answers, rejected[] }
//
// ctx = { direction, profile, workOrder, user, signoff, answers }

// ---------------------------------------------------------------------------
// The catalogue.
//
// source is written for a person, not for a developer. It goes on screen next
// to the value, so that if a check-in is ever disputed the provenance of every
// digit Nova sent is already recorded and nobody has to reconstruct it.
//
// askable: false is not "we could not be bothered". It means no answer a
// technician standing at a door can type would be trustworthy - a vendor PIN he
// invents is worse than no call at all - so the honest outcome is to stop and
// say what is missing.
// ---------------------------------------------------------------------------

function str(v) {
  if (v == null) return null;
  var s = String(v).trim();
  return s ? s : null;
}

function digits(v) {
  var s = str(v);
  return s ? s.replace(/[^0-9]/g, '') : null;
}

var FIELDS = {
  checkin_reference: {
    label: 'Check-In PIN',
    askable: false,
    why: 'The PIN the tree asks for first.',
    resolve: function (c) {
      if (str(c.workOrder.checkin_reference)) return { value: str(c.workOrder.checkin_reference), source: 'work order' };
      if (str(c.accountPin)) return { value: str(c.accountPin), source: 'account setup' };
      if (str(c.user && c.user.ivr_reference)) return { value: str(c.user.ivr_reference), source: 'your profile' };
      return null;
    },
    fix: 'Type it onto the work order, re-parse the work order to pull it off the paperwork, or set the account PIN under Check-Ins > Scripts.'
  },
  checkin_tracking: {
    label: 'Tracking #',
    askable: true, askType: 'text',
    why: 'The job number the line for this account asks for. On ServiceChannel work orders it is the TRACKING number, which is often not the work order number printed elsewhere.',
    resolve: function (c) {
      if (str(c.workOrder.checkin_tracking)) return { value: str(c.workOrder.checkin_tracking), source: 'work order' };
      if (str(c.workOrder.wo_number)) return { value: str(c.workOrder.wo_number), source: 'work order number' };
      return null;
    },
    fix: 'Read it off the work order.'
  },
  wo_number: {
    label: 'Work Order #', askable: true, askType: 'text',
    why: 'The work order number.',
    resolve: function (c) { var v = str(c.workOrder.wo_number); return v ? { value: v, source: 'work order' } : null; },
    fix: 'Read it off the work order.'
  },
  po_number: {
    label: 'PO #', askable: true, askType: 'text',
    why: 'The purchase order number.',
    resolve: function (c) { var v = str(c.workOrder.po_number); return v ? { value: v, source: 'work order' } : null; },
    fix: 'Read it off the work order.'
  },
  claim_id: {
    label: 'Claim / Ref ID', askable: true, askType: 'text',
    why: 'The claim or reference id.',
    resolve: function (c) { var v = str(c.workOrder.claim_id); return v ? { value: v, source: 'work order' } : null; },
    fix: 'Read it off the work order.'
  },
  store_number: {
    label: 'Store #', askable: true, askType: 'text',
    why: 'The store or site number.',
    resolve: function (c) { var v = str(c.workOrder.store_number); return v ? { value: v, source: 'work order' } : null; },
    fix: 'Read it off the work order or the sign on the building.'
  },
  account_number: {
    label: 'Account #', askable: true, askType: 'text',
    why: 'The account number.',
    resolve: function (c) { var v = str(c.workOrder.account_number); return v ? { value: v, source: 'work order' } : null; },
    fix: 'Read it off the work order.'
  },
  tech_reference: {
    label: 'Technician ID',
    askable: false,
    why: 'The id this account issued to the technician personally.',
    resolve: function (c) {
      if (str(c.user && c.user.ivr_reference)) return { value: str(c.user.ivr_reference), source: 'your profile' };
      if (str(c.workOrder.checkin_reference)) return { value: str(c.workOrder.checkin_reference), source: 'work order' };
      return null;
    },
    fix: 'A manager sets this on the user account. It is a setup job, not something to guess at the door.'
  },
  num_technicians: {
    label: 'Technicians on site', askable: true, askType: 'number',
    why: 'The check-out tree asks how many technicians were on site.',
    resolve: function (c) {
      var n = c.signoff && c.signoff.num_technicians;
      if (n === 0 || n) { var i = parseInt(n, 10); if (isFinite(i) && i > 0) return { value: String(i), source: 'sign-off sheet' }; }
      return null;
    },
    writeTo: { table: 'signoff', column: 'num_technicians' },
    fix: 'Fill in the sign-off sheet, or answer it here.'
  },
  job_status: {
    label: 'Job status', askable: true, askType: 'choice',
    why: 'The check-out tree asks whether the job is finished.',
    options: [
      { value: 'complete', label: 'Finished, nothing left to do' },
      { value: 'incomplete_parts', label: 'Not finished, waiting on parts' },
      { value: 'return_trip', label: 'Not finished, coming back' },
      { value: 'cancelled', label: 'Cancelled on site' }
    ],
    // Resolved to the account's own digit by statusDigit() below, never by the
    // model. Which key means "complete" on this tree is a business fact about
    // the account, and a business fact belongs in configuration.
    resolve: function (c) {
      var s = c.signoff;
      if (!s) return null;
      if (s.work_complete === true) return { value: 'complete', source: 'sign-off sheet' };
      if (s.work_complete === false) return { value: 'return_trip', source: 'sign-off sheet' };
      return null;
    },
    writeTo: { table: 'signoff', column: 'work_complete' },
    fix: 'Answer the 100% complete question on the sign-off sheet, or answer it here.'
  },
  return_date: {
    label: 'Return date', askable: true, askType: 'date',
    why: 'Some trees ask when you are coming back.',
    resolve: function () { return null; },
    fix: 'Answer it here.'
  }
};

function fieldLabel(k) { return (FIELDS[k] && FIELDS[k].label) || k; }
function fieldList() {
  return Object.keys(FIELDS).map(function (k) { return { key: k, label: FIELDS[k].label, askable: !!FIELDS[k].askable }; });
}

// ---------------------------------------------------------------------------
// What this call needs.
//
// A script says it out loud through its send steps, so read those. An AI
// profile has no steps, so it says it on the profile (needs). Falling back to a
// default is deliberate but narrow: PIN and tracking number is what every tree
// Nova has met so far asks for, and a check-out adds status and head count.
// ---------------------------------------------------------------------------
var DEFAULT_NEEDS = {
  in: ['checkin_reference', 'checkin_tracking'],
  out: ['checkin_reference', 'checkin_tracking', 'job_status', 'num_technicians']
};

function stepFields(steps) {
  var out = [];
  (steps || []).forEach(function (s) {
    if (s && String(s.type).toLowerCase() === 'send' && s.field && FIELDS[s.field] && out.indexOf(s.field) === -1) {
      out.push(s.field);
    }
  });
  return out;
}

function neededKeys(profile, direction) {
  profile = profile || {};
  var dir = direction === 'out' ? 'out' : 'in';
  var mode = String(profile.mode || 'script').toLowerCase();

  if (mode === 'script') {
    return stepFields(dir === 'out' ? profile.checkout_steps : profile.checkin_steps);
  }
  var declared = profile.needs && profile.needs[dir];
  if (Array.isArray(declared) && declared.length) {
    return declared.filter(function (k) { return !!FIELDS[k]; });
  }
  // ai_fallback still runs the script first, so if there are steps they are the
  // better answer than a default list.
  var fromSteps = stepFields(dir === 'out' ? profile.checkout_steps : profile.checkin_steps);
  if (fromSteps.length) return fromSteps;
  return DEFAULT_NEEDS[dir].slice();
}

// The account's digit for a job status. No map configured is a MISSING value,
// not a guess: sending the wrong number to a check-out tree closes the job in
// the wrong state on the client's side, which is worse than not calling.
function statusDigit(profile, statusKey) {
  var map = (profile && profile.status_map) || null;
  if (!map || typeof map !== 'object') return null;
  var v = map[statusKey];
  var d = v == null ? '' : String(v).replace(/[^0-9*#]/g, '');
  return d || null;
}

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------
function readiness(ctx) {
  ctx = ctx || {};
  var c = {
    direction: ctx.direction === 'out' ? 'out' : 'in',
    profile: ctx.profile || {},
    workOrder: ctx.workOrder || {},
    user: ctx.user || null,
    signoff: ctx.signoff || null,
    accountPin: ctx.accountPin || null,
    answers: ctx.answers || {}
  };
  var keys = neededKeys(c.profile, c.direction);
  var values = [];
  var ask = [];
  var blocked = [];

  keys.forEach(function (key) {
    var def = FIELDS[key];
    if (!def) return;
    var hit = null;

    // A typed answer counts, and says so. It is not laundered into looking like
    // it came off the paperwork.
    if (Object.prototype.hasOwnProperty.call(c.answers, key)) {
      var typed = str(c.answers[key]);
      if (typed) hit = { value: typed, source: 'typed just now' };
    }
    if (!hit) hit = def.resolve(c) || null;

    var row = {
      key: key,
      label: def.label,
      value: hit ? hit.value : null,
      source: hit ? hit.source : null,
      status: hit ? 'ok' : 'missing'
    };

    // job_status carries a second value: the digit this account's tree wants.
    if (key === 'job_status' && hit) {
      row.digit = statusDigit(c.profile, hit.value);
      row.status_label = (function () {
        var m = null;
        def.options.forEach(function (o) { if (o.value === hit.value) m = o.label; });
        return m;
      })();
      if (!row.digit) {
        row.status = 'missing';
        blocked.push('This account has no job-status mapping, so Nova does not know which key means "' +
          (row.status_label || hit.value) + '" on its tree. Set it under Check-Ins > Scripts.');
      }
    }
    values.push(row);

    if (row.status === 'missing' && !(key === 'job_status' && !statusDigit(c.profile, 'complete'))) {
      if (def.askable) {
        ask.push({
          key: key, label: def.label, type: def.askType || 'text',
          options: def.options || null, why: def.why,
          suggested: key === 'num_technicians' ? '1' : null
        });
      } else {
        blocked.push(def.label + ' is missing. ' + def.fix);
      }
    }
  });

  // A return date is only asked for when the job is not finished. Asking a
  // technician when he is coming back to a job he just completed is the kind of
  // question that teaches people to click through the screen without reading.
  var statusRow = null;
  values.forEach(function (v) { if (v.key === 'job_status') statusRow = v; });
  if (statusRow && statusRow.value === 'complete') {
    ask = ask.filter(function (a) { return a.key !== 'return_date'; });
    values = values.filter(function (v) { return v.key !== 'return_date'; });
  }

  return {
    direction: c.direction,
    ready: ask.length === 0 && blocked.length === 0,
    values: values,
    ask: ask,
    blocked: blocked
  };
}

// ---------------------------------------------------------------------------
// Merging what the technician typed.
//
// THE RULE: an answer may only fill a key readiness itself declared missing.
// Anything else is dropped and reported. Without it a browser could post a PIN,
// or a job status, or a head count that contradicts the sheet, and the entire
// argument that Nova only sends values it can vouch for would collapse into
// "Nova sends whatever the last request said".
// ---------------------------------------------------------------------------
function applyAnswers(state, answers) {
  var allowed = {};
  (state && state.ask ? state.ask : []).forEach(function (a) { allowed[a.key] = a; });

  var clean = {};
  var rejected = [];
  Object.keys(answers || {}).forEach(function (k) {
    var slot = allowed[k];
    if (!slot) { rejected.push(k); return; }
    var raw = answers[k];
    var v = null;
    if (slot.type === 'number') {
      var n = parseInt(digits(raw), 10);
      if (isFinite(n) && n > 0 && n < 100) v = String(n);
    } else if (slot.type === 'choice') {
      (slot.options || []).forEach(function (o) { if (o.value === String(raw)) v = o.value; });
    } else if (slot.type === 'date') {
      var s = str(raw);
      if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) v = s;
    } else {
      var t = str(raw);
      if (t) v = t.slice(0, 80);
    }
    if (v === null) rejected.push(k); else clean[k] = v;
  });
  return { answers: clean, rejected: rejected };
}

// The values an IVR script or the AI navigator may send, keyed the way
// utils/ivrScript.js expects. Only ever built from a readiness pass, so a value
// with no provenance cannot reach a keypad.
function dialValues(state) {
  var out = {};
  (state && state.values ? state.values : []).forEach(function (v) {
    if (v.status !== 'ok') return;
    out[v.key] = (v.key === 'job_status') ? v.digit : v.value;
  });
  return out;
}

module.exports = {
  FIELDS: FIELDS,
  fieldLabel: fieldLabel,
  fieldList: fieldList,
  neededKeys: neededKeys,
  stepFields: stepFields,
  statusDigit: statusDigit,
  readiness: readiness,
  applyAnswers: applyAnswers,
  dialValues: dialValues,
  DEFAULT_NEEDS: DEFAULT_NEEDS
};
