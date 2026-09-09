const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'mixer.db');
const B2_DB_KEY = 'data/mixer.db';

// B2 persistence helpers (lazy-loaded to avoid circular deps)
let b2Client = null;
function getB2() {
  if (!b2Client) {
    try {
      const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
      const endpoint = process.env.B2_ENDPOINT;
      const keyId = process.env.B2_KEY_ID;
      const appKey = process.env.B2_APP_KEY;
      const bucket = process.env.B2_BUCKET_NAME;

      if (!endpoint || !keyId || !appKey || !bucket) return null;

      const s3 = new S3Client({
        endpoint,
        region: 'auto',
        credentials: { accessKeyId: keyId, secretAccessKey: appKey },
        forcePathStyle: true,
      });

      b2Client = { s3, bucket, GetObjectCommand, PutObjectCommand, HeadObjectCommand };
    } catch (err) {
      console.warn('[DB] B2 not available for database persistence:', err.message);
      return null;
    }
  }
  return b2Client;
}

// B2 holds the authoritative database; the local file is only a working copy.
// Uploading is whole-file, so two servers running at once will happily
// overwrite each other — the guard below stops a server writing over a copy
// it never read. Set DB_B2_SYNC=false to work fully offline.
const B2_SYNC_ENABLED = process.env.DB_B2_SYNC !== 'false';

// LastModified of the B2 copy this process is in sync with. Null means we
// have never reconciled with the remote, so we must not overwrite it.
let syncedRemoteMtime = null;

async function getRemoteMtime() {
  const b2 = getB2();
  if (!b2) return null;
  try {
    const head = await b2.s3.send(new b2.HeadObjectCommand({
      Bucket: b2.bucket,
      Key: B2_DB_KEY,
    }));
    return head.LastModified ? head.LastModified.getTime() : null;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function downloadDbFromB2() {
  const b2 = getB2();
  if (!b2) return false;

  try {
    const { pipeline } = require('stream/promises');
    const response = await b2.s3.send(new b2.GetObjectCommand({
      Bucket: b2.bucket,
      Key: B2_DB_KEY,
    }));
    const writeStream = fs.createWriteStream(DB_PATH);
    await pipeline(response.Body, writeStream);
    syncedRemoteMtime = response.LastModified ? response.LastModified.getTime() : null;
    console.log('[DB] Database restored from B2');
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('[DB] No existing database on B2, starting fresh');
      syncedRemoteMtime = null;
    } else {
      console.warn('[DB] Failed to download database from B2:', err.message);
    }
    return false;
  }
}

async function uploadDbToB2() {
  const b2 = getB2();
  if (!b2 || !B2_SYNC_ENABLED) return;

  try {
    const remoteMtime = await getRemoteMtime();

    // Someone else has written since we last read: our copy is stale and
    // uploading it would discard their data.
    if (remoteMtime !== null && syncedRemoteMtime === null) {
      console.warn('[DB] Skipping backup: a database exists on B2 that this server never loaded. Restart to pick it up.');
      return;
    }
    if (remoteMtime !== null && remoteMtime > syncedRemoteMtime) {
      console.warn('[DB] Skipping backup: the copy on B2 is newer than the one this server loaded (another instance is writing). Restart to pick it up.');
      return;
    }

    await b2.s3.send(new b2.PutObjectCommand({
      Bucket: b2.bucket,
      Key: B2_DB_KEY,
      Body: fs.readFileSync(DB_PATH),
      ContentType: 'application/octet-stream',
    }));
    syncedRemoteMtime = await getRemoteMtime();
    console.log('[DB] Database backed up to B2');
  } catch (err) {
    console.warn('[DB] Failed to upload database to B2:', err.message);
  }
}

// Wrapper providing better-sqlite3-compatible API over sql.js
class DbWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._dirty = false;
    this._uploadTimer = null;
    this._localOnlyDepth = 0;
  }

  prepare(sql) {
    const self = this;
    return {
      get(...params) {
        const stmt = self._db.prepare(sql);
        if (params.length) stmt.bind(params);
        let result;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.free();
        return result || undefined;
      },
      all(...params) {
        const stmt = self._db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },
      run(...params) {
        self._db.run(sql, params);
        const rowid = self._db.exec("SELECT last_insert_rowid()")[0]?.values[0][0];
        self._save();
        return { lastInsertRowid: rowid };
      }
    };
  }

  exec(sql) {
    this._db.exec(sql);
    this._save();
  }

  pragma(str) {
    this._db.run(`PRAGMA ${str}`);
  }

  // Run writes that should stay on this machine — login sessions, which are
  // per-instance and would otherwise trigger a B2 upload on every request.
  // sql.js is synchronous, so the depth counter is safe here.
  localOnly(fn) {
    this._localOnlyDepth++;
    try {
      return fn();
    } finally {
      this._localOnlyDepth--;
    }
  }

  _save() {
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));

    if (this._localOnlyDepth > 0) return; // don't sync session churn to B2

    // Debounced upload to B2 — wait 5 seconds after last write
    this._dirty = true;
    if (this._uploadTimer) clearTimeout(this._uploadTimer);
    this._uploadTimer = setTimeout(() => {
      if (this._dirty) {
        this._dirty = false;
        uploadDbToB2().catch(() => {});
      }
    }, 5000);
  }
}

let db;

// Initialize is async (sql.js loads WASM + B2 restore), but we export a promise
const ready = (async () => {
  // Always reconcile with B2 when it has a copy — it is the authoritative
  // one. Previously a stale local file was kept and then uploaded over the
  // good remote copy, which silently destroyed data.
  if (B2_SYNC_ENABLED) {
    const remoteMtime = await getRemoteMtime().catch(() => null);
    if (remoteMtime !== null) {
      await downloadDbFromB2();
    }
  } else if (fs.existsSync(DB_PATH)) {
    console.log('[DB] B2 sync disabled (DB_B2_SYNC=false) — using local database only');
  }

  const SQL = await initSqlJs();
  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  db = new DbWrapper(sqlDb);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // local-only: schema creation is idempotent and runs on every boot; letting
  // it trigger a B2 upload means every server start rewrites the remote copy
  db.localOnly(() => db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      picture TEXT,
      google_id TEXT UNIQUE,
      is_admin INTEGER NOT NULL DEFAULT 0,
      invited_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      parent_id INTEGER REFERENCES comments(id),
      timestamp_seconds REAL NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id);
    CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

    CREATE TABLE IF NOT EXISTS mix_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      session_id TEXT NOT NULL,
      settings TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      UNIQUE(user_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_mix_presets_user_session ON mix_presets(user_id, session_id);

    CREATE TABLE IF NOT EXISTS session_names (
      session_id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS songs (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      duration INTEGER,
      added_by INTEGER REFERENCES users(id),
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS playlist_items (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id  INTEGER NOT NULL REFERENCES users(id),
      song_id  INTEGER NOT NULL REFERENCES songs(id),
      position INTEGER NOT NULL,
      UNIQUE(user_id, song_id)
    );

    CREATE INDEX IF NOT EXISTS idx_playlist_user ON playlist_items(user_id, position);

    CREATE TABLE IF NOT EXISTS track_icons (
      session_id TEXT NOT NULL,
      track_name TEXT NOT NULL,
      icon TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, track_name)
    );

    CREATE TABLE IF NOT EXISTS http_sessions (
      sid TEXT PRIMARY KEY NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `));

  // Purge expired login sessions. Kept local-only: this runs on every boot and
  // must not trigger a B2 upload, or a dev server would overwrite the remote
  // copy just by starting up.
  db.localOnly(() => {
    db.prepare('DELETE FROM http_sessions WHERE expires_at < ?').run(Date.now());
  });

  return db;
})();

function seedAdmin(adminEmail) {
  if (!adminEmail || !db) return;
  const existing = db.prepare('SELECT id, is_admin FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, is_admin) VALUES (?, ?, 1)').run(adminEmail, 'Admin');
    console.log(`Admin user seeded: ${adminEmail}`);
  } else if (!existing.is_admin) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(adminEmail);
    console.log(`Admin flag restored for ${adminEmail}`);
  }
  // Already an admin — no write, so booting the server does not rewrite the
  // database (and therefore does not push a new copy to B2) for no reason.
}

function getDb() {
  return db;
}

module.exports = { getDb, seedAdmin, ready };
