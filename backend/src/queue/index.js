const PgBoss = require('pg-boss');
const { handleScrapeJob } = require('../workers/scrapeWorker');

const QUEUE_NAME = 'scrape-company-website';

let boss = null;

async function startQueue() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('[queue] DATABASE_URL not set, skipping pg-boss');
    return null;
  }

  boss = new PgBoss(connectionString);
  await boss.start();

  await boss.work(QUEUE_NAME, async (job) => {
    await handleScrapeJob(job);
  });

  console.log('[queue] Started, worker registered:', QUEUE_NAME);
  return boss;
}

async function sendScrapeJob(companyId, websiteUrl) {
  if (!boss) {
    throw new Error('Queue not initialized');
  }
  return boss.send(QUEUE_NAME, { companyId, websiteUrl });
}

async function stopQueue() {
  if (boss) {
    await boss.stop();
    boss = null;
  }
}

module.exports = { startQueue, sendScrapeJob, stopQueue, QUEUE_NAME };
