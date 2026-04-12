const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { getDb } = require('./db');

function configurePassport() {
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === '') {
    console.log('[AUTH] Dev mode — Google OAuth disabled. All requests auto-authenticate as admin.');
    return;
  }

  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  }, (accessToken, refreshToken, profile, done) => {
    const email = profile.emails && profile.emails[0] && profile.emails[0].value;
    if (!email) {
      return done(null, false, { message: 'No email from Google' });
    }

    const db = getDb();

    // Check if user is invited
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return done(null, false, { message: 'Not invited' });
    }

    // Update user with Google profile info
    db.prepare(`
      UPDATE users SET google_id = ?, name = ?, picture = ?, last_login = datetime('now')
      WHERE email = ?
    `).run(
      profile.id,
      profile.displayName,
      profile.photos && profile.photos[0] && profile.photos[0].value,
      email
    );

    const updatedUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return done(null, updatedUser);
  }));

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser((id, done) => {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user || false);
  });

  console.log('[AUTH] Google OAuth configured.');
}

module.exports = { configurePassport };
