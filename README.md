# [Insert Band Name Here]

A web-based multitrack audio mixer for band collaboration. Load recordings from a Zoom L-8 (or similar multitrack recorder), mix them in the browser, and leave time-stamped comments for your bandmates.

![Dark themed mixer interface](https://img.shields.io/badge/theme-dark-121218)

## Features

- **Multitrack Playback** — Up to 8 synchronized tracks using the Web Audio API
- **Per-Track Controls** — Volume (0–150%), pan (L/C/R), mute, and solo per channel
- **Session Browser** — Dropdown populated from recording folders, displayed as readable dates
- **Server-Side Transcoding** — WAV files are automatically transcoded to OGG (Opus) via ffmpeg for fast streaming
- **Save & Restore Mixes** — Save your volume/pan/mute/solo settings per session, per user. Copy settings between sessions
- **Time-Stamped Comments** — Click the timeline to leave a comment at a specific point in the song. Threaded replies for discussion
- **Comment Markers** — Visual dots on the seek bar showing where comments exist
- **Google OAuth** — Sign in with Google. Admin invites users by email — no account management needed
- **Invite-Only Access** — Only invited users can access the app
- **Admin Panel** — Invite/remove users, see who's active

## Prerequisites

- **Node.js** v18+ (tested on v25.x)
- **ffmpeg** with Opus support (`brew install ffmpeg` on macOS)
- **Google OAuth credentials** (for production auth — optional for local dev)

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/jphortonvt/Webmixer.git
cd Webmixer
npm install
```

### 2. Add your audio files

Place your multitrack recordings in `raw_audio/` with one subfolder per session. Folder names should follow the Zoom L-8 naming convention (`YYMMDD_HHMMSS`):

```
raw_audio/
├── 240115_193000/
│   ├── TRACK01.WAV
│   ├── TRACK02.WAV
│   ├── ...
│   └── TRACK08.WAV
└── 240122_200000/
    ├── TRACK01.WAV
    └── ...
```

### 3. Configure environment

Copy the example below into a `.env` file in the project root:

```env
PORT=3000
AUDIO_DIR=./raw_audio
CACHE_DIR=./cache
ADMIN_EMAIL=you@gmail.com
SESSION_SECRET=generate-a-random-string-here

# Google OAuth (leave empty for dev mode)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=http://localhost:3000/auth/google/callback
```

> **Dev mode:** When `GOOGLE_CLIENT_ID` is empty, the app skips OAuth and auto-authenticates as the admin user. Great for local testing.

### 4. Start the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Google OAuth Setup (Production)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Navigate to **APIs & Services → Credentials**
4. Create an **OAuth 2.0 Client ID** (Web application)
5. Add your callback URL as an authorized redirect URI:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://yourdomain.com/auth/google/callback`
6. Copy the Client ID and Client Secret into your `.env` file
7. Set `ADMIN_EMAIL` to your Google email — you'll be the first admin

## Hosting on a Public Server

### Using a VPS (e.g., DigitalOcean, Linode, AWS EC2)

1. SSH into your server and clone the repo
2. Install Node.js and ffmpeg
3. Set up your `.env` with production values (update `GOOGLE_CALLBACK_URL` to your domain)
4. Use a process manager to keep it running:

```bash
npm install -g pm2
pm2 start server.js --name web-mixer
pm2 save
pm2 startup
```

5. Set up a reverse proxy with Nginx:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

6. Add HTTPS with Let's Encrypt: `sudo certbot --nginx -d yourdomain.com`

## Project Structure

```
├── server.js              # Express app entry point
├── lib/
│   ├── db.js              # SQLite database (users, comments, mixes)
│   ├── passport.js        # Google OAuth strategy
│   ├── sessions.js        # Audio session discovery
│   └── transcode.js       # WAV → OGG transcoding via ffmpeg
├── middleware/
│   └── auth.js            # Authentication & admin middleware
├── routes/
│   ├── api.js             # Session & track listing
│   ├── auth.js            # OAuth login/logout
│   ├── admin.js           # User management
│   ├── comments.js        # Time-stamped comments
│   └── mixes.js           # Save/load mix settings
├── public/
│   ├── index.html         # Main mixer page
│   ├── login.html         # Sign-in page
│   ├── admin.html         # Admin panel
│   ├── css/style.css      # Dark theme styles
│   └── js/
│       ├── app.js         # App initialization
│       ├── mixer.js       # Web Audio API engine
│       ├── transport.js   # Play/pause/stop/seek controls
│       ├── ui.js          # Channel strip rendering
│       ├── comments.js    # Comments UI
│       ├── mixes.js       # Mix save/load UI
│       └── auth.js        # Client-side auth
├── raw_audio/             # Your multitrack recordings (not committed)
├── cache/                 # Transcoded OGG files (auto-generated)
├── data/                  # SQLite databases (auto-generated)
└── dev_server.py          # Python fallback server for development
```

## License

MIT
