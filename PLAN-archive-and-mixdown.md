# Plan: Session Archive (tags/search/star) + Mixdown Export → Playlist

Written for Claude Code to implement in this repo. Two feature areas, designed to
share patterns already in the codebase (the `session_names` join pattern in
`routes/api.js`, the per-user upsert pattern in `routes/playlist.js`, the
temp-dir + ffmpeg pattern in `lib/transcode.js`).

Suggested order: **Archive first** (smaller, self-contained), then
**Mixdown export + Playlist integration** (bigger, touches more files).
Feel free to reorder if one turns out easier to land first.

---

## 1. Archive: tags, search, starring

### Data model

Add to the schema block in `lib/db.js` (inside the existing `db.localOnly(() =>
db.exec(...))` call, alongside `session_names` etc.):

```sql
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

CREATE TABLE IF NOT EXISTS session_starred (
  session_id TEXT PRIMARY KEY NOT NULL,
  starred_by INTEGER REFERENCES users(id),
  starred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Decision: starring is shared/global**, not per-user — one star per session,
visible to everyone, like a "keeper" flag on the take rather than a personal
favorite. (Confirmed.)

### API (routes/api.js)

- Extend `GET /api/sessions` to also join `session_tags` (grouped into a
  `tags: string[]` array per session) and `session_starred` (`starred:
  boolean`) — same pattern already used there for `customName` via
  `session_names`. One call, no extra round trips.
- `POST /api/sessions/:id/tags` — body `{ tag }`, insert (ignore on
  duplicate).
- `DELETE /api/sessions/:id/tags/:tag`
- `PUT /api/sessions/:id/star` — body `{ starred: boolean }` — insert/delete
  the row in `session_starred`.

All behind `ensureAuthenticated` like the existing session routes. No admin
requirement — any band member can tag/star.

### UI (public/js/app.js, public/index.html)

MVP: keep the existing `<select id="session-select">` dropdown. Add:
- A text `<input>` above it that filters `sessionsList` client-side (session
  already fetches the whole list up front — filtering there is free, matches
  how `renderSessionDropdown` already works).
- Append tag/star info into each `<option>`'s label (e.g. a star glyph
  prefix, `#tag` suffixes) so filtering by typing a tag name works without
  any new UI chrome.
- A small tag-editor and star-toggle button next to the existing "rename
  session" pencil icon (`#btn-edit-name`), reusing its `prompt()`-based
  pattern for tags (simplest: comma-separated tag string in one prompt) and a
  single click to toggle star.

If this feels cramped once there are many tags, a fuller card-based session
browser (closer to what the Playlist tab already does with its own list UI)
is the natural next step — not needed for v1.

---

## 2. Mixdown export → Playlist, with subset ranges and on/off toggle

### Data model

Add to `songs` (schema in `lib/db.js`):

```sql
-- add columns (sql.js/SQLite: use ALTER TABLE ADD COLUMN, both nullable)
ALTER TABLE songs ADD COLUMN source_session_id TEXT;
ALTER TABLE songs ADD COLUMN range_start REAL;
ALTER TABLE songs ADD COLUMN range_end REAL;
```

Add to `playlist_items`:

```sql
ALTER TABLE playlist_items ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
```

(`ALTER TABLE ... ADD COLUMN` is idempotent-safe here the same way the
existing `CREATE TABLE IF NOT EXISTS` blocks are — guard with a check against
`PRAGMA table_info(songs)` / `playlist_items` before running, since SQLite
errors on adding a column that already exists, unlike `CREATE TABLE IF NOT
EXISTS`.)

**Decision: mixdowns are visible to the whole band** by default — they land
in the shared `songs` table like any other song, not scoped to the creator.
(Confirmed.)

**Decision: the enable/disable toggle is per-user.** It lives on
`playlist_items`, which is already keyed by `(user_id, song_id)` — what one
person wants in rotation doesn't need to match anyone else's view.

### Rendering the mixdown (server-side ffmpeg)

New function in `lib/transcode.js`, e.g. `renderMixdown(cacheDir, sessionId,
tracks, settings, { format, startSeconds, endSeconds })`:

- Inputs are the **already-cached per-track MP3s** in `CACHE_DIR` (not the
  raw WAVs) — they're already transcoded and sitting on disk/B2 for any
  session that's been opened, so this is fast and avoids re-downloading from
  B2.
- Build an ffmpeg filter graph: for each track that isn't muted (and honoring
  solo — if any track is soloed, only soloed tracks are included), apply, in
  order:
  1. `atrim=start=<startSeconds>:end=<endSeconds>,asetpts=PTS-STARTPTS` — trim
     first, before mixing, so every track is cut at the same sample-accurate
     point.
  2. `volume=<vol>` from the track's saved volume (0–1.5).
  3. Panning — mono tracks can use `pan=stereo|c0=<L-gain>*c0|c1=<R-gain>*c0`;
     already-stereo tracks (merged L/R pairs) need `stereotools` or an
     equivalent stereo-safe pan approach. Work out the exact filter syntax
     during implementation — flagged here because it's the fiddliest part.
  4. Feed all trimmed/adjusted streams into `amix=inputs=N:duration=longest`.
- Output: `libmp3lame -b:a 192k` for MP3 (matches the bitrate already used
  elsewhere in this file), `pcm_s16le` in a `.wav` container for WAV.
- Use the same `TMP_DIR`/cleanup pattern already in this file for the merge
  case (write to a temp path, delete after use).

### API

`POST /api/sessions/:id/mixdown`
- Body: `{ settings, format, startSeconds, endSeconds, name }` — `settings`
  is exactly what `UI.getSettings()` already produces client-side (same
  shape saved by `POST /api/sessions/:id/mix`), so the frontend can reuse
  that function verbatim.
- Server renders via `renderMixdown(...)`, uploads the result to B2 under
  `songs/<generated-filename>` using the existing `uploadFile()` in
  `lib/b2.js` (no presigned-URL round trip needed — this is a server-side
  upload, not browser-to-B2), then inserts a row into `songs` with
  `source_session_id`, `range_start`, `range_end` set, `added_by` = current
  user.
- Responds with the created song record (same shape as
  `POST /api/admin/songs` returns) so the frontend can immediately reflect it
  in the Playlist tab.
- Auth: `ensureAuthenticated`, not `ensureAdmin` — any band member can render
  a mixdown, unlike the existing admin-only song upload.

`PUT /api/playlist/:songId/enabled`
- Body: `{ enabled: boolean }`.
- Upsert into `playlist_items` for `(req.user.id, songId)` — if no row
  exists yet (song not yet in this user's custom order), create one with a
  default `position` (append to end), same upsert-or-insert shape already
  used in `routes/api.js` for `session_names`.

`GET /api/songs` (existing route in `routes/playlist.js`)
- Extend the `SELECT` to also return `COALESCE(pi.enabled, 1) AS enabled` so
  songs with no playlist_items row yet default to enabled.

Download: add `res.set('Content-Disposition', 'attachment; filename="..."')`
on the `/songs/:filename` static-serve path (or the on-demand B2 fallback
route) so the browser downloads rather than tries to play inline.

### UI

**Export modal** (extends the existing `#mix-save-modal` pattern in
`index.html`/`app.js`, or a new sibling modal): format picker (MP3/WAV),
optional name field (default something like `<session label/customName> —
Mixdown (0:45–2:10)`, omitting the range suffix for a full-length export).

**In/out points**: two small buttons, "Set In" / "Set Out", next to the
existing transport controls. Each captures `Mixer.getCurrentTime()` when
clicked; unset = full track. Store as local state (`mixdownStart` /
`mixdownEnd`), pre-fill the export modal's fields from them, editable as
mm:ss before submitting. (Confirmed as the v1 approach — draggable range
handles on the seek bar, similar to how `#comment-markers` already overlay
the seek bar, are a natural v2 if buttons feel too fiddly in practice.)

**Playlist tab** (`public/js/playlist.js`):
- Each row gets an enabled/disabled toggle (checkbox or switch); wire it to
  `PUT /api/playlist/:songId/enabled`.
- "Play All" / next / prev logic skips disabled songs — it's a rotation
  filter, not a delete.
- Each row gets a download button/link (`<a download href="/songs/...">`).
- Songs that came from a mixdown show their `source_session_id` /
  range as a small subtitle, so it's clear where they came from.

---

## Open items to resolve during implementation

- Exact ffmpeg pan filter for stereo-pair tracks vs. mono tracks in the
  mixdown render (flagged above).
- Whether "Play All" ordering should still respect the existing
  `playlist_items.position` when some songs are disabled (skip-in-place,
  recommended) vs. re-pack the visible list.
- SQLite `ALTER TABLE ADD COLUMN` needs an existence check before running
  (unlike the `CREATE TABLE IF NOT EXISTS` blocks elsewhere in `lib/db.js`)
  to stay idempotent across restarts.

## Testing note

The `.env` on this machine has no `B2_*` credentials set, so `lib/sessions.js`
/ `lib/transcode.js` (which go through B2, not the local `raw_audio/` folder
directly) can't run end-to-end here without them. Confirm with JP how he
wants to test before relying on a live B2 connection during development —
the real bucket holds the actual band archive.
