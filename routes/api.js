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
      const tracks = trackFiles.map(track => ({
        name: track.name,
        url: `/audio/${sessionId}/${track.name.replace(/\.wav$/i, '.mp3')}`,
        type: track.type,
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

// GET track icons for a session
router.get('/sessions/:id/icons', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  const db = getDb();
  try {
    const rows = db.prepare('SELECT track_name, icon FROM track_icons WHERE session_id = ?').all(sessionId);
    const icons = {};
    for (const r of rows) {
      icons[r.track_name] = r.icon;
    }
    res.json(icons);
  } catch (err) {
    console.error('Error fetching track icons:', err);
    res.status(500).json({ error: 'Failed to fetch track icons' });
  }
});

// PUT (upsert) track icon for a session
router.put('/sessions/:id/icons', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  const { track_name, icon } = req.body;

  if (!track_name || !icon) {
    return res.status(400).json({ error: 'track_name and icon required' });
  }

  const db = getDb();
  try {
    const existing = db.prepare('SELECT 1 FROM track_icons WHERE session_id = ? AND track_name = ?').get(sessionId, track_name);
    if (existing) {
      db.prepare('UPDATE track_icons SET icon = ?, updated_at = datetime(\'now\') WHERE session_id = ? AND track_name = ?')
        .run(icon, sessionId, track_name);
    } else {
      db.prepare('INSERT INTO track_icons (session_id, track_name, icon) VALUES (?, ?, ?)')
        .run(sessionId, track_name, icon);
    }
    res.json({ message: 'Icon saved', track_name, icon });
  } catch (err) {
    console.error('Error saving track icon:', err);
    res.status(500).json({ error: 'Failed to save track icon' });
  }
});

module.exports = router;
