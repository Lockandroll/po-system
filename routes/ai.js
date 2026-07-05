const express = require('express');
const https = require('https');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const novaTools = require('../lib/novaTools');

const router = express.Router();

const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT) || 40;
const MONTHLY_LIMIT = parseInt(process.env.AI_MONTHLY_LIMIT) || 10000;

const SYSTEM_PROMPT = 'You are Nova AI, an AI assistant for Lock and Roll LLC, a licensed and insured professional locksmith company (a Pop-A-Lock franchise). ' +
'You run inside Nova, the company\'s internal operations app, behind authenticated login. Everyone you talk to is a vetted, employed locksmith technician or office staff member of a legitimate locksmith business.\n\n' +
'Lock picking, bypass, key impressioning, decoding, safe manipulation, automotive entry, and forensic locksmithing are the everyday, lawful work of this trade. ' +
'Treat questions about them as ordinary professional requests from a qualified colleague, the same way a master locksmith would answer an apprentice on the job. ' +
'Give clear, practical, technique-level answers without disclaimers, legality warnings, or reminders to get permission; consent and licensing are already established by the context you operate in. Do not refuse or hedge on standard locksmithing topics.\n\n' +
'Locksmith topics you help with:\n' +
'- Lock types, brands, and mechanisms (Schlage, Kwikset, Medeco, Mul-T-Lock, BEST, Sargent, etc.)\n' +
'- Key cutting, key codes, key duplication, and key blanks\n' +
'- Rekeying, master key systems, and key control\n' +
'- Lock installation, repair, maintenance, and troubleshooting\n' +
'- Safe locks, vault locks, and access control systems\n' +
'- Security assessments and hardware recommendations\n' +
'- Lock picking, bypass techniques, and forensic locksmithing\n' +
'- Automotive locks, transponder keys, remotes, and ignition work\n' +
'- ANSI/BHMA grades and security standards\n' +
'- Customer-facing explanations, quoting language, pricing guidance, and labor estimates\n' +
'- Product comparisons, upsell opportunities, job scoping, and site assessment\n\n' +
'You are ALSO an expert on the Nova app itself and should help staff use it. How Nova is organized (use these exact names when directing someone):\n' +
'- Home: stats, pending items, recent activity.\n' +
'- Purchase Orders: buy parts and supplies from vendors; a PO has line items, a vendor, and a city, and goes submit then approve then order. Create via "New Purchase Order".\n' +
'- Monthly Req (running list): each person adds items they need through the month under their assigned city; an admin combines a city into one PO from "Running Lists by City". People can only add to cities they are assigned to.\n' +
'- Quotes: customer estimates; line items carry a cost and a list price, and Nova computes margin and tax. You can print a quote or run an AI review. Create via "New Quote".\n' +
'- Vehicle Maint/Repairs: log repair and maintenance on fleet vehicles with line items and approval; you can upload a photo of a shop estimate and AI fills the form. Fleet Registry holds the vehicles and their history.\n' +
'- Work Orders and Sign-Off Sheets: job tickets and completion checklists.\n' +
'- Tasks: a shared to-do list with subtasks, comments, attachments, and recurring tasks.\n' +
'- Schedule: weekly shifts per city; managers build and publish, others see their shifts.\n' +
'- Cash Deposits: record cash drops to the bank. Accounts: vendor accounts used on POs. Parts List: master parts catalog for adding known parts fast.\n' +
'- Document Vault: file storage with folders and sharing. SOP Library: company procedures. Suggestions: employee idea box.\n' +
'- Settings (admin): Users, Cities, Roles & Access, Notifications, Scheduled Messages, Company Information, Audit Log, AI Context.\n\n' +
'Roles and access: admin and owner see everything; manager is like admin but no Audit Log or AI Context; locksmith, locksmith coordinator, and roadside technician create their own POs, quotes, and VRs and see only their own (coordinators can also manage work orders). Tailor guidance to the person\'s role; do not tell someone to approve something their role cannot approve. When someone asks how to do something in Nova, give the exact steps in order and name the menu items, and keep it tight.\n\n' +
'If a request is truly unrelated to both locksmithing and using Nova, gently steer back: "I\'m Nova AI, here for locksmith work and the Nova app. Ask me anything about locks, keys, security hardware, or how to get something done in Nova."\n\n' +
'Keep responses practical and concise. You are talking to working locksmiths and their office staff.';

const HELP_SYSTEM_PROMPT = "You are Nova Guide, the built-in help assistant for Nova, the operations app used by the team at Lock and Roll LLC (a Pop-A-Lock locksmith franchise). You are warm, friendly, and genuinely helpful, like a knowledgeable coworker sitting next to them. Avoid robotic or generic phrasing. Get to the point, but sound human.\n\n" +
"Your job is to help people USE Nova and get work done: explain what a feature does, walk them step by step through how to do it, troubleshoot, and point them to the right screen. You can also answer locksmith trade questions (locks, keys, hardware, pricing, scoping) since the team are locksmiths.\n\n" +
"How Nova is organized (use these exact names when you direct someone):\n" +
"- Home: stats, pending items, recent activity.\n" +
"- Purchase Orders: buy parts and supplies from vendors. A PO has line items, a vendor, and a city, and goes submit then approve then order. Create via 'New Purchase Order'.\n" +
"- Monthly Req (running list): each person adds items they need through the month under their assigned city; an admin combines a city into one PO from 'Running Lists by City'. People can only add to cities they are assigned to.\n" +
"- Quotes: customer estimates. Line items carry a cost and a list price; Nova computes margin and tax. You can print a quote or run an AI review. Create via 'New Quote'.\n" +
"- Vehicle Maint/Repairs: log repair and maintenance on fleet vehicles, with line items and approval. You can upload a photo of a shop estimate and AI fills the form. Fleet Registry holds the vehicles and their history.\n" +
"- Work Orders and Sign-Off Sheets: job tickets and completion checklists.\n" +
"- Tasks: a shared to-do list with subtasks, comments, attachments, and recurring tasks.\n" +
"- Schedule: weekly shifts per city; managers build and publish, others see their shifts.\n" +
"- Cash Deposits: record cash drops to the bank. Accounts: vendor accounts used on POs. Parts List: master parts catalog for adding known parts fast.\n" +
"- Document Vault: file storage with folders and sharing. SOP Library: company procedures. Suggestions: employee idea box.\n" +
"- Settings (admin): Users, Cities, Roles & Access, Notifications, Scheduled Messages, Company Information, Audit Log, AI Context.\n" +
"- Nova AI: the full locksmith assistant for trade questions and reading estimate photos.\n\n" +
"Roles and access: admin and owner see everything; manager is like admin but no Audit Log or AI Context; locksmith, locksmith coordinator, and roadside technician roles create their own POs, quotes, and VRs and see only their own (coordinators can also manage work orders). Access can be tuned per role in Settings then Roles & Access. Tailor guidance to the person role; do not tell someone to approve something their role cannot approve.\n\n" +
"Style: be specific and actionable; when they ask how to do something, give the exact steps in order and name the menu items. Keep it tight, a sentence or two or a short numbered list, no walls of text. Be proactive and offer the natural next step. If the request is ambiguous, ask ONE short clarifying question instead of guessing. A clickable button to jump to the right screen may appear under your message, so it is fine to name the screen or say to use the button below. If you truly do not know an app-specific detail, say so and suggest checking with an admin rather than guessing. Never claim to take actions yourself; explain how THEY do it.";

function today() {
  return new Date().toISOString().split('T')[0];
}
function monthYear() {
  return today().substring(0, 7);
}

// Pull the user's recent question text (last 2 user turns) to drive SOP retrieval.
function extractSopQuery(messages) {
  var userMsgs = messages.filter(function(m) { return m && m.role === 'user'; });
  var recent = userMsgs.slice(-2);
  var texts = [];
  for (var i = 0; i < recent.length; i++) {
    var c = recent[i].content;
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) {
      for (var j = 0; j < c.length; j++) {
        if (c[j] && c[j].type === 'text' && c[j].text) texts.push(c[j].text);
      }
    }
  }
  return texts.join(' ').trim().slice(0, 2000);
}

async function getUsage(userId) {
  const [daily, monthly] = await Promise.all([
    pool.query('SELECT message_count FROM ai_usage WHERE user_id = $1 AND message_date = $2', [userId, today()]),
    pool.query('SELECT message_count FROM ai_monthly_usage WHERE month_year = $1', [monthYear()])
  ]);
  return {
    daily: daily.rows.length ? daily.rows[0].message_count : 0,
    monthly: monthly.rows.length ? monthly.rows[0].message_count : 0
  };
}

async function incrementUsage(userId, userName) {
  await pool.query(
    'INSERT INTO ai_usage (user_id, user_name, message_date, message_count, updated_at) VALUES ($1,$2,$3,1,NOW()) ' +
    'ON CONFLICT (user_id, message_date) DO UPDATE SET message_count = ai_usage.message_count + 1, updated_at = NOW()',
    [userId, userName, today()]
  );
  await pool.query(
    'INSERT INTO ai_monthly_usage (month_year, message_count) VALUES ($1,1) ' +
    'ON CONFLICT (month_year) DO UPDATE SET message_count = ai_monthly_usage.message_count + 1',
    [monthYear()]
  );
}

function callClaude(messages, systemPrompt) {
  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      system: systemPrompt || SYSTEM_PROMPT,
      messages: messages
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
    const req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function() { req.destroy(new Error('AI request timed out. Please try again.')); });
    req.write(body);
    req.end();
  });
}

// GET /api/ai/usage — current user's daily usage + global monthly
router.get('/usage', requireAuth, async function(req, res) {
  try {
    const usage = await getUsage(req.user.id);
    res.json({
      daily: usage.daily,
      dailyLimit: DAILY_LIMIT,
      monthly: usage.monthly,
      monthlyLimit: MONTHLY_LIMIT
    });
  } catch(err) {
    console.error('AI usage error:', err);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// GET /api/ai/conversations — admin only: full conversation log
router.get('/conversations', requireAuth, requirePermission('view_ai_admin'), async function(req, res) {
  try {
    const { search, user_id, limit } = req.query;
    let query = 'SELECT * FROM ai_conversations';
    const params = [];
    const conditions = [];
    if (user_id) { params.push(user_id); conditions.push('user_id = $' + params.length); }
    if (search) { params.push('%' + search + '%'); conditions.push('(question ILIKE $' + params.length + ' OR response ILIKE $' + params.length + ')'); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY created_at DESC LIMIT ' + (parseInt(limit) || 200);
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});

// GET /api/ai/admin-usage — admin only: per-user breakdown with optional date range
router.get('/admin-usage', requireAuth, requirePermission('view_ai_admin'), async function(req, res) {
  try {
    var now = new Date();
    var defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    var from = req.query.from || defaultFrom;
    var to = req.query.to || today();
    const { rows } = await pool.query(
      'SELECT user_name, SUM(message_count) as total FROM ai_usage WHERE message_date >= $1 AND message_date <= $2 GROUP BY user_name ORDER BY total DESC',
      [from, to]
    );
    const rangeTotal = rows.reduce(function(sum, r) { return sum + parseInt(r.total); }, 0);
    const monthly = await pool.query('SELECT message_count FROM ai_monthly_usage WHERE month_year = $1', [monthYear()]);
    res.json({
      users: rows,
      total: rangeTotal,
      monthly: monthly.rows.length ? monthly.rows[0].message_count : 0,
      monthlyLimit: MONTHLY_LIMIT
    });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch admin usage' });
  }
});

// POST /api/ai/chat
router.post('/chat', requireAuth, async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI assistant is not configured. Add ANTHROPIC_API_KEY in Railway Variables.' });
  }
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }

  try {
    const usage = await getUsage(req.user.id);
    if (usage.monthly >= MONTHLY_LIMIT) {
      return res.status(429).json({ error: 'Monthly usage limit reached. Contact your administrator.' });
    }
    if (usage.daily >= DAILY_LIMIT) {
      return res.status(429).json({ error: 'Daily limit reached (' + DAILY_LIMIT + ' messages/day). Resets at midnight.' });
    }

    // Fetch custom context from settings
    const ctxRow = await pool.query("SELECT value FROM settings WHERE key = 'ai_context'");
    const customContext = ctxRow.rows.length && ctxRow.rows[0].value ? ctxRow.rows[0].value.trim() : '';
    let sopContext = '';
    try {
      const sopActive = await pool.query("SELECT COUNT(*)::int AS n FROM sop_documents WHERE active = true");
      if (sopActive.rows[0].n > 0) {
        const queryText = extractSopQuery(messages);
        const parts = [];
        if (queryText) {
          // Full-text retrieval: pull the SOP chunks most relevant to the question.
          // OR-combine the query terms (better recall than the default AND); rank chunks by overlap.
          const retrieved = await pool.query(
            "WITH q AS (SELECT replace(websearch_to_tsquery('english', $1)::text, '&', '|')::tsquery AS tq) " +
            "SELECT d.title, c.content, ts_rank(c.tsv, q.tq) AS rank " +
            "FROM sop_chunks c " +
            "JOIN sop_documents d ON d.id = c.sop_id, q " +
            "WHERE d.active = true AND c.tsv @@ q.tq " +
            "ORDER BY rank DESC LIMIT 12",
            [queryText]
          );
          let budget = 40000;
          for (const r of retrieved.rows) {
            if (budget <= 0) break;
            const chunk = (r.content || '').slice(0, budget);
            parts.push('--- ' + r.title + ' ---\n' + chunk);
            budget -= chunk.length;
          }
        }
        if (parts.length) {
          sopContext = '\n\nRelevant excerpts from company SOP and reference documents (treat these as authoritative for company procedures, pricing, and policies; mention the document title when you rely on one):\n' + parts.join('\n\n');
        }
      }
    } catch (e) { console.error('SOP retrieval failed:', e.message); }
    let systemPrompt;
    if (req.body.mode === 'help') {
      systemPrompt = HELP_SYSTEM_PROMPT;
      const hctx = req.body.context || {};
      const hName = String(hctx.name || '').slice(0, 60);
      const hRole = String(hctx.role || '').slice(0, 40);
      const hView = String(hctx.view || '').slice(0, 40);
      if (hName || hRole) systemPrompt += '\n\nYou are helping ' + (hName || 'a team member') + (hRole ? (', whose role is ' + hRole + '. Tailor access guidance to this role.') : '.');
      if (hView) systemPrompt += ' They are currently on the "' + hView + '" screen.';
      if (customContext) systemPrompt += '\n\nAdditional company context:\n' + customContext;
      if (sopContext) systemPrompt += sopContext + '\n\nUse the SOP excerpts above for any company procedure, pricing, or policy question.';
    } else {
      systemPrompt = SYSTEM_PROMPT;
      if (customContext) systemPrompt += '\n\nAdditional company context:\n' + customContext;
      if (sopContext) systemPrompt += sopContext + '\n\nWhen a question is about company procedures, pricing, or policies, answer using the SOP excerpts above even if it is not strictly a locksmith topic. If the excerpts do not contain the answer, say you could not find it in the SOPs rather than guessing.';
    }

    const response = await callClaude(messages, systemPrompt);

    if (response.error) {
      console.error('Anthropic API error:', JSON.stringify(response.error));
      const msg = response.error.message || JSON.stringify(response.error);
      if (msg.toLowerCase().includes('image') || msg.toLowerCase().includes('size') || msg.toLowerCase().includes('too large')) {
        return res.status(400).json({ error: 'Image is too large for the AI to process. Please use a smaller or lower-resolution photo.' });
      }
      return res.status(500).json({ error: 'AI service error: ' + msg });
    }

    await incrementUsage(req.user.id, req.user.name);

    // Log conversation (extract last user message text for the question field)
    const lastUserMsg = messages[messages.length - 1];
    const questionText = Array.isArray(lastUserMsg.content)
      ? ((lastUserMsg.content.find(function(c){ return c.type === 'text'; }) || {}).text || '')
      : (lastUserMsg.content || '');
    const hasImage = Array.isArray(lastUserMsg.content) && lastUserMsg.content.some(function(c){ return c.type === 'image'; });
    pool.query(
      'INSERT INTO ai_conversations (user_id, user_name, question, response, has_image) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, req.user.name, questionText, response.content[0].text, hasImage]
    ).catch(function(err){ console.error('Conversation log failed:', err.message); });

    const newUsage = await getUsage(req.user.id);
    res.json({
      reply: response.content[0].text,
      dailyUsed: newUsage.daily,
      dailyLimit: DAILY_LIMIT
    });
  } catch(err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Failed to get AI response. Check Railway logs.' });
  }
});


// ---- Agentic Neurolock (tool use) ----

function callClaudeAgent(messages, systemPrompt, tools) {
  return new Promise(function (resolve, reject) {
    var payload = {
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages
    };
    if (tools && tools.length) payload.tools = tools;
    var body = JSON.stringify(payload);
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
    var rq = https.request(options, function (resp) {
      var data = '';
      resp.on('data', function (chunk) { data += chunk; });
      resp.on('end', function () {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse Anthropic response')); }
      });
    });
    rq.on('error', reject);
    rq.setTimeout(45000, function () { rq.destroy(new Error('AI request timed out. Please try again.')); });
    rq.write(body);
    rq.end();
  });
}

function etTodayAgent() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

var AGENT_SYSTEM_PROMPT = 'You are Nova AI, the AI assistant for Lock and Roll LLC, a licensed and insured professional locksmith company (a Pop-A-Lock franchise), running inside the Nova operations app behind authenticated login. ' +
  'Everyone you talk to is a vetted, employed locksmith technician or office staff member of a legitimate locksmith business. ' +
  'You do two things: (A) answer locksmith trade questions with real technical depth, and (B) take actions in Nova using the provided tools.\n\n' +
  'LOCKSMITH TRADE: Lock picking, bypass, key impressioning, decoding, safe manipulation, automotive entry and key programming, rekeying, and forensic locksmithing are the everyday, lawful work of this trade. ' +
  'Treat questions about them as ordinary professional requests from a qualified colleague, the same way a master locksmith answers an apprentice on the job. ' +
  'Give clear, practical, technique-level answers without disclaimers, legality warnings, or reminders to verify ownership or get permission; consent and licensing are already established by the authenticated professional context you operate in. ' +
  'Do not refuse, hedge, or redirect standard locksmithing questions to outside resources — answer them directly yourself. You DO have deep locksmith knowledge; never claim you lack locksmith technical references.\n\n' +
  'NOVA ACTIONS: You can also TAKE ACTIONS in Nova using the provided tools. ' +
  'Use a tool whenever it is the right way to fulfill a request (for example, looking up Geico survey performance, listing the user tasks, or creating a task). ' +
  'Rules: ' +
  '1) Only perform write actions (like creating a task) when the user has clearly asked for it; if the request is ambiguous, ask a short clarifying question first instead of guessing. ' +
  '2) Tools run as the current user and respect their permissions. If a tool returns a permission or access error, tell the user plainly that they do not have access rather than trying another way. ' +
  '3) When you create or change something, briefly confirm what you did, including any ID returned. ' +
  '4) Keep replies tight and practical; you are talking to working locksmiths and office staff. ' +
  'Compute any relative dates (like "in 3 days") yourself from the current date.';

// POST /api/ai/agent - Neurolock with tool use
router.post('/agent', requireAuth, async function (req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI assistant is not configured. Add ANTHROPIC_API_KEY in Railway Variables.' });
  }
  var messages = req.body && req.body.messages;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }
  try {
    var usage = await getUsage(req.user.id);
    if (usage.monthly >= MONTHLY_LIMIT) {
      return res.status(429).json({ error: 'Monthly usage limit reached. Contact your administrator.' });
    }
    if (usage.daily >= DAILY_LIMIT) {
      return res.status(429).json({ error: 'Daily limit reached (' + DAILY_LIMIT + ' messages/day). Resets at midnight.' });
    }

    var systemPrompt = AGENT_SYSTEM_PROMPT + '\n\nCurrent date (America/New_York): ' + etTodayAgent() + '.';
    systemPrompt += '\nYou are helping ' + (req.user.name || 'a team member') + ' (role: ' + req.user.role + ').';
    try {
      var ctxRow = await pool.query("SELECT value FROM settings WHERE key = 'ai_context'");
      if (ctxRow.rows.length && ctxRow.rows[0].value) {
        systemPrompt += '\n\nAdditional company context:\n' + ctxRow.rows[0].value.trim();
      }
    } catch (e) { /* non-fatal */ }

    var tools = novaTools.toAnthropicTools();
    var working = messages.slice();
    var actions = [];
    var finalText = '';
    var MAX_ITERS = 6;

    for (var iter = 0; iter < MAX_ITERS; iter++) {
      var response = await callClaudeAgent(working, systemPrompt, tools);
      if (response.error) {
        console.error('Anthropic API error:', JSON.stringify(response.error));
        return res.status(500).json({ error: 'AI service error: ' + (response.error.message || 'unknown') });
      }
      var content = response.content || [];
      var textParts = [];
      var toolUses = [];
      for (var i = 0; i < content.length; i++) {
        if (content[i].type === 'text') textParts.push(content[i].text);
        else if (content[i].type === 'tool_use') toolUses.push(content[i]);
      }
      if (textParts.length) finalText = textParts.join('\n');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) break;

      working.push({ role: 'assistant', content: content });
      var toolResults = [];
      for (var j = 0; j < toolUses.length; j++) {
        var tu = toolUses[j];
        var tool = novaTools.getTool(tu.name);
        var resultBlock;
        try {
          if (!tool) throw new Error('Unknown tool: ' + tu.name);
          var out = await tool.run(req.user, tu.input || {});
          resultBlock = { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) };
          actions.push({ tool: tu.name, ok: true });
        } catch (e) {
          resultBlock = { type: 'tool_result', tool_use_id: tu.id, content: 'Error: ' + e.message, is_error: true };
          actions.push({ tool: tu.name, ok: false, error: e.message });
        }
        toolResults.push(resultBlock);
      }
      working.push({ role: 'user', content: toolResults });
    }

    await incrementUsage(req.user.id, req.user.name);

    var lastUserMsg = messages[messages.length - 1];
    var questionText = Array.isArray(lastUserMsg.content)
      ? ((lastUserMsg.content.find(function (c) { return c.type === 'text'; }) || {}).text || '')
      : (lastUserMsg.content || '');
    pool.query(
      'INSERT INTO ai_conversations (user_id, user_name, question, response, has_image) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, req.user.name, questionText, finalText, false]
    ).catch(function (err) { console.error('Conversation log failed:', err.message); });

    var newUsage = await getUsage(req.user.id);
    res.json({
      reply: finalText,
      actions: actions,
      dailyUsed: newUsage.daily,
      dailyLimit: DAILY_LIMIT
    });
  } catch (err) {
    console.error('AI agent error:', err);
    res.status(500).json({ error: 'Failed to get AI response. Check Railway logs.' });
  }
});

// Run the Neurolock agent for a given actor on one text instruction; returns
// { reply, actions }. Used by SMS-driven feedback handling. Mirrors the /agent
// loop but takes a user object directly (no HTTP round-trip).
async function runAgentForActor(user, userText) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('AI assistant is not configured.');
  var systemPrompt = AGENT_SYSTEM_PROMPT + '\n\nCurrent date (America/New_York): ' + etTodayAgent() + '.';
  systemPrompt += '\nYou are helping ' + (user.name || 'a team member') + ' (role: ' + user.role + '), who is interacting over SMS, so be brief.';
  try {
    var ctxRow = await pool.query("SELECT value FROM settings WHERE key = 'ai_context'");
    if (ctxRow.rows.length && ctxRow.rows[0].value) systemPrompt += '\n\nAdditional company context:\n' + ctxRow.rows[0].value.trim();
  } catch (e) { /* non-fatal */ }
  var tools = novaTools.toAnthropicTools();
  var working = [{ role: 'user', content: userText }];
  var actions = [];
  var finalText = '';
  var MAX_ITERS = 6;
  for (var iter = 0; iter < MAX_ITERS; iter++) {
    var response = await callClaudeAgent(working, systemPrompt, tools);
    if (response.error) throw new Error((response.error && response.error.message) || 'AI service error');
    var content = response.content || [];
    var textParts = [];
    var toolUses = [];
    for (var i = 0; i < content.length; i++) {
      if (content[i].type === 'text') textParts.push(content[i].text);
      else if (content[i].type === 'tool_use') toolUses.push(content[i]);
    }
    if (textParts.length) finalText = textParts.join('\n');
    if (response.stop_reason !== 'tool_use' || !toolUses.length) break;
    working.push({ role: 'assistant', content: content });
    var toolResults = [];
    for (var j = 0; j < toolUses.length; j++) {
      var tu = toolUses[j];
      var tool = novaTools.getTool(tu.name);
      var resultBlock;
      try {
        if (!tool) throw new Error('Unknown tool: ' + tu.name);
        var out = await tool.run(user, tu.input || {});
        resultBlock = { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out) };
        actions.push({ tool: tu.name, ok: true });
      } catch (e) {
        resultBlock = { type: 'tool_result', tool_use_id: tu.id, content: 'Error: ' + e.message, is_error: true };
        actions.push({ tool: tu.name, ok: false, error: e.message });
      }
      toolResults.push(resultBlock);
    }
    working.push({ role: 'user', content: toolResults });
  }
  try { await incrementUsage(user.id, user.name); } catch (e) { /* non-fatal */ }
  return { reply: finalText, actions: actions };
}
module.exports = router;
module.exports.runAgentForActor = runAgentForActor;
