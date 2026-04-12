// Application initialization and session management
(async function App() {
  const sessionSelect = document.getElementById('session-select');
  const loadingEl = document.getElementById('loading');
  const loadingText = document.getElementById('loading-text');

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

  // Load session list
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();

    sessionSelect.innerHTML = '<option value="">-- Select a session --</option>';
    sessions.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.label} (${s.trackCount} tracks)`;
      sessionSelect.appendChild(opt);
    });
    sessionSelect.disabled = false;
  } catch (err) {
    console.error('Failed to load sessions:', err);
    sessionSelect.innerHTML = '<option value="">Failed to load sessions</option>';
  }

  // Handle session selection
  sessionSelect.addEventListener('change', async () => {
    const sessionId = sessionSelect.value;
    if (!sessionId) {
      Mixer.stop();
      Transport.disable();
      UI.clearMixer();
      Comments.loadComments(null);
      Mixes.hide();
      return;
    }

    Mixer.stop();
    Transport.disable();
    UI.clearMixer();
    Comments.loadComments(null);
    Mixes.hide();
    showLoading('Preparing tracks (transcoding if needed)...');

    try {
      // Fetch track list (triggers transcoding on server if needed)
      const res = await fetch(`/api/sessions/${sessionId}/tracks`);
      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }
      let data = await res.json();

      // If server is still transcoding, poll until ready
      if (data.preparing) {
        showLoading(`Preparing ${data.trackCount} tracks from cloud storage... (this may take a few minutes on first load)`);
        data = await waitForTracks(sessionId);
      }

      if (!data.tracks || data.tracks.length === 0) {
        hideLoading();
        showLoading('No tracks found for this session.');
        return;
      }

      showLoading(`Loading ${data.tracks.length} tracks into mixer...`);

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
