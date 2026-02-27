/**
 * Health and system monitoring. GET /api/health is public.
 * Checks: database, redis, queue health, API keys.
 */
const logger = require('../../lib/logger');
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');

const VERSION = '1.0.0';

async function checkDatabase() {
  try {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  } catch (e) {
    return { status: 'degraded', error: e.message };
  }
}

async function checkRedis() {
  try {
    const queueService = require('../../../services/queueService');
    const conn = queueService.getConnection?.();
    if (!conn) return { status: 'degraded', error: 'No connection' };
    const pong = await conn.ping();
    return pong === 'PONG' ? { status: 'ok' } : { status: 'degraded' };
  } catch (e) {
    return { status: 'degraded', error: e.message };
  }
}

async function checkQueues() {
  try {
    const incomingQueue = require('../../../services/incomingMessageQueue');
    const followUpQueue = require('../../../services/queueService');
    const [incomingStats, followUpStats] = await Promise.all([
      incomingQueue.getQueueStats(),
      followUpQueue.getQueueStats(),
    ]);
    const totalWaiting = (incomingStats.waiting || 0) + (followUpStats.waiting || 0);
    const totalFailed = (incomingStats.failed || 0) + (followUpStats.failed || 0);
    let queueStatus = 'ok';
    if (totalWaiting > 100) queueStatus = 'degraded';
    if (totalFailed > 50) queueStatus = 'degraded';
    return {
      status: queueStatus,
      incoming: incomingStats,
      followUp: followUpStats,
    };
  } catch (e) {
    return { status: 'degraded', error: e.message };
  }
}

async function checkAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return { status: 'degraded', error: 'Key not set' };
  return { status: 'ok' };
}

async function checkManyChat() {
  if (!process.env.MANYCHAT_WEBHOOK_SECRET) return { status: 'degraded', error: 'Secret not set' };
  return { status: 'ok' };
}

// GET /api/health — public
router.get('/', async (req, res) => {
  try {
    const [database, redis, queues, anthropic, manychat] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueues(),
      checkAnthropic(),
      checkManyChat(),
    ]);
    const allStatuses = [database.status, redis.status, queues.status, anthropic.status, manychat.status];
    const overall = allStatuses.every((s) => s === 'ok') ? 'ok' : 'degraded';
    const statusCode = overall === 'ok' ? 200 : 503;
    res.status(statusCode).json({
      status: overall,
      timestamp: new Date().toISOString(),
      services: { database, redis, queues, anthropic, manychat },
      version: VERSION,
    });
  } catch (err) {
    logger.error({ err }, 'Health check failed');
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      services: {},
      version: VERSION,
    });
  }
});

module.exports = router;
