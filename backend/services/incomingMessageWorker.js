/**
 * BullMQ Worker for incoming webhook messages.
 * Processes ManyChat payloads that were enqueued by the webhook handler.
 *
 * - Concurrency: 10 (handles 10 conversations simultaneously)
 * - Retries: 3 with exponential backoff (5s, 10s, 20s)
 * - Per-lead locking preserved (inside processManyChatPayload)
 */

const logger = require('../src/lib/logger');
const { Worker } = require('bullmq');
const incomingMessageQueue = require('./incomingMessageQueue');

const CONCURRENCY = 10;

let worker = null;

async function processJob(job) {
  const { payload, overrideCompany } = job.data;
  if (!payload) {
    logger.warn('[incoming-message-worker] Job missing payload, skipping:', job.id);
    return;
  }

  const subscriberId = payload.subscriber?.id ?? 'unknown';
  logger.info('[incoming-message-worker] Processing job:', job.id, 'subscriber:', subscriberId, 'attempt:', job.attemptsMade + 1);

  // Import processManyChatPayload lazily to avoid circular deps
  const { processManyChatPayload } = require('../src/api/routes/manychat');
  await processManyChatPayload(payload, overrideCompany ?? null);
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
    logger.error('[incoming-message-worker] error:', err.message);
  });

  worker.on('failed', async (job, err) => {
    logger.error('[incoming-message-worker] job failed:', job?.id, 'attempt:', job?.attemptsMade, 'error:', err?.message);
    // Alert on permanent failure (all retries exhausted)
    if (job && job.attemptsMade >= (job.opts?.attempts || 3)) {
      const { sendAdminAlert } = require('../src/services/adminAlertService');
      sendAdminAlert(
        `dlq:incoming:${job.id}`,
        'Incoming message permanently failed',
        { jobId: job.id, companyId: job.data?.payload?.company_id, error: err?.message, attempts: job.attemptsMade }
      ).catch(() => {});
    }
  });

  worker.on('completed', (job) => {
    logger.info('[incoming-message-worker] job completed:', job?.id);
  });

  logger.info('[incoming-message-worker] started, concurrency=', CONCURRENCY);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[incoming-message-worker] stopped');
  }
}

module.exports = { start, stop };
