/**
 * Event bus for real-time SSE delivery.
 * Uses Redis Pub/Sub when REDIS_URL is set; falls back to in-memory EventEmitter.
 */
const { EventEmitter } = require('events');
const logger = require('./logger');

// ---------------------------------------------------------------------------
// In-memory fallback (works when Redis is unavailable — single process only)
// ---------------------------------------------------------------------------
const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(500); // Allow many concurrent SSE connections

// ---------------------------------------------------------------------------
// Redis Pub/Sub (preferred — works across multiple processes/containers)
// ---------------------------------------------------------------------------
let pubClient = null;
let redisAvailable = false;

function getPubClient() {
  if (pubClient) return pubClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const IORedis = require('ioredis');
    pubClient = new IORedis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
    pubClient.on('error', (err) => {
      logger.error({ err }, '[eventBus] Pub client error');
    });
    pubClient.connect()
      .then(() => { redisAvailable = true; })
      .catch((err) => {
        logger.error({ err }, '[eventBus] Pub client connection failed');
        pubClient = null;
      });
    return pubClient;
  } catch (err) {
    logger.warn({ err: err.message }, '[eventBus] Could not create Redis pub client');
    return null;
  }
}

// Try to initialize pub client eagerly
getPubClient();

/**
 * Publish an event to a company channel.
 */
async function publish(companyId, event) {
  const payload = { ...event, timestamp: event.timestamp || new Date().toISOString() };
  const channel = `events:${companyId}`;

  // Try Redis first
  const client = getPubClient();
  if (client && redisAvailable) {
    try {
      await client.publish(channel, JSON.stringify(payload));
      return; // Redis handled it — subscribers will receive via Redis
    } catch (err) {
      logger.warn({ err: err.message, companyId }, '[eventBus] Redis publish failed, using local fallback');
    }
  }

  // Fallback: in-memory delivery (same process only)
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

  // Also subscribe to Redis if available
  let subClient = null;
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const IORedis = require('ioredis');
      subClient = new IORedis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
      subClient.on('error', (err) => {
        logger.warn({ err: err.message }, '[eventBus] Sub client error');
      });

      const messageHandler = (ch, message) => {
        if (ch !== channel) return;
        try {
          const event = JSON.parse(message);
          callback(event);
        } catch (err) {
          logger.warn({ err: err.message }, '[eventBus] Failed to parse Redis event');
        }
      };

      subClient.connect()
        .then(() => {
          subClient.subscribe(channel);
          subClient.on('message', messageHandler);
        })
        .catch((err) => {
          logger.error({ err }, '[eventBus] Sub client connection failed');
        });
    } catch (err) {
      logger.warn({ err: err.message }, '[eventBus] Could not create Redis sub client');
    }
  }

  return {
    unsubscribe: () => {
      localEmitter.removeListener(channel, callback);
      if (subClient) {
        subClient.unsubscribe(channel).catch(() => {});
        subClient.disconnect().catch(() => {});
      }
    },
  };
}

module.exports = { publish, subscribe };
