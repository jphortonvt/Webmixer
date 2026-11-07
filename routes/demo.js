// Public demo at /demo: one set of tracks anyone can open without signing in,
// with sample comments the admin writes. Viewers can only read. Nothing in
// the public router changes data, so the demo page has nothing to abuse even
// if someone bypasses its "Demo only" toasts.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { ensureAdmin } = require('../middleware/auth');
const { getDb } = require('../lib/db');
const { getSessionTracks } = require('../lib/sessions');
const { transcodeSession, isSessionCached } = require('../lib/transcode');
const { listKeys, copyFile, deleteFile, getUploadUrl, TRACK_PATTERN } = require('../lib/b2');

// Demo WAVs live under demo/ in B2 and their MP3s under cache/demo/, the same
// layout as a real session. listSessions() only lists YYMMDD_HHMMSS folders,
// so the demo never shows up in the band's picker.
const DEMO_ID = 'demo';
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');
const DEMO_CACHE_DIR = path.join(CACHE_DIR, DEMO_ID);
const FOLDER_PATTERN = /^\d{6}_\d{6}$/;
const ICONS = ['🎸', '🔊', '🎹', '🥁', '🎤', '🎵'];

// What the demo is doing right now, shown on the admin page. In memory only:
// a restart mid-copy loses the status line, not the tracks.
let job = { stage: 'idle', message: '' };
let preparing = null;

// Every visitor would otherwise cost a B2 listing
let tracksCache = null;

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM demo_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  const db = getDb();
  if (db.prepare('SELECT key FROM demo_settings WHERE key = ?').get(key)) {
    db.prepare('UPDATE demo_settings SET value = ? WHERE key = ?').run(value, key);
  } else {
    db.prepare('INSERT INTO demo_settings (key, value) VALUES (?, ?)').run(key, value);
  }
}

async function getDemoTracks() {
  if (tracksCache) return tracksCache;
  try {
    tracksCache = await getSessionTracks(DEMO_ID);
  } catch (err) {
    if (err.message !== 'Session not found') throw err;
    tracksCache = [];
  }
  return tracksCache;
}

// Transcode (or pull already-made MP3s from B2) so the demo plays straight away
function prepare() {
  if (preparing) return preparing;
  preparing = (async () => {
    const tracks = await getDemoTracks();
    if (tracks.length === 0 || isSessionCached(CACHE_DIR, DEMO_ID, tracks)) return;
    job = { stage: 'preparing', message: `Preparing ${tracks.length} tracks…` };
    await transcodeSession(CACHE_DIR, DEMO_ID, tracks);
  })()
    .then(() => {
      if (job.stage === 'preparing') job = { stage: 'ready', message: 'The demo is ready.' };
    })
    .catch(err => {
      console.error('[DEMO] Prepare failed:', err.message);
      job = { stage: 'error', message: `Preparing the demo failed: ${err.message}` };
    })
    .finally(() => { preparing = null; });
  return preparing;
}

// Remove the current demo tracks so a new set can replace them
async function clearTracks() {
  const keys = [...await listKeys(`${DEMO_ID}/`), ...await listKeys(`cache/${DEMO_ID}/`)];
  for (const key of keys) await deleteFile(key);
  fs.rmSync(DEMO_CACHE_DIR, { recursive: true, force: true });
  getDb().prepare('DELETE FROM track_icons WHERE session_id = ?').run(DEMO_ID);
  tracksCache = null;
  // Browsers cache /demo-audio/TRACK01.mp3; a new version busts that
  setSetting('version', String(Date.now()));
}

function busy() {
  return !!preparing || job.stage === 'copying';
}

function threadComments(rows) {
  const byId = {};
  const topLevel = [];
  for (const c of rows) {
    c.replies = [];
    byId[c.id] = c;
  }
  for (const c of rows) {
    if (c.parent_id && byId[c.parent_id]) byId[c.parent_id].replies.push(c);
    else topLevel.push(c);
  }
  return topLevel;
}

// --- Public: read-only ------------------------------------------------------

const publicRouter = express.Router();

// Shaped like /api/sessions so the normal mixer page can show it
publicRouter.get('/sessions', async (req, res) => {
  try {
    const tracks = await getDemoTracks();
    if (tracks.length === 0) return res.json([]);
    res.json([{
      id: DEMO_ID,
      label: getSetting('name') || 'Demo session',
      customName: null,
      trackCount: tracks.length,
      tags: [],
      starred: false,
      archived: false,
    }]);
  } catch (err) {
    console.error('[DEMO] Failed to list the demo:', err);
    res.status(500).json({ error: 'Failed to load the demo' });
  }
});

publicRouter.get('/tracks', async (req, res) => {
  try {
    const tracks = await getDemoTracks();
    if (tracks.length === 0) return res.status(404).json({ error: 'The demo has no tracks yet' });

    if (!isSessionCached(CACHE_DIR, DEMO_ID, tracks)) {
      prepare();
      return res.json({ sessionId: DEMO_ID, preparing: true, trackCount: tracks.length });
    }

    const version = getSetting('version') || '0';
    res.json({
      sessionId: DEMO_ID,
      tracks: tracks.map(track => ({
        name: track.name,
        url: `/demo-audio/${track.name.replace(/\.wav$/i, '.mp3')}?v=${version}`,
        type: track.type,
      })),
    });
  } catch (err) {
    console.error('[DEMO] Failed to load tracks:', err);
    res.status(500).json({ error: 'Failed to load tracks' });
  }
});

publicRouter.get('/comments', (req, res) => {
  const rows = getDb().prepare(`
    SELECT id, parent_id, author_name AS user_name, timestamp_seconds, body, created_at
    FROM demo_comments
    ORDER BY timestamp_seconds ASC, created_at ASC
  `).all();
  res.json(threadComments(rows));
});

publicRouter.get('/icons', (req, res) => {
  const icons = {};
  for (const r of getDb().prepare('SELECT track_name, icon FROM track_icons WHERE session_id = ?').all(DEMO_ID)) {
    icons[r.track_name] = r.icon;
  }
  res.json(icons);
});

// Only the demo's own MP3s are public; real sessions stay behind sign-in
const audio = express.static(DEMO_CACHE_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.mp3')) res.set('Content-Type', 'audio/mpeg');
  }
});

// --- Admin: set the demo up -------------------------------------------------

const adminRouter = express.Router();

adminRouter.get('/', ensureAdmin, async (req, res) => {
  try {
    const tracks = await getDemoTracks();
    const icons = {};
    for (const r of getDb().prepare('SELECT track_name, icon FROM track_icons WHERE session_id = ?').all(DEMO_ID)) {
      icons[r.track_name] = r.icon;
    }
    const comments = getDb().prepare(`
      SELECT id, parent_id, author_name, timestamp_seconds, body
      FROM demo_comments ORDER BY timestamp_seconds ASC, created_at ASC
    `).all();
    res.json({
      name: getSetting('name') || '',
      source: getSetting('source') || '',
      tracks: tracks.map(t => ({ name: t.name, type: t.type, icon: icons[t.name] || null })),
      ready: tracks.length > 0 && isSessionCached(CACHE_DIR, DEMO_ID, tracks),
      busy: busy(),
      job,
      comments,
    });
  } catch (err) {
    console.error('[DEMO] Failed to read the demo:', err);
    res.status(500).json({ error: 'Failed to read the demo' });
  }
});

adminRouter.put('/name', ensureAdmin, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  setSetting('name', name);
  res.json({ name });
});

// Use one of the band's sessions as the demo. Copies run in B2, and the
// session's MP3s come along when they exist, so nothing needs re-encoding.
adminRouter.post('/copy', ensureAdmin, async (req, res) => {
  const sessionId = req.body && req.body.sessionId;
  if (!FOLDER_PATTERN.test(sessionId || '')) return res.status(400).json({ error: 'Pick a session to copy' });
  if (busy()) return res.status(409).json({ error: 'The demo is still being set up. Try again in a minute.' });

  job = { stage: 'copying', message: 'Copying tracks…' };
  res.status(202).json({ job });

  try {
    const wavs = (await listKeys(`${sessionId}/`)).filter(k => TRACK_PATTERN.test(path.basename(k)));
    if (wavs.length === 0) throw new Error('That session has no tracks');
    const mp3s = await listKeys(`cache/${sessionId}/`);

    await clearTracks();
    let done = 0;
    for (const key of [...wavs, ...mp3s]) {
      job.message = `Copying ${++done} of ${wavs.length + mp3s.length}…`;
      await copyFile(key, key.replace(`${sessionId}/`, `${DEMO_ID}/`));
    }

    // Bring the track-type icons along, and the session's name if the demo has none
    const db = getDb();
    for (const r of db.prepare('SELECT track_name, icon FROM track_icons WHERE session_id = ?').all(sessionId)) {
      db.prepare('INSERT INTO track_icons (session_id, track_name, icon) VALUES (?, ?, ?)').run(DEMO_ID, r.track_name, r.icon);
    }
    if (!getSetting('name')) {
      const custom = db.prepare('SELECT name FROM session_names WHERE session_id = ?').get(sessionId);
      if (custom) setSetting('name', custom.name);
    }
    setSetting('source', `Copied from session ${sessionId}`);

    tracksCache = null;
    job = { stage: 'preparing', message: 'Preparing tracks…' };
    prepare();
  } catch (err) {
    console.error('[DEMO] Copy failed:', err);
    job = { stage: 'error', message: `Copying failed: ${err.message}` };
  }
});

// Uploading from disk is three steps from the admin page: clear, upload each
// WAV straight to B2, then prepare.
adminRouter.post('/clear', ensureAdmin, async (req, res) => {
  if (busy()) return res.status(409).json({ error: 'The demo is still being set up. Try again in a minute.' });
  try {
    await clearTracks();
    job = { stage: 'idle', message: '' };
    res.json({ cleared: true });
  } catch (err) {
    console.error('[DEMO] Clear failed:', err);
    res.status(500).json({ error: 'Failed to clear the demo tracks' });
  }
});

adminRouter.post('/upload-url', ensureAdmin, async (req, res) => {
  const filename = req.body && req.body.filename;
  if (!TRACK_PATTERN.test(filename || '')) {
    return res.status(400).json({ error: 'Track files must be named like TRACK01.WAV' });
  }
  try {
    res.json({ url: await getUploadUrl(`${DEMO_ID}/${filename}`, 'audio/wav') });
  } catch (err) {
    console.error('[DEMO] Failed to sign upload:', err.message);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

adminRouter.post('/prepare', ensureAdmin, (req, res) => {
  const count = Number(req.body && req.body.count) || 0;
  setSetting('source', `Uploaded ${count} file${count === 1 ? '' : 's'}`);
  tracksCache = null;
  prepare();
  res.status(202).json({ job });
});

adminRouter.put('/icons', ensureAdmin, (req, res) => {
  const { track_name, icon } = req.body || {};
  if (!track_name || !ICONS.includes(icon)) return res.status(400).json({ error: 'track_name and a known icon are required' });
  const db = getDb();
  db.prepare('DELETE FROM track_icons WHERE session_id = ? AND track_name = ?').run(DEMO_ID, track_name);
  db.prepare('INSERT INTO track_icons (session_id, track_name, icon) VALUES (?, ?, ?)').run(DEMO_ID, track_name, icon);
  res.json({ track_name, icon });
});

adminRouter.post('/comments', ensureAdmin, (req, res) => {
  const { author_name, timestamp_seconds, body, parent_id } = req.body || {};
  const author = typeof author_name === 'string' ? author_name.trim().slice(0, 40) : '';
  const text = typeof body === 'string' ? body.trim().slice(0, 1000) : '';
  const seconds = Number(timestamp_seconds);
  if (!author || !text || !Number.isFinite(seconds) || seconds < 0) {
    return res.status(400).json({ error: 'A name, a time and a comment are required' });
  }

  const db = getDb();
  let parent = null;
  if (parent_id) {
    parent = db.prepare('SELECT id, timestamp_seconds FROM demo_comments WHERE id = ? AND parent_id IS NULL').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'That comment no longer exists' });
  }

  // A reply takes its parent's time, so the admin only types a time once
  const result = db.prepare(`
    INSERT INTO demo_comments (parent_id, author_name, timestamp_seconds, body) VALUES (?, ?, ?, ?)
  `).run(parent ? parent.id : null, author, parent ? parent.timestamp_seconds : seconds, text);
  res.status(201).json({ id: result.lastInsertRowid });
});

adminRouter.delete('/comments/:id', ensureAdmin, (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM demo_comments WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM demo_comments WHERE id = ?').run(id);
  res.json({ deleted: id });
});

module.exports = { publicRouter, adminRouter, audio, prepare, DEMO_ID };
