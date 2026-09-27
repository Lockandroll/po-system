// utils/qboJournal.js
// ---------------------------------------------------------------------------
// Weekly Cash Close -> QuickBooks Online journal entries (CSV import file).
//
// Rebuilt 2026-09-27 after Tony's review of the first cut. The two rules that
// shape everything below:
//   1. Revenue and its Class come from the PULSAR Call Search import (the Task
//      on every cash call), never from the tech. A locksmith has locksmith AND
//      roadside revenue in the same week.
//   2. Techs classify nothing. Expense lines get a Category (-> QBO account) and
//      a Class from whoever reviews them in the weekly close.
//
// Unit of export: one journal entry per TECH per WEEK (usually that is one
// deposit; two deposits by the same tech in the same week share one entry, so
// the week's Pulsar revenue is booked exactly once).
//
//   normal  tech deposited for the week:
//             Dr Bank (one line per deposit)      Dr expense (per approved line)
//             Cr income by class + Cr sales tax   (from Pulsar, per city)
//             Dr/Cr Cash Over/Short for the difference
//   held    Pulsar shows cash but the tech deposited nothing: the revenue still
//           belongs to THIS week, so it is booked against a receivable:
//             Dr Cash Held by Techs               Cr income by class + Cr tax
//   late    a deposit for an earlier, already-closed week whose cash was held:
//             Dr Bank + Dr expenses               Cr Cash Held by Techs
//             Dr/Cr Cash Over/Short for the difference
//
// revenue_mode 'clearing' swaps "income by class + tax" for "Cash Clearing by
// class, gross" - the fallback if cash sales already reach QuickBooks some other
// way (open question for the bookkeeper, 2026-09-27).
//
// Everything here is PURE: routes/cashClose.js loads the rows and hands them in,
// which is what lets the test harness drive it without a database.
// House style: string concatenation, no template literals (CLAUDE.md 1.1).
// ---------------------------------------------------------------------------

var RE = require('./royaltyEngine');

var SETTINGS_KEY = 'qbo_je_config';

var DEFAULT_CATEGORIES = [
  { key: 'fuel', label: 'Fuel' },
  { key: 'parts', label: 'Parts & supplies' },
  { key: 'tools', label: 'Tools & equipment' },
  { key: 'vehicle', label: 'Vehicle repair & maintenance' },
  { key: 'tolls', label: 'Tolls & parking' },
  { key: 'meals', label: 'Meals' },
  { key: 'other', label: 'Other' }
];

function defaultConfig() {
  return {
    revenue_mode: 'income',
    bank_account: '',
    clearing_account: '',
    over_short_account: '',
    held_account: '',
    tax_account: '',
    city_tax_accounts: {},
    income_accounts: { Locksmith: '', Roadside: '', Dispatch: '' },
    categories: DEFAULT_CATEGORIES.map(function (c) { return { key: c.key, label: c.label, account: '' }; }),
    classes: ['Locksmith', 'Roadside', 'Dispatch'],
    default_class: 'Locksmith',
    task_classes: {},
    city_locations: {}
  };
}

function str(v, max) {
  return (v == null ? '' : String(v)).trim().slice(0, max || 200);
}

function taskKey(task) {
  return str(task, 100).replace(/\s+/g, ' ').toLowerCase();
}

function keyify(s) {
  return str(s, 80).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function cleanMap(raw, keyFn, valFn) {
  var out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).forEach(function (k) {
    var kk = keyFn(k);
    var v = valFn(raw[k]);
    if (kk && v) out[kk] = v;
  });
  return out;
}

// Whatever is stored (or submitted) -> a complete, clean config.
function normalizeConfig(raw) {
  var d = defaultConfig();
  var r = (raw && typeof raw === 'object') ? raw : {};
  var out = {
    revenue_mode: r.revenue_mode === 'clearing' ? 'clearing' : 'income',
    bank_account: str(r.bank_account),
    clearing_account: str(r.clearing_account),
    over_short_account: str(r.over_short_account),
    held_account: str(r.held_account),
    tax_account: str(r.tax_account),
    city_tax_accounts: cleanMap(r.city_tax_accounts, function (k) { return str(k, 3).toUpperCase(); }, function (v) { return str(v); }),
    income_accounts: {},
    categories: [],
    classes: [],
    default_class: '',
    task_classes: {},
    city_locations: cleanMap(r.city_locations, function (k) { return str(k, 3).toUpperCase(); }, function (v) { return str(v, 100); })
  };
  var classes = Array.isArray(r.classes) ? r.classes : d.classes;
  classes.forEach(function (c) {
    var v = str(c, 40);
    if (v && out.classes.indexOf(v) === -1) out.classes.push(v);
  });
  if (!out.classes.length) out.classes = d.classes.slice();
  var ia = (r.income_accounts && typeof r.income_accounts === 'object') ? r.income_accounts : {};
  out.classes.forEach(function (c) { out.income_accounts[c] = str(ia[c]); });
  var dc = str(r.default_class != null ? r.default_class : d.default_class, 40);
  out.default_class = out.classes.indexOf(dc) !== -1 ? dc : out.classes[0];
  var cats = Array.isArray(r.categories) ? r.categories : d.categories;
  var seen = {};
  cats.forEach(function (c) {
    if (!c) return;
    var label = str(c.label, 80);
    var key = keyify(c.key) || keyify(label);
    if (!key || !label || seen[key]) return;
    seen[key] = true;
    out.categories.push({ key: key, label: label, account: str(c.account) });
  });
  out.task_classes = cleanMap(r.task_classes, taskKey, function (v) {
    var s = str(v, 40);
    return out.classes.indexOf(s) !== -1 ? s : '';
  });
  return out;
}

async function loadConfig(pool) {
  var r = await pool.query('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEY]);
  var parsed = null;
  if (r.rows.length && r.rows[0].value) {
    try { parsed = JSON.parse(r.rows[0].value); } catch (e) { parsed = null; }
  }
  return normalizeConfig(parsed);
}

async function saveConfig(pool, cfg) {
  var clean = normalizeConfig(cfg);
  await pool.query(
    'INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW()) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
    [SETTINGS_KEY, JSON.stringify(clean)]
  );
  return clean;
}

// The class a Pulsar task falls under. An explicit mapping wins; otherwise the
// royalty engine's grouping supplies Locksmith / Roadside. "Opening" (lockouts,
// trunks) and "Other" are deliberately left unmapped - that is Tony's call, and
// an unmapped task holds the tech's entry rather than guessing.
function suggestClass(task, cfg) {
  var sec = RE.sectionOf(RE.classifyService(task));
  if (sec === 'Locksmith' && cfg.classes.indexOf('Locksmith') !== -1) return 'Locksmith';
  if (sec === 'Roadside' && cfg.classes.indexOf('Roadside') !== -1) return 'Roadside';
  return '';
}
function royaltyGroup(task) {
  return RE.sectionOf(RE.classifyService(task)) || 'Other';
}
function classForTask(task, cfg) {
  var k = taskKey(task);
  if (k && cfg.task_classes[k]) return { cls: cfg.task_classes[k], source: 'mapped' };
  var s = k ? suggestClass(task, cfg) : '';
  return s ? { cls: s, source: 'suggested' } : { cls: '', source: 'none' };
}

// Problems with the mapping that block every entry.
function configProblems(cfg) {
  var p = [];
  if (!cfg.bank_account) p.push('Set the bank account deposits go into.');
  if (!cfg.over_short_account) p.push('Set the Cash Over/Short account.');
  if (!cfg.held_account) p.push('Set the Cash Held by Techs account.');
  if (cfg.revenue_mode === 'clearing') {
    if (!cfg.clearing_account) p.push('Set the Cash Clearing account.');
  } else {
    if (!cfg.tax_account) p.push('Set the default sales tax account.');
    var missing = cfg.classes.filter(function (c) { return !cfg.income_accounts[c]; });
    if (missing.length) p.push('Set an income account for ' + missing.join(', ') + '.');
  }
  return p;
}

/* ------------------------------------------------------------ money --- */

function toCents(v) {
  var n = parseFloat(v);
  if (isNaN(n)) return 0;
  return Math.round(n * 100);
}
function centsStr(c) {
  var neg = c < 0; if (neg) c = -c;
  var s = String(Math.floor(c / 100)) + '.' + (c % 100 < 10 ? '0' : '') + String(c % 100);
  return neg ? '-' + s : s;
}

// Split `cents` across `weights` ({key: weight}) by largest remainder, so the
// parts always add back to the whole to the penny.
function allocate(cents, weights) {
  var keys = Object.keys(weights).filter(function (k) { return weights[k] > 0; });
  var total = 0;
  keys.forEach(function (k) { total += weights[k]; });
  var out = {};
  if (!keys.length || total <= 0) return out;
  var used = 0;
  var rema = keys.map(function (k) {
    var exact = cents * weights[k] / total;
    var base = Math.floor(exact);
    out[k] = base;
    used += base;
    return { k: k, r: exact - base };
  });
  rema.sort(function (a, b) { return b.r - a.r || (a.k < b.k ? -1 : 1); });
  for (var i = 0; used < cents; i++, used++) out[rema[i % rema.length].k] += 1;
  return out;
}

/* ------------------------------------------------------ the builder --- */

// input = {
//   week_start, week_end   'YYYY-MM-DD'
//   config                 normalizeConfig() output
//   city_names             { ORL: 'Orlando', ... }
//   calls                  [{ week_start, tech_user_id, task, cash, tax, city_code }]  linked calls of
//                          the week being closed AND of any week a late deposit belongs to
//   deposits               [{ id, deposit_number, deposit_date, amount, city_code, user_id, user_name,
//                             week_start, expenses: [{ id, description, amount, category, qbo_class,
//                             review_status }] }]   this week's + late ones
//   held                   [{ id, week_start, user_id, amount }]   outstanding held balances
//   users                  { id: name }
// }
// Returns { units: [...], totals: [...], problems: [config problems] }.
function buildWeek(input) {
  var cfg = input.config;
  var W = input.week_start;
  var cityNames = input.city_names || {};
  var users = input.users || {};
  var catByKey = {};
  cfg.categories.forEach(function (c) { catByKey[c.key] = c; });

  function loc(code) {
    var c = String(code || '').toUpperCase();
    return cfg.city_locations[c] || cityNames[c] || c;
  }
  function taxAccount(code) {
    return cfg.city_tax_accounts[String(code || '').toUpperCase()] || cfg.tax_account;
  }

  var callsBy = {};
  (input.calls || []).forEach(function (c) {
    if (!c.tech_user_id) return;
    var k = c.week_start + '|' + c.tech_user_id;
    (callsBy[k] = callsBy[k] || []).push(c);
  });
  var depsBy = {};
  (input.deposits || []).forEach(function (d) {
    var k = d.week_start + '|' + d.user_id;
    (depsBy[k] = depsBy[k] || []).push(d);
  });
  var heldBy = {};
  (input.held || []).forEach(function (h) { heldBy[h.week_start + '|' + h.user_id] = h; });

  // Which units exist: every tech with cash or a deposit this week, plus every
  // (tech, earlier week) that has a late deposit.
  var keys = {};
  Object.keys(callsBy).forEach(function (k) { if (k.indexOf(W + '|') === 0) keys[k] = true; });
  Object.keys(depsBy).forEach(function (k) { keys[k] = true; });

  var units = Object.keys(keys).map(function (k) {
    var parts = k.split('|');
    var wk = parts[0];
    var uid = parseInt(parts[1], 10);
    var calls = callsBy[k] || [];
    var deps = (depsBy[k] || []).slice().sort(function (a, b) { return a.deposit_number < b.deposit_number ? -1 : 1; });
    var isLate = wk !== W;
    var kind = isLate ? 'late' : (deps.length ? 'normal' : 'held');
    var who = users[uid] || (deps[0] && deps[0].user_name) || ('User ' + uid);
    var problems = [];
    var lines = [];

    // Pulsar cash by class and city (the class mix also drives "split").
    var byClassCity = {};
    var taxByCity = {};
    var classGross = {};
    var cashCents = 0;
    var cashByCity = {};
    var unmapped = {};
    calls.forEach(function (c) {
      var cents = toCents(c.cash);
      var tax = toCents(c.tax);
      if (cents <= 0) return;
      cashCents += cents;
      var city = String(c.city_code || '').toUpperCase();
      cashByCity[city] = (cashByCity[city] || 0) + cents;
      var cl = classForTask(c.task, cfg).cls;
      if (!cl) { unmapped[c.task || '(blank)'] = true; return; }
      var ck = cl + '|' + city;
      if (!byClassCity[ck]) byClassCity[ck] = { gross: 0, tax: 0 };
      byClassCity[ck].gross += cents;
      byClassCity[ck].tax += tax;
      taxByCity[city] = (taxByCity[city] || 0) + tax;
      classGross[cl] = (classGross[cl] || 0) + cents;
    });
    var mainCity = Object.keys(cashByCity).sort(function (a, b) { return cashByCity[b] - cashByCity[a]; })[0] ||
      (deps[0] && String(deps[0].city_code || '').toUpperCase()) || '';

    if (!isLate) {
      Object.keys(unmapped).forEach(function (t) {
        problems.push('Pulsar task "' + t + '" is not mapped to a class.');
      });
    }

    // --- debit side: bank + expenses
    var debit = 0;
    var credit = 0;
    var pending = 0;
    deps.forEach(function (d) {
      var amt = toCents(d.amount);
      var dcity = String(d.city_code || mainCity).toUpperCase();
      if (amt > 0) {
        lines.push({ account: cfg.bank_account, debit: amt, credit: 0, cls: '', location: loc(dcity),
          description: 'Cash deposit ' + d.deposit_number + ' (' + (d.deposit_date || '') + ') - ' + who });
        debit += amt;
      } else if (amt < 0) {
        problems.push('Deposit ' + d.deposit_number + ' has a negative amount.');
      }
      (d.expenses || []).forEach(function (ex) {
        var st = ex.review_status || 'pending';
        if (st === 'denied') return;
        var eamt = toCents(ex.amount);
        if (eamt <= 0) return;
        if (st === 'pending') { pending++; return; }
        var cat = ex.category ? catByKey[ex.category] : null;
        var label = ex.description || 'expense';
        if (!ex.category) { problems.push('Expense "' + label + '" has no category.'); return; }
        if (!cat) { problems.push('Expense "' + label + '" uses category "' + ex.category + '", which is no longer on the list.'); return; }
        if (!cat.account) { problems.push('Category "' + cat.label + '" has no QuickBooks account.'); return; }
        var ecls = ex.qbo_class || '';
        var desc = cat.label + ': ' + label + ' (' + who + ', ' + d.deposit_number + ')';
        if (ecls === 'split') {
          var weights = Object.keys(classGross).length ? classGross : {};
          if (!Object.keys(weights).length) weights[cfg.default_class] = 1;
          var split = allocate(eamt, weights);
          Object.keys(split).sort().forEach(function (cl) {
            if (!split[cl]) return;
            lines.push({ account: cat.account, debit: split[cl], credit: 0, cls: cl, location: loc(dcity),
              description: desc + ' - split by revenue' });
          });
        } else if (ecls && cfg.classes.indexOf(ecls) !== -1) {
          lines.push({ account: cat.account, debit: eamt, credit: 0, cls: ecls, location: loc(dcity), description: desc });
        } else {
          problems.push('Expense "' + label + '" has no class.');
          return;
        }
        debit += eamt;
      });
    });
    if (pending) problems.push(pending + ' expense line' + (pending === 1 ? ' is' : 's are') + ' still waiting for review.');

    // --- revenue side (normal + held only; a late deposit's revenue was
    // already booked in its own week when the cash was held)
    function revenueLines() {
      Object.keys(byClassCity).sort().forEach(function (ck) {
        var p = ck.split('|');
        var cl = p[0], city = p[1];
        var g = byClassCity[ck];
        if (cfg.revenue_mode === 'clearing') {
          lines.push({ account: cfg.clearing_account, debit: 0, credit: g.gross, cls: cl, location: loc(city),
            description: cl + ' cash per Pulsar - ' + who });
          credit += g.gross;
        } else {
          var net = g.gross - g.tax;
          if (net > 0) {
            lines.push({ account: cfg.income_accounts[cl] || '', debit: 0, credit: net, cls: cl, location: loc(city),
              description: cl + ' cash sales per Pulsar - ' + who });
            credit += net;
          } else if (net < 0) {
            problems.push('Pulsar tax is larger than the cash collected for ' + cl + ' in ' + city + '.');
          }
        }
      });
      if (cfg.revenue_mode !== 'clearing') {
        Object.keys(taxByCity).sort().forEach(function (city) {
          var t = taxByCity[city];
          if (!t) return;
          lines.push({ account: taxAccount(city), debit: 0, credit: t, cls: '', location: loc(city),
            description: 'Sales tax collected per Pulsar - ' + who });
          credit += t;
        });
      }
    }

    var heldAmount = 0;
    var clearsHeld = null;
    if (kind === 'normal') {
      if (cashCents === 0) problems.push('No Pulsar cash calls for ' + who + ' this week. Check the name link or the import.');
      revenueLines();
    } else if (kind === 'held') {
      revenueLines();
      heldAmount = credit;
      if (heldAmount > 0) {
        lines.unshift({ account: cfg.held_account, debit: heldAmount, credit: 0, cls: '', location: loc(mainCity),
          description: 'Cash held by ' + who + ', no deposit for week of ' + W });
        debit += heldAmount;
      }
    } else {
      var h = heldBy[k];
      if (!h) {
        problems.push('Late deposit for the week of ' + wk + ', but no held balance was recorded for ' + who + ' that week.');
      } else {
        clearsHeld = h.id;
        var hc = toCents(h.amount);
        lines.push({ account: cfg.held_account, debit: 0, credit: hc, cls: '', location: loc(mainCity),
          description: 'Clears cash held by ' + who + ' for week of ' + wk });
        credit += hc;
      }
    }

    // --- over / short against what Pulsar (or the held balance) says was owed
    var overShort = 0;
    if (kind !== 'held') {
      overShort = debit - credit;   // > 0 means deposited + spent more than owed
      if (overShort > 0) {
        lines.push({ account: cfg.over_short_account, debit: 0, credit: overShort, cls: '', location: loc(mainCity),
          description: 'Cash over - ' + who });
        credit += overShort;
      } else if (overShort < 0) {
        lines.push({ account: cfg.over_short_account, debit: -overShort, credit: 0, cls: '', location: loc(mainCity),
          description: 'Cash short - ' + who });
        debit += -overShort;
      }
    }

    if (debit === 0 && credit === 0) problems.push('Nothing to post.');
    if (debit !== credit) problems.push('Entry does not balance (' + centsStr(debit) + ' vs ' + centsStr(credit) + ').');
    if (lines.some(function (l) { return !l.account; })) problems.push('A line has no QuickBooks account (finish the mapping).');

    var dates = deps.map(function (d) { return d.deposit_date || ''; }).sort();
    return {
      key: k,
      kind: kind,
      user_id: uid,
      user_name: who,
      week_start: wk,
      city_code: mainCity,
      location: loc(mainCity),
      journal_no: deps.length ? deps[0].deposit_number : ('HELD-' + W.replace(/-/g, '') + '-' + uid),
      date: kind === 'late' ? (dates[dates.length - 1] || input.week_end) : input.week_end,
      deposit_ids: deps.map(function (d) { return d.id; }),
      deposit_numbers: deps.map(function (d) { return d.deposit_number; }),
      pulsar_cash: cashCents,
      class_cash: classGross,
      over_short: overShort,
      held_amount: heldAmount,
      clears_held_id: clearsHeld,
      total: debit,
      lines: lines,
      problems: problems
    };
  });

  units.sort(function (a, b) {
    var ka = (a.kind === 'late' ? '0' : '1') + a.user_name;
    var kb = (b.kind === 'late' ? '0' : '1') + b.user_name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // Totals by account + class across the ready units.
  var tot = {};
  units.forEach(function (u) {
    if (u.problems.length) return;
    u.lines.forEach(function (l) {
      var tk = l.account + '|' + (l.cls || '');
      if (!tot[tk]) tot[tk] = { account: l.account, cls: l.cls || '', debit: 0, credit: 0 };
      tot[tk].debit += l.debit;
      tot[tk].credit += l.credit;
    });
  });
  var totals = Object.keys(tot).sort().map(function (k2) {
    var t = tot[k2];
    var net = t.debit - t.credit;
    return { account: t.account, cls: t.cls, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
  });

  return { units: units, totals: totals, problems: configProblems(cfg) };
}

/* -------------------------------------------------------------- CSV --- */

function csvCell(v) {
  var s = v == null ? '' : String(v);
  // Formula-injection guard: the bookkeeper opens this in Excel and descriptions
  // carry text techs typed.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function mdy(ymd) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? m[2] + '/' + m[3] + '/' + m[1] : '';
}

var CSV_HEADERS = ['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description', 'Name', 'Location', 'Class'];

// Only units with no problems are written.
function toCsv(units) {
  var out = [CSV_HEADERS.join(',')];
  units.forEach(function (u) {
    if (u.problems && u.problems.length) return;
    u.lines.forEach(function (l) {
      out.push([
        csvCell(u.journal_no),
        csvCell(mdy(u.date)),
        csvCell(l.account),
        l.debit ? centsStr(l.debit) : '',
        l.credit ? centsStr(l.credit) : '',
        csvCell(l.description),
        '',
        csvCell(l.location),
        csvCell(l.cls || '')
      ].join(','));
    });
  });
  return out.join('\r\n') + '\r\n';
}

module.exports = {
  SETTINGS_KEY: SETTINGS_KEY,
  defaultConfig: defaultConfig,
  normalizeConfig: normalizeConfig,
  loadConfig: loadConfig,
  saveConfig: saveConfig,
  configProblems: configProblems,
  taskKey: taskKey,
  classForTask: classForTask,
  suggestClass: suggestClass,
  royaltyGroup: royaltyGroup,
  allocate: allocate,
  buildWeek: buildWeek,
  toCsv: toCsv,
  centsStr: centsStr,
  toCents: toCents,
  mdy: mdy
};
