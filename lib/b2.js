const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const FOLDER_PATTERN = /^\d{6}_\d{6}$/;
const TRACK_PATTERN = /^TRACK\d+\.WAV$/i;

let s3 = null;
let bucketName = null;

function getClient() {
  if (!s3) {
    if (!process.env.B2_ENDPOINT || !process.env.B2_KEY_ID || !process.env.B2_APP_KEY || !process.env.B2_BUCKET_NAME) {
      throw new Error('B2 credentials not configured. Set B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME in .env');
    }
    s3 = new S3Client({
      endpoint: process.env.B2_ENDPOINT,
      region: 'auto',
      credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APP_KEY,
      },
      forcePathStyle: true,
    });
    bucketName = process.env.B2_BUCKET_NAME;
  }
  return { s3, bucketName };
}

/**
 * List all session folders in the B2 bucket.
 * Returns array of { id, trackCount }
 */
async function listSessions() {
  const { s3, bucketName } = getClient();

  // Get all top-level "folders" using delimiter
  const listCmd = new ListObjectsV2Command({
    Bucket: bucketName,
    Delimiter: '/',
  });

  const response = await s3.send(listCmd);
  const prefixes = (response.CommonPrefixes || [])
    .map(p => p.Prefix.replace(/\/$/, ''))
    .filter(name => FOLDER_PATTERN.test(name));

  // Count tracks in each session
  const sessions = await Promise.all(prefixes.map(async (sessionId) => {
    const tracks = await listSessionTracks(sessionId);
    return { id: sessionId, trackCount: tracks.length };
  }));

  // Filter out empty sessions
  return sessions.filter(s => s.trackCount > 0);
}

/**
 * List WAV track files for a specific session.
 * Returns sorted array of filenames like ['TRACK01.WAV', 'TRACK02.WAV', ...]
 */
async function listSessionTracks(sessionId) {
  const { s3, bucketName } = getClient();

  const listCmd = new ListObjectsV2Command({
    Bucket: bucketName,
    Prefix: `${sessionId}/`,
  });

  const response = await s3.send(listCmd);
  const files = (response.Contents || [])
    .map(obj => path.basename(obj.Key))
    .filter(name => TRACK_PATTERN.test(name))
    .sort();

  return files;
}

/**
 * Download a track WAV file from B2 to a local path.
 */
async function downloadTrack(sessionId, trackFile, destPath) {
  const { s3, bucketName } = getClient();

  // Ensure destination directory exists
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const getCmd = new GetObjectCommand({
    Bucket: bucketName,
    Key: `${sessionId}/${trackFile}`,
  });

  const response = await s3.send(getCmd);
  const writeStream = fs.createWriteStream(destPath);
  await pipeline(response.Body, writeStream);
}

/**
 * Check if a cached OGG file exists in B2.
 */
async function hasCachedOgg(sessionId, oggName) {
  const { s3, bucketName } = getClient();

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: bucketName,
      Key: `cache/${sessionId}/${oggName}`,
    }));
    return true;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * Download a cached OGG file from B2 to a local path.
 */
async function downloadCachedOgg(sessionId, oggName, destPath) {
  const { s3, bucketName } = getClient();

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const response = await s3.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: `cache/${sessionId}/${oggName}`,
  }));

  const writeStream = fs.createWriteStream(destPath);
  await pipeline(response.Body, writeStream);
}

/**
 * Upload a transcoded OGG file to B2 for persistent caching.
 */
async function uploadCachedOgg(sessionId, oggName, filePath) {
  const { s3, bucketName } = getClient();

  const fileStream = fs.createReadStream(filePath);
  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: `cache/${sessionId}/${oggName}`,
    Body: fileStream,
    ContentType: 'audio/ogg',
  }));
}

module.exports = {
  listSessions,
  listSessionTracks,
  downloadTrack,
  hasCachedOgg,
  downloadCachedOgg,
  uploadCachedOgg,
};
