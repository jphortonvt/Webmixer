require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const passport = require('passport');
const path = require('path');
const fs = require('fs');

const { ready, seedAdmin, getDb } = require('./lib/db');
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

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Session (memory store — sessions lost on restart, fine for small app)
  app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
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

async function precacheAllSessions() {
  try {
    console.log('[PRECACHE] Checking all sessions...');
    const sessions = await getSessions();
    let cached = 0;
    let transcoded = 0;

    for (const session of sessions) {
      const trackFiles = await getSessionTracks(session.id);
      if (isSessionCached(CACHE_DIR, session.id, trackFiles)) {
        cached++;
        continue;
      }

      console.log(`[PRECACHE] Transcoding ${session.id} (${trackFiles.length} tracks)...`);
      try {
        await transcodeSession(CACHE_DIR, session.id, trackFiles);
        transcoded++;
        console.log(`[PRECACHE] Done: ${session.id}`);
      } catch (err) {
        console.error(`[PRECACHE] Failed: ${session.id}`, err.message);
      }
    }

    console.log(`[PRECACHE] Complete — ${cached} already cached, ${transcoded} newly transcoded.`);
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
