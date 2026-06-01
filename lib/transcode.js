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

async function mapConcurrent(array, limit, fn) {
  const results = [];
  const promises = [];
  let index = 0;

  async function worker() {
    while (index < array.length) {
      const curIndex = index++;
      const item = array[curIndex];
      results[curIndex] = await fn(item);
    }
  }

  for (let i = 0; i < Math.min(limit, array.length); i++) {
    promises.push(worker());
  }

  await Promise.all(promises);
  return results;
}

async function transcodeSession(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  const errors = [];
  const CONCURRENCY_LIMIT = 4;

  await mapConcurrent(trackFiles, CONCURRENCY_LIMIT, async (trackFile) => {
    const mp3Name = trackFile.replace(/\.wav$/i, '.mp3');
    const outputPath = path.join(sessionCacheDir, mp3Name);

    // 1. Already cached locally — skip
    if (fs.existsSync(outputPath)) {
      return mp3Name;
    }

    // 2. Check if MP3 exists on B2 — just download it
    try {
      if (await hasCachedOgg(sessionId, mp3Name)) {
        console.log(`  Downloading cached MP3 ${sessionId}/${mp3Name} from B2...`);
        await downloadCachedOgg(sessionId, mp3Name, outputPath);
        return mp3Name;
      }
    } catch (err) {
      console.warn(`  Warning: B2 MP3 cache check failed for ${mp3Name}:`, err.message);
    }

    // 3. No cached MP3 — download WAV, transcode, upload MP3 to B2
    const tmpPath = path.join(TMP_DIR, `${sessionId}_${trackFile}`);

    try {
      console.log(`  Downloading ${sessionId}/${trackFile} from B2...`);
      await downloadTrack(sessionId, trackFile, tmpPath);
      console.log(`  Transcoding ${trackFile} to MP3...`);
      await transcodeFile(tmpPath, outputPath);

      try {
        console.log(`  Uploading ${mp3Name} to B2 cache...`);
        await uploadCachedOgg(sessionId, mp3Name, outputPath);
      } catch (uploadErr) {
        console.warn(`  Warning: Failed to upload MP3 to B2 cache for ${mp3Name}:`, uploadErr.message);
      }
    } catch (err) {
      console.error(`  Error: Failed to process/transcode track ${trackFile}:`, err.message);
      errors.push({ trackFile, error: err });
    } finally {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch (unlinkErr) {
          console.warn(`  Warning: Failed to delete temp file ${tmpPath}:`, unlinkErr.message);
        }
      }
    }

    return mp3Name;
  });

  if (errors.length > 0) {
    throw new Error(`Session transcoding completed with ${errors.length} error(s):\n` +
      errors.map(e => `  - ${e.trackFile}: ${e.error.message}`).join('\n')
    );
  }

  return trackFiles.map(f => f.replace(/\.wav$/i, '.mp3'));
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(f => {
    const mp3Name = f.replace(/\.wav$/i, '.mp3');
    return fs.existsSync(path.join(sessionCacheDir, mp3Name));
  });
}

module.exports = { transcodeSession, isSessionCached };
