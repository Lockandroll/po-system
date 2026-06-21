// SOP text chunking + full-text reindex helpers used by db.js (backfill) and routes/sops.js (upload).
// No external dependencies; chunks are stored in sop_chunks and searched via Postgres full-text (tsvector).

var CHUNK_SIZE = 1500;    // target characters per chunk
var CHUNK_OVERLAP = 200;  // characters of overlap so answers spanning a boundary still match

// Split SOP text into overlapping chunks, preferring paragraph/sentence boundaries near the target size.
function chunkSopText(content) {
  var text = (content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];
  var chunks = [];
  var start = 0;
  while (start < text.length) {
    var end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      var slice = text.slice(start, end);
      var para = slice.lastIndexOf('\n\n');
      var sent = slice.lastIndexOf('. ');
      var brk = -1;
      if (para > CHUNK_SIZE * 0.5) brk = para;
      else if (sent > CHUNK_SIZE * 0.5) brk = sent + 1;
      if (brk > 0) end = start + brk;
    }
    var piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
  }
  return chunks;
}

// Replace all chunks for one SOP. db is a pg pool or client (both expose .query).
async function reindexSop(db, sopId, content) {
  await db.query('DELETE FROM sop_chunks WHERE sop_id = $1', [sopId]);
  var chunks = chunkSopText(content);
  for (var i = 0; i < chunks.length; i++) {
    await db.query(
      'INSERT INTO sop_chunks (sop_id, chunk_index, content) VALUES ($1,$2,$3)',
      [sopId, i, chunks[i]]
    );
  }
  return chunks.length;
}

module.exports = { chunkSopText: chunkSopText, reindexSop: reindexSop };
