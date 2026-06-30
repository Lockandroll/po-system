/* Nova Secure Vault — owner-only, zero-knowledge credential store.
 *
 * All cryptography happens in THIS browser. The master password, recovery key,
 * data key (DEK) and every plaintext credential never leave the device. The
 * server only ever stores salts and AES-GCM ciphertext.
 *
 * House style: string concatenation only, no template literals/backticks.
 */

var VAULT_ITER = 600000;   // PBKDF2-SHA256 iterations (OWASP-recommended floor)
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
async function vaultWrapDEK(dek, kek){
  var raw = new Uint8Array(await crypto.subtle.exportKey('raw', dek));
  var iv = vaultRand(12);
  var ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: iv }, kek, raw));
  return JSON.stringify({ iv: vaultB64(iv), ct: vaultB64(ct) });
}
async function vaultUnwrapDEK(wrappedJson, kek){
  var o = JSON.parse(wrappedJson);
  var raw = await crypto.subtle.decrypt({ name:'AES-GCM', iv: vaultUnB64(o.iv) }, kek, vaultUnB64(o.ct)); // throws on wrong key
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

/* ---- transport (adds the gate token, handles re-lock) -------------------- */
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
function vaultLockSilent(){
  var v = state.vault;
  if (v){ if (v.lockTimer){ clearTimeout(v.lockTimer); } }
  state.vault = { stage:'locked' };
}
function vaultAutoLock(){ if (state.vault && state.vault.dek){ vaultLogActivity('autolock'); } vaultLockSilent(); if (state.currentView==='vault') render(); }
function vaultBump(){
  var v = vaultState();
  if (v.lockTimer) clearTimeout(v.lockTimer);
  if (v.stage === 'open') v.lockTimer = setTimeout(vaultAutoLock, VAULT_AUTOLOCK_MS);
}
function vaultManualLock(){ if (state.vault && state.vault.dek){ vaultLogActivity('lock'); } vaultLockSilent(); render(); showToast('Vault locked.','info'); }

// Lock whenever the owner navigates away from the vault, hides the tab, or signs out.
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
    content.innerHTML = '<div class="alert alert-error">Vault access is restricted to the owner.</div>';
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
  if (v.stage === 'show-recovery') return vaultRenderRecoveryReveal(content);
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
      '<div style="color:var(--text-muted-color);font-size:13px">Owner-only. End-to-end encrypted on this device.</div>' +
    '</div>' + inner + '</div>';
}
function vaultCard(inner){ return '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:22px">' + inner + '</div>'; }

/* ---- stage: locked ------------------------------------------------------- */
function vaultRenderLocked(content){
  content.innerHTML = vaultShell(vaultCard(
    '<p style="margin:0 0 16px;color:var(--text-dim);font-size:14px;line-height:1.6">To open the Vault you must pass a fresh security check: a one-time code sent to you, plus your account password. The Vault is then decrypted locally with your master password.</p>' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultStartChallenge(this)">Unlock Vault</button>'
  ));
}
async function vaultStartChallenge(btn){
  if (btn){ btn.disabled = true; btn.textContent = 'Sending code…'; }
  try {
    var r = await vaultApi('POST','/challenge', {});
    var v = vaultState(); v.via = r.via; v.stage = 'awaiting-code';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Unlock Vault'; } showToast(e.message,'error'); }
}

/* ---- stage: gate (fresh code + account password) ------------------------- */
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
    v.config = r.config;
    v.stage = r.hasVault ? 'unlock' : 'setup';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Verify'; } showToast(e.message,'error'); }
}

/* ---- stage: first-time setup --------------------------------------------- */
function vaultRenderSetup(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Create your master password</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px;line-height:1.6">This password encrypts everything in the Vault. It is never sent to the server and <b>cannot be recovered</b> if lost — that is what makes the Vault secure. You will also get a one-time recovery key as a backup.</p>' +
    '<label class="form-label">Master password</label>' +
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
    var dek = await vaultGenDEK();
    var saltB = vaultRand(16);
    var kek = await vaultDeriveKEK(p1, saltB, VAULT_ITER);
    var wrapped = await vaultWrapDEK(dek, kek);
    // Recovery key
    var recBytes = vaultRand(20);
    var recKey = vaultGroupKey(vaultB32(recBytes));
    var recSaltB = vaultRand(16);
    var recKek = await vaultDeriveKEK(vaultNormKey(recKey), recSaltB, VAULT_ITER);
    var wrappedRec = await vaultWrapDEK(dek, recKek);
    await vaultApi('POST','/setup', {
      kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, wrapped_dek: wrapped,
      recovery_salt: vaultHex(recSaltB), wrapped_dek_recovery: wrappedRec
    });
    var v = vaultState();
    v.dek = dek;
    v.recoveryKey = recKey;
    v.entries = [];
    v.stage = 'show-recovery';
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Create Vault'; } showToast(e.message,'error'); }
}

/* ---- stage: show recovery key once --------------------------------------- */
function vaultRenderRecoveryReveal(content){
  var v = vaultState();
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Save your recovery key</h3>' +
    '<p style="margin:0 0 14px;color:var(--text-muted-color);font-size:13px;line-height:1.6">This is shown <b>once</b>. Store it somewhere safe and offline (a password manager, a locked drawer). It is the only way back into the Vault if you forget your master password.</p>' +
    '<div style="background:var(--bg);border:1px dashed var(--primary,#f97316);border-radius:10px;padding:16px;text-align:center;font-family:monospace;font-size:18px;letter-spacing:2px;word-break:break-all">' + escHtml(v.recoveryKey || '') + '</div>' +
    '<button class="btn btn-secondary btn-sm" style="width:100%;margin-top:12px" onclick="copyToClipboard(\'' + (v.recoveryKey || '') + '\', this)">Copy recovery key</button>' +
    '<label style="display:flex;align-items:center;gap:8px;margin:16px 0 0;font-size:13px;cursor:pointer"><input type="checkbox" id="vault-rec-ack"> I have saved my recovery key somewhere safe.</label>' +
    '<button class="btn btn-primary" style="width:100%;margin-top:14px" onclick="vaultFinishSetup()">Enter Vault</button>'
  ));
}
function vaultFinishSetup(){
  if (!(document.getElementById('vault-rec-ack')||{}).checked){ showToast('Please confirm you saved the recovery key.','error'); return; }
  var v = vaultState();
  v.recoveryKey = null;
  v.stage = 'open';
  vaultBump();
  render();
}

/* ---- stage: unlock with master password ---------------------------------- */
function vaultRenderUnlock(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Enter master password</h3>' +
    '<p style="margin:0 0 16px;color:var(--text-muted-color);font-size:13px">Your Vault is decrypted locally — this password never leaves your device.</p>' +
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
    var saltB = vaultUnHex(v.config.kdf_salt);
    var kek = await vaultDeriveKEK(mp, saltB, v.config.kdf_iterations);
    var dek;
    try { dek = await vaultUnwrapDEK(v.config.wrapped_dek, kek); }
    catch(err){ vaultLogActivity('unlock_failed'); throw new Error('Incorrect master password.'); }
    v.dek = dek;
    await vaultLoadEntries();
    v.stage = 'open';
    vaultBump();
    render();
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Unlock'; } showToast(e.message,'error'); }
}
async function vaultLoadEntries(){
  var v = vaultState();
  var rows = await vaultApi('GET','/entries');
  var out = [];
  for (var i=0;i<rows.length;i++){
    try { var data = await vaultDecEntry(rows[i].iv, rows[i].ciphertext, v.dek); out.push({ id: rows[i].id, data: data, updated_at: rows[i].updated_at }); }
    catch(e){ out.push({ id: rows[i].id, data: { title:'(could not decrypt)', _err:true }, updated_at: rows[i].updated_at }); }
  }
  v.entries = out;
  v.revealed = {};
}

/* ---- stage: recover with recovery key ------------------------------------ */
async function vaultStartRecover(){
  var v = vaultState();
  try { v.recBlob = await vaultApi('GET','/recovery-blob'); }
  catch(e){ showToast(e.message,'error'); return; }
  v.stage = 'recover';
  render();
}
function vaultRenderRecover(content){
  content.innerHTML = vaultShell(vaultCard(
    '<h3 style="margin:0 0 6px;font-size:17px">Recover with recovery key</h3>' +
    '<p style="margin:0 0 14px;color:var(--text-muted-color);font-size:13px;line-height:1.6">Enter your recovery key, then choose a new master password.</p>' +
    '<label class="form-label">Recovery key</label>' +
    '<input id="vault-reckey" class="form-input" placeholder="XXXX-XXXX-…" style="margin-bottom:14px;font-family:monospace">' +
    '<label class="form-label">New master password</label>' +
    '<input id="vault-nmp1" class="form-input" type="password" autocomplete="new-password" placeholder="At least 10 characters" style="margin-bottom:14px">' +
    '<label class="form-label">Confirm new master password</label>' +
    '<input id="vault-nmp2" class="form-input" type="password" autocomplete="new-password" placeholder="Re-enter" style="margin-bottom:18px">' +
    '<button class="btn btn-primary" style="width:100%" onclick="vaultDoRecover(this)">Recover Vault</button>' +
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
    var dek;
    try { dek = await vaultUnwrapDEK(v.recBlob.wrapped_dek_recovery, recKek); }
    catch(err){ throw new Error('That recovery key is not correct.'); }
    // Re-wrap the DEK under the new master password.
    var saltB = vaultRand(16);
    var kek = await vaultDeriveKEK(p1, saltB, VAULT_ITER);
    var wrapped = await vaultWrapDEK(dek, kek);
    await vaultApi('POST','/rekey', { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, wrapped_dek: wrapped });
    v.dek = dek;
    v.config = { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, wrapped_dek: wrapped };
    v.recBlob = null;
    await vaultLoadEntries();
    v.stage = 'open';
    vaultBump();
    render();
    showToast('Vault recovered. Master password updated.','success');
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Recover Vault'; } showToast(e.message,'error'); }
}

/* ---- stage: open --------------------------------------------------------- */
function vaultRenderOpen(content){
  var v = vaultState();
  if (v.editing !== undefined && v.editing !== null) return vaultRenderForm(content);
  content.innerHTML =
    '<div onclick="vaultBump()" onkeydown="vaultBump()">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">' +
      '<div style="display:flex;align-items:center;gap:10px">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary,#f97316)" stroke-width="1.8"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' +
        '<h2 style="margin:0;font-size:20px">Secure Vault</h2>' +
        '<span style="font-size:12px;color:var(--text-muted-color);border:1px solid var(--border);border-radius:20px;padding:2px 10px">' + (v.entries||[]).length + ' saved</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button class="btn btn-secondary btn-sm" onclick="vaultManualLock()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Lock</button>' +
        '<button class="btn btn-primary btn-sm" onclick="vaultNewEntry()">+ Add login</button>' +
      '</div>' +
    '</div>' +
    '<input class="form-input" placeholder="Search logins…" value="' + escHtml(v.search||'') + '" oninput="vaultSearch(this.value)" style="margin-bottom:14px">' +
    '<div id="vault-list">' + vaultListHtml() + '</div>' +
    '<div style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--text-muted-color)" onclick="vaultChangeMaster()">Change master password</button>' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--danger,#ef4444)" onclick="vaultResetVault()">Reset vault…</button>' +
    '</div>' +
    '<div style="margin-top:14px;text-align:center;color:var(--text-muted-color);font-size:11px;line-height:1.5">Auto-locks after 5 minutes idle. Everything here is encrypted on your device — the server never sees your passwords.</div>' +
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
function vaultSearch(q){
  vaultState().search = q;
  vaultBump();
  var holder = document.getElementById('vault-list');
  if (holder) holder.innerHTML = vaultListHtml();
}
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
    v.editing = null; v.draft = null;
    vaultBump();
    render();
    showToast('Saved.','success');
  } catch(e){ if (btn){ btn.disabled=false; btn.textContent='Save'; } showToast(e.message,'error'); }
}
async function vaultDeleteEntry(id){
  var e = (vaultState().entries||[]).filter(function(x){ return x.id===id; })[0];
  var nm = e && e.data ? (e.data.title || 'this login') : 'this login';
  if (!confirm('Delete ' + nm + '? This cannot be undone.')) return;
  try {
    await vaultApi('DELETE','/entries/' + id);
    var v = vaultState();
    v.entries = (v.entries||[]).filter(function(x){ return x.id!==id; });
    vaultBump();
    render();
    showToast('Deleted.','success');
  } catch(err){ showToast(err.message,'error'); }
}

/* ---- change master password / reset -------------------------------------- */
async function vaultChangeMaster(){
  var np = prompt('New master password (at least 10 characters):');
  if (np === null) return;
  if (np.length < 10){ showToast('Master password must be at least 10 characters.','error'); return; }
  var np2 = prompt('Confirm new master password:');
  if (np2 === null) return;
  if (np !== np2){ showToast('Passwords do not match.','error'); return; }
  try {
    var v = vaultState();
    var saltB = vaultRand(16);
    var kek = await vaultDeriveKEK(np, saltB, VAULT_ITER);
    var wrapped = await vaultWrapDEK(v.dek, kek);
    await vaultApi('POST','/rekey', { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, wrapped_dek: wrapped });
    v.config = { kdf_salt: vaultHex(saltB), kdf_iterations: VAULT_ITER, wrapped_dek: wrapped };
    showToast('Master password changed. Your recovery key still works.','success');
  } catch(e){ showToast(e.message,'error'); }
}
async function vaultResetVault(){
  if (!confirm('Reset the entire Vault? Every saved login will be permanently deleted. This cannot be undone.')) return;
  var typed = prompt('Type RESET to confirm.');
  if (typed !== 'RESET'){ showToast('Reset cancelled.','info'); return; }
  try {
    await vaultApi('DELETE','/');
    vaultLockSilent();
    render();
    showToast('Vault has been reset.','info');
  } catch(e){ showToast(e.message,'error'); }
}
