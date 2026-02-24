/**
 * Health and system monitoring. GET /api/health is public; GET /api/admin/system-health is admin-only.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');

const VERSION = '1.0.0';

async function checkDatabase() {
  try {
    await pool.query('SELECT 1');
    return 'ok';
  } catch (e) {
    return 'degraded';
  }
}

async function checkRedis() {
  try {
    const queueService = require('../../../services/queueService');
    const conn = queueService.getConnection?.();
    if (!conn) return 'degraded';
    const pong = await conn.ping();
    return pong === 'PONG' ? 'ok' : 'degraded';
  } catch (e) {
    return 'degraded';
  }
}

async function checkAnthropic() {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return 'degraded';
    return 'ok';
  } catch (e) {
    return 'degraded';
  }
}

async function checkManyChat() {
  try {
    if (!process.env.MANYCHAT_WEBHOOK_SECRET) return 'degraded';
    return 'ok';
  } catch (e) {
    return 'degraded';
  }
}

// GET /api/health — public
router.get('/', async (req, res) => {
  try {
    const [database, redis, anthropic, manychat] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkAnthropic(),
      checkManyChat(),
    ]);
    const status = [database, redis, anthropic, manychat].every((s) => s === 'ok') ? 'ok' : 'degraded';
    res.json({
      status,
      timestamp: new Date().toISOString(),
      services: { database, redis, anthropic, manychat },
      version: VERSION,
    });
  } catch (err) {
    res.status(200).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      services: { database: 'degraded', redis: 'degraded', anthropic: 'degraded', manychat: 'degraded' },
      version: VERSION,
    });
  }
});

module.exports = router;
