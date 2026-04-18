const express = require('express');
const multer = require('multer');
const { ensureAdmin } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { uploadFile } = require('../lib/b2');

const router = express.Router();

// Multer — store in memory, limit 200MB per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

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

// Upload audio files to B2
// Accepts multiple files with folder paths preserved via webkitdirectory
router.post('/upload', ensureAdmin, (req, res, next) => {
  upload.array('files')(req, res, (err) => {
    if (err) {
      console.error('[UPLOAD] Multer error:', err.message);
      return res.status(400).json({ error: err.message, uploaded: 0, skipped: 0, errors: [], details: [] });
    }
    next();
  });
}, async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  const results = { uploaded: 0, skipped: 0, errors: [], details: [] };
  const FOLDER_PATTERN = /^\d{6}_\d{6}$/;
  const WAV_PATTERN = /\.wav$/i;

  // The relative paths may come as a separate field (since browsers strip paths from filenames)
  const relativePaths = req.body.relativePaths
    ? (Array.isArray(req.body.relativePaths) ? req.body.relativePaths : [req.body.relativePaths])
    : [];

  for (let fi = 0; fi < req.files.length; fi++) {
    const file = req.files[fi];
    // Use the explicit relativePath field if available, fall back to originalname
    const rawPath = (relativePaths[fi] || file.originalname || '').replace(/\\/g, '/');
    const parts = rawPath.split('/');

    console.log(`[UPLOAD] Processing: originalname=${file.originalname}, relativePath=${relativePaths[fi] || '(none)'}, parts=${JSON.stringify(parts)}`);

    // Find the session folder part (YYMMDD_HHMMSS pattern)
    let sessionId = null;
    let fileName = null;
    for (let i = 0; i < parts.length; i++) {
      if (FOLDER_PATTERN.test(parts[i])) {
        sessionId = parts[i];
        fileName = parts.slice(i + 1).join('/');
        break;
      }
    }

    if (!sessionId || !fileName) {
      console.log(`[UPLOAD] Skipped (no session folder found in path): ${rawPath}`);
      results.skipped++;
      results.details.push({ file: rawPath, reason: 'No YYMMDD_HHMMSS folder found in path' });
      continue;
    }

    if (!WAV_PATTERN.test(fileName)) {
      results.skipped++;
      results.details.push({ file: rawPath, reason: 'Not a WAV file' });
      continue;
    }

    const key = `${sessionId}/${fileName}`;
    try {
      await uploadFile(key, file.buffer, 'audio/wav');
      results.uploaded++;
      console.log(`[UPLOAD] Success: ${key} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error(`[UPLOAD] Failed: ${key}`, err.message);
      results.errors.push({ file: key, error: err.message });
    }
  }

  res.json(results);
});

module.exports = router;
