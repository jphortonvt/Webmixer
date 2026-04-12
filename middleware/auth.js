function isDevMode() {
  return !process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === '';
}

function ensureAuthenticated(req, res, next) {
  // Dev mode: auto-authenticate as admin
  if (isDevMode()) {
    if (!req.session.user) {
      const { getDb } = require('../lib/db');
      const db = getDb();
      const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (admin) {
        req.session.user = admin;
      }
    }
    req.user = req.session.user;
    return next();
  }

  if (req.session && req.session.user) {
    req.user = req.session.user;
    return next();
  }
  // Passport's deserializeUser sets req.user on subsequent requests
  if (req.user) {
    req.session.user = {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      google_id: req.user.google_id,
      is_admin: req.user.is_admin
    };
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

function ensureAdmin(req, res, next) {
  if (isDevMode()) {
    if (!req.session.user) {
      const { getDb } = require('../lib/db');
      const db = getDb();
      const admin = db.prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
      if (admin) {
        req.session.user = admin;
      }
    }
    req.user = req.session.user;
    return next();
  }

  if (req.session && req.session.user && req.session.user.is_admin) {
    req.user = req.session.user;
    return next();
  }
  if (req.user && req.user.is_admin) {
    req.session.user = {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      google_id: req.user.google_id,
      is_admin: req.user.is_admin
    };
    return next();
  }
  res.status(403).json({ error: 'Admin access required' });
}

module.exports = { ensureAuthenticated, ensureAdmin, isDevMode };
