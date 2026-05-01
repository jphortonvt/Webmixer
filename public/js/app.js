// Application initialization and session management
(async function App() {
  const sessionSelect = document.getElementById('session-select');
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');
  const editNameBtn = document.getElementById('btn-edit-name');
  let sessionsList = []; // cached for refreshing dropdown

  // Initialize auth first
  const user = await Auth.init();
  if (!user) return; // Redirected to login

  Transport.init();
  Comments.init();
  Mixes.init();

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

  function renderSessionDropdown(selectedId) {
    const currentValue = selectedId || sessionSelect.value;
    sessionSelect.innerHTML = '<option value="">-- Select a session --</option>';
    sessionsList.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const nameStr = s.customName ? ` — ${s.customName}` : '';
      opt.textContent = `${s.label}${nameStr} (${s.trackCount} tracks)`;
      sessionSelect.appendChild(opt);
    });
    sessionSelect.value = currentValue;
    sessionSelect.disabled = false;
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

  // Handle session selection
  sessionSelect.addEventListener('change', async () => {
    const sessionId = sessionSelect.value;
    editNameBtn.classList.toggle('hidden', !sessionId);
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
      UI.renderTracks(data.tracks);

      // Enable transport
      Transport.enable();
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
