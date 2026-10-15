// Signed releases of liability do NOT go in the Document Vault.
//
// Until 2026-10-15 completing a release also dropped the signed PDF into a root
// vault folder called "Signed Documents" owned by whoever created the release,
// creating that folder if the person did not have one. That filled the vault
// with identical "Signed Documents" folders, and it was a duplicate anyway: the
// Liability Releases tab already lists every release with its signed PDF
// (release_forms.signed_r2_key), and the complaint's Attachments card points at
// the same object. Tony's call: releases live in the Liability Releases tab
// only. routes/releases.js no longer writes to the vault.
//
// It was worse than clutter: the vault row pointed at the SAME R2 object as the
// release, so deleting it from the vault (routes/documents.js deletes the R2
// object) would have broken the signed copy on the release itself.
//
// cleanup() removes the old vault rows at boot. It deletes ROWS ONLY and never
// touches R2: the object is still the release's signed copy. A "Signed
// Documents" folder it empties is removed; one that still holds other signed
// files (e-signatures, separation agreements) is left alone. Idempotent.
//
// IMPORTANT: never use backticks/template literals in this file (Windows
// corrupts backticks in .js files); string concatenation only.

async function cleanup(pool) {
  var rows = (await pool.query(
    "SELECT id, folder_id FROM documents WHERE r2_key LIKE 'releases/%'"
  )).rows;
  if (!rows.length) return { removed_files: 0, removed_folders: 0 };
  var ids = rows.map(function (d) { return d.id; });
  var folders = {};
  rows.forEach(function (d) { if (d.folder_id) folders[d.folder_id] = true; });
  await pool.query("DELETE FROM document_shares WHERE resource_type = 'file' AND resource_id = ANY($1::int[])", [ids]);
  await pool.query('DELETE FROM documents WHERE id = ANY($1::int[])', [ids]);
  var del = await pool.query(
    "DELETE FROM document_folders f WHERE f.id = ANY($1::int[]) AND f.name = 'Signed Documents' " +
    'AND f.parent_id IS NULL ' +
    'AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.folder_id = f.id) ' +
    'AND NOT EXISTS (SELECT 1 FROM document_folders c WHERE c.parent_id = f.id) RETURNING f.id',
    [Object.keys(folders).map(Number)]
  );
  if (del.rows.length) {
    await pool.query("DELETE FROM document_shares WHERE resource_type = 'folder' AND resource_id = ANY($1::int[])",
      [del.rows.map(function (r) { return r.id; })]);
  }
  return { removed_files: ids.length, removed_folders: del.rows.length };
}

module.exports = { cleanup: cleanup };
