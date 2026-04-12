const express = require('express');
const path = require('path');
const { getSessions, getSessionTracks } = require('../lib/sessions');
const { transcodeSession, isSessionCached } = require('../lib/transcode');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');

// Track which sessions are currently being transcoded
const transcodingInProgress = new Map();

router.get('/sessions', ensureAuthenticated, async (req, res) => {
  try {
    const sessions = await getSessions();
    res.json(sessions);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.get('/sessions/:id/tracks', ensureAuthenticated, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const trackFiles = await getSessionTracks(sessionId);

    if (isSessionCached(CACHE_DIR, sessionId, trackFiles)) {
      // All tracks cached — return immediately
      const tracks = trackFiles.map(f => ({
        name: f,
        url: `/audio/${sessionId}/${f.replace(/\.wav$/i, '.ogg')}`
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
