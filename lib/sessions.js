const { listSessions: b2ListSessions, listSessionTracks: b2ListSessionTracks } = require('./b2');

const FOLDER_PATTERN = /^\d{6}_\d{6}$/;

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

async function getSessions() {
  const raw = await b2ListSessions();

  const sessions = raw.map(s => ({
    id: s.id,
    label: parseFolderDate(s.id),
    trackCount: s.trackCount
  }));

  sessions.sort((a, b) => a.id.localeCompare(b.id));
  return sessions;
}

async function getSessionTracks(sessionId) {
  // Validate no path traversal
  if (sessionId.includes('..') || sessionId.includes('/')) {
    throw new Error('Invalid session ID');
  }

  const tracks = await b2ListSessionTracks(sessionId);
  if (tracks.length === 0) {
    throw new Error('Session not found');
  }
  return tracks;
}

module.exports = { getSessions, getSessionTracks };
