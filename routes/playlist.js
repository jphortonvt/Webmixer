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

  // Return songs ordered by user's saved position; songs without a position come last (ordered by id)
  const songs = db.prepare(`
    SELECT s.id, s.name, s.filename, s.duration, s.added_at,
           COALESCE(pi.position, 999999) AS _pos
    FROM songs s
    LEFT JOIN playlist_items pi ON pi.song_id = s.id AND pi.user_id = ?
    ORDER BY _pos ASC, s.id ASC
  `).all(userId);

  res.json(songs);
});

// PUT /api/playlist/order — save the user's song order
router.put('/playlist/order', ensureAuthenticated, (req, res) => {
  const { songIds } = req.body;
  if (!Array.isArray(songIds)) {
    return res.status(400).json({ error: 'songIds must be an array' });
  }

  const db = getDb();
  const userId = req.user.id;

  // Wipe existing order and re-insert
  db.prepare('DELETE FROM playlist_items WHERE user_id = ?').run(userId);

  const ins = db.prepare(
    'INSERT INTO playlist_items (user_id, song_id, position) VALUES (?, ?, ?)'
  );
  songIds.forEach((songId, pos) => {
    try {
      ins.run(userId, parseInt(songId, 10), pos);
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
