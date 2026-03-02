require('dotenv').config();

// --- Sentry: must initialize before other imports for full coverage ---
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

// --- Crash handlers: must be registered before anything else ---
const logger = require('./lib/logger');

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'UNCAUGHT EXCEPTION - process will exit');
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'UNHANDLED REJECTION - process will exit');
  setTimeout(() => process.exit(1), 1000);
});

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const requestIdMiddleware = require('./middleware/requestId');
const authRouter = require('./api/routes/auth');
const meRouter = require('./api/routes/me');
const companiesRouter = require('./api/routes/companies');
const leadsFlatRouter = require('./api/routes/leadsFlat');
const integrationsRouter = require('./api/routes/integrations');
const adminRouter = require('./api/routes/admin');
const chatbotRouter = require('./api/routes/chatbot');
const notificationsRouter = require('./api/routes/notifications');
const settingsRouter = require('./api/routes/settings');
const crmRouter = require('./api/routes/crmIndex');
const analyticsRouter = require('./api/routes/analytics');
const appointmentsRouter = require('./api/routes/appointments');
const schedulingRequestsRouter = require('./api/routes/schedulingRequests');
const chatbotSchedulingRouter = require('./api/routes/chatbotScheduling');
const schedulingRouter = require('./api/routes/scheduling');
const conversationsRouter = require('./api/routes/conversations');
const hotLeadsRouter = require('./api/routes/hotLeads');
const warmingRouter = require('./api/routes/warming');
const dealsRouter = require('./api/routes/deals');
const pipelineRouter = require('./api/routes/pipeline');
const calendarRouter = require('./api/routes/calendar');
const billingRouter = require('./api/routes/billing');
const teamRouter = require('./api/routes/team');
const voiceRouter = require('./api/routes/voice');
const handoffRouter = require('./api/routes/handoff');
const { authMiddleware } = require('./api/middleware/auth');
const { tenantMiddleware } = require('./api/middleware/tenant');
const { requireCompany } = require('./middleware/requireCompany');
const { checkSubscription } = require('./middleware/checkSubscription');
const isAdmin = require('./middleware/isAdmin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// --- CORS: explicit origin allowlist, reject all in production if empty ---
function parseAllowedOrigins() {
  const raw = process.env.FRONTEND_ORIGIN || '';
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => o.replace(/\/+$/, ''));
}

const allowedOrigins = parseAllowedOrigins();

if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'production') {
  logger.warn('No FRONTEND_ORIGIN set - CORS will reject all cross-origin requests in production');
}

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'string') return origin;
  return origin.replace(/\/+$/, '');
}

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (server-to-server, health checks, webhooks)
    if (!origin) return cb(null, true);
    const norm = normalizeOrigin(origin);
    if (!norm) return cb(null, true);
    if (allowedOrigins.length > 0 && allowedOrigins.some((a) => a === norm)) {
      return cb(null, true);
    }
    // In development, allow all if no origins configured
    if (allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production') {
      return cb(null, true);
    }
    logger.warn({ origin }, 'CORS blocked origin');
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));

// --- Request ID for tracing ---
app.use(requestIdMiddleware);

// --- Structured request logging via pino-http ---
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/api/health',
  },
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
}));

// ManyChat webhook must receive raw body for HMAC verification - mount BEFORE express.json()
const manychatRouter = require('./api/routes/manychat');
app.use('/api/webhooks/manychat', express.raw({ type: 'application/json' }), manychatRouter);

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
const manychatWebhookByTokenRouter = require('./api/routes/manychatWebhookByToken');
app.use('/api/webhook/manychat', webhookLimiter, express.raw({ type: 'application/json' }), manychatWebhookByTokenRouter);

// Stripe webhook needs raw body for signature verification
const billingWebhookRouter = require('./api/routes/billingWebhook');
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }), billingWebhookRouter);

app.use(express.json());
app.use(cookieParser());

// SSE endpoint for real-time events (uses own JWT auth via query param)
const sseRouter = require('./api/routes/sse');
app.use('/api/sse', sseRouter);

// ManyChat External Request endpoint for voice reply (public, no auth)
const manychatVoiceReplyRouter = require('./api/routes/manychatVoiceReply');
app.use('/api/manychat/voice-reply-content', manychatVoiceReplyRouter);

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests, please slow down' } },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const healthRouter = require('./api/routes/health');
app.use('/api/health', healthRouter);

app.use('/uploads', express.static(path.join(__dirname, '../public/uploads')));

const { chatAttachmentRepository } = require('../db/repositories');
app.get('/public/attachments/:id/:token/:filename', async (req, res) => {
  try {
    const { id, token } = req.params;
    const row = await chatAttachmentRepository.findById(id);
    if (!row || row.public_token !== token) {
      return res.status(404).send('Not found');
    }
    res.set('Cache-Control', 'public, max-age=31536000');
    res.set('Content-Disposition', 'inline');
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.send(row.data);
  } catch (err) {
    res.status(500).send('Internal server error');
  }
});

app.use('/api/auth', authRouter);
app.use('/api/me', apiLimiter, meRouter);

const companyRateLimit = require('./middleware/companyRateLimit');
const protectedStack = [authMiddleware, tenantMiddleware, requireCompany, checkSubscription, companyRateLimit, apiLimiter];
app.use('/api/onboarding', authMiddleware, tenantMiddleware, requireCompany, apiLimiter, require('./api/routes/onboarding'));

app.use('/api/companies', ...protectedStack, companiesRouter);
app.use('/api/leads', ...protectedStack, leadsFlatRouter);
app.use('/api/integrations', apiLimiter, integrationsRouter);
app.use('/api/admin', isAdmin, tenantMiddleware, apiLimiter, adminRouter);
app.use('/api/chatbot', ...protectedStack, chatbotRouter);
app.use('/api/notifications', ...protectedStack, notificationsRouter);
app.use('/api/settings', ...protectedStack, settingsRouter);
app.use('/api/crm', ...protectedStack, crmRouter);
app.use('/api/analytics', ...protectedStack, analyticsRouter);
app.use('/api/appointments', ...protectedStack, appointmentsRouter);
app.use('/api/scheduling-requests', ...protectedStack, schedulingRequestsRouter);
app.use('/api/scheduling', ...protectedStack, schedulingRouter);
app.use('/api/chatbot/scheduling', ...protectedStack, chatbotSchedulingRouter);
app.use('/api/conversations', ...protectedStack, conversationsRouter);
app.use('/api/hot-leads', ...protectedStack, hotLeadsRouter);
app.use('/api/warming', ...protectedStack, warmingRouter);
app.use('/api/deals', ...protectedStack, dealsRouter);
app.use('/api/pipeline', ...protectedStack, pipelineRouter);
app.use('/api/calendar', ...protectedStack, calendarRouter);
app.use('/api/billing', ...protectedStack, billingRouter);
app.use('/api/team', ...protectedStack, teamRouter);
app.use('/api/voice', ...protectedStack, voiceRouter);
app.use('/api/handoff', ...protectedStack, handoffRouter);
const autoresponderRouter = require('./api/routes/autoresponder');
app.use('/api/autoresponder', ...protectedStack, autoresponderRouter);
const queueRouter = require('./api/routes/queue');
app.use('/api/queue', ...protectedStack, queueRouter);
const copilotRouter = require('./api/routes/copilot');
app.use('/api/copilot', ...protectedStack, copilotRouter);

app.use((req, res) => {
  if (!res.headersSent) {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
    } else {
      res.status(404).send('Not found');
    }
  }
});

// Sentry error handler (must be before other error handlers)
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: { code: 'CORS_ERROR', message: 'Origin not allowed' } });
  }
  logger.error({ err }, 'Unhandled Express error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

const reminderWorker = require('../services/appointmentReminderWorker');
const followUpWorker = require('../services/followUpWorker');
const incomingMessageWorker = require('../services/incomingMessageWorker');
const warmingWorker = require('./workers/warmingWorker');
const warmingService = require('./services/warmingService');
const revenueSnapshotService = require('./services/revenueSnapshotService');
const handoffService = require('./services/handoffService');

const WARMING_CRON_MS = 60 * 60 * 1000;
const HANDOFF_CRON_MS = 5 * 60 * 1000;
const REVENUE_CRON_MS = 60 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
let warmingCronTimer = null;
let handoffCronTimer = null;
let revenueCronTimer = null;
let lastRevenueSnapshotDate = null;
let server = null;

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function runMigrations() {
  const { pool } = require('../db');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);
  const applied = await pool.query('SELECT filename FROM schema_migrations');
  let appliedSet = new Set((applied.rows || []).map((r) => r.filename));
  if (appliedSet.size === 0) {
    let legacy = { rows: [] };
    try {
      legacy = await pool.query('SELECT name FROM _migrations ORDER BY id');
    } catch (_) {
      /* _migrations table may not exist */
    }
    if (legacy.rows && legacy.rows.length > 0) {
      for (const r of legacy.rows) {
        await pool.query(
          'INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW()) ON CONFLICT (filename) DO NOTHING',
          [r.name]
        ).catch(() => {});
      }
      const reapplied = await pool.query('SELECT filename FROM schema_migrations');
      appliedSet = new Set((reapplied.rows || []).map((r) => r.filename));
      logger.info({ count: legacy.rows.length }, 'Backfilled schema_migrations from _migrations');
    }
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.info('No migrations directory found, skipping');
    return;
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length === 0) {
    logger.info('No pending migrations');
    return;
  }
  logger.info({ count: pending.length, files: pending }, 'Running pending migrations');
  for (const filename of pending) {
    try {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, 'utf8').trim();
      if (sql) {
        await pool.query(sql);
      }
      await pool.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW())', [filename]);
      logger.info({ migration: filename }, 'Migration applied');
    } catch (err) {
      logger.error({ migration: filename, err }, 'Migration FAILED - server will start anyway');
    }
  }
}

const { acquireCronLock, releaseCronLock } = require('./lib/redis');

/**
 * Run a cron job with Redis-based distributed lock.
 * Prevents duplicate runs during deploy overlap (old + new instance both running).
 */
async function runWithCronLock(lockName, ttlSeconds, fn) {
  const acquired = await acquireCronLock(lockName, ttlSeconds);
  if (!acquired) {
    logger.debug({ lockName }, 'Cron lock held by another instance, skipping');
    return;
  }
  try {
    await fn();
  } finally {
    await releaseCronLock(lockName).catch(() => {});
  }
}

function startServer() {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'Server listening');
    reminderWorker.start();
    if (process.env.REDIS_URL) {
      incomingMessageWorker.start();
      followUpWorker.start();
      warmingWorker.start();
      warmingCronTimer = setInterval(() => {
        runWithCronLock('warming-72h', 3000, () =>
          warmingService.runHourlyNoReply72hEnrollment()
        ).catch((err) => logger.error({ err }, 'Warming cron error'));
      }, WARMING_CRON_MS);
    } else {
      logger.warn('REDIS_URL not set, queue workers not started');
    }
    handoffCronTimer = setInterval(() => {
      runWithCronLock('handoff-resume', 240, () =>
        handoffService.runAutoResumeCron()
      ).catch((err) => logger.error({ err }, 'Handoff auto-resume cron error'));
    }, HANDOFF_CRON_MS);
    revenueCronTimer = setInterval(() => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() === 0 && lastRevenueSnapshotDate !== today) {
        lastRevenueSnapshotDate = today;
        runWithCronLock('revenue-snapshot', 3000, () =>
          revenueSnapshotService.runDailySnapshot()
        ).catch((err) => logger.error({ err }, 'Revenue snapshot error'));
      }
    }, REVENUE_CRON_MS);
  });
}

runMigrations()
  .catch((err) => {
    logger.error({ err }, 'Error running migrations');
  })
  .finally(() => {
    startServer();
  });

// --- Graceful shutdown with timeout + pool drain ---
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Shutdown initiated');

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    // 1. Clear cron timers
    if (warmingCronTimer) clearInterval(warmingCronTimer);
    if (handoffCronTimer) clearInterval(handoffCronTimer);
    if (revenueCronTimer) clearInterval(revenueCronTimer);

    // 2. Stop accepting HTTP connections
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    // 3. Stop workers (finishes in-flight jobs)
    reminderWorker.stop();
    await Promise.allSettled([
      incomingMessageWorker.stop(),
      followUpWorker.stop(),
      warmingWorker.stop(),
    ]);

    // 4. Close queues and Redis
    const queueService = require('../services/queueService');
    const incomingMessageQueue = require('../services/incomingMessageQueue');
    await Promise.allSettled([
      queueService.close(),
      incomingMessageQueue.close(),
    ]);

    // 5. Drain DB pool
    const { pool } = require('../db');
    await pool.end();

    logger.info('Shutdown complete');
    clearTimeout(forceExit);
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    clearTimeout(forceExit);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = { app, server, gracefulShutdown };
