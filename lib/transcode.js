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
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
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
    const m4aName = trackFile.replace(/\.wav$/i, '.m4a');
    const outputPath = path.join(sessionCacheDir, m4aName);

    // 1. Already cached locally — skip
    if (fs.existsSync(outputPath)) {
      results.push(m4aName);
      continue;
    }

    // 2. Check if M4A exists in B2 cache — just download it
    try {
      if (await hasCachedOgg(sessionId, m4aName)) {
        console.log(`  Downloading cached M4A ${sessionId}/${m4aName} from B2...`);
        await downloadCachedOgg(sessionId, m4aName, outputPath);
        results.push(m4aName);
        continue;
      }
    } catch (err) {
      console.warn(`  Warning: B2 cache check failed for ${m4aName}:`, err.message);
    }

    // 3. No cached M4A — download WAV, transcode, upload M4A to B2
    const tmpPath = path.join(TMP_DIR, `${sessionId}_${trackFile}`);

    try {
      console.log(`  Downloading ${sessionId}/${trackFile} from B2...`);
      await downloadTrack(sessionId, trackFile, tmpPath);
      console.log(`  Transcoding ${trackFile} to M4A...`);
      await transcodeFile(tmpPath, outputPath);

      // Upload M4A back to B2 for persistent cache
      try {
        console.log(`  Uploading ${m4aName} to B2 cache...`);
        await uploadCachedOgg(sessionId, m4aName, outputPath);
      } catch (uploadErr) {
        console.warn(`  Warning: Failed to upload M4A to B2 cache:`, uploadErr.message);
        // Non-fatal — local cache still works
      }
    } finally {
      // Clean up temp WAV
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    }

    results.push(m4aName);
  }

  return results;
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(f => {
    const m4aName = f.replace(/\.wav$/i, '.m4a');
    return fs.existsSync(path.join(sessionCacheDir, m4aName));
  });
}

module.exports = { transcodeSession, isSessionCached };
