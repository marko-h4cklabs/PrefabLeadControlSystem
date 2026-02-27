/**
 * Trial and subscription enforcement. Allow auth, billing, settings, health, onboarding.
 * Trial expired -> 402. Cancelled/past_due -> block non-GET with 402.
 * Message limits enforced: warn at 80%, block at 100%.
 * Do NOT apply on webhook routes (clients need webhooks to keep working).
 */
const { pool } = require('../../db');
const logger = require('../lib/logger');

const PLAN_LIMITS = {
  trial: 100,
  pro: 2000,
  enterprise: 999999,
};

async function getCompanyById(companyId) {
  if (!companyId) return null;
  const r = await pool.query(
    `SELECT id, subscription_status, trial_ends_at, subscription_plan, monthly_message_count FROM companies WHERE id = $1`,
    [companyId]
  );
  return r.rows[0] || null;
}

async function checkSubscription(req, res, next) {
  const companyId = req.companyId || req.tenantId || req.user?.companyId;
  if (!companyId) {
    return next();
  }

  const company = await getCompanyById(companyId);
  if (!company) {
    return res.status(404).json({ error: 'Company not found' });
  }

  const allowedPaths = [
    '/api/auth',
    '/api/billing',
    '/api/settings',
    '/api/health',
    '/api/onboarding',
  ];
  const path = req.originalUrl || req.url || req.path || '';
  if (allowedPaths.some((p) => path.startsWith(p))) {
    return next();
  }

  const status = company.subscription_status || 'trial';

  if (status === 'trial' && company.trial_ends_at && new Date() > new Date(company.trial_ends_at)) {
    return res.status(402).json({
      error: 'trial_expired',
      message: 'Your trial has ended. Please upgrade to continue.',
      trial_ended_at: company.trial_ends_at,
    });
  }

  if (['cancelled', 'past_due'].includes(status) && req.method !== 'GET') {
    return res.status(402).json({
      error: 'subscription_inactive',
      message: 'Your subscription is inactive. Please update your billing.',
      status,
    });
  }

  // Attach message limit info for downstream use (e.g., webhook handlers)
  const plan = company.subscription_plan || 'trial';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.trial;
  const used = company.monthly_message_count || 0;
  req.messageLimitInfo = { plan, limit, used, exceeded: used >= limit };

  next();
}

/**
 * Check if a company has exceeded its message limit. Returns { allowed, used, limit, plan }.
 * Use this in webhook handlers and workers to block AI replies when limit is reached.
 */
async function checkMessageLimit(companyId) {
  const r = await pool.query(
    `SELECT subscription_plan, monthly_message_count FROM companies WHERE id = $1`,
    [companyId]
  );
  const row = r.rows[0];
  if (!row) return { allowed: false, used: 0, limit: 0, plan: 'unknown' };

  const plan = row.subscription_plan || 'trial';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.trial;
  const used = row.monthly_message_count || 0;

  if (used >= limit) {
    logger.warn({ companyId, plan, used, limit }, 'Message limit exceeded - blocking');
    return { allowed: false, used, limit, plan };
  }

  // Warn at 80%
  if (used >= limit * 0.8) {
    logger.info({ companyId, plan, used, limit }, 'Message limit approaching 80%');
  }

  return { allowed: true, used, limit, plan };
}

module.exports = { checkSubscription, getCompanyById, checkMessageLimit, PLAN_LIMITS };
