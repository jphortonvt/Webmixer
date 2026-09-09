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

  // --- Rotation ---
  // Disabled songs stay in the list at their saved position; they are only
  // skipped when advancing. Clicking one directly still plays it.

  function nextEnabledIdx(from) {
    for (let i = from + 1; i < songs.length; i++) {
      if (songs[i].enabled !== false) return i;
    }
    return -1;
  }

  function prevEnabledIdx(from) {
    for (let i = from - 1; i >= 0; i--) {
      if (songs[i].enabled !== false) return i;
    }
    return -1;
  }

  async function setEnabled(songId, enabled) {
    const song = songs.find(s => s.id === songId);
    if (song) song.enabled = enabled; // optimistic
    render();
    try {
      const res = await fetch(`/api/playlist/${songId}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('request failed');
    } catch (e) {
      console.error('[Playlist] enabled toggle error:', e);
      if (song) song.enabled = !enabled; // roll back
      render();
    }
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
    const onCount = songs.filter(s => s.enabled !== false).length;
    if (countEl) {
      countEl.textContent = onCount === songs.length
        ? (songs.length === 1 ? '1 song' : `${songs.length} songs`)
        : `${onCount} of ${songs.length} in rotation`;
    }

    songs.forEach((song, idx) => {
      const enabled = song.enabled !== false;
      const row = document.createElement('div');
      row.className = 'song-row' + (idx === currentIdx ? ' playing' : '') + (enabled ? '' : ' disabled');
      row.dataset.songId = String(song.id);

      const dur = song.duration ? `<span class="song-dur">${esc(formatDuration(song.duration))}</span>` : '';
      const playIcon = idx === currentIdx
        ? '<span class="playing-icon">&#9654;</span>'
        : '<span class="playing-icon"></span>';

      // Where a mixdown came from, so its origin is obvious in the list
      let origin = '';
      if (song.source_session_id) {
        const range = (song.range_start != null || song.range_end != null)
          ? ` · ${formatDuration(song.range_start || 0)}–${song.range_end != null ? formatDuration(song.range_end) : 'end'}`
          : '';
        origin = `<span class="song-origin">Mixdown of ${esc(song.source_session_id)}${esc(range)}</span>`;
      }

      const href = '/songs/' + encodeURIComponent(song.filename) + '?download=1';

      row.innerHTML =
        '<span class="drag-handle" title="Drag to reorder">&#8942;&#8942;</span>' +
        `<span class="track-num">${idx + 1}</span>` +
        playIcon +
        `<span class="song-main"><span class="song-title">${esc(song.name)}</span>${origin}</span>` +
        dur +
        `<a class="song-download" href="${href}" download title="Download">&#8681;</a>` +
        `<button class="song-toggle${enabled ? ' on' : ''}" title="${enabled ? 'In rotation — click to skip' : 'Skipped — click to include'}">${enabled ? 'On' : 'Off'}</button>`;

      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('drag-handle')) return;
        if (e.target.closest('.song-download')) return;      // let the link do its job
        if (e.target.closest('.song-toggle')) {
          e.stopPropagation();
          setEnabled(song.id, !enabled);
          return;
        }
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

    const playPauseBtn = document.getElementById('btn-playlist-play-pause');
    const prevBtn = document.getElementById('btn-playlist-prev');
    const nextBtn = document.getElementById('btn-playlist-next');
    const timeDisplay = document.getElementById('playlist-time-display');
    const seekBar = document.getElementById('playlist-seek-bar');

    // Update play/pause button text on play event
    audioEl.addEventListener('play', () => {
      if (playPauseBtn) playPauseBtn.innerHTML = '&#10074;&#10074; Pause';
    });

    audioEl.addEventListener('pause', () => {
      if (playPauseBtn) playPauseBtn.innerHTML = '&#9654; Play';
    });

    // Handle play/pause toggle click
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', () => {
        if (currentIdx === -1 && songs.length > 0) {
          playSong(0);
        } else if (audioEl.src) {
          if (audioEl.paused) {
            audioEl.play().catch(() => {});
          } else {
            audioEl.pause();
          }
        }
      });
    }

    // Previous track
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        const i = prevEnabledIdx(currentIdx);
        if (i !== -1) playSong(i);
      });
    }

    // Next track
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        const i = nextEnabledIdx(currentIdx);
        if (i !== -1) playSong(i);
      });
    }

    // Enable seek bar and set duration
    audioEl.addEventListener('loadedmetadata', () => {
      if (seekBar) {
        seekBar.disabled = false;
        seekBar.max = audioEl.duration;
      }
      updatePlaylistTimeDisplay();
    });

    // Progress updating
    audioEl.addEventListener('timeupdate', () => {
      if (seekBar && !seekBar._isUserDragging) {
        seekBar.value = audioEl.currentTime;
      }
      updatePlaylistTimeDisplay();
    });

    // Handle user interaction with seek bar
    if (seekBar) {
      seekBar.addEventListener('mousedown', () => {
        seekBar._isUserDragging = true;
      });
      seekBar.addEventListener('mouseup', () => {
        seekBar._isUserDragging = false;
        audioEl.currentTime = parseFloat(seekBar.value);
      });
      seekBar.addEventListener('touchstart', () => {
        seekBar._isUserDragging = true;
      });
      seekBar.addEventListener('touchend', () => {
        seekBar._isUserDragging = false;
        audioEl.currentTime = parseFloat(seekBar.value);
      });
      seekBar.addEventListener('input', () => {
        updatePlaylistTimeDisplay(parseFloat(seekBar.value));
      });
    }

    function updatePlaylistTimeDisplay(currentVal) {
      if (!timeDisplay) return;
      const cur = currentVal !== undefined ? currentVal : (audioEl.currentTime || 0);
      const dur = audioEl.duration || 0;
      timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    // Auto-advance to the next song when current one ends
    audioEl.addEventListener('ended', () => {
      const i = nextEnabledIdx(currentIdx);
      if (i !== -1) {
        playSong(i);
      } else {
        if (playPauseBtn) playPauseBtn.innerHTML = '&#9654; Play';
        if (seekBar) seekBar.value = 0;
        updatePlaylistTimeDisplay(0);
      }
    });
  }

  return { init, load };
})();
