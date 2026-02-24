/**
 * Trial and subscription enforcement. Allow auth, billing, settings, health, onboarding.
 * Trial expired -> 402. Cancelled/past_due -> block non-GET with 402.
 * Do NOT apply on webhook routes (clients need webhooks to keep working).
 */
const { pool } = require('../../db');

async function getCompanyById(companyId) {
  if (!companyId) return null;
  const r = await pool.query(
    `SELECT id, subscription_status, trial_ends_at FROM companies WHERE id = $1`,
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

  next();
}

module.exports = { checkSubscription, getCompanyById };
