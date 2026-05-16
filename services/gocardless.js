/**
 * GoCardless API service — Direct Debit billing for Australia.
 *
 * Uses GoCardless Billing Requests flow:
 *   1. Create billing request (mandate_request for AUD BECS Direct Debit)
 *   2. Create billing request flow (hosted page URL)
 *   3. Redirect user to authorisation_url
 *   4. GoCardless redirects back to our success URL on completion
 *   5. Webhook: billing_requests.fulfilled → create subscription (14-day trial)
 *
 * Required env vars:
 *   GOCARDLESS_ACCESS_TOKEN  — Live API token (Bearer auth)
 *   GOCARDLESS_WEBHOOK_SECRET — Webhook secret for HMAC-SHA256 verification
 *
 * GoCardless REST API: https://api.gocardless.com (live)
 */

const https = require('https');
const crypto = require('crypto');

const GC_BASE_URL = 'https://api.gocardless.com';
const GC_VERSION = '2015-07-06';
const TRIAL_DAYS = 14;
const MONTHLY_AMOUNT_CENTS = 14900; // $149.00 AUD
const ANNUAL_AMOUNT_CENTS = 150000; // $1,500.00 AUD (legacy, kept for backward compat)

// ─── Office Plan Config ───────────────────────────────────────────────────────
// Maps plan code → { amountCents, name, description, intervalUnit }
const OFFICE_PLANS = {
  'monthly': { amountCents: 14900, name: 'PropOps.Pro — $149/month', intervalUnit: 'monthly' },
  'office-2': { amountCents: 26900, name: 'Office 2 — $269/month', intervalUnit: 'monthly' },
  'office-3': { amountCents: 34900, name: 'Office 3 — $349/month', intervalUnit: 'monthly' },
  'office-4': { amountCents: 42900, name: 'Office 4 — $429/month', intervalUnit: 'monthly' },
  'office-5': { amountCents: 50000, name: 'Office 5 — $500/month', intervalUnit: 'monthly' },
};

// Maps GoCardless Billing Request Template IDs → plan code
const BRT_TEMPLATE_PLAN_MAP = {
  'BRT000516GT7HES': 'monthly',  // legacy — keep for in-flight billing requests
  'BRT00051HY4XEZW': 'monthly',  // current PropOps.Pro BRT
  'BRT00051HVFJT23': 'office-2',
  'BRT00051HRXHMN0': 'office-3',
  'BRT00051HSR5FP6': 'office-4',
  'BRT00051HTC8F1V': 'office-5',
};

// ─── Low-level HTTP helper ────────────────────────────────────────────────────

function gcRequest(method, path, body = null) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not set');

  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: 'api.gocardless.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'GoCardless-Version': GC_VERSION,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed);
        } else {
          const errMsg = parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`;
          const err = new Error(`GoCardless API error: ${errMsg}`);
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Billing Requests ─────────────────────────────────────────────────────────

/**
 * Create a GoCardless billing request with mandate setup.
 * Returns the billing request object with ID for later use.
 */
async function createBillingRequest({ plan = 'monthly' }) {
  const isAnnual = plan === 'annual';
  let description;
  if (isAnnual) {
    description = 'PropOps Pro — $1,500/year Direct Debit';
  } else if (OFFICE_PLANS[plan]) {
    description = `${OFFICE_PLANS[plan].name} Direct Debit`;
  } else {
    description = 'PropOps Pro — $149/month Direct Debit';
  }

  const result = await gcRequest('POST', '/billing_requests', {
    billing_requests: {
      mandate_request: {
        currency: 'AUD',
        description,
      },
      metadata: {
        plan,
        source: 'web_checkout',
      },
    },
  });
  return result.billing_requests;
}

/**
 * Create a billing request flow (hosted page URL).
 * Returns object with `authorisation_url` to redirect the user to.
 */
async function createBillingRequestFlow({ billingRequestId, successUrl, exitUrl, email }) {
  const body = {
    billing_request_flows: {
      redirect_uri: successUrl,
      exit_uri: exitUrl,
      links: {
        billing_request: billingRequestId,
      },
    },
  };

  // Prefill customer email in the flow (GoCardless requires this on the flow, not the billing request)
  if (email) {
    body.billing_request_flows.prefilled_customer = { email };
  }

  const result = await gcRequest('POST', '/billing_request_flows', body);
  return result.billing_request_flows;
}

/**
 * Fetch a billing request by ID.
 */
async function getBillingRequest(billingRequestId) {
  const result = await gcRequest('GET', `/billing_requests/${billingRequestId}`);
  return result.billing_requests;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

/**
 * Create a monthly $149 AUD subscription starting after the 14-day trial.
 * @param {string} mandateId — The GC mandate ID from the fulfilled billing request.
 * @returns The created subscription object.
 */
async function createMonthlySubscription(mandateId) {
  const startDate = getTrialEndDate();

  const result = await gcRequest('POST', '/subscriptions', {
    subscriptions: {
      amount: MONTHLY_AMOUNT_CENTS,
      currency: 'AUD',
      name: 'PropOps Pro — $149/month',
      interval_unit: 'monthly',
      day_of_month: startDate.getDate() > 28 ? 28 : startDate.getDate(),
      start_date: formatDate(startDate),
      links: {
        mandate: mandateId,
      },
      metadata: {
        plan: 'monthly',
        source: 'propops_backend',
      },
    },
  });
  return result.subscriptions;
}

/**
 * Create a yearly $1,500 AUD subscription starting after the 14-day trial.
 * @param {string} mandateId — The GC mandate ID from the fulfilled billing request.
 * @returns The created subscription object.
 */
async function createAnnualSubscription(mandateId) {
  const startDate = getTrialEndDate();

  const result = await gcRequest('POST', '/subscriptions', {
    subscriptions: {
      amount: ANNUAL_AMOUNT_CENTS,
      currency: 'AUD',
      name: 'PropOps Pro — $1,500/year',
      interval_unit: 'yearly',
      start_date: formatDate(startDate),
      links: {
        mandate: mandateId,
      },
      metadata: {
        plan: 'annual',
        source: 'propops_backend',
      },
    },
  });
  return result.subscriptions;
}

/**
 * Create a subscription for any plan (monthly, annual, office-2 through office-5).
 * All plans start after the 14-day trial period.
 * @param {string} mandateId — The GC mandate ID.
 * @param {string} plan — 'monthly', 'annual', 'office-2', 'office-3', 'office-4', 'office-5'.
 * @returns The created subscription object.
 */
async function createSubscription(mandateId, plan = 'monthly') {
  if (plan === 'annual') {
    return createAnnualSubscription(mandateId);
  }

  const planConfig = OFFICE_PLANS[plan];
  if (planConfig) {
    const startDate = getTrialEndDate();
    const result = await gcRequest('POST', '/subscriptions', {
      subscriptions: {
        amount: planConfig.amountCents,
        currency: 'AUD',
        name: planConfig.name,
        interval_unit: planConfig.intervalUnit,
        day_of_month: startDate.getDate() > 28 ? 28 : startDate.getDate(),
        start_date: formatDate(startDate),
        links: { mandate: mandateId },
        metadata: { plan, source: 'propops_backend' },
      },
    });
    return result.subscriptions;
  }

  // Fallback to monthly
  return createMonthlySubscription(mandateId);
}

/**
 * Resolve plan code from a GoCardless billing request template ID.
 * Returns the plan code string or 'monthly' as default.
 * @param {string} templateId — BRT template ID (e.g. 'BRT000516GT7HES')
 */
function getPlanFromTemplateId(templateId) {
  return BRT_TEMPLATE_PLAN_MAP[templateId] || 'monthly';
}

/**
 * Cancel a GoCardless subscription immediately.
 * @param {string} subscriptionId
 */
async function cancelSubscription(subscriptionId) {
  const result = await gcRequest('POST', `/subscriptions/${subscriptionId}/actions/cancel`, {});
  return result.subscriptions;
}

/**
 * Get a subscription by ID.
 */
async function getSubscription(subscriptionId) {
  const result = await gcRequest('GET', `/subscriptions/${subscriptionId}`);
  return result.subscriptions;
}

/**
 * List all subscriptions for a mandate.
 * Used to detect auto-created subscriptions from BRT templates.
 * @param {string} mandateId
 */
async function listSubscriptionsForMandate(mandateId) {
  const result = await gcRequest('GET', `/subscriptions?mandate=${mandateId}`);
  return result.subscriptions || [];
}

/**
 * List payments for a subscription (to cancel pending payments).
 * @param {string} subscriptionId
 */
async function listPaymentsForSubscription(subscriptionId) {
  const result = await gcRequest('GET', `/payments?subscription=${subscriptionId}`);
  return result.payments || [];
}

/**
 * Cancel a pending payment.
 * Only works on payments in pending_submission or pending_customer_approval status.
 * @param {string} paymentId
 */
async function cancelPayment(paymentId) {
  const result = await gcRequest('POST', `/payments/${paymentId}/actions/cancel`, {});
  return result.payments;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * List all mandates from GoCardless.
 * Returns array of mandate objects with links.customer.
 */
async function listAllMandates() {
  const result = await gcRequest('GET', '/mandates');
  return result.mandates || [];
}

/**
 * Get a GoCardless customer by ID.
 * @param {string} customerId
 */
async function getCustomer(customerId) {
  const result = await gcRequest('GET', `/customers/${customerId}`);
  return result.customers;
}

/**
 * Verify GoCardless webhook HMAC-SHA256 signature.
 * GoCardless sends `Webhook-Signature` header = HMAC-SHA256(body, webhook_secret)
 */
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[GoCardless] GOCARDLESS_WEBHOOK_SECRET not set — skipping signature check');
    return true; // Don't block webhooks if secret isn't configured yet
  }
  const expected = crypto.createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTrialEndDate() {
  const d = new Date();
  d.setDate(d.getDate() + TRIAL_DAYS);
  return d;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function isConfigured() {
  return !!process.env.GOCARDLESS_ACCESS_TOKEN;
}

module.exports = {
  createBillingRequest,
  createBillingRequestFlow,
  getBillingRequest,
  createMonthlySubscription,
  createAnnualSubscription,
  createSubscription,
  cancelSubscription,
  getSubscription,
  listSubscriptionsForMandate,
  listPaymentsForSubscription,
  cancelPayment,
  listAllMandates,
  getCustomer,
  verifyWebhookSignature,
  isConfigured,
  getPlanFromTemplateId,
  BRT_TEMPLATE_PLAN_MAP,
  OFFICE_PLANS,
  TRIAL_DAYS,
};
