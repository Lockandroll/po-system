const jwt = require('jsonwebtoken');

// Validates the Microsoft "bootstrap" token returned by Office.auth.getAccessToken
// (Office SSO) and returns its claims. Identity-only: we read the email claim to
// map the signed-in Outlook user to a Nova account. No client secret, no
// On-Behalf-Of flow, no Graph call required.

var KEY_CACHE = {};         // kid -> PEM cert
var KEY_CACHE_AT = 0;
var CACHE_TTL_MS = 12 * 60 * 60 * 1000; // refresh signing keys every 12h

function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function certToPem(x5c) {
  var body = (x5c.match(/.{1,64}/g) || [x5c]).join('\n');
  return '-----BEGIN CERTIFICATE-----\n' + body + '\n-----END CERTIFICATE-----\n';
}

async function fetchJwks(jwksUri) {
  var res = await fetch(jwksUri);
  if (!res.ok) throw new Error('JWKS fetch failed: ' + res.status);
  var data = await res.json();
  var map = {};
  (data.keys || []).forEach(function (k) {
    if (k.kid && k.x5c && k.x5c.length) map[k.kid] = certToPem(k.x5c[0]);
  });
  return map;
}

async function getSigningKey(jwksUri, kid) {
  var now = Date.now();
  if (!KEY_CACHE[kid] || (now - KEY_CACHE_AT) > CACHE_TTL_MS) {
    KEY_CACHE = await fetchJwks(jwksUri);
    KEY_CACHE_AT = now;
  }
  if (!KEY_CACHE[kid]) {            // key rotation: force one refresh
    KEY_CACHE = await fetchJwks(jwksUri);
    KEY_CACHE_AT = now;
  }
  return KEY_CACHE[kid];
}

function decodeSegment(token, i) {
  var parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  return JSON.parse(b64urlToBuf(parts[i]).toString('utf8'));
}

// Verify signature, audience and issuer; return the decoded claims.
async function verifyOfficeSsoToken(token) {
  var clientId = process.env.ADDIN_SSO_CLIENT_ID;
  if (!clientId) throw new Error('ADDIN_SSO_CLIENT_ID not set');

  var header = decodeSegment(token, 0);
  if (!header.kid) throw new Error('Token has no kid');
  var unsafe = decodeSegment(token, 1);
  var tenantId = process.env.ADDIN_SSO_TENANT_ID || unsafe.tid;
  if (!tenantId) throw new Error('No tenant id in token');

  // The v2 metadata document points at the JWKS that signs both v1 and v2 tokens.
  var cfgUrl = 'https://login.microsoftonline.com/' + tenantId + '/v2.0/.well-known/openid-configuration';
  var cfgRes = await fetch(cfgUrl);
  if (!cfgRes.ok) throw new Error('OIDC config fetch failed: ' + cfgRes.status);
  var cfg = await cfgRes.json();

  var pem = await getSigningKey(cfg.jwks_uri, header.kid);
  if (!pem) throw new Error('Signing key not found for kid');

  // getAccessToken tokens may be v1 (aud = App ID URI) or v2 (aud = client id).
  var appIdUri = process.env.ADDIN_SSO_APP_ID_URI || ('api://www.popalockar.com/' + clientId);
  var audiences = [appIdUri, clientId];
  var issuers = [
    'https://login.microsoftonline.com/' + tenantId + '/v2.0',
    'https://sts.windows.net/' + tenantId + '/'
  ];

  return jwt.verify(token, pem, {
    algorithms: ['RS256'],
    audience: audiences,
    issuer: issuers
  });
}

module.exports = { verifyOfficeSsoToken };
