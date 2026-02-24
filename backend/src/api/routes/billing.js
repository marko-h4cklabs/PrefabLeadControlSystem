/**
 * Stripe billing.
 * Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRO_PRICE_ID, STRIPE_ENTERPRISE_PRICE_ID
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../../../db');
const { companyRepository } = require('../../../db/repositories');
const stripeService = require('../../services/stripeService');
const { errorJson } = require('../middleware/errors');
const { authMiddleware } = require('../middleware/auth');
const { tenantMiddleware } = require('../middleware/tenant');

const PLAN_LIMITS = {
  trial: { monthly_messages: 100, leads: 50 },
  pro: { monthly_messages: 2000, leads: 999999 },
  enterprise: { monthly_messages: 999999, leads: 999999 },
};

function getLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
}

// Protected routes
router.use(authMiddleware, tenantMiddleware);

// GET /api/billing/status
router.get('/status', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const row = (
      await pool.query(
        `SELECT subscription_plan, subscription_status, trial_ends_at, subscription_ends_at,
          monthly_message_count, message_count_reset_at FROM companies WHERE id = $1`,
        [companyId]
      )
    ).rows[0];
    const plan = row?.subscription_plan || 'trial';
    const status = row?.subscription_status || 'active';
    const limits = getLimits(plan);
    return res.json({
      plan,
      status,
      trial_ends_at: row?.trial_ends_at ?? null,
      subscription_ends_at: row?.subscription_ends_at ?? null,
      monthly_message_count: row?.monthly_message_count ?? 0,
      limits: {
        monthly_messages: limits.monthly_messages,
        leads: limits.leads,
      },
    });
  } catch (err) {
    console.error('[billing/status]', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to get billing status');
  }
});

// POST /api/billing/checkout — body { plan: 'pro' | 'enterprise' }
router.post('/checkout', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const plan = req.body?.plan === 'enterprise' ? 'enterprise' : 'pro';
    const priceId =
      plan === 'enterprise'
        ? process.env.STRIPE_ENTERPRISE_PRICE_ID
        : process.env.STRIPE_PRO_PRICE_ID;
    if (!priceId) {
      return errorJson(res, 503, 'SERVICE_UNAVAILABLE', 'Checkout not configured for this plan');
    }
    const company = await companyRepository.findById(companyId);
    let stripeCustomerId = (
      await pool.query('SELECT stripe_customer_id FROM companies WHERE id = $1', [companyId])
    ).rows[0]?.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripeService.createCustomer({
        id: companyId,
        name: company?.name,
        contact_email: company?.contact_email,
      });
      stripeCustomerId = customer.id;
      await pool.query(
        'UPDATE companies SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, companyId]
      );
    }
    const baseUrl = process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:5173';
    const successUrl = `${baseUrl.replace(/\/$/, '')}/settings?stripe=success`;
    const cancelUrl = `${baseUrl.replace(/\/$/, '')}/settings?stripe=cancelled`;
    const session = await stripeService.createCheckoutSession(
      companyId,
      priceId,
      successUrl,
      cancelUrl,
      plan
    );
    return res.json({ checkout_url: session.url });
  } catch (err) {
    console.error('[billing/checkout]', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create checkout session');
  }
});

// POST /api/billing/portal
router.post('/portal', async (req, res) => {
  try {
    const companyId = req.tenantId;
    const row = (
      await pool.query('SELECT stripe_customer_id FROM companies WHERE id = $1', [companyId])
    ).rows[0];
    if (!row?.stripe_customer_id) {
      return errorJson(res, 400, 'BAD_REQUEST', 'No billing customer. Subscribe first.');
    }
    const baseUrl = process.env.FRONTEND_ORIGIN?.split(',')[0]?.trim() || 'http://localhost:5173';
    const returnUrl = `${baseUrl.replace(/\/$/, '')}/settings`;
    const session = await stripeService.createBillingPortalSession(
      row.stripe_customer_id,
      returnUrl
    );
    return res.json({ portal_url: session.url });
  } catch (err) {
    console.error('[billing/portal]', err.message);
    return errorJson(res, 500, 'INTERNAL_ERROR', 'Failed to create portal session');
  }
});

module.exports = router;
