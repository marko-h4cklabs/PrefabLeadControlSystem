/**
 * BullMQ Worker for incoming webhook messages.
 * Processes ManyChat payloads that were enqueued by the webhook handler.
 *
 * - Concurrency: 10 (handles 10 conversations simultaneously)
 * - Retries: 3 with exponential backoff (5s, 10s, 20s)
 * - Per-lead locking preserved (inside processManyChatPayload)
 */

const { Worker } = require('bullmq');
const incomingMessageQueue = require('./incomingMessageQueue');

const CONCURRENCY = 10;

let worker = null;

async function processJob(job) {
  const { payload } = job.data;
  if (!payload) {
    console.warn('[incoming-message-worker] Job missing payload, skipping:', job.id);
    return;
  }

  const subscriberId = payload.subscriber?.id ?? 'unknown';
  console.log('[incoming-message-worker] Processing job:', job.id, 'subscriber:', subscriberId, 'attempt:', job.attemptsMade + 1);

  // Import processManyChatPayload lazily to avoid circular deps
  const { processManyChatPayload } = require('../src/api/routes/manychat');
  await processManyChatPayload(payload);
}

function start() {
  if (worker) return;
  const connection = incomingMessageQueue.getConnection();
  worker = new Worker(
    incomingMessageQueue.QUEUE_NAME,
    async (job) => {
      await processJob(job);
    },
    {
      connection,
      concurrency: CONCURRENCY,
    }
  );

  worker.on('error', (err) => {
    console.error('[incoming-message-worker] error:', err.message);
  });

  worker.on('failed', (job, err) => {
    console.error('[incoming-message-worker] job failed:', job?.id, 'attempt:', job?.attemptsMade, 'error:', err?.message);
  });

  worker.on('completed', (job) => {
    console.log('[incoming-message-worker] job completed:', job?.id);
  });

  console.info('[incoming-message-worker] started, concurrency=', CONCURRENCY);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    console.info('[incoming-message-worker] stopped');
  }
}

module.exports = { start, stop };
