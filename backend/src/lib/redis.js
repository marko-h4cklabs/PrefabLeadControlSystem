/**
 * Shared Redis client for application state (dedup, locks, delays, cron locks).
 * Uses the same REDIS_URL as BullMQ queues.
 */
const IORedis = require('ioredis');
const logger = require('./logger');

let client = null;
let clientReady = false;

function getRedisClient() {
  if (client) return client;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  client = new IORedis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 500, 5000),
    reconnectOnError: () => true,
  });
  client.on('error', (err) => {
    logger.error({ err: err.message }, 'Redis client error');
  });
  client.on('ready', () => { clientReady = true; });
  client.on('close', () => { clientReady = false; });
  client.on('end', () => {
    clientReady = false;
    client = null; // Allow recreation on next getRedisClient() call
  });
  client.connect().catch((err) => {
    logger.error({ err: err.message }, 'Redis connection failed');
    clientReady = false;
  });
  return client;
}

/** Check if the Redis client is connected and ready for commands. */
function isRedisReady() {
  return client !== null && clientReady;
}

/**
 * Check if a message ID has been processed (Redis SET NX dedup).
 * Returns true if duplicate (already processed), false if new.
 */
async function isMessageProcessed(messageId, ttlSeconds = 3600) {
  const redis = getRedisClient();
  if (!redis) return false; // No Redis = no dedup (fallback)
  const key = `dedup:msg:${messageId}`;
  const result = await redis.set(key, '1', 'NX', 'EX', ttlSeconds);
  return result === null; // null = key already existed = duplicate
}

/**
 * Acquire a distributed lock for a lead. Returns true if lock acquired.
 * Lock auto-expires after ttlSeconds to prevent deadlocks.
 */
async function acquireDistributedLock(lockName, ttlSeconds = 60) {
  const redis = getRedisClient();
  if (!redis) return true; // No Redis = always allow (single instance fallback)
  const key = `lock:${lockName}`;
  const result = await redis.set(key, Date.now().toString(), 'NX', 'EX', ttlSeconds);
  return result !== null;
}

/**
 * Release a distributed lock.
 */
async function releaseDistributedLock(lockName) {
  const redis = getRedisClient();
  if (!redis) return;
  const key = `lock:${lockName}`;
  await redis.del(key);
}

/**
 * Set a delay marker with TTL. Returns readyAt timestamp.
 */
async function setDelay(delayKey, delayMs) {
  const redis = getRedisClient();
  if (!redis) return null;
  const readyAt = Date.now() + delayMs;
  const key = `delay:${delayKey}`;
  await redis.set(key, readyAt.toString(), 'PX', delayMs + 5000);
  return readyAt;
}

/**
 * Check if a delay is active and get its readyAt time.
 */
async function getDelayReadyAt(delayKey) {
  const redis = getRedisClient();
  if (!redis) return null;
  const key = `delay:${delayKey}`;
  const val = await redis.get(key);
  return val ? parseInt(val, 10) : null;
}

/**
 * Clear a delay marker.
 */
async function clearDelay(delayKey) {
  const redis = getRedisClient();
  if (!redis) return;
  const key = `delay:${delayKey}`;
  await redis.del(key);
}

/**
 * Store a value in Redis with TTL.
 */
async function setWithTTL(key, value, ttlSeconds) {
  const redis = getRedisClient();
  if (!redis) return;
  await redis.set(key, typeof value === 'string' ? value : JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Get a value from Redis.
 */
async function getKey(key) {
  const redis = getRedisClient();
  if (!redis) return null;
  return redis.get(key);
}

/**
 * Try to acquire a cron lock (prevents duplicate cron runs across instances).
 */
async function acquireCronLock(cronName, ttlSeconds) {
  return acquireDistributedLock(`cron:${cronName}`, ttlSeconds);
}

async function releaseCronLock(cronName) {
  return releaseDistributedLock(`cron:${cronName}`);
}

module.exports = {
  getRedisClient,
  isRedisReady,
  isMessageProcessed,
  acquireDistributedLock,
  releaseDistributedLock,
  setDelay,
  getDelayReadyAt,
  clearDelay,
  setWithTTL,
  getKey,
  acquireCronLock,
  releaseCronLock,
};
