// The customer call page: /c/<token>. No login. Texted when a call is created
// (setting dispatch_customer_link) or sent from the call screen.
// Plan: claude/nova-dispatch-new-call-plan.md, step 4 (Tony, 2026-10-13).
//
//   GET  /c/:token               status, ETA, the tech + vehicle photo, details
//   GET  /c/:token/photo/:slot   tech / vehicle photo, only once the call is acknowledged
//   POST /c/:token/edit          fix address, exact spot, vehicle, callback, a note
//   POST /c/:token/id            driver's license photo (private, for the tech)
//   POST /c/:token/cancel        cancel with a reason
//
// Edits and cancel lock once the tech is on scene. The page closes with the call.
// Mounted on '/c' in server.js, outside /api/, with its own rate limits (same
// shape as routes/invoiceLink.js). public/sw.js skips /c/.
// No backticks anywhere in this file (Windows corrupts them in .js).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const r2 = require('../utils/r2');
const cl = require('../utils/callLink');
const geo = require('../utils/geocode');
const zones = require('../utils/zones');

const router = express.Router();
const pageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: 'Too many requests. Please try again in a few minutes.' });
const postLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please try again in a few minutes.' } });

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function noStore(res) { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); }
function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function money(n) { var x = parseFloat(n); return isFinite(x) ? '$' + x.toFixed(2) : ''; }

async function loadByToken(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  const r = await pool.query(
    'SELECT j.*, c.name AS city_name, u.name AS tech_name, COALESCE(st.name, j.service_type) AS service_name ' +
    'FROM dispatch_jobs j LEFT JOIN cities c ON TRIM(c.code) = TRIM(j.city_code) ' +
    'LEFT JOIN users u ON u.id = j.assigned_to LEFT JOIN service_types st ON st.id = j.service_type_id ' +
    'WHERE j.customer_token = $1', [token]);
  return r.rows[0] || null;
}

async function customerEvent(jobId, event, detail) {
  try {
    await pool.query("INSERT INTO dispatch_job_events (job_id, event, user_id, user_name, detail) VALUES ($1,$2,NULL,'Customer',$3)",
      [jobId, event, detail ? String(detail).slice(0, 1000) : null]);
  } catch (e) { console.error('[callLink] event:', e.message); }
}

function simplePage(res, code, title, msg, phone) {
  noStore(res);
  res.status(code).set('Content-Type', 'text/html; charset=utf-8').send(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>' + esc(title) + '</title><style>' + CSS + '</style></head><body><div class="wrap">' +
    '<div class="top"><h1>' + esc(title) + '</h1></div><div class="sec"><p class="lead">' + esc(msg) + '</p>' +
    (phone ? '<a class="btn ghost" href="tel:' + esc(String(phone).replace(/[^0-9+]/g, '')) + '">Call us</a>' : '') +
    '</div></div></body></html>');
}

var CSS =
  '*{box-sizing:border-box}body{margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#1c1d21}' +
  '.wrap{max-width:480px;margin:0 auto;padding-bottom:28px}@media(min-width:700px){.wrap{padding-top:28px}.top{border-radius:14px 14px 0 0}}' +
  '.top{background:#1c1d21;color:#fff;padding:18px 20px}.brand{font-size:13px;color:#fdba74;font-weight:700;letter-spacing:.04em;text-transform:uppercase}' +
  '.top h1{margin:6px 0 0;font-size:22px}.top .sub{font-size:13px;color:#aaa;margin-top:4px}' +
  '.sec{background:#fff;border:1px solid #e2e4e8;border-radius:14px;padding:18px;margin:12px 14px 0}' +
  '.sec h2{margin:0 0 12px;font-size:16px}.lead{font-size:15px;line-height:1.55;margin:0 0 12px;color:#3a3d44}' +
  '.eta{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.eta b{font-size:40px;line-height:1}.eta b small{font-size:18px;color:#6b7280;font-weight:600}.eta span{font-size:15px;color:#3a3d44}' +
  '.steps{list-style:none;margin:16px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}' +
  '.steps li{font-size:11px;color:#6b7280}.steps li:before{content:"";display:block;height:6px;border-radius:3px;background:#e2e4e8;margin-bottom:6px}' +
  '.steps li.done{color:#15803d;font-weight:600}.steps li.done:before{background:#22c55e}.steps li.cur{color:#c2410c;font-weight:700}.steps li.cur:before{background:#f97316}' +
  '.price{margin-top:14px;font-size:14px;color:#3a3d44}' +
  '.tech{display:flex;align-items:center;gap:14px}.ph{width:84px;height:84px;border-radius:50%;flex:none;object-fit:cover;border:3px solid #f97316;background:#e7e9ee;' +
    'display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#6b7280}' +
  '.tech .n{font-size:20px;font-weight:700}.tech .r{font-size:13px;color:#6b7280;margin-top:2px}' +
  '.veh{margin-top:14px;width:100%;max-height:220px;object-fit:cover;border-radius:12px;display:block;background:#e7e9ee}' +
  '.hd{display:flex;align-items:center;gap:10px}.hd h2{flex:1;margin:0}' +
  'dl{margin:10px 0 0;display:grid;grid-template-columns:104px 1fr;gap:10px 12px;font-size:14px}dt{color:#6b7280}dd{margin:0;word-break:break-word}' +
  '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:52px;border-radius:12px;border:0;background:#f97316;color:#fff;' +
    'font:inherit;font-size:16px;font-weight:700;cursor:pointer;text-decoration:none;margin-top:10px}' +
  '.btn.ghost{background:#fff;color:#1c1d21;border:1px solid #d6d8dd;font-weight:600}.btn.danger{background:#fff;color:#b91c1c;border:1px solid #f3c4c4}' +
  '.btn[disabled]{opacity:.6}.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.two .btn{margin-top:0}' +
  '.link{background:none;border:0;color:#c2410c;font:inherit;font-weight:700;font-size:15px;padding:10px 4px;cursor:pointer}' +
  'label{display:block;font-size:13px;font-weight:600;color:#3a3d44;margin:12px 0 5px}' +
  'input,textarea,select{width:100%;border:1px solid #c9ccd2;border-radius:10px;padding:12px;font:inherit;font-size:16px;background:#fff;color:#1c1d21}' +
  'textarea{min-height:80px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.row2{display:grid;grid-template-columns:2fr 1fr;gap:8px}' +
  '.hide{display:none}.msg{font-size:14px;margin-top:10px}.msg.err{color:#b91c1c}.msg.ok{color:#15803d}' +
  '.ok{display:flex;gap:10px;align-items:center;background:#eefaf2;border:1px solid #bfe6cc;border-radius:12px;padding:12px;font-size:14px}' +
  '.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{border:1px solid #d6d8dd;border-radius:20px;padding:9px 14px;font:inherit;font-size:14px;background:#fff;cursor:pointer;color:#1c1d21}' +
  '.chip.on{background:#1c1d21;color:#fff;border-color:#1c1d21}' +
  '.fine{font-size:12px;color:#6b7280;text-align:center;padding:14px 18px 0;line-height:1.5}' +
  ':focus-visible{outline:3px solid #f97316;outline-offset:2px}';

var STEP_AT = { new: 0, assigned: 0, accepted: 1, enroute: 2, onscene: 3 };

function statusLine(j, tech) {
  if (j.status === 'onscene') return (tech || 'Your technician') + ' has arrived.';
  if (j.status === 'enroute') return (tech || 'Your technician') + ' is on the way.';
  if (j.status === 'accepted') return (tech || 'Your technician') + ' has your call and will head your way.';
  return 'We are lining up your technician.';
}

async function renderPage(j) {
  const brand = await cl.getSetting('company_name', 'Pop-A-Lock');
  const phone = await cl.getSetting('company_phone', '');
  const tech = cl.SHOW_TECH.indexOf(j.status) !== -1 ? firstName(j.tech_name) : '';
  const photos = tech ? await cl.photosFor(j.assigned_to) : { tech: null, vehicle: null };
  const editable = cl.CUSTOMER_EDITABLE.indexOf(j.status) !== -1;
  const at = STEP_AT[j.status] || 0;
  const first = firstName(j.customer_name);
  var minsLeft = null;
  if (j.eta_promised_at && j.status !== 'onscene') {
    minsLeft = Math.max(0, Math.round((new Date(j.eta_promised_at).getTime() - Date.now()) / 60000));
  }
  var h = '';
  h += '<div class="top"><div class="brand">' + esc(brand) + (j.city_name ? ' of ' + esc(j.city_name) : '') + '</div>' +
    '<h1>' + (first ? 'Hi ' + esc(first) + ', ' : '') + (j.status === 'onscene' ? 'your technician is there' : 'help is on the way') + '</h1>' +
    '<div class="sub">Call ' + esc(j.job_number || '') + (j.service_name ? ' &middot; ' + esc(j.service_name) : '') + '</div></div>';

  // Status
  h += '<div class="sec" aria-live="polite"><div class="eta">' +
    (minsLeft !== null ? '<b>' + minsLeft + '<small> min</small></b>' : '') +
    '<span>' + esc(statusLine(j, tech)) + '</span></div>' +
    '<ol class="steps" aria-label="Progress">' + ['Received', 'Tech assigned', 'On the way', 'Arrived'].map(function (n, i) {
      var c = i < at ? 'done' : (i === at ? (at === 3 ? 'done' : 'cur') : '');
      if (i === 0) c = 'done';
      return '<li class="' + c + '"' + (i === at ? ' aria-current="step"' : '') + '>' + n + '</li>';
    }).join('') + '</ol>' +
    (j.quoted_price !== null && j.quoted_price !== undefined
      ? '<div class="price">Quoted <b>' + esc(money(j.quoted_price)) + '</b> plus tax. Credit card payments include a processing surcharge.</div>' : '') +
    '</div>';

  // Tech + vehicle
  if (tech) {
    h += '<div class="sec"><h2>Your technician</h2><div class="tech">' +
      (photos.tech ? '<img class="ph" src="' + esc(j.customer_token) + '/photo/tech" alt="Photo of ' + esc(tech) + ', your technician">'
                   : '<div class="ph" aria-hidden="true">' + esc(tech.charAt(0)) + '</div>') +
      '<div><div class="n">' + esc(tech) + '</div><div class="r">Your ' + esc(brand) + ' technician</div></div></div>' +
      (photos.vehicle ? '<img class="veh" src="' + esc(j.customer_token) + '/photo/vehicle" alt="Photo of the service vehicle">' : '') +
      '</div>';
  }

  // Details + edit
  var veh = [j.vehicle_color, j.vehicle_year, j.vehicle_make, j.vehicle_model].filter(Boolean).join(' ');
  h += '<div class="sec" id="details"><div class="hd"><h2>Your details</h2>' +
    (editable ? '<button type="button" class="link" id="ed-open" aria-expanded="false" aria-controls="ed">Edit</button>' : '') + '</div>' +
    '<dl id="dl">' +
      '<dt>Where</dt><dd>' + esc([j.address, j.zip].filter(Boolean).join(', ') || '-') + '</dd>' +
      '<dt>Exact spot</dt><dd>' + esc(j.vehicle_location || '-') + '</dd>' +
      '<dt>Vehicle</dt><dd>' + esc(veh || '-') + '</dd>' +
      '<dt>Callback</dt><dd>' + esc(j.callback_phone || j.customer_phone || '-') + '</dd>' +
      (j.customer_note ? '<dt>Your note</dt><dd>' + esc(j.customer_note) + '</dd>' : '') +
    '</dl>' +
    (editable ? '<form id="ed" class="hide" novalidate>' +
      '<label for="f-address">Street address</label><input id="f-address" name="address" autocomplete="street-address" value="' + esc(j.address) + '">' +
      '<div class="row2"><div><label for="f-cross">Cross street</label><input id="f-cross" name="cross_street" value="' + esc(j.cross_street) + '"></div>' +
        '<div><label for="f-zip">Zip</label><input id="f-zip" name="zip" inputmode="numeric" autocomplete="postal-code" maxlength="10" value="' + esc(j.zip) + '"></div></div>' +
      '<label for="f-spot">Exact spot</label><input id="f-spot" name="vehicle_location" placeholder="Garage level 2, by the elevator" value="' + esc(j.vehicle_location) + '">' +
      '<div class="row3"><div><label for="f-year">Year</label><input id="f-year" name="vehicle_year" inputmode="numeric" maxlength="4" value="' + esc(j.vehicle_year) + '"></div>' +
        '<div><label for="f-make">Make</label><input id="f-make" name="vehicle_make" value="' + esc(j.vehicle_make) + '"></div>' +
        '<div><label for="f-model">Model</label><input id="f-model" name="vehicle_model" value="' + esc(j.vehicle_model) + '"></div></div>' +
      '<label for="f-color">Color</label><input id="f-color" name="vehicle_color" value="' + esc(j.vehicle_color) + '">' +
      '<label for="f-cb">Best number to reach you</label><input id="f-cb" name="callback_phone" type="tel" autocomplete="tel" value="' + esc(j.callback_phone || j.customer_phone) + '">' +
      '<label for="f-note">Anything the technician should know</label><textarea id="f-note" name="customer_note" maxlength="1000">' + esc(j.customer_note) + '</textarea>' +
      '<button type="submit" class="btn">Save changes</button><button type="button" class="btn ghost" id="ed-cancel">Never mind</button>' +
      '<div class="msg" id="ed-msg" role="status"></div></form>' : '') +
    '</div>';

  // Driver's license
  if (cl.OPEN.indexOf(j.status) !== -1) {
    h += '<div class="sec" id="idsec"><h2>Save time on arrival</h2>' +
      (j.id_image_r2_key
        ? '<div class="ok" role="status">&#10003; Your ID is on file. Your technician will confirm it on arrival.</div>'
        : '<p class="lead">Before we unlock, we check the vehicle is yours. Add a photo of your driver&#39;s license now and your technician can confirm it on the way. Only your technician and our office can see it.</p>') +
      '<div class="two"' + (j.id_image_r2_key ? ' style="margin-top:10px"' : '') + '>' +
        '<label class="btn" style="margin:0">Take photo<input type="file" accept="image/*" capture="environment" class="hide" data-id-file></label>' +
        '<label class="btn ghost" style="margin:0">' + (j.id_image_r2_key ? 'Replace' : 'Upload') + '<input type="file" accept="image/*" class="hide" data-id-file></label>' +
      '</div><div class="msg" id="id-msg" role="status"></div></div>';
  }

  // Call + cancel
  h += '<div class="sec">' +
    (phone ? '<a class="btn ghost" href="tel:' + esc(String(phone).replace(/[^0-9+]/g, '')) + '" style="margin-top:0">Call our office</a>' : '') +
    (editable ? '<button type="button" class="btn danger" id="cx-open" aria-expanded="false" aria-controls="cx">Cancel this call</button>' +
      '<form id="cx" class="hide" novalidate><h2 style="margin-top:14px">Cancel this call?</h2>' +
        '<div class="chips" role="group" aria-label="Reason">' +
          ['I got in another way', 'It is taking too long', 'I found someone else', 'I no longer need help'].map(function (r) {
            return '<button type="button" class="chip" data-reason="' + esc(r) + '" aria-pressed="false">' + esc(r) + '</button>';
          }).join('') + '</div>' +
        '<label for="cx-other">Anything else? (optional)</label><textarea id="cx-other" maxlength="500"></textarea>' +
        '<button type="submit" class="btn danger" style="background:#b91c1c;color:#fff;border:0">Yes, cancel my call</button>' +
        '<button type="button" class="btn ghost" id="cx-back">Keep my call</button>' +
        '<div class="msg" id="cx-msg" role="status"></div></form>'
      : '<p class="lead" style="margin:12px 0 0">Your technician is with you, so changes now go through them.</p>') +
    '</div>';
  h += '<div class="fine">This page is just for this call and stops working once the job is closed. It updates on its own.</div>';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
    '<title>Call ' + esc(j.job_number || '') + ' | ' + esc(brand) + '</title><base href="/c/"><style>' + CSS + '</style></head>' +
    '<body data-token="' + esc(j.customer_token) + '"><main class="wrap">' + h + '</main><script src="/js/callLinkPage.js?v=1"></script></body></html>';
}

async function closedPage(res, j) {
  const phone = await cl.getSetting('company_phone', '');
  if (j.status === 'cancelled') return simplePage(res, 410, 'This call was cancelled', 'If you still need help, give us a call and we will get someone out to you.', phone);
  return simplePage(res, 410, 'This call is closed', 'Thank you for choosing us. If you need anything else, give us a call.', phone);
}

router.get('/:token', pageLimiter, async function (req, res) {
  try {
    const j = await loadByToken(req.params.token);
    const phone = await cl.getSetting('company_phone', '');
    if (!j) return simplePage(res, 404, 'Link not found', 'This link is not valid. Please call us and we will help.', phone);
    if (cl.OPEN.indexOf(j.status) === -1) return closedPage(res, j);
    if (!j.customer_link_viewed_at) {
      await pool.query('UPDATE dispatch_jobs SET customer_link_viewed_at = NOW() WHERE id = $1', [j.id]);
      await customerEvent(j.id, 'customer_opened', 'Opened the call link');
    }
    noStore(res);
    res.set('Content-Type', 'text/html; charset=utf-8').send(await renderPage(j));
  } catch (err) {
    console.error('[callLink] page failed:', err);
    simplePage(res, 500, 'Something went wrong', 'We could not open this page right now. Please try again shortly.');
  }
});

router.get('/:token/photo/:slot', pageLimiter, async function (req, res) {
  try {
    const j = await loadByToken(req.params.token);
    if (!j || cl.OPEN.indexOf(j.status) === -1 || cl.SHOW_TECH.indexOf(j.status) === -1) return res.status(404).end();
    if (cl.PHOTO_SLOTS.indexOf(req.params.slot) === -1 || !r2.configured()) return res.status(404).end();
    const p = await pool.query('SELECT r2_key, mime FROM employee_photos WHERE user_id = $1 AND slot = $2', [j.assigned_to, req.params.slot]);
    if (!p.rows.length) return res.status(404).end();
    const buf = await r2.getObjectBuffer(p.rows[0].r2_key);
    noStore(res);
    res.set('Content-Type', p.rows[0].mime || 'image/jpeg').send(buf);
  } catch (err) {
    console.error('[callLink] photo failed:', err.message);
    res.status(404).end();
  }
});

function cleanStr(v, n) { return v === undefined || v === null ? null : String(v).trim().slice(0, n); }
var EDIT_FIELDS = { address: 255, cross_street: 255, zip: 12, vehicle_location: 255, vehicle_year: 8,
  vehicle_make: 60, vehicle_model: 60, vehicle_color: 40, callback_phone: 50, customer_note: 1000 };
var EDIT_LABEL = { address: 'address', cross_street: 'cross street', zip: 'zip', vehicle_location: 'exact spot',
  vehicle_year: 'vehicle year', vehicle_make: 'vehicle make', vehicle_model: 'vehicle model', vehicle_color: 'vehicle color',
  callback_phone: 'callback number', customer_note: 'note' };

router.post('/:token/edit', postLimiter, async function (req, res) {
  try {
    const j = await loadByToken(req.params.token);
    if (!j) return res.status(404).json({ error: 'This link is not valid.' });
    if (cl.CUSTOMER_EDITABLE.indexOf(j.status) === -1) {
      return res.status(409).json({ error: 'Your technician is already with you, so changes go through them now.' });
    }
    const b = req.body || {};
    const sets = [], vals = [], changed = [];
    Object.keys(EDIT_FIELDS).forEach(function (k) {
      if (b[k] === undefined) return;
      var v = cleanStr(b[k], EDIT_FIELDS[k]);
      if (v === '') v = null;
      var cur = j[k] === undefined || j[k] === null ? null : String(j[k]);
      if (k === 'callback_phone' && cur === null) cur = j.customer_phone || null;
      if ((v || null) === (cur || null)) return;
      vals.push(v); sets.push(k + ' = $' + vals.length); changed.push(k);
    });
    if (changed.indexOf('address') !== -1 && !b.address) return res.status(400).json({ error: 'Please enter the street address.' });
    if (changed.indexOf('zip') !== -1 && !/^\d{5}(-\d{4})?$/.test(String(b.zip || '').trim())) return res.status(400).json({ error: 'Please enter a 5-digit zip.' });
    if (changed.indexOf('callback_phone') !== -1 && !cl.e164(b.callback_phone)) return res.status(400).json({ error: 'Please enter a 10-digit phone number.' });
    if (!changed.length) return res.json({ ok: true, changed: [] });
    // A new callback number is also the number dispatch dials.
    if (changed.indexOf('callback_phone') !== -1) { vals.push(cleanStr(b.callback_phone, 50)); sets.push('customer_phone = $' + vals.length); }
    vals.push(j.id);
    await pool.query('UPDATE dispatch_jobs SET ' + sets.join(', ') + ', updated_at = NOW() WHERE id = $' + vals.length, vals);
    var note = 'Changed ' + changed.map(function (k) { return EDIT_LABEL[k]; }).join(', ');
    // A moved address gets a new map point and zone. The price is NOT changed
    // here (it is what the customer was told); dispatch is asked to check it.
    if (changed.indexOf('address') !== -1 || changed.indexOf('zip') !== -1) {
      var addr = b.address !== undefined ? cleanStr(b.address, 255) : j.address;
      var zip = b.zip !== undefined ? cleanStr(b.zip, 12) : j.zip;
      var point = null;
      try { point = await geo.geocode({ address: addr, city_state_zip: j.city_state_zip, zip: zip }); } catch (e) { point = null; }
      var zh = null;
      try { zh = await zones.resolve({ zip: zip, city_code: j.city_code, lat: point && point.lat, lon: point && point.lon }); } catch (e) { zh = null; }
      await pool.query('UPDATE dispatch_jobs SET lat = $1, lon = $2, geocode_accuracy = $3, zone_id = $4 WHERE id = $5',
        [point ? point.lat : null, point ? point.lon : null, point ? point.accuracy_type : null, zh && zh.zone ? zh.zone.id : j.zone_id, j.id]);
      note += '. New address: check the price and who is going.';
      if (zh && zh.wrong_city) note += ' The new zip belongs to another city.';
      if (zh && zh.out_of_area) note += ' The new address is outside our coverage.';
    }
    await customerEvent(j.id, 'customer_edit', note);
    await cl.notify(j, 'Customer updated ' + (j.job_number || 'a call'), note);
    res.json({ ok: true, changed: changed });
  } catch (err) {
    console.error('[callLink] edit failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again, or call us.' });
  }
});

router.post('/:token/id', postLimiter, async function (req, res) {
  try {
    const j = await loadByToken(req.params.token);
    if (!j) return res.status(404).json({ error: 'This link is not valid.' });
    if (cl.OPEN.indexOf(j.status) === -1) return res.status(409).json({ error: 'This call is closed.' });
    var stored;
    try { stored = await cl.storeDataUrl('dispatch/' + j.id + '/id', req.body && req.body.data); }
    catch (e) { console.error('[callLink] id store:', e.message); return res.status(502).json({ error: 'The photo did not upload. Please try again.' }); }
    if (stored.error) return res.status(400).json({ error: stored.error });
    const old = j.id_image_r2_key;
    await pool.query('UPDATE dispatch_jobs SET id_image_r2_key = $1, id_image_mime = $2, id_image_at = NOW() WHERE id = $3', [stored.key, stored.mime, j.id]);
    if (old && old !== stored.key) { try { await r2.deleteObject(old); } catch (e) {} }
    await customerEvent(j.id, 'customer_id', old ? 'Replaced their ID photo' : 'Added their ID photo');
    if (j.assigned_to) await cl.notify({ id: j.id, assigned_to: j.assigned_to }, 'ID on file for ' + (j.job_number || 'your call'), 'The customer added a photo of their ID.');
    res.json({ ok: true });
  } catch (err) {
    console.error('[callLink] id failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again, or call us.' });
  }
});

router.post('/:token/cancel', postLimiter, async function (req, res) {
  try {
    const j = await loadByToken(req.params.token);
    if (!j) return res.status(404).json({ error: 'This link is not valid.' });
    if (cl.CUSTOMER_EDITABLE.indexOf(j.status) === -1) {
      return res.status(409).json({ error: j.status === 'onscene' ? 'Your technician is already with you. Please talk to them.' : 'This call is already closed.' });
    }
    var reason = cleanStr((req.body && req.body.reason) || '', 300) || '';
    var other = cleanStr((req.body && req.body.other) || '', 500) || '';
    var why = [reason, other].filter(Boolean).join(' - ') || 'No reason given';
    // Conditional on the status so a tech pressing On scene at the same moment wins.
    const u = await pool.query(
      "UPDATE dispatch_jobs SET status = 'cancelled', status_since = NOW(), cancel_reason = $1, updated_at = NOW() " +
      'WHERE id = $2 AND status = ANY($3) RETURNING id', ['Customer: ' + why, j.id, cl.CUSTOMER_EDITABLE]);
    if (!u.rows.length) return res.status(409).json({ error: 'Your technician is already with you. Please talk to them.' });
    await customerEvent(j.id, 'cancelled', 'Cancelled by the customer: ' + why);
    await cl.notify(j, 'Customer cancelled ' + (j.job_number || 'a call'), why);
    res.json({ ok: true });
  } catch (err) {
    console.error('[callLink] cancel failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please call us to cancel.' });
  }
});

module.exports = router;
module.exports.renderPage = renderPage;
