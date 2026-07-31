// routes/mcp.js
// Remote MCP server for Nova. Speaks JSON-RPC over HTTP (Streamable HTTP,
// JSON-response mode) and exposes the shared lib/novaTools.js registry to an
// external Claude. Bearer-token protected; the token is a Nova-issued JWT
// (same secret/claims as app login), so OAuth (next increment) just becomes
// another way to obtain one. No backticks anywhere (Windows-safe).

var express = require('express');
var jwt = require('jsonwebtoken');
var novaTools = require('../lib/novaTools');
var pool = require('../db').pool;
var diag = require('../lib/diag');

var router = express.Router();

var SERVER_INFO = { name: 'Nova', version: '1.0.0' };
var PROTOCOL_VERSION = '2025-06-18';

// Where Claude should look to discover how to authenticate (served in Increment 2).
function resourceMetadataUrl(req) {
  var proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host + '/.well-known/oauth-protected-resource';
}

function resourceUrl(req) {
  var proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host + '/api/mcp';
}

// Resolve the acting Nova user from the bearer token (mirrors middleware/auth.js).
// Identity is taken from the DATABASE, never from the token's claims. A signed token
// only proves who minted it, not that the account is still active, still at that role,
// or still signed in - and this router is the front door to the entire tool registry.
async function actorFromAuth(req) {
  var h = req.headers.authorization;
  if (!h || h.indexOf('Bearer ') !== 0) return null;
  var p;
  try { p = jwt.verify(h.slice(7), process.env.JWT_SECRET); }
  catch (e) { return null; }
  if (p.aud && p.aud !== resourceUrl(req)) return null;
  // An Outlook add-in token is deliberately confined to /api/addin (middleware/auth.js).
  // It must not become a full-API credential by coming in through MCP instead.
  if (p.addin) return null;
  var r;
  try {
    r = await pool.query(
      'SELECT id, email, name, role, active, session_epoch, onboarding_status, offboarding_restricted FROM users WHERE id = $1',
      [p.id]
    );
  } catch (e) { return null; }  // fail closed: cannot confirm the account, do not act
  var u = r.rows[0];
  if (!u || u.active === false) return null;
  // Session revocation (password reset, forced sign-out) bumps session_epoch.
  if (p.se !== undefined && Number(u.session_epoch || 0) !== Number(p.se)) return null;
  // Someone still in onboarding, or already offboarding, does not get the tool surface.
  if (u.onboarding_status && u.onboarding_status !== 'complete') return null;
  if (u.offboarding_restricted === true) return null;
  var actor = { id: u.id, email: u.email, name: u.name, role: u.role };
  if (actor.role === 'owner') actor.role = 'admin';
  return actor;
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; }

async function handleOne(msg, actor) {
  var id = (msg && msg.id !== undefined) ? msg.id : null;
  var method = msg && msg.method;
  var params = (msg && msg.params) || {};

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    });
  }
  if (method === 'ping') return rpcResult(id, {});

  if (method === 'tools/list') {
    var tools = novaTools.TOOLS.map(function (t) {
      return { name: t.name, description: t.description, inputSchema: t.input_schema };
    });
    return rpcResult(id, { tools: tools });
  }

  if (method === 'tools/call') {
    var name = params.name;
    var args = params.arguments || {};
    var tool = novaTools.getTool(name);
    if (!tool) return rpcError(id, -32602, 'Unknown tool: ' + name);
    try {
      var out = await tool.run(actor, args);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true });
    }
  }

  return rpcError(id, -32601, 'Method not found: ' + method);
}

// Notifications (no id) require no response.
function isNotification(msg) {
  return msg && msg.method && (msg.id === undefined || msg.id === null) &&
    (msg.method.indexOf('notifications/') === 0);
}

router.post('/', async function (req, res) {
  diag.log('mcp POST auth=' + (req.headers.authorization ? 'yes' : 'no') + ' method=' + (req.body && !Array.isArray(req.body) ? req.body.method : 'batch'));
  // Every call is on a protected resource: require a valid token, otherwise
  // return 401 with WWW-Authenticate so Claude can start OAuth discovery.
  var actor = await actorFromAuth(req);
  if (!actor) {
    res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + resourceMetadataUrl(req) + '"');
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
  }

  var body = req.body;
  // Batch support.
  if (Array.isArray(body)) {
    var notifications = body.filter(isNotification);
    var requests = body.filter(function (m) { return !isNotification(m); });
    if (!requests.length) return res.status(202).end();
    var out = [];
    for (var i = 0; i < requests.length; i++) { out.push(await handleOne(requests[i], actor)); }
    return res.json(out);
  }

  if (isNotification(body)) return res.status(202).end();
  var result = await handleOne(body || {}, actor);
  return res.json(result);
});

// Some MCP clients open a GET for a server-to-client SSE stream. Nova uses
// JSON-response mode only, so we politely decline the stream.
router.get('/', function (req, res) { diag.log('mcp GET (sse decline)'); res.status(405).json(rpcError(null, -32000, 'Method Not Allowed')); });

module.exports = router;
