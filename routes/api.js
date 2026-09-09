const express = require('express');
const fs = require('fs');
const path = require('path');
const { getSessions, getSessionTracks } = require('../lib/sessions');
const { transcodeSession, isSessionCached, renderMixdown } = require('../lib/transcode');
const { ensureAuthenticated } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { uploadFile } = require('../lib/b2');

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

    // Tags, grouped per session — one query rather than one per session
    const tagMap = {};
    for (const row of db.prepare('SELECT session_id, tag FROM session_tags ORDER BY tag').all()) {
      (tagMap[row.session_id] = tagMap[row.session_id] || []).push(row.tag);
    }

    const starred = new Set(
      db.prepare('SELECT session_id FROM session_starred').all().map(r => r.session_id)
    );
    const archived = new Set(
      db.prepare('SELECT session_id FROM session_archived').all().map(r => r.session_id)
    );

    for (const s of sessions) {
      s.customName = nameMap[s.id] || null;
      s.tags = tagMap[s.id] || [];
      s.starred = starred.has(s.id);
      s.archived = archived.has(s.id);
    }

    // Archived sessions are hidden from the picker unless explicitly asked for
    const visible = req.query.includeArchived
      ? sessions
      : sessions.filter(s => !s.archived);

    res.json(visible);
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

// --- Archive: tags and starring -------------------------------------------
// Any authenticated band member can tag or star; these are shared, not admin-only.

function normaliseTag(raw) {
  if (typeof raw !== 'string') return null;
  // strip a leading # so "#loud" and "loud" are the same tag
  const tag = raw.trim().replace(/^#+/, '').toLowerCase();
  if (!tag || tag.length > 40) return null;
  return tag;
}

router.post('/sessions/:id/tags', ensureAuthenticated, (req, res) => {
  const tag = normaliseTag(req.body && req.body.tag);
  if (!tag) return res.status(400).json({ error: 'A tag of 1-40 characters is required' });

  const db = getDb();
  try {
    const existing = db.prepare('SELECT id FROM session_tags WHERE session_id = ? AND tag = ?')
      .get(req.params.id, tag);
    if (!existing) {
      db.prepare('INSERT INTO session_tags (session_id, tag, created_by) VALUES (?, ?, ?)')
        .run(req.params.id, tag, req.user.id);
    }
    const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag')
      .all(req.params.id).map(r => r.tag);
    res.json({ sessionId: req.params.id, tags });
  } catch (err) {
    console.error('Error adding tag:', err);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

router.delete('/sessions/:id/tags/:tag', ensureAuthenticated, (req, res) => {
  const tag = normaliseTag(req.params.tag);
  if (!tag) return res.status(400).json({ error: 'Invalid tag' });

  const db = getDb();
  try {
    db.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag = ?').run(req.params.id, tag);
    const tags = db.prepare('SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag')
      .all(req.params.id).map(r => r.tag);
    res.json({ sessionId: req.params.id, tags });
  } catch (err) {
    console.error('Error removing tag:', err);
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

// Replace a session's whole tag set in one call — matches the comma-separated
// prompt the UI uses, and saves a round trip per tag.
router.put('/sessions/:id/tags', ensureAuthenticated, (req, res) => {
  const raw = Array.isArray(req.body && req.body.tags) ? req.body.tags : [];
  const tags = [...new Set(raw.map(normaliseTag).filter(Boolean))].sort();

  const db = getDb();
  try {
    db.prepare('DELETE FROM session_tags WHERE session_id = ?').run(req.params.id);
    for (const tag of tags) {
      db.prepare('INSERT INTO session_tags (session_id, tag, created_by) VALUES (?, ?, ?)')
        .run(req.params.id, tag, req.user.id);
    }
    res.json({ sessionId: req.params.id, tags });
  } catch (err) {
    console.error('Error setting tags:', err);
    res.status(500).json({ error: 'Failed to set tags' });
  }
});

// Archive a session — hides it from everyone's picker. Restoring is
// admin-only and lives in routes/admin.js.
router.put('/sessions/:id/archive', ensureAuthenticated, (req, res) => {
  const db = getDb();
  try {
    const existing = db.prepare('SELECT session_id FROM session_archived WHERE session_id = ?')
      .get(req.params.id);
    if (!existing) {
      db.prepare('INSERT INTO session_archived (session_id, archived_by) VALUES (?, ?)')
        .run(req.params.id, req.user.id);
    }
    res.json({ sessionId: req.params.id, archived: true });
  } catch (err) {
    console.error('Error archiving session:', err);
    res.status(500).json({ error: 'Failed to archive session' });
  }
});

router.put('/sessions/:id/star', ensureAuthenticated, (req, res) => {
  const starred = !!(req.body && req.body.starred);
  const db = getDb();
  try {
    if (starred) {
      const existing = db.prepare('SELECT session_id FROM session_starred WHERE session_id = ?')
        .get(req.params.id);
      if (!existing) {
        db.prepare('INSERT INTO session_starred (session_id, starred_by) VALUES (?, ?)')
          .run(req.params.id, req.user.id);
      }
    } else {
      db.prepare('DELETE FROM session_starred WHERE session_id = ?').run(req.params.id);
    }
    res.json({ sessionId: req.params.id, starred });
  } catch (err) {
    console.error('Error setting star:', err);
    res.status(500).json({ error: 'Failed to set star' });
  }
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

// --- Mixdown: render a session to a song in the shared playlist -----------
// Any band member can render one (unlike the admin-only song upload).

function formatRange(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Renders can take a while, so a mixdown runs as a job the client polls
// rather than holding a request open with no feedback.
const mixdownJobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function setJob(jobId, patch) {
  const job = Object.assign(mixdownJobs.get(jobId) || {}, patch, { updatedAt: Date.now() });
  mixdownJobs.set(jobId, job);
  return job;
}

// Drop finished jobs after a while so the map cannot grow without bound
function reapJobs() {
  const now = Date.now();
  for (const [id, job] of mixdownJobs) {
    if (job.stage !== 'running' && now - job.updatedAt > JOB_TTL_MS) mixdownJobs.delete(id);
  }
}

router.get('/mixdown/:jobId', ensureAuthenticated, (req, res) => {
  const job = mixdownJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown or expired job' });
  if (job.userId !== req.user.id) return res.status(403).json({ error: 'Not your export' });
  res.json({
    jobId: req.params.jobId,
    stage: job.stage,
    percent: job.percent || 0,
    message: job.message || '',
    song: job.song || null,
    error: job.error || null,
  });
});

router.post('/sessions/:id/mixdown', ensureAuthenticated, async (req, res) => {
  const sessionId = req.params.id;
  const { settings, format, startSeconds, endSeconds, name } = req.body || {};

  if (!Array.isArray(settings) || settings.length === 0) {
    return res.status(400).json({ error: 'settings (from the mixer) are required' });
  }
  const ext = format === 'wav' ? 'wav' : 'mp3';

  const start = Number.isFinite(startSeconds) ? Math.max(0, startSeconds) : null;
  const end = Number.isFinite(endSeconds) ? endSeconds : null;
  if (start != null && end != null && end <= start) {
    return res.status(400).json({ error: 'The out point must come after the in point' });
  }

  reapJobs();
  const jobId = `${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  setJob(jobId, { stage: 'running', percent: 0, message: 'Preparing…', userId: req.user.id });

  // Answer immediately; the client follows GET /api/mixdown/:jobId
  res.status(202).json({ jobId });

  runMixdownJob(jobId, { sessionId, settings, ext, start, end, name, userId: req.user.id })
    .catch(err => {
      console.error('[MIXDOWN] Job failed:', err.message);
      setJob(jobId, { stage: 'error', error: err.message || 'Export failed' });
    });
});

async function runMixdownJob(jobId, { sessionId, settings, ext, start, end, name, userId }) {
  let rendered = null;
  try {
    const trackFiles = await getSessionTracks(sessionId);

    if (!isSessionCached(CACHE_DIR, sessionId, trackFiles)) {
      throw new Error('This session is still being prepared. Open it in the mixer first, then export.');
    }

    setJob(jobId, { percent: 0, message: 'Mixing tracks…' });
    rendered = await renderMixdown(CACHE_DIR, sessionId, trackFiles, settings, {
      format: ext, startSeconds: start, endSeconds: end,
      onProgress: (percent) => setJob(jobId, { percent, message: 'Mixing tracks…' })
    });

    const db = getDb();

    // Default name: session's custom name (or its id) plus the range
    const custom = db.prepare('SELECT name FROM session_names WHERE session_id = ?').get(sessionId);
    const label = custom && custom.name ? custom.name : sessionId;
    const rangeSuffix = (start != null || end != null)
      ? ` (${formatRange(start || 0)}–${end != null ? formatRange(end) : 'end'})`
      : '';
    const songName = (typeof name === 'string' && name.trim())
      ? name.trim()
      : `${label} — Mixdown${rangeSuffix}`;

    // Filename must be unique and safe for a B2 key and a URL path
    const safeBase = songName.replace(/[^a-zA-Z0-9._\-()\s]/g, '_').slice(0, 80).trim();
    const filename = `${safeBase} ${Date.now()}.${ext}`;

    setJob(jobId, { percent: 100, message: 'Uploading…' });
    const buffer = fs.readFileSync(rendered.outputPath);
    const contentType = ext === 'wav' ? 'audio/wav' : 'audio/mpeg';
    await uploadFile(`songs/${filename}`, buffer, contentType);

    // Keep a local copy so the first play doesn't round-trip to B2
    try {
      const songsCacheDir = path.resolve(process.env.SONGS_CACHE_DIR || './songs-cache');
      if (!fs.existsSync(songsCacheDir)) fs.mkdirSync(songsCacheDir, { recursive: true });
      fs.copyFileSync(rendered.outputPath, path.join(songsCacheDir, filename));
    } catch (cacheErr) {
      console.warn('[MIXDOWN] Could not write local cache copy:', cacheErr.message);
    }

    const result = db.prepare(
      `INSERT INTO songs (name, filename, duration, added_by, source_session_id, range_start, range_end)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      songName, filename,
      (start != null && end != null) ? Math.round(end - start) : null,
      userId, sessionId, start, end
    );

    const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(result.lastInsertRowid);
    console.log(`[MIXDOWN] ${sessionId}: saved "${songName}" (${rendered.trackCount} tracks)`);
    setJob(jobId, {
      stage: 'done', percent: 100, message: 'Saved to the Playlist',
      song: { ...song, enabled: true, trackCount: rendered.trackCount }
    });
  } finally {
    if (rendered && fs.existsSync(rendered.outputPath)) {
      fs.unlinkSync(rendered.outputPath);
    }
  }
}

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
