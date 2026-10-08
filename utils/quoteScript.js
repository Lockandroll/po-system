// Dispatch Quote Script - the pricing engine (Phase 1: residential + commercial).
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files). Use string concatenation only.
//
// How res/com is priced (Tony, 2026-10-08 - see claude/nova-dispatch-quote-script-plan.md):
//
//   HOURLY (almost everything). First hour INCLUDES the trip; every hour after
//   that is billed in FULL hours. Separate residential and commercial rate
//   cards, per city, the same rate 24/7. Parts are extra and are quoted with ONE
//   line for everything ("most common locks start at $40"). Big jobs (master
//   key, access control, exit devices, storefront) are still hourly, plus a line
//   that the tech gives a full quote on site.
//
//   FLAT (a handful). Package price that already includes the trip and a set
//   number of units, plus a price per extra unit: rekey ($138.99 for 2 keyways
//   and 2 keys), key duplication (a visit rate plus a price per key), mailbox /
//   cabinet locks.
//
//   More than one job on the same trip is priced MANUALLY by the tech, so this
//   engine never stacks tasks. Lockouts carry a rekey upsell.
//
// Resolution order for the number:
//   1. the ACCOUNT's own rate (account + city, then account + all cities)
//   2. an account with nothing set -> vendors.quote_fallback: 'retail' quotes
//      retail, 'no_quote' (the default) refuses to quote. Defaulting to
//      no_quote means a national account never hears a retail price by accident.
//   3. RETAIL: the city's rate card (hourly) or the task's city price (flat)
//   4. nothing -> price_not_set, shown amber. Prices are NEVER seeded: a seeded
//      price is a wrong price quoted to a real customer.
// Then the coverage zone adjustment, ONCE, on the first hour or the flat total.
//
// Everything a quote depended on is returned in "snapshot" and stored on the
// dispatch_quotes row, so a price change next month never restates what a
// customer was told last Tuesday.
const { pool } = require('../db');
const zones = require('./zones');

const CATEGORIES = ['residential', 'commercial'];
// The Pulsar service type each category files under. Pay, royalty bucketing
// and the ETA windows all key off service_types, so the quote does too.
const SERVICE_CODE = { residential: 'RESLS', commercial: 'COMLS' };

const DEFAULT_PARTS_LINE = 'Parts are extra; most common locks start at $40.';
const DEFAULT_SURCHARGE = 'Cash and debit are that price. Credit cards carry a small processing surcharge.';

// Script sections in the order the dispatcher reads them.
const SECTIONS = ['greeting', 'qualify', 'price', 'policies', 'upsell', 'close_asap', 'close_scheduled'];
const SECTION_LABELS = {
  greeting: 'Greeting', qualify: 'Qualify', price: 'Price', policies: 'Policies',
  upsell: 'Upsell', close_asap: 'Close (ASAP)', close_scheduled: 'Close (scheduled)'
};

// Every block key the admin screen offers, with what it is for. Body text lives
// in quote_script_blocks (global row has category ''), so wording changes never
// need a deploy.
const BLOCK_KEYS = [
  { key: 'greeting', label: 'Greeting', help: 'Read at the top of every quote.' },
  { key: 'qualify', label: 'Qualify (default)', help: 'Used when a task has no questions of its own.' },
  { key: 'price_hourly', label: 'Price: hourly tasks', help: 'Fields: {first_hour} {addl_hour} {parts_line}' },
  { key: 'price_flat', label: 'Price: flat tasks', help: 'Fields: {price} {included} {task}' },
  { key: 'tech_confirms', label: 'Big jobs: tech quotes on site', help: 'Added after the price on tasks marked "tech quotes on site".' },
  { key: 'multi_task', label: 'More than one job', help: 'Other work on the same trip is priced by the tech.' },
  { key: 'no_quote', label: 'Account: do not quote', help: 'Read instead of a price when the account is billed per its terms.' },
  { key: 'policies', label: 'Policies (default)', help: 'Used when a task has no policy line of its own.' },
  { key: 'surcharge', label: 'Card surcharge', help: 'Read on every quote. Usually just {surcharge_disclosure}.' },
  { key: 'upsell', label: 'Upsell (default)', help: 'Fields: {upsell_task} {upsell_price} {upsell_included}' },
  { key: 'close_asap', label: 'Close: ASAP', help: 'Fields: {eta}' },
  { key: 'close_scheduled', label: 'Close: scheduled', help: 'Appointment time is booked in Pulsar.' }
];

function cleanCity(c) { return String(c || '').trim().toUpperCase().slice(0, 10); }
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function money(n) {
  if (n === null || n === undefined || !isFinite(Number(n))) return '';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function plural(label, qty) {
  const l = String(label || '').trim();
  if (Number(qty) === 1) return l;
  if (/(s|x|ch|sh)$/i.test(l)) return l + 'es';
  return l + 's';
}
// "2 keyways and 2 keys" / "1 lock" / ""
function unitsPhrase(parts) {
  const bits = (parts || []).filter(function (p) { return p.qty > 0; })
    .map(function (p) { return p.qty + ' ' + plural(p.label, p.qty); });
  if (!bits.length) return '';
  if (bits.length === 1) return bits[0];
  return bits.slice(0, -1).join(', ') + ' and ' + bits[bits.length - 1];
}
function fill(text, fields) {
  if (!text) return '';
  return String(text).replace(/\{([a-z0-9_]+)\}/gi, function (m, k) {
    return Object.prototype.hasOwnProperty.call(fields, k) && fields[k] !== null && fields[k] !== undefined ? String(fields[k]) : '';
  }).replace(/[ \t]{2,}/g, ' ').trim();
}

async function setting(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (r.rows.length && r.rows[0].value !== null && String(r.rows[0].value).trim() !== '') return String(r.rows[0].value);
  } catch (e) { /* fall through */ }
  return fallback;
}

async function loadBlocks() {
  const r = await pool.query('SELECT block_key, category, body FROM quote_script_blocks');
  const out = {};
  r.rows.forEach(function (b) { out[b.block_key + '|' + (b.category || '')] = b.body || ''; });
  return out;
}
// Category wording wins over global; a blank category row means "use global".
function block(blocks, key, category) {
  const c = blocks[key + '|' + (category || '')];
  if (c && String(c).trim()) return c;
  return blocks[key + '|'] || '';
}

async function rateCard(city, category) {
  const r = await pool.query(
    'SELECT first_hour, addl_hour FROM quote_rate_cards WHERE TRIM(city_code) = $1 AND category = $2',
    [cleanCity(city), category]);
  return r.rows[0] || null;
}

// A category is live in a city once its first-hour rate is set. Until then the
// panel hides it, so a half-set-up city can never produce a $0 quote.
async function liveMap() {
  const r = await pool.query('SELECT TRIM(city_code) AS city_code, category FROM quote_rate_cards WHERE first_hour IS NOT NULL');
  const out = {};
  r.rows.forEach(function (x) {
    out[x.city_code] = out[x.city_code] || {};
    out[x.city_code][x.category] = true;
  });
  return out;
}

async function taskWithUnits(taskId) {
  const t = await pool.query('SELECT * FROM quote_tasks WHERE id = $1', [taskId]);
  if (!t.rows.length) return null;
  const u = await pool.query('SELECT code, label, included_qty, sort FROM quote_task_units WHERE task_id = $1 ORDER BY sort, id', [taskId]);
  const task = t.rows[0];
  task.units = u.rows;
  return task;
}

async function flatPrices(taskId, city) {
  const c = cleanCity(city);
  const p = await pool.query('SELECT package_price FROM quote_flat_prices WHERE task_id = $1 AND TRIM(city_code) = $2', [taskId, c]);
  const u = await pool.query('SELECT unit_code, addl_price FROM quote_unit_prices WHERE task_id = $1 AND TRIM(city_code) = $2', [taskId, c]);
  const units = {};
  u.rows.forEach(function (x) { units[x.unit_code] = x.addl_price === null ? null : Number(x.addl_price); });
  return {
    package_price: p.rows.length && p.rows[0].package_price !== null ? Number(p.rows[0].package_price) : null,
    units: units
  };
}

// Most specific wins: this city, then '' (all cities).
async function accountRate(accountId, category, city) {
  const r = await pool.query(
    "SELECT first_hour, addl_hour, city_code FROM quote_account_rates " +
    "WHERE account_id = $1 AND category = $2 AND (TRIM(city_code) = $3 OR city_code = '') " +
    "ORDER BY (city_code <> '') DESC LIMIT 1",
    [accountId, category, cleanCity(city)]);
  return r.rows[0] || null;
}
async function accountTaskPrice(accountId, taskId, city) {
  const r = await pool.query(
    "SELECT package_price, unit_prices, city_code FROM quote_account_task_prices " +
    "WHERE account_id = $1 AND task_id = $2 AND (TRIM(city_code) = $3 OR city_code = '') " +
    "ORDER BY (city_code <> '') DESC LIMIT 1",
    [accountId, taskId, cleanCity(city)]);
  return r.rows[0] || null;
}

// The number for one task in one city for one (optional) account, before the
// zone. Returns { source, first_hour, addl_hour, package_price, unit_prices,
// missing } where source is 'account' | 'retail' | 'no_quote'.
async function baseNumbers(task, city, account) {
  const out = { source: 'retail', first_hour: null, addl_hour: null, package_price: null, unit_prices: {}, missing: false, account_rate_used: false };
  if (account) {
    if (task.pricing === 'hourly') {
      const ar = await accountRate(account.id, task.category, city);
      if (ar && ar.first_hour !== null) {
        out.source = 'account'; out.account_rate_used = true;
        out.first_hour = Number(ar.first_hour);
        out.addl_hour = ar.addl_hour === null ? null : Number(ar.addl_hour);
        return out;
      }
    } else {
      const ap = await accountTaskPrice(account.id, task.id, city);
      if (ap && ap.package_price !== null) {
        out.source = 'account'; out.account_rate_used = true;
        out.package_price = Number(ap.package_price);
        // An account row may override some unit prices and inherit the rest
        // from retail, so start from retail and lay the account's on top.
        const retail = await flatPrices(task.id, city);
        out.unit_prices = Object.assign({}, retail.units);
        const up = ap.unit_prices || {};
        Object.keys(up).forEach(function (k) { const v = numOrNull(up[k]); if (v !== null) out.unit_prices[k] = v; });
        return out;
      }
    }
    if ((account.quote_fallback || 'no_quote') !== 'retail') { out.source = 'no_quote'; return out; }
  }
  if (task.pricing === 'hourly') {
    const rc = await rateCard(city, task.category);
    out.first_hour = rc && rc.first_hour !== null ? Number(rc.first_hour) : null;
    out.addl_hour = rc && rc.addl_hour !== null ? Number(rc.addl_hour) : null;
    if (out.first_hour === null) out.missing = true;
  } else {
    const fp = await flatPrices(task.id, city);
    out.package_price = fp.package_price;
    out.unit_prices = fp.units;
    if (out.package_price === null) out.missing = true;
  }
  return out;
}

// What the upsell task would cost on the same terms, for the "while we're
// there" line. Only its package (included units), never the extras.
async function upsellFor(task, city, account) {
  if (!task.upsell_task_id) return null;
  const u = await taskWithUnits(task.upsell_task_id);
  if (!u || !u.active) return null;
  const n = await baseNumbers(u, city, account);
  var price = u.pricing === 'hourly' ? n.first_hour : n.package_price;
  if (n.source === 'no_quote') price = null;
  return {
    task_id: u.id, name: u.name, pricing: u.pricing,
    price: price,
    included: unitsPhrase(u.units.map(function (x) { return { label: x.label, qty: Number(x.included_qty) || 0 }; }))
  };
}

async function etaFor(category, city, accountId, zone) {
  try {
    const pricing = require('./pricing');
    const st = await pool.query('SELECT id FROM service_types WHERE code = $1', [SERVICE_CODE[category]]);
    if (!st.rows.length) return null;
    const q = await pricing.quote({ service_type_id: st.rows[0].id, city_code: cleanCity(city), account_id: accountId || null });
    if (!q || !q.eta_low) return null;
    var lo = q.eta_low, hi = q.eta_high || q.eta_low;
    if (zone) { lo = zones.applyEtaAdjust(lo, zone); hi = zones.applyEtaAdjust(hi, zone); }
    return { low: lo, high: hi };
  } catch (e) { return null; }
}
function etaText(eta) {
  if (!eta) return '';
  return eta.low === eta.high ? ('about ' + eta.low + ' minutes') : (eta.low + ' to ' + eta.high + ' minutes');
}

/**
 * Price one res/com task and build its script.
 * @param {object} o  city_code, task_id, quantities {unit_code: qty}, account_id, zip, dispatcher
 */
async function price(o) {
  const opts = o || {};
  const city = cleanCity(opts.city_code);
  const warnings = [];
  if (!city) return { error: 'Pick a city first.' };
  const task = await taskWithUnits(parseInt(opts.task_id, 10) || 0);
  if (!task || !task.active) return { error: 'That task is not available.' };

  var account = null;
  if (opts.account_id) {
    const a = await pool.query('SELECT id, name, quote_fallback FROM vendors WHERE id = $1', [parseInt(opts.account_id, 10) || 0]);
    account = a.rows[0] || null;
  }

  // Zone: from the zip, hinted by the city. Only a zone in THIS city adjusts
  // price; a zip that resolves to another market is flagged, not applied.
  var zone = null, outOfArea = false, wrongCity = false;
  if (opts.zip) {
    try {
      const hit = await zones.resolve({ zip: String(opts.zip).trim(), city_code: city });
      outOfArea = !!hit.out_of_area;
      wrongCity = !!hit.wrong_city;
      if (hit.zone && !wrongCity) zone = hit.zone;
    } catch (e) { /* no zone is not an error */ }
  }
  if (outOfArea) warnings.push({ key: 'out_of_area', text: 'This zip is outside the drawn coverage area.' });
  if (wrongCity) warnings.push({ key: 'wrong_city', text: 'This zip belongs to a different market. Check the city.' });

  const n = await baseNumbers(task, city, account);
  const lines = [];
  var total = null;
  var qtyOut = [];

  if (n.source === 'no_quote') {
    warnings.push({ key: 'no_quote', text: 'Account call: bill per account terms. Do not quote a price.' });
  } else if (task.pricing === 'hourly') {
    if (n.first_hour !== null) {
      total = n.first_hour;
      lines.push({ label: 'First hour (includes the trip)', amount: n.first_hour });
      if (n.addl_hour !== null) lines.push({ label: 'Each additional hour', amount: n.addl_hour, info: true });
    }
  } else if (n.package_price !== null) {
    const q = opts.quantities || {};
    const incParts = [];
    total = n.package_price;
    const incPhrase = unitsPhrase(task.units.map(function (u) { return { label: u.label, qty: Number(u.included_qty) || 0 }; }));
    lines.push({ label: task.name + (incPhrase ? ' (' + incPhrase + ')' : ''), amount: n.package_price });
    task.units.forEach(function (u) {
      const inc = Number(u.included_qty) || 0;
      var want = parseInt(q[u.code], 10);
      if (!isFinite(want) || want < 0) want = inc;
      if (want > 999) want = 999;
      incParts.push({ label: u.label, qty: want });
      qtyOut.push({ code: u.code, label: u.label, included: inc, qty: want, addl_price: n.unit_prices[u.code] === undefined ? null : n.unit_prices[u.code] });
      const extra = Math.max(0, want - inc);
      if (extra > 0) {
        const each = n.unit_prices[u.code];
        if (each === null || each === undefined) {
          warnings.push({ key: 'unit_price_not_set', text: 'No price set for an extra ' + u.label + ' in this city.' });
        } else {
          const amt = Math.round(extra * each * 100) / 100;
          total = Math.round((total + amt) * 100) / 100;
          lines.push({ label: '+' + extra + ' ' + plural(u.label, extra) + ' x ' + money(each), amount: amt });
        }
      }
    });
    task._includedNow = unitsPhrase(incParts);
  }

  if (n.missing) warnings.push({ key: 'price_not_set', text: 'Price not set for this ' + (task.pricing === 'hourly' ? task.category + ' rate card' : 'task') + ' in this city. Get a manager.' });

  var zoneAdj = null;
  if (total !== null && zone) {
    const adj = zones.applyPriceAdjust(total, zone);
    if (adj.adjust) {
      zoneAdj = adj.adjust;
      total = adj.price;
      lines.push({ label: 'Coverage zone: ' + zone.name, amount: adj.adjust });
    }
  }
  // For hourly the zone moves the first hour, which IS the quoted number.
  const firstHourQuoted = task.pricing === 'hourly' ? total : null;

  const eta = await etaFor(task.category, city, account ? account.id : null, zone);
  const upsell = n.source === 'no_quote' ? null : await upsellFor(task, city, account);

  // ---- script -------------------------------------------------------------
  const blocks = await loadBlocks();
  const partsLine = task.show_parts_line ? await setting('quote_parts_line', DEFAULT_PARTS_LINE) : '';
  const surcharge = await setting('quote_surcharge_disclosure', DEFAULT_SURCHARGE);
  const cityRow = await pool.query('SELECT name FROM cities WHERE TRIM(code) = $1', [city]);
  const fields = {
    task: task.name.toLowerCase(),
    city: cityRow.rows.length ? cityRow.rows[0].name : city,
    first_hour: money(firstHourQuoted),
    addl_hour: money(n.addl_hour),
    price: money(total),
    // A flat task with no units (mailbox lock) still needs a noun after "for".
    included: task._includedNow || ('the ' + task.name.toLowerCase()),
    eta: etaText(eta),
    parts_line: partsLine,
    surcharge_disclosure: surcharge,
    upsell_task: upsell ? upsell.name.toLowerCase() : '',
    upsell_price: upsell ? money(upsell.price) : '',
    upsell_included: upsell ? upsell.included : '',
    dispatcher: opts.dispatcher || '',
    account: account ? account.name : ''
  };
  qtyOut.forEach(function (u) { fields['unit_price_' + u.code] = money(u.addl_price); });

  const script = [];
  function add(section, text) { const t = fill(text, fields); if (t) script.push({ section: section, label: SECTION_LABELS[section], text: t }); }
  add('greeting', block(blocks, 'greeting', task.category));
  add('qualify', task.qualify_text || block(blocks, 'qualify', task.category));
  if (n.source === 'no_quote') {
    add('price', block(blocks, 'no_quote', task.category));
  } else if (total !== null) {
    var priceText = task.price_text || block(blocks, task.pricing === 'hourly' ? 'price_hourly' : 'price_flat', task.category);
    if (task.tech_confirms) priceText += ' ' + block(blocks, 'tech_confirms', task.category);
    priceText += ' ' + block(blocks, 'multi_task', task.category);
    add('price', priceText);
  }
  add('policies', (task.policy_text || block(blocks, 'policies', task.category)) + ' ' + block(blocks, 'surcharge', task.category));
  if (upsell && upsell.price !== null) add('upsell', task.upsell_text || block(blocks, 'upsell', task.category));
  add('close_asap', block(blocks, 'close_asap', task.category));
  add('close_scheduled', block(blocks, 'close_scheduled', task.category));

  const result = {
    task: { id: task.id, name: task.name, category: task.category, group_name: task.group_name, pricing: task.pricing,
      tech_confirms: !!task.tech_confirms, show_parts_line: !!task.show_parts_line, service_code: SERVICE_CODE[task.category] },
    city_code: city,
    account: account ? { id: account.id, name: account.name, fallback: account.quote_fallback || 'no_quote' } : null,
    source: n.source,
    total: total,
    first_hour: firstHourQuoted,
    addl_hour: n.addl_hour,
    parts_line: partsLine,
    quantities: qtyOut,
    lines: lines,
    zone: zone ? { id: zone.id, name: zone.name, price_adjust: zoneAdj } : null,
    out_of_area: outOfArea,
    eta: eta,
    upsell: upsell,
    warnings: warnings,
    price_missing: !!n.missing,
    script: script
  };
  return result;
}

module.exports = {
  CATEGORIES: CATEGORIES,
  SERVICE_CODE: SERVICE_CODE,
  BLOCK_KEYS: BLOCK_KEYS,
  SECTIONS: SECTIONS,
  DEFAULT_PARTS_LINE: DEFAULT_PARTS_LINE,
  DEFAULT_SURCHARGE: DEFAULT_SURCHARGE,
  cleanCity: cleanCity,
  numOrNull: numOrNull,
  money: money,
  unitsPhrase: unitsPhrase,
  fill: fill,
  liveMap: liveMap,
  taskWithUnits: taskWithUnits,
  price: price
};
