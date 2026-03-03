/**
 * SSE (Server-Sent Events) endpoint for real-time updates.
 * Streams company-scoped events to authenticated clients.
 *
 * GET /api/sse/events?token=<JWT>
 *
 * EventSource can't set headers, so we authenticate via query param.
 */
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const logger = require('../../lib/logger');
const { subscribe } = require('../../lib/eventBus');
const { userRepository } = require('../../../db/repositories');

const HEARTBEAT_INTERVAL_MS = 15_000;

router.get('/events', async (req, res) => {
  const token = req.query.token;
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  // Verify JWT
  let userId, companyId;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    userId = payload.id ?? payload.userId;
    companyId = payload.companyId;
    if (!userId || !companyId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }
    // Verify user still exists and belongs to company
    const user = await userRepository.findByIdOnly(userId);
    if (!user || user.company_id !== companyId) {
      return res.status(401).json({ error: 'User not found' });
    }
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Track connection state to avoid writing to a closed stream
  let closed = false;

  // Swallow errors on the response stream — writing after client disconnect
  // emits an async 'error' event that would otherwise become an uncaught exception.
  res.on('error', (err) => {
    logger.debug({ err: err.message, userId, companyId }, '[sse] Response stream error (client likely disconnected)');
    closed = true;
  });

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Safe write helper — only writes if client is still connected
  const safeWrite = (data) => {
    if (closed) return false;
    try {
      res.write(data);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  // Send initial connection event
  safeWrite(`data: ${JSON.stringify({ type: 'connected', userId, companyId })}\n\n`);

  // Subscribe to company events via Redis Pub/Sub
  const subscription = subscribe(companyId, (event) => {
    safeWrite(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Heartbeat to prevent proxy/load balancer timeouts
  const heartbeat = setInterval(() => {
    if (!safeWrite(`: heartbeat\n\n`)) {
      // Client gone — trigger cleanup
      cleanup();
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on disconnect
  const cleanup = () => {
    if (closed) return; // Prevent double cleanup
    closed = true;
    clearInterval(heartbeat);
    subscription.unsubscribe();
    logger.debug({ userId, companyId }, '[sse] Client disconnected');
  };

  req.on('close', cleanup);
  req.on('error', cleanup);

  logger.info({ userId, companyId }, '[sse] Client connected');
});

module.exports = router;
