"""Development server for previewing the mixer. Production uses server.js (Node/Express)."""
import http.server
import json
import os
import re
import sqlite3
import subprocess
import socketserver
from urllib.parse import urlparse
from datetime import datetime

PORT = int(os.environ.get('PORT', 3000))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIR = os.path.join(BASE_DIR, 'raw_audio')
CACHE_DIR = os.path.join(BASE_DIR, 'cache')
DATA_DIR = os.path.join(BASE_DIR, 'data')
FOLDER_PATTERN = re.compile(r'^\d{6}_\d{6}$')
TRACK_PATTERN = re.compile(r'^TRACK\d+\.WAV$', re.IGNORECASE)
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', '')

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# --- SQLite setup ---
db_path = os.path.join(DATA_DIR, 'mixer.db')
db = sqlite3.connect(db_path, check_same_thread=False)
db.row_factory = sqlite3.Row
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA foreign_keys=ON')
db.executescript('''
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
''')

# Seed admin
row = db.execute('SELECT id FROM users WHERE email=?', (ADMIN_EMAIL,)).fetchone()
if not row:
    db.execute('INSERT INTO users (email, name, is_admin) VALUES (?, ?, 1)', (ADMIN_EMAIL, 'Admin'))
    db.commit()
    print(f'Admin user seeded: {ADMIN_EMAIL}')
else:
    db.execute('UPDATE users SET is_admin=1 WHERE email=?', (ADMIN_EMAIL,))
    db.commit()

DEV_USER = dict(db.execute('SELECT * FROM users WHERE is_admin=1 LIMIT 1').fetchone())


def parse_folder_date(name):
    yy, mm, dd = name[0:2], name[2:4], name[4:6]
    HH, MM = name[7:9], name[9:11]
    dt = datetime(2000 + int(yy), int(mm), int(dd), int(HH), int(MM))
    return dt.strftime('%b %-d, %Y - %-I:%M %p')


def get_sessions():
    sessions = []
    for entry in sorted(os.listdir(AUDIO_DIR)):
        full = os.path.join(AUDIO_DIR, entry)
        if not os.path.isdir(full) or not FOLDER_PATTERN.match(entry):
            continue
        tracks = [f for f in os.listdir(full) if TRACK_PATTERN.match(f)]
        if not tracks:
            continue
        sessions.append({
            'id': entry,
            'label': parse_folder_date(entry),
            'trackCount': len(tracks)
        })
    return sessions


def has_ffmpeg():
    try:
        subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False

_ffmpeg_available = has_ffmpeg()


def transcode_session(session_id):
    src_dir = os.path.join(AUDIO_DIR, session_id)
    tracks = sorted(f for f in os.listdir(src_dir) if TRACK_PATTERN.match(f))
    result = []

    if _ffmpeg_available:
        dst_dir = os.path.join(CACHE_DIR, session_id)
        os.makedirs(dst_dir, exist_ok=True)
        for t in tracks:
            ogg_name = re.sub(r'\.wav$', '.ogg', t, flags=re.IGNORECASE)
            ogg_path = os.path.join(dst_dir, ogg_name)
            if not os.path.exists(ogg_path):
                wav_path = os.path.join(src_dir, t)
                subprocess.run([
                    'ffmpeg', '-i', wav_path,
                    '-c:a', 'libopus', '-b:a', '128k', '-y', ogg_path
                ], capture_output=True)
            if os.path.exists(ogg_path):
                result.append({'name': t, 'url': f'/audio/{session_id}/{ogg_name}'})
            else:
                result.append({'name': t, 'url': f'/audio/{session_id}/{t}'})
    else:
        for t in tracks:
            result.append({'name': t, 'url': f'/audio/{session_id}/{t}'})

    return result


def get_comments(session_id):
    rows = db.execute('''
        SELECT c.id, c.session_id, c.user_id, c.parent_id, c.timestamp_seconds,
               c.body, c.created_at, c.updated_at,
               u.name AS user_name, u.email AS user_email, u.picture AS user_picture
        FROM comments c JOIN users u ON c.user_id = u.id
        WHERE c.session_id = ?
        ORDER BY c.timestamp_seconds ASC, c.created_at ASC
    ''', (session_id,)).fetchall()

    comments = [dict(r) for r in rows]
    for c in comments:
        c['replies'] = []

    by_id = {c['id']: c for c in comments}
    top_level = []
    for c in comments:
        if c['parent_id'] and c['parent_id'] in by_id:
            by_id[c['parent_id']]['replies'].append(c)
        else:
            top_level.append(c)
    return top_level


class MixerHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(BASE_DIR, 'public'), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/auth/me':
            self.send_json({**DEV_USER, 'devMode': True})
        elif path == '/auth/logout':
            self.send_response(302)
            self.send_header('Location', '/login.html')
            self.end_headers()
        elif path == '/api/sessions':
            self.send_json(get_sessions())
        elif path.startswith('/api/sessions/') and path.endswith('/tracks'):
            session_id = path.split('/')[3]
            if '..' in session_id:
                self.send_error(400)
                return
            try:
                tracks = transcode_session(session_id)
                self.send_json({'sessionId': session_id, 'tracks': tracks})
            except FileNotFoundError:
                self.send_error(404)
            except Exception as e:
                print(f'[ERROR] {e}')
                self.send_json({'error': str(e), 'sessionId': session_id, 'tracks': []})
        elif path.startswith('/api/sessions/') and path.endswith('/mix'):
            session_id = path.split('/')[3]
            if '..' in session_id:
                self.send_error(400)
                return
            row = db.execute(
                'SELECT settings, updated_at, created_at FROM mix_presets WHERE user_id=? AND session_id=?',
                (DEV_USER['id'], session_id)
            ).fetchone()
            if not row:
                self.send_json({'error': 'No saved mix'}, 404)
            else:
                self.send_json({
                    'session_id': session_id,
                    'settings': json.loads(row['settings']),
                    'updated_at': row['updated_at'] or row['created_at']
                })
        elif path.startswith('/api/sessions/') and path.endswith('/comments'):
            session_id = path.split('/')[3]
            self.send_json(get_comments(session_id))
        elif path == '/api/mixes':
            rows = db.execute(
                'SELECT session_id, updated_at, created_at FROM mix_presets WHERE user_id=? ORDER BY COALESCE(updated_at, created_at) DESC',
                (DEV_USER['id'],)
            ).fetchall()
            self.send_json([{
                'session_id': r['session_id'],
                'updated_at': r['updated_at'] or r['created_at']
            } for r in rows])
        elif path == '/api/admin/users':
            rows = db.execute('SELECT id, email, name, picture, is_admin, invited_at, last_login FROM users ORDER BY invited_at DESC').fetchall()
            self.send_json([dict(r) for r in rows])
        elif path.startswith('/audio/'):
            rel = path[len('/audio/'):]
            if '..' in rel:
                self.send_error(400)
                return
            file_path = os.path.join(CACHE_DIR, rel)
            if not os.path.isfile(file_path):
                file_path = os.path.join(AUDIO_DIR, rel)
            if os.path.isfile(file_path):
                content_type = 'audio/ogg' if file_path.endswith('.ogg') else 'audio/wav'
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', os.path.getsize(file_path))
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                with open(file_path, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.send_error(404)
        else:
            super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json_body()

        if path.startswith('/api/sessions/') and path.endswith('/mix'):
            session_id = path.split('/')[3]
            if '..' in session_id:
                self.send_json({'error': 'Invalid session'}, 400)
                return
            copy_from = body.get('copy_from_session')
            if copy_from:
                source = db.execute(
                    'SELECT settings FROM mix_presets WHERE user_id=? AND session_id=?',
                    (DEV_USER['id'], copy_from)
                ).fetchone()
                if not source:
                    self.send_json({'error': 'Source mix not found'}, 404)
                    return
                final_settings = source['settings']
            else:
                settings = body.get('settings')
                if not settings or not isinstance(settings, list):
                    self.send_json({'error': 'settings array required'}, 400)
                    return
                final_settings = json.dumps(settings)
            existing = db.execute(
                'SELECT id FROM mix_presets WHERE user_id=? AND session_id=?',
                (DEV_USER['id'], session_id)
            ).fetchone()
            if existing:
                db.execute(
                    "UPDATE mix_presets SET settings=?, updated_at=datetime('now') WHERE id=?",
                    (final_settings, existing['id'])
                )
            else:
                db.execute(
                    'INSERT INTO mix_presets (user_id, session_id, settings) VALUES (?,?,?)',
                    (DEV_USER['id'], session_id, final_settings)
                )
            db.commit()
            self.send_json({
                'session_id': session_id,
                'settings': json.loads(final_settings),
                'message': 'Mix saved'
            })
        elif path.startswith('/api/sessions/') and path.endswith('/comments'):
            session_id = path.split('/')[3]
            ts = body.get('timestamp_seconds', 0)
            text = (body.get('body') or '').strip()
            parent_id = body.get('parent_id')
            if not text:
                self.send_json({'error': 'body required'}, 400)
                return
            cur = db.execute(
                'INSERT INTO comments (session_id, user_id, parent_id, timestamp_seconds, body) VALUES (?,?,?,?,?)',
                (session_id, DEV_USER['id'], parent_id, ts, text)
            )
            db.commit()
            row = db.execute('''
                SELECT c.*, u.name AS user_name, u.email AS user_email, u.picture AS user_picture
                FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?
            ''', (cur.lastrowid,)).fetchone()
            comment = dict(row)
            comment['replies'] = []
            self.send_json(comment, 201)
        elif path == '/api/admin/invite':
            email = (body.get('email') or '').strip()
            if not email or '@' not in email:
                self.send_json({'error': 'Valid email required'}, 400)
                return
            existing = db.execute('SELECT id FROM users WHERE email=?', (email,)).fetchone()
            if existing:
                self.send_json({'error': 'User already invited'}, 409)
                return
            cur = db.execute('INSERT INTO users (email) VALUES (?)', (email,))
            db.commit()
            self.send_json({'id': cur.lastrowid, 'email': email, 'message': 'User invited'}, 201)
        else:
            self.send_error(404)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path.startswith('/api/comments/'):
            comment_id = int(path.split('/')[-1])
            db.execute('DELETE FROM comments WHERE parent_id=?', (comment_id,))
            db.execute('DELETE FROM comments WHERE id=?', (comment_id,))
            db.commit()
            self.send_json({'message': 'Deleted'})
        elif path.startswith('/api/admin/users/'):
            user_id = int(path.split('/')[-1])
            user = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
            if not user:
                self.send_json({'error': 'Not found'}, 404)
                return
            if user['is_admin']:
                self.send_json({'error': 'Cannot remove admin'}, 400)
                return
            db.execute('DELETE FROM comments WHERE user_id=?', (user_id,))
            db.execute('DELETE FROM users WHERE id=?', (user_id,))
            db.commit()
            self.send_json({'message': 'User removed'})
        else:
            self.send_error(404)

    def _read_json_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f'[{self.log_date_time_string()}] {format % args}')


if __name__ == '__main__':
    with socketserver.TCPServer(('', PORT), MixerHandler) as httpd:
        print(f'Dev server running at http://localhost:{PORT}')
        print(f'Admin: {ADMIN_EMAIL} | ffmpeg: {"yes" if _ffmpeg_available else "no (serving WAV)"}')
        httpd.serve_forever()
