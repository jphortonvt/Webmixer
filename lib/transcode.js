const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { downloadTrack, hasCachedOgg, downloadCachedOgg, uploadCachedOgg } = require('./b2');

const TMP_DIR = path.join(os.tmpdir(), 'webmixer');

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

  for (const trackFile of trackFiles) {
    const mp3Name = trackFile.replace(/\.wav$/i, '.mp3');
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

    // 3. No cached MP3 — download WAV, transcode, upload MP3 to B2
    const tmpPath = path.join(TMP_DIR, `${sessionId}_${trackFile}`);

    try {
      console.log(`  Downloading ${sessionId}/${trackFile} from B2...`);
      await downloadTrack(sessionId, trackFile, tmpPath);
      console.log(`  Transcoding ${trackFile} to M4A...`);
      await transcodeFile(tmpPath, outputPath);

      try {
        console.log(`  Uploading ${mp3Name} to B2 cache...`);
        await uploadCachedOgg(sessionId, mp3Name, outputPath);
      } catch (uploadErr) {
        console.warn(`  Warning: Failed to upload MP3 to B2 cache:`, uploadErr.message);
      }
    } finally {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }

    results.push(mp3Name);
  }

  return results;
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(f => {
    const mp3Name = f.replace(/\.wav$/i, '.mp3');
    return fs.existsSync(path.join(sessionCacheDir, mp3Name));
  });
}

module.exports = { transcodeSession, isSessionCached };
