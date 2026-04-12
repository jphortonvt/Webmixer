const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { downloadTrack } = require('./b2');

const TMP_DIR = path.join(os.tmpdir(), 'webmixer');

function transcodeFile(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ensure output directory exists
    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    // Skip if already cached
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

    // Skip if already cached
    if (fs.existsSync(outputPath)) {
      results.push(oggName);
      continue;
    }

    // Download WAV from B2 to temp file
    const tmpPath = path.join(TMP_DIR, `${sessionId}_${trackFile}`);

    try {
      console.log(`  Downloading ${sessionId}/${trackFile} from B2...`);
      await downloadTrack(sessionId, trackFile, tmpPath);
      console.log(`  Transcoding ${trackFile}...`);
      await transcodeFile(tmpPath, outputPath);
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
