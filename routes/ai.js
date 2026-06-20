const express = require('express');
const https = require('https');
const { pool } = require('../db');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');

const router = express.Router();

const DAILY_LIMIT = parseInt(process.env.AI_DAILY_LIMIT) || 40;
const MONTHLY_LIMIT = parseInt(process.env.AI_MONTHLY_LIMIT) || 10000;

const SYSTEM_PROMPT = 'You are Neurolock, an AI assistant for Lock and Roll LLC, a professional locksmith company. ' +
'You help technicians and staff with locksmith-specific questions and tasks.\n\n' +
'Topics you can help with:\n' +
'- Lock types, brands, and mechanisms (Schlage, Kwikset, Medeco, Mul-T-Lock, BEST, Sargent, etc.)\n' +
'- Key cutting, key codes, key duplication, and key blanks\n' +
'- Rekeying, master key systems, and key control\n' +
'- Lock installation, repair, maintenance, and troubleshooting\n' +
'- Safe locks, vault locks, and access control systems\n' +
'- Security assessments and hardware recommendations\n' +
'- Lock picking, bypass techniques, and forensic locksmithing (for legitimate professional use)\n' +
'- Automotive locks, transponder keys, remotes, and ignition work\n' +
'- ANSI/BHMA grades and security standards\n' +
'- Customer-facing explanations and quoting language\n' +
'- Pricing guidance and labor estimates for common services\n' +
'- Product comparisons and upsell opportunities\n' +
'- Job scoping and site assessment questions\n\n' +
'If asked about anything unrelated to locksmithing, security hardware, or the locksmith trade, ' +
'respond with: "I\'m Neurolock, specialized for locksmith topics only. I can\'t help with that, ' +
'but ask me anything about locks, keys, or security hardware!"\n\n' +
'Keep responses practical and concise. You are talking to working locksmiths and their office staff.';

function today() {
  return new Date().toISOString().split('T')[0];
}
function monthYear() {
  return today().substring(0, 7);
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
    const systemPrompt = customContext ? SYSTEM_PROMPT + '\n\nAdditional company context:\n' + customContext : SYSTEM_PROMPT;

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

module.exports = router;
