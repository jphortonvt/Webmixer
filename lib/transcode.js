const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { downloadTrack, hasCachedOgg, downloadCachedOgg, uploadCachedOgg } = require('./b2');

const TMP_DIR = path.join(os.tmpdir(), 'webmixer');

function mergeStereoFiles(leftPath, rightPath, outputPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    execFile('ffmpeg', [
      '-i', leftPath,
      '-i', rightPath,
      '-filter_complex', '[0:a][1:a]amerge=inputs=2[aout]',
      '-map', '[aout]',
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-y',
      outputPath
    ], (err, stdout, stderr) => {
      if (err) reject(new Error(`ffmpeg merge error: ${err.message}\n${stderr}`));
      else resolve(outputPath);
    });
  });
}

function transcodeFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    if (fs.existsSync(outputPath)) {
      return resolve(outputPath);
    }

    execFile('ffmpeg', [
      '-i', inputPath,
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-y',
      outputPath
    ], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg error: ${err.message}\n${stderr}`));
      } else {
        resolve(outputPath);
      }
    });
  });
}

async function transcodeSession(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  const results = [];

  for (const track of trackFiles) {
    const mp3Name = track.name.replace(/\.wav$/i, '.mp3');
    const outputPath = path.join(sessionCacheDir, mp3Name);

    // 1. Already cached locally — skip
    if (fs.existsSync(outputPath)) {
      results.push(mp3Name);
      continue;
    }

    // 2. Check if MP3 exists on B2 — just download it
    try {
      if (await hasCachedOgg(sessionId, mp3Name)) {
        console.log(`  Downloading cached MP3 ${sessionId}/${mp3Name} from B2...`);
        await downloadCachedOgg(sessionId, mp3Name, outputPath);
        results.push(mp3Name);
        continue;
      }
    } catch (err) {
      console.warn(`  Warning: B2 MP3 cache check failed for ${mp3Name}:`, err.message);
    }

    // 3. No cached MP3 — download WAV(s), transcode, upload MP3 to B2
    if (track.type === 'stereo_pair') {
      const tmpL = path.join(TMP_DIR, `${sessionId}_${track.left}`);
      const tmpR = path.join(TMP_DIR, `${sessionId}_${track.right}`);
      try {
        console.log(`  Downloading stereo pair ${track.left} + ${track.right}...`);
        await Promise.all([
          downloadTrack(sessionId, track.left, tmpL),
          downloadTrack(sessionId, track.right, tmpR),
        ]);
        console.log(`  Merging stereo pair → ${mp3Name}...`);
        await mergeStereoFiles(tmpL, tmpR, outputPath);
        try {
          console.log(`  Uploading ${mp3Name} to B2 cache...`);
          await uploadCachedOgg(sessionId, mp3Name, outputPath);
        } catch (uploadErr) {
          console.warn(`  Warning: Failed to upload MP3 to B2 cache:`, uploadErr.message);
        }
      } finally {
        if (fs.existsSync(tmpL)) fs.unlinkSync(tmpL);
        if (fs.existsSync(tmpR)) fs.unlinkSync(tmpR);
      }
    } else {
      const tmpPath = path.join(TMP_DIR, `${sessionId}_${track.name}`);
      try {
        console.log(`  Downloading ${sessionId}/${track.name} from B2...`);
        await downloadTrack(sessionId, track.name, tmpPath);
        console.log(`  Transcoding ${track.name} to MP3...`);
        await transcodeFile(tmpPath, outputPath);
        try {
          console.log(`  Uploading ${mp3Name} to B2 cache...`);
          await uploadCachedOgg(sessionId, mp3Name, outputPath);
        } catch (uploadErr) {
          console.warn(`  Warning: Failed to upload MP3 to B2 cache:`, uploadErr.message);
        }
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    }

    results.push(mp3Name);
  }

  return results;
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(track => {
    const mp3Name = track.name.replace(/\.wav$/i, '.mp3');
    return fs.existsSync(path.join(sessionCacheDir, mp3Name));
  });
}

// --- Mixdown ---------------------------------------------------------------

function probeChannels(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=channels',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], (err, stdout) => {
      if (err) return resolve(2); // assume stereo; the pan maths still works
      const n = parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(n) && n > 0 ? n : 2);
    });
  });
}

function probeDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], (err, stdout) => {
      if (err) return resolve(NaN);
      resolve(parseFloat(String(stdout).trim()));
    });
  });
}

/**
 * Pan coefficients matching the Web Audio StereoPannerNode algorithm, so a
 * rendered mixdown pans the same way the browser does. Mono and stereo sources
 * use different formulas in that spec — this is the part worth getting right.
 * `pan` is -1 (hard left) to 1 (hard right).
 */
function panFilter(pan, channels) {
  const q = Math.PI / 2;
  const f = (n) => n.toFixed(6);

  if (channels === 1) {
    const x = (pan + 1) / 2;
    return `pan=stereo|c0=${f(Math.cos(x * q))}*c0|c1=${f(Math.sin(x * q))}*c0`;
  }

  if (pan <= 0) {
    const x = pan + 1;
    // outL = inL + inR*cos(x); outR = inR*sin(x)
    return `pan=stereo|c0=c0+${f(Math.cos(x * q))}*c1|c1=${f(Math.sin(x * q))}*c1`;
  }
  const x = pan;
  // outL = inL*cos(x); outR = inR + inL*sin(x)
  return `pan=stereo|c0=${f(Math.cos(x * q))}*c0|c1=c1+${f(Math.sin(x * q))}*c0`;
}

/**
 * Render a stereo mixdown of a session from its already-cached per-track MP3s,
 * honouring the mix settings the browser produced (UI.getSettings()).
 *
 * settings entries: { volume: 0-150, pan: -100..100, muted, solo, boost }
 * options: { format: 'mp3'|'wav', startSeconds, endSeconds }
 */
async function renderMixdown(cacheDir, sessionId, trackFiles, settings, options = {}) {
  const { format = 'mp3', startSeconds, endSeconds, onProgress } = options;
  const sessionCacheDir = path.join(cacheDir, sessionId);

  // Solo wins over mute, matching the mixer: any solo means only solos play.
  const anySolo = settings.some(s => s && s.solo);
  const chosen = [];

  trackFiles.forEach((track, i) => {
    const s = settings[i] || {};
    const include = anySolo ? !!s.solo : !s.muted;
    if (!include) return;

    const file = path.join(sessionCacheDir, track.name.replace(/\.wav$/i, '.mp3'));
    if (!fs.existsSync(file)) {
      console.warn(`[MIXDOWN] Skipping ${track.name} — not cached`);
      return;
    }
    const volume = ((s.volume ?? 100) / 100) * (s.boost ?? 1);
    chosen.push({ file, volume, pan: (s.pan ?? 0) / 100, name: track.name });
  });

  if (chosen.length === 0) {
    throw new Error('No audible tracks to mix down — every track is muted or uncached');
  }

  const channelCounts = await Promise.all(chosen.map(c => probeChannels(c.file)));

  const hasStart = Number.isFinite(startSeconds) && startSeconds > 0;
  const hasEnd = Number.isFinite(endSeconds) && endSeconds > 0;

  const chains = chosen.map((c, i) => {
    const steps = [];
    if (hasStart || hasEnd) {
      const parts = [];
      if (hasStart) parts.push(`start=${startSeconds}`);
      if (hasEnd) parts.push(`end=${endSeconds}`);
      // trim before mixing so every track is cut at the same point
      steps.push('atrim=' + parts.join(':'), 'asetpts=PTS-STARTPTS');
    }
    steps.push(`volume=${c.volume.toFixed(6)}`);
    steps.push(panFilter(c.pan, channelCounts[i]));
    return `[${i}:a]${steps.join(',')}[a${i}]`;
  });

  // normalize=0 keeps the summed level the mixer produces; amix would
  // otherwise divide by the input count and render everything quiet.
  const mixInputs = chosen.map((_, i) => `[a${i}]`).join('');
  const filterGraph =
    chains.join(';') + ';' +
    `${mixInputs}amix=inputs=${chosen.length}:duration=longest:normalize=0[out]`;

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const ext = format === 'wav' ? 'wav' : 'mp3';
  const outputPath = path.join(TMP_DIR, `mixdown_${sessionId}_${Date.now()}.${ext}`);

  // How long the output will be, so ffmpeg's progress can be a percentage
  let totalSeconds = null;
  if (hasStart || hasEnd) {
    if (hasEnd) totalSeconds = endSeconds - (hasStart ? startSeconds : 0);
  } else {
    const durations = await Promise.all(chosen.map(c => probeDuration(c.file)));
    const longest = Math.max(...durations.filter(Number.isFinite), 0);
    if (longest > 0) totalSeconds = longest;
  }

  const args = ['-hide_banner', '-loglevel', 'error'];
  for (const c of chosen) args.push('-i', c.file);
  args.push('-filter_complex', filterGraph, '-map', '[out]');
  if (ext === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', '192k');
  }
  // machine-readable progress on stdout, so it can be reported live
  args.push('-progress', 'pipe:1', '-nostats', '-y', outputPath);

  console.log(`[MIXDOWN] ${sessionId}: mixing ${chosen.length} track(s) -> ${ext}`);

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    let buffered = '';

    proc.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const micros = parseInt(value, 10);
        if (!Number.isFinite(micros) || !totalSeconds || !onProgress) continue;
        // ffmpeg reports microseconds under both key spellings
        const done = micros / 1e6;
        onProgress(Math.max(0, Math.min(99, Math.round((done / totalSeconds) * 100))));
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', (err) => reject(new Error(`ffmpeg mixdown failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mixdown failed (exit ${code})\n${stderr}`));
    });
  });

  if (onProgress) onProgress(100);
  return { outputPath, trackCount: chosen.length, format: ext };
}

module.exports = { transcodeSession, isSessionCached, renderMixdown };
