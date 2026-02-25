/**
 * In-memory store for pending voice reply audio URLs.
 * When TTS audio is generated, the URL is stored keyed by ManyChat subscriber_id.
 * When ManyChat's External Request calls our endpoint, we look it up and return it.
 * Entries expire after 5 minutes.
 */

const TTL_MS = 5 * 60 * 1000;
const store = new Map();

function set(subscriberId, audioUrl) {
  store.set(String(subscriberId), { audioUrl, createdAt: Date.now() });
}

function get(subscriberId) {
  const entry = store.get(String(subscriberId));
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(String(subscriberId));
    return null;
  }
  return entry.audioUrl;
}

function remove(subscriberId) {
  store.delete(String(subscriberId));
}

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.createdAt > TTL_MS) {
      store.delete(key);
    }
  }
}, 60 * 1000);

module.exports = { set, get, remove };
