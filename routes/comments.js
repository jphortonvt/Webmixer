const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { getDb } = require('../lib/db');

const router = express.Router();

// Get all comments for a session (threaded)
router.get('/sessions/:id/comments', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  if (sessionId.includes('..')) return res.status(400).json({ error: 'Invalid session' });

  const db = getDb();
  const comments = db.prepare(`
    SELECT c.id, c.session_id, c.user_id, c.parent_id, c.timestamp_seconds,
           c.body, c.created_at, c.updated_at,
           u.name AS user_name, u.email AS user_email, u.picture AS user_picture
    FROM comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.session_id = ?
    ORDER BY c.timestamp_seconds ASC, c.created_at ASC
  `).all(sessionId);

  // Build threaded structure
  const topLevel = [];
  const byId = {};

  for (const c of comments) {
    c.replies = [];
    byId[c.id] = c;
  }

  for (const c of comments) {
    if (c.parent_id && byId[c.parent_id]) {
      byId[c.parent_id].replies.push(c);
    } else {
      topLevel.push(c);
    }
  }

  res.json(topLevel);
});

// Create a comment
router.post('/sessions/:id/comments', ensureAuthenticated, (req, res) => {
  const sessionId = req.params.id;
  if (sessionId.includes('..')) return res.status(400).json({ error: 'Invalid session' });

  const { timestamp_seconds, body, parent_id } = req.body;

  if (timestamp_seconds == null || !body || !body.trim()) {
    return res.status(400).json({ error: 'timestamp_seconds and body are required' });
  }

  const db = getDb();

  // If replying, validate parent exists and belongs to same session
  if (parent_id) {
    const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND session_id = ?').get(parent_id, sessionId);
    if (!parent) {
      return res.status(400).json({ error: 'Parent comment not found' });
    }
  }

  const result = db.prepare(`
    INSERT INTO comments (session_id, user_id, parent_id, timestamp_seconds, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, req.user.id, parent_id || null, timestamp_seconds, body.trim());

  // Return the created comment with user info
  const comment = db.prepare(`
    SELECT c.*, u.name AS user_name, u.email AS user_email, u.picture AS user_picture
    FROM comments c JOIN users u ON c.user_id = u.id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  comment.replies = [];
  res.status(201).json(comment);
});

// Delete a comment (own comments or admin)
router.delete('/comments/:commentId', ensureAuthenticated, (req, res) => {
  const commentId = parseInt(req.params.commentId);
  const db = getDb();
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);

  if (!comment) return res.status(404).json({ error: 'Comment not found' });

  if (comment.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'Not authorized' });
  }

  // Delete replies first, then the comment
  db.prepare('DELETE FROM comments WHERE parent_id = ?').run(commentId);
  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  res.json({ message: 'Comment deleted' });
});

module.exports = router;
