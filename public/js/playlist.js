// Playlist: per-user song list with drag-and-drop reordering and HTML5 audio player
const Playlist = (() => {
  let songs = [];       // current ordered list of song objects
  let currentIdx = -1;  // index of the song loaded in the audio player
  let saveTimer = null;

  // DOM refs (set in init)
  let audioEl, songListEl, nowPlayingEl, emptyEl, countEl;

  // --- Helpers ---

  function formatDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Data ---

  async function load() {
    try {
      const res = await fetch('/api/songs');
      if (!res.ok) return;
      songs = await res.json();
      render();
    } catch (e) {
      console.error('[Playlist] load error:', e);
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await fetch('/api/playlist/order', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songIds: songs.map(s => s.id) }),
        });
      } catch (e) {
        console.error('[Playlist] save order error:', e);
      }
    }, 800);
  }

  // --- Playback ---

  function playSong(idx) {
    if (idx < 0 || idx >= songs.length) return;
    currentIdx = idx;
    const song = songs[idx];
    audioEl.src = '/songs/' + encodeURIComponent(song.filename);
    audioEl.load();
    audioEl.play().catch(() => {}); // iOS may block autoplay; user already clicked
    nowPlayingEl.textContent = song.name;
    render();
  }

  // --- Render ---

  function render() {
    if (!songListEl) return;
    songListEl.innerHTML = '';

    if (songs.length === 0) {
      emptyEl.classList.remove('hidden');
      if (countEl) countEl.textContent = '';
      return;
    }
    emptyEl.classList.add('hidden');
    if (countEl) countEl.textContent = songs.length === 1 ? '1 song' : `${songs.length} songs`;

    songs.forEach((song, idx) => {
      const row = document.createElement('div');
      row.className = 'song-row' + (idx === currentIdx ? ' playing' : '');
      row.dataset.songId = String(song.id);

      const dur = song.duration ? `<span class="song-dur">${esc(formatDuration(song.duration))}</span>` : '';
      const playIcon = idx === currentIdx
        ? '<span class="playing-icon">&#9654;</span>'
        : '<span class="playing-icon"></span>';

      row.innerHTML =
        '<span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>' +
        `<span class="track-num">${idx + 1}</span>` +
        playIcon +
        `<span class="song-title">${esc(song.name)}</span>` +
        dur;

      // Click anywhere on the row (except the handle) to play
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('drag-handle')) return;
        playSong(idx);
      });

      songListEl.appendChild(row);
    });

    setupDragDrop();
  }

  // --- Drag-and-drop (pointer events — works for mouse and touch) ---

  function setupDragDrop() {
    const rows = [...songListEl.querySelectorAll('.song-row')];

    rows.forEach((row, idx) => {
      const handle = row.querySelector('.drag-handle');
      if (!handle) return;

      let dragState = null;

      function cleanup() {
        if (!dragState) return;
        if (dragState.clone) dragState.clone.remove();
        if (dragState.placeholder && dragState.placeholder.parentNode) {
          dragState.placeholder.parentNode.removeChild(dragState.placeholder);
        }
        row.style.opacity = '';
        dragState = null;
      }

      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);

        const rect = row.getBoundingClientRect();
        row.style.opacity = '0.25';

        // Floating ghost that follows the pointer
        const clone = row.cloneNode(true);
        Object.assign(clone.style, {
          position: 'fixed',
          left: rect.left + 'px',
          top: rect.top + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
          opacity: '0.9',
          pointerEvents: 'none',
          zIndex: '1000',
          background: 'var(--bg-surface)',
          border: '1px solid var(--accent)',
          borderRadius: '6px',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          transition: 'none',
          margin: '0',
        });
        document.body.appendChild(clone);

        // Placeholder that marks the drop position
        const placeholder = document.createElement('div');
        placeholder.className = 'drag-placeholder';
        placeholder.style.height = rect.height + 'px';
        row.parentNode.insertBefore(placeholder, row.nextSibling);

        dragState = {
          clone,
          placeholder,
          pointerId: e.pointerId,
          startY: e.clientY,
          startTop: rect.top,
        };
      });

      handle.addEventListener('pointermove', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;

        // Move ghost
        const dy = e.clientY - dragState.startY;
        dragState.clone.style.top = (dragState.startTop + dy) + 'px';

        // Find which non-dragged row the pointer is above
        const realRows = [...songListEl.querySelectorAll('.song-row')].filter(r => r !== row);
        let insertBefore = null;
        for (const r of realRows) {
          const rRect = r.getBoundingClientRect();
          if (e.clientY < rRect.top + rRect.height / 2) {
            insertBefore = r;
            break;
          }
        }

        // Reposition placeholder
        const ph = dragState.placeholder;
        if (ph.parentNode) ph.parentNode.removeChild(ph);
        if (insertBefore) {
          songListEl.insertBefore(ph, insertBefore);
        } else {
          songListEl.appendChild(ph);
        }
      });

      handle.addEventListener('pointerup', (e) => {
        if (!dragState || e.pointerId !== dragState.pointerId) return;

        // Count non-dragged song-rows before the placeholder to find new insert position
        const { placeholder } = dragState;
        const siblings = [...songListEl.children];
        const phPos = siblings.indexOf(placeholder);
        const rowsBefore = siblings
          .slice(0, phPos)
          .filter(el => el.classList.contains('song-row') && el !== row)
          .length;

        cleanup();

        // Rebuild songs array with new order
        const dragged = songs[idx];
        const rest = songs.filter((_, i) => i !== idx);
        const newSongs = [
          ...rest.slice(0, rowsBefore),
          dragged,
          ...rest.slice(rowsBefore),
        ];

        // Keep currentIdx pointing at the same song
        if (currentIdx >= 0 && currentIdx < songs.length) {
          const currentSong = songs[currentIdx];
          currentIdx = newSongs.findIndex(s => s.id === currentSong.id);
        }

        songs = newSongs;
        render();
        scheduleSave();
      });

      handle.addEventListener('pointercancel', cleanup);
    });
  }

  // --- Init ---

  function init() {
    audioEl = document.getElementById('playlist-audio');
    songListEl = document.getElementById('song-list');
    nowPlayingEl = document.getElementById('now-playing');
    emptyEl = document.getElementById('playlist-empty');
    countEl = document.getElementById('playlist-count');

    if (!audioEl || !songListEl) return;

    // Auto-advance to the next song when current one ends
    audioEl.addEventListener('ended', () => {
      if (currentIdx >= 0 && currentIdx + 1 < songs.length) {
        playSong(currentIdx + 1);
      }
    });
  }

  return { init, load };
})();
