/**
 * PAYDECK routes — staff, roster, invoices, payroll for Premium operators.
 *
 * Owns: staff_members, roster_entries, invoices, payroll_entries CRUD
 *       + Australian payroll compliance (super 11.5%, PAYG tax ATO 2025-26, GST 10%).
 * Does NOT own: Hugo brain logic, billing subscription management, auth.
 *
 * All routes require auth. PAYDECK endpoints additionally require subscription_tier = 'premium'.
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { requireAuth } = require('./auth');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Premium Stripe subscription URL — $149/month, PropOps Stripe account
const PREMIUM_STRIPE_URL = process.env.STRIPE_PREMIUM_URL || 'https://buy.stripe.com/7sY4gzeCI75rb7H1tOdby0b';

// ─── Australian Payroll Compliance Logic ──────────────────────────────────────

// Superannuation rate: 11.5% of ordinary time earnings (FY2025-26)
const SUPER_RATE = 0.115;

// GST rate: 10% on invoices for GST-registered operators
const GST_RATE = 0.10;

/**
 * Calculate PAYG withholding from gross annual income.
 * Uses ATO 2025-26 weekly/fortnightly extrapolation to annual then applies brackets.
 * Returns withholding amount for the given gross pay (period-based, not annual).
 *
 * ATO 2025-26 tax brackets (resident, no HELP/HECS):
 *   $0       – $18,200 = Nil
 *   $18,201  – $45,000 = 19c for each $1 over $18,200
 *   $45,001  – $120,000 = $5,092 + 32.5c for each $1 over $45,000
 *   $120,001 – $180,000 = $29,467 + 37c for each $1 over $120,000
 *   $180,001+           = $51,667 + 45c for each $1 over $180,000
 *
 * Low Income Tax Offset (LITO) max $700, phases out $37,500–$66,667 then $66,667–$121,000.
 * Low and Middle Income Tax Offset (LMITO) no longer applies from FY2023-24.
 *
 * @param {number} grossPay   Gross pay for the period
 * @param {number} hoursInPeriod  Hours worked in the period (to annualise)
 * @param {number} hourlyRate   Staff hourly rate (for annualisation)
 * @param {string} tfnStatus  'provided' | 'not_provided' | 'exemption'
 * @returns {number} tax withheld for this period (rounded to 2dp)
 */
function calculatePAYG(grossPay, hoursInPeriod, hourlyRate, tfnStatus) {
  if (!grossPay || grossPay <= 0) return 0;

  // No TFN → withhold at 47% (ATO requirement, top marginal + Medicare)
  if (tfnStatus === 'not_provided') {
    return Math.round(grossPay * 0.47 * 100) / 100;
  }

  // Annualise: use hours worked if available, otherwise treat period pay as 1/26th fortnightly
  let annualIncome;
  if (hoursInPeriod && hoursInPeriod > 0 && hourlyRate && hourlyRate > 0) {
    // Full-time hours = 38/week; assume this period scales to annual
    const weeksInPeriod = hoursInPeriod / 38;
    const periodsPerYear = 52 / Math.max(weeksInPeriod, 0.1);
    annualIncome = grossPay * Math.min(periodsPerYear, 52); // cap at 52 pays
  } else {
    // Assume fortnightly — 26 periods per year
    annualIncome = grossPay * 26;
  }

  // Annual tax before offsets (ATO 2025-26 brackets)
  let annualTax = 0;
  if (annualIncome <= 18200) {
    annualTax = 0;
  } else if (annualIncome <= 45000) {
    annualTax = (annualIncome - 18200) * 0.19;
  } else if (annualIncome <= 120000) {
    annualTax = 5092 + (annualIncome - 45000) * 0.325;
  } else if (annualIncome <= 180000) {
    annualTax = 29467 + (annualIncome - 120000) * 0.37;
  } else {
    annualTax = 51667 + (annualIncome - 180000) * 0.45;
  }

  // Low Income Tax Offset (LITO) — reduces tax payable
  let lito = 0;
  if (annualIncome <= 37500) {
    lito = 700;
  } else if (annualIncome <= 66667) {
    lito = 700 - (annualIncome - 37500) * (700 / 29167);
  } else if (annualIncome <= 121000) {
    lito = Math.max(0, 700 - (annualIncome - 37500) * 0.015 - (annualIncome - 66667) * 0.015);
  }
  lito = Math.max(0, lito);

  // Medicare Levy: 2% on incomes over $26,000 (reduced below $34,398 under low-income threshold)
  let medicare = 0;
  if (annualIncome > 26000) {
    if (annualIncome <= 34398) {
      // Shade-in zone: 10% of excess above $26,000
      medicare = (annualIncome - 26000) * 0.10;
    } else {
      medicare = annualIncome * 0.02;
    }
  }

  const annualWithholding = Math.max(0, annualTax - lito + medicare);

  // Scale back down to period withholding
  let periodWithholding;
  if (hoursInPeriod && hoursInPeriod > 0 && hourlyRate && hourlyRate > 0) {
    const weeksInPeriod = hoursInPeriod / 38;
    const periodsPerYear = 52 / Math.max(weeksInPeriod, 0.1);
    periodWithholding = annualWithholding / Math.min(periodsPerYear, 52);
  } else {
    periodWithholding = annualWithholding / 26;
  }

  return Math.round(periodWithholding * 100) / 100;
}

/**
 * Calculate superannuation for a gross pay amount.
 * Super is 11.5% of ordinary time earnings (OTE) for FY2025-26.
 */
function calculateSuper(grossPay) {
  if (!grossPay || grossPay <= 0) return 0;
  return Math.round(grossPay * SUPER_RATE * 100) / 100;
}

/**
 * Calculate GST breakdown for an invoice amount.
 * Returns { subtotal, gst_amount, total_inc_gst }
 * If gstRegistered is false, no GST is applied.
 */
function calculateGST(amount, gstRegistered) {
  const total = parseFloat(amount);
  if (!gstRegistered || !total) {
    return { subtotal: total, gst_amount: 0, total_inc_gst: total };
  }
  // Amount entered is always treated as the subtotal (ex-GST)
  const gst_amount = Math.round(total * GST_RATE * 100) / 100;
  const total_inc_gst = Math.round((total + gst_amount) * 100) / 100;
  return { subtotal: total, gst_amount, total_inc_gst };
}

// ─── GET /api/paydeck/summary ─────────────────────────────────────────────────

router.get('/summary', requireAuth, async (req, res) => {
  try {
    const [staff, roster, invoices, payroll, complianceResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN is_active THEN 1 ELSE 0 END) as active FROM staff_members WHERE operator_id = $1`, [req.userId]),
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'scheduled' AND scheduled_date >= CURRENT_DATE THEN 1 ELSE 0 END) as upcoming FROM roster_entries WHERE operator_id = $1`, [req.userId]),
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) as revenue_paid, SUM(CASE WHEN status IN ('sent','overdue') THEN amount ELSE 0 END) as outstanding FROM invoices WHERE operator_id = $1`, [req.userId]),
      pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) as pending_amount FROM payroll_entries WHERE operator_id = $1`, [req.userId]),
      // Compliance summary: super this quarter, PAYG this period, GST collected
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN period_start >= date_trunc('quarter', CURRENT_DATE) THEN super_amount ELSE 0 END), 0) as super_this_quarter,
          COALESCE(SUM(CASE WHEN period_start >= date_trunc('month', CURRENT_DATE) THEN tax_withheld ELSE 0 END), 0) as payg_this_month
        FROM payroll_entries WHERE operator_id = $1
      `, [req.userId]),
    ]);

    // GST collected this quarter from paid invoices
    let gstThisQuarter = 0;
    try {
      const gstResult = await pool.query(`
        SELECT COALESCE(SUM(gst_amount), 0) as gst_collected
        FROM invoices
        WHERE operator_id = $1 AND status = 'paid'
          AND paid_at >= date_trunc('quarter', CURRENT_DATE)
      `, [req.userId]);
      gstThisQuarter = parseFloat(gstResult.rows[0]?.gst_collected || 0);
    } catch(_) {}

    res.json({
      success: true,
      summary: {
        staff: { total: parseInt(staff.rows[0].total), active: parseInt(staff.rows[0].active) },
        roster: { total: parseInt(roster.rows[0].total), upcoming: parseInt(roster.rows[0].upcoming) },
        invoices: {
          total: parseInt(invoices.rows[0].total),
          revenue_paid: parseFloat(invoices.rows[0].revenue_paid || 0),
          outstanding: parseFloat(invoices.rows[0].outstanding || 0),
        },
        payroll: {
          total: parseInt(payroll.rows[0].total),
          pending_amount: parseFloat(payroll.rows[0].pending_amount || 0),
        },
        compliance: {
          super_this_quarter: parseFloat(complianceResult.rows[0]?.super_this_quarter || 0),
          payg_this_month: parseFloat(complianceResult.rows[0]?.payg_this_month || 0),
          gst_this_quarter: gstThisQuarter,
        },
      },
    });
  } catch (err) {
    console.error('[PAYDECK] Summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load summary' });
  }
});

// ─── STAFF ────────────────────────────────────────────────────────────────────

router.get('/staff', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM staff_members WHERE operator_id = $1 ORDER BY is_active DESC, name ASC`,
      [req.userId]
    );
    res.json({ success: true, staff: result.rows });
  } catch (err) {
    console.error('[PAYDECK] Staff list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load staff' });
  }
});

router.post('/staff', requireAuth, async (req, res) => {
  const { name, phone, email, role, hourly_rate, tfn_status } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'Name is required' });
  }
  const validTfn = ['provided', 'not_provided', 'exemption'];
  const tfn = validTfn.includes(tfn_status) ? tfn_status : 'provided';
  try {
    const result = await pool.query(
      `INSERT INTO staff_members (operator_id, name, phone, email, role, hourly_rate, tfn_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, name.trim(), phone || null, email || null, role || 'employee', hourly_rate || null, tfn]
    );
    res.json({ success: true, staff: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Create staff error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create staff member' });
  }
});

router.put('/staff/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, role, hourly_rate, is_active, tfn_status } = req.body;
  const validTfn = ['provided', 'not_provided', 'exemption'];
  const tfn = validTfn.includes(tfn_status) ? tfn_status : undefined;
  try {
    const result = await pool.query(
      `UPDATE staff_members
       SET name = COALESCE($1, name),
           phone = COALESCE($2, phone),
           email = COALESCE($3, email),
           role = COALESCE($4, role),
           hourly_rate = COALESCE($5, hourly_rate),
           is_active = COALESCE($6, is_active),
           tfn_status = COALESCE($7, tfn_status)
       WHERE id = $8 AND operator_id = $9 RETURNING *`,
      [name, phone, email, role, hourly_rate, is_active, tfn || null, id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Staff member not found' });
    res.json({ success: true, staff: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Update staff error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update staff member' });
  }
});

router.delete('/staff/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Soft delete — set inactive instead of hard delete (payroll/roster history)
    await pool.query(
      `UPDATE staff_members SET is_active = false WHERE id = $1 AND operator_id = $2`,
      [id, req.userId]
    );
    res.json({ success: true, message: 'Staff member deactivated' });
  } catch (err) {
    console.error('[PAYDECK] Delete staff error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to deactivate staff member' });
  }
});

// ─── ROSTER ───────────────────────────────────────────────────────────────────

router.get('/roster', requireAuth, async (req, res) => {
  const { start_date, end_date, staff_id } = req.query;
  try {
    let query = `
      SELECT r.*, s.name as staff_name, s.phone as staff_phone, s.role as staff_role
      FROM roster_entries r
      JOIN staff_members s ON r.staff_id = s.id
      WHERE r.operator_id = $1
    `;
    const params = [req.userId];

    if (start_date) { params.push(start_date); query += ` AND r.scheduled_date >= $${params.length}`; }
    if (end_date)   { params.push(end_date);   query += ` AND r.scheduled_date <= $${params.length}`; }
    if (staff_id)   { params.push(staff_id);   query += ` AND r.staff_id = $${params.length}`; }

    query += ` ORDER BY r.scheduled_date ASC, r.start_time ASC`;

    const result = await pool.query(query, params);
    res.json({ success: true, roster: result.rows });
  } catch (err) {
    console.error('[PAYDECK] Roster list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load roster' });
  }
});

router.post('/roster', requireAuth, async (req, res) => {
  const { staff_id, lead_id, job_title, job_address, scheduled_date, start_time, end_time, notes } = req.body;
  if (!staff_id || !scheduled_date) {
    return res.status(400).json({ success: false, message: 'staff_id and scheduled_date are required' });
  }
  try {
    // Verify staff belongs to this operator
    const staffCheck = await pool.query(
      `SELECT id FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [staff_id, req.userId]
    );
    if (!staffCheck.rows[0]) return res.status(400).json({ success: false, message: 'Invalid staff member' });

    const result = await pool.query(
      `INSERT INTO roster_entries (operator_id, staff_id, lead_id, job_title, job_address, scheduled_date, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.userId, staff_id, lead_id || null, job_title || null, job_address || null, scheduled_date, start_time || null, end_time || null, notes || null]
    );
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Create roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create roster entry' });
  }
});

router.put('/roster/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { staff_id, job_title, job_address, scheduled_date, start_time, end_time, status, notes } = req.body;
  try {
    const result = await pool.query(
      `UPDATE roster_entries
       SET staff_id = COALESCE($1, staff_id),
           job_title = COALESCE($2, job_title),
           job_address = COALESCE($3, job_address),
           scheduled_date = COALESCE($4, scheduled_date),
           start_time = COALESCE($5, start_time),
           end_time = COALESCE($6, end_time),
           status = COALESCE($7, status),
           notes = COALESCE($8, notes)
       WHERE id = $9 AND operator_id = $10 RETURNING *`,
      [staff_id, job_title, job_address, scheduled_date, start_time, end_time, status, notes, id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Roster entry not found' });
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Update roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update roster entry' });
  }
});

router.delete('/roster/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE roster_entries SET status = 'cancelled' WHERE id = $1 AND operator_id = $2`,
      [id, req.userId]
    );
    res.json({ success: true, message: 'Roster entry cancelled' });
  } catch (err) {
    console.error('[PAYDECK] Delete roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to cancel roster entry' });
  }
});

// ─── INVOICES ─────────────────────────────────────────────────────────────────

router.get('/invoices', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT i.*, s.name as staff_name
      FROM invoices i
      LEFT JOIN staff_members s ON i.staff_id = s.id
      WHERE i.operator_id = $1
    `;
    const params = [req.userId];
    if (status) { params.push(status); query += ` AND i.status = $${params.length}`; }
    query += ` ORDER BY i.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, invoices: result.rows });
  } catch (err) {
    console.error('[PAYDECK] Invoice list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load invoices' });
  }
});

router.post('/invoices', requireAuth, async (req, res) => {
  const { lead_id, staff_id, customer_name, customer_email, customer_phone, description, amount, due_date } = req.body;
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount required' });
  }
  try {
    // Check operator GST registration
    const userResult = await pool.query(`SELECT gst_registered FROM users WHERE id = $1`, [req.userId]);
    const gstRegistered = userResult.rows[0]?.gst_registered || false;

    // Auto-generate invoice number: INV-YYYYMM-XXXX
    const countResult = await pool.query(
      `SELECT COUNT(*) as cnt FROM invoices WHERE operator_id = $1`,
      [req.userId]
    );
    const num = parseInt(countResult.rows[0].cnt) + 1;
    const now = new Date();
    const invoiceNumber = `INV-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}-${String(num).padStart(4,'0')}`;

    const gst = calculateGST(parseFloat(amount), gstRegistered);

    const result = await pool.query(
      `INSERT INTO invoices (operator_id, lead_id, staff_id, customer_name, customer_email, customer_phone,
                             description, amount, gst_included, due_date, invoice_number,
                             subtotal, gst_amount, total_inc_gst)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.userId, lead_id || null, staff_id || null,
       customer_name || null, customer_email || null, customer_phone || null,
       description || null, parseFloat(amount), gstRegistered, due_date || null, invoiceNumber,
       gst.subtotal, gst.gst_amount, gst.total_inc_gst]
    );
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Create invoice error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create invoice' });
  }
});

// Generate Stripe payment link for an invoice
router.post('/invoices/:id/payment-link', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM invoices WHERE id = $1 AND operator_id = $2`,
      [id, req.userId]
    );
    const invoice = result.rows[0];
    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (invoice.status === 'paid') return res.status(400).json({ success: false, message: 'Invoice already paid' });

    // Use Polsia Stripe proxy to create payment link
    const polsiaApiUrl = process.env.POLSIA_API_URL;
    const polsiaApiKey = process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN;

    if (!polsiaApiUrl || !polsiaApiKey) {
      return res.status(500).json({ success: false, message: 'Payment processing not configured' });
    }

    const productName = invoice.customer_name
      ? `Invoice ${invoice.invoice_number} — ${invoice.customer_name}`
      : `Invoice ${invoice.invoice_number}`;

    // Charge the total-inc-GST amount if GST registered, otherwise charge the base amount
    const chargeAmount = parseFloat(invoice.total_inc_gst || invoice.amount);

    const payResponse = await fetch(
      `${polsiaApiUrl}/api/company-payments/create-payment-link`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${polsiaApiKey}`,
        },
        body: JSON.stringify({
          name: productName,
          amount: chargeAmount,
          description: invoice.description || `PropOps invoice for ${invoice.customer_name || 'customer'}`,
          success_url: `${process.env.APP_URL || 'https://propopspro.polsia.app'}/invoice-paid?invoice_id=${id}`,
        }),
      }
    );

    const payData = await payResponse.json();

    if (!payResponse.ok || !payData.url) {
      console.error('[PAYDECK] Stripe link error:', payData);
      return res.status(500).json({ success: false, message: 'Failed to create payment link' });
    }

    // Save payment link to invoice
    await pool.query(
      `UPDATE invoices SET stripe_payment_link = $1, updated_at = NOW() WHERE id = $2`,
      [payData.url, id]
    );

    res.json({ success: true, payment_link: payData.url, invoice_id: id });
  } catch (err) {
    console.error('[PAYDECK] Payment link error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate payment link' });
  }
});

// Mark invoice as sent
router.post('/invoices/:id/send', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE invoices SET status = 'sent', sent_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND operator_id = $2 AND status = 'draft' RETURNING *`,
      [id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Invoice not found or already sent' });
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Send invoice error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark invoice as sent' });
  }
});

// Mark invoice as paid (manual confirmation)
router.post('/invoices/:id/mark-paid', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE invoices SET status = 'paid', paid_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND operator_id = $2 RETURNING *`,
      [id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Invoice not found' });
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Mark paid error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark invoice as paid' });
  }
});

router.put('/invoices/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { customer_name, customer_email, customer_phone, description, amount, due_date } = req.body;
  try {
    // Recalculate GST if amount is changing
    let gstFields = '';
    const params = [customer_name, customer_email, customer_phone, description, due_date, id, req.userId];
    if (amount) {
      const userResult = await pool.query(`SELECT gst_registered FROM users WHERE id = $1`, [req.userId]);
      const gstRegistered = userResult.rows[0]?.gst_registered || false;
      const gst = calculateGST(parseFloat(amount), gstRegistered);
      gstFields = `, amount = $${params.length + 1}, subtotal = $${params.length + 2}, gst_amount = $${params.length + 3}, total_inc_gst = $${params.length + 4}`;
      params.splice(params.length - 2, 0, parseFloat(amount), gst.subtotal, gst.gst_amount, gst.total_inc_gst);
    }

    const result = await pool.query(
      `UPDATE invoices
       SET customer_name = COALESCE($1, customer_name),
           customer_email = COALESCE($2, customer_email),
           customer_phone = COALESCE($3, customer_phone),
           description = COALESCE($4, description),
           due_date = COALESCE($5, due_date),
           updated_at = NOW()
           ${gstFields}
       WHERE id = $6 AND operator_id = $7 AND status = 'draft' RETURNING *`,
      params
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Invoice not found or not editable' });
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Update invoice error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update invoice' });
  }
});

// ─── GST SETTINGS ─────────────────────────────────────────────────────────────

router.get('/gst-status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT gst_registered FROM users WHERE id = $1`, [req.userId]);
    res.json({ success: true, gst_registered: result.rows[0]?.gst_registered || false });
  } catch (err) {
    console.error('[PAYDECK] GST status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to get GST status' });
  }
});

router.post('/gst-status', requireAuth, async (req, res) => {
  const { gst_registered } = req.body;
  if (typeof gst_registered !== 'boolean') {
    return res.status(400).json({ success: false, message: 'gst_registered must be true or false' });
  }
  try {
    await pool.query(`UPDATE users SET gst_registered = $1 WHERE id = $2`, [gst_registered, req.userId]);
    res.json({ success: true, gst_registered });
  } catch (err) {
    console.error('[PAYDECK] Set GST status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update GST status' });
  }
});

// ─── PAYROLL ──────────────────────────────────────────────────────────────────

router.get('/payroll', requireAuth, async (req, res) => {
  const { staff_id, status } = req.query;
  try {
    let query = `
      SELECT p.*, s.name as staff_name, s.hourly_rate as staff_rate, s.tfn_status
      FROM payroll_entries p
      JOIN staff_members s ON p.staff_id = s.id
      WHERE p.operator_id = $1
    `;
    const params = [req.userId];
    if (staff_id) { params.push(staff_id); query += ` AND p.staff_id = $${params.length}`; }
    if (status)   { params.push(status);   query += ` AND p.status = $${params.length}`; }
    query += ` ORDER BY p.period_end DESC`;

    const result = await pool.query(query, params);
    res.json({ success: true, payroll: result.rows });
  } catch (err) {
    console.error('[PAYDECK] Payroll list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load payroll' });
  }
});

router.post('/payroll', requireAuth, async (req, res) => {
  const { staff_id, period_start, period_end, hours_worked, notes } = req.body;
  if (!staff_id || !period_start || !period_end) {
    return res.status(400).json({ success: false, message: 'staff_id, period_start, period_end required' });
  }
  try {
    // Get staff details for calculations
    const staffResult = await pool.query(
      `SELECT hourly_rate, tfn_status FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [staff_id, req.userId]
    );
    const staffMember = staffResult.rows[0];
    if (!staffMember) return res.status(400).json({ success: false, message: 'Staff member not found' });

    // Calculate gross pay
    let grossAmount = req.body.amount ? parseFloat(req.body.amount) : null;
    if (!grossAmount && hours_worked && staffMember.hourly_rate) {
      grossAmount = parseFloat(hours_worked) * parseFloat(staffMember.hourly_rate);
    }

    // Calculate compliance fields
    const super_amount = grossAmount ? calculateSuper(grossAmount) : null;
    const tax_withheld = grossAmount
      ? calculatePAYG(grossAmount, parseFloat(hours_worked) || null, parseFloat(staffMember.hourly_rate) || null, staffMember.tfn_status)
      : null;
    const net_pay = grossAmount && super_amount !== null && tax_withheld !== null
      ? Math.round((grossAmount - tax_withheld) * 100) / 100
      : null;

    const result = await pool.query(
      `INSERT INTO payroll_entries (operator_id, staff_id, period_start, period_end, hours_worked, amount, notes, super_amount, tax_withheld, net_pay)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.userId, staff_id, period_start, period_end, hours_worked || null, grossAmount, notes || null, super_amount, tax_withheld, net_pay]
    );
    res.json({ success: true, payroll: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Create payroll error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create payroll entry' });
  }
});

router.post('/payroll/:id/approve', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE payroll_entries SET status = 'approved', approved_at = NOW()
       WHERE id = $1 AND operator_id = $2 AND status = 'pending' RETURNING *`,
      [id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Payroll entry not found or already approved' });
    res.json({ success: true, payroll: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Approve payroll error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to approve payroll' });
  }
});

router.post('/payroll/:id/mark-paid', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `UPDATE payroll_entries SET status = 'paid', paid_at = NOW()
       WHERE id = $1 AND operator_id = $2 AND status = 'approved' RETURNING *`,
      [id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Payroll entry not found or not approved' });
    res.json({ success: true, payroll: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Mark payroll paid error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark payroll as paid' });
  }
});

// ─── COMPLIANCE SUMMARY ───────────────────────────────────────────────────────
// Aggregated view for Hugo and dashboard compliance card

router.get('/compliance', requireAuth, async (req, res) => {
  try {
    const [superResult, paygResult, gstResult, userResult] = await Promise.all([
      // Super by staff member this quarter
      pool.query(`
        SELECT s.name as staff_name,
               COALESCE(SUM(p.super_amount), 0) as super_this_quarter,
               COALESCE(SUM(p.amount), 0) as gross_this_quarter
        FROM payroll_entries p
        JOIN staff_members s ON p.staff_id = s.id
        WHERE p.operator_id = $1 AND p.period_start >= date_trunc('quarter', CURRENT_DATE)
        GROUP BY s.name ORDER BY s.name
      `, [req.userId]),
      // PAYG withheld this month
      pool.query(`
        SELECT s.name as staff_name,
               COALESCE(SUM(p.tax_withheld), 0) as payg_this_month,
               COALESCE(SUM(p.net_pay), 0) as net_this_month
        FROM payroll_entries p
        JOIN staff_members s ON p.staff_id = s.id
        WHERE p.operator_id = $1 AND p.period_start >= date_trunc('month', CURRENT_DATE)
        GROUP BY s.name ORDER BY s.name
      `, [req.userId]),
      // GST collected this quarter (paid invoices only)
      pool.query(`
        SELECT COALESCE(SUM(gst_amount), 0) as gst_collected,
               COALESCE(SUM(total_inc_gst), 0) as revenue_inc_gst
        FROM invoices
        WHERE operator_id = $1 AND status = 'paid'
          AND paid_at >= date_trunc('quarter', CURRENT_DATE)
      `, [req.userId]),
      pool.query(`SELECT gst_registered FROM users WHERE id = $1`, [req.userId]),
    ]);

    res.json({
      success: true,
      compliance: {
        super_by_staff: superResult.rows,
        payg_by_staff: paygResult.rows,
        gst_collected: parseFloat(gstResult.rows[0]?.gst_collected || 0),
        revenue_inc_gst: parseFloat(gstResult.rows[0]?.revenue_inc_gst || 0),
        gst_registered: userResult.rows[0]?.gst_registered || false,
      },
    });
  } catch (err) {
    console.error('[PAYDECK] Compliance summary error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load compliance data' });
  }
});

// ─── STAFF PORTAL — operator-side management ──────────────────────────────────
// Invite sending, clock-in GPS history view, swap request approval

const crypto = require('crypto');
const { sendEmail } = require('../services/email');

/**
 * POST /api/paydeck/staff/:id/send-invite
 * Generates a one-time invite token for the staff member and emails it.
 */
router.post('/staff/:id/send-invite', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Verify staff belongs to this operator and has an email; fetch business name for branding
    const staffResult = await pool.query(
      `SELECT s.id, s.name, s.email, s.invite_accepted_at, op.business_name
       FROM staff_members s
       LEFT JOIN operator_profiles op ON op.operator_id = s.operator_id
       WHERE s.id = $1 AND s.operator_id = $2`,
      [id, req.userId]
    );
    const staff = staffResult.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });
    if (!staff.email) return res.status(400).json({ success: false, message: 'Staff member has no email address. Add one first.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `UPDATE staff_members SET invite_token = $1, invite_expires_at = $2, invite_accepted_at = NULL WHERE id = $3`,
      [token, expiresAt, id]
    );

    const appUrl = process.env.APP_URL || 'https://propopspro.polsia.app';
    const inviteUrl = `${appUrl}/pays/staff?invite=${token}`;

    const bizName = staff.business_name || '';
    const brandLine = bizName ? `Hugo.pays · ${bizName}` : 'Hugo.pays';

    await sendEmail({
      to: staff.email,
      subject: bizName ? `${bizName} — You're invited to the staff portal` : `You're invited to the staff portal`,
      html: `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Inter',-apple-system,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="540" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr><td style="background:#0f172a;padding:24px 36px;">
          <p style="margin:0;font-size:18px;font-weight:700;color:#fff;">Hugo.pays<span style="color:#f59e0b;">.</span>${bizName ? `<span style="color:#94a3b8;font-weight:400;font-size:14px;margin-left:8px;">· ${bizName}</span>` : ''}</p>
        </td></tr>
        <tr><td style="padding:36px;">
          <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#0f172a;">Hi ${staff.name},</h1>
          <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.6;">${bizName ? `You've been invited to the <strong>${bizName}</strong> staff portal` : `You've been invited to the Hugo.pays staff portal`}. You can view your roster, clock in/out for shifts, and request shift swaps.</p>
          <p style="margin:0 0 20px;font-size:14px;color:#64748b;">Click the button below to set up your account. This link expires in 7 days.</p>
          <table cellpadding="0" cellspacing="0"><tr><td style="background:#f59e0b;border-radius:8px;">
            <a href="${inviteUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#0f172a;text-decoration:none;">Accept Invite →</a>
          </td></tr></table>
          <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">Or copy this link: ${inviteUrl}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
      text: `Hi ${staff.name},\n\n${bizName ? `You've been invited to the ${bizName} staff portal` : `You've been invited to the Hugo.pays staff portal`}.\n\nAccept your invite: ${inviteUrl}\n\nThis link expires in 7 days.`,
      tag: 'staff_invite',
    });

    res.json({ success: true, message: `Invite sent to ${staff.email}`, invite_url: inviteUrl });
  } catch (err) {
    console.error('[PAYDECK] send-invite error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send invite' });
  }
});

/**
 * GET /api/paydeck/clock-events
 * Operator sees all staff GPS clock-in/out history.
 */
router.get('/clock-events', requireAuth, async (req, res) => {
  const { staff_id, date } = req.query;
  try {
    let query = `
      SELECT ce.*, s.name AS staff_name, re.job_title, re.job_address, re.scheduled_date
      FROM staff_clock_events ce
      JOIN staff_members s ON ce.staff_id = s.id
      LEFT JOIN roster_entries re ON ce.roster_entry_id = re.id
      WHERE ce.operator_id = $1
    `;
    const params = [req.userId];
    if (staff_id) { params.push(staff_id); query += ` AND ce.staff_id = $${params.length}`; }
    if (date)     { params.push(date);     query += ` AND DATE(ce.occurred_at) = $${params.length}`; }
    query += ` ORDER BY ce.occurred_at DESC LIMIT 200`;

    const result = await pool.query(query, params);
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('[PAYDECK] clock-events error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load clock events' });
  }
});

/**
 * GET /api/paydeck/swap-requests
 * Operator sees all pending (and recent) swap requests.
 */
router.get('/swap-requests', requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT sw.*,
             rs.name AS requesting_name,
             ts.name AS target_name,
             re.job_title, re.scheduled_date, re.start_time, re.end_time
      FROM staff_shift_swap_requests sw
      JOIN staff_members rs ON sw.requesting_staff_id = rs.id
      LEFT JOIN staff_members ts ON sw.target_staff_id = ts.id
      JOIN roster_entries re ON sw.roster_entry_id = re.id
      WHERE sw.operator_id = $1
    `;
    const params = [req.userId];
    if (status) { params.push(status); query += ` AND sw.status = $${params.length}`; }
    query += ` ORDER BY sw.created_at DESC LIMIT 100`;

    const result = await pool.query(query, params);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[PAYDECK] swap-requests list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load swap requests' });
  }
});

/**
 * POST /api/paydeck/swap-requests/:id/review
 * Operator approves or declines a shift swap request.
 * On approve: swaps staff_id on the roster_entry.
 */
router.post('/swap-requests/:id/review', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body; // action: 'approve' | 'decline'
  if (!['approve', 'decline'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or decline' });
  }
  try {
    const swapResult = await pool.query(
      `SELECT sw.*, re.staff_id AS current_staff_id
       FROM staff_shift_swap_requests sw
       JOIN roster_entries re ON sw.roster_entry_id = re.id
       WHERE sw.id = $1 AND sw.operator_id = $2 AND sw.status = 'pending'`,
      [id, req.userId]
    );
    const swap = swapResult.rows[0];
    if (!swap) return res.status(404).json({ success: false, message: 'Swap request not found or already reviewed' });

    const newStatus = action === 'approve' ? 'approved' : 'declined';

    await pool.query(
      `UPDATE staff_shift_swap_requests
       SET status = $1, operator_note = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [newStatus, note || null, id]
    );

    // On approve: reassign roster entry to target staff (or leave open if no target)
    if (action === 'approve' && swap.target_staff_id) {
      await pool.query(
        `UPDATE roster_entries SET staff_id = $1 WHERE id = $2 AND operator_id = $3`,
        [swap.target_staff_id, swap.roster_entry_id, req.userId]
      );
    }

    res.json({ success: true, status: newStatus, message: `Swap request ${newStatus}` });
  } catch (err) {
    console.error('[PAYDECK] swap review error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to review swap request' });
  }
});

// ─── LEAVE REQUESTS — operator approval queue ─────────────────────────────────

/**
 * GET /api/paydeck/leave-requests
 * Operator sees all leave requests (filter by status or staff_id).
 */
router.get('/leave-requests', requireAuth, async (req, res) => {
  const { status, staff_id } = req.query;
  try {
    let query = `
      SELECT lr.*, s.name AS staff_name, s.role AS staff_role
      FROM staff_leave_requests lr
      JOIN staff_members s ON lr.staff_id = s.id
      WHERE lr.operator_id = $1
    `;
    const params = [req.userId];
    if (status)   { params.push(status);   query += ` AND lr.status = $${params.length}`; }
    if (staff_id) { params.push(staff_id); query += ` AND lr.staff_id = $${params.length}`; }
    query += ` ORDER BY lr.created_at DESC LIMIT 100`;
    const result = await pool.query(query, params);
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[PAYDECK] leave-requests list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load leave requests' });
  }
});

/**
 * POST /api/paydeck/leave-requests/:id/review
 * Operator approves or declines a staff leave request.
 */
router.post('/leave-requests/:id/review', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body; // action: 'approve' | 'decline'
  if (!['approve', 'decline'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or decline' });
  }
  try {
    const result = await pool.query(
      `UPDATE staff_leave_requests
       SET status = $1, operator_note = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND operator_id = $4 AND status = 'pending'
       RETURNING *`,
      [action === 'approve' ? 'approved' : 'declined', note || null, id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Leave request not found or already reviewed' });
    res.json({ success: true, request: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] leave-request review error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to review leave request' });
  }
});

/**
 * GET /api/paydeck/staff/:id/onboarding
 * Operator sees a staff member's onboarding completion status.
 */
router.get('/staff/:id/onboarding', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Verify staff belongs to operator
    const staffCheck = await pool.query(
      `SELECT id, name, onboarding_completed FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [id, req.userId]
    );
    if (!staffCheck.rows[0]) return res.status(404).json({ success: false, message: 'Staff member not found' });

    const onboardingResult = await pool.query(
      `SELECT
         tfn_declared_at IS NOT NULL as tfn_done,
         super_submitted_at IS NOT NULL as super_done,
         bank_submitted_at IS NOT NULL as bank_done,
         emergency_submitted_at IS NOT NULL as emergency_done,
         completed_at
       FROM staff_onboarding WHERE staff_id = $1`,
      [id]
    );
    res.json({
      success: true,
      staff: staffCheck.rows[0],
      onboarding: onboardingResult.rows[0] || { tfn_done: false, super_done: false, bank_done: false, emergency_done: false },
    });
  } catch (err) {
    console.error('[PAYDECK] staff onboarding status error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── EXPORT — MYOB, SuperStream, STP2, Xero ───────────────────────────────────
//
// All exports are CSV or JSON downloads — no third-party API required.
// Operator clicks "Download" → file is generated server-side from payroll_entries
// + staff_members + staff_onboarding → ready to import into MYOB / Xero / send
// to accountant / upload to ATO clearing house for SuperStream.

/**
 * Helper: escape a CSV field (wrap in double quotes if needed, escape inner quotes).
 */
function csvField(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(fields) {
  return fields.map(csvField).join(',');
}

/**
 * Format a date as DD/MM/YYYY (Australian convention).
 */
function fmtDateAU(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * GET /api/paydeck/export/payroll-csv
 *
 * MYOB AccountRight-compatible payroll CSV.
 * Maps to MYOB "Import Payroll Data" format:
 *   Employee Name, Employee ID, Period Start, Period End,
 *   Gross Wages, PAYG Withholding, Super (SGC 11.5%),
 *   Net Pay, Hours Worked, Pay Category, Pay Period Type, Notes
 *
 * Query params:
 *   ?start=YYYY-MM-DD  — filter period_start >= this date (default: start of current FY)
 *   ?end=YYYY-MM-DD    — filter period_end   <= this date (default: today)
 *   ?staff_id=N        — optional single staff filter
 */
router.get('/export/payroll-csv', requireAuth, async (req, res) => {
  const { start, end, staff_id } = req.query;

  // Default: current financial year (ATO FY runs Jul 1 – Jun 30)
  const now = new Date();
  const fyStart = now.getMonth() >= 6
    ? `${now.getFullYear()}-07-01`
    : `${now.getFullYear() - 1}-07-01`;
  const fromDate = start || fyStart;
  const toDate   = end   || now.toISOString().split('T')[0];

  try {
    const params = [req.userId, fromDate, toDate];
    let query = `
      SELECT
        p.id,
        p.period_start,
        p.period_end,
        p.hours_worked,
        p.amount        AS gross,
        p.super_amount,
        p.tax_withheld,
        p.net_pay,
        p.status,
        p.notes,
        s.name          AS staff_name,
        s.id            AS staff_id,
        s.role,
        s.tfn_status
      FROM payroll_entries p
      JOIN staff_members s ON p.staff_id = s.id
      WHERE p.operator_id = $1
        AND p.period_start >= $2
        AND p.period_end   <= $3
    `;
    if (staff_id) { params.push(staff_id); query += ` AND p.staff_id = $${params.length}`; }
    query += ` ORDER BY p.period_end DESC, s.name ASC`;

    const result = await pool.query(query, params);
    const rows   = result.rows;

    // Get operator business name for header comment
    const userRes = await pool.query(`SELECT name, email, gst_registered FROM users WHERE id = $1`, [req.userId]);
    const operator = userRes.rows[0] || {};

    const header = [
      'Employee Name',
      'Employee ID',
      'Pay Period Start',
      'Pay Period End',
      'Pay Period Type',
      'Hours Worked',
      'Ordinary Hours Rate',
      'Ordinary Hours Amount',
      'Gross Wages',
      'PAYG Withholding',
      'Super (SGC 11.5%)',
      'Net Pay',
      'Status',
      'Notes',
    ];

    const lines = [
      // MYOB import comment rows (prefixed with #) for context — ignored on import
      `# MYOB Payroll Import — ${operator.name || 'Operator'} | Generated ${new Date().toLocaleString('en-AU')}`,
      `# Period: ${fromDate} to ${toDate} | Super rate: 11.5% SG | PAYG: ATO 2025-26 brackets`,
      csvRow(header),
    ];

    for (const r of rows) {
      // MYOB pay period type: Weekly=W, Fortnightly=F, Monthly=M — infer from days
      const days = r.period_start && r.period_end
        ? Math.round((new Date(r.period_end) - new Date(r.period_start)) / (1000 * 60 * 60 * 24)) + 1
        : null;
      const periodType = days <= 8 ? 'Weekly' : days <= 16 ? 'Fortnightly' : 'Monthly';

      // Ordinary hours = all hours (no overtime split unless you track it separately)
      const ordinaryRate = r.hours_worked && r.gross
        ? (parseFloat(r.gross) / parseFloat(r.hours_worked)).toFixed(4)
        : '';

      lines.push(csvRow([
        r.staff_name,
        r.staff_id,
        fmtDateAU(r.period_start),
        fmtDateAU(r.period_end),
        periodType,
        r.hours_worked != null ? parseFloat(r.hours_worked).toFixed(2) : '',
        ordinaryRate,
        r.gross != null ? parseFloat(r.gross).toFixed(2) : '',
        r.gross != null ? parseFloat(r.gross).toFixed(2) : '',
        r.tax_withheld != null ? parseFloat(r.tax_withheld).toFixed(2) : '',
        r.super_amount != null ? parseFloat(r.super_amount).toFixed(2) : '',
        r.net_pay  != null ? parseFloat(r.net_pay).toFixed(2)  : '',
        r.status || 'pending',
        r.notes || '',
      ]));
    }

    const csv = lines.join('\r\n');
    const filename = `myob-payroll-${fromDate}-to-${toDate}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[PAYDECK] export/payroll-csv error:', err.message);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

/**
 * GET /api/paydeck/export/superstream-csv
 *
 * SuperStream-ready CSV for electronic super payments.
 * Fields required by ATO SuperStream / clearing houses (e.g. ATO Small Business Super
 * Clearing House, Beam, Webjet).
 *
 * Query params: same as payroll-csv
 */
router.get('/export/superstream-csv', requireAuth, async (req, res) => {
  const { start, end, staff_id } = req.query;

  const now = new Date();
  const fyStart = now.getMonth() >= 6
    ? `${now.getFullYear()}-07-01`
    : `${now.getFullYear() - 1}-07-01`;
  const fromDate = start || fyStart;
  const toDate   = end   || now.toISOString().split('T')[0];

  try {
    const params = [req.userId, fromDate, toDate];
    let query = `
      SELECT
        p.id,
        p.period_start,
        p.period_end,
        p.amount      AS gross,
        p.super_amount,
        p.status,
        s.name        AS staff_name,
        s.id          AS staff_id,
        s.email       AS staff_email,
        s.tfn_status,
        -- super fund details from onboarding (confirmed values preferred)
        COALESCE(so.super_fund_name,   s.super_fund_name)   AS super_fund_name,
        COALESCE(so.super_usi,         s.super_usi)         AS super_usi,
        COALESCE(so.super_member_number, s.super_member_number) AS super_member_number,
        COALESCE(so.tfn,               NULL)                AS tfn,
        so.is_resident
      FROM payroll_entries p
      JOIN staff_members s ON p.staff_id = s.id
      LEFT JOIN staff_onboarding so ON so.staff_id = s.id
      WHERE p.operator_id = $1
        AND p.period_start >= $2
        AND p.period_end   <= $3
        AND p.super_amount IS NOT NULL
        AND p.super_amount > 0
    `;
    if (staff_id) { params.push(staff_id); query += ` AND p.staff_id = $${params.length}`; }
    query += ` ORDER BY p.period_end DESC, s.name ASC`;

    const result = await pool.query(query, params);
    const rows   = result.rows;

    const userRes = await pool.query(`SELECT name FROM users WHERE id = $1`, [req.userId]);
    const operator = userRes.rows[0] || {};

    // SuperStream clearing house CSV format
    const header = [
      'Employer Name',
      'Employee Name',
      'Employee ID',
      'Employee Email',
      'TFN',
      'Is Resident',
      'Super Fund Name',
      'Super Fund USI',
      'Member Number',
      'Contribution Type',
      'Contribution Amount',
      'Ordinary Time Earnings',
      'Payment Period Start',
      'Payment Period End',
    ];

    const lines = [
      `# SuperStream Contribution Export — ${operator.name || 'Operator'} | Generated ${new Date().toLocaleString('en-AU')}`,
      `# Rate: 11.5% SG (FY2025-26) | Upload to ATO Small Business Super Clearing House or your clearing house`,
      csvRow(header),
    ];

    for (const r of rows) {
      lines.push(csvRow([
        operator.name || '',
        r.staff_name,
        r.staff_id,
        r.staff_email || '',
        // TFN is sensitive — include only if explicitly stored (operator compliance responsibility)
        r.tfn || (r.tfn_status === 'provided' ? 'PROVIDED' : r.tfn_status === 'exemption' ? 'EXEMPTION' : 'NOT_PROVIDED'),
        r.is_resident !== false ? 'Y' : 'N',
        r.super_fund_name || '',
        r.super_usi || '',
        r.super_member_number || '',
        'SGC',  // Super Guarantee Contribution (mandatory employer contribution)
        r.super_amount != null ? parseFloat(r.super_amount).toFixed(2) : '',
        r.gross != null ? parseFloat(r.gross).toFixed(2) : '',
        fmtDateAU(r.period_start),
        fmtDateAU(r.period_end),
      ]));
    }

    // Totals row
    const totalSuper = rows.reduce((s, r) => s + parseFloat(r.super_amount || 0), 0);
    lines.push(`# TOTAL SUPER: $${totalSuper.toFixed(2)} across ${rows.length} contribution records`);

    const csv = lines.join('\r\n');
    const filename = `superstream-${fromDate}-to-${toDate}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[PAYDECK] export/superstream-csv error:', err.message);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

/**
 * GET /api/paydeck/export/stp2-summary
 *
 * STP2 Phase 2 compliance summary — JSON (not a direct ATO lodgement; intended for review
 * or forwarding to accountant / payroll software with ATO DSP connection).
 *
 * STP2 required fields (ATO specification):
 *   - employer ABN (we ask operator to enter via settings)
 *   - employee TFN, name, DOB, residential address
 *   - pay event: gross, PAYG, super, allowances, deductions
 *   - income type: SAW (salary/wages), Labour hire, etc.
 *   - YTD totals per employee (cumulative from FY start)
 *
 * Query params: ?financial_year=2026 (defaults to current)
 */
router.get('/export/stp2-summary', requireAuth, async (req, res) => {
  const fy = parseInt(req.query.financial_year) || new Date().getFullYear();
  // FY runs Jul 1 (fy-1) to Jun 30 (fy)
  const fyStart = `${fy - 1}-07-01`;
  const fyEnd   = `${fy}-06-30`;

  try {
    const userRes = await pool.query(
      `SELECT id, name, email, gst_registered FROM users WHERE id = $1`,
      [req.userId]
    );
    const operator = userRes.rows[0] || {};

    // Per-employee YTD aggregates
    const staffSummary = await pool.query(`
      SELECT
        s.id                AS employee_id,
        s.name              AS employee_name,
        s.email             AS employee_email,
        s.role,
        s.tfn_status,
        s.hourly_rate,
        s.super_fund_name,
        s.super_usi,
        s.super_member_number,
        -- YTD totals
        COALESCE(SUM(p.amount),      0) AS ytd_gross,
        COALESCE(SUM(p.tax_withheld),0) AS ytd_payg,
        COALESCE(SUM(p.super_amount),0) AS ytd_super,
        COALESCE(SUM(p.net_pay),     0) AS ytd_net,
        COALESCE(SUM(p.hours_worked),0) AS ytd_hours,
        COUNT(p.id)                      AS pay_run_count
      FROM staff_members s
      LEFT JOIN payroll_entries p
        ON p.staff_id = s.id
       AND p.operator_id = $1
       AND p.period_start >= $2
       AND p.period_end   <= $3
      WHERE s.operator_id = $1 AND s.is_active = true
      GROUP BY s.id, s.name, s.email, s.role, s.tfn_status, s.hourly_rate, s.super_fund_name, s.super_usi, s.super_member_number
      ORDER BY s.name ASC
    `, [req.userId, fyStart, fyEnd]);

    // Individual pay runs for this FY
    const payRuns = await pool.query(`
      SELECT
        p.id, p.staff_id, p.period_start, p.period_end, p.hours_worked,
        p.amount AS gross, p.super_amount, p.tax_withheld, p.net_pay,
        p.status, p.notes,
        s.name AS staff_name, s.tfn_status
      FROM payroll_entries p
      JOIN staff_members s ON p.staff_id = s.id
      WHERE p.operator_id = $1
        AND p.period_start >= $2
        AND p.period_end   <= $3
      ORDER BY p.period_end DESC
    `, [req.userId, fyStart, fyEnd]);

    const totals = {
      ytd_gross:   staffSummary.rows.reduce((a, r) => a + parseFloat(r.ytd_gross), 0),
      ytd_payg:    staffSummary.rows.reduce((a, r) => a + parseFloat(r.ytd_payg),  0),
      ytd_super:   staffSummary.rows.reduce((a, r) => a + parseFloat(r.ytd_super), 0),
      ytd_net:     staffSummary.rows.reduce((a, r) => a + parseFloat(r.ytd_net),   0),
      employee_count: staffSummary.rows.length,
      pay_run_count:  payRuns.rows.length,
    };

    res.json({
      success: true,
      stp2: {
        format_version: 'STP2-Phase2',
        financial_year: `FY${fy}`,
        fy_start: fyStart,
        fy_end:   fyEnd,
        generated_at: new Date().toISOString(),
        employer: {
          name:  operator.name  || '',
          email: operator.email || '',
          // ABN should be entered in settings — placeholder if not available
          abn:   operator.abn   || 'ENTER ABN IN SETTINGS',
        },
        // STP2 required pay categories (ATO):
        // SAW = Salary/Wages (ordinary), LAB = Labour Hire, SWS = Supported Wage System
        income_type: 'SAW',
        super_rate_pct: 11.5,
        payg_year: '2025-26',
        employees: staffSummary.rows.map(e => ({
          employee_id:       e.employee_id,
          name:              e.employee_name,
          email:             e.employee_email,
          role:              e.role,
          tfn_status:        e.tfn_status,
          // STP2 pay categories
          ytd: {
            gross_wages:       parseFloat(e.ytd_gross).toFixed(2),
            payg_withholding:  parseFloat(e.ytd_payg).toFixed(2),
            super_sgc:         parseFloat(e.ytd_super).toFixed(2),
            net_pay:           parseFloat(e.ytd_net).toFixed(2),
            hours_worked:      parseFloat(e.ytd_hours).toFixed(2),
          },
          super_fund: {
            name:          e.super_fund_name   || '',
            usi:           e.super_usi          || '',
            member_number: e.super_member_number || '',
          },
          pay_run_count: parseInt(e.pay_run_count),
        })),
        pay_runs: payRuns.rows.map(p => ({
          id:           p.id,
          staff_id:     p.staff_id,
          staff_name:   p.staff_name,
          period_start: p.period_start,
          period_end:   p.period_end,
          hours_worked: p.hours_worked,
          gross:        p.gross,
          payg:         p.tax_withheld,
          super:        p.super_amount,
          net_pay:      p.net_pay,
          status:       p.status,
        })),
        totals: {
          ytd_gross:       totals.ytd_gross.toFixed(2),
          ytd_payg:        totals.ytd_payg.toFixed(2),
          ytd_super:       totals.ytd_super.toFixed(2),
          ytd_net:         totals.ytd_net.toFixed(2),
          employee_count:  totals.employee_count,
          pay_run_count:   totals.pay_run_count,
        },
      },
    });
  } catch (err) {
    console.error('[PAYDECK] export/stp2-summary error:', err.message);
    res.status(500).json({ success: false, message: 'STP2 export failed' });
  }
});

/**
 * GET /api/paydeck/export/xero-csv
 *
 * Xero Payroll import CSV.
 * Xero uses a slightly different column set from MYOB:
 *   Employee Name, Payroll Code, Pay Period Start, Pay Period End,
 *   Earnings Name, Earnings Type, Earnings Rate, Earnings Units, Earnings Amount,
 *   Tax Amount, Super Amount, Net Pay
 *
 * Each pay run generates 1 "Ordinary Time" earnings line + 1 deduction line (PAYG).
 * Query params: same as payroll-csv
 */
router.get('/export/xero-csv', requireAuth, async (req, res) => {
  const { start, end, staff_id } = req.query;

  const now = new Date();
  const fyStart = now.getMonth() >= 6
    ? `${now.getFullYear()}-07-01`
    : `${now.getFullYear() - 1}-07-01`;
  const fromDate = start || fyStart;
  const toDate   = end   || now.toISOString().split('T')[0];

  try {
    const params = [req.userId, fromDate, toDate];
    let query = `
      SELECT
        p.id, p.period_start, p.period_end, p.hours_worked,
        p.amount AS gross, p.super_amount, p.tax_withheld, p.net_pay, p.notes,
        s.id AS staff_id, s.name AS staff_name, s.hourly_rate
      FROM payroll_entries p
      JOIN staff_members s ON p.staff_id = s.id
      WHERE p.operator_id = $1
        AND p.period_start >= $2
        AND p.period_end   <= $3
    `;
    if (staff_id) { params.push(staff_id); query += ` AND p.staff_id = $${params.length}`; }
    query += ` ORDER BY p.period_end DESC, s.name ASC`;

    const result = await pool.query(query, params);
    const rows   = result.rows;

    const userRes = await pool.query(`SELECT name FROM users WHERE id = $1`, [req.userId]);
    const operator = userRes.rows[0] || {};

    // Xero payroll CSV headers
    const header = [
      'Employee Name',
      'Payroll Code',
      'Pay Period Start',
      'Pay Period End',
      'Earnings Name',
      'Earnings Type',
      'Earnings Rate',
      'Earnings Units',
      'Earnings Amount',
      'Tax Amount (PAYG)',
      'Super Amount (SGC 11.5%)',
      'Net Pay',
      'Notes',
    ];

    const lines = [
      `# Xero Payroll Import — ${operator.name || 'Operator'} | Generated ${new Date().toLocaleString('en-AU')}`,
      `# Period: ${fromDate} to ${toDate} | Super: 11.5% SGC | PAYG: ATO 2025-26`,
      csvRow(header),
    ];

    for (const r of rows) {
      const ordRate = r.hours_worked && r.gross
        ? (parseFloat(r.gross) / parseFloat(r.hours_worked)).toFixed(4)
        : (r.hourly_rate ? parseFloat(r.hourly_rate).toFixed(4) : '');

      // Xero: one line per earnings type; "OrdinaryTime" is the Xero built-in earnings name
      lines.push(csvRow([
        r.staff_name,
        `EMP-${r.staff_id}`,
        fmtDateAU(r.period_start),
        fmtDateAU(r.period_end),
        'Ordinary Time',      // Xero earnings name — matches built-in unless custom
        'Regular',            // Earnings type: Regular | Overtime | Leave
        ordRate,
        r.hours_worked != null ? parseFloat(r.hours_worked).toFixed(2) : '',
        r.gross != null ? parseFloat(r.gross).toFixed(2) : '',
        r.tax_withheld != null ? parseFloat(r.tax_withheld).toFixed(2) : '',
        r.super_amount != null ? parseFloat(r.super_amount).toFixed(2) : '',
        r.net_pay  != null ? parseFloat(r.net_pay).toFixed(2)  : '',
        r.notes || '',
      ]));
    }

    const csv = lines.join('\r\n');
    const filename = `xero-payroll-${fromDate}-to-${toDate}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[PAYDECK] export/xero-csv error:', err.message);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});

// ─── WEEK VIEW ────────────────────────────────────────────────────────────────

/**
 * GET /api/paydeck/week-view
 * Unified 7-day roster + pay chart.
 *
 * Query params:
 *   week_start  ISO date (YYYY-MM-DD) for Monday of the week. Defaults to current Monday.
 *   staff_id    Optional — filter to single staff member.
 *
 * Returns:
 *   week_start, week_end (strings)
 *   staff[] — one entry per staff member, each with shifts[] indexed 0=Mon…6=Sun
 *             plus weekly pay totals (hours, gross, payg, super, net)
 *   team_totals — summed hours/gross/payg/super/net across all staff
 *   pending_swaps — count of pending swap requests for badge display
 */
router.get('/week-view', requireAuth, async (req, res) => {
  try {
    // Compute week window: Mon–Sun
    let weekStart;
    if (req.query.week_start) {
      weekStart = new Date(req.query.week_start + 'T00:00:00Z');
    } else {
      const now = new Date();
      const dow = now.getUTCDay(); // 0=Sun…6=Sat
      const daysToMon = dow === 0 ? -6 : 1 - dow;
      weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMon));
    }
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

    const wStartStr = weekStart.toISOString().split('T')[0];
    const wEndStr   = weekEnd.toISOString().split('T')[0];

    // Fetch active staff
    const staffQuery = req.query.staff_id
      ? pool.query(`SELECT * FROM staff_members WHERE id = $1 AND operator_id = $2`, [req.query.staff_id, req.userId])
      : pool.query(`SELECT * FROM staff_members WHERE operator_id = $1 AND is_active = true ORDER BY name ASC`, [req.userId]);

    const [staffResult, shiftResult, swapResult] = await Promise.all([
      staffQuery,
      pool.query(`
        SELECT r.*, s.name as staff_name, s.hourly_rate as staff_hourly_rate, s.tfn_status
        FROM roster_entries r
        JOIN staff_members s ON r.staff_id = s.id
        WHERE r.operator_id = $1
          AND r.scheduled_date >= $2
          AND r.scheduled_date <= $3
          AND r.status != 'cancelled'
        ORDER BY r.scheduled_date ASC, r.start_time ASC
      `, [req.userId, wStartStr, wEndStr]),
      pool.query(`
        SELECT id, roster_entry_id, requesting_staff_id, target_staff_id, status
        FROM staff_shift_swap_requests
        WHERE operator_id = $1 AND status = 'pending'
      `, [req.userId]),
    ]);

    const staffList  = staffResult.rows;
    const allShifts  = shiftResult.rows;
    const pendingSwaps = swapResult.rows;

    // Index pending swap roster entry IDs for quick lookup
    const swapOfferedEntryIds = new Set(pendingSwaps.map(s => s.roster_entry_id));

    // WHY: Pure string-based day index avoids timezone drift from Date object arithmetic.
    // node-pg returns DATE columns as JS Date at midnight local TZ — toISOString() can shift
    // the date backward. Extracting YYYY-MM-DD and comparing strings is timezone-safe.
    function dayIndex(dateStr) {
      // dateStr should already be YYYY-MM-DD; compare directly against wStartStr
      const ds = dateStr.split('T')[0]; // strip any time component
      const [sy, sm, sd] = wStartStr.split('-').map(Number);
      const [dy, dm, dd] = ds.split('-').map(Number);
      const startDays = new Date(Date.UTC(sy, sm - 1, sd)).getTime() / 86400000;
      const dateDays  = new Date(Date.UTC(dy, dm - 1, dd)).getTime() / 86400000;
      return Math.round(dateDays - startDays); // 0=Mon…6=Sun
    }

    // Build staff rows
    const staffRows = staffList.map(s => {
      const shifts = Array.from({length: 7}, () => []);
      allShifts
        .filter(r => r.staff_id === s.id)
        .forEach(r => {
          // WHY: node-pg DATE → JS Date at local midnight; toISOString() shifts in non-UTC TZ.
          // Extract YYYY-MM-DD without UTC conversion to avoid off-by-one date bugs.
          let dateStr;
          if (r.scheduled_date instanceof Date) {
            dateStr = r.scheduled_date.getFullYear() + '-' + String(r.scheduled_date.getMonth()+1).padStart(2,'0') + '-' + String(r.scheduled_date.getDate()).padStart(2,'0');
          } else {
            dateStr = String(r.scheduled_date).split('T')[0];
          }
          const idx = dayIndex(dateStr);
          if (idx >= 0 && idx <= 6) {
            shifts[idx].push({
              id:           r.id,
              job_title:    r.job_title,
              job_address:  r.job_address,
              start_time:   r.start_time,
              end_time:     r.end_time,
              status:       r.status,
              notes:        r.notes,
              swap_offered: swapOfferedEntryIds.has(r.id),
            });
          }
        });

      // Compute weekly pay from all shifts with start+end times
      let totalHours = 0;
      allShifts.filter(r => r.staff_id === s.id).forEach(r => {
        if (r.start_time && r.end_time) {
          const [sh, sm] = String(r.start_time).split(':').map(Number);
          const [eh, em] = String(r.end_time).split(':').map(Number);
          let mins = eh * 60 + (em||0) - sh * 60 - (sm||0);
          // WHY: If end < start (e.g. 09:00 to 05:00 stored as AM), assume 12h offset
          if (mins <= 0) mins += 12 * 60;
          totalHours += mins / 60;
        }
      });

      const rate = parseFloat(s.hourly_rate) || 0;
      const gross = Math.round(totalHours * rate * 100) / 100;
      const superAmt = calculateSuper(gross);
      const payg = calculatePAYG(gross, totalHours, rate, s.tfn_status || 'provided');
      const net = Math.round((gross - payg) * 100) / 100;

      return {
        id:          s.id,
        name:        s.name,
        role:        s.role,
        hourly_rate: rate,
        tfn_status:  s.tfn_status,
        shifts,                // 7-element array, each is array of shift objects
        totals: {
          hours: Math.round(totalHours * 100) / 100,
          gross, super: superAmt, payg, net,
        },
      };
    });

    // Team totals
    const team = staffRows.reduce((acc, s) => {
      acc.hours += s.totals.hours;
      acc.gross += s.totals.gross;
      acc.super += s.totals.super;
      acc.payg  += s.totals.payg;
      acc.net   += s.totals.net;
      return acc;
    }, { hours: 0, gross: 0, super: 0, payg: 0, net: 0 });
    Object.keys(team).forEach(k => { team[k] = Math.round(team[k] * 100) / 100; });

    res.json({
      success:   true,
      week_start: wStartStr,
      week_end:   wEndStr,
      staff:     staffRows,
      team_totals: team,
      pending_swaps: pendingSwaps.length,
    });
  } catch (err) {
    console.error('[PAYDECK] week-view error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load week view' });
  }
});

/**
 * POST /api/paydeck/week-view/shift
 * Add a shift directly from the week view cell.
 * Body: { staff_id, scheduled_date, start_time, end_time, job_title, job_address }
 */
router.post('/week-view/shift', requireAuth, async (req, res) => {
  const { staff_id, scheduled_date, start_time, end_time, job_title, job_address } = req.body;
  if (!staff_id || !scheduled_date) {
    return res.status(400).json({ success: false, message: 'staff_id and scheduled_date are required' });
  }
  try {
    const staffCheck = await pool.query(
      `SELECT id FROM staff_members WHERE id = $1 AND operator_id = $2 AND is_active = true`,
      [staff_id, req.userId]
    );
    if (!staffCheck.rows[0]) return res.status(400).json({ success: false, message: 'Invalid or inactive staff member' });

    const result = await pool.query(
      `INSERT INTO roster_entries (operator_id, staff_id, job_title, job_address, scheduled_date, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, staff_id, job_title || null, job_address || null, scheduled_date, start_time || null, end_time || null]
    );
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] week-view/shift POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to add shift' });
  }
});

/**
 * POST /api/paydeck/week-view/offer-swap
 * Staff (or operator on behalf) marks a shift as available for swap.
 * Body: { roster_entry_id }
 */
router.post('/week-view/offer-swap', requireAuth, async (req, res) => {
  const { roster_entry_id } = req.body;
  if (!roster_entry_id) return res.status(400).json({ success: false, message: 'roster_entry_id required' });
  try {
    // Verify entry belongs to this operator
    const entryResult = await pool.query(
      `SELECT * FROM roster_entries WHERE id = $1 AND operator_id = $2 AND status != 'cancelled'`,
      [roster_entry_id, req.userId]
    );
    const entry = entryResult.rows[0];
    if (!entry) return res.status(404).json({ success: false, message: 'Shift not found' });

    // Check no existing pending swap for this entry
    const existCheck = await pool.query(
      `SELECT id FROM staff_shift_swap_requests WHERE roster_entry_id = $1 AND status = 'pending'`,
      [roster_entry_id]
    );
    if (existCheck.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Swap already offered for this shift' });
    }

    await pool.query(
      `INSERT INTO staff_shift_swap_requests (operator_id, roster_entry_id, requesting_staff_id, status)
       VALUES ($1, $2, $3, 'pending')`,
      [req.userId, roster_entry_id, entry.staff_id]
    );
    res.json({ success: true, message: 'Swap offer created — awaiting approval' });
  } catch (err) {
    console.error('[PAYDECK] week-view/offer-swap error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to offer swap' });
  }
});

// ─── UPGRADE endpoint — for base tier operators ───────────────────────────────

router.get('/upgrade-url', requireAuth, async (req, res) => {
  res.json({
    success: true,
    upgrade_url: PREMIUM_STRIPE_URL,
    plan_name: 'PropOps Premium — Hugo + PAYDECK',
    monthly_amount: 149,
    features: [
      'Full Hugo AI receptionist (calls, SMS, web chat)',
      'Staff & roster management',
      'Automated invoicing with Stripe payment links',
      'Payroll tracking with super + PAYG compliance',
      'Australian GST invoicing (10%)',
      'Hugo knows your super, tax, and GST obligations',
    ],
  });
});

module.exports = router;
