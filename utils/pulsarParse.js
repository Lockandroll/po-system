// Deterministic parser for Pulsar (idssautomated.com) tech-conduct / feedback
// emails. These are fixed-template, so we extract fields by label rather than AI.
// Returns a plain object; never throws - unknown/blank fields come back as null.

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*(div|p|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(div|p|li|tr|td|h[1-6]|table|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

// 'Tech Conduct' -> 'tech_conduct'
function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function parseDate(s) {
  if (!s) return null;
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Map of normalized label -> field name on the result object.
var LABELS = {
  'customer name': 'customer_name',
  'contact email': 'customer_email',
  'vehicle make': 'vehicle_make',
  'vehicle model': 'vehicle_model',
  'vehicle year': 'vehicle_year',
  'task': 'service_task',
  'tech': 'tech_name_raw',
  'invoice': 'invoice_ref',
  'job location': 'job_location'
};

function parsePulsarEmail(input) {
  input = input || {};
  var subject = String(input.subject || '');
  var body = String(input.text || '').trim();
  if (!body) body = stripHtml(input.html);
  body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  var lines = body.split('\n');

  var out = {
    conduct_type: null, received_at: null, location_raw: null,
    customer_name: null, customer_phone: null, customer_email: null,
    vehicle_make: null, vehicle_model: null, vehicle_year: null,
    service_task: null, tech_name_raw: null, invoice_ref: null,
    job_location: null, incident_text: null, category_hint: null
  };

  var phones = { home: null, work: null, cell: null };
  var incidentParts = [];
  var inIncident = false;
  var sawFirstLabel = false;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (inIncident) {
      incidentParts.push(line);
      continue;
    }
    if (!trimmed) continue;

    var m = trimmed.match(/^([A-Za-z][A-Za-z /]*?):\s*(.*)$/);

    // The 'Tech Conduct on <date>' header and the '<ST> - <City>' location line
    // appear before the first labelled field.
    if (!sawFirstLabel && (!m || /^tech conduct on/i.test(trimmed))) {
      var hdr = trimmed.match(/^(.*?)\s+on\s+(.+)$/i);
      if (hdr && /conduct|complaint|feedback/i.test(hdr[1])) {
        out.conduct_type = hdr[1].trim();
        out.received_at = parseDate(hdr[2].trim());
        continue;
      }
      if (/^[A-Za-z]{2}\s*-\s*.+/.test(trimmed) && !out.location_raw) {
        out.location_raw = trimmed;
        continue;
      }
      if (!m) continue;
    }

    if (!m) continue;
    sawFirstLabel = true;
    var label = m[1].trim().toLowerCase();
    var value = (m[2] || '').trim();

    if (label === 'incident') {
      inIncident = true;
      if (value) incidentParts.push(value);
      continue;
    }
    if (label === 'home phone') { phones.home = value || null; continue; }
    if (label === 'work phone') { phones.work = value || null; continue; }
    if (label === 'cell phone') { phones.cell = value || null; continue; }
    if (LABELS[label]) { out[label === 'tech' ? 'tech_name_raw' : LABELS[label]] = value || null; }
  }

  out.customer_phone = phones.cell || phones.work || phones.home || null;
  var incident = incidentParts.join('\n').trim();
  out.incident_text = incident || null;

  // Category hint from the subject / header line.
  var src = (subject + ' ' + (out.conduct_type || '')).toLowerCase();
  if (/conduct/.test(src)) out.category_hint = 'tech_conduct';
  else if (/prais|compliment|thank/.test(src)) out.category_hint = 'praise';
  else if (/bill|charge|refund|price/.test(src)) out.category_hint = 'billing';
  else out.category_hint = 'complaint';

  return out;
}

module.exports = { parsePulsarEmail: parsePulsarEmail, stripHtml: stripHtml, slug: slug };
