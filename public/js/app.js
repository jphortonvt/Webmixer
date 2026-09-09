// Application initialization and session management
(async function App() {
  const sessionSelect = document.getElementById('session-select');
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const editNameBtn = document.getElementById('btn-edit-name');
  const sessionFilter = document.getElementById('session-filter');
  const tagsBtn = document.getElementById('btn-edit-tags');
  const starBtn = document.getElementById('btn-star-session');
  let sessionsList = []; // cached for refreshing dropdown

  // Mixdown in/out points, in seconds. null = full length.
  let mixdownStart = null;
  let mixdownEnd = null;

  // Initialize auth first
  const user = await Auth.init();
  if (!user) return; // Redirected to login

  Transport.init();
  Comments.init();
  Mixes.init();
  Playlist.init();

  // Tab switching
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const sessionSelectorWrap = document.getElementById('session-selector-wrap');
  let playlistLoaded = false;

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach(b => b.classList.toggle('active', b === btn));
      tabContents.forEach(c => c.classList.toggle('hidden', c.id !== 'tab-' + target));

      // Show/hide session selector — only relevant in mixer tab
      if (sessionSelectorWrap) {
        sessionSelectorWrap.style.display = target === 'mixer' ? '' : 'none';
      }

      // Lazy-load playlist on first visit
      if (target === 'playlist' && !playlistLoaded) {
        playlistLoaded = true;
        Playlist.load();
      }
    });
  });

  function showLoading(msg) {
    loadingText.textContent = msg;
    loadingEl.classList.remove('hidden');
  }

  function hideLoading() {
    loadingEl.classList.add('hidden');
  }

  // Poll for tracks until transcoding is complete
  async function waitForTracks(sessionId) {
    const maxAttempts = 120; // 10 minutes max (120 x 5s)
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 5000));
      showLoading(`Preparing tracks from cloud storage... (this may take a few minutes on first load)`);

      const res = await fetch(`/api/sessions/${sessionId}/tracks`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();

      if (!data.preparing) {
        return data; // Tracks are ready
      }
    }
    throw new Error('Transcoding timed out');
  }

  // Label carries the star and #tags so typing either into the filter works
  // without any extra UI.
  function sessionLabel(s) {
    const star = s.starred ? '★ ' : '';
    const nameStr = s.customName ? ` — ${s.customName}` : '';
    const tagStr = (s.tags && s.tags.length) ? '  ' + s.tags.map(t => '#' + t).join(' ') : '';
    return `${star}${s.label}${nameStr} (${s.trackCount} tracks)${tagStr}`;
  }

  function matchesFilter(s, query) {
    if (!query) return true;
    // "star" or a bare star character filters to starred sessions
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = sessionLabel(s).toLowerCase() + ' ' + s.id.toLowerCase();
    return terms.every(term => {
      if (term === '★' || term === 'star' || term === 'starred') return !!s.starred;
      return hay.includes(term.replace(/^#/, '#'));
    });
  }

  function renderSessionDropdown(selectedId) {
    const currentValue = selectedId || sessionSelect.value;
    const query = sessionFilter ? sessionFilter.value.trim() : '';
    const visible = sessionsList.filter(s => matchesFilter(s, query));

    sessionSelect.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = query
      ? `-- ${visible.length} of ${sessionsList.length} sessions --`
      : '-- Select a session --';
    sessionSelect.appendChild(placeholder);

    visible.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = sessionLabel(s);
      sessionSelect.appendChild(opt);
    });

    // Keep the loaded session selectable even when the filter would hide it
    if (currentValue && !visible.some(s => s.id === currentValue)) {
      const s = sessionsList.find(x => x.id === currentValue);
      if (s) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = sessionLabel(s);
        sessionSelect.appendChild(opt);
      }
    }

    sessionSelect.value = currentValue;
    sessionSelect.disabled = false;
    updateSessionButtons();
  }

  function currentSession() {
    return sessionsList.find(s => s.id === sessionSelect.value) || null;
  }

  function updateSessionButtons() {
    const s = currentSession();
    const has = !!s;
    [editNameBtn, tagsBtn, starBtn].forEach(b => b && b.classList.toggle('hidden', !has));
    if (s && starBtn) {
      starBtn.textContent = s.starred ? '★' : '☆';
      starBtn.classList.toggle('active', !!s.starred);
      starBtn.title = s.starred ? 'Starred — click to unstar' : 'Star this session';
    }
    if (s && tagsBtn) {
      tagsBtn.title = (s.tags && s.tags.length) ? `Tags: ${s.tags.join(', ')}` : 'Tag this session';
      tagsBtn.classList.toggle('active', !!(s.tags && s.tags.length));
    }
  }

  // Load session list
  try {
    const res = await fetch('/api/sessions');
    sessionsList = await res.json();
    renderSessionDropdown();
  } catch (err) {
    console.error('Failed to load sessions:', err);
    sessionSelect.innerHTML = '<option value="">Failed to load sessions</option>';
  }

  // Filter the dropdown as you type — the whole list is already loaded
  if (sessionFilter) {
    sessionFilter.addEventListener('input', () => renderSessionDropdown());
  }

  // Star / unstar (shared across the band, not per-user)
  if (starBtn) {
    starBtn.addEventListener('click', async () => {
      const s = currentSession();
      if (!s) return;
      const next = !s.starred;
      s.starred = next; // optimistic
      updateSessionButtons();
      try {
        const res = await fetch(`/api/sessions/${s.id}/star`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ starred: next }),
        });
        if (!res.ok) throw new Error('failed');
        renderSessionDropdown(s.id);
      } catch (err) {
        console.error('Failed to update star:', err);
        s.starred = !next;
        updateSessionButtons();
      }
    });
  }

  // Tags — one comma-separated prompt replaces the whole set
  if (tagsBtn) {
    tagsBtn.addEventListener('click', async () => {
      const s = currentSession();
      if (!s) return;
      const current = (s.tags || []).join(', ');
      const input = prompt('Tags for this session (comma separated, blank to clear):', current);
      if (input === null) return;

      const tags = input.split(',').map(t => t.trim()).filter(Boolean);
      try {
        const res = await fetch(`/api/sessions/${s.id}/tags`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        });
        if (!res.ok) throw new Error('failed');
        const data = await res.json();
        s.tags = data.tags;
        renderSessionDropdown(s.id);
      } catch (err) {
        console.error('Failed to save tags:', err);
        alert('Failed to save tags');
      }
    });
  }

  // Edit session name button
  editNameBtn.addEventListener('click', async () => {
    const sessionId = sessionSelect.value;
    if (!sessionId) return;

    const session = sessionsList.find(s => s.id === sessionId);
    const currentName = session?.customName || '';
    const newName = prompt('Enter a name for this session (leave blank to clear):', currentName);

    if (newName === null) return; // cancelled

    try {
      const res = await fetch(`/api/sessions/${sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) throw new Error('Failed to save name');
      const data = await res.json();

      // Update cached session list and re-render dropdown
      if (session) session.customName = data.name;
      renderSessionDropdown(sessionId);
    } catch (err) {
      console.error('Failed to update session name:', err);
      alert('Failed to save session name');
    }
  });

  // --- Mixdown in/out points and export ------------------------------------

  const setInBtn = document.getElementById('btn-set-in');
  const setOutBtn = document.getElementById('btn-set-out');
  const rangeDisplay = document.getElementById('range-display');
  const exportBtn = document.getElementById('btn-export-mix');
  const mixdownModal = document.getElementById('mixdown-modal');
  const mixdownName = document.getElementById('mixdown-name');
  const mixdownStartEl = document.getElementById('mixdown-start');
  const mixdownEndEl = document.getElementById('mixdown-end');
  const mixdownFormat = document.getElementById('mixdown-format');
  const mixdownStatus = document.getElementById('mixdown-status');

  function fmtTime(sec) {
    if (sec == null) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Accepts "mm:ss" or plain seconds; empty means unset
  function parseTime(str) {
    const raw = String(str || '').trim();
    if (!raw) return null;
    if (raw.includes(':')) {
      const [m, s] = raw.split(':');
      const mins = parseInt(m, 10), secs = parseFloat(s);
      if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
      return mins * 60 + secs;
    }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : null;
  }

  function updateRangeDisplay() {
    if (!rangeDisplay) return;
    if (mixdownStart == null && mixdownEnd == null) {
      rangeDisplay.textContent = '';
      return;
    }
    rangeDisplay.textContent = `${fmtTime(mixdownStart || 0)}–${mixdownEnd != null ? fmtTime(mixdownEnd) : 'end'}`;
  }

  if (setInBtn) {
    setInBtn.addEventListener('click', () => {
      mixdownStart = Mixer.getCurrentTime();
      if (mixdownEnd != null && mixdownEnd <= mixdownStart) mixdownEnd = null;
      updateRangeDisplay();
    });
  }
  if (setOutBtn) {
    setOutBtn.addEventListener('click', () => {
      const t = Mixer.getCurrentTime();
      if (mixdownStart != null && t <= mixdownStart) return; // out must follow in
      mixdownEnd = t;
      updateRangeDisplay();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (!sessionSelect.value) return;
      const s = currentSession();
      const label = s ? (s.customName || s.label) : sessionSelect.value;
      const suffix = (mixdownStart != null || mixdownEnd != null)
        ? ` (${fmtTime(mixdownStart || 0)}–${mixdownEnd != null ? fmtTime(mixdownEnd) : 'end'})`
        : '';
      mixdownName.value = `${label} — Mixdown${suffix}`;
      mixdownStartEl.value = mixdownStart != null ? fmtTime(mixdownStart) : '';
      mixdownEndEl.value = mixdownEnd != null ? fmtTime(mixdownEnd) : '';
      mixdownStatus.textContent = '';
      mixdownModal.classList.remove('hidden');
    });
  }

  const closeMixdownModal = () => mixdownModal.classList.add('hidden');
  const cancelBtn = document.getElementById('btn-mixdown-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeMixdownModal);

  const clearRangeBtn = document.getElementById('btn-range-clear');
  if (clearRangeBtn) {
    clearRangeBtn.addEventListener('click', () => {
      mixdownStartEl.value = '';
      mixdownEndEl.value = '';
    });
  }

  const confirmBtn = document.getElementById('btn-mixdown-confirm');
  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      const sessionId = sessionSelect.value;
      if (!sessionId) return;

      const start = parseTime(mixdownStartEl.value);
      const end = parseTime(mixdownEndEl.value);
      if (start != null && end != null && end <= start) {
        mixdownStatus.textContent = 'The out point must come after the in point.';
        return;
      }

      confirmBtn.disabled = true;
      mixdownStatus.textContent = 'Rendering… this can take a moment.';

      try {
        const body = {
          settings: UI.getSettings(),
          format: mixdownFormat.value,
          name: mixdownName.value,
        };
        if (start != null) body.startSeconds = start;
        if (end != null) body.endSeconds = end;

        const res = await fetch(`/api/sessions/${sessionId}/mixdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Export failed');

        mixdownStatus.textContent = `Saved "${data.name}" to the Playlist (${data.trackCount} tracks).`;
        if (window.Playlist && Playlist.load) Playlist.load();
        setTimeout(closeMixdownModal, 1600);
      } catch (err) {
        console.error('Mixdown failed:', err);
        mixdownStatus.textContent = err.message || 'Export failed.';
      } finally {
        confirmBtn.disabled = false;
      }
    });
  }

  // Handle session selection
  sessionSelect.addEventListener('change', async () => {
    Mixer.unlockAudio(); // Must be synchronous before any awaits — required for iOS Safari
    const sessionId = sessionSelect.value;
    updateSessionButtons();

    // A new session invalidates any in/out points from the previous one
    mixdownStart = null;
    mixdownEnd = null;
    updateRangeDisplay();
    if (setInBtn) setInBtn.disabled = true;
    if (setOutBtn) setOutBtn.disabled = true;
    if (!sessionId) {
      Mixer.stop();
      Transport.disable();
      UI.clearMixer();
      Comments.loadComments(null);
      Mixes.hide();
      return;
    }

    // Unlock AudioContext now, while still inside the synchronous user gesture.
    // iOS Safari requires this before any async work (fetch, etc.) breaks the gesture window.
    Mixer.unlock();

    Mixer.stop();
    Transport.disable();
    UI.clearMixer();
    Comments.loadComments(null);
    Mixes.hide();
    showLoading('Loading session...');

    try {
      // Fetch track list (triggers transcoding on server if needed)
      const res = await fetch(`/api/sessions/${sessionId}/tracks`);
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }
      let data = await res.json();

      // If server is still transcoding, poll until ready
      if (data.preparing) {
        showLoading(`Preparing ${data.trackCount} tracks from cloud storage... (first load may take a few minutes)`);
        data = await waitForTracks(sessionId);
      }

      if (!data.tracks || data.tracks.length === 0) {
        hideLoading();
        showLoading('No tracks found for this session.');
        return;
      }

      showLoading(`Loading ${data.tracks.length} tracks...`);

      // Load audio buffers
      await Mixer.loadTracks(data.tracks);

      // Render channel strips
      UI.renderTracks(data.tracks, sessionId);

      // Enable transport
      Transport.enable();
      if (setInBtn) setInBtn.disabled = false;
      if (setOutBtn) setOutBtn.disabled = false;
      Transport.updateTimeDisplay(0, Mixer.getDuration());

      // Load saved mix settings (if any)
      await Mixes.loadMix(sessionId);
      Mixes.show(sessionId);

      // Load comments for this session
      Comments.loadComments(sessionId);
    } catch (err) {
      console.error('Failed to load session:', err);
      loadingText.textContent = 'Error loading session. Check console.';
      loadingEl.classList.remove('hidden');
      return;
    }

    hideLoading();
  });
})();
