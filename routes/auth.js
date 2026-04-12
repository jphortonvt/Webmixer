const express = require('express');
const passport = require('passport');
const { isDevMode } = require('../middleware/auth');
const { getDb } = require('../lib/db');

const router = express.Router();

// Initiate Google OAuth
router.get('/google', (req, res, next) => {
  if (isDevMode()) {
    return res.redirect('/');
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// Google OAuth callback
router.get('/google/callback', (req, res, next) => {
  if (isDevMode()) {
    return res.redirect('/');
  }
  passport.authenticate('google', { failureRedirect: '/login.html?error=denied' })(req, res, () => {
    // Passport sets req.user — persist it in session for our middleware
    if (req.user) {
      req.session.user = {
        id: req.user.id,
        email: req.user.email,
        name: req.user.name,
        picture: req.user.picture,
        google_id: req.user.google_id,
        is_admin: req.user.is_admin
      };
    }
    res.redirect('/');
  });
});

// Get current user info
router.get('/me', (req, res) => {
  if (isDevMode() && !req.session.user) {
    const admin = getDb().prepare('SELECT * FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (admin) {
      req.session.user = admin;
    }
  }

  const user = (req.session && req.session.user) || req.user;
  if (user) {
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      is_admin: user.is_admin,
      devMode: isDevMode()
    });
  } else {
    res.status(401).json({ error: 'Not authenticated' });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login.html');
  });
});

module.exports = router;
