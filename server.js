require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const passport = require('passport');
const path = require('path');
const fs = require('fs');

const { ready, seedAdmin, getDb } = require('./lib/db');
const { SqliteSessionStore } = require('./lib/session-store');
const { configurePassport } = require('./lib/passport');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const commentRoutes = require('./routes/comments');
const mixRoutes = require('./routes/mixes');
const playlistRoutes = require('./routes/playlist');
const { ensureAuthenticated } = require('./middleware/auth');
const { getSessions, getSessionTracks } = require('./lib/sessions');
const { transcodeSession, isSessionCached } = require('./lib/transcode');
const { configureCors, downloadFile } = require('./lib/b2');

const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');
const DATA_DIR = path.resolve(__dirname, 'data');
const SONGS_CACHE_DIR = path.resolve(process.env.SONGS_CACHE_DIR || './songs-cache');

// Ensure directories exist
[CACHE_DIR, DATA_DIR, SONGS_CACHE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Wait for database to initialize, then start server
ready.then(() => {
  // Seed admin user
  seedAdmin(process.env.ADMIN_EMAIL);

  const app = express();

  // Middleware — CORS only when explicitly configured; the app is served
  // same-origin so cross-origin API access is opt-in
  if (process.env.ALLOWED_ORIGINS) {
    app.use(cors({ origin: process.env.ALLOWED_ORIGINS.split(','), credentials: true }));
  }
  app.use(express.json());

  // Sessions persist in SQLite so logins survive restarts/deploys
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET must be set in production. Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
  // Behind a reverse proxy (Render/Fly/nginx) Express needs to trust
  // X-Forwarded-Proto, or it sees plain HTTP and refuses to set a secure cookie
  if (isProduction) {
    app.set('trust proxy', 1);
  }

  app.use(session({
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax',
      // HTTPS-only in production; left off locally so plain-HTTP dev still works
      secure: isProduction
    }
  }));

  // Passport
  configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  // Public pages (no auth required)
  app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // Auth routes (no auth required)
  app.use('/auth', authRoutes);

  // Static assets (CSS, JS) — no auth required since API is protected
  app.use(express.static(path.join(__dirname, 'public')));

  // Serve cached mixer audio files
  app.use('/audio', ensureAuthenticated, express.static(CACHE_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.mp3')) {
        res.set('Content-Type', 'audio/mpeg');
      }
    }
  }));

  // Serve songs — check local cache first; fall back to downloading from B2
  app.use('/songs', ensureAuthenticated, express.static(SONGS_CACHE_DIR, {
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.mp3') res.set('Content-Type', 'audio/mpeg');
      if (ext === '.m4a') res.set('Content-Type', 'audio/mp4');
      if (ext === '.wav') res.set('Content-Type', 'audio/wav');
    }
  }));

  // Fallback: song not in local cache — download from B2 on demand
  app.get('/songs/:filename', ensureAuthenticated, async (req, res) => {
    const filename = path.basename(req.params.filename);
    if (!filename || filename.startsWith('.')) return res.status(400).end();

    const localPath = path.join(SONGS_CACHE_DIR, filename);

    try {
      await downloadFile(`songs/${filename}`, localPath);
    } catch (err) {
      console.error(`[SONGS] Failed to fetch ${filename} from B2:`, err.message);
      return res.status(404).send('Song not found');
    }

    const ext = path.extname(filename).toLowerCase();
    const ct = ext === '.m4a' ? 'audio/mp4' : ext === '.wav' ? 'audio/wav' : 'audio/mpeg';
    res.setHeader('Content-Type', ct);
    res.sendFile(localPath);
  });

  // API routes
  app.use('/api', apiRoutes);
  app.use('/api', commentRoutes);
  app.use('/api', mixRoutes);
  app.use('/api', playlistRoutes);
  app.use('/api/admin', adminRoutes);

  app.listen(PORT, () => {
    console.log(`[Insert Band Name Here] server running at http://localhost:${PORT}`);

    // Configure B2 CORS for direct browser uploads
    configureCors();

    // Background: pre-transcode all mixer sessions on startup
    precacheAllSessions();

    // Background: pre-download all songs to local cache
    precacheSongs();
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});

// Only the newest sessions are warmed at boot. Older ones transcode on first
// open — the UI already handles the "preparing" state — so startup cost stays
// constant as the session archive grows.
const PRECACHE_RECENT_COUNT = parseInt(process.env.PRECACHE_RECENT_COUNT || '5', 10);
const PRECACHE_CONCURRENCY = parseInt(process.env.PRECACHE_CONCURRENCY || '2', 10);

// Run tasks with a bounded number in flight. Unlimited concurrency here
// overwhelms ffmpeg and B2; serial is needlessly slow.
async function runPool(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function precacheAllSessions() {
  try {
    if (PRECACHE_RECENT_COUNT === 0) {
      console.log('[PRECACHE] Disabled (PRECACHE_RECENT_COUNT=0)');
      return;
    }

    const all = await getSessions();
    // getSessions() sorts ascending by id (which is a timestamp), so the
    // newest sessions are at the end
    const recent = all.slice(-PRECACHE_RECENT_COUNT);
    console.log(`[PRECACHE] Warming ${recent.length} most recent of ${all.length} sessions (concurrency ${PRECACHE_CONCURRENCY})...`);

    let cached = 0;
    let transcoded = 0;
    let failed = 0;

    await runPool(recent, PRECACHE_CONCURRENCY, async (session) => {
      try {
        const trackFiles = await getSessionTracks(session.id);
        if (isSessionCached(CACHE_DIR, session.id, trackFiles)) {
          cached++;
          return;
        }
        console.log(`[PRECACHE] Transcoding ${session.id} (${trackFiles.length} tracks)...`);
        await transcodeSession(CACHE_DIR, session.id, trackFiles);
        transcoded++;
        console.log(`[PRECACHE] Done: ${session.id}`);
      } catch (err) {
        failed++;
        console.error(`[PRECACHE] Failed: ${session.id}`, err.message);
      }
    });

    const lazy = all.length - recent.length;
    console.log(`[PRECACHE] Complete — ${cached} already cached, ${transcoded} transcoded, ${failed} failed, ${lazy} deferred to first open.`);
  } catch (err) {
    console.error('[PRECACHE] Error:', err.message);
  }
}

async function precacheSongs() {
  try {
    const db = getDb();
    const songs = db.prepare('SELECT filename FROM songs').all();
    if (songs.length === 0) return;

    console.log(`[SONGS] Pre-caching ${songs.length} song(s)...`);
    for (const song of songs) {
      const localPath = path.join(SONGS_CACHE_DIR, song.filename);
      if (fs.existsSync(localPath)) continue;
      try {
        await downloadFile(`songs/${song.filename}`, localPath);
        console.log(`[SONGS] Cached: ${song.filename}`);
      } catch (err) {
        console.warn(`[SONGS] Could not cache ${song.filename}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[SONGS] Precache error:', err.message);
  }
}
