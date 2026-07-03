// utils/hrCrypto.js
// Tier-2 application-layer encryption for sensitive HR / onboarding documents
// (driver's license, SSN card / birth certificate, insurance, registration).
//
// Files are AES-256-GCM encrypted in THIS server before they ever reach R2, and
// decrypted here only for an authorized reviewer. R2 therefore stores ciphertext
// only, and the bytes stream through the server (never a presigned plaintext URL).
// GCM is authenticated: any tampering with the stored blob fails decryption.
//
// The key lives in the HR_DOC_ENC_KEY env var (Railway) as base64 (or hex) of a
// 32-byte / 256-bit key. It never appears in code, DB, git or logs.
//
// No backticks in this file (Windows clipboard safety).

'use strict';

const crypto = require('crypto');
const r2 = require('./r2');

const IV_LEN = 12;   // 96-bit nonce, the GCM standard
const TAG_LEN = 16;  // 128-bit auth tag

// Parse HR_DOC_ENC_KEY into a 32-byte Buffer, or null if unset/invalid.
function keyBuffer() {
  const raw = (process.env.HR_DOC_ENC_KEY || '').trim();
  if (!raw) return null;
  try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) return b; } catch (e) {}
  try { const h = Buffer.from(raw, 'hex'); if (h.length === 32) return h; } catch (e) {}
  return null;
}

// True when a valid 256-bit key is present.
function configured() { return !!keyBuffer(); }

// True when we can actually store encrypted docs (key + R2 both ready).
function storageReady() { return configured() && r2.configured(); }

// Encrypt a plaintext Buffer. Returns a single Buffer packed as [iv|tag|cipher].
function encrypt(plaintext) {
  const key = keyBuffer();
  if (!key) throw new Error('HR_DOC_ENC_KEY not set or not a 32-byte base64/hex value');
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

// Decrypt a packed [iv|tag|cipher] Buffer back to plaintext. Throws if the key
// is wrong or the blob was tampered with.
function decrypt(packed) {
  const key = keyBuffer();
  if (!key) throw new Error('HR_DOC_ENC_KEY not set or not a 32-byte base64/hex value');
  if (!Buffer.isBuffer(packed) || packed.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('ciphertext too short or not a buffer');
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

// Build a unique R2 object key under the hr/ prefix, namespaced by user.
function hrKey(userId, originalName) {
  const rand = crypto.randomBytes(8).toString('hex');
  const safe = String(originalName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
  return 'hr/' + (parseInt(userId, 10) || 0) + '/' + Date.now() + '-' + rand + '-' + safe;
}

// Encrypt a plaintext Buffer and store the ciphertext in R2 at key.
async function putEncrypted(key, plaintextBuffer) {
  return r2.putObject(key, encrypt(plaintextBuffer), 'application/octet-stream');
}

// Fetch ciphertext from R2 at key and return the decrypted plaintext Buffer.
async function getDecrypted(key) {
  const packed = await r2.getObjectBuffer(key);
  return decrypt(packed);
}

module.exports = { configured, storageReady, encrypt, decrypt, hrKey, putEncrypted, getDecrypted };
