// routes/mcp.js
// Remote MCP server for Nova. Speaks JSON-RPC over HTTP (Streamable HTTP,
// JSON-response mode) and exposes the shared lib/novaTools.js registry to an
// external Claude. Bearer-token protected; the token is a Nova-issued JWT
// (same secret/claims as app login), so OAuth (next increment) just becomes
// another way to obtain one. No backticks anywhere (Windows-safe).

var express = require('express');
var jwt = require('jsonwebtoken');
var novaTools = require('../lib/novaTools');
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
function actorFromAuth(req) {
  var h = req.headers.authorization;
  if (!h || h.indexOf('Bearer ') !== 0) return null;
  try {
    var p = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    if (p.aud && p.aud !== resourceUrl(req)) return null;
    var actor = { id: p.id, email: p.email, name: p.name, role: p.role };
    if (p.role === 'owner') actor.role = 'admin';
    return actor;
  } catch (e) { return null; }
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
  var actor = actorFromAuth(req);
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
