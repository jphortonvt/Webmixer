// Web Audio API engine for synchronized multitrack playback.
// Tracks stream through <audio> elements (MediaElementAudioSourceNode) rather
// than being decoded into AudioBuffers — keeps memory flat on mobile, where
// fully-decoded PCM for a session can exceed what iOS Safari allows a tab.
const Mixer = (() => {
  let audioCtx = null;
  let tracks = []; // { el, sourceNode, gainNode, panNode, analyserNode, name, url }
  let isPlaying = false;
  let duration = 0;
  let masterIndex = -1; // index of the longest track; drives time/ended events
  let onTimeUpdate = null;
  let onPlaybackEnd = null;
  let timeUpdateId = null;
  let driftCheckId = null;
  let wakeLock = null;

  // Elements are allowed to drift this far (seconds) from the master before
  // being snapped back into sync.
  const DRIFT_TOLERANCE = 0.06;

  function getContext() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  // Call this synchronously inside a user gesture to unlock audio on iOS.
  function unlock() {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
  }

  function disposeTracks() {
    for (const t of tracks) {
      try { t.el.pause(); } catch (e) {}
      t.el.removeAttribute('src');
      t.el.load();
      try { t.sourceNode.disconnect(); } catch (e) {}
      try { t.gainNode.disconnect(); } catch (e) {}
      try { t.panNode.disconnect(); } catch (e) {}
      try { t.analyserNode.disconnect(); } catch (e) {}
    }
    tracks = [];
    masterIndex = -1;
    duration = 0;
  }

  function waitForMetadata(el, name) {
    return new Promise((resolve, reject) => {
      if (el.readyState >= 1) return resolve(); // HAVE_METADATA
      const onMeta = () => { cleanup(); resolve(); };
      const onErr = () => { cleanup(); reject(new Error(`Failed to load ${name}`)); };
      const cleanup = () => {
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('error', onErr);
      };
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('error', onErr);
    });
  }

  async function loadTracks(trackList) {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    stop();
    disposeTracks();

    tracks = trackList.map((t) => {
      const el = new Audio();
      el.preload = 'auto';
      el.src = t.url;

      const sourceNode = ctx.createMediaElementSource(el);
      const gainNode = ctx.createGain();
      // createStereoPanner is unavailable on iOS Safari < 14.1 — fall back to a pass-through gain node
      const panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;

      sourceNode.connect(gainNode);
      gainNode.connect(panNode);
      panNode.connect(analyserNode);
      analyserNode.connect(ctx.destination);

      return {
        name: t.name,
        url: t.url,
        el,
        sourceNode,
        gainNode,
        panNode,
        analyserNode,
        _baseVolume: 1,       // volume slider contribution (0–1.5)
        _boostMultiplier: 1,  // trim/boost button contribution
      };
    });

    await Promise.all(tracks.map(t => waitForMetadata(t.el, t.name)));

    duration = 0;
    tracks.forEach((t, i) => {
      if (t.el.duration > duration) {
        duration = t.el.duration;
        masterIndex = i;
      }
    });

    // Playback-end fires on the longest track
    if (masterIndex >= 0) {
      tracks[masterIndex].el.addEventListener('ended', handleMasterEnded);
    }

    return tracks.length;
  }

  function handleMasterEnded() {
    if (!isPlaying) return;
    isPlaying = false;
    for (const t of tracks) {
      try { t.el.pause(); } catch (e) {}
      t.el.currentTime = 0;
    }
    stopLoops();
    releaseWakeLock();
    if (window.UI) window.UI.stopVuLoop();
    if (onPlaybackEnd) onPlaybackEnd();
  }

  function play() {
    if (isPlaying || tracks.length === 0) return;

    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    const master = tracks[masterIndex].el;
    const startAt = master.currentTime;

    for (const t of tracks) {
      // Tracks shorter than the master stay silent past their own end
      if (startAt < t.el.duration) {
        t.el.currentTime = startAt;
        t.el.play().catch(err => console.warn(`Play failed for ${t.name}:`, err.message));
      }
    }

    isPlaying = true;
    startLoops();
    requestWakeLock();
    if (window.UI) window.UI.startVuLoop();
  }

  function pause() {
    if (!isPlaying) return;
    for (const t of tracks) {
      try { t.el.pause(); } catch (e) {}
    }
    isPlaying = false;
    stopLoops();
    releaseWakeLock();
    if (window.UI) window.UI.stopVuLoop();
  }

  function stop() {
    for (const t of tracks) {
      try { t.el.pause(); } catch (e) {}
      t.el.currentTime = 0;
    }
    isPlaying = false;
    stopLoops();
    releaseWakeLock();
    if (window.UI) window.UI.stopVuLoop();
    if (onTimeUpdate) onTimeUpdate(0, duration);
  }

  function seekTo(time, autoPlay) {
    const clamped = Math.max(0, Math.min(time, duration));
    const wasPlaying = isPlaying;

    for (const t of tracks) {
      t.el.currentTime = Math.min(clamped, t.el.duration || clamped);
    }

    if (autoPlay !== false) {
      if (!wasPlaying) {
        play();
      } else {
        // Already playing — restart any tracks the seek brought back into range
        for (const t of tracks) {
          if (t.el.paused && clamped < t.el.duration) {
            t.el.play().catch(() => {});
          }
        }
      }
    } else if (wasPlaying) {
      pause();
    }
    if (onTimeUpdate) onTimeUpdate(clamped, duration);
  }

  function setVolume(trackIndex, value) {
    if (tracks[trackIndex]) {
      const track = tracks[trackIndex];
      track._baseVolume = value;
      track.gainNode.gain.value = value * track._boostMultiplier;
    }
  }

  function setBoost(trackIndex, multiplier) {
    if (tracks[trackIndex]) {
      const track = tracks[trackIndex];
      track._boostMultiplier = multiplier;
      track.gainNode.gain.value = track._baseVolume * multiplier;
    }
  }

  function getBoost(trackIndex) {
    if (tracks[trackIndex]) {
      return tracks[trackIndex]._boostMultiplier || 1;
    }
    return 1;
  }

  function setPan(trackIndex, value) {
    if (tracks[trackIndex] && tracks[trackIndex].panNode.pan) {
      tracks[trackIndex].panNode.pan.value = value;
    }
  }

  function startLoops() {
    // Time display — setInterval instead of requestAnimationFrame to avoid
    // throttling when the tab is not focused
    stopLoops();
    timeUpdateId = setInterval(() => {
      if (!isPlaying) return;
      if (onTimeUpdate) onTimeUpdate(getCurrentTime(), duration);
    }, 100);

    // Keep tracks locked to the master; media elements drift independently,
    // especially on mobile when buffering stalls one stream
    driftCheckId = setInterval(() => {
      if (!isPlaying || masterIndex < 0) return;
      const masterTime = tracks[masterIndex].el.currentTime;
      tracks.forEach((t, i) => {
        if (i === masterIndex) return;
        if (masterTime >= t.el.duration) return; // legitimately finished
        if (t.el.paused) {
          t.el.currentTime = masterTime;
          t.el.play().catch(() => {});
        } else if (Math.abs(t.el.currentTime - masterTime) > DRIFT_TOLERANCE) {
          t.el.currentTime = masterTime;
        }
      });
    }, 1000);
  }

  function stopLoops() {
    if (timeUpdateId) { clearInterval(timeUpdateId); timeUpdateId = null; }
    if (driftCheckId) { clearInterval(driftCheckId); driftCheckId = null; }
  }

  // Keep the screen on during playback (no-op where unsupported)
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { /* denied (low battery etc.) — not critical */ }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  // Re-acquire wake lock when returning to the tab mid-playback
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPlaying) {
      requestWakeLock();
    }
  });

  function getCurrentTime() {
    if (masterIndex < 0) return 0;
    return tracks[masterIndex].el.currentTime;
  }

  function getDuration() {
    return duration;
  }

  function getIsPlaying() {
    return isPlaying;
  }

  // Per-track playback state — used to diagnose sync/buffering issues
  function getSyncInfo() {
    const masterTime = masterIndex >= 0 ? tracks[masterIndex].el.currentTime : 0;
    return tracks.map((t, i) => ({
      name: t.name,
      time: t.el.currentTime,
      driftMs: Math.round((t.el.currentTime - masterTime) * 1000),
      paused: t.el.paused,
      readyState: t.el.readyState,
      isMaster: i === masterIndex,
    }));
  }

  function getTrackLevels() {
    return tracks.map(t => {
      if (!t.analyserNode || !isPlaying) return 0;
      const array = new Uint8Array(t.analyserNode.fftSize);
      t.analyserNode.getByteTimeDomainData(array);
      let maxDev = 0;
      for (let i = 0; i < array.length; i++) {
        const dev = Math.abs(array[i] - 128);
        if (dev > maxDev) maxDev = dev;
      }
      return maxDev / 128;
    });
  }

  function setOnTimeUpdate(cb) {
    onTimeUpdate = cb;
  }

  function setOnPlaybackEnd(cb) {
    onPlaybackEnd = cb;
  }

  // iOS Safari requires AudioContext to be created/resumed within a user gesture.
  // Call this synchronously in any event handler where audio will follow.
  function unlockAudio() {
    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  return {
    unlock,
    loadTracks,
    play,
    pause,
    stop,
    seekTo,
    setVolume,
    setPan,
    setBoost,
    getBoost,
    getCurrentTime,
    getDuration,
    getIsPlaying,
    getTrackLevels,
    getSyncInfo,
    setOnTimeUpdate,
    setOnPlaybackEnd,
    unlockAudio
  };
})();
