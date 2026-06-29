const https = require('https');

// Rough HTML -> text so the model gets readable content from HTML-only emails.
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function etTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function callClaudeJSON(systemPrompt, userText) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userText }]
    });
    const options = {
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
    const r = https.request(options, function (res) {
      var data = '';
      res.on('data', function (c) { data += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, function () { r.destroy(new Error('AI request timed out')); });
    r.write(body);
    r.end();
  });
}

// Turn an email into a normalized task object:
//   { title, description, priority, due_date, assignee }
// `input` = { subject, text, html, fromName }
async function parseEmailToTask(input) {
  input = input || {};
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const subject = String(input.subject || '').slice(0, 300);
  var bodyText = String(input.text || '').trim();
  if (!bodyText && input.html) bodyText = htmlToText(input.html);
  bodyText = bodyText.slice(0, 12000);

  const sys =
    'You convert a forwarded email into a single actionable task for a locksmith company operations app (Nova). ' +
    'The person forwarding the email may type a short instruction at the very top, before the forwarded content. ' +
    'Treat that instruction as the highest-priority signal for the title, due date, and who to assign. ' +
    'Today is ' + etTodayStr() + ' in America/New_York. Resolve relative dates such as "Friday", "tomorrow", or "next week" to an absolute calendar date. ' +
    'Respond with ONLY a JSON object - no prose, no markdown code fences - with exactly these keys: ' +
    'title (a short imperative summary, about 80 characters max), ' +
    'description (1 to 4 sentences on what needs doing; keep key names, addresses, phone numbers, and dollar amounts), ' +
    'priority (one of: low, medium, high, urgent), ' +
    'due_date (YYYY-MM-DD, or null if none is implied), ' +
    'assignee (the name or email address of the specific person the email says to assign this to, or null if no one is named).';

  const userText =
    'Forwarded by: ' + (input.fromName || 'unknown') + '\n' +
    'Subject: ' + subject + '\n\n' +
    'Body:\n' + (bodyText || '(no body)');

  const resp = await callClaudeJSON(sys, userText);
  var raw = '';
  if (resp && Array.isArray(resp.content)) {
    for (var i = 0; i < resp.content.length; i++) {
      var block = resp.content[i];
      if (block && block.type === 'text' && block.text) raw += block.text;
    }
  }
  raw = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  var obj = {};
  try { obj = JSON.parse(raw); }
  catch (e) {
    var m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { obj = {}; } }
  }

  const PRI = ['low', 'medium', 'high', 'urgent'];
  var priority = String(obj.priority || 'medium').toLowerCase();
  if (PRI.indexOf(priority) === -1) priority = 'medium';

  var due = obj.due_date;
  if (due == null) due = null;
  else { due = String(due).trim(); if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) due = null; }

  return {
    title: String(obj.title || subject || 'New task from email').trim().slice(0, 200),
    description: String(obj.description || '').trim(),
    priority: priority,
    due_date: due,
    assignee: obj.assignee ? String(obj.assignee).trim() : null
  };
}

module.exports = { parseEmailToTask, htmlToText };
