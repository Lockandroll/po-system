// AI classification for customer feedback. One Anthropic call per intake returns
// strict JSON: { category, sentiment, severity, summary }. Mirrors the direct
// HTTPS pattern in routes/ai.js. Never throws - returns null on any failure so
// intake falls back to the heuristic category and flags needs_review.
const https = require('https');

var MODEL = process.env.FEEDBACK_AI_MODEL || 'claude-opus-4-8';
var CATEGORIES = ['complaint', 'tech_conduct', 'service_quality', 'damage', 'billing', 'praise', 'other'];
var SENTIMENTS = ['negative', 'neutral', 'positive'];
var SEVERITIES = ['low', 'medium', 'high', 'critical'];

var SYSTEM = 'You triage customer feedback for a locksmith / roadside service company (Lock and Roll, a Pop-A-Lock franchise). ' +
  'Classify a single piece of customer feedback. Respond with ONLY a JSON object, no prose, no code fences. ' +
  'Schema: {"category": one of [complaint, tech_conduct, service_quality, damage, billing, praise, other], ' +
  '"sentiment": one of [negative, neutral, positive], ' +
  '"severity": one of [low, medium, high, critical], ' +
  '"summary": a single plain sentence under 160 characters}. ' +
  'Severity guide: critical = injury, legal threat, major property damage, or safety risk; ' +
  'high = vehicle/property damage, rude or unprofessional tech conduct, customer demanding a callback or refund; ' +
  'medium = service complaints or dissatisfaction without damage; low = minor gripes or neutral notes; praise is low.';

function extractJson(textOut) {
  if (!textOut) return null;
  try { return JSON.parse(textOut); } catch (e) {}
  var start = textOut.indexOf('{');
  var end = textOut.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(textOut.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

function callAnthropic(userText) {
  return new Promise(function (resolve, reject) {
    if (!process.env.ANTHROPIC_API_KEY) { resolve(null); return; }
    var body = JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }]
    });
    var options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    var req = https.request(options, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try {
          var parsed = JSON.parse(data);
          var txt = (parsed && parsed.content && parsed.content[0] && parsed.content[0].text) || '';
          resolve(txt);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(30000, function () { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// parsed = output of parsePulsarEmail. Returns { category, sentiment, severity,
// summary } or null.
async function classifyFeedback(parsed) {
  try {
    var ctx = [];
    if (parsed.conduct_type) ctx.push('Type: ' + parsed.conduct_type);
    if (parsed.service_task) ctx.push('Service task: ' + parsed.service_task);
    if (parsed.tech_name_raw) ctx.push('Tech: ' + parsed.tech_name_raw);
    ctx.push('Incident: ' + (parsed.incident_text || '(none provided)'));
    var txt = await callAnthropic(ctx.join('\n'));
    var obj = extractJson(txt);
    if (!obj) return null;
    var category = CATEGORIES.indexOf(obj.category) !== -1 ? obj.category : null;
    var sentiment = SENTIMENTS.indexOf(obj.sentiment) !== -1 ? obj.sentiment : null;
    var severity = SEVERITIES.indexOf(obj.severity) !== -1 ? obj.severity : null;
    var summary = (typeof obj.summary === 'string') ? obj.summary.slice(0, 240) : null;
    if (!category && !severity) return null;
    return { category: category, sentiment: sentiment, severity: severity, summary: summary };
  } catch (e) {
    console.error('[feedback] classify failed:', e.message);
    return null;
  }
}

module.exports = { classifyFeedback: classifyFeedback };
