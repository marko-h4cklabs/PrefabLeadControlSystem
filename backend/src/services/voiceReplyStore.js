/**
 * Redis-backed store for pending voice reply audio URLs.
 * When TTS audio is generated, the URL is stored keyed by ManyChat subscriber_id.
 * When ManyChat's External Request calls our endpoint, we look it up and return it.
 * Entries expire after 5 minutes (Redis TTL, no manual cleanup needed).
 */

const { setWithTTL, getKey } = require('../lib/redis');
const logger = require('../lib/logger');

const TTL_SECONDS = 300; // 5 minutes
const KEY_PREFIX = 'voice:reply:';

async function set(subscriberId, audioUrl) {
  try {
    await setWithTTL(`${KEY_PREFIX}${subscriberId}`, audioUrl, TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, subscriberId }, 'voiceReplyStore.set failed (Redis), using fallback');
    // Fallback to in-memory if Redis unavailable
    fallbackStore.set(String(subscriberId), { audioUrl, createdAt: Date.now() });
  }
}

async function get(subscriberId) {
  try {
    const val = await getKey(`${KEY_PREFIX}${subscriberId}`);
    if (val) return val;
  } catch (err) {
    logger.warn({ err, subscriberId }, 'voiceReplyStore.get failed (Redis), using fallback');
  }
  // Fallback check
  const entry = fallbackStore.get(String(subscriberId));
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_SECONDS * 1000) {
    fallbackStore.delete(String(subscriberId));
    return null;
  }
  return entry.audioUrl;
}

async function remove(subscriberId) {
  try {
    const redis = require('../lib/redis').getRedisClient();
    if (redis) await redis.del(`${KEY_PREFIX}${subscriberId}`);
  } catch (_) {}
  fallbackStore.delete(String(subscriberId));
}

// In-memory fallback for when Redis is unavailable
const fallbackStore = new Map();

module.exports = { set, get, remove };
