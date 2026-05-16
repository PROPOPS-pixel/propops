/**
 * Checkout routes — create Stripe checkout with 14-day free trial.
 *
 * POST /api/checkout/initiate  — Save lead + redirect to Stripe Checkout
 *
 * Flow: email entered on landing page → Stripe Checkout Session created
 * (14-day free trial, $69/mo early bird or $99/mo standard OR $999/year annual) →
 * Stripe webhook creates account + sends welcome email.
 *
 * Plans:
 *   monthly (default) — STRIPE_MONTHLY_PRICE_ID — $69/mo early bird, $99/mo standard
 *   annual            — STRIPE_ANNUAL_PRICE_ID   — $999/year, 14-day free trial
 *
 * Required env vars for trial support:
 *   STRIPE_SECRET_KEY         — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_MONTHLY_PRICE_ID   — Stripe Price ID for monthly plan (price_...)
 *   STRIPE_ANNUAL_PRICE_ID    — Stripe Price ID for $999/yr plan (price_...)
 *
 * Fallback (no STRIPE_SECRET_KEY): redirects to static Stripe payment links
 * (no trial — update links in Stripe Dashboard to add trial as well).
 */

const express = require('express');
const router = express.Router();

// Lazy-init Stripe SDK — only if secret key is configured
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) return null;
  try {
    const Stripe = require('stripe');
    _stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    return _stripe;
  } catch (err) {
    console.error('[Checkout] Failed to init Stripe SDK:', err.message);
    return null;
  }
}

const APP_URL = process.env.APP_URL || 'https://propops.pro';
const TRIAL_DAYS = 14;

router.post('/initiate', async (req, res) => {
  const { email, plan } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  const billingPlan = plan === 'annual' ? 'annual' : 'monthly';

  // ── Save to waitlist/leads (non-blocking) ───────────────────────────────────
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    await pool.query(
      `INSERT INTO waitlist (email, source)
       VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING`,
      [email.toLowerCase(), billingPlan === 'annual' ? 'free_trial_signup_annual' : 'free_trial_signup']
    );
    pool.end();
  } catch (err) {
    console.warn('[Checkout] Failed to save to waitlist:', err.message);
  }

  // ── Primary path: Stripe Checkout Session with 14-day trial ────────────────
  const stripe = getStripe();
  const priceId = billingPlan === 'annual'
    ? process.env.STRIPE_ANNUAL_PRICE_ID
    : process.env.STRIPE_MONTHLY_PRICE_ID;

  if (stripe && priceId) {
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer_email: email.toLowerCase(),
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: TRIAL_DAYS,
        },
        payment_method_collection: 'always', // Collect card upfront — no charge for 14 days
        success_url: `${APP_URL}/signup-success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/checkout.html?email=${encodeURIComponent(email.toLowerCase())}&plan=${billingPlan}`,
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        metadata: {
          plan: billingPlan,
          source: 'web_checkout',
        },
      });

      console.log(`[Checkout] ✅ Stripe session created for ${email} (plan: ${billingPlan}, trial: ${TRIAL_DAYS} days) — ${session.id}`);

      return res.json({
        success: true,
        url: session.url,
        plan: billingPlan,
        trial_days: TRIAL_DAYS,
      });
    } catch (err) {
      console.error('[Checkout] Stripe session creation failed:', err.message);
      // Fall through to payment link fallback
    }
  } else {
    if (!stripe) {
      console.warn('[Checkout] STRIPE_SECRET_KEY not set — falling back to static payment links (no trial)');
    } else if (!priceId) {
      console.warn(`[Checkout] ${billingPlan === 'annual' ? 'STRIPE_ANNUAL_PRICE_ID' : 'STRIPE_MONTHLY_PRICE_ID'} not set — falling back to static payment links (no trial)`);
    }
  }

  // ── Fallback: static Stripe payment links (no trial unless configured in Dashboard) ──
  const monthlyUrl = process.env.STRIPE_SUBSCRIPTION_URL || 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a';
  const annualUrl = process.env.STRIPE_ANNUAL_URL || 'https://buy.stripe.com/9B63cvams0H37VvfkEdby09';
  const baseStripeUrl = billingPlan === 'annual' ? annualUrl : monthlyUrl;
  const stripeUrl = baseStripeUrl + '?prefilled_email=' + encodeURIComponent(email.toLowerCase());

  console.log(`[Checkout] Redirecting ${email} to static Stripe link (plan: ${billingPlan})`);

  return res.json({
    success: true,
    url: stripeUrl,
    plan: billingPlan,
  });
});

module.exports = router;
