/**
 * Redis Pub/Sub event bus for real-time SSE delivery.
 * Publishes company-scoped events; SSE endpoint subscribes per-company.
 */
const IORedis = require('ioredis');
const logger = require('./logger');

let pubClient = null;
const subClients = new Map(); // companyId → { client, listeners }

function getPubClient() {
  if (pubClient) return pubClient;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  pubClient = new IORedis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  pubClient.on('error', (err) => {
    logger.error({ err }, '[eventBus] Pub client error');
  });
  pubClient.connect().catch((err) => {
    logger.error({ err }, '[eventBus] Pub client connection failed');
  });
  return pubClient;
}

/**
 * Publish an event to a company channel.
 * @param {string} companyId
 * @param {{ type: string, [key: string]: any }} event
 */
async function publish(companyId, event) {
  const client = getPubClient();
  if (!client) return;
  const channel = `events:${companyId}`;
  const payload = JSON.stringify({ ...event, timestamp: event.timestamp || new Date().toISOString() });
  try {
    await client.publish(channel, payload);
  } catch (err) {
    logger.warn({ err: err.message, companyId }, '[eventBus] Publish failed');
  }
}

/**
 * Subscribe to a company's event channel.
 * Returns a subscriber object with an unsubscribe method.
 * @param {string} companyId
 * @param {(event: object) => void} callback
 * @returns {{ unsubscribe: () => void }}
 */
function subscribe(companyId, callback) {
  const url = process.env.REDIS_URL;
  if (!url) return { unsubscribe: () => {} };

  const channel = `events:${companyId}`;

  // Each SSE connection gets its own Redis subscriber client
  // (Redis requires dedicated connections for subscriptions)
  const subClient = new IORedis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  subClient.on('error', (err) => {
    logger.warn({ err: err.message }, '[eventBus] Sub client error');
  });

  const messageHandler = (ch, message) => {
    if (ch !== channel) return;
    try {
      const event = JSON.parse(message);
      callback(event);
    } catch (err) {
      logger.warn({ err: err.message }, '[eventBus] Failed to parse event');
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

  return {
    unsubscribe: () => {
      subClient.unsubscribe(channel).catch(() => {});
      subClient.removeListener('message', messageHandler);
      subClient.disconnect().catch(() => {});
    },
  };
}

module.exports = { publish, subscribe };
