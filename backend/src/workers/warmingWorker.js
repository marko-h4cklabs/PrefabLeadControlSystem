/**
 * BullMQ worker for warming sequence steps. Processes jobs from warming-queue, concurrency 3.
 */

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
    console.error('[warmingWorker] error:', err.message);
  });

  worker.on('failed', (job, err) => {
    console.error('[warmingWorker] job failed:', job?.id, err?.message);
  });

  console.info('[warmingWorker] started, concurrency=', CONCURRENCY);
}

async function stop() {
  if (worker) {
    await worker.close();
    worker = null;
    console.info('[warmingWorker] stopped');
  }
}

module.exports = { start, stop };
