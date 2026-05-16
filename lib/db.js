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
    console.log('[DB] Database restored from B2');
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('[DB] No existing database on B2, starting fresh');
    } else {
      console.warn('[DB] Failed to download database from B2:', err.message);
    }
    return false;
  }
}

async function uploadDbToB2() {
  const b2 = getB2();
  if (!b2) return;

  try {
    const fileStream = fs.createReadStream(DB_PATH);
    await b2.s3.send(new b2.PutObjectCommand({
      Bucket: b2.bucket,
      Key: B2_DB_KEY,
      Body: fileStream,
      ContentType: 'application/octet-stream',
    }));
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

  _save() {
    const data = this._db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));

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
  // Try to restore database from B2 first
  if (!fs.existsSync(DB_PATH)) {
    await downloadDbFromB2();
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

  db.exec(`
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
  `);

  return db;
})();

function seedAdmin(adminEmail) {
  if (!adminEmail || !db) return;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, is_admin) VALUES (?, ?, 1)').run(adminEmail, 'Admin');
    console.log(`Admin user seeded: ${adminEmail}`);
  } else {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(adminEmail);
  }
}

function getDb() {
  return db;
}

module.exports = { getDb, seedAdmin, ready };
