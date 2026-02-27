/**
 * AES-256-GCM encryption for sensitive data at rest (API keys, tokens).
 * Requires ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 *
 * Usage:
 *   const { encrypt, decrypt, isConfigured } = require('./encryption');
 *   if (isConfigured()) {
 *     const encrypted = encrypt(plaintext);
 *     const decrypted = decrypt(encrypted);
 *   }
 */
const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

function isConfigured() {
  return getKey() !== null;
}

function encrypt(plaintext) {
  const key = getKey();
  if (!key) {
    logger.warn('ENCRYPTION_KEY not configured, storing plaintext');
    return plaintext;
  }
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  // Not encrypted (no enc: prefix)
  if (!ciphertext.startsWith('enc:')) return ciphertext;

  const key = getKey();
  if (!key) {
    logger.warn('ENCRYPTION_KEY not configured, cannot decrypt');
    return ciphertext;
  }

  const parts = ciphertext.slice(4).split(':');
  if (parts.length !== 3) {
    logger.warn('Invalid encrypted format');
    return ciphertext;
  }

  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt, isConfigured };
