const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { getDb } = require('../lib/db');

const router = express.Router();

// Get current user's saved mix for a session
router.get('/sessions/:id/mix', ensureAuthenticated, (req, res) => {
  try {
    const sessionId = req.params.id;
    if (sessionId.includes('..')) return res.status(400).json({ error: 'Invalid session' });

    const db = getDb();
    const preset = db.prepare(
      'SELECT settings, updated_at, created_at FROM mix_presets WHERE user_id = ? AND session_id = ?'
    ).get(req.user.id, sessionId);

    if (!preset) return res.status(404).json({ error: 'No saved mix' });

    res.json({
      session_id: sessionId,
      settings: JSON.parse(preset.settings),
      updated_at: preset.updated_at || preset.created_at
    });
  } catch (err) {
    console.error('Error loading mix:', err);
    res.status(500).json({ error: 'Failed to load mix' });
  }
});

// Save/update mix settings for a session
router.post('/sessions/:id/mix', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  if (sessionId.includes('..')) return res.status(400).json({ error: 'Invalid session' });

  const { settings, copy_from_session } = req.body;
  const db = getDb();

  let finalSettings;

  if (copy_from_session) {
    // Copy settings from another session
    const source = db.prepare(
      'SELECT settings FROM mix_presets WHERE user_id = ? AND session_id = ?'
    ).get(req.user.id, copy_from_session);

    if (!source) return res.status(404).json({ error: 'Source mix not found' });
    finalSettings = source.settings; // Already JSON string
  } else {
    if (!settings || !Array.isArray(settings)) {
      return res.status(400).json({ error: 'settings array is required' });
    }
    finalSettings = JSON.stringify(settings);
  }

  // Upsert: try update first, then insert
  const existing = db.prepare(
    'SELECT id FROM mix_presets WHERE user_id = ? AND session_id = ?'
  ).get(req.user.id, sessionId);

  if (existing) {
    db.prepare(
      'UPDATE mix_presets SET settings = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(finalSettings, existing.id);
  } else {
    db.prepare(
      'INSERT INTO mix_presets (user_id, session_id, settings) VALUES (?, ?, ?)'
    ).run(req.user.id, sessionId, finalSettings);
  }

  res.json({
    session_id: sessionId,
    settings: JSON.parse(finalSettings),
    message: 'Mix saved'
  });
});

// List all sessions where current user has saved mixes
router.get('/mixes', ensureAuthenticated, (req, res) => {
  const db = getDb();
  const mixes = db.prepare(
    'SELECT session_id, updated_at, created_at FROM mix_presets WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);

  res.json(mixes.map(m => ({
    session_id: m.session_id,
    updated_at: m.updated_at || m.created_at
  })));
});

module.exports = router;
