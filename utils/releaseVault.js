// Where a signed Release of Liability lands in the Document Vault.
//
// Before 2026-10-15 every completed release went into a root folder called
// "Signed Documents" owned by whoever CREATED the release, made on the spot if
// that person did not have one yet. The vault filled up with identical
// "Signed Documents" folders (one per person), a company settlement record sat
// in one employee's personal folder, and it went with them if they left.
// Tony's call: every release lives in ONE company folder, "Liability Releases".
//
// The folder:
//   1. settings.release_vault_folder_id, if set and the folder still exists
//      (lets the folder be renamed or moved without a deploy);
//   2. else the oldest root folder named "Liability Releases" (any case);
//   3. else it is created, owned by the business owner (role 'owner').
// The FILE is owned by the folder's owner too, not the person who created the
// release. Otherwise the vault shows that person a loose copy at their root
// (canViewFile lets a file owner see it even when the folder is not shared).
// The creator still has it on the complaint and in the completion email; who
// else sees the folder is a normal vault Share.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.

var FOLDER_NAME = 'Liability Releases';

async function ensureFolder(pool, fallbackOwnerId) {
  try {
    var s = await pool.query("SELECT value FROM settings WHERE key = 'release_vault_folder_id'");
    var sid = s.rows.length ? parseInt(s.rows[0].value, 10) : NaN;
    if (sid) {
      var f = await pool.query('SELECT id, owner_id, owner_name FROM document_folders WHERE id = $1', [sid]);
      if (f.rows.length) return f.rows[0];
    }
  } catch (e) { console.error('[release-vault] setting:', e.message); }

  var found = await pool.query(
    "SELECT id, owner_id, owner_name FROM document_folders " +
    "WHERE parent_id IS NULL AND LOWER(TRIM(name)) = LOWER($1) ORDER BY id ASC LIMIT 1",
    [FOLDER_NAME]
  );
  if (found.rows.length) return found.rows[0];

  var owner = (await pool.query(
    "SELECT id, name FROM users WHERE role = 'owner' AND active IS NOT FALSE ORDER BY id ASC LIMIT 1"
  )).rows[0];
  if (!owner && fallbackOwnerId) {
    owner = (await pool.query('SELECT id, name FROM users WHERE id = $1', [fallbackOwnerId])).rows[0];
  }
  var made = await pool.query(
    'INSERT INTO document_folders (name, parent_id, owner_id, owner_name) VALUES ($1, NULL, $2, $3) ' +
    'RETURNING id, owner_id, owner_name',
    [FOLDER_NAME, owner ? owner.id : null, owner ? owner.name : null]
  );
  return made.rows[0];
}

// One-time (idempotent) move of releases already filed under the old
// per-person "Signed Documents" folders. Runs at boot; does nothing once every
// release is in the folder. A "Signed Documents" folder it empties is removed;
// one that still holds other signed files (e-signatures, separation
// agreements) is left alone.
async function backfill(pool) {
  var stray = (await pool.query(
    "SELECT id, folder_id FROM documents WHERE r2_key LIKE 'releases/%'"
  )).rows;
  if (!stray.length) return { moved: 0, removed: 0 };
  var folder = await ensureFolder(pool, null);
  var toMove = stray.filter(function (d) { return d.folder_id !== folder.id; });
  if (!toMove.length) return { moved: 0, removed: 0 };
  var oldFolders = {};
  toMove.forEach(function (d) { if (d.folder_id) oldFolders[d.folder_id] = true; });
  await pool.query(
    'UPDATE documents SET folder_id = $1, owner_id = $2, owner_name = $3 WHERE id = ANY($4::int[])',
    [folder.id, folder.owner_id, folder.owner_name, toMove.map(function (d) { return d.id; })]
  );
  var del = await pool.query(
    "DELETE FROM document_folders f WHERE f.id = ANY($1::int[]) AND f.name = 'Signed Documents' " +
    'AND f.parent_id IS NULL ' +
    'AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id) ' +
    'AND NOT EXISTS (SELECT 1 FROM document_folders c WHERE c.parent_id = f.id) RETURNING f.id',
    [Object.keys(oldFolders).map(Number)]
  );
  return { moved: toMove.length, removed: del.rows.length };
}

module.exports = { ensureFolder: ensureFolder, backfill: backfill, FOLDER_NAME: FOLDER_NAME };
