/**
 * BullMQ-based follow-up queue service.
 * Handles scheduled outreach to leads (no_reply, post_quote, cold_lead, custom).
 */

const logger = require('../src/lib/logger');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');

const QUEUE_NAME = 'follow-ups';
const JOB_TYPES = new Set(['no_reply', 'post_quote', 'cold_lead', 'custom']);

let queue = null;
let connection = null;

function getConnection() {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is required for queue service');
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
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86400 * 3 },
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 10000,
        },
      },
    });
  }
  return queue;
}

/**
 * Build job ID for deduplication. BullMQ jobIds must not contain ':'.
 */
function buildJobId(leadId, type) {
  return `${String(leadId)}-${String(type)}`;
}

/**
 * Schedule a follow-up job.
 * Deduplicates: if a job with same leadId+type exists (waiting/delayed/active), skip.
 * @returns {{ queued: boolean, jobId: string } | { queued: false, reason: string }}
 */
async function scheduleFollowUp(leadId, companyId, type, delayMs, payload = {}) {
  try {
    if (!JOB_TYPES.has(type)) {
      return { queued: false, reason: 'Invalid job type' };
    }

    const q = getQueue();
    const jobId = buildJobId(leadId, type);

    const existing = await q.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'delayed', 'active'].includes(state)) {
        return { queued: false, reason: 'Job already exists', jobId };
      }
    }

    const scheduledAt = new Date().toISOString();
    const job = await q.add(
      type,
      {
        leadId,
        companyId,
        type,
        scheduledAt,
        ...payload,
      },
      {
        jobId,
        delay: Math.max(0, delayMs),
      }
    );

    return { queued: true, jobId: job.id ?? jobId };
  } catch (err) {
    logger.error('[queueService] scheduleFollowUp error:', err.message);
    throw err;
  }
}

/**
 * Cancel a scheduled follow-up job.
 */
async function cancelFollowUp(leadId, type) {
  try {
    const q = getQueue();
    const jobId = buildJobId(leadId, type);
    const job = await q.getJob(jobId);
    if (job) {
      const state = await job.getState();
      if (['waiting', 'delayed'].includes(state)) {
        await job.remove();
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.error('[queueService] cancelFollowUp error:', err.message);
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
    logger.error('[queueService] getQueueStats error:', err.message);
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
    logger.error('[queueService] close error:', err.message);
  }
}

module.exports = {
  scheduleFollowUp,
  cancelFollowUp,
  getQueueStats,
  getConnection,
  getQueue,
  close,
  QUEUE_NAME,
};
