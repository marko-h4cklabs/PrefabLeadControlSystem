/**
 * Cloudflare R2 (S3-compatible) object storage.
 * Falls back to local disk when R2 is not configured.
 *
 * Env vars: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL
 */
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('./logger');

let client = null;

function isConfigured() {
  return !!(
    process.env.R2_ENDPOINT &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

function getClient() {
  if (client) return client;
  if (!isConfigured()) return null;
  client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

/**
 * Upload a buffer to R2.
 * @param {string} key - Object key (e.g. "social-proof/abc_123_photo.jpg")
 * @param {Buffer} buffer - File contents
 * @param {string} contentType - MIME type
 * @returns {string} Public URL of the uploaded object
 */
async function upload(key, buffer, contentType) {
  const s3 = getClient();
  if (!s3) throw new Error('R2 storage not configured');

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
  return `${publicBase}/${key}`;
}

/**
 * Delete an object from R2.
 * @param {string} key - Object key
 */
async function remove(key) {
  const s3 = getClient();
  if (!s3) return;
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      })
    );
  } catch (err) {
    logger.warn({ err, key }, 'Failed to delete R2 object');
  }
}

module.exports = { isConfigured, upload, remove };
