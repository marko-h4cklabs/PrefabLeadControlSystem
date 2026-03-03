/**
 * BullMQ queue service for incoming webhook messages.
 * Replaces fire-and-forget async processing with a persistent, retryable queue.
 *
 * - Concurrency-limited processing (prevents scaling wall)
 * - Automatic retries with exponential backoff
 * - Job persistence across server restarts
 * - Per-lead deduplication via messageId
 */

const logger = require('../src/lib/logger');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const QUEUE_NAME = 'incoming-messages';

let queue = null;
let connection = null;

function getConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is required for incoming message queue');
    }
    connection = new IORedis(url, { maxRetriesPerRequest: null });
  }
  return connection;
}

function getQueue() {
  if (!queue) {
    const conn = getConnection();
    queue = new Queue(QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        removeOnComplete: { age: 3600, count: 2000 },
        removeOnFail: { age: 86400 * 3 },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
      },
    });
  }
  return queue;
}

/**
 * Enqueue an incoming webhook payload for async processing.
 * @param {object} payload - Raw ManyChat webhook payload
 * @param {string|null} messageId - ManyChat message ID for deduplication
 * @param {object|null} [overrideCompany] - Pre-resolved company row (from token-based route)
 * @returns {{ queued: boolean, jobId?: string, reason?: string }}
 */
async function enqueueMessage(payload, messageId, overrideCompany = null) {
  try {
    const q = getQueue();
    const jobId = messageId ? `msg-${messageId}` : undefined;

    // Deduplicate: skip if a job with same messageId already exists and is active/waiting
    if (jobId) {
      const existing = await q.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'delayed', 'active'].includes(state)) {
          return { queued: false, reason: 'Duplicate message already queued', jobId };
        }
      }
    }

    const jobData = { payload, enqueuedAt: new Date().toISOString() };
    if (overrideCompany) jobData.overrideCompany = overrideCompany;

    const job = await q.add('process_message', jobData, {
      ...(jobId ? { jobId } : {}),
    });

    return { queued: true, jobId: job.id ?? jobId };
  } catch (err) {
    logger.error('[incomingMessageQueue] enqueue error:', err.message);
    throw err;
  }
}

/**
 * Get queue statistics.
 */
async function getQueueStats() {
  try {
    const q = getQueue();
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      q.getWaitingCount(),
      q.getActiveCount(),
      q.getCompletedCount(),
      q.getFailedCount(),
      q.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  } catch (err) {
    logger.error('[incomingMessageQueue] getQueueStats error:', err.message);
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }
}

async function close() {
  try {
    if (queue) {
      await queue.close();
      queue = null;
    }
    if (connection) {
      await connection.quit();
      connection = null;
    }
  } catch (err) {
    logger.error('[incomingMessageQueue] close error:', err.message);
  }
}

module.exports = {
  enqueueMessage,
  getQueueStats,
  getConnection,
  getQueue,
  close,
  QUEUE_NAME,
};
