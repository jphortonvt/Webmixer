const express = require('express');
const { ensureAdmin } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { getUploadUrl } = require('../lib/b2');

const router = express.Router();

// --- Archived sessions (restore is admin-only) ----------------------------

// List every archived session, with who archived it and when
router.get('/archived-sessions', ensureAdmin, (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT a.session_id, a.archived_at, u.email AS archived_by_email, u.name AS archived_by_name,
             n.name AS custom_name
      FROM session_archived a
      LEFT JOIN users u ON u.id = a.archived_by
      LEFT JOIN session_names n ON n.session_id = a.session_id
      ORDER BY a.archived_at DESC
    `).all();

    // Tags come along so the list is recognisable without opening each one
    const tagMap = {};
    for (const t of db.prepare('SELECT session_id, tag FROM session_tags ORDER BY tag').all()) {
      (tagMap[t.session_id] = tagMap[t.session_id] || []).push(t.tag);
    }

    res.json(rows.map(r => ({ ...r, tags: tagMap[r.session_id] || [] })));
  } catch (err) {
    console.error('[ADMIN] Failed to list archived sessions:', err);
    res.status(500).json({ error: 'Failed to list archived sessions' });
  }
});

// Restore an archived session back into everyone's picker
router.delete('/archived-sessions/:id', ensureAdmin, (req, res) => {
  const db = getDb();
  try {
    const existing = db.prepare('SELECT session_id FROM session_archived WHERE session_id = ?')
      .get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'That session is not archived' });

    db.prepare('DELETE FROM session_archived WHERE session_id = ?').run(req.params.id);
    res.json({ sessionId: req.params.id, archived: false });
  } catch (err) {
    console.error('[ADMIN] Failed to restore session:', err);
    res.status(500).json({ error: 'Failed to restore session' });
  }
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

  // Everything that points at the user goes with them, in one transaction —
  // with foreign keys enforced, a leftover reference would block the delete.
  db.transaction(() => {
    // Sign them out everywhere
    db.prepare("DELETE FROM http_sessions WHERE json_extract(data, '$.passport.user') = ? OR json_extract(data, '$.user.id') = ?")
      .run(userId, userId);

    // Their comments, plus every reply underneath them (whoever wrote it)
    db.prepare(`
      WITH RECURSIVE doomed(id) AS (
        SELECT id FROM comments WHERE user_id = ?
        UNION
        SELECT c.id FROM comments c JOIN doomed d ON c.parent_id = d.id
      )
      DELETE FROM comments WHERE id IN (SELECT id FROM doomed)
    `).run(userId);

    db.prepare('DELETE FROM mix_presets WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM playlist_items WHERE user_id = ?').run(userId);

    // Shared things they touched stay, minus the attribution
    db.prepare('UPDATE songs SET added_by = NULL WHERE added_by = ?').run(userId);
    db.prepare('UPDATE session_names SET updated_by = NULL WHERE updated_by = ?').run(userId);
    db.prepare('UPDATE session_tags SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE session_starred SET starred_by = NULL WHERE starred_by = ?').run(userId);
    db.prepare('UPDATE session_archived SET archived_by = NULL WHERE archived_by = ?').run(userId);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
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
