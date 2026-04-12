const express = require('express');
const path = require('path');
const { getSessions, getSessionTracks } = require('../lib/sessions');
const { transcodeSession, isSessionCached } = require('../lib/transcode');
const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

const AUDIO_DIR = path.resolve(process.env.AUDIO_DIR || './raw_audio');
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');

router.get('/sessions', ensureAuthenticated, (req, res) => {
  try {
    const sessions = getSessions(AUDIO_DIR);
    res.json(sessions);
  } catch (err) {
    console.error('Error listing sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.get('/sessions/:id/tracks', ensureAuthenticated, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const trackFiles = getSessionTracks(AUDIO_DIR, sessionId);

    // Transcode if not already cached
    if (!isSessionCached(CACHE_DIR, sessionId, trackFiles)) {
      console.log(`Transcoding session ${sessionId}...`);
      await transcodeSession(AUDIO_DIR, CACHE_DIR, sessionId, trackFiles);
      console.log(`Transcoding complete for ${sessionId}`);
    }

    const tracks = trackFiles.map(f => ({
      name: f,
      url: `/audio/${sessionId}/${f.replace(/\.wav$/i, '.ogg')}`
    }));

    res.json({ sessionId, tracks });
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
