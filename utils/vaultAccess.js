// Vault access model, shared.
//
// This lived inside routes/documents.js until the Fleet document linking was
// built. It moved out here because a SECOND caller now needs the exact same
// answer to "may this person see this vault file": routes/vehicles.js has to
// check it before letting anyone attach a document to a truck. Two copies of an
// access rule is how a leak gets built, so there is one copy and both require it.
//
// Note what is NOT here: reading a registration or an insurance card THROUGH a
// vehicle deliberately does not consult this file. That read is gated on being
// able to see the vehicle instead - see routes/vehicles.js. The vault rules gate
// who can browse, upload, rename, delete and ATTACH; they do not gate a tech
// pulling up the insurance card for the van they are sitting in.

const { pool } = require('../db');

// Roles that can be granted access via a "share with role". Only owners see
// everything by default; admins must be granted access like anyone else, so the
// admin role is offered as a share target (lets an owner grant the whole group).
const SHAREABLE_ROLES = ['admin', 'manager', 'locksmith_coordinator', 'dispatcher', 'locksmith', 'roadside_technician'];

// Build the per-request access picture for a user. Only owners see everything;
// admins (and everyone else) are limited to what they own or have been shared.
// We load the folder tree once and expand ownership and shares downward (a folder
// grant cascades to all descendants).
async function loadContext(user) {
  const isOwner = !!user.isOwner; // owner role is coerced to 'admin' upstream, but isOwner is preserved
  const ctx = {
    isOwner: isOwner,
    userId: user.id,
    viewFolders: new Set(),
    editFolders: new Set(),
    viewFiles: new Set(),
    editFiles: new Set(),
    childrenOf: new Map()
  };
  const folders = (await pool.query('SELECT id, parent_id, owner_id FROM document_folders')).rows;
  folders.forEach(function (f) {
    if (!ctx.childrenOf.has(f.parent_id)) ctx.childrenOf.set(f.parent_id, []);
    ctx.childrenOf.get(f.parent_id).push(f.id);
  });
  if (isOwner) return ctx;

  function addDescendants(id, set) {
    set.add(id);
    (ctx.childrenOf.get(id) || []).forEach(function (c) { addDescendants(c, set); });
  }
  // Owned folders: full view + edit, cascading down.
  folders.forEach(function (f) {
    if (f.owner_id === user.id) { addDescendants(f.id, ctx.viewFolders); addDescendants(f.id, ctx.editFolders); }
  });
  // Shares targeting this user directly or via their role.
  const shares = (await pool.query(
    "SELECT resource_type, resource_id, can_edit FROM document_shares " +
    "WHERE (grantee_type = 'user' AND grantee_user_id = $1) OR (grantee_type = 'role' AND grantee_role = $2)",
    [user.id, user.role]
  )).rows;
  shares.forEach(function (s) {
    if (s.resource_type === 'folder') {
      addDescendants(s.resource_id, ctx.viewFolders);
      if (s.can_edit) addDescendants(s.resource_id, ctx.editFolders);
    } else {
      ctx.viewFiles.add(s.resource_id);
      if (s.can_edit) ctx.editFiles.add(s.resource_id);
    }
  });
  return ctx;
}

function canViewFolder(ctx, id) { return ctx.isOwner || ctx.viewFolders.has(id); }
function canEditFolder(ctx, id) { return ctx.isOwner || ctx.editFolders.has(id); }
function canViewFile(ctx, file) {
  if (ctx.isOwner) return true;
  if (file.owner_id === ctx.userId) return true;
  if (ctx.viewFiles.has(file.id)) return true;
  return file.folder_id != null && ctx.viewFolders.has(file.folder_id);
}
function canEditFile(ctx, file) {
  if (ctx.isOwner) return true;
  if (file.owner_id === ctx.userId) return true;
  if (ctx.editFiles.has(file.id)) return true;
  return file.folder_id != null && ctx.editFolders.has(file.folder_id);
}
// Can the user create folders / upload files into this location?
// Root (null) is open to everyone (they own what they create); folders require edit.
function canWriteInto(ctx, folderId) {
  if (folderId == null) return true;
  return canEditFolder(ctx, folderId);
}

// All descendant folder ids of a folder (inclusive), for move-cycle checks + deletes.
function descendantFolderIds(ctx, id) {
  const out = [];
  (function walk(fid) { out.push(fid); (ctx.childrenOf.get(fid) || []).forEach(walk); })(id);
  return out;
}

module.exports = {
  SHAREABLE_ROLES: SHAREABLE_ROLES,
  loadContext: loadContext,
  canViewFolder: canViewFolder,
  canEditFolder: canEditFolder,
  canViewFile: canViewFile,
  canEditFile: canEditFile,
  canWriteInto: canWriteInto,
  descendantFolderIds: descendantFolderIds
};
