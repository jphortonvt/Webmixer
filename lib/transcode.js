const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { downloadTrack, hasCachedOgg, downloadCachedOgg, uploadCachedOgg } = require('./b2');

const TMP_DIR = path.join(os.tmpdir(), 'webmixer');

function transcodeFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Skip if already cached locally
    if (fs.existsSync(outputPath)) {
      return resolve(outputPath);
    }

    execFile('ffmpeg', [
      '-i', inputPath,
      '-c:a', 'libopus',
      '-b:a', '128k',
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

  // Process tracks sequentially to limit memory usage on small servers
  for (const trackFile of trackFiles) {
    const oggName = trackFile.replace(/\.wav$/i, '.ogg');
    const outputPath = path.join(sessionCacheDir, oggName);

    // 1. Already cached locally — skip
    if (fs.existsSync(outputPath)) {
      results.push(oggName);
      continue;
    }

    // 2. Check if OGG exists on B2 — just download the small OGG
    try {
      if (await hasCachedOgg(sessionId, oggName)) {
        console.log(`  Downloading cached OGG ${sessionId}/${oggName} from B2...`);
        await downloadCachedOgg(sessionId, oggName, outputPath);
        results.push(oggName);
        continue;
      }
    } catch (err) {
      console.warn(`  Warning: B2 OGG cache check failed for ${oggName}:`, err.message);
    }

    // 3. No cached OGG — download WAV, transcode, upload OGG to B2
    const tmpPath = path.join(TMP_DIR, `${sessionId}_${trackFile}`);

    try {
      console.log(`  Downloading ${sessionId}/${trackFile} from B2...`);
      await downloadTrack(sessionId, trackFile, tmpPath);
      console.log(`  Transcoding ${trackFile}...`);
      await transcodeFile(tmpPath, outputPath);

      // Upload OGG back to B2 for persistent cache
      try {
        console.log(`  Uploading ${oggName} to B2 cache...`);
        await uploadCachedOgg(sessionId, oggName, outputPath);
      } catch (uploadErr) {
        console.warn(`  Warning: Failed to upload OGG to B2 cache:`, uploadErr.message);
        // Non-fatal — local cache still works
      }
    } finally {
      // Clean up temp WAV
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }

    results.push(oggName);
  }

  return results;
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(f => {
    const oggName = f.replace(/\.wav$/i, '.ogg');
    return fs.existsSync(path.join(sessionCacheDir, oggName));
  });
}

module.exports = { transcodeSession, isSessionCached };
