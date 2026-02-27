/**
 * BullMQ worker for warming sequence steps. Processes jobs from warming-queue, concurrency 3.
 */

const logger = require('../lib/logger');
const { Worker } = require('bullmq');
const warmingService = require('../services/warmingService');

const CONCURRENCY = 3;
let worker = null;

function start() {
  if (worker) return;
  const connection = warmingService.getConnection();
  worker = new Worker(
    warmingService.QUEUE_NAME,
    async (job) => {
      if (job.name === 'warming_step' && job.data?.enrollmentId && job.data?.stepId) {
        await warmingService.processWarmingStep(job.data.enrollmentId, job.data.stepId);
      }
    },
    { connection, concurrency: CONCURRENCY }
  );

  worker.on('error', (err) => {
    logger.error('[warmingWorker] error:', err.message);
  });

  worker.on('failed', async (job, err) => {
    logger.error('[warmingWorker] job failed:', job?.id, err?.message);
    if (job && job.attemptsMade >= (job.opts?.attempts || 1)) {
      const { sendAdminAlert } = require('../services/adminAlertService');
      sendAdminAlert(
        `dlq:warming:${job.id}`,
        'Warming job permanently failed',
        { jobId: job.id, enrollmentId: job.data?.enrollmentId, stepId: job.data?.stepId, error: err?.message }
      ).catch(() => {});
    }
  });

  logger.info('[warmingWorker] started, concurrency=', CONCURRENCY);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    logger.info('[warmingWorker] stopped');
  }
}

module.exports = { start, stop };
