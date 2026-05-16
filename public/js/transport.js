// Transport controls: Play, Pause, Stop, time display, seek bar
const Transport = (() => {
  const btnPlay = document.getElementById('btn-play');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');
  const timeDisplay = document.getElementById('time-display');
  const seekBar = document.getElementById('seek-bar');

  let isSeeking = false;

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function updateTimeDisplay(current, total) {
    timeDisplay.textContent = `${formatTime(current)} / ${formatTime(total)}`;
    if (!isSeeking && total > 0) {
      seekBar.value = (current / total) * 100;
    }
  }

  function enable() {
    btnPlay.disabled = false;
    btnPause.disabled = false;
    btnStop.disabled = false;
    seekBar.disabled = false;
  }

  function disable() {
    btnPlay.disabled = true;
    btnPause.disabled = true;
    btnStop.disabled = true;
    seekBar.disabled = true;
  }

  function init() {
    Mixer.setOnTimeUpdate(updateTimeDisplay);

    Mixer.setOnPlaybackEnd(() => {
      updateTimeDisplay(0, Mixer.getDuration());
    });

    btnPlay.addEventListener('click', () => {
      Mixer.unlockAudio(); // iOS Safari requires resume() inside a user gesture
      Mixer.play();
    });

    btnPause.addEventListener('click', () => {
      Mixer.pause();
    });

    btnStop.addEventListener('click', () => {
      Mixer.stop();
    });

    seekBar.addEventListener('mousedown', () => { isSeeking = true; });
    seekBar.addEventListener('touchstart', () => { isSeeking = true; });

    // Live update time display while dragging, and seek without playing yet
    seekBar.addEventListener('input', () => {
      const time = (seekBar.value / 100) * Mixer.getDuration();
      timeDisplay.textContent = `${formatTime(time)} / ${formatTime(Mixer.getDuration())}`;
      // Seek but don't auto-play during drag
      Mixer.seekTo(time, false);
    });

    // On release, seek and start playing from that point
    seekBar.addEventListener('change', () => {
      const time = (seekBar.value / 100) * Mixer.getDuration();
      Mixer.seekTo(time, true);
      isSeeking = false;
    });
  }

  return { init, enable, disable, updateTimeDisplay };
})();
