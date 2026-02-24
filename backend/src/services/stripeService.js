/**
 * Stripe billing.
 * Env: STRIPE_SECRET_KEY=sk_live_or_test_..., STRIPE_WEBHOOK_SECRET=whsec_...,
 *      STRIPE_PRO_PRICE_ID=price_..., STRIPE_ENTERPRISE_PRICE_ID=price_...
 */
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

async function createCustomer(company) {
  const customer = await stripe.customers.create({
    email: company.contact_email || undefined,
    name: company.name || undefined,
    metadata: { company_id: company.id },
  });
  return customer;
}

async function createCheckoutSession(companyId, priceId, successUrl, cancelUrl, plan = 'pro') {
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
  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: returnUrl,
  });
  return session;
}

async function cancelSubscription(subscriptionId) {
  return stripe.subscriptions.cancel(subscriptionId);
}

module.exports = {
  stripe,
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  cancelSubscription,
};
