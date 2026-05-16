/**
 * Billing routes — Stripe payment links for PropOps subscriptions.
 *
 * POST /api/billing/initiate  — Redirect to Stripe payment link
 * POST /api/billing/cancel    — Cancel active subscription (requires auth)
 * GET  /api/billing/status     — Check subscription status (requires auth)
 *
 * Flow:
 *   1. User clicks "Start Free Trial" on pricing page
 *   2. Redirected directly to Stripe hosted checkout page
 *   3. After payment, redirected to /signup/success
 *   4. User completes account setup → POST /api/auth/signup-complete
 *
 * Required env vars:
 *   STRIPE_SUBSCRIPTION_URL — Monthly payment link ($69/mo early bird, $99/mo standard)
 *   STRIPE_ANNUAL_URL       — Annual payment link ($999/yr)
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');

const APP_URL = process.env.APP_URL || 'https://propops.pro';
const STRIPE_MONTHLY_URL = process.env.STRIPE_SUBSCRIPTION_URL || 'https://buy.stripe.com/dRmbJ1bqw89v4Jj0pKdby0a';
const STRIPE_ANNUAL_URL = process.env.STRIPE_ANNUAL_URL || 'https://buy.stripe.com/9B63cvams0H37VvfkEdby09';

// ─── POST /api/billing/initiate ───────────────────────────────────────────────

router.post('/initiate', async (req, res) => {
  const { email, plan } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Valid email required' });
  }

  const billingPlan = ['monthly', 'annual'].includes(plan) ? plan : 'monthly';

  // Save to waitlist (non-blocking)
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
      [email.toLowerCase(), `stripe_signup_${billingPlan}`]
    );
    pool.end();
  } catch (err) {
    console.warn('[Billing] Failed to save to waitlist:', err.message);
  }

  // Redirect to Stripe payment link
  const stripeUrl = billingPlan === 'annual' ? STRIPE_ANNUAL_URL : STRIPE_MONTHLY_URL;
  const exitUrl = `${APP_URL}/checkout?email=${encodeURIComponent(email.toLowerCase())}&plan=${billingPlan}`;

  // Append email + plan as query params so Stripe can include them in success redirect
  const paymentUrl = new URL(stripeUrl);
  paymentUrl.searchParams.set('email', email.toLowerCase());
  paymentUrl.searchParams.set('plan', billingPlan);

  console.log(`[Billing] Redirecting ${email} to Stripe (plan: ${billingPlan})`);

  return res.json({
    success: true,
    url: paymentUrl.toString(),
    plan: billingPlan,
  });
});

// ─── POST /api/billing/cancel ─────────────────────────────────────────────────
// Cancel the authenticated user's active subscription.
// Note: Stripe payment links don't create managed subscriptions.
// This marks the local account as cancelled. Owner must handle Stripe separately.

router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const auth = require('../services/auth');
    const user = await auth.getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (user.subscription_status === 'cancelled') {
      return res.json({ success: true, message: 'Subscription already cancelled' });
    }

    // Update local DB — Stripe cancellations must be done via Stripe dashboard
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
    await pool.query(
      `UPDATE users SET subscription_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [req.userId]
    );
    pool.end();

    console.log(`[Billing] ✅ Subscription cancelled for user ${req.userId} (${user.email})`);

    return res.json({
      success: true,
      message: 'Subscription cancelled locally. Please cancel your Stripe subscription at dashboard.stripe.com if applicable.',
    });
  } catch (err) {
    console.error('[Billing] Cancel error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
  }
});

// ─── GET /api/billing/status ──────────────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
  try {
    const auth = require('../services/auth');
    const user = await auth.getUserById(req.userId);

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const daysLeft = auth.getDaysLeft(user.trial_end);

    // If trial has expired but status is still 'trial', treat as active.
    const effectiveStatus = (user.subscription_status === 'trial' && daysLeft === 0)
      ? 'active'
      : user.subscription_status;

    return res.json({
      success: true,
      subscription_status: effectiveStatus,
      raw_status: user.subscription_status,
      trial_end: user.trial_end,
      days_left: daysLeft,
      cancelled_at: user.cancelled_at,
      stripe_customer_id: user.stripe_customer_id || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;