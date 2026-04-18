const express = require('express');
const { ensureAdmin } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { getUploadUrl } = require('../lib/b2');

const router = express.Router();

// List all users
router.get('/users', ensureAdmin, (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, email, name, picture, is_admin, invited_at, last_login
    FROM users ORDER BY invited_at DESC
  `).all();
  res.json(users);
});

// Invite a user by email
router.post('/invite', ensureAdmin, (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'User already invited' });
  }

  const result = db.prepare('INSERT INTO users (email) VALUES (?)').run(email);
  res.json({ id: result.lastInsertRowid, email, message: 'User invited' });
});

// Revoke access
router.delete('/users/:id', ensureAdmin, (req, res) => {
  const userId = parseInt(req.params.id);
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  if (user.is_admin) {
    return res.status(400).json({ error: 'Cannot remove admin' });
  }

  // Delete their comments too
  db.prepare('DELETE FROM comments WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  res.json({ message: 'User removed' });
});

// Generate a pre-signed URL for direct browser-to-B2 upload (no server memory needed)
router.post('/upload-url', ensureAdmin, async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'key is required' });
  }

  // Validate the key matches expected pattern: YYMMDD_HHMMSS/TRACKNN.WAV
  const FOLDER_PATTERN = /^\d{6}_\d{6}$/;
  const parts = key.split('/');
  if (parts.length < 2 || !FOLDER_PATTERN.test(parts[0])) {
    return res.status(400).json({ error: 'Invalid key format. Expected: YYMMDD_HHMMSS/TRACKNAME.WAV' });
  }

  try {
    const url = await getUploadUrl(key, 'audio/wav');
    res.json({ url });
  } catch (err) {
    console.error('[UPLOAD-URL] Failed to generate pre-signed URL:', err.message);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

module.exports = router;
