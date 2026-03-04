/**
 * Event bus for real-time SSE delivery.
 * Uses Redis Pub/Sub when REDIS_URL is set; falls back to in-memory EventEmitter.
 *
 * IMPORTANT: Uses a SINGLE shared subscriber client (not one per SSE connection)
 * to prevent Redis connection leaks and OOM crashes.
 */
const { EventEmitter } = require('events');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// In-memory fallback (works when Redis is unavailable — single process only)
// ---------------------------------------------------------------------------
const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(500);

// ---------------------------------------------------------------------------
// Redis Pub/Sub — single pub + single sub client, shared across all subscribers
// ---------------------------------------------------------------------------
let pubClient = null;
let subClient = null;
let redisAvailable = false;
let subConnected = false;

// Track per-channel callbacks so one shared sub client can dispatch to many listeners
const channelListeners = new Map(); // channel -> Set<callback>

function initPubClient() {
  if (pubClient) return pubClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const IORedis = require('ioredis');
    pubClient = new IORedis(url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    pubClient.on('error', (err) => {
      logger.error({ err: err.message }, '[eventBus] Pub client error');
    });
    pubClient.on('connect', () => { redisAvailable = true; });
    pubClient.on('close', () => { redisAvailable = false; });
    pubClient.connect().catch((err) => {
      logger.error({ err: err.message }, '[eventBus] Pub client connection failed');
      pubClient = null;
      redisAvailable = false;
    });
    return pubClient;
  } catch (err) {
    logger.warn({ err: err.message }, '[eventBus] Could not create Redis pub client');
    return null;
  }
}

function initSubClient() {
  if (subClient) return subClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const IORedis = require('ioredis');
    subClient = new IORedis(url, {
      maxRetriesPerRequest: null, // subscriber clients must not limit retries
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    subClient.on('error', (err) => {
      logger.error({ err: err.message }, '[eventBus] Sub client error');
    });
    subClient.on('connect', () => { subConnected = true; });
    subClient.on('close', () => { subConnected = false; });

    // Single global message handler dispatches to per-channel listeners
    subClient.on('message', (ch, message) => {
      const listeners = channelListeners.get(ch);
      if (!listeners || listeners.size === 0) return;
      let event;
      try {
        event = JSON.parse(message);
      } catch (err) {
        logger.warn({ err: err.message }, '[eventBus] Failed to parse Redis event');
        return;
      }
      for (const cb of listeners) {
        try { cb(event); } catch (e) {
          logger.warn({ err: e.message }, '[eventBus] Listener callback error');
        }
      }
    });

    subClient.connect().then(() => {
      // Re-subscribe to any channels that were registered before connection completed
      for (const channel of channelListeners.keys()) {
        subClient.subscribe(channel).catch(() => {});
      }
    }).catch((err) => {
      logger.error({ err: err.message }, '[eventBus] Sub client connection failed');
      subClient = null;
      subConnected = false;
    });
    return subClient;
  } catch (err) {
    logger.warn({ err: err.message }, '[eventBus] Could not create Redis sub client');
    return null;
  }
}

// Initialize eagerly
initPubClient();
initSubClient();

/**
 * Publish an event to a company channel.
 */
async function publish(companyId, event) {
  const payload = { ...event, timestamp: event.timestamp || new Date().toISOString() };
  const channel = `events:${companyId}`;

  const client = pubClient || initPubClient();
  if (client && redisAvailable) {
    try {
      await client.publish(channel, JSON.stringify(payload));
      return;
    } catch (err) {
      logger.warn({ err: err.message, companyId }, '[eventBus] Redis publish failed, using local fallback');
    }
  }

  localEmitter.emit(channel, payload);
}

/**
 * Subscribe to a company's event channel.
 * Returns a subscriber object with an unsubscribe method.
 */
function subscribe(companyId, callback) {
  const channel = `events:${companyId}`;

  // Always subscribe to in-memory emitter as fallback
  localEmitter.on(channel, callback);

  // Subscribe via shared Redis sub client (no new connection per subscriber)
  const sub = subClient || initSubClient();
  if (sub) {
    if (!channelListeners.has(channel)) {
      channelListeners.set(channel, new Set());
      // Only subscribe on Redis if this is the first listener for this channel
      if (subConnected) {
        sub.subscribe(channel).catch((err) => {
          logger.warn({ err: err.message }, '[eventBus] Redis subscribe failed');
        });
      }
    }
    channelListeners.get(channel).add(callback);
  }

  return {
    unsubscribe: () => {
      localEmitter.removeListener(channel, callback);
      const listeners = channelListeners.get(channel);
      if (listeners) {
        listeners.delete(callback);
        // If no more listeners for this channel, unsubscribe from Redis
        if (listeners.size === 0) {
          channelListeners.delete(channel);
          if (sub && subConnected) {
            sub.unsubscribe(channel).catch(() => {});
          }
        }
      }
    },
  };
}

module.exports = { publish, subscribe };
