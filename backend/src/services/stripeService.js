/**
 * Stripe billing.
 * Env: STRIPE_SECRET_KEY=sk_live_or_test_..., STRIPE_WEBHOOK_SECRET=whsec_...,
 *      STRIPE_PRO_PRICE_ID=price_..., STRIPE_ENTERPRISE_PRICE_ID=price_...
 * Stripe is lazy-initialized so the app can start without STRIPE_SECRET_KEY set.
 */
const Stripe = require('stripe');

let stripeInstance = null;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY || !String(process.env.STRIPE_SECRET_KEY).trim()) {
    return null;
  }
  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY.trim());
  }
  return stripeInstance;
}

async function createCustomer(company) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const customer = await stripe.customers.create({
    email: company.contact_email || undefined,
    name: company.name || undefined,
    metadata: { company_id: company.id },
  });
  return customer;
}

async function createCheckoutSession(companyId, priceId, successUrl, cancelUrl, plan = 'pro') {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { company_id: companyId, plan },
    subscription_data: { metadata: { company_id: companyId, plan } },
  });
  return session;
}

async function createBillingPortalSession(stripeCustomerId, returnUrl) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session;
}

async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  return stripe.subscriptions.cancel(subscriptionId);
}

module.exports = {
  getStripe,
  get stripe() {
    return getStripe();
  },
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
};
