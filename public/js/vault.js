/* Nova Secure Vault — owner-only, SHARED, zero-knowledge credential store.
 *
 * One shared data key (DEK) encrypts every entry. Each owner has a personal
 * RSA keypair: their private key is encrypted under their own master password
 * (and their own recovery key), and the shared DEK is wrapped to each owner's
 * PUBLIC key. So nothing secret — master passwords, recovery keys, private keys,
 * the DEK, plaintext — ever reaches the server. A new owner is admitted when an
 * existing owner wraps the shared DEK to the newcomer's public key, all in-browser.
 *
 * House style: string concatenation only, no template literals/backticks.
 */

var VAULT_ITER = 600000;                 // PBKDF2-SHA256 iterations
var VAULT_AUTOLOCK_MS = 5 * 60 * 1000;   // re-lock after 5 min idle
var VAULT_CLIP_CLEAR_MS = 30 * 1000;     // wipe copied password from clipboard

/* ---- byte / encoding helpers --------------------------------------------- */
function vaultRand(n){ return crypto.getRandomValues(new Uint8Array(n)); }
function vaultB64(bytes){ var s=''; for(var i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]); return btoa(s); }
function vaultUnB64(str){ var bin=atob(str); var out=new Uint8Array(bin.length); for(var i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i); return out; }
function vaultHex(bytes){ var s=''; for(var i=0;i<bytes.length;i++){ var h=bytes[i].toString(16); if(h.length<2) h='0'+h; s+=h; } return s; }
function vaultUnHex(hex){ var out=new Uint8Array(hex.length/2); for(var i=0;i<out.length;i++) out[i]=parseInt(hex.substr(i*2,2),16); return out; }
function vaultB32(bytes){
  var A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', out='', bits=0, val=0;
  for(var i=0;i<bytes.length;i++){ val=(val<<8)|bytes[i]; bits+=8; while(bits>=5){ out+=A[(val>>>(bits-5))&31]; bits-=5; } }
  if(bits>0) out+=A[(val<<(5-bits))&31];
  return out;
}
function vaultGroupKey(s){ return (s.match(/.{1,4}/g) || []).join('-'); }
function vaultNormKey(s){ return String(s||'').toUpperCase().replace(/[^A-Z2-7]/g,''); }

/* ---- crypto core --------------------------------------------------------- */
async function vaultDeriveKEK(password, saltBytes, iterations){
  var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return await crypto.subtle.deriveKey(
    { name:'PBKDF2', salt: saltBytes, iterations: iterations, hash:'SHA-256' },
    base, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
  );
}
async function vaultGenDEK(){ return await crypto.subtle.generateKey({ name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']); }
async function vaultGenKeypair(){
  return await crypto.subtle.generateKey(
    { name:'RSA-OAEP', modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:'SHA-256' },
    true, ['encrypt','decrypt']
  );
}
async function vaultExportPub(pub){ return vaultB64(new Uint8Array(await crypto.subtle.exportKey('spki', pub))); }
async function vaultImportPub(b64){ return await crypto.subtle.importKey('spki', vaultUnB64(b64), { name:'RSA-OAEP', hash:'SHA-256' }, false, ['encrypt']); }
async function vaultExportPrivBytes(priv){ return new Uint8Array(await crypto.subtle.exportKey('pkcs8', priv)); }
async function vaultImportPriv(bytes){ return await crypto.subtle.importKey('pkcs8', bytes, { name:'RSA-OAEP', hash:'SHA-256' }, true, ['decrypt']); }
async function vaultEncPriv(privBytes, kek){
  var iv = vaultRand(12);
  var ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: iv }, kek, privBytes));
  return JSON.stringify({ iv: vaultB64(iv), ct: vaultB64(ct) });
}
async function vaultDecPriv(encJson, kek){
  var o = JSON.parse(encJson);
  var raw = await crypto.subtle.decrypt({ name:'AES-GCM', iv: vaultUnB64(o.iv) }, kek, vaultUnB64(o.ct)); // throws on wrong key
  return new Uint8Array(raw);
}
async function vaultWrapDekTo(dek, pub){
  var raw = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  return vaultB64(new Uint8Array(await crypto.subtle.encrypt({ name:'RSA-OAEP' }, pub, raw)));
}
async function vaultUnwrapDek(b64, priv){
  var raw = await crypto.subtle.decrypt({ name:'RSA-OAEP' }, priv, vaultUnB64(b64));
  return await crypto.subtle.importKey('raw', new Uint8Array(raw), { name:'AES-GCM', length:256 }, true, ['encrypt','decrypt']);
}
async function vaultEncEntry(obj, dek){
  var iv = vaultRand(12);
  var ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: iv }, dek, new TextEncoder().encode(JSON.stringify(obj))));
  return { iv: vaultHex(iv), ciphertext: vaultB64(ct) };
}
async function vaultDecEntry(ivHex, ctB64, dek){
  var pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: vaultUnHex(ivHex) }, dek, vaultUnB64(ctB64));
  return JSON.parse(new TextDecoder().decode(pt));
}

// Build a fresh per-owner identity (keypair + encrypted private key + recovery).
async function vaultBuildIdentity(masterPw){
  var kp = await vaultGenKeypair();
  var pubB64 = await vaultExportPub(kp.publicKey);
  var privBytes = await vaultExportPrivBytes(kp.privateKey);
  var saltB = vaultRand(16);
  var kek = await vaultDeriveKEK(masterPw, saltB, VAULT_ITER);
  var encPriv = await vaultEncPriv(privBytes, kek);
  var recBytes = vaultRand(20);
  var recKey = vaultGroupKey(vaultB32(recBytes));
  var recSaltB = vaultRand(16);
  var recKek = await vaultDeriveKEK(vaultNormKey(recKey), recSaltB, VAULT_ITER);
  var encPrivRec = await vaultEncPriv(privBytes, recKek);
  return {
    keyPair: kp, pubB64: pubB64,
    kdf_salt: vaultHex(saltB), enc_private_key: encPriv,
    recovery_salt: vaultHex(recSaltB), enc_private_key_recovery: encPrivRec,
    recoveryKey: recKey
  };
}

/* ---- transport ----------------------------------------------------------- */
async function vaultApi(method, path, body){
  var opts = { method: method, headers: { 'Content-Type':'application/json' } };
  if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
  if (state.vault && state.vault.token) opts.headers['X-Vault-Token'] = state.vault.token;
  if (body) opts.body = JSON.stringify(body);
  var res;
  try { res = await fetch('/api/vault' + path, opts); }
  catch(e){ throw new Error('Network error — could not reach the server.'); }
  var nt = res.headers.get('X-New-Token');
  if (nt){ state.token = nt; try { localStorage.setItem('po_token', nt); } catch(e){} }
  var data; try { data = await res.json(); } catch(e){ throw new Error('Server error (status ' + res.status + ').'); }
  if (res.status === 401 && data && data.locked){ vaultLockSilent(); render(); throw new Error(data.error || 'Vault locked.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed (status ' + res.status + ')');
  return data;
}
function vaultLogActivity(action, entryId){ vaultApi('POST','/audit',{ action: action, entry_id: entryId || null }).catch(function(){}); }

/* ---- state + lock lifecycle ---------------------------------------------- */
function vaultState(){ if (!state.vault) state.vault = { stage:'locked' }; return state.vault; }
function vaultLockSilent(){ var v = state.vault; if (v && v.lockTimer) clearTimeout(v.lockTimer); state.vault = { stage:'locked' }; }
function vaultAutoLock(){ if (state.vault && state.vault.dek){ vaultLogActivity('autolock'); } vaultLockSilent(); if (state.currentView==='vault') render(); }
function vaultBump(){ var v = vaultState(); if (v.lockTimer) clearTimeout(v.lockTimer); if (v.stage==='open') v.lockTimer = setTimeout(vaultAutoLock, VAULT_AUTOLOCK_MS); }
function vaultManualLock(){ if (state.vault && state.vault.dek){ vaultLogActivity('lock'); } vaultLockSilent(); render(); showToast('Vault locked.','info'); }

(function(){
  if (window.__vaultHooks) return; window.__vaultHooks = true;
  var _nav = window.navigate;
  window.navigate = function(view, param){ if (state.currentView==='vault' && view!=='vault' && state.vault && state.vault.dek){ vaultLockSilent(); } return _nav.apply(this, arguments); };
  var _logout = window.logout;
  if (typeof _logout === 'function'){ window.logout = function(){ vaultLockSilent(); return _logout.apply(this, arguments); }; }
  document.addEventListener('visibilitychange', function(){ if (document.hidden && state.vault && state.vault.dek){ vaultAutoLock(); } });
})();

/* ---- main render dispatch ------------------------------------------------ */
async function renderVault(content){
  if (!(state.user && state.user.isOwner) || state.realUser){
    content.innerHTML = '<div class="alert alert-error">Vault access is restricted to owners.</div>';
    return;
  }
  if (!window.crypto || !crypto.subtle){
    content.innerHTML = '<div class="alert alert-error">This browser does not support the encryption required by the Vault. Use a modern browser over HTTPS.</div>';
    return;
  }
  var v = vaultState();
  if (v.stage === 'locked') return vaultRenderLocked(content);
  if (v.stage === 'awaiting-code') return vaultRenderGate(content);
  if (v.stage === 'setup') return vaultRenderSetup(content);
  if (v.stage === 'request-access') return vaultRenderRequest(content);
  if (v.stage === 'show-recovery') return vaultRenderRecoveryReveal(content);
  if (v.stage === 'pending-wait') return vaultRenderPending(content);
  if (v.stage === 'unlock') return vaultRenderUnlock(content);
  if (v.stage === 'recover') return vaultRenderRecover(content);
  if (v.stage === 'open') return vaultRenderOpen(content);
  return vaultRenderLocked(content);
}

function vaultShell(inner){
  var lock = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--primary,#f97316)" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  return '<div style="max-width:640px;margin:0 auto">' +
    '<div style="text-align:center;margin:8px 0 22px">' + lock +
      '<h2 style="margin:10px 0 2px;font-size:22px">Secure Vault</h2>' +
      '<div style="color:var(--text-muted-color);font-size:13px">Shared among owners. End-to-end encrypted on each device.</div>' +
    '</div>' + inner + '</div>';
}
function vaultCard(inner){ return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:22px">' + inner + '</div>'; }

/* ---- stage: locked ------------------------------------------------------- */
function vaultRenderLocked(content){
  content.innerHTML = vaultShell(vaultCard(
    '<p style="margin:0 0 16px;color:var(--text-dim);font-size:14px;line-height:1.6">To open the Vault you must pass a fresh security check: a one-time code sent to you, plus your account password. The Vault is then decrypted locally with your personal master password.</p>' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultStartChallenge(this)">Unlock Vault</button>'
  ));
}
async function vaultStartChallenge(btn){
  if (btn){ btn.disabled = true; btn.textContent = 'Sending code…'; }
  try { var r = await vaultApi('POST','/challenge', {}); var v = vaultState(); v.via = r.via; v.stage = 'awaiting-code'; render(); }
  catch(e){ if (btn){ btn.disabled=false; btn.textContent='Unlock Vault'; } showToast(e.message,'error'); }
}

/* ---- stage: gate --------------------------------------------------------- */
function vaultRenderGate(content){
  var v = vaultState();
  var dest = v.via === 'sms' ? 'your phone by text' : 'your email';
  content.innerHTML = vaultShell(vaultCard(
    '<p style="margin:0 0 16px;color:var(--text-dim);font-size:14px">We sent a one-time code to ' + dest + '. Enter it along with your Nova account password.</p>' +
    '<label class="form-label">Unlock code</label>' +
    '<input id="vault-code" class="form-input" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" style="margin-bottom:14px;letter-spacing:4px;font-family:monospace">' +
    '<label class="form-label">Account password</label>' +
    '<input id="vault-pass" class="form-input" type="password" autocomplete="current-password" placeholder="Your Nova password" style="margin-bottom:18px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultVerifyGate(this)">Verify</button>' +
    '<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:10px" onclick="vaultStartChallenge(this)">Resend code</button>'
  ));
  var c = document.getElementById('vault-code'); if (c) c.focus();
  var p = document.getElementById('vault-pass');
  if (p) p.addEventListener('keydown', function(e){ if (e.key==='Enter') vaultVerifyGate(); });
}
async function vaultVerifyGate(btn){
  var code = (document.getElementById('vault-code')||{}).value || '';
  var pass = (document.getElementById('vault-pass')||{}).value || '';
  if (!code || !pass){ showToast('Enter both the code and your password.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Verifying…'; }
  try {
    var r = await vaultApi('POST','/verify-gate', { code: code, password: pass });
    var v = vaultState();
    v.token = r.vaultToken;
    v.vaultExists = r.vaultExists;
    v.membership = r.membership;
    if (r.membership && r.membership.status === 'active') v.stage = 'unlock';
    else if (r.membership && r.membership.status === 'pending') v.stage = 'pending-wait';
    else if (r.vaultExists) v.stage = 'request-access';
    else v.stage = 'setup';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Verify'; } showToast(e.message,'error'); }
}

/* ---- stage: first-owner setup -------------------------------------------- */
function vaultRenderSetup(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Create the Vault</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px;line-height:1.6">You are the first owner. Choose your master password — it encrypts the Vault and is never sent to the server, so it <b>cannot be recovered</b> if lost. You will also get a one-time recovery key. Other owners can request access later and you approve them.</p>' +
    '<label class="form-label">Your master password</label>' +
    '<input id="vault-mp1" class="form-input" type="password" autocomplete="new-password" placeholder="At least 10 characters" style="margin-bottom:14px">' +
    '<label class="form-label">Confirm master password</label>' +
    '<input id="vault-mp2" class="form-input" type="password" autocomplete="new-password" placeholder="Re-enter" style="margin-bottom:18px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultDoSetup(this)">Create Vault</button>'
  ));
}
async function vaultDoSetup(btn){
  var p1 = (document.getElementById('vault-mp1')||{}).value || '';
  var p2 = (document.getElementById('vault-mp2')||{}).value || '';
  if (p1.length < 10){ showToast('Master password must be at least 10 characters.','error'); return; }
  if (p1 !== p2){ showToast('Passwords do not match.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Encrypting…'; }
  try {
    var id = await vaultBuildIdentity(p1);
    var dek = await vaultGenDEK();
    var wrapped = await vaultWrapDekTo(dek, id.keyPair.publicKey);
    await vaultApi('POST','/setup', {
      public_key: id.pubB64, kdf_salt: id.kdf_salt, kdf_iterations: VAULT_ITER,
      enc_private_key: id.enc_private_key, wrapped_dek: wrapped,
      recovery_salt: id.recovery_salt, enc_private_key_recovery: id.enc_private_key_recovery
    });
    var v = vaultState();
    v.dek = dek; v.priv = id.keyPair.privateKey; v.entries = [];
    v.recoveryKey = id.recoveryKey; v.afterRecovery = 'open';
    v.stage = 'show-recovery';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Create Vault'; } showToast(e.message,'error'); }
}

/* ---- stage: request access (new owner) ----------------------------------- */
function vaultRenderRequest(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Request access to the Vault</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px;line-height:1.6">A Vault already exists. Choose your own master password — it stays on your device. After you request access, an existing owner approves you, and then you can open the shared Vault. You will also get your own one-time recovery key.</p>' +
    '<label class="form-label">Your master password</label>' +
    '<input id="vault-mp1" class="form-input" type="password" autocomplete="new-password" placeholder="At least 10 characters" style="margin-bottom:14px">' +
    '<label class="form-label">Confirm master password</label>' +
    '<input id="vault-mp2" class="form-input" type="password" autocomplete="new-password" placeholder="Re-enter" style="margin-bottom:18px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultDoRequest(this)">Request access</button>'
  ));
}
async function vaultDoRequest(btn){
  var p1 = (document.getElementById('vault-mp1')||{}).value || '';
  var p2 = (document.getElementById('vault-mp2')||{}).value || '';
  if (p1.length < 10){ showToast('Master password must be at least 10 characters.','error'); return; }
  if (p1 !== p2){ showToast('Passwords do not match.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Submitting…'; }
  try {
    var id = await vaultBuildIdentity(p1);
    await vaultApi('POST','/enroll-request', {
      public_key: id.pubB64, kdf_salt: id.kdf_salt, kdf_iterations: VAULT_ITER,
      enc_private_key: id.enc_private_key,
      recovery_salt: id.recovery_salt, enc_private_key_recovery: id.enc_private_key_recovery
    });
    var v = vaultState();
    v.recoveryKey = id.recoveryKey; v.afterRecovery = 'pending-wait';
    v.stage = 'show-recovery';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Request access'; } showToast(e.message,'error'); }
}

/* ---- stage: show recovery key once --------------------------------------- */
function vaultRenderRecoveryReveal(content){
  var v = vaultState();
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Save your recovery key</h3>' +
    '<p style="margin:0 0 14px;color:var(--text-muted-color);font-size:13px;line-height:1.6">This is shown <b>once</b> and is yours alone. Store it somewhere safe and offline. It is the only way back into the Vault if you forget your master password.</p>' +
    '<div style="background:var(--bg);border:1px dashed var(--primary,#f97316);border-radius:10px;padding:16px;text-align:center;font-family:monospace;font-size:18px;letter-spacing:2px;word-break:break-all">' + escHtml(v.recoveryKey || '') + '</div>' +
    '<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="copyToClipboard(\'' + (v.recoveryKey || '') + '\', this)">Copy recovery key</button>' +
    '<label style="display:flex;align-items:center;gap:8px;margin:16px 0 0;font-size:13px;cursor:pointer"><input type="checkbox" id="vault-rec-ack"> I have saved my recovery key somewhere safe.</label>' +
    '<button class="btn btn-primary" style="width:100%;margin-top:14px" onclick="vaultFinishRecoveryReveal()">Continue</button>'
  ));
}
function vaultFinishRecoveryReveal(){
  if (!(document.getElementById('vault-rec-ack')||{}).checked){ showToast('Please confirm you saved the recovery key.','error'); return; }
  var v = vaultState();
  v.recoveryKey = null;
  if (v.afterRecovery === 'pending-wait'){ v.stage = 'pending-wait'; }
  else { v.stage = 'open'; vaultBump(); }
  render();
}

/* ---- stage: pending (waiting for approval) ------------------------------- */
function vaultRenderPending(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 8px;font-size:17px">Waiting for approval</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px;line-height:1.6">Your access request has been sent to the existing owner(s). Once one of them approves you, come back and unlock the Vault with your master password.</p>' +
    '<button class="btn btn-secondary" style="width:100%" onclick="vaultRecheck(this)">Check again</button>'
  ));
}
function vaultRecheck(){
  // Re-run the whole unlock flow; verify-gate will report the latest membership
  // status, so an approved request will move straight to the unlock screen.
  vaultLockSilent(); render(); showToast('Unlock again to check if you have been approved.','info');
}

/* ---- stage: unlock ------------------------------------------------------- */
function vaultRenderUnlock(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Enter your master password</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px">The shared Vault is decrypted locally — your password never leaves your device.</p>' +
    '<input id="vault-mp" class="form-input" type="password" autocomplete="current-password" placeholder="Master password" style="margin-bottom:16px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultDoUnlock(this)">Unlock</button>' +
    '<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:12px;color:var(--text-muted-color)" onclick="vaultStartRecover()">Forgot master password? Use recovery key</button>'
  ));
  var m = document.getElementById('vault-mp');
  if (m){ m.focus(); m.addEventListener('keydown', function(e){ if (e.key==='Enter') vaultDoUnlock(); }); }
}
async function vaultDoUnlock(btn){
  var v = vaultState();
  var mp = (document.getElementById('vault-mp')||{}).value || '';
  if (!mp){ showToast('Enter your master password.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Unlocking…'; }
  try {
    var mem = v.membership;
    var kek = await vaultDeriveKEK(mp, vaultUnHex(mem.kdf_salt), mem.kdf_iterations);
    var privBytes;
    try { privBytes = await vaultDecPriv(mem.enc_private_key, kek); }
    catch(err){ vaultLogActivity('unlock_failed'); throw new Error('Incorrect master password.'); }
    var priv = await vaultImportPriv(privBytes);
    var dek = await vaultUnwrapDek(mem.wrapped_dek, priv);
    v.priv = priv; v.dek = dek;
    await vaultLoadAll();
    v.stage = 'open'; vaultBump(); render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Unlock'; } showToast(e.message,'error'); }
}
async function vaultLoadAll(){
  var v = vaultState();
  var rows = await vaultApi('GET','/entries');
  var out = [];
  for (var i=0;i<rows.length;i++){
    try { out.push({ id: rows[i].id, data: await vaultDecEntry(rows[i].iv, rows[i].ciphertext, v.dek), updated_at: rows[i].updated_at }); }
    catch(e){ out.push({ id: rows[i].id, data: { title:'(could not decrypt)', _err:true }, updated_at: rows[i].updated_at }); }
  }
  v.entries = out; v.revealed = {};
  try { v.pending = await vaultApi('GET','/pending'); } catch(e){ v.pending = []; }
  try { v.members = await vaultApi('GET','/members'); } catch(e){ v.members = []; }
}

/* ---- stage: recover ------------------------------------------------------ */
async function vaultStartRecover(){
  var v = vaultState();
  try { v.recBlob = await vaultApi('GET','/recovery-blob'); }
  catch(e){ showToast(e.message,'error'); return; }
  v.stage = 'recover'; render();
}
function vaultRenderRecover(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Recover with your recovery key</h3>' +
    '<p style="margin:0 0 14px;color:var(--text-muted-color);font-size:13px;line-height:1.6">Enter your recovery key, then choose a new master password.</p>' +
    '<label class="form-label">Recovery key</label>' +
    '<input id="vault-reckey" class="form-input" placeholder="XXXX-XXXX-…" style="margin-bottom:14px;font-family:monospace">' +
    '<label class="form-label">New master password</label>' +
    '<input id="vault-nmp1" class="form-input" type="password" autocomplete="new-password" placeholder="At least 10 characters" style="margin-bottom:14px">' +
    '<label class="form-label">Confirm new master password</label>' +
    '<input id="vault-nmp2" class="form-input" type="password" autocomplete="new-password" placeholder="Re-enter" style="margin-bottom:18px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultDoRecover(this)">Recover access</button>' +
    '<button class="btn btn-ghost btn-sm" style="width:100%;margin-top:10px" onclick="vaultBackToUnlock()">Back</button>'
  ));
}
function vaultBackToUnlock(){ vaultState().stage = 'unlock'; render(); }
async function vaultDoRecover(btn){
  var v = vaultState();
  var key = (document.getElementById('vault-reckey')||{}).value || '';
  var p1 = (document.getElementById('vault-nmp1')||{}).value || '';
  var p2 = (document.getElementById('vault-nmp2')||{}).value || '';
  if (!key){ showToast('Enter your recovery key.','error'); return; }
  if (p1.length < 10){ showToast('New master password must be at least 10 characters.','error'); return; }
  if (p1 !== p2){ showToast('Passwords do not match.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Recovering…'; }
  try {
    var recKek = await vaultDeriveKEK(vaultNormKey(key), vaultUnHex(v.recBlob.recovery_salt), VAULT_ITER);
    var privBytes;
    try { privBytes = await vaultDecPriv(v.recBlob.enc_private_key_recovery, recKek); }
    catch(err){ throw new Error('That recovery key is not correct.'); }
    var priv = await vaultImportPriv(privBytes);
    var dek = await vaultUnwrapDek(v.recBlob.wrapped_dek, priv);
    // Re-encrypt the private key under the new master password.
    var saltB = vaultRand(16);
    var kek = await vaultDeriveKEK(p1, saltB, VAULT_ITER);
    var encPriv = await vaultEncPriv(privBytes, kek);
    await vaultApi('POST','/rekey', { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, enc_private_key: encPriv });
    v.priv = priv; v.dek = dek;
    v.membership = Object.assign({}, v.membership, { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, enc_private_key: encPriv });
    v.recBlob = null;
    await vaultLoadAll();
    v.stage = 'open'; vaultBump(); render();
    showToast('Access recovered. Master password updated.','success');
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Recover access'; } showToast(e.message,'error'); }
}

/* ---- stage: open --------------------------------------------------------- */
function vaultRenderOpen(content){
  var v = vaultState();
  if (v.managePanel) return vaultRenderManage(content);
  if (v.editing !== undefined && v.editing !== null) return vaultRenderForm(content);
  var pendCount = (v.pending || []).length;
  content.innerHTML =
    '<div onclick="vaultBump()" onkeydown="vaultBump()">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary,#f97316)" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
        '<h2 style="margin:0;font-size:20px">Secure Vault</h2>' +
        '<span style="font-size:12px;color:var(--text-muted-color);border:1px solid var(--border);border-radius:20px;padding:2px 10px">' + (v.entries||[]).length + ' saved</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-secondary btn-sm" onclick="vaultOpenManage()">Owners' + (pendCount ? ' <span style="background:var(--primary,#f97316);color:#1a1a1a;border-radius:10px;padding:0 6px;font-weight:800">' + pendCount + '</span>' : '') + '</button>' +
        '<button class="btn btn-secondary btn-sm" onclick="vaultManualLock()">Lock</button>' +
        '<button class="btn btn-primary btn-sm" onclick="vaultNewEntry()">+ Add login</button>' +
      '</div>' +
    '</div>' +
    (pendCount ? '<div style="background:var(--bg-card);border:1px solid var(--primary,#f97316);border-radius:10px;padding:12px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap"><span style="font-size:13px"><b>' + pendCount + '</b> owner' + (pendCount>1?'s are':' is') + ' requesting access.</span><button class="btn btn-primary btn-sm" onclick="vaultOpenManage()">Review</button></div>' : '') +
    '<input class="form-input" placeholder="Search logins…" value="' + escHtml(v.search||'') + '" oninput="vaultSearch(this.value)" style="margin-bottom:14px">' +
    '<div id="vault-list">' + vaultListHtml() + '</div>' +
    '<div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--text-muted-color)" onclick="vaultChangeMaster()">Change my master password</button>' +
    '</div>' +
    '<div style="margin-top:14px;text-align:center;color:var(--text-muted-color);font-size:11px;line-height:1.5">Shared with all approved owners. Auto-locks after 5 minutes idle. Everything is encrypted on your device — the server never sees your passwords.</div>' +
    '</div>';
}
function vaultListHtml(){
  var v = vaultState();
  var q = (v.search || '').toLowerCase();
  var list = (v.entries || []).filter(function(e){
    if (!q) return true;
    var d = e.data || {};
    return ((d.title||'') + ' ' + (d.url||'') + ' ' + (d.username||'')).toLowerCase().indexOf(q) !== -1;
  });
  var rows = list.map(function(e){ return vaultEntryRow(e); }).join('');
  if (!rows) rows = '<div style="text-align:center;color:var(--text-muted-color);padding:30px 0;font-size:14px">' + ((v.entries||[]).length ? 'No matches.' : 'No saved logins yet. Add your first one.') + '</div>';
  return rows;
}
function vaultSearch(q){ vaultState().search = q; vaultBump(); var h = document.getElementById('vault-list'); if (h) h.innerHTML = vaultListHtml(); }
function vaultEntryRow(e){
  var v = vaultState();
  var d = e.data || {};
  var revealed = v.revealed && v.revealed[e.id];
  var initials = (d.title || '?').trim().slice(0,1).toUpperCase();
  var pwDisplay = revealed ? escHtml(d.password || '') : '••••••••••';
  return '<div style="border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;background:var(--bg-card)">' +
    '<div style="display:flex;align-items:flex-start;gap:12px">' +
      '<div style="width:34px;height:34px;border-radius:8px;background:var(--primary,#f97316);color:#1a1a1a;display:flex;align-items:center;justify-content:center;font-weight:800;flex-shrink:0">' + escHtml(initials) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis">' + escHtml(d.title || '(untitled)') + '</div>' +
        (d.url ? '<div style="font-size:12px;color:var(--text-muted-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(d.url) + '</div>' : '') +
        '<div style="margin-top:8px;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span style="color:var(--text-muted-color)">User:</span> <span style="font-family:monospace">' + escHtml(d.username || '—') + '</span>' +
          (d.username ? '<button class="btn btn-ghost btn-sm" style="padding:1px 6px" title="Copy username" onclick="vaultCopy(' + e.id + ',\'username\',this)">copy</button>' : '') +
        '</div>' +
        '<div style="margin-top:4px;font-size:13px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span style="color:var(--text-muted-color)">Pass:</span> <span style="font-family:monospace">' + pwDisplay + '</span>' +
          '<button class="btn btn-ghost btn-sm" style="padding:1px 6px" onclick="vaultReveal(' + e.id + ')">' + (revealed ? 'hide' : 'show') + '</button>' +
          '<button class="btn btn-ghost btn-sm" style="padding:1px 6px" title="Copy password" onclick="vaultCopy(' + e.id + ',\'password\',this)">copy</button>' +
        '</div>' +
        (revealed && d.totp ? '<div style="margin-top:4px;font-size:12px;color:var(--text-muted-color)">2FA secret: <span style="font-family:monospace">' + escHtml(d.totp) + '</span></div>' : '') +
        (revealed && d.notes ? '<div style="margin-top:8px;font-size:12px;white-space:pre-wrap;color:var(--text-dim);border-top:1px solid var(--border);padding-top:8px">' + escHtml(d.notes) + '</div>' : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">' +
        '<button class="btn btn-ghost btn-sm" style="padding:3px 8px" onclick="vaultEditEntry(' + e.id + ')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" style="padding:3px 8px;color:var(--danger,#ef4444)" onclick="vaultDeleteEntry(' + e.id + ')">Delete</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}
function vaultReveal(id){ var v=vaultState(); v.revealed=v.revealed||{}; v.revealed[id]=!v.revealed[id]; if(v.revealed[id]) vaultLogActivity('reveal',id); vaultBump(); render(); }
function vaultCopy(id, field, btn){
  var v = vaultState();
  var e = (v.entries||[]).filter(function(x){ return x.id===id; })[0];
  if (!e) return;
  var val = (e.data||{})[field] || '';
  copyToClipboard(val, btn);
  vaultLogActivity('copy', id);
  vaultBump();
  if (field === 'password' && val){
    setTimeout(function(){ try { navigator.clipboard.writeText(''); showToast('Password cleared from clipboard.','info'); } catch(e){} }, VAULT_CLIP_CLEAR_MS);
  }
}

/* ---- add / edit form ----------------------------------------------------- */
function vaultNewEntry(){ var v=vaultState(); v.editing='new'; v.draft={ title:'',url:'',username:'',password:'',totp:'',notes:'' }; render(); }
function vaultEditEntry(id){ var v=vaultState(); var e=(v.entries||[]).filter(function(x){return x.id===id;})[0]; if(!e) return; v.editing=id; v.draft=Object.assign({ title:'',url:'',username:'',password:'',totp:'',notes:'' }, e.data); render(); }
function vaultRenderForm(content){
  var v = vaultState();
  var d = v.draft || {};
  var isNew = v.editing === 'new';
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 16px;font-size:17px">' + (isNew ? 'Add login' : 'Edit login') + '</h3>' +
    '<label class="form-label">Title</label>' +
    '<input id="vf-title" class="form-input" value="' + escHtml(d.title||'') + '" placeholder="e.g. GoDaddy" style="margin-bottom:12px">' +
    '<label class="form-label">Website / URL</label>' +
    '<input id="vf-url" class="form-input" value="' + escHtml(d.url||'') + '" placeholder="https://…" style="margin-bottom:12px">' +
    '<label class="form-label">Username / email</label>' +
    '<input id="vf-user" class="form-input" value="' + escHtml(d.username||'') + '" autocomplete="off" style="margin-bottom:12px">' +
    '<label class="form-label">Password</label>' +
    '<div style="display:flex;gap:8px;margin-bottom:12px"><input id="vf-pass" class="form-input" value="' + escHtml(d.password||'') + '" autocomplete="off" style="flex:1"><button class="btn btn-secondary btn-sm" onclick="vaultGenPassword()">Generate</button></div>' +
    '<label class="form-label">2FA / TOTP secret (optional)</label>' +
    '<input id="vf-totp" class="form-input" value="' + escHtml(d.totp||'') + '" autocomplete="off" placeholder="Backup of an authenticator secret" style="margin-bottom:12px">' +
    '<label class="form-label">Notes (optional)</label>' +
    '<textarea id="vf-notes" class="form-input" rows="3" style="margin-bottom:18px">' + escHtml(d.notes||'') + '</textarea>' +
    '<div style="display:flex;gap:10px">' +
      '<button class="btn btn-primary" style="flex:1" onclick="vaultSaveEntry(this)">Save</button>' +
      '<button class="btn btn-secondary" style="flex:1" onclick="vaultCancelForm()">Cancel</button>' +
    '</div>'
  ));
}
function vaultGenPassword(){
  var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
  var bytes=vaultRand(20), out='';
  for(var i=0;i<bytes.length;i++) out+=chars[bytes[i]%chars.length];
  var f=document.getElementById('vf-pass'); if(f) f.value=out;
}
function vaultCancelForm(){ var v=vaultState(); v.editing=null; v.draft=null; render(); }
async function vaultSaveEntry(btn){
  var v = vaultState();
  var obj = {
    title: (document.getElementById('vf-title')||{}).value || '',
    url: (document.getElementById('vf-url')||{}).value || '',
    username: (document.getElementById('vf-user')||{}).value || '',
    password: (document.getElementById('vf-pass')||{}).value || '',
    totp: (document.getElementById('vf-totp')||{}).value || '',
    notes: (document.getElementById('vf-notes')||{}).value || ''
  };
  if (!obj.title && !obj.username && !obj.password){ showToast('Add at least a title or login.','error'); return; }
  if (btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var enc = await vaultEncEntry(obj, v.dek);
    if (v.editing === 'new'){
      var r = await vaultApi('POST','/entries', { iv: enc.iv, ciphertext: enc.ciphertext });
      v.entries.unshift({ id: r.id, data: obj, updated_at: r.updated_at });
    } else {
      await vaultApi('PUT','/entries/' + v.editing, { iv: enc.iv, ciphertext: enc.ciphertext });
      var ex = (v.entries||[]).filter(function(x){ return x.id===v.editing; })[0];
      if (ex){ ex.data = obj; ex.updated_at = new Date().toISOString(); }
    }
    v.editing = null; v.draft = null; vaultBump(); render();
    showToast('Saved.','success');
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Save'; } showToast(e.message,'error'); }
}
async function vaultDeleteEntry(id){
  var e = (vaultState().entries||[]).filter(function(x){ return x.id===id; })[0];
  var nm = e && e.data ? (e.data.title || 'this login') : 'this login';
  if (!confirm('Delete ' + nm + '? This removes it for all owners and cannot be undone.')) return;
  try {
    await vaultApi('DELETE','/entries/' + id);
    var v = vaultState();
    v.entries = (v.entries||[]).filter(function(x){ return x.id!==id; });
    vaultBump(); render(); showToast('Deleted.','success');
  } catch(err){ showToast(err.message,'error'); }
}

/* ---- manage owners ------------------------------------------------------- */
function vaultOpenManage(){ vaultState().managePanel = true; render(); }
function vaultCloseManage(){ vaultState().managePanel = false; render(); }
function vaultRenderManage(content){
  var v = vaultState();
  var meId = state.user.id;
  var pend = (v.pending || []).map(function(p){
    return '<div style="border:1px solid var(--primary,#f97316);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
      '<div><div style="font-weight:700;font-size:14px">' + escHtml(p.name||('User '+p.user_id)) + '</div><div style="font-size:12px;color:var(--text-muted-color)">' + escHtml(p.email||'') + ' — requesting access</div></div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="btn btn-primary btn-sm" onclick="vaultApprove(' + p.user_id + ',this)">Approve</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#ef4444)" onclick="vaultRevoke(' + p.user_id + ',this)">Deny</button>' +
      '</div>' +
    '</div>';
  }).join('');
  var active = (v.members || []).filter(function(m){ return m.status==='active'; }).map(function(m){
    var isMe = m.user_id === meId;
    return '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
      '<div><div style="font-weight:700;font-size:14px">' + escHtml(m.name||('User '+m.user_id)) + (isMe?' <span style="color:var(--text-muted-color);font-weight:400">(you)</span>':'') + '</div><div style="font-size:12px;color:var(--text-muted-color)">' + escHtml(m.email||'') + '</div></div>' +
      (isMe ? '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#ef4444)" onclick="vaultLeave(this)">Leave vault</button>'
            : '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#ef4444)" onclick="vaultRevoke(' + m.user_id + ',this)">Remove</button>') +
    '</div>';
  }).join('');
  content.innerHTML = vaultShell(
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px"><h3 style="margin:0;font-size:18px">Owners</h3><button class="btn btn-secondary btn-sm" onclick="vaultCloseManage()">Back to vault</button></div>' +
    (pend ? '<div style="margin-bottom:6px;font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.5px">Pending requests</div>' + pend : '') +
    '<div style="margin:14px 0 6px;font-size:12px;color:var(--text-muted-color);text-transform:uppercase;letter-spacing:0.5px">Active owners</div>' +
    (active || '<div style="color:var(--text-muted-color);font-size:13px">No active owners.</div>') +
    '<div style="margin-top:16px;color:var(--text-muted-color);font-size:11px;line-height:1.5">Approving an owner shares the vault key with them, encrypted to their personal key — done on your device. Removing an owner revokes their copy of the key.</div>'
  );
}
async function vaultApprove(userId, btn){
  var v = vaultState();
  var p = (v.pending || []).filter(function(x){ return x.user_id===userId; })[0];
  if (!p){ showToast('Request not found. Refreshing…','error'); vaultLoadAll().then(render); return; }
  if (!confirm('Approve ' + (p.name||'this owner') + '? They will get full access to all shared logins.')) return;
  if (btn){ btn.disabled = true; btn.textContent = 'Approving…'; }
  try {
    var pub = await vaultImportPub(p.public_key);
    var wrapped = await vaultWrapDekTo(v.dek, pub);
    await vaultApi('POST','/approve/' + userId, { wrapped_dek: wrapped });
    await vaultLoadAll(); render(); showToast('Owner approved.','success');
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Approve'; } showToast(e.message,'error'); }
}
async function vaultRevoke(userId, btn){
  if (!confirm('Remove this owner\'s access to the vault?')) return;
  if (btn){ btn.disabled = true; btn.textContent = 'Removing…'; }
  try { await vaultApi('POST','/revoke/' + userId, {}); await vaultLoadAll(); render(); showToast('Access removed.','info'); }
  catch(e){ if (btn){ btn.disabled=false; btn.textContent='Remove'; } showToast(e.message,'error'); }
}
async function vaultLeave(btn){
  if (!confirm('Leave the vault? You will lose access to all shared logins unless another owner re-approves you.')) return;
  try { await vaultApi('POST','/leave', {}); vaultLockSilent(); render(); showToast('You have left the vault.','info'); }
  catch(e){ showToast(e.message,'error'); }
}

/* ---- change master password ---------------------------------------------- */
async function vaultChangeMaster(){
  var np = prompt('New master password (at least 10 characters):');
  if (np === null) return;
  if (np.length < 10){ showToast('Master password must be at least 10 characters.','error'); return; }
  var np2 = prompt('Confirm new master password:');
  if (np2 === null) return;
  if (np !== np2){ showToast('Passwords do not match.','error'); return; }
  try {
    var v = vaultState();
    var privBytes = await vaultExportPrivBytes(v.priv);
    var saltB = vaultRand(16);
    var kek = await vaultDeriveKEK(np, saltB, VAULT_ITER);
    var encPriv = await vaultEncPriv(privBytes, kek);
    await vaultApi('POST','/rekey', { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, enc_private_key: encPriv });
    v.membership = Object.assign({}, v.membership, { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, enc_private_key: encPriv });
    showToast('Master password changed. Your recovery key still works.','success');
  } catch(e){ showToast(e.message,'error'); }
}
