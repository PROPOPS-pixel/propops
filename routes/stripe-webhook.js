/**
 * Stripe webhook — handles payment events.
 *
 * POST /api/stripe/webhook
 *
 * Events handled:
 *   checkout.session.completed        → create user account + send welcome email
 *   customer.subscription.trial_will_end → send trial reminder
 *   customer.subscription.deleted     → mark account as cancelled
 *   invoice.payment_failed            → mark account as past_due
 *   invoice.paid                      → mark subscription as active after trial
 *   customer.subscription.updated    → reactivate cancelled users on re-subscribe
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

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

// Stripe webhooks send raw body — must be before express.json()
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    console.error('[Stripe Webhook] Failed to parse body:', err.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log(`[Stripe Webhook] Event: ${event.type}`);

  try {
    const auth = require('../services/auth');
    const { sendWelcomeEmail, sendTrialReminderEmail } = require('../services/email');
    const pool = getPool();

    switch (event.type) {
      // ── Checkout completed: user just paid ──────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        const name = session.customer_details?.name;
        const sessionId = session.id;
        const customerId = session.customer;

        if (!email) {
          console.warn('[Stripe Webhook] No email in checkout session:', sessionId);
          break;
        }

        console.log(`[Stripe Webhook] ✅ Checkout complete for ${email}`);

        const user = await auth.createUser({ email, name, stripeSessionId: sessionId });

        // Store Stripe customer ID
        if (customerId) {
          await pool.query(
            'UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE id = $2',
            [customerId, user.id]
          );
        }

        // Send welcome email if not already sent
        if (!user.welcome_email_sent) {
          const emailResult = await sendWelcomeEmail({ email: user.email, name: user.name || name });
          if (emailResult && emailResult.ok) {
            await auth.markWelcomeEmailSent(user.id);
            console.log(`[Stripe Webhook] ✅ Welcome email sent to ${email} via ${emailResult.provider}`);
          } else {
            console.error(`[Stripe Webhook] ❌ Welcome email FAILED for ${email} — queued for retry`);
          }
        }

        break;
      }

      // ── Trial ending soon (Stripe fires ~3 days before) ─────────────────────
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (!customerId) break;

        const result = await pool.query('SELECT * FROM users WHERE stripe_customer_id = $1', [customerId]);
        const user = result.rows[0];

        if (!user) {
          console.warn(`[Stripe Webhook] No user found for Stripe customer: ${customerId}`);
          break;
        }

        if (!user.trial_reminder_sent) {
          const daysLeft = auth.getDaysLeft(user.trial_end);
          await sendTrialReminderEmail({ email: user.email, name: user.name, daysLeft: Math.max(daysLeft, 3) });
          await auth.markTrialReminderSent(user.id);
          console.log(`[Stripe Webhook] ✅ Trial reminder sent to ${user.email}`);
        }

        break;
      }

      // ── Invoice paid: activate subscription (handles trial→active AND re-subscription) ──
      case 'invoice.paid': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (!customerId) break;

        // Activate ANY user with this Stripe customer ID — including cancelled re-subscriptions.
        // Previous bug: WHERE clause excluded 'cancelled' users, so re-subscriptions stayed cancelled.
        const activateResult = await pool.query(
          `UPDATE users SET subscription_status = 'active', updated_at = NOW()
           WHERE stripe_customer_id = $1 AND subscription_status != 'active'`,
          [customerId]
        );

        if (activateResult.rowCount > 0) {
          console.log(`[Stripe Webhook] ✅ Subscription activated for customer: ${customerId} (${activateResult.rowCount} row(s))`);
        } else {
          // No user found by stripe_customer_id — try looking up by invoice email
          // Handles case where new agents pay before user record has stripe_customer_id set
          const customerEmail = invoice.customer_email;
          if (customerEmail) {
            const emailResult = await pool.query(
              `UPDATE users SET subscription_status = 'active', stripe_customer_id = $1, updated_at = NOW()
               WHERE LOWER(email) = $2 AND subscription_status != 'active'`,
              [customerId, customerEmail.toLowerCase()]
            );
            if (emailResult.rowCount > 0) {
              console.log(`[Stripe Webhook] ✅ Subscription activated by email for: ${customerEmail} (customer: ${customerId})`);
            } else {
              console.log(`[Stripe Webhook] invoice.paid — no matching user for customer: ${customerId} (email: ${customerEmail || 'none'})`);
            }
          } else {
            console.log(`[Stripe Webhook] invoice.paid — already active or no user for customer: ${customerId}`);
          }
        }
        break;
      }

      // ── Subscription updated (re-subscribe, plan change, etc.) ────────────
      // Stripe shows these as "Subscription update" — critical for re-subscriptions
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (!customerId) break;

        // If subscription is now active/trialing, ensure user status matches
        const subStatus = sub.status; // 'active', 'trialing', 'canceled', 'past_due', etc.
        if (subStatus === 'active') {
          const result = await pool.query(
            `UPDATE users SET subscription_status = 'active', updated_at = NOW()
             WHERE stripe_customer_id = $1 AND subscription_status != 'active'`,
            [customerId]
          );
          if (result.rowCount > 0) {
            console.log(`[Stripe Webhook] ✅ Subscription re-activated via update for customer: ${customerId}`);
          }
        } else if (subStatus === 'trialing') {
          await pool.query(
            `UPDATE users SET subscription_status = 'trial', updated_at = NOW()
             WHERE stripe_customer_id = $1 AND subscription_status IN ('cancelled', 'canceled')`,
            [customerId]
          );
          console.log(`[Stripe Webhook] Subscription trialing for customer: ${customerId}`);
        }
        break;
      }

      // ── Subscription cancelled ──────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        if (!customerId) break;

        await pool.query(
          `UPDATE users SET subscription_status = 'cancelled', updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
        console.log(`[Stripe Webhook] Subscription cancelled for customer: ${customerId}`);
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        if (!customerId) break;

        await pool.query(
          `UPDATE users SET subscription_status = 'past_due', updated_at = NOW()
           WHERE stripe_customer_id = $1`,
          [customerId]
        );
        console.log(`[Stripe Webhook] Payment failed for customer: ${customerId}`);
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error(`[Stripe Webhook] Error processing ${event.type}:`, err.message);
    // Return 200 to avoid Stripe retrying unnecessarily
  }

  res.json({ received: true });
});

module.exports = router;
