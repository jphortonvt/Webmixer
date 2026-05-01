// Web Audio API engine for synchronized multitrack playback
const Mixer = (() => {
  let audioCtx = null;
  let tracks = []; // { buffer, sourceNode, gainNode, panNode, name, url }
  let isPlaying = false;
  let startTime = 0;
  let pauseOffset = 0;
  let duration = 0;
  let onTimeUpdate = null;
  let onPlaybackEnd = null;
  let animFrameId = null;
  let playGeneration = 0; // guards against stale onended callbacks

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

  async function loadTracks(trackList) {
    const ctx = getContext();
    // Resume context if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    stop(); // Reset any current playback
    tracks = [];
    duration = 0;

    const loadPromises = trackList.map(async (t) => {
      const response = await fetch(t.url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const gainNode = ctx.createGain();
      // createStereoPanner is unavailable on iOS Safari < 14.1 — fall back to a pass-through gain node
      const panNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();

      gainNode.connect(panNode);
      panNode.connect(ctx.destination);

      if (audioBuffer.duration > duration) {
        duration = audioBuffer.duration;
      }

      return {
        name: t.name,
        url: t.url,
        buffer: audioBuffer,
        sourceNode: null,
        gainNode,
        panNode
      };
    });

    tracks = await Promise.all(loadPromises);
    return tracks.length;
  }

  function createSourceNodes(offset) {
    const ctx = getContext();
    for (const track of tracks) {
      const source = ctx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(track.gainNode);
      track.sourceNode = source;
    }
  }

  function play() {
    if (isPlaying || tracks.length === 0) return;

    const ctx = getContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }

    createSourceNodes(pauseOffset);

    const scheduleTime = ctx.currentTime + 0.05;
    for (const track of tracks) {
      track.sourceNode.start(scheduleTime, pauseOffset);
    }

    startTime = scheduleTime - pauseOffset;
    isPlaying = true;

    // Listen for playback end on the longest track
    const gen = ++playGeneration;
    const longestTrack = tracks.reduce((a, b) =>
      a.buffer.duration > b.buffer.duration ? a : b
    );
    longestTrack.sourceNode.onended = () => {
      // Only handle if this is still the current play generation
      if (gen === playGeneration && isPlaying) {
        isPlaying = false;
        pauseOffset = 0;
        clearInterval(animFrameId); animFrameId = null;
        if (onPlaybackEnd) onPlaybackEnd();
      }
    };

    startTimeUpdate();
  }

  function pause() {
    if (!isPlaying) return;

    const ctx = getContext();
    pauseOffset = ctx.currentTime - startTime;
    stopSources();
    isPlaying = false;
    clearInterval(animFrameId); animFrameId = null;
  }

  function stop() {
    stopSources();
    isPlaying = false;
    pauseOffset = 0;
    clearInterval(animFrameId); animFrameId = null;
    if (onTimeUpdate) onTimeUpdate(0, duration);
  }

  function stopSources() {
    playGeneration++; // invalidate any pending onended callbacks
    for (const track of tracks) {
      if (track.sourceNode) {
        track.sourceNode.onended = null;
        try { track.sourceNode.stop(); } catch (e) {}
        track.sourceNode = null;
      }
    }
  }

  function seekTo(time, autoPlay) {
    stopSources();
    isPlaying = false;
    clearInterval(animFrameId); animFrameId = null;
    pauseOffset = Math.max(0, Math.min(time, duration));
    if (onTimeUpdate) onTimeUpdate(pauseOffset, duration);
    if (autoPlay !== false) {
      play();
    }
  }

  function setVolume(trackIndex, value) {
    if (tracks[trackIndex]) {
      const track = tracks[trackIndex];
      track._baseVolume = value;
      track.gainNode.gain.value = value * (track._boostMultiplier || 1);
    }
  }

  function setBoost(trackIndex, multiplier) {
    if (tracks[trackIndex]) {
      const track = tracks[trackIndex];
      track._boostMultiplier = multiplier;
      const base = track._baseVolume != null ? track._baseVolume : track.gainNode.gain.value;
      track.gainNode.gain.value = base * multiplier;
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

  function startTimeUpdate() {
    const ctx = getContext();
    // Use setInterval instead of requestAnimationFrame to avoid
    // throttling when the tab is not focused
    if (animFrameId) clearInterval(animFrameId);
    animFrameId = setInterval(() => {
      if (!isPlaying) {
        clearInterval(animFrameId);
        animFrameId = null;
        return;
      }
      const currentTime = ctx.currentTime - startTime;
      if (onTimeUpdate) onTimeUpdate(currentTime, duration);
    }, 100);
  }

  function getCurrentTime() {
    if (!isPlaying) return pauseOffset;
    return getContext().currentTime - startTime;
  }

  function getDuration() {
    return duration;
  }

  function getIsPlaying() {
    return isPlaying;
  }

  function setOnTimeUpdate(cb) {
    onTimeUpdate = cb;
  }

  function setOnPlaybackEnd(cb) {
    onPlaybackEnd = cb;
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
    setOnTimeUpdate,
    setOnPlaybackEnd
  };
})();
