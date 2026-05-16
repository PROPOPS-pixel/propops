/**
 * GoCardless webhook handler.
 *
 * POST /api/gocardless/webhook
 *
 * Events handled:
 *   billing_requests.fulfilled    → mandate ready — create subscription with 14-day trial
 *   subscriptions.cancelled       → mark cancelled + 7-day grace period
 *   payments.paid_out             → mark subscription as active (trial → active)
 *   payments.failed               → mark payment_failed + 7-day grace period
 *   payments.cancelled            → mark payment_failed + 7-day grace period
 *   mandates.cancelled            → mark cancelled + 7-day grace period
 *   mandates.failed               → mark payment_failed + 7-day grace period
 *
 * Signature: HMAC-SHA256(raw_body, GOCARDLESS_WEBHOOK_SECRET)
 * Header: Webhook-Signature
 * Invalid signature → 498
 */

const express = require('express');
const router = express.Router();
const gc = require('../services/gocardless');
const { Pool } = require('pg');

const GRACE_PERIOD_DAYS = 7;

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// GoCardless webhooks send raw JSON — must be before express.json()
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const rawBody = req.body; // Buffer
  const signature = req.headers['webhook-signature'];

  // ── Verify signature ─────────────────────────────────────────────────────
  if (!gc.verifyWebhookSignature(rawBody, signature)) {
    console.warn('[GC Webhook] ❌ Invalid signature');
    return res.status(498).json({ error: 'Invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[GC Webhook] Failed to parse body:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const events = payload.events || [];
  console.log(`[GC Webhook] Received ${events.length} event(s)`);

  for (const event of events) {
    const { resource_type, action, links } = event;
    console.log(`[GC Webhook] Event: ${resource_type}.${action}`);

    try {
      await handleEvent(resource_type, action, links, event);
    } catch (err) {
      console.error(`[GC Webhook] Error handling ${resource_type}.${action}:`, err.message);
      // Continue processing other events — don't fail the whole batch
    }
  }

  // Always return 200 so GoCardless doesn't retry
  res.json({ success: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Calculate grace period end timestamp (7 days from now).
 */
function gracePeriodEnd() {
  const d = new Date();
  d.setDate(d.getDate() + GRACE_PERIOD_DAYS);
  return d;
}

/**
 * Apply grace period + cancellation metadata to a user found by a single field.
 * @param {object} pool - PG pool
 * @param {string} whereField - DB column to match (e.g. 'gocardless_subscription_id')
 * @param {string} whereValue - value to match
 * @param {string} newStatus - 'cancelled' or 'payment_failed'
 * @param {object} event - the GC webhook event object
 * @returns {object|null} the updated user row (email) or null if not found
 */
async function applyPaymentIssue(pool, whereField, whereValue, newStatus, event) {
  const reason = event?.details?.cause || event?.details?.description || null;
  const graceEnd = gracePeriodEnd();

  const result = await pool.query(
    `UPDATE users
     SET subscription_status  = $1,
         grace_period_ends_at = $2,
         cancellation_reason  = $3,
         cancelled_at         = NOW(),
         suspension_event     = $4,
         updated_at           = NOW()
     WHERE ${whereField} = $5
     RETURNING id, email, name`,
    [newStatus, graceEnd, reason, `${event.resource_type}.${event.action}`, whereValue]
  );

  if (result.rows[0]) {
    const { id, email } = result.rows[0];
    console.log(
      `[GC Webhook] ✅ ${event.resource_type}.${event.action} → user ${id} (${email}) → status="${newStatus}", grace_period_ends_at=${graceEnd.toISOString().slice(0, 10)}, reason="${reason || 'none'}"`
    );
  } else {
    console.warn(`[GC Webhook] No user found for ${whereField}=${whereValue}`);
  }

  return result.rows[0] || null;
}

// ─── Event handlers ───────────────────────────────────────────────────────────

async function handleEvent(resourceType, action, links, event) {
  const pool = getPool();
  const auth = require('../services/auth');
  const { sendWelcomeEmail } = require('../services/email');

  switch (`${resourceType}.${action}`) {

    // ── Billing request fulfilled: mandate is ready ────────────────────────
    case 'billing_requests.fulfilled': {
      const billingRequestId = links?.billing_request;

      if (!billingRequestId) {
        console.warn('[GC Webhook] billing_requests.fulfilled missing billing_request link — full links:', JSON.stringify(links));
        break;
      }

      // Mandate is NOT in event links for BRT-originated flows.
      // Always fetch the billing request from the API to get mandate + customer details.
      let billingRequest;
      try {
        billingRequest = await gc.getBillingRequest(billingRequestId);
      } catch (err) {
        console.error(`[GC Webhook] Could not fetch billing request ${billingRequestId}:`, err.message);
        break;
      }

      const mandateId = links?.mandate || billingRequest?.links?.mandate;
      if (!mandateId) {
        console.warn(`[GC Webhook] Could not resolve mandate for billing request ${billingRequestId} — links:`, JSON.stringify(links), 'br.links:', JSON.stringify(billingRequest?.links));
        break;
      }

      console.log(`[GC Webhook] Billing request fulfilled: BRQ=${billingRequestId}, mandate=${mandateId}`);

      // ── Cancel any auto-created subscriptions from BRT templates ──────────
      // BRT templates with subscription_request auto-create subscriptions that
      // charge immediately (no trial). We must cancel those before creating ours.
      try {
        const existingSubs = await gc.listSubscriptionsForMandate(mandateId);
        for (const sub of existingSubs) {
          // Skip subscriptions we created (have our metadata marker)
          if (sub.metadata?.source === 'propops_backend') continue;
          // Only cancel active/pending subscriptions
          if (sub.status !== 'active' && sub.status !== 'pending_customer_approval') continue;

          console.log(`[GC Webhook] Cancelling auto-created subscription ${sub.id} (status: ${sub.status}, start_date: ${sub.start_date})`);
          try {
            await gc.cancelSubscription(sub.id);
            console.log(`[GC Webhook] ✅ Cancelled auto-created subscription ${sub.id}`);
          } catch (cancelErr) {
            console.error(`[GC Webhook] Failed to cancel auto-created subscription ${sub.id}:`, cancelErr.message);
          }

          // Cancel any pending payments for the auto-created subscription
          try {
            const payments = await gc.listPaymentsForSubscription(sub.id);
            for (const payment of payments) {
              if (payment.status === 'pending_submission' || payment.status === 'pending_customer_approval' || payment.status === 'submitted') {
                try {
                  await gc.cancelPayment(payment.id);
                  console.log(`[GC Webhook] ✅ Cancelled pending payment ${payment.id} (status: ${payment.status})`);
                } catch (payErr) {
                  console.warn(`[GC Webhook] Could not cancel payment ${payment.id} (status: ${payment.status}):`, payErr.message);
                }
              }
            }
          } catch (payListErr) {
            console.warn(`[GC Webhook] Could not list payments for sub ${sub.id}:`, payListErr.message);
          }
        }
      } catch (subListErr) {
        console.warn(`[GC Webhook] Could not check for auto-created subscriptions on mandate ${mandateId}:`, subListErr.message);
      }

      // ── Resolve plan from billing request ─────────────────────────────────
      const templateId = billingRequest?.links?.billing_request_template;
      const plan = billingRequest?.metadata?.plan
        || (templateId ? gc.getPlanFromTemplateId(templateId) : 'monthly');
      console.log(`[GC Webhook] Resolved plan: ${plan} (template: ${templateId || 'none'})`);

      // ── Find user: first by billing_request_id, then by email ─────────────
      let user = null;

      const userResult = await pool.query(
        'SELECT * FROM users WHERE gocardless_billing_request_id = $1',
        [billingRequestId]
      );
      user = userResult.rows[0] || null;

      if (!user) {
        // BRT-originated flow: user didn't go through our API, no billing_request_id stored.
        // Find by customer email from the billing request.
        const customerEmail = billingRequest?.customer_details?.email
          || billingRequest?.prefilled_customer?.email;
        console.log(`[GC Webhook] No user by billing_request_id — trying email: ${customerEmail || 'unknown'}`);

        if (customerEmail) {
          const emailResult = await pool.query(
            'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
            [customerEmail]
          );
          user = emailResult.rows[0] || null;
        }

        if (!user) {
          console.warn(`[GC Webhook] No user found for BRQ=${billingRequestId} — subscription will be created when user signs up`);
          break;
        }
      }

      // ── Update user with mandate + trial info ─────────────────────────────
      await pool.query(
        `UPDATE users
         SET gocardless_mandate_id          = $1,
             gocardless_billing_request_id  = $2,
             subscription_status            = 'trial',
             trial_start                    = COALESCE(trial_start, NOW()),
             trial_end                      = COALESCE(trial_end, NOW() + INTERVAL '14 days'),
             grace_period_ends_at           = NULL,
             updated_at                     = NOW()
         WHERE id = $3`,
        [mandateId, billingRequestId, user.id]
      );

      // ── Create subscription with 14-day trial delay ───────────────────────
      if (!user.gocardless_subscription_id) {
        try {
          const subscription = await gc.createSubscription(mandateId, plan);
          await pool.query(
            `UPDATE users SET gocardless_subscription_id = $1, subscription_plan = $2, updated_at = NOW() WHERE id = $3`,
            [subscription.id, plan, user.id]
          );
          console.log(`[GC Webhook] ✅ ${plan} subscription created: ${subscription.id} for user ${user.id} (${user.email}), starts ${subscription.start_date}`);
        } catch (err) {
          console.error(`[GC Webhook] Failed to create ${plan} subscription for user ${user.id}:`, err.message);
        }
      } else {
        console.log(`[GC Webhook] Subscription already exists for user ${user.id} — skipping creation`);
      }

      // ── Send welcome email if needed ──────────────────────────────────────
      if (!user.welcome_email_sent) {
        const emailResult = await sendWelcomeEmail({ email: user.email, name: user.name });
        if (emailResult && emailResult.ok) {
          await auth.markWelcomeEmailSent(user.id);
          console.log(`[GC Webhook] ✅ Welcome email sent to ${user.email}`);
        }
      }

      break;
    }

    // ── Subscription auto-created by BRT template (safety net) ─────────────
    // If a BRT template has subscription_request, GoCardless creates a
    // subscription automatically. If our billing_requests.fulfilled handler
    // didn't catch it (e.g., billing_request link was also missing), this
    // handler cancels the auto-created subscription to prevent immediate charges.
    case 'subscriptions.created': {
      const subscriptionId = links?.subscription;
      if (!subscriptionId) break;

      try {
        const sub = await gc.getSubscription(subscriptionId);
        // If this subscription was created by our backend, skip it
        if (sub?.metadata?.source === 'propops_backend') {
          console.log(`[GC Webhook] subscriptions.created: ${subscriptionId} is ours (propops_backend) — no action needed`);
          break;
        }

        // Auto-created subscription without our metadata — cancel it
        // Our billing_requests.fulfilled handler should have already created the proper one.
        // This is a safety net in case that handler didn't run.
        if (sub?.status === 'active') {
          console.log(`[GC Webhook] subscriptions.created: ${subscriptionId} is auto-created (no propops_backend metadata, start_date: ${sub.start_date}) — cancelling`);
          await gc.cancelSubscription(subscriptionId);
          console.log(`[GC Webhook] ✅ Cancelled auto-created subscription ${subscriptionId}`);

          // Cancel pending payments
          try {
            const payments = await gc.listPaymentsForSubscription(subscriptionId);
            for (const payment of payments) {
              if (['pending_submission', 'pending_customer_approval', 'submitted'].includes(payment.status)) {
                try {
                  await gc.cancelPayment(payment.id);
                  console.log(`[GC Webhook] ✅ Cancelled pending payment ${payment.id}`);
                } catch (payErr) {
                  console.warn(`[GC Webhook] Could not cancel payment ${payment.id}:`, payErr.message);
                }
              }
            }
          } catch (payListErr) {
            console.warn(`[GC Webhook] Could not list payments for auto-created sub ${subscriptionId}:`, payListErr.message);
          }
        }
      } catch (err) {
        console.warn(`[GC Webhook] Could not check subscription ${subscriptionId}:`, err.message);
      }
      break;
    }

    // ── Payment paid out: trial converted → active ─────────────────────────
    case 'payments.paid_out': {
      const subscriptionId = links?.subscription;
      if (!subscriptionId) break;

      const result = await pool.query(
        `UPDATE users
         SET subscription_status  = 'active',
             grace_period_ends_at = NULL,
             updated_at           = NOW()
         WHERE gocardless_subscription_id = $1
           AND subscription_status IN ('trial', 'past_due', 'payment_failed')
         RETURNING email`,
        [subscriptionId]
      );

      if (result.rows[0]) {
        console.log(`[GC Webhook] ✅ Subscription activated for ${result.rows[0].email}`);
      }
      break;
    }

    // ── Payment failed ─────────────────────────────────────────────────────
    case 'payments.failed': {
      const subscriptionId = links?.subscription;
      if (!subscriptionId) break;

      await applyPaymentIssue(pool, 'gocardless_subscription_id', subscriptionId, 'payment_failed', event);
      break;
    }

    // ── Payment cancelled ──────────────────────────────────────────────────
    case 'payments.cancelled': {
      const subscriptionId = links?.subscription;
      if (!subscriptionId) break;

      await applyPaymentIssue(pool, 'gocardless_subscription_id', subscriptionId, 'payment_failed', event);
      break;
    }

    // ── Subscription cancelled ─────────────────────────────────────────────
    case 'subscriptions.cancelled': {
      const subscriptionId = links?.subscription;
      if (!subscriptionId) break;

      await applyPaymentIssue(pool, 'gocardless_subscription_id', subscriptionId, 'cancelled', event);
      break;
    }

    // ── Mandate cancelled (e.g., bank revoked or customer cancelled) ───────
    case 'mandates.cancelled': {
      const mandateId = links?.mandate;
      if (!mandateId) break;

      await applyPaymentIssue(pool, 'gocardless_mandate_id', mandateId, 'cancelled', event);
      break;
    }

    // ── Mandate failed (setup failure) ─────────────────────────────────────
    case 'mandates.failed': {
      const mandateId = links?.mandate;
      if (!mandateId) break;

      await applyPaymentIssue(pool, 'gocardless_mandate_id', mandateId, 'payment_failed', event);
      break;
    }

    default:
      break;
  }
}

module.exports = router;
