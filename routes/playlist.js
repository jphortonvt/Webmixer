const express = require('express');
const path = require('path');
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { getUploadUrl } = require('../lib/b2');

const router = express.Router();

// GET /api/songs — all songs in the user's preferred order
router.get('/songs', ensureAuthenticated, (req, res) => {
  const db = getDb();
  const userId = req.user.id;

  // Return songs ordered by user's saved position; songs without a position come last (ordered by id).
  // enabled defaults to 1 for songs the user has no playlist row for yet.
  const songs = db.prepare(`
    SELECT s.id, s.name, s.filename, s.duration, s.added_at,
           s.source_session_id, s.range_start, s.range_end,
           COALESCE(pi.position, 999999) AS _pos,
           COALESCE(pi.enabled, 1) AS enabled
    FROM songs s
    LEFT JOIN playlist_items pi ON pi.song_id = s.id AND pi.user_id = ?
    ORDER BY _pos ASC, s.id ASC
  `).all(userId);

  // sql.js hands back integers; the client wants a boolean
  res.json(songs.map(s => ({ ...s, enabled: !!s.enabled })));
});

// PUT /api/playlist/:songId/enabled — per-user rotation toggle
router.put('/playlist/:songId/enabled', ensureAuthenticated, (req, res) => {
  const songId = parseInt(req.params.songId, 10);
  if (isNaN(songId)) return res.status(400).json({ error: 'Invalid song id' });

  const enabled = !!(req.body && req.body.enabled);
  const db = getDb();
  const userId = req.user.id;

  const song = db.prepare('SELECT id FROM songs WHERE id = ?').get(songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  try {
    const existing = db.prepare('SELECT id FROM playlist_items WHERE user_id = ? AND song_id = ?')
      .get(userId, songId);

    if (existing) {
      db.prepare('UPDATE playlist_items SET enabled = ? WHERE user_id = ? AND song_id = ?')
        .run(enabled ? 1 : 0, userId, songId);
    } else {
      // No saved order yet for this user — append to the end
      const max = db.prepare('SELECT MAX(position) AS m FROM playlist_items WHERE user_id = ?').get(userId);
      const position = (max && max.m != null ? max.m : -1) + 1;
      db.prepare('INSERT INTO playlist_items (user_id, song_id, position, enabled) VALUES (?, ?, ?, ?)')
        .run(userId, songId, position, enabled ? 1 : 0);
    }

    res.json({ songId, enabled });
  } catch (err) {
    console.error('[PLAYLIST] Enabled toggle error:', err);
    res.status(500).json({ error: 'Failed to update song' });
  }
});

// PUT /api/playlist/order — save the user's song order
router.put('/playlist/order', ensureAuthenticated, (req, res) => {
  const { songIds } = req.body;
  if (!Array.isArray(songIds)) {
    return res.status(400).json({ error: 'songIds must be an array' });
  }

  const db = getDb();
  const userId = req.user.id;

  // Carry the enabled flags across the wipe-and-reinsert below, or reordering
  // would silently switch every disabled song back on.
  const wasEnabled = {};
  for (const row of db.prepare('SELECT song_id, enabled FROM playlist_items WHERE user_id = ?').all(userId)) {
    wasEnabled[row.song_id] = row.enabled;
  }

  // Wipe existing order and re-insert
  db.prepare('DELETE FROM playlist_items WHERE user_id = ?').run(userId);

  const ins = db.prepare(
    'INSERT INTO playlist_items (user_id, song_id, position, enabled) VALUES (?, ?, ?, ?)'
  );
  songIds.forEach((songId, pos) => {
    try {
      const id = parseInt(songId, 10);
      ins.run(userId, id, pos, wasEnabled[id] != null ? wasEnabled[id] : 1);
    } catch (_) {
      // Skip invalid song ids
    }
  });

  res.json({ ok: true });
});

// POST /api/admin/songs/upload-url — get a pre-signed URL for direct browser-to-B2 upload
router.post('/admin/songs/upload-url', ensureAdmin, async (req, res) => {
  const { filename, contentType } = req.body;
  if (!filename) {
    return res.status(400).json({ error: 'filename is required' });
  }

  // Sanitize: no path components, allow common audio filename characters
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._\-()\s]/g, '_');
  const key = `songs/${safeName}`;

  try {
    const url = await getUploadUrl(key, contentType || 'audio/mpeg');
    res.json({ url, filename: safeName, key });
  } catch (err) {
    console.error('[SONGS] Upload URL error:', err.message);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

// POST /api/admin/songs — register a song in the DB after it's been uploaded to B2
router.post('/admin/songs', ensureAdmin, (req, res) => {
  const { name, filename, duration } = req.body;
  if (!name || !filename) {
    return res.status(400).json({ error: 'name and filename are required' });
  }

  const db = getDb();
  try {
    const result = db.prepare(
      'INSERT INTO songs (name, filename, duration, added_by) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), filename, duration || null, req.user.id);

    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(song);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'A song with that filename already exists' });
    }
    console.error('[SONGS] Insert error:', err);
    res.status(500).json({ error: 'Failed to save song' });
  }
});

// DELETE /api/admin/songs/:id — remove a song (removes from all playlists too)
router.delete('/admin/songs/:id', ensureAdmin, (req, res) => {
  const songId = parseInt(req.params.id, 10);
  if (isNaN(songId)) return res.status(400).json({ error: 'Invalid id' });

  const db = getDb();
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  db.prepare('DELETE FROM playlist_items WHERE song_id = ?').run(songId);
  db.prepare('DELETE FROM songs WHERE id = ?').run(songId);

  res.json({ message: 'Song deleted' });
});

module.exports = router;
