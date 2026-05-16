const express = require('express');
const path = require('path');
const { getSessions, getSessionTracks } = require('../lib/sessions');
const { transcodeSession, isSessionCached } = require('../lib/transcode');
const { ensureAuthenticated } = require('../middleware/auth');
const { getDb } = require('../lib/db');

const router = express.Router();

const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');

// Track which sessions are currently being transcoded
const transcodingInProgress = new Map();

router.get('/sessions', ensureAuthenticated, async (req, res) => {
  try {
    const sessions = await getSessions();
    const db = getDb();

    // Attach custom names from the database
    const names = db.prepare('SELECT session_id, name FROM session_names').all();
    const nameMap = {};
    for (const n of names) {
      nameMap[n.session_id] = n.name;
    }

    for (const s of sessions) {
      s.customName = nameMap[s.id] || null;
    }

    res.json(sessions);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Set or update a session's custom name
router.put('/sessions/:id/name', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  const { name } = req.body;

  if (!name || !name.trim()) {
    // Delete the name
    const db = getDb();
    db.prepare('DELETE FROM session_names WHERE session_id = ?').run(sessionId);
    return res.json({ sessionId, name: null });
  }

  const db = getDb();
  const existing = db.prepare('SELECT session_id FROM session_names WHERE session_id = ?').get(sessionId);
  if (existing) {
    db.prepare('UPDATE session_names SET name = ?, updated_by = ?, updated_at = datetime(\'now\') WHERE session_id = ?')
      .run(name.trim(), req.user.id, sessionId);
  } else {
    db.prepare('INSERT INTO session_names (session_id, name, updated_by) VALUES (?, ?, ?)')
      .run(sessionId, name.trim(), req.user.id);
  }

  res.json({ sessionId, name: name.trim() });
});

router.get('/sessions/:id/tracks', ensureAuthenticated, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const trackFiles = await getSessionTracks(sessionId);

    if (isSessionCached(CACHE_DIR, sessionId, trackFiles)) {
      // All tracks cached — return immediately
      const tracks = trackFiles.map(f => ({
        name: f,
        url: `/audio/${sessionId}/${f.replace(/\.wav$/i, '.mp3')}`
      }));
      return res.json({ sessionId, tracks });
    }

    // Not cached — start transcoding in background if not already running
    if (!transcodingInProgress.has(sessionId)) {
      console.log(`Transcoding session ${sessionId}...`);
      const promise = transcodeSession(CACHE_DIR, sessionId, trackFiles)
        .then(() => {
          console.log(`Transcoding complete for ${sessionId}`);
          transcodingInProgress.delete(sessionId);
        })
        .catch(err => {
          console.error(`Transcoding failed for ${sessionId}:`, err);
          transcodingInProgress.delete(sessionId);
        });
      transcodingInProgress.set(sessionId, promise);
    }

    // Return a "preparing" response so the frontend can poll
    res.json({ sessionId, preparing: true, trackCount: trackFiles.length });
  } catch (err) {
    console.error('Error getting tracks:', err);
    if (err.message === 'Session not found') {
      res.status(404).json({ error: 'Session not found' });
    } else {
      res.status(500).json({ error: 'Failed to load tracks' });
    }
  }
});

module.exports = router;
