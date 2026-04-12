const fs = require('fs');
const path = require('path');

const FOLDER_PATTERN = /^\d{6}_\d{6}$/;
const TRACK_PATTERN = /^TRACK\d+\.WAV$/i;

function parseFolderDate(name) {
  // Format: YYMMDD_HHMMSS
  const yy = name.slice(0, 2);
  const mm = name.slice(2, 4);
  const dd = name.slice(4, 6);
  const HH = name.slice(7, 9);
  const MM = name.slice(9, 11);

  const date = new Date(`20${yy}-${mm}-${dd}T${HH}:${MM}:00`);
  const label = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  return label;
}

function getSessions(audioDir) {
  const entries = fs.readdirSync(audioDir, { withFileTypes: true });
  const sessions = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !FOLDER_PATTERN.test(entry.name)) continue;

    const folderPath = path.join(audioDir, entry.name);
    const files = fs.readdirSync(folderPath);
    const tracks = files.filter(f => TRACK_PATTERN.test(f));

    if (tracks.length === 0) continue;

    sessions.push({
      id: entry.name,
      label: parseFolderDate(entry.name),
      trackCount: tracks.length
    });
  }

  sessions.sort((a, b) => a.id.localeCompare(b.id));
  return sessions;
}

function getSessionTracks(audioDir, sessionId) {
  // Validate no path traversal
  if (sessionId.includes('..') || sessionId.includes('/')) {
    throw new Error('Invalid session ID');
  }

  const folderPath = path.join(audioDir, sessionId);
  if (!fs.existsSync(folderPath)) {
    throw new Error('Session not found');
  }

  const files = fs.readdirSync(folderPath);
  return files
    .filter(f => TRACK_PATTERN.test(f))
    .sort();
}

module.exports = { getSessions, getSessionTracks };
