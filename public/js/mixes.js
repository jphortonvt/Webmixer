// Mix preset save/load/copy functionality
const Mixes = (() => {
  let currentSessionId = null;
  let savedSessions = []; // sessions that have saved mixes

  async function loadMix(sessionId) {
    currentSessionId = sessionId;
    if (!sessionId) return false;

    try {
      const res = await fetch(`/api/sessions/${sessionId}/mix`);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`Error: ${res.status}`);

      const data = await res.json();
      UI.applySettings(data.settings);
      showStatus('Mix loaded', true);
      return true;
    } catch (err) {
      console.error('Failed to load mix:', err);
      return false;
    }
  }

  async function saveMix(sessionId, copyFromSession) {
    if (!sessionId) return;

    const body = {};
    if (copyFromSession) {
      body.copy_from_session = copyFromSession;
    } else {
      body.settings = UI.getSettings();
    }

    try {
      const res = await fetch(`/api/sessions/${sessionId}/mix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error(`Error: ${res.status}`);

      const data = await res.json();

      // If we copied from another session, apply those settings to the UI
      if (copyFromSession) {
        UI.applySettings(data.settings);
      }

      showStatus('Mix saved', true);
      // Refresh saved sessions list
      await refreshSavedSessions();
      return true;
    } catch (err) {
      console.error('Failed to save mix:', err);
      showStatus('Save failed');
      return false;
    }
  }

  async function refreshSavedSessions() {
    try {
      const res = await fetch('/api/mixes');
      if (!res.ok) return;
      savedSessions = await res.json();
    } catch (err) {
      console.error('Failed to fetch saved mixes:', err);
    }
  }

  function getSavedSessions() {
    return savedSessions;
  }

  function showStatus(msg, persistent) {
    const el = document.getElementById('mix-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    if (!persistent) {
      setTimeout(() => el.classList.remove('visible'), 2000);
    }
  }

  function clearStatus() {
    const el = document.getElementById('mix-status');
    if (!el) return;
    el.textContent = '';
    el.classList.remove('visible');
  }

  // Show/hide the mix actions bar
  function show(sessionId) {
    currentSessionId = sessionId;
    const bar = document.getElementById('mix-actions');
    if (bar) bar.classList.remove('hidden');
  }

  function hide() {
    currentSessionId = null;
    const bar = document.getElementById('mix-actions');
    if (bar) bar.classList.add('hidden');
    clearStatus();
    closeModal();
  }

  // Modal for save with copy-from option
  function openSaveModal() {
    const modal = document.getElementById('mix-save-modal');
    if (!modal) return;

    const sessionLabel = document.getElementById('session-select');
    const selectedText = sessionLabel.options[sessionLabel.selectedIndex]?.text || currentSessionId;
    document.getElementById('mix-save-session-name').textContent = selectedText;

    // Populate copy-from dropdown
    const copySelect = document.getElementById('mix-copy-from');
    copySelect.innerHTML = '<option value="">-- Don\'t copy, use current settings --</option>';

    for (const s of savedSessions) {
      if (s.session_id === currentSessionId) continue; // Skip current session
      // Try to find the label from the session dropdown
      const sessionOpt = document.querySelector(`#session-select option[value="${s.session_id}"]`);
      const label = sessionOpt ? sessionOpt.text : s.session_id;
      const opt = document.createElement('option');
      opt.value = s.session_id;
      opt.textContent = label;
      copySelect.appendChild(opt);
    }

    modal.classList.remove('hidden');
  }

  function closeModal() {
    const modal = document.getElementById('mix-save-modal');
    if (modal) modal.classList.add('hidden');
  }

  function init() {
    // Save button opens modal
    const saveBtn = document.getElementById('btn-save-mix');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        await refreshSavedSessions();
        openSaveModal();
      });
    }

    // Modal confirm
    const confirmBtn = document.getElementById('btn-mix-save-confirm');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        const copyFrom = document.getElementById('mix-copy-from').value || null;
        await saveMix(currentSessionId, copyFrom);
        closeModal();
      });
    }

    // Modal cancel
    const cancelBtn = document.getElementById('btn-mix-save-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', closeModal);
    }

    // Close modal on backdrop click
    const modal = document.getElementById('mix-save-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }
  }

  return { init, loadMix, saveMix, show, hide, refreshSavedSessions, getSavedSessions };
})();
