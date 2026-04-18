require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const passport = require('passport');
const path = require('path');
const fs = require('fs');

const { ready, seedAdmin } = require('./lib/db');
const { configurePassport } = require('./lib/passport');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const commentRoutes = require('./routes/comments');
const mixRoutes = require('./routes/mixes');
const { ensureAuthenticated } = require('./middleware/auth');
const { getSessions, getSessionTracks } = require('./lib/sessions');
const { transcodeSession, isSessionCached } = require('./lib/transcode');
const { configureCors } = require('./lib/b2');

const PORT = process.env.PORT || 3000;
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || './cache');
const DATA_DIR = path.resolve(__dirname, 'data');

// Ensure directories exist
[CACHE_DIR, DATA_DIR].forEach(dir => {
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

  // Serve cached audio files with proper headers
  app.use('/audio', ensureAuthenticated, express.static(CACHE_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.ogg')) {
        res.set('Content-Type', 'audio/ogg');
      }
    }
  }));

  // API routes (auth enforced per route)
  app.use('/api', apiRoutes);
  app.use('/api', commentRoutes);
  app.use('/api', mixRoutes);
  app.use('/api/admin', adminRoutes);

  app.listen(PORT, () => {
    console.log(`[Insert Band Name Here] server running at http://localhost:${PORT}`);

    // Configure B2 CORS for direct browser uploads
    configureCors();

    // Background: pre-transcode all sessions on startup
    precacheAllSessions();
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
