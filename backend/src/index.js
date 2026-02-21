require('dotenv').config();
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
const { authMiddleware } = require('./api/middleware/auth');
const { tenantMiddleware } = require('./api/middleware/tenant');

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
app.use('/api/admin', authMiddleware, tenantMiddleware, apiLimiter, adminRouter);
app.use('/api/chatbot', authMiddleware, tenantMiddleware, apiLimiter, chatbotRouter);
app.use('/api/notifications', authMiddleware, tenantMiddleware, apiLimiter, notificationsRouter);
app.use('/api/settings', authMiddleware, tenantMiddleware, apiLimiter, settingsRouter);
app.use('/api/crm', authMiddleware, tenantMiddleware, apiLimiter, crmRouter);
app.use('/api/analytics', authMiddleware, tenantMiddleware, apiLimiter, analyticsRouter);
app.use('/api/appointments', authMiddleware, tenantMiddleware, apiLimiter, appointmentsRouter);

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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
