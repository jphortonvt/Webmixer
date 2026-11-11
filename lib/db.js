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
// Uploading is whole-file, so two servers running at once would overwrite each
// other — the guard in uploadDbToB2 stops a server writing over a copy it never
// read, and puts this instance into read-only mode when it trips.
// Set DB_B2_SYNC=false to work fully offline.
const B2_SYNC_ENABLED = process.env.DB_B2_SYNC !== 'false';

const UPLOAD_DEBOUNCE_MS = 5000;        // wait this long after the last write…
const UPLOAD_MAX_WAIT_MS = 30000;       // …but never hold a write back longer than this
const UPLOAD_RETRY_BASE_MS = 5000;      // failed upload: 5s, 10s, 20s… between retries
const UPLOAD_RETRY_MAX_MS = 5 * 60 * 1000;

// LastModified of the B2 copy this process is in sync with. Null means we
// have never reconciled with the remote, so we must not overwrite it.
let syncedRemoteMtime = null;

class RemoteNewerError extends Error {}

// Thrown by every synced write once the instance has gone read-only. The
// status makes Express answer 503 rather than a generic 500.
class DbReadOnlyError extends Error {
  constructor(reason) {
    super(`Database is read-only: ${reason}`);
    this.name = 'DbReadOnlyError';
    this.code = 'DB_READ_ONLY';
    this.status = 503;
  }
}

// Write-then-rename, so a crash mid-write leaves the previous file intact
// instead of a truncated database.
function writeFileAtomic(target, data) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

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

// Returns true when a copy was downloaded, false when B2 has none. Any other
// failure throws: starting on a stale or empty local copy while a real
// database sits on B2 is how data gets lost.
async function downloadDbFromB2() {
  const b2 = getB2();
  if (!b2) return false;

  try {
    const { pipeline } = require('stream/promises');
    const response = await b2.s3.send(new b2.GetObjectCommand({
      Bucket: b2.bucket,
      Key: B2_DB_KEY,
    }));
    const tmp = DB_PATH + '.download';
    await pipeline(response.Body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, DB_PATH);
    syncedRemoteMtime = response.LastModified ? response.LastModified.getTime() : null;
    console.log('[DB] Database restored from B2');
    return true;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      console.log('[DB] No existing database on B2, starting fresh');
      syncedRemoteMtime = null;
      return false;
    }
    throw err;
  }
}

// Uploads one snapshot. Throws on any failure; throws RemoteNewerError when
// the copy on B2 is not the one this server last read or wrote.
async function uploadDbToB2(body) {
  const b2 = getB2();
  const remoteMtime = await getRemoteMtime();

  // Someone else has written since we last read: our copy is stale and
  // uploading it would discard their data.
  if (remoteMtime !== null && syncedRemoteMtime === null) {
    throw new RemoteNewerError('a database exists on B2 that this server never loaded');
  }
  if (remoteMtime !== null && remoteMtime > syncedRemoteMtime) {
    throw new RemoteNewerError('the copy on B2 is newer than the one this server loaded (another instance is writing)');
  }

  await b2.s3.send(new b2.PutObjectCommand({
    Bucket: b2.bucket,
    Key: B2_DB_KEY,
    Body: body,
    ContentType: 'application/octet-stream',
  }));
  try {
    syncedRemoteMtime = await getRemoteMtime();
  } catch (err) {
    // The upload itself landed; we just could not read back its timestamp.
    // Treat whatever is there at the next upload as ours rather than tripping
    // the guard on our own write.
    syncedRemoteMtime = Infinity;
  }
  console.log('[DB] Database backed up to B2');
}

// --- Upload scheduling ------------------------------------------------------
// One upload at a time, chained on a single promise. A write marks the
// database dirty; the flag is only cleared by an upload that started after it.

let dirty = false;
let dirtySince = null;       // when the oldest un-uploaded write happened
let uploadTimer = null;
let uploadFailures = 0;
let uploadChain = Promise.resolve();
let readOnlyReason = null;

function syncActive() {
  return B2_SYNC_ENABLED && !!getB2();
}

function scheduleUpload(ms) {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = null;
    flushToB2().catch(() => {}); // already logged, and a retry is scheduled
  }, ms);
}

function markDirty() {
  if (!syncActive() || readOnlyReason) return;
  dirty = true;
  if (dirtySince === null) dirtySince = Date.now();
  // Backing off after a failure: leave the retry timer alone, so a burst of
  // writes neither hammers B2 nor pushes the retry further away.
  if (uploadFailures > 0 && uploadTimer) return;
  // Debounce, capped so steady activity cannot starve the upload
  const untilCap = dirtySince + UPLOAD_MAX_WAIT_MS - Date.now();
  scheduleUpload(Math.max(0, Math.min(UPLOAD_DEBOUNCE_MS, untilCap)));
}

function enterReadOnly(reason) {
  readOnlyReason = reason;
  dirty = false;
  dirtySince = null;
  if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }

  // Whatever was written since the last good upload cannot go to B2 and will
  // be replaced by the remote copy on restart. Keep it somewhere recoverable.
  let kept = '';
  try {
    const conflictPath = `${DB_PATH}.conflict-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(DB_PATH, conflictPath);
    kept = ` This server's unsaved changes were kept in ${conflictPath}.`;
  } catch (err) {
    kept = ` (Could not keep a copy of this server's database: ${err.message})`;
  }
  console.error(`[DB] READ-ONLY: ${reason}. Refusing all further writes so nothing else is silently lost.${kept} Restart to load the copy on B2.`);
}

// Upload now if there is anything to upload. Resolves once B2 has it (or
// there was nothing to do); rejects if the upload failed.
function flushToB2() {
  const attempt = uploadChain.then(async () => {
    if (!dirty || readOnlyReason || !syncActive()) return;
    if (uploadTimer) { clearTimeout(uploadTimer); uploadTimer = null; }

    const since = dirtySince;
    dirty = false;
    dirtySince = null;
    try {
      await uploadDbToB2(fs.readFileSync(DB_PATH));
      uploadFailures = 0;
      // Written to while the upload was in flight with no timer pending
      if (dirty && !uploadTimer) scheduleUpload(UPLOAD_DEBOUNCE_MS);
    } catch (err) {
      if (err instanceof RemoteNewerError) {
        enterReadOnly(err.message);
        throw new DbReadOnlyError(err.message);
      }
      dirty = true;
      dirtySince = since;
      uploadFailures++;
      const delay = Math.min(UPLOAD_RETRY_BASE_MS * 2 ** (uploadFailures - 1), UPLOAD_RETRY_MAX_MS);
      console.error(`[DB] Upload to B2 failed (attempt ${uploadFailures}): ${err.message}. Retrying in ${Math.round(delay / 1000)}s.`);
      scheduleUpload(delay);
      throw err;
    }
  });
  uploadChain = attempt.catch(() => {});
  return attempt;
}

// A statement that can only change rows; when one of these changes none, there
// is nothing to save. (sqlite3_changes is only meaningful for these.)
const ROW_WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

// Wrapper providing better-sqlite3-compatible API over sql.js
class DbWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._localOnlyDepth = 0;
    this._inTransaction = false;
    this._txWrote = false;   // something in the open transaction needs saving
    this._txSync = false;    // …and at least one of those writes should reach B2
  }

  prepare(sql) {
    const self = this;
    return {
      get(...params) {
        const stmt = self._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          return stmt.step() ? stmt.getAsObject() : undefined;
        } finally {
          stmt.free();
        }
      },
      all(...params) {
        const stmt = self._db.prepare(sql);
        try {
          if (params.length) stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          return results;
        } finally {
          stmt.free();
        }
      },
      run(...params) {
        self._assertWritable();
        self._db.run(sql, params);
        const changes = self._db.getRowsModified();
        const rowid = self._db.exec("SELECT last_insert_rowid()")[0]?.values[0][0];
        if (changes > 0 || !ROW_WRITE.test(sql)) self._wrote();
        return { lastInsertRowid: rowid, changes };
      }
    };
  }

  exec(sql) {
    this._assertWritable();
    this._db.exec(sql);
    this._wrote();
  }

  pragma(str) {
    this._db.run(`PRAGMA ${str}`);
  }

  // Run several statements as one unit: all of them land, or none do.
  // fn must be synchronous — sql.js has a single connection, so a transaction
  // left open across an await would swallow other requests' writes.
  // The file save (and B2 upload) happens once, after COMMIT. Nested calls
  // join the outer transaction.
  transaction(fn) {
    if (this._inTransaction) return fn();

    this._db.run('BEGIN');
    this._inTransaction = true;
    this._txWrote = false;
    this._txSync = false;
    let result;
    try {
      result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('db.transaction() callback must be synchronous');
      }
      this._db.run('COMMIT');
    } catch (err) {
      try { this._db.run('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    } finally {
      this._inTransaction = false;
    }
    if (this._txWrote) this._save(this._txSync);
    return result;
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

  // Once read-only, a synced write would be accepted here and then dropped —
  // refuse it instead. Local-only writes (login sessions) still work, so
  // people can keep reading.
  _assertWritable() {
    if (readOnlyReason && this._localOnlyDepth === 0) {
      throw new DbReadOnlyError(readOnlyReason);
    }
  }

  _wrote() {
    const sync = this._localOnlyDepth === 0;
    if (this._inTransaction) {
      // export() closes the connection, which would roll the transaction
      // back — so the save waits for COMMIT
      this._txWrote = true;
      if (sync) this._txSync = true;
      return;
    }
    this._save(sync);
  }

  _save(sync) {
    const data = this._db.export();
    // export() closes and reopens the connection, and foreign key enforcement
    // is per-connection and off by default — turn it back on every time
    this._db.run('PRAGMA foreign_keys = ON');
    writeFileAtomic(DB_PATH, Buffer.from(data));

    if (sync) markDirty(); // local-only writes don't go to B2
  }
}

let db;

// Initialize is async (sql.js loads WASM + B2 restore), but we export a promise
const ready = (async () => {
  // Always reconcile with B2 when it has a copy — it is the authoritative
  // one. Previously a stale local file was kept and then uploaded over the
  // good remote copy, which silently destroyed data.
  if (!B2_SYNC_ENABLED) {
    if (fs.existsSync(DB_PATH)) {
      console.log('[DB] B2 sync disabled (DB_B2_SYNC=false) — using local database only');
    }
  } else if (getB2()) {
    // Refuse to start rather than run on a stale or empty local copy: every
    // write made in that state would be thrown away.
    try {
      const remoteMtime = await getRemoteMtime();
      if (remoteMtime !== null) {
        await downloadDbFromB2();
      }
    } catch (err) {
      throw new Error(`Could not load the database from B2 (${err.message}). Set DB_B2_SYNC=false to run on the local copy only.`);
    }
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

  // sql.js only ever reads and writes the single database file. Older copies
  // were flagged as WAL in their header, which makes other SQLite tools look
  // for a -wal file beside it; this clears the flag on the next save.
  db.pragma('journal_mode = DELETE');
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

    CREATE TABLE IF NOT EXISTS session_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, tag)
    );

    CREATE INDEX IF NOT EXISTS idx_session_tags_session ON session_tags(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

    -- Starring is shared, not per-user: one star per session, a "keeper" flag
    -- on the take rather than a personal favourite.
    CREATE TABLE IF NOT EXISTS session_starred (
      session_id TEXT PRIMARY KEY NOT NULL,
      starred_by INTEGER REFERENCES users(id),
      starred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Archiving hides a session from the picker for everyone. Any member can
    -- archive clutter; only an admin can bring one back (see routes/admin.js).
    CREATE TABLE IF NOT EXISTS session_archived (
      session_id TEXT PRIMARY KEY NOT NULL,
      archived_by INTEGER REFERENCES users(id),
      archived_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Public demo (/demo): its name and where its tracks came from
    CREATE TABLE IF NOT EXISTS demo_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );

    -- Sample comments the admin writes for the demo. Separate from comments
    -- because the authors are made-up names, not band members.
    CREATE TABLE IF NOT EXISTS demo_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES demo_comments(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      timestamp_seconds REAL NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `));

  // SQLite has no ADD COLUMN IF NOT EXISTS — it errors when the column is
  // already there — so check first to stay idempotent across restarts.
  db.localOnly(() => {
    const addColumn = (table, column, definition) => {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (cols.some(c => c.name === column)) return;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`[DB] Added ${table}.${column}`);
    };
    // Where a song came from, when it was rendered out of a session mixdown
    addColumn('songs', 'source_session_id', 'TEXT');
    addColumn('songs', 'range_start', 'REAL');
    addColumn('songs', 'range_end', 'REAL');
    // Per-user rotation toggle — what one member wants in rotation need not
    // match anyone else's view
    addColumn('playlist_items', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
  });

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
  // One statement: create the admin, or restore the flag if it was lost.
  // When they are already an admin nothing changes, so nothing is saved and
  // booting the server does not push a new copy to B2 for no reason.
  const { changes } = db.prepare(`
    INSERT INTO users (email, name, is_admin) VALUES (?, 'Admin', 1)
    ON CONFLICT(email) DO UPDATE SET is_admin = 1 WHERE is_admin = 0
  `).run(adminEmail);
  if (changes > 0) console.log(`Admin user ensured: ${adminEmail}`);
}

function getDb() {
  return db;
}

// Null while writable; otherwise why this instance stopped accepting writes
function getReadOnlyReason() {
  return readOnlyReason;
}

module.exports = { getDb, seedAdmin, ready, flushToB2, getReadOnlyReason, DbReadOnlyError };
