require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
const { authMiddleware } = require('./api/middleware/auth');
const { tenantMiddleware } = require('./api/middleware/tenant');
const isAdmin = require('./middleware/isAdmin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

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

function normalizeOrigin(origin) {
  if (!origin || typeof origin !== 'string') return origin;
  return origin.replace(/\/+$/, '');
}

const corsOptions = {
  origin:
    allowedOrigins.length > 0
      ? (origin, cb) => {
          const norm = normalizeOrigin(origin);
          if (!origin || !norm) {
            cb(null, true);
            return;
          }
          const allowed = allowedOrigins.some((a) => a === norm);
          if (allowed) {
            cb(null, true);
          } else {
            console.warn('[cors] blocked origin:', origin);
            cb(new Error('Not allowed by CORS'));
          }
        }
      : true,
  credentials: true,
};

app.use(helmet());
app.use(cors(corsOptions));

// ManyChat webhook must receive raw body for HMAC verification - mount BEFORE express.json()
const manychatRouter = require('./api/routes/manychat');
app.use('/api/webhooks/manychat', express.raw({ type: 'application/json' }), manychatRouter);

app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many login attempts' } },
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const { chatAttachmentRepository } = require('../db/repositories');
app.get('/public/attachments/:id/:token', async (req, res) => {
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

app.use('/api/auth', authLimiter, authRouter);
app.use('/api/me', apiLimiter, meRouter);

app.use('/api/companies', authMiddleware, tenantMiddleware, apiLimiter, companiesRouter);
app.use('/api/leads', authMiddleware, tenantMiddleware, apiLimiter, leadsFlatRouter);
app.use('/api/integrations', apiLimiter, integrationsRouter);
app.use('/api/admin', isAdmin, tenantMiddleware, apiLimiter, adminRouter);
app.use('/api/chatbot', authMiddleware, tenantMiddleware, apiLimiter, chatbotRouter);
app.use('/api/notifications', authMiddleware, tenantMiddleware, apiLimiter, notificationsRouter);
app.use('/api/settings', authMiddleware, tenantMiddleware, apiLimiter, settingsRouter);
app.use('/api/crm', authMiddleware, tenantMiddleware, apiLimiter, crmRouter);
app.use('/api/analytics', authMiddleware, tenantMiddleware, apiLimiter, analyticsRouter);
app.use('/api/appointments', authMiddleware, tenantMiddleware, apiLimiter, appointmentsRouter);
app.use('/api/scheduling-requests', authMiddleware, tenantMiddleware, apiLimiter, schedulingRequestsRouter);
app.use('/api/scheduling', authMiddleware, tenantMiddleware, apiLimiter, schedulingRouter);
app.use('/api/chatbot/scheduling', authMiddleware, tenantMiddleware, apiLimiter, chatbotSchedulingRouter);
app.use('/api/conversations', authMiddleware, tenantMiddleware, apiLimiter, conversationsRouter);
app.use('/api/hot-leads', authMiddleware, tenantMiddleware, apiLimiter, hotLeadsRouter);
app.use('/api/warming', authMiddleware, tenantMiddleware, apiLimiter, warmingRouter);
app.use('/api/deals', authMiddleware, tenantMiddleware, apiLimiter, dealsRouter);
app.use('/api/pipeline', authMiddleware, tenantMiddleware, apiLimiter, pipelineRouter);
app.use('/api/calendar', authMiddleware, tenantMiddleware, apiLimiter, calendarRouter);

app.use((req, res) => {
  if (!res.headersSent) {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } });
    } else {
      res.status(404).send('Not found');
    }
  }
});

app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: { code: 'CORS_ERROR', message: 'Origin not allowed' } });
  }
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
});

const reminderWorker = require('../services/appointmentReminderWorker');
const followUpWorker = require('../services/followUpWorker');
const warmingWorker = require('./workers/warmingWorker');
const warmingService = require('./services/warmingService');
const revenueSnapshotService = require('./services/revenueSnapshotService');

const WARMING_CRON_MS = 60 * 60 * 1000;
const REVENUE_CRON_MS = 60 * 60 * 1000; // check every hour, run at midnight
let warmingCronTimer = null;
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
      console.log('[migrations] Backfilled schema_migrations from _migrations:', legacy.rows.length, 'migration(s)');
    }
  }
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('[migrations] No migrations directory found, skipping.');
    return;
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !appliedSet.has(f));
  if (pending.length === 0) {
    console.log('[migrations] No pending migrations.');
    return;
  }
  console.log(`[migrations] ${pending.length} pending migration(s): ${pending.join(', ')}`);
  for (const filename of pending) {
    try {
      const filePath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(filePath, 'utf8').trim();
      if (sql) {
        await pool.query(sql);
      }
      await pool.query('INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW())', [filename]);
      console.log(`[migrations] Applied: ${filename}`);
    } catch (err) {
      console.error(`[migrations] FAILED: ${filename} —`, err.message);
      console.error('[migrations] Server will start anyway. Fix the migration and redeploy.');
    }
  }
}

function startServer() {
  server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    reminderWorker.start();
    if (process.env.REDIS_URL) {
      followUpWorker.start();
      warmingWorker.start();
      warmingCronTimer = setInterval(() => {
        warmingService.runHourlyNoReply72hEnrollment().catch((err) => console.error('[warming] cron error:', err.message));
      }, WARMING_CRON_MS);
    } else {
      console.warn('[index] REDIS_URL not set, follow-up worker not started');
    }
    revenueCronTimer = setInterval(() => {
      const now = new Date();
      const today = now.toISOString().slice(0, 10);
      if (now.getHours() === 0 && lastRevenueSnapshotDate !== today) {
        lastRevenueSnapshotDate = today;
        revenueSnapshotService.runDailySnapshot().catch((err) => console.error('[revenueSnapshot] error:', err.message));
      }
    }, REVENUE_CRON_MS);
  });
}

runMigrations()
  .catch((err) => {
    console.error('[migrations] Error running migrations:', err.message);
  })
  .finally(() => {
    startServer();
  });

async function gracefulShutdown() {
  console.log('[index] shutting down...');
  if (warmingCronTimer) clearInterval(warmingCronTimer);
  if (revenueCronTimer) clearInterval(revenueCronTimer);
  reminderWorker.stop();
  await followUpWorker.stop();
  await warmingWorker.stop();
  const queueService = require('../services/queueService');
  await queueService.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => gracefulShutdown());
process.on('SIGINT', () => gracefulShutdown());

module.exports = { app, server, gracefulShutdown };
