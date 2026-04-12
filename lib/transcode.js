const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

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

async function transcodeSession(audioDir, cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);

  const tasks = trackFiles.map(trackFile => {
    const inputPath = path.join(audioDir, sessionId, trackFile);
    const oggName = trackFile.replace(/\.wav$/i, '.ogg');
    const outputPath = path.join(sessionCacheDir, oggName);
    return transcodeFile(inputPath, outputPath).then(() => oggName);
  });

  return Promise.all(tasks);
}

function isSessionCached(cacheDir, sessionId, trackFiles) {
  const sessionCacheDir = path.join(cacheDir, sessionId);
  return trackFiles.every(f => {
    const oggName = f.replace(/\.wav$/i, '.ogg');
    return fs.existsSync(path.join(sessionCacheDir, oggName));
  });
}

module.exports = { transcodeSession, isSessionCached };
