/**
 * Stripe webhook — must be mounted with express.raw({ type: 'application/json' }) BEFORE express.json()
 */
const express = require('express');
const { pool } = require('../../../db');
const stripeService = require('../../services/stripeService');

const router = express.Router();

router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = stripeService.getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' });
  }
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[billing/webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).json({ error: 'Webhook not configured' });
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[billing/webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    await pool.query(
      `INSERT INTO billing_events (company_id, event_type, stripe_event_id, metadata)
       VALUES ($1, $2, $3, $4)`,
      [
        null,
        event.type,
        event.id,
        JSON.stringify({
          type: event.type,
          data: event.data?.object ? { id: event.data.object.id } : {},
        }),
      ]
    );
  } catch (e) {
    console.warn('[billing/webhook] Log insert failed:', e.message);
  }
  let companyId = null;
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    companyId = obj.metadata?.company_id;
    if (companyId) {
      const subscriptionId = obj.subscription || obj.id;
      const plan = obj.metadata?.plan === 'enterprise' ? 'enterprise' : 'pro';
      await pool.query(
        `UPDATE companies SET stripe_subscription_id = $1, subscription_status = 'active', subscription_plan = $2 WHERE id = $3`,
        [subscriptionId, plan, companyId]
      );
    }
  } else if (event.type === 'customer.subscription.updated') {
    const subId = obj.id;
    const status = obj.status;
    const r = await pool.query('SELECT id FROM companies WHERE stripe_subscription_id = $1', [
      subId,
    ]);
    if (r.rows[0]) {
      companyId = r.rows[0].id;
      await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', [
        status,
        companyId,
      ]);
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const subId = obj.id;
    const r = await pool.query('SELECT id FROM companies WHERE stripe_subscription_id = $1', [
      subId,
    ]);
    if (r.rows[0]) {
      companyId = r.rows[0].id;
      await pool.query(
        `UPDATE companies SET subscription_status = 'cancelled', stripe_subscription_id = NULL WHERE id = $1`,
        [companyId]
      );
    }
  } else if (event.type === 'invoice.payment_failed') {
    const subId = obj.subscription;
    if (subId) {
      const r = await pool.query('SELECT id FROM companies WHERE stripe_subscription_id = $1', [
        subId,
      ]);
      if (r.rows[0]) {
        companyId = r.rows[0].id;
        await pool.query('UPDATE companies SET subscription_status = $1 WHERE id = $2', [
          'past_due',
          companyId,
        ]);
      }
    }
  }
  if (companyId) {
    await pool
      .query(`UPDATE billing_events SET company_id = $1 WHERE stripe_event_id = $2`, [
        companyId,
        event.id,
      ])
      .catch(() => {});
  }
  res.json({ received: true });
});

module.exports = router;
