// Channel strip UI generation and wiring
const UI = (() => {
  const mixerEl = document.getElementById('mixer');

  function clearMixer() {
    mixerEl.innerHTML = '';
  }

  function createChannelStrip(index, trackName) {
    const strip = document.createElement('div');
    strip.className = 'channel-strip';

    // Extract track number from filename
    const numMatch = trackName.match(/(\d+)/);
    const trackNum = numMatch ? numMatch[1] : index + 1;

    strip.innerHTML = `
      <div class="track-number">${trackNum}</div>
      <div class="track-name">${trackName}</div>
      <div class="channel-buttons">
        <button class="btn-mute" data-index="${index}">M</button>
        <button class="btn-solo" data-index="${index}">S</button>
      </div>
      <div class="volume-container">
        <label>Vol</label>
        <input type="range" class="volume-slider" data-index="${index}"
               min="0" max="150" value="100" orient="vertical">
        <span class="volume-value">100%</span>
      </div>
      <div class="pan-container">
        <label>Pan</label>
        <input type="range" class="pan-slider" data-index="${index}"
               min="-100" max="100" value="0">
        <span class="pan-value">C</span>
      </div>
    `;

    // Volume slider
    const volSlider = strip.querySelector('.volume-slider');
    const volValue = strip.querySelector('.volume-value');
    volSlider.addEventListener('input', () => {
      const val = parseInt(volSlider.value);
      Mixer.setVolume(index, val / 100);
      volValue.textContent = `${val}%`;
    });

    // Pan slider
    const panSlider = strip.querySelector('.pan-slider');
    const panValue = strip.querySelector('.pan-value');
    panSlider.addEventListener('input', () => {
      const val = parseInt(panSlider.value);
      Mixer.setPan(index, val / 100);
      if (val === 0) {
        panValue.textContent = 'C';
      } else if (val < 0) {
        panValue.textContent = `L${Math.abs(val)}`;
      } else {
        panValue.textContent = `R${val}`;
      }
    });

    // Mute button
    const muteBtn = strip.querySelector('.btn-mute');
    let muted = false;
    let premuteVol = 100;
    muteBtn.addEventListener('click', () => {
      muted = !muted;
      muteBtn.classList.toggle('active', muted);
      if (muted) {
        premuteVol = parseInt(volSlider.value);
        Mixer.setVolume(index, 0);
      } else {
        Mixer.setVolume(index, premuteVol / 100);
      }
    });

    // Solo button
    const soloBtn = strip.querySelector('.btn-solo');
    soloBtn.addEventListener('click', () => {
      soloBtn.classList.toggle('active');
      applySolo();
    });

    return strip;
  }

  function applySolo() {
    const soloButtons = mixerEl.querySelectorAll('.btn-solo.active');
    const strips = mixerEl.querySelectorAll('.channel-strip');

    if (soloButtons.length === 0) {
      // No solo active — unmute everything (respect mute buttons)
      strips.forEach((strip, i) => {
        const muteBtn = strip.querySelector('.btn-mute');
        if (!muteBtn.classList.contains('active')) {
          const vol = parseInt(strip.querySelector('.volume-slider').value);
          Mixer.setVolume(i, vol / 100);
        }
      });
    } else {
      // Solo active — mute non-soloed tracks
      const soloIndices = new Set(
        Array.from(soloButtons).map(b => parseInt(b.dataset.index))
      );
      strips.forEach((strip, i) => {
        if (soloIndices.has(i)) {
          const muteBtn = strip.querySelector('.btn-mute');
          if (!muteBtn.classList.contains('active')) {
            const vol = parseInt(strip.querySelector('.volume-slider').value);
            Mixer.setVolume(i, vol / 100);
          }
        } else {
          Mixer.setVolume(i, 0);
        }
      });
    }
  }

  function renderTracks(trackList) {
    clearMixer();
    trackList.forEach((track, index) => {
      const strip = createChannelStrip(index, track.name);
      mixerEl.appendChild(strip);
    });
  }

  function getSettings() {
    const strips = mixerEl.querySelectorAll('.channel-strip');
    return Array.from(strips).map(strip => ({
      volume: parseInt(strip.querySelector('.volume-slider').value),
      pan: parseInt(strip.querySelector('.pan-slider').value),
      muted: strip.querySelector('.btn-mute').classList.contains('active'),
      solo: strip.querySelector('.btn-solo').classList.contains('active')
    }));
  }

  function applySettings(settings) {
    const strips = mixerEl.querySelectorAll('.channel-strip');
    const count = Math.min(settings.length, strips.length);

    for (let i = 0; i < count; i++) {
      const s = settings[i];
      const strip = strips[i];

      // Volume
      const volSlider = strip.querySelector('.volume-slider');
      const volValue = strip.querySelector('.volume-value');
      volSlider.value = s.volume;
      volValue.textContent = `${s.volume}%`;

      // Pan
      const panSlider = strip.querySelector('.pan-slider');
      const panValue = strip.querySelector('.pan-value');
      panSlider.value = s.pan;
      if (s.pan === 0) {
        panValue.textContent = 'C';
      } else if (s.pan < 0) {
        panValue.textContent = `L${Math.abs(s.pan)}`;
      } else {
        panValue.textContent = `R${s.pan}`;
      }

      // Mute
      const muteBtn = strip.querySelector('.btn-mute');
      muteBtn.classList.toggle('active', s.muted);

      // Solo
      const soloBtn = strip.querySelector('.btn-solo');
      soloBtn.classList.toggle('active', s.solo);

      // Apply to audio engine
      if (s.muted) {
        Mixer.setVolume(i, 0);
      } else {
        Mixer.setVolume(i, s.volume / 100);
      }
      Mixer.setPan(i, s.pan / 100);
    }

    // Re-run solo logic after applying all states
    applySolo();
  }

  return { renderTracks, clearMixer, getSettings, applySettings };
})();
