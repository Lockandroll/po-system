// routes/oauth.js
// OAuth 2.1 authorization server for Nova's remote MCP (routes/mcp.js).
// Implements: Protected Resource Metadata (RFC 9728), Authorization Server
// Metadata (RFC 8414), Dynamic Client Registration (RFC 7591), the
// authorization endpoint with a login + consent page, and the token endpoint
// with mandatory PKCE (S256) plus refresh-token rotation.
// Access tokens are Nova JWTs (same JWT_SECRET/claims as app login) so
// routes/mcp.js validates them unchanged. No backticks anywhere.

var express = require('express');
var crypto = require('crypto');
var bcrypt = require('bcryptjs');
var jwt = require('jsonwebtoken');
var pool = require('../db').pool;
var diag = require('../lib/diag');

var router = express.Router();
var urlenc = express.urlencoded({ extended: false });

var ACCESS_TTL_SEC = 3600;          // 1 hour access tokens
var REFRESH_TTL_DAYS = 60;
var CODE_TTL_SEC = 300;             // 5 minute auth codes
var SCOPE = 'nova';
var MAX_ATTEMPTS = 5;
var LOCKOUT_MINUTES = 15;

function baseUrl(req) {
  var proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  var host = req.headers['x-forwarded-host'] || req.headers.host;
  return proto + '://' + host;
}
function resourceUrl(req) { return baseUrl(req) + '/api/mcp'; }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest(); }
function randToken(n) { return b64url(crypto.randomBytes(n || 32)); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- Discovery: Protected Resource Metadata (RFC 9728) ----
function protectedResource(req, res) {
  diag.log('PRM fetched');
  res.json({
    resource: resourceUrl(req),
    authorization_servers: [baseUrl(req)],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header']
  });
}
router.get('/.well-known/oauth-protected-resource', protectedResource);
router.get('/.well-known/oauth-protected-resource/*', protectedResource);

// ---- Discovery: Authorization Server Metadata (RFC 8414) ----
function authServerMeta(req, res) {
  diag.log('AS-metadata fetched');
  var b = baseUrl(req);
  res.json({
    issuer: b,
    authorization_endpoint: b + '/oauth/authorize',
    token_endpoint: b + '/oauth/token',
    registration_endpoint: b + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    // Only 'none' (public client + PKCE) is advertised: the token endpoint does
    // not verify client secrets, so advertising client_secret_post would be a
    // false promise. Clients authenticate the auth code via PKCE (S256).
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE]
  });
}
router.get('/.well-known/oauth-authorization-server', authServerMeta);
router.get('/.well-known/oauth-authorization-server/*', authServerMeta);

// NOTE: the unauthenticated GET /oauth/debug diagnostic route was removed — it
// leaked client counts, timestamps, and internal diag events to anyone.

// ---- Dynamic Client Registration (RFC 7591) ----
router.post('/oauth/register', async function (req, res) {
  try {
    var b = req.body || {};
    diag.log('register POST ct=' + (req.headers['content-type']||'') + ' keys=' + Object.keys(b).join(','));
    var uris = b.redirect_uris;
    if (!Array.isArray(uris) || !uris.length) {
      diag.log('register 400: redirect_uris missing');
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' });
    }
    for (var i = 0; i < uris.length; i++) {
      if (!/^https?:\/\//i.test(uris[i])) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect URIs must be http(s)' });
      }
    }
    var clientId = 'nova_' + randToken(16);
    var clientSecret = randToken(32);
    var name = String(b.client_name || 'MCP Client').slice(0, 120);
    await pool.query(
      'INSERT INTO oauth_clients (client_id, client_secret, client_name, redirect_uris) VALUES ($1,$2,$3,$4)',
      [clientId, clientSecret, name, JSON.stringify(uris)]
    );
    diag.log('register OK client_id=' + clientId + ' uris=' + JSON.stringify(uris));
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post'
    });
  } catch (e) {
    diag.log('register ERROR ' + e.message);
    console.error('DCR failed:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

async function getClient(clientId) {
  if (!clientId) return null;
  var r = await pool.query('SELECT * FROM oauth_clients WHERE client_id=$1', [clientId]);
  if (!r.rows.length) return null;
  var c = r.rows[0];
  try { c.redirect_uris = JSON.parse(c.redirect_uris); } catch (e) { c.redirect_uris = []; }
  return c;
}

function page(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>' + esc(title) + '</title><style>' +
    'body{margin:0;background:#0f0f0f;color:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}' +
    '.card{width:100%;max-width:400px;background:#181818;border:1px solid #2a2a2a;border-radius:14px;padding:28px}' +
    '.brand{font-size:22px;font-weight:800;color:#f97316;margin:0 0 2px}' +
    '.sub{color:#9a9a9a;font-size:13px;margin:0 0 20px}' +
    'label{display:block;font-size:12px;color:#bdbdbd;margin:14px 0 5px}' +
    'input[type=email],input[type=password]{width:100%;box-sizing:border-box;padding:11px 12px;background:#0f0f0f;' +
    'border:1px solid #333;border-radius:8px;color:#fff;font-size:14px}' +
    '.row{display:flex;gap:10px;margin-top:20px}' +
    'button{flex:1;padding:11px;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer}' +
    '.allow{background:#f97316;color:#0f0f0f}.deny{background:#262626;color:#ddd}' +
    '.err{background:#3a1212;border:1px solid #7f1d1d;color:#fca5a5;padding:9px 11px;border-radius:8px;font-size:13px;margin:14px 0 0}' +
    '.scopes{background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:12px;margin-top:16px;font-size:13px;color:#cfcfcf}' +
    '.scopes b{color:#fff}.foot{color:#7a7a7a;font-size:11px;margin-top:18px;text-align:center}' +
    '</style></head><body><div class="card">' + inner + '</div></body></html>';
}

function errorPage(title, msg) {
  return page(title, '<p class="brand">Nova</p><p class="sub">Connection request</p>' +
    '<div class="err">' + esc(msg) + '</div>' +
    '<p class="foot">You can close this window.</p>');
}

function renderConsent(req, res, p, errorMsg) {
  var keys = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'response_type', 'resource'];
  var hidden = keys.map(function (k) { return '<input type="hidden" name="' + k + '" value="' + esc(p[k]) + '" />'; }).join('');
  var clientName = esc(p._client_name || 'An application');
  var inner = '<p class="brand">Nova</p><p class="sub">Connect your account</p>' +
    '<div class="scopes"><b>' + clientName + '</b> wants to connect to Nova and act <b>as you</b>. ' +
    'It will be able to see and do only what your role already allows. Sign in to approve.</div>' +
    (errorMsg ? ('<div class="err">' + esc(errorMsg) + '</div>') : '') +
    '<form method="POST" action="/oauth/authorize">' + hidden +
    '<label>Email</label><input type="email" name="email" autocomplete="username" required autofocus />' +
    '<label>Password</label><input type="password" name="password" autocomplete="current-password" required />' +
    '<div class="row">' +
    '<button class="deny" type="submit" name="decision" value="deny">Deny</button>' +
    '<button class="allow" type="submit" name="decision" value="allow">Allow</button>' +
    '</div></form>' +
    '<p class="foot">Only approve connections you started. Nova will never ask for your password anywhere else.</p>';
  res.set('Content-Type', 'text/html; charset=utf-8').send(page('Connect to Nova', inner));
}

function redirectError(res, p, code, desc) {
  var uri = p.redirect_uri;
  var sep = uri.indexOf('?') === -1 ? '?' : '&';
  var u = uri + sep + 'error=' + encodeURIComponent(code) +
    (desc ? ('&error_description=' + encodeURIComponent(desc)) : '') +
    (p.state ? ('&state=' + encodeURIComponent(p.state)) : '');
  res.redirect(302, u);
}

// ---- Authorization endpoint ----
router.get('/oauth/authorize', async function (req, res) {
  try {
    var q = req.query || {};
    diag.log('authorize GET client_id=' + q.client_id + ' redirect_uri=' + q.redirect_uri);
    var client = await getClient(q.client_id);
    if (!client) {
      try { var cc = await pool.query('SELECT COUNT(*)::int AS n FROM oauth_clients'); console.log('[oauth] unknown client_id=' + q.client_id + ' total=' + cc.rows[0].n); } catch (e) { console.error('[oauth] count failed: ' + e.message); }
      return res.status(400).send(errorPage('Unknown application', 'This application is not registered with Nova.'));
    }
    if (client.redirect_uris.indexOf(q.redirect_uri) === -1) {
      return res.status(400).send(errorPage('Invalid redirect', 'The redirect address does not match what was registered.'));
    }
    if (q.response_type !== 'code') return redirectError(res, q, 'unsupported_response_type');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return redirectError(res, q, 'invalid_request', 'PKCE with S256 is required');
    }
    q._client_name = client.client_name;
    renderConsent(req, res, q, null);
  } catch (e) {
    console.error('authorize GET failed:', e);
    res.status(500).send(errorPage('Something went wrong', 'Please try connecting again.'));
  }
});

router.post('/oauth/authorize', urlenc, async function (req, res) {
  try {
    var f = req.body || {};
    var client = await getClient(f.client_id);
    if (!client || client.redirect_uris.indexOf(f.redirect_uri) === -1) {
      return res.status(400).send(errorPage('Invalid request', 'Client or redirect address mismatch.'));
    }
    f._client_name = client.client_name;
    if (f.decision === 'deny') return redirectError(res, f, 'access_denied');
    if (!f.code_challenge || f.code_challenge_method !== 'S256') return redirectError(res, f, 'invalid_request', 'PKCE required');

    var email = (f.email || '').trim();
    var r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    var user = r.rows[0];
    if (!user) return renderConsent(req, res, f, 'Invalid email or password.');
    if (user.lockout_until && new Date(user.lockout_until) > new Date()) {
      return renderConsent(req, res, f, 'Account locked due to failed attempts. Try again later.');
    }
    var ok = await bcrypt.compare(f.password || '', user.password_hash || '');
    if (!ok) {
      var attempts = (user.failed_attempts || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await pool.query('UPDATE users SET failed_attempts=$1, lockout_until=$2 WHERE id=$3',
          [attempts, new Date(Date.now() + LOCKOUT_MINUTES * 60000), user.id]);
      } else {
        await pool.query('UPDATE users SET failed_attempts=$1 WHERE id=$2', [attempts, user.id]);
      }
      return renderConsent(req, res, f, 'Invalid email or password.');
    }
    if (user.active === false) return renderConsent(req, res, f, 'Your account has been deactivated.');
    await pool.query('UPDATE users SET failed_attempts=0, lockout_until=NULL WHERE id=$1', [user.id]);

    var code = randToken(32);
    var exp = new Date(Date.now() + CODE_TTL_SEC * 1000);
    await pool.query(
      'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [code, client.client_id, user.id, f.redirect_uri, f.code_challenge, SCOPE, exp]
    );
    var sep = f.redirect_uri.indexOf('?') === -1 ? '?' : '&';
    var url = f.redirect_uri + sep + 'code=' + encodeURIComponent(code) + (f.state ? ('&state=' + encodeURIComponent(f.state)) : '');
    res.redirect(302, url);
  } catch (e) {
    console.error('authorize POST failed:', e);
    res.status(500).send(errorPage('Something went wrong', 'Please try connecting again.'));
  }
});

// ---- Token endpoint ----
async function issueTokens(req, res, userId, clientId, scope) {
  var ur = await pool.query('SELECT id,email,name,role,active FROM users WHERE id=$1', [userId]);
  var u = ur.rows[0];
  if (!u || u.active === false) return res.status(400).json({ error: 'invalid_grant', error_description: 'user inactive' });
  var access = jwt.sign(
    { id: u.id, email: u.email, name: u.name, role: u.role, scope: scope || SCOPE, aud: resourceUrl(req), token_use: 'mcp' },
    process.env.JWT_SECRET, { expiresIn: ACCESS_TTL_SEC }
  );
  var refresh = randToken(48);
  var rexp = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [b64url(sha256(refresh)), clientId, u.id, scope || SCOPE, rexp]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SEC, refresh_token: refresh, scope: scope || SCOPE });
}

router.post('/oauth/token', urlenc, async function (req, res) {
  try {
    var b = req.body || {};
    var grant = b.grant_type;
    diag.log('token POST grant=' + grant + ' client_id=' + b.client_id);
    if (grant === 'authorization_code') {
      // Atomically claim the code to prevent replay: flip used=false -> true in a
      // single statement and treat 0 rows returned as an already-used/unknown code.
      // (A failed PKCE/mismatch below still consumes the code, which is safe.)
      var cr = await pool.query('UPDATE oauth_codes SET used = true WHERE code = $1 AND used = false RETURNING *', [b.code]);
      var row = cr.rows[0];
      if (!row || new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' });
      if (row.client_id !== b.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
      if (row.redirect_uri !== b.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect mismatch' });
      var challenge = b64url(sha256(b.code_verifier || ''));
      if (challenge !== row.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return issueTokens(req, res, row.user_id, row.client_id, row.scope);
    }
    if (grant === 'refresh_token') {
      var rt = b.refresh_token || '';
      var hash = b64url(sha256(rt));
      var rr = await pool.query('SELECT * FROM oauth_refresh_tokens WHERE token_hash=$1', [hash]);
      var rrow = rr.rows[0];
      if (!rrow || rrow.revoked || new Date(rrow.expires_at) < new Date()) return res.status(400).json({ error: 'invalid_grant' });
      if (rrow.client_id !== b.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client mismatch' });
      await pool.query('UPDATE oauth_refresh_tokens SET revoked=true WHERE token_hash=$1', [hash]);
      return issueTokens(req, res, rrow.user_id, rrow.client_id, rrow.scope);
    }
    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (e) {
    console.error('token endpoint failed:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
