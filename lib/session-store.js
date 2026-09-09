// SQLite-backed express-session store, so logins survive server restarts.
// Uses the existing sql.js DbWrapper (http_sessions table, created in db.js).
const session = require('express-session');
const { getDb } = require('./db');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // matches cookie maxAge

// touch() fires on every request; only persist the refreshed expiry when it
// has advanced by at least this much, so routine requests don't write the DB
// (each write saves the whole sql.js file and schedules a B2 upload).
const TOUCH_THRESHOLD_MS = 60 * 60 * 1000;

class SqliteSessionStore extends session.Store {
  _expiryOf(sess) {
    if (sess && sess.cookie && sess.cookie.expires) {
      return new Date(sess.cookie.expires).getTime();
    }
    return Date.now() + DEFAULT_TTL_MS;
  }

  get(sid, cb) {
    try {
      const row = getDb().prepare('SELECT data, expires_at FROM http_sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at < Date.now()) {
        return this.destroy(sid, () => cb(null, null));
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      const db = getDb();
      const data = JSON.stringify(sess);
      const expiresAt = this._expiryOf(sess);
      // local-only: sessions are per-instance, and syncing them would mean a
      // B2 upload on essentially every request
      db.localOnly(() => {
        const existing = db.prepare('SELECT sid FROM http_sessions WHERE sid = ?').get(sid);
        if (existing) {
          db.prepare('UPDATE http_sessions SET data = ?, expires_at = ? WHERE sid = ?').run(data, expiresAt, sid);
        } else {
          db.prepare('INSERT INTO http_sessions (sid, data, expires_at) VALUES (?, ?, ?)').run(sid, data, expiresAt);
        }
      });
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      const db = getDb();
      db.localOnly(() => {
        db.prepare('DELETE FROM http_sessions WHERE sid = ?').run(sid);
      });
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const db = getDb();
      const row = db.prepare('SELECT expires_at FROM http_sessions WHERE sid = ?').get(sid);
      if (row) {
        const newExpiry = this._expiryOf(sess);
        if (newExpiry - row.expires_at > TOUCH_THRESHOLD_MS) {
          db.localOnly(() => {
            db.prepare('UPDATE http_sessions SET expires_at = ? WHERE sid = ?').run(newExpiry, sid);
          });
        }
      }
      if (cb) cb(null);
    } catch (err) {
      if (cb) cb(err);
    }
  }
}

module.exports = { SqliteSessionStore };
