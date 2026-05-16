const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, HeadObjectCommand, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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

  // Get all top-level "folders" using delimiter (with pagination)
  let allPrefixes = [];
  let continuationToken = undefined;

  do {
    const listCmd = new ListObjectsV2Command({
      Bucket: bucketName,
      Delimiter: '/',
      ...(continuationToken && { ContinuationToken: continuationToken }),
    });

    const response = await s3.send(listCmd);
    const prefixes = (response.CommonPrefixes || [])
      .map(p => p.Prefix.replace(/\/$/, ''));
    allPrefixes = allPrefixes.concat(prefixes);
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  const sessionPrefixes = allPrefixes.filter(name => FOLDER_PATTERN.test(name));

  // Count tracks in each session
  const sessions = await Promise.all(sessionPrefixes.map(async (sessionId) => {
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

  let allContents = [];
  let continuationToken = undefined;

  do {
    const listCmd = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: `${sessionId}/`,
      ...(continuationToken && { ContinuationToken: continuationToken }),
    });

    const response = await s3.send(listCmd);
    allContents = allContents.concat(response.Contents || []);
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  const files = allContents
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
    ContentType: 'audio/mpeg',
  }));
}

/**
 * Download any file from B2 by key to a local path.
 */
async function downloadFile(key, destPath) {
  const { s3, bucketName } = getClient();

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const response = await s3.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  }));

  const writeStream = fs.createWriteStream(destPath);
  await pipeline(response.Body, writeStream);
}

/**
 * Upload a file buffer to B2 with the given key.
 */
async function uploadFile(key, buffer, contentType) {
  const { s3, bucketName } = getClient();

  await s3.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
}

/**
 * Generate a pre-signed PUT URL for direct browser-to-B2 upload.
 */
async function getUploadUrl(key, contentType) {
  const { s3, bucketName } = getClient();
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });
  return await getSignedUrl(s3, command, { expiresIn: 3600 });
}

/**
 * Configure CORS on the B2 bucket to allow direct browser uploads.
 */
async function configureCors(allowedOrigins) {
  const { s3, bucketName } = getClient();
  try {
    await s3.send(new PutBucketCorsCommand({
      Bucket: bucketName,
      CORSConfiguration: {
        CORSRules: [{
          AllowedHeaders: ['*'],
          AllowedMethods: ['PUT', 'GET', 'HEAD'],
          AllowedOrigins: allowedOrigins || ['*'],
          MaxAgeSeconds: 3600,
        }],
      },
    }));
    console.log('[B2] CORS configured for direct uploads');
  } catch (err) {
    console.warn('[B2] Could not set CORS (uploads may fail from browser):', err.message);
  }
}

module.exports = {
  listSessions,
  listSessionTracks,
  downloadTrack,
  downloadFile,
  hasCachedOgg,
  downloadCachedOgg,
  uploadCachedOgg,
  uploadFile,
  getUploadUrl,
  configureCors,
};
