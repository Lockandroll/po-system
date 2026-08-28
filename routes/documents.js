const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const r2 = require('../utils/r2');
const { sendEmail } = require('../utils/email');
const docText = require('../utils/docText');

const router = express.Router();

// The vault access model (loadContext + the can* helpers) moved to
// utils/vaultAccess.js when Fleet document linking was built, because
// routes/vehicles.js has to ask the same question before letting anyone attach a
// vault file to a truck. One copy, two callers - see the header of that file.
const vault = require('../utils/vaultAccess');
const SHAREABLE_ROLES = vault.SHAREABLE_ROLES;
const loadContext = vault.loadContext;
const canViewFolder = vault.canViewFolder;
const canEditFolder = vault.canEditFolder;
const canViewFile = vault.canViewFile;
const canEditFile = vault.canEditFile;
const canWriteInto = vault.canWriteInto;
const descendantFolderIds = vault.descendantFolderIds;

function sanitizeName(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file';
}


// ---- Listing ----
router.get('/', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const folderId = req.query.folder ? parseInt(req.query.folder, 10) : null;

    let current = null, ancestors = [];
    if (folderId != null) {
      const fr = await pool.query('SELECT id, name, parent_id, policy_source FROM document_folders WHERE id = $1', [folderId]);
      if (!fr.rows.length) return res.status(404).json({ error: 'Folder not found' });
      current = fr.rows[0];
      if (!canViewFolder(ctx, folderId)) return res.status(403).json({ error: 'You do not have access to this folder' });
      // Build breadcrumb up to root.
      let pid = current.parent_id;
      const guard = new Set();
      while (pid != null && !guard.has(pid)) {
        guard.add(pid);
        const pr = await pool.query('SELECT id, name, parent_id FROM document_folders WHERE id = $1', [pid]);
        if (!pr.rows.length) break;
        ancestors.unshift({ id: pr.rows[0].id, name: pr.rows[0].name });
        pid = pr.rows[0].parent_id;
      }
    }

    const allFolders = (await pool.query(
      'SELECT id, name, parent_id, owner_id, owner_name, created_at, policy_source FROM document_folders ORDER BY name ASC'
    )).rows;
    // text_status is LEFT JOINed rather than required: a deploy where the
    // migration has not landed, or a file nobody has indexed, both come back
    // null and the screen simply shows nothing next to that file.
    const allFiles = (await pool.query(
      "SELECT d.id, d.name, d.folder_id, d.mime_type, d.size_bytes, d.owner_id, d.owner_name, d.emailable, " +
      "d.created_at, d.expires_on, d.reminder_lead_num, d.reminder_lead_unit, d.fleet_scope, d.fleet_kind, " +
      "t.status AS text_status, t.char_count AS text_chars, t.detail AS text_detail " +
      "FROM documents d LEFT JOIN document_text t ON t.document_id = d.id " +
      "WHERE d.status = 'ready' ORDER BY d.name ASC"
    )).rows;

    let folders, files;
    if (folderId == null) {
      // Root: owned/shared entry points whose parent is not itself accessible.
      folders = allFolders.filter(function (f) {
        if (!canViewFolder(ctx, f.id)) return false;
        return f.parent_id == null || !canViewFolder(ctx, f.parent_id);
      });
      files = allFiles.filter(function (f) {
        if (!canViewFile(ctx, f)) return false;
        return f.folder_id == null || !canViewFolder(ctx, f.folder_id);
      });
    } else {
      folders = allFolders.filter(function (f) { return f.parent_id === folderId && canViewFolder(ctx, f.id); });
      files = allFiles.filter(function (f) { return f.folder_id === folderId && canViewFile(ctx, f); });
    }

    const shareCounts = {};
    (await pool.query('SELECT resource_type, resource_id, COUNT(*)::int AS n FROM document_shares GROUP BY resource_type, resource_id')).rows
      .forEach(function (r) { shareCounts[r.resource_type + ':' + r.resource_id] = r.n; });

    // Inherited, not just the folder's own flag: a subfolder of Policies is
    // policy too, and the screen has to say so or a file dropped one level down
    // looks unindexed for no visible reason.
    var inPolicyTree = false;
    if (folderId != null) {
      try { inPolicyTree = await docText.isPolicyFolder(pool, folderId); } catch (e) {}
    }

    res.json({
      folder: current,
      ancestors: ancestors,
      canWriteHere: canWriteInto(ctx, folderId),
      storageReady: r2.configured(),
      inPolicyTree: inPolicyTree,
      isAdmin: req.user.role === 'admin',
      folders: folders.map(function (f) {
        return {
          id: f.id, name: f.name, owner_name: f.owner_name, created_at: f.created_at,
          mine: f.owner_id === req.user.id, canEdit: canEditFolder(ctx, f.id),
          shareCount: shareCounts['folder:' + f.id] || 0,
          policy_source: !!f.policy_source
        };
      }),
      files: files.map(function (f) {
        return {
          id: f.id, name: f.name, mime_type: f.mime_type, size_bytes: Number(f.size_bytes) || 0,
          owner_name: f.owner_name, created_at: f.created_at,
          mine: f.owner_id === req.user.id, canEdit: canEditFile(ctx, f), emailable: !!f.emailable,
          expires_on: f.expires_on, reminder_lead_num: f.reminder_lead_num, reminder_lead_unit: f.reminder_lead_unit,
          fleet_scope: !!f.fleet_scope, fleet_kind: f.fleet_kind || null,
          shareCount: shareCounts['file:' + f.id] || 0,
          // Only meaningful inside a policy folder; elsewhere it is always null
          // because nothing else in the vault is ever read.
          text_status: f.text_status || null,
          text_chars: f.text_chars == null ? null : Number(f.text_chars),
          text_detail: f.text_detail || null
        };
      })
    });
  } catch (err) {
    console.error('Documents list error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

// Minimal user list for the share picker (any authenticated user may read it).
router.get('/users-list', requireAuth, async function (req, res) {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, role FROM users WHERE active = true AND role <> 'owner' ORDER BY name ASC"
    );
    res.json({ users: rows, roles: SHAREABLE_ROLES });
  } catch (err) {
    console.error('Documents users-list error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// Vault search, for pickers that attach an EXISTING file to something else -
// today that means the Fleet Registry's "Attach existing document" dialog. It is
// deliberately view-scoped: you can only attach a file you can already see, so
// nobody can reach an HR document by attaching it to a van and reading it back
// through the vehicle page. That is the one gate protecting the vehicle read
// path, which does not consult the vault at all.
router.get('/search', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));

    const folders = (await pool.query('SELECT id, parent_id, name FROM document_folders')).rows;
    const byId = new Map();
    folders.forEach(function (f) { byId.set(f.id, f); });
    function pathOf(id) {
      var parts = [], seen = {}, cur = id;
      while (cur != null && byId.has(cur) && !seen[cur]) {
        seen[cur] = true;
        parts.unshift(byId.get(cur).name);
        cur = byId.get(cur).parent_id;
      }
      return parts.join(' / ');
    }

    const rows = (await pool.query(
      "SELECT id, name, folder_id, owner_id, mime_type, size_bytes, fleet_scope, fleet_kind, " +
      "to_char(expires_on, 'YYYY-MM-DD') AS expires_on, reminder_lead_num, reminder_lead_unit " +
      "FROM documents WHERE status = 'ready' ORDER BY created_at DESC"
    )).rows;

    const out = [];
    for (var i = 0; i < rows.length && out.length < limit; i++) {
      var f = rows[i];
      if (!canViewFile(ctx, f)) continue;
      var folder = pathOf(f.folder_id);
      if (q && String(f.name).toLowerCase().indexOf(q) === -1 && folder.toLowerCase().indexOf(q) === -1) continue;
      out.push({
        id: f.id, name: f.name, folder_path: folder, mime_type: f.mime_type,
        size_bytes: Number(f.size_bytes) || 0, expires_on: f.expires_on,
        reminder_lead_num: f.reminder_lead_num, reminder_lead_unit: f.reminder_lead_unit,
        fleet_scope: !!f.fleet_scope, fleet_kind: f.fleet_kind || null
      });
    }
    res.json({ files: out });
  } catch (err) {
    console.error('Documents search error:', err);
    res.status(500).json({ error: 'Failed to search documents' });
  }
});

// ---- Folders ----
router.post('/folders', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const name = (req.body.name || '').trim();
    const parentId = req.body.parent_id ? parseInt(req.body.parent_id, 10) : null;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    if (parentId != null) {
      const pr = await pool.query('SELECT id FROM document_folders WHERE id = $1', [parentId]);
      if (!pr.rows.length) return res.status(404).json({ error: 'Parent folder not found' });
    }
    if (!canWriteInto(ctx, parentId)) return res.status(403).json({ error: 'You cannot create folders here' });
    const { rows } = await pool.query(
      'INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ($1,$2,$3,$4) RETURNING id',
      [name.slice(0, 255), parentId, req.user.id, req.user.name]
    );
    logAudit({ entity_type: 'document_folder', entity_id: rows[0].id, action: 'create', user_id: req.user.id, user_name: req.user.name, details: { name: name } });
    res.json({ success: true, id: rows[0].id });
  } catch (err) {
    console.error('Folder create error:', err);
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

router.put('/folders/:id', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const fr = await pool.query('SELECT id, name, parent_id FROM document_folders WHERE id = $1', [id]);
    if (!fr.rows.length) return res.status(404).json({ error: 'Folder not found' });
    if (!canEditFolder(ctx, id)) return res.status(403).json({ error: 'You cannot edit this folder' });
    const sets = [], params = [];
    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      params.push(req.body.name.trim().slice(0, 255)); sets.push('name = $' + params.length);
    }
    // Marking a folder as a policy source widens who can read what is inside it:
    // the text becomes quotable to anyone writing a disciplinary notice, and to
    // Neurolock. That is wider than the folder's own shares, so it is an admin
    // decision and nobody else's.
    var policyChanged = false;
    if (req.body.policy_source !== undefined) {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can mark a folder as a policy source' });
      params.push(!!req.body.policy_source); sets.push('policy_source = $' + params.length);
      policyChanged = true;
    }
    // Expiration + reminder lead time. Changing the expiry re-arms both reminders.
    if (req.body.expires_on !== undefined) {
      var exp = req.body.expires_on;
      if (exp === null || exp === '') {
        sets.push('expires_on = NULL'); sets.push('reminder_lead_num = NULL'); sets.push('reminder_lead_unit = NULL');
        sets.push('reminder_sent_at = NULL'); sets.push('expiry_notice_sent_at = NULL');
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(exp))) return res.status(400).json({ error: 'Invalid expiration date' });
        var num = parseInt(req.body.reminder_lead_num, 10);
        var unit = String(req.body.reminder_lead_unit || '');
        if (!num || num < 1) num = 1;
        if (num > 999) num = 999;
        if (['days','weeks','months'].indexOf(unit) === -1) unit = 'weeks';
        params.push(exp); sets.push('expires_on = $' + params.length);
        params.push(num); sets.push('reminder_lead_num = $' + params.length);
        params.push(unit); sets.push('reminder_lead_unit = $' + params.length);
        sets.push('reminder_sent_at = NULL'); sets.push('expiry_notice_sent_at = NULL');
      }
    }
    if (req.body.parent_id !== undefined) {
      const target = req.body.parent_id === null ? null : parseInt(req.body.parent_id, 10);
      if (target != null) {
        if (descendantFolderIds(ctx, id).indexOf(target) !== -1) {
          return res.status(400).json({ error: 'Cannot move a folder into itself' });
        }
        const tr = await pool.query('SELECT id FROM document_folders WHERE id = $1', [target]);
        if (!tr.rows.length) return res.status(404).json({ error: 'Target folder not found' });
        if (!canWriteInto(ctx, target)) return res.status(403).json({ error: 'You cannot move it there' });
      }
      params.push(target); sets.push('parent_id = $' + params.length);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    await pool.query('UPDATE document_folders SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
    logAudit({ entity_type: 'document_folder', entity_id: id, action: 'update', user_id: req.user.id, user_name: req.user.name });

    // Turning the flag ON reads everything under the folder. Turning it OFF
    // deletes the extracted words on the spot - un-ticking the box has to mean
    // the AI stops being able to quote from it, not just that new files are
    // skipped, or the setting is a lie.
    if (policyChanged) {
      var nowPolicy = !!req.body.policy_source;
      if (nowPolicy) {
        docText.reindexPolicyFolders(pool, { onlyMissing: true })
          .then(function (r) { console.log('[doc-text] policy folder on: ' + JSON.stringify({ total: r.total, ok: r.ok, no_text: r.no_text })); })
          .catch(function (e) { console.error('[doc-text] reindex after toggle failed:', e.message); });
      } else {
        try {
          await docText.clearFolders(pool, descendantFolderIds(ctx, id));
        } catch (e) { console.error('[doc-text] clear after toggle failed:', e.message); }
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Folder update error:', err);
    res.status(500).json({ error: 'Failed to update folder' });
  }
});

router.delete('/folders/:id', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const fr = await pool.query('SELECT id, name FROM document_folders WHERE id = $1', [id]);
    if (!fr.rows.length) return res.status(404).json({ error: 'Folder not found' });
    if (!canEditFolder(ctx, id)) return res.status(403).json({ error: 'You cannot delete this folder' });
    // Remove every file under this folder subtree from R2 first.
    const ids = descendantFolderIds(ctx, id);
    const keys = (await pool.query('SELECT r2_key FROM documents WHERE folder_id = ANY($1::int[])', [ids])).rows;
    for (const k of keys) { try { await r2.deleteObject(k.r2_key); } catch (e) { console.error('R2 delete failed:', e.message); } }
    // DB cascade removes child folders, files, and their share rows for files;
    // folder share rows are keyed by resource_id so clean those explicitly.
    await pool.query("DELETE FROM document_shares WHERE resource_type = 'folder' AND resource_id = ANY($1::int[])", [ids]);
    await pool.query('DELETE FROM document_folders WHERE id = $1', [id]);
    logAudit({ entity_type: 'document_folder', entity_id: id, action: 'delete', user_id: req.user.id, user_name: req.user.name, details: { name: fr.rows[0].name } });
    res.json({ success: true });
  } catch (err) {
    console.error('Folder delete error:', err);
    res.status(500).json({ error: 'Failed to delete folder' });
  }
});

// ---- Files ----
// Step 1: reserve a record + presigned PUT URL. Browser uploads bytes directly to R2.
router.post('/upload-url', requireAuth, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet. Add the R2_* environment variables in Railway.' });
    const ctx = await loadContext(req.user);
    const name = (req.body.name || '').trim();
    const folderId = req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;
    const mime = (req.body.mime_type || 'application/octet-stream').slice(0, 255);
    if (!name) return res.status(400).json({ error: 'File name is required' });
    if (folderId != null) {
      const fr = await pool.query('SELECT id FROM document_folders WHERE id = $1', [folderId]);
      if (!fr.rows.length) return res.status(404).json({ error: 'Folder not found' });
    }
    if (!canWriteInto(ctx, folderId)) return res.status(403).json({ error: 'You cannot upload here' });
    const key = 'documents/' + crypto.randomUUID() + '/' + sanitizeName(name);
    const { rows } = await pool.query(
      "INSERT INTO documents (name, folder_id, r2_key, mime_type, owner_id, owner_name, status) " +
      "VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING id",
      [name.slice(0, 255), folderId, key, mime, req.user.id, req.user.name]
    );
    const uploadUrl = await r2.presignUpload(key, mime);
    res.json({ id: rows[0].id, uploadUrl: uploadUrl });
  } catch (err) {
    console.error('Upload-url error:', err);
    res.status(500).json({ error: 'Failed to start upload' });
  }
});

// Step 2: confirm the upload completed; record the size and mark it ready.
router.post('/:id/confirm', requireAuth, async function (req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT id, name, owner_id, status FROM documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    if (dr.rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your upload' });
    }
    const size = Math.max(0, parseInt(req.body.size_bytes, 10) || 0);
    await pool.query("UPDATE documents SET size_bytes = $1, status = 'ready', updated_at = NOW() WHERE id = $2", [size, id]);
    logAudit({ entity_type: 'document', entity_id: id, action: 'upload', user_id: req.user.id, user_name: req.user.name, details: { name: dr.rows[0].name } });
    // A file that landed in a policy folder gets read now, in the background.
    // Nothing anywhere else in the vault is ever extracted.
    var indexing = false;
    if (await docText.isPolicyDocument(pool, id)) {
      indexing = true;
      docText.indexInBackground(pool, id);
    }
    res.json({ success: true, indexing: indexing });
  } catch (err) {
    console.error('Confirm error:', err);
    res.status(500).json({ error: 'Failed to confirm upload' });
  }
});

// Download / preview via a short-lived presigned GET URL.
router.get('/:id/download', requireAuth, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query("SELECT id, name, r2_key, folder_id, owner_id FROM documents WHERE id = $1 AND status = 'ready'", [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    if (!canViewFile(ctx, dr.rows[0])) return res.status(403).json({ error: 'You do not have access to this file' });
    const url = await r2.presignDownload(dr.rows[0].r2_key, dr.rows[0].name, req.query.inline === '1');
    res.json({ url: url });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to generate download link' });
  }
});

router.put('/:id', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT id, name, folder_id, owner_id FROM documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    if (!canEditFile(ctx, dr.rows[0])) return res.status(403).json({ error: 'You cannot edit this file' });
    const sets = [], params = [];
    if (req.body.emailable !== undefined) {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can change email permission' });
      params.push(!!req.body.emailable); sets.push('emailable = $' + params.length);
    }
    if (typeof req.body.name === 'string' && req.body.name.trim()) {
      params.push(req.body.name.trim().slice(0, 255)); sets.push('name = $' + params.length);
    }
    // Marking a file as covering the whole fleet puts it in front of every person
    // who can see any active vehicle, which is a wider audience than the vault's
    // own sharing would ever give it. That is the point - an insurance card is
    // meant to be reachable by the tech driving the van - but it is a deliberate
    // act, so it sits at the same level as the emailable flag: admins only.
    if (req.body.fleet_scope !== undefined || req.body.fleet_kind !== undefined) {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can change fleet visibility' });
      var wantScope = !!req.body.fleet_scope;
      var wantKind = req.body.fleet_kind == null ? null : String(req.body.fleet_kind);
      if (wantScope && ['registration', 'insurance'].indexOf(wantKind) === -1) {
        return res.status(400).json({ error: 'Say whether this is a registration or an insurance document' });
      }
      params.push(wantScope); sets.push('fleet_scope = $' + params.length);
      params.push(wantScope ? wantKind : null); sets.push('fleet_kind = $' + params.length);
    }
    if (req.body.folder_id !== undefined) {
      const target = req.body.folder_id === null ? null : parseInt(req.body.folder_id, 10);
      if (target != null) {
        const tr = await pool.query('SELECT id FROM document_folders WHERE id = $1', [target]);
        if (!tr.rows.length) return res.status(404).json({ error: 'Target folder not found' });
        if (!canWriteInto(ctx, target)) return res.status(403).json({ error: 'You cannot move it there' });
      }
      params.push(target); sets.push('folder_id = $' + params.length);
    }
    // Expiration + reminder lead time. Changing the expiry re-arms both reminders.
    if (req.body.expires_on !== undefined) {
      var exp = req.body.expires_on;
      if (exp === null || exp === '') {
        sets.push('expires_on = NULL'); sets.push('reminder_lead_num = NULL'); sets.push('reminder_lead_unit = NULL');
        sets.push('reminder_sent_at = NULL'); sets.push('expiry_notice_sent_at = NULL');
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(exp))) return res.status(400).json({ error: 'Invalid expiration date' });
        var num = parseInt(req.body.reminder_lead_num, 10);
        var unit = String(req.body.reminder_lead_unit || '');
        if (!num || num < 1) num = 1;
        if (num > 999) num = 999;
        if (['days','weeks','months'].indexOf(unit) === -1) unit = 'weeks';
        params.push(exp); sets.push('expires_on = $' + params.length);
        params.push(num); sets.push('reminder_lead_num = $' + params.length);
        params.push(unit); sets.push('reminder_lead_unit = $' + params.length);
        sets.push('reminder_sent_at = NULL'); sets.push('expiry_notice_sent_at = NULL');
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at = NOW()');
    params.push(id);
    await pool.query('UPDATE documents SET ' + sets.join(', ') + ' WHERE id = $' + params.length, params);
    logAudit({ entity_type: 'document', entity_id: id, action: 'update', user_id: req.user.id, user_name: req.user.name });

    // Moving a file follows the folder it lands in. Dragged into Policies it
    // gets read; dragged out, its words go with it - otherwise a file could be
    // quoted from a folder it no longer lives in.
    if (req.body.folder_id !== undefined) {
      try {
        if (await docText.isPolicyDocument(pool, id)) docText.indexInBackground(pool, id);
        else await docText.clearDocuments(pool, [id]);
      } catch (e) { console.error('[doc-text] move follow-up failed:', e.message); }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('File update error:', err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

router.delete('/:id', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT id, name, r2_key, folder_id, owner_id FROM documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    if (!canEditFile(ctx, dr.rows[0])) return res.status(403).json({ error: 'You cannot delete this file' });
    try { await r2.deleteObject(dr.rows[0].r2_key); } catch (e) { console.error('R2 delete failed:', e.message); }
    await pool.query("DELETE FROM document_shares WHERE resource_type = 'file' AND resource_id = $1", [id]);
    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    logAudit({ entity_type: 'document', entity_id: id, action: 'delete', user_id: req.user.id, user_name: req.user.name, details: { name: dr.rows[0].name } });
    res.json({ success: true });
  } catch (err) {
    console.error('File delete error:', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Email a document as an attachment. Only docs flagged emailable (admins set that)
// can be sent; any viewer may send. The sender is CC'd a copy; from = no-reply.
function escEmail(x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
router.post('/:id/email', requireAuth, async function (req, res) {
  try {
    if (!r2.configured()) return res.status(503).json({ error: 'Document storage is not configured yet.' });
    const ctx = await loadContext(req.user);
    const id = parseInt(req.params.id, 10);
    const dr = await pool.query("SELECT id, name, r2_key, folder_id, owner_id, mime_type, size_bytes, emailable FROM documents WHERE id = $1 AND status = 'ready'", [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    const file = dr.rows[0];
    if (!canViewFile(ctx, file)) return res.status(403).json({ error: 'You do not have access to this file' });
    if (!file.emailable) return res.status(403).json({ error: 'This document is not approved for emailing. An admin must allow it first.' });
    const to = (req.body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid recipient email address' });
    if (Number(file.size_bytes) > 20 * 1024 * 1024) return res.status(413).json({ error: 'This file is over 20 MB and is too large to email as an attachment.' });
    const toName = (req.body.to_name || '').toString().slice(0, 120);
    const message = (req.body.message || '').toString().slice(0, 2000);
    let buf;
    try { buf = await r2.getObjectBuffer(file.r2_key); }
    catch (e) { console.error('R2 fetch for email failed:', e.message); return res.status(502).json({ error: 'Could not retrieve the file to send.' }); }
    const safeMsg = message ? escEmail(message).replace(/\n/g, '<br>') : '';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;line-height:1.6">' +
      '<p>' + (toName ? ('Hi ' + escEmail(toName) + ',') : 'Hello,') + '</p>' +
      '<p>Please find the attached document: <strong>' + escEmail(file.name) + '</strong>.</p>' +
      (safeMsg ? ('<p>' + safeMsg + '</p>') : '') +
      '<p>Sent by ' + escEmail(req.user.name) + ' on behalf of Lock and Roll LLC.</p>' +
      '<p style="color:#888;font-size:12px;border-top:1px solid #eee;padding-top:10px;margin-top:18px">This message was sent from an unmonitored address. Please contact Lock and Roll LLC directly with any questions.</p>' +
      '</div>';
    await sendEmail(
      to,
      'Document from Lock and Roll LLC: ' + file.name,
      html,
      req.user.email || null,
      [{ filename: file.name, content: buf.toString('base64'), content_type: file.mime_type || 'application/octet-stream' }]
    );
    logAudit({ entity_type: 'document', entity_id: id, action: 'email', user_id: req.user.id, user_name: req.user.name, details: { name: file.name, to: to } });
    res.json({ success: true });
  } catch (err) {
    console.error('Document email error:', err);
    res.status(500).json({ error: 'Failed to send the document' });
  }
});

// ---- Policy text ----
// Reading a vault file into searchable text. Both routes are admin-only for the
// same reason the folder flag is: what comes out of here can be quoted to people
// the file itself was never shared with.

// Re-read every file under every policy-source folder. This is what makes the
// feature work on documents that were uploaded long before it existed - nothing
// has to be re-uploaded. Pass full=true to redo the ones already indexed, which
// is what you want after replacing a scanned PDF with a searchable one.
router.post('/reindex-policies', requireAuth, async function (req, res) {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    var out = await docText.reindexPolicyFolders(pool, { onlyMissing: (req.body || {}).full !== true });
    logAudit({
      entity_type: 'document', entity_id: 0, action: 'reindex_policies',
      user_id: req.user.id, user_name: req.user.name,
      details: { total: out.total, ok: out.ok, no_text: out.no_text, skipped: out.skipped }
    });
    res.json(out);
  } catch (err) {
    console.error('Policy reindex error:', err);
    res.status(500).json({ error: 'Failed to re-read the policy folders' });
  }
});

// One file, on demand. Also the way to check WHY a file is not searchable: the
// status and detail come straight back.
router.post('/:id/reindex', requireAuth, async function (req, res) {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    var id = parseInt(req.params.id, 10);
    const dr = await pool.query('SELECT id FROM documents WHERE id = $1', [id]);
    if (!dr.rows.length) return res.status(404).json({ error: 'File not found' });
    if (!(await docText.isPolicyDocument(pool, id))) {
      return res.status(400).json({ error: 'That file is not in a policy folder, so it is not read at all.' });
    }
    var out = await docText.indexDocument(pool, id);
    res.json(out);
  } catch (err) {
    console.error('Reindex error:', err);
    res.status(500).json({ error: 'Failed to read that file' });
  }
});

// ---- Sharing ----
// Confirm the caller may manage shares on a resource (must be able to edit it).
async function canManageShares(ctx, type, id) {
  if (type === 'folder') return canEditFolder(ctx, id);
  const dr = await pool.query('SELECT id, folder_id, owner_id FROM documents WHERE id = $1', [id]);
  if (!dr.rows.length) return false;
  return canEditFile(ctx, dr.rows[0]);
}

router.get('/shares/:type/:id', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const type = req.params.type === 'folder' ? 'folder' : 'file';
    const id = parseInt(req.params.id, 10);
    if (!(await canManageShares(ctx, type, id))) return res.status(403).json({ error: 'You cannot manage sharing for this item' });
    const { rows } = await pool.query(
      "SELECT s.id, s.grantee_type, s.grantee_user_id, s.grantee_role, s.can_edit, u.name AS user_name " +
      "FROM document_shares s LEFT JOIN users u ON u.id = s.grantee_user_id " +
      "WHERE s.resource_type = $1 AND s.resource_id = $2 ORDER BY s.created_at ASC",
      [type, id]
    );
    res.json({ shares: rows });
  } catch (err) {
    console.error('Shares list error:', err);
    res.status(500).json({ error: 'Failed to load sharing' });
  }
});

router.post('/shares', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const type = req.body.resource_type === 'folder' ? 'folder' : 'file';
    const id = parseInt(req.body.resource_id, 10);
    const granteeType = req.body.grantee_type === 'role' ? 'role' : 'user';
    const canEdit = !!req.body.can_edit;
    if (!id) return res.status(400).json({ error: 'Missing resource' });
    if (!(await canManageShares(ctx, type, id))) return res.status(403).json({ error: 'You cannot manage sharing for this item' });

    let userId = null, role = null;
    if (granteeType === 'user') {
      userId = parseInt(req.body.grantee_user_id, 10);
      if (!userId) return res.status(400).json({ error: 'Pick a person to share with' });
    } else {
      role = String(req.body.grantee_role || '');
      if (SHAREABLE_ROLES.indexOf(role) === -1) return res.status(400).json({ error: 'Invalid role' });
    }
    // Upsert: if a share for this exact grantee already exists, just update can_edit.
    const existing = await pool.query(
      "SELECT id FROM document_shares WHERE resource_type = $1 AND resource_id = $2 AND grantee_type = $3 " +
      "AND COALESCE(grantee_user_id, -1) = COALESCE($4, -1) AND COALESCE(grantee_role, '') = COALESCE($5, '')",
      [type, id, granteeType, userId, role]
    );
    if (existing.rows.length) {
      await pool.query('UPDATE document_shares SET can_edit = $1 WHERE id = $2', [canEdit, existing.rows[0].id]);
    } else {
      await pool.query(
        'INSERT INTO document_shares (resource_type, resource_id, grantee_type, grantee_user_id, grantee_role, can_edit, created_by) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [type, id, granteeType, userId, role, canEdit, req.user.id]
      );
    }
    logAudit({ entity_type: type === 'folder' ? 'document_folder' : 'document', entity_id: id, action: 'share', user_id: req.user.id, user_name: req.user.name, details: { grantee: granteeType === 'user' ? ('user:' + userId) : ('role:' + role), can_edit: canEdit } });
    res.json({ success: true });
  } catch (err) {
    console.error('Share add error:', err);
    res.status(500).json({ error: 'Failed to share' });
  }
});

router.delete('/shares/:shareId', requireAuth, async function (req, res) {
  try {
    const ctx = await loadContext(req.user);
    const shareId = parseInt(req.params.shareId, 10);
    const sr = await pool.query('SELECT id, resource_type, resource_id FROM document_shares WHERE id = $1', [shareId]);
    if (!sr.rows.length) return res.status(404).json({ error: 'Share not found' });
    if (!(await canManageShares(ctx, sr.rows[0].resource_type, sr.rows[0].resource_id))) {
      return res.status(403).json({ error: 'You cannot manage sharing for this item' });
    }
    await pool.query('DELETE FROM document_shares WHERE id = $1', [shareId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Share remove error:', err);
    res.status(500).json({ error: 'Failed to remove share' });
  }
});

module.exports = router;
