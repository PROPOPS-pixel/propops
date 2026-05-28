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

// ── Geocoding helper (OpenStreetMap Nominatim) ────────────────────────────────
// WHY: GPS Map pins need lat/lng from job addresses. Nominatim is free; we cache
// results on the roster_entry row so each address is only geocoded once.
// Rate limit: 1 req/sec (Nominatim policy) — acceptable for roster save flow.
const https = require('https');
async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address.trim())}`;
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'HugoPays/1.0 (propops.pro)' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results && results.length > 0) {
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else { resolve(null); }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// WHY: Fire-and-forget geocode after roster save — don't block the response.
// Updates geocoded_lat/lng on the roster_entry row for map pin display.
function geocodeAndCache(entryId, address) {
  if (!address) return;
  geocodeAddress(address).then(async (coords) => {
    if (!coords) return;
    try {
      await pool.query(
        `UPDATE roster_entries SET geocoded_lat = $1, geocoded_lng = $2 WHERE id = $3`,
        [coords.lat, coords.lng, entryId]
      );
    } catch (err) {
      console.error('[PAYDECK] geocode cache write failed:', err.message);
    }
  }).catch(() => {});
}

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

  // WHY: Convert to weekly gross for ATO weekly withholding schedule.
  // Previous code annualised via hours/38 which caused part-time workers to fall
  // below the tax-free threshold and get $0 withholding (e.g. 8h/wk × $30 = $240,
  // annualised to $12,480 < $18,200 = $0 tax). ATO weekly schedule is the correct
  // approach — withhold based on what they actually earn that week.
  let weeklyGross;
  if (hoursInPeriod && hoursInPeriod > 0) {
    // Treat the period as exactly one week of pay
    weeklyGross = grossPay;
  } else {
    // Assume fortnightly → halve for weekly
    weeklyGross = grossPay / 2;
  }

  // ATO 2025-26 weekly PAYG withholding schedule (simplified)
  // These map to annual brackets: $18,200 → $350/wk, $45,000 → $865/wk, etc.
  let weeklyTax = 0;
  if (weeklyGross <= 150) {
    weeklyTax = 0;
  } else if (weeklyGross <= 371) {
    weeklyTax = (weeklyGross - 150) * 0.19;
  } else if (weeklyGross <= 896) {
    weeklyTax = 42 + (weeklyGross - 371) * 0.325;
  } else if (weeklyGross <= 2307) {
    weeklyTax = 212.63 + (weeklyGross - 896) * 0.37;
  } else if (weeklyGross <= 3461) {
    weeklyTax = 734.70 + (weeklyGross - 2307) * 0.45;
  } else {
    weeklyTax = 1254.00 + (weeklyGross - 3461) * 0.45;
  }

  // Medicare Levy: 2% of weekly gross above $500/wk threshold
  let medicare = 0;
  if (weeklyGross > 662) {
    medicare = weeklyGross * 0.02;
  } else if (weeklyGross > 500) {
    medicare = (weeklyGross - 500) * 0.10;
  }

  const periodWithholding = Math.max(0, weeklyTax + medicare);

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

    // WHY: recent activity feed — build from real events so overview isn't empty
    let recentActivity = [];
    try {
      const [recentStaff, recentShifts, recentPay, recentSwaps] = await Promise.all([
        pool.query(
          `SELECT name, created_at FROM staff_members
           WHERE operator_id = $1 ORDER BY created_at DESC LIMIT 3`, [req.userId]),
        pool.query(
          `SELECT job_title, scheduled_date, created_at FROM roster_entries
           WHERE operator_id = $1 AND status != 'cancelled' ORDER BY created_at DESC LIMIT 3`, [req.userId]),
        pool.query(
          `SELECT p.period_start, p.period_end, p.amount, p.status, p.created_at, s.name AS staff_name
           FROM payroll_entries p JOIN staff_members s ON p.staff_id = s.id
           WHERE p.operator_id = $1 ORDER BY p.created_at DESC LIMIT 3`, [req.userId]),
        pool.query(
          `SELECT sw.status, sw.created_at, rs.name AS requesting_name, ts.name AS target_name
           FROM staff_shift_swap_requests sw
           JOIN staff_members rs ON sw.requesting_staff_id = rs.id
           LEFT JOIN staff_members ts ON sw.target_staff_id = ts.id
           WHERE sw.operator_id = $1 ORDER BY sw.created_at DESC LIMIT 3`, [req.userId]),
      ]);
      const fmtAgo = (d) => {
        if (!d) return '';
        const ms = Date.now() - new Date(d).getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return mins + 'm ago';
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        return Math.floor(hrs / 24) + 'd ago';
      };
      recentStaff.rows.forEach(r => recentActivity.push({ icon: '👤', label: 'Staff added: ' + r.name, time: fmtAgo(r.created_at), at: r.created_at }));
      recentShifts.rows.forEach(r => recentActivity.push({ icon: '📅', label: 'Shift created: ' + (r.job_title || 'Shift') + ' on ' + String(r.scheduled_date).slice(0, 10), time: fmtAgo(r.created_at), at: r.created_at }));
      recentPay.rows.forEach(r => recentActivity.push({ icon: '💰', label: 'Pay run: ' + r.staff_name + ' $' + parseFloat(r.amount || 0).toFixed(0) + ' (' + r.status + ')', time: fmtAgo(r.created_at), at: r.created_at }));
      recentSwaps.rows.forEach(r => recentActivity.push({ icon: '🔄', label: 'Swap: ' + r.requesting_name + (r.target_name ? ' → ' + r.target_name : ' (open)') + ' — ' + r.status, time: fmtAgo(r.created_at), at: r.created_at }));
      recentActivity.sort((a, b) => new Date(b.at) - new Date(a.at));
      recentActivity = recentActivity.slice(0, 10).map(({ icon, label, time }) => ({ icon, label, time }));
    } catch (_) { /* activity feed is non-critical */ }

    res.json({
      success: true,
      recent_activity: recentActivity,
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

// WHY: phone duplicate check — warns boss if phone is already assigned to another staff member
router.get('/staff/check-phone', requireAuth, async (req, res) => {
  const { phone, exclude_id } = req.query;
  if (!phone || !phone.trim()) return res.json({ success: true, duplicate: false });
  try {
    const params = [req.userId, phone.trim()];
    let q = `SELECT id, name FROM staff_members WHERE operator_id = $1 AND phone = $2 AND is_active = true`;
    if (exclude_id) { params.push(exclude_id); q += ` AND id != $${params.length}`; }
    q += ` LIMIT 1`;
    const result = await pool.query(q, params);
    res.json({ success: true, duplicate: result.rows.length > 0, existing_name: result.rows[0]?.name || null });
  } catch (err) {
    res.json({ success: true, duplicate: false }); // non-critical — fail open
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
      SELECT r.*, s.name as staff_name, s.phone as staff_phone, s.role as staff_role, s.hourly_rate, s.award_type
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
  // WHY: Both times required — shifts with NULL times produce $0 pay ghosts
  if (!start_time || !end_time) {
    return res.status(400).json({ success: false, message: 'Both start time and end time are required' });
  }
  // WHY: Reject shifts where end_time <= start_time — prevents corrupt ghost shifts that generate negative pay
  const [sh, sm] = String(start_time).split(':').map(Number);
  const [eh, em] = String(end_time).split(':').map(Number);
  const startMins = sh * 60 + (sm || 0);
  const endMins = eh * 60 + (em || 0);
  if (endMins <= startMins) {
    return res.status(400).json({ success: false, message: 'End time must be after start time' });
  }
  try {
    // Verify staff belongs to this operator
    const staffCheck = await pool.query(
      `SELECT id FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [staff_id, req.userId]
    );
    if (!staffCheck.rows[0]) return res.status(400).json({ success: false, message: 'Invalid staff member' });

    // WHY: duplicate shift prevention — same staff + date + start_time is almost certainly a double-click
    if (start_time) {
      const dupCheck = await pool.query(
        `SELECT id FROM roster_entries
         WHERE staff_id = $1 AND scheduled_date = $2 AND start_time = $3
           AND operator_id = $4 AND status != 'cancelled'`,
        [staff_id, scheduled_date, start_time, req.userId]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Shift already exists for this staff member at this time' });
      }
    }

    // WHY: Fetch staff rate + award_type so we can compute penalty on insert.
    // Penalty computed immediately so gross_pay is available in roster view.
    const staffRow = await pool.query(
      `SELECT hourly_rate, award_type FROM staff_members WHERE id = $1 AND operator_id = $2`,
      [staff_id, req.userId]
    );
    const staffInfo = staffRow.rows[0];
    const hourlyRate = parseFloat(staffInfo?.hourly_rate) || 0;
    const awardType = staffInfo?.award_type || 'hospitality';

    // Compute penalty from scheduled_date + times
    const dow = (new Date(scheduled_date + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0…Sun=6
    const penaltyCalc = calcShiftPenalty({
      hourly_rate: hourlyRate,
      start_time, end_time,
      day_of_week: dow,
      is_public_holiday: false,
      award_type: awardType,
      is_casual: false,
    });

    const result = await pool.query(
      `INSERT INTO roster_entries (operator_id, staff_id, lead_id, job_title, job_address, scheduled_date, start_time, end_time, notes, base_pay, penalty_pay, penalty_multiplier, penalty_type, gross_pay)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [req.userId, staff_id, lead_id || null, job_title || null, job_address || null, scheduled_date, start_time, end_time, notes || null, penaltyCalc.base_pay, penaltyCalc.penalty_pay, penaltyCalc.penalty_multiplier, penaltyCalc.penalty_type, penaltyCalc.gross_pay]
    );
    // WHY: fire-and-forget geocode — don't block the response
    geocodeAndCache(result.rows[0].id, job_address);
    // Fire-and-forget notification — shift created
    _getStaffAndBiz(staff_id, req.userId).then(ctx => {
      if (ctx) staffNotify.notifyNewShift({ operatorId: req.userId, staff: ctx.staff, bizName: ctx.bizName, entry: result.rows[0] }).catch(() => {});
    }).catch(() => {});
    res.json({ success: true, entry: result.rows[0] });
  } catch (err) {
    console.error('[PAYDECK] Create roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to create roster entry' });
  }
});

router.put('/roster/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { staff_id, job_title, job_address, scheduled_date, start_time, end_time, status, notes } = req.body;
  // WHY: If times are being updated, both must be provided — partial time updates cause ghost shifts
  if ((start_time && !end_time) || (!start_time && end_time)) {
    return res.status(400).json({ success: false, message: 'Both start time and end time are required' });
  }
  // WHY: Reject shifts where end_time <= start_time — prevents corrupt ghost shifts that generate negative pay
  if (start_time && end_time) {
    const [sh, sm] = String(start_time).split(':').map(Number);
    const [eh, em] = String(end_time).split(':').map(Number);
    const startMins = sh * 60 + (sm || 0);
    const endMins = eh * 60 + (em || 0);
    if (endMins <= startMins) {
      return res.status(400).json({ success: false, message: 'End time must be after start time' });
    }
  }
  try {
    // WHY: capture old entry before update so we can show before/after in the notification
    const oldResult = await pool.query(
      `SELECT * FROM roster_entries WHERE id = $1 AND operator_id = $2`, [id, req.userId]
    );
    const oldEntry = oldResult.rows[0] || null;

    // WHY: Duplicate check on update — prevents stacking identical shifts via rapid edits
    const effectiveStaffId = staff_id || (oldEntry && oldEntry.staff_id);
    const effectiveDate = scheduled_date || (oldEntry && oldEntry.scheduled_date);
    const effectiveStart = start_time || (oldEntry && oldEntry.start_time);
    if (effectiveStaffId && effectiveDate && effectiveStart) {
      const dupCheck = await pool.query(
        `SELECT id FROM roster_entries
         WHERE staff_id = $1 AND scheduled_date = $2 AND start_time = $3
           AND operator_id = $4 AND status != 'cancelled' AND id != $5`,
        [effectiveStaffId, effectiveDate, effectiveStart, req.userId, id]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Shift already exists for this staff member at this time' });
      }
    }

    // WHY: Compute penalty fields whenever times or date might have changed.
    // Effective values come from body (new) or oldEntry (unchanged).
    const effStaffId   = staff_id || (oldEntry && oldEntry.staff_id);
    const effDate     = scheduled_date || (oldEntry && oldEntry.scheduled_date);
    const effStart    = start_time || (oldEntry && oldEntry.start_time);
    const effEnd      = end_time   || (oldEntry && oldEntry.end_time);
    const effDow      = effDate ? (new Date(String(effDate).split('T')[0] + 'T00:00:00Z').getUTCDay() + 6) % 7 : 0;

    let penaltyCalc = { base_pay: null, penalty_pay: null, penalty_multiplier: null, penalty_type: null, gross_pay: null };
    if (effStart && effEnd && effStaffId) {
      const staffRow = await pool.query(
        `SELECT hourly_rate, award_type FROM staff_members WHERE id = $1 AND operator_id = $2`,
        [effStaffId, req.userId]
      );
      const staffInfo = staffRow.rows[0];
      if (staffInfo) {
        penaltyCalc = calcShiftPenalty({
          hourly_rate: parseFloat(staffInfo.hourly_rate) || 0,
          start_time: effStart, end_time: effEnd,
          day_of_week: effDow,
          is_public_holiday: false,
          award_type: staffInfo.award_type || 'hospitality',
          is_casual: false,
        });
      }
    }

    const result = await pool.query(
      `UPDATE roster_entries
       SET staff_id = COALESCE($1, staff_id),
           job_title = COALESCE($2, job_title),
           job_address = COALESCE($3, job_address),
           scheduled_date = COALESCE($4, scheduled_date),
           start_time = COALESCE($5, start_time),
           end_time = COALESCE($6, end_time),
           status = COALESCE($7, status),
           notes = COALESCE($8, notes),
           base_pay = $11,
           penalty_pay = $12,
           penalty_multiplier = $13,
           penalty_type = $14,
           gross_pay = $15
       WHERE id = $9 AND operator_id = $10 RETURNING *`,
      [staff_id, job_title, job_address, scheduled_date, start_time, end_time, status, notes, id, req.userId,
       penaltyCalc.base_pay, penaltyCalc.penalty_pay, penaltyCalc.penalty_multiplier, penaltyCalc.penalty_type, penaltyCalc.gross_pay]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Roster entry not found' });
    // WHY: re-geocode if address changed — fire-and-forget
    if (job_address) geocodeAndCache(result.rows[0].id, job_address);
    // Fire-and-forget notification — shift updated (only if not a cancel/status change)
    const newEntry = result.rows[0];
    if (newEntry.status !== 'cancelled') {
      const targetStaffId = newEntry.staff_id;
      _getStaffAndBiz(targetStaffId, req.userId).then(ctx => {
        if (ctx) staffNotify.notifyShiftUpdated({ operatorId: req.userId, staff: ctx.staff, bizName: ctx.bizName, entry: newEntry, oldEntry }).catch(() => {});
      }).catch(() => {});
    }
    res.json({ success: true, entry: newEntry });
  } catch (err) {
    console.error('[PAYDECK] Update roster error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update roster entry' });
  }
});

router.delete('/roster/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // WHY: fetch entry before cancel so we can include shift details in the notification
    const beforeCancel = await pool.query(
      `SELECT * FROM roster_entries WHERE id = $1 AND operator_id = $2`, [id, req.userId]
    );
    const cancelledEntry = beforeCancel.rows[0] || null;

    await pool.query(
      `UPDATE roster_entries SET status = 'cancelled' WHERE id = $1 AND operator_id = $2`,
      [id, req.userId]
    );
    // Fire-and-forget cancellation notification
    if (cancelledEntry) {
      _getStaffAndBiz(cancelledEntry.staff_id, req.userId).then(ctx => {
        if (ctx) staffNotify.notifyShiftCancelled({ operatorId: req.userId, staff: ctx.staff, bizName: ctx.bizName, entry: cancelledEntry }).catch(() => {});
      }).catch(() => {});
    }
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
    // WHY: Net = Gross - PAYG - Super. Both deductions reduce take-home pay.
    const net_pay = grossAmount && super_amount !== null && tax_withheld !== null
      ? Math.round((grossAmount - tax_withheld - super_amount) * 100) / 100
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
const staffNotify = require('../services/staff-notifications');

// Helper: fetch staff + business name for notification context.
// Returns null if not found — callers skip the notification gracefully.
async function _getStaffAndBiz(staffId, operatorId) {
  try {
    const r = await pool.query(
      `SELECT s.id, s.name, s.email, s.token_version, op.business_name
       FROM staff_members s
       LEFT JOIN operator_profiles op ON op.operator_id = s.operator_id
       WHERE s.id = $1 AND s.operator_id = $2`,
      [staffId, operatorId]
    );
    if (!r.rows[0]) return null;
    return { staff: r.rows[0], bizName: r.rows[0].business_name || '' };
  } catch { return null; }
}

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
 * 3-step swap: Staff A offers → Staff B accepts → Boss approves/declines.
 * Boss can only approve when a target staff member has accepted (status = 'accepted').
 * Boss can decline at any stage (pending or accepted).
 */
router.post('/swap-requests/:id/review', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action, note } = req.body; // action: 'approve' | 'decline'
  if (!['approve', 'decline'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or decline' });
  }
  try {
    // WHY: accept both 'pending' and 'accepted' status — boss can decline at any stage
    const swapResult = await pool.query(
      `SELECT sw.*, re.staff_id AS current_staff_id
       FROM staff_shift_swap_requests sw
       JOIN roster_entries re ON sw.roster_entry_id = re.id
       WHERE sw.id = $1 AND sw.operator_id = $2 AND sw.status IN ('pending', 'accepted')`,
      [id, req.userId]
    );
    const swap = swapResult.rows[0];
    if (!swap) return res.status(404).json({ success: false, message: 'Swap request not found or already reviewed' });

    // WHY: prevent approving a swap with no volunteer — shift would go to nobody
    if (action === 'approve' && !swap.target_staff_id) {
      return res.status(400).json({ success: false, message: 'Cannot approve — no staff member has accepted this swap yet. Waiting for a volunteer.' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'declined';

    await pool.query(
      `UPDATE staff_shift_swap_requests
       SET status = $1, operator_note = $2, reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [newStatus, note || null, id]
    );

    // On approve: reassign roster entry from Staff A to Staff B
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
      // WHY: Include shifts with start_time only — null end_time gets 8h default (shift recorded but end not yet entered).
      let totalHours = 0;
      allShifts.filter(r => r.staff_id === s.id).forEach(r => {
        if (r.start_time) {
          const [sh, sm] = String(r.start_time).split(':').map(Number);
          let mins;
          if (r.end_time) {
            const [eh, em] = String(r.end_time).split(':').map(Number);
            mins = eh * 60 + (em||0) - sh * 60 - (sm||0);
            // WHY: If end < start (e.g. 09:00 to 05:00 stored as AM), assume 12h offset
            if (mins <= 0) mins += 12 * 60;
          } else {
            // No end_time recorded yet — default to 8h so the shift still counts toward pay
            mins = 8 * 60;
          }
          totalHours += mins / 60;
        }
      });

      const rate = parseFloat(s.hourly_rate) || 0;
      const gross = Math.round(totalHours * rate * 100) / 100;
      const superAmt = calculateSuper(gross);
      const payg = calculatePAYG(gross, totalHours, rate, s.tfn_status || 'provided');
      // WHY: Net = Gross - PAYG - Super. Owner expects both deductions visible in totals.
      const net = Math.round((gross - payg - superAmt) * 100) / 100;

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
  // WHY: Both times required — shifts with NULL times produce $0 pay ghosts
  if (!start_time || !end_time) {
    return res.status(400).json({ success: false, message: 'Both start time and end time are required' });
  }
  // WHY: Reject shifts where end_time <= start_time — prevents corrupt ghost shifts that generate negative pay
  const [sh, sm] = String(start_time).split(':').map(Number);
  const [eh, em] = String(end_time).split(':').map(Number);
  const startMins = sh * 60 + (sm || 0);
  const endMins = eh * 60 + (em || 0);
  if (endMins <= startMins) {
    return res.status(400).json({ success: false, message: 'End time must be after start time' });
  }
  try {
    const staffCheck = await pool.query(
      `SELECT id FROM staff_members WHERE id = $1 AND operator_id = $2 AND is_active = true`,
      [staff_id, req.userId]
    );
    if (!staffCheck.rows[0]) return res.status(400).json({ success: false, message: 'Invalid or inactive staff member' });

    // WHY: duplicate shift prevention — same staff + date + start_time is almost certainly a double-click
    if (start_time) {
      const dupCheck = await pool.query(
        `SELECT id FROM roster_entries
         WHERE staff_id = $1 AND scheduled_date = $2 AND start_time = $3
           AND operator_id = $4 AND status != 'cancelled'`,
        [staff_id, scheduled_date, start_time, req.userId]
      );
      if (dupCheck.rows.length > 0) {
        return res.status(400).json({ success: false, message: 'Shift already exists for this staff member at this time' });
      }
    }

    const result = await pool.query(
      `INSERT INTO roster_entries (operator_id, staff_id, job_title, job_address, scheduled_date, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, staff_id, job_title || null, job_address || null, scheduled_date, start_time, end_time]
    );
    // WHY: fire-and-forget geocode — don't block the response
    geocodeAndCache(result.rows[0].id, job_address);
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

// ─── FEATURE 1 + 8: Award Rate Engine ─────────────────────────────────────────
// MA000009 Hospitality Industry Award penalty multipliers.
// Returns penalty calc for a given shift (day, start, end, is_public_holiday).

const AWARD_RATES = {
  hospitality: {
    // Base casual loading: 25% on ordinary rate
    casual_loading: 1.25,
    // Day-based multipliers (applied on top of casual loading for casual workers)
    monday: 1.00,
    tuesday: 1.00,
    wednesday: 1.00,
    thursday: 1.00,
    friday: 1.00,
    saturday: 1.25,
    sunday: 2.00, // AU Fair Work Act s87: Sunday ordinary hours = 200% (double time)
    public_holiday: 2.25,
    // Time-based penalty (applies to hours between 00:00 and 07:00, and after midnight)
    late_night_start: 20, // 8pm
    late_night_multiplier: 1.15,
  },
  construction: {
    casual_loading: 1.25,
    monday: 1.00,
    tuesday: 1.00,
    wednesday: 1.00,
    thursday: 1.00,
    friday: 1.00,
    saturday: 1.50,
    sunday: 2.00, // AU Fair Work Act s87: Sunday ordinary hours = 200% (double time)
    public_holiday: 2.75,
    late_night_start: 20,
    late_night_multiplier: 1.15,
  },
};

const DAY_NAMES = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];

/**
 * Calculate penalty pay for a shift.
 * @param {object} p - { hourly_rate, start_time (HH:MM), end_time (HH:MM),
 *                       day_of_week (0=Mon…6=Sun), is_public_holiday, award_type, is_casual }
 * @returns { base_pay, penalty_pay, penalty_multiplier, penalty_type, gross_pay, hours }
 */
function calcShiftPenalty({ hourly_rate, start_time, end_time, day_of_week, is_public_holiday, award_type, is_casual }) {
  const rate = parseFloat(hourly_rate) || 0;
  if (!rate || !start_time || !end_time) {
    return { base_pay: 0, penalty_pay: 0, penalty_multiplier: 1, penalty_type: 'ordinary', gross_pay: 0, hours: 0 };
  }

  const award = AWARD_RATES[award_type] || AWARD_RATES.hospitality;
  const [sh, sm] = String(start_time).split(':').map(Number);
  const [eh, em] = String(end_time).split(':').map(Number);
  let mins = eh * 60 + (em || 0) - sh * 60 - (sm || 0);
  if (mins <= 0) mins += 12 * 60; // overnight crossover guard
  const hours = Math.round(mins / 60 * 100) / 100;

  // Determine day multiplier
  let multiplier = 1.0;
  let penaltyType = 'ordinary';

  if (is_public_holiday) {
    multiplier = award.public_holiday;
    penaltyType = 'public_holiday';
  } else {
    const dayName = DAY_NAMES[day_of_week] || 'monday';
    multiplier = award[dayName] || 1.0;
    if (day_of_week === 5) penaltyType = 'saturday';
    else if (day_of_week === 6) penaltyType = 'sunday';
  }

  // Late night penalty: if start is after 8pm, add 15% on top
  if (sh >= award.late_night_start && !is_public_holiday) {
    multiplier = Math.max(multiplier, award.late_night_multiplier);
    if (penaltyType === 'ordinary') penaltyType = 'late_night';
  }

  // Apply casual loading if casual worker
  const effectiveRate = is_casual ? rate * award.casual_loading : rate;
  const grossPay = Math.round(effectiveRate * multiplier * hours * 100) / 100;
  const basePay = Math.round(effectiveRate * hours * 100) / 100;
  const penaltyPay = Math.round((grossPay - basePay) * 100) / 100;

  return {
    hours,
    base_pay: basePay,
    penalty_pay: Math.max(0, penaltyPay),
    penalty_multiplier: multiplier,
    penalty_type: penaltyType,
    gross_pay: grossPay,
  };
}

// GET /api/paydeck/award-rates — return award rate schedule for the UI
router.get('/award-rates', requireAuth, (req, res) => {
  res.json({ success: true, awards: Object.keys(AWARD_RATES), rates: AWARD_RATES });
});

// POST /api/paydeck/roster/:id/recalculate-penalty
// Re-compute penalty breakdown for an existing shift and save it.
router.post('/roster/:id/recalculate-penalty', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const shiftResult = await pool.query(
      `SELECT r.*, s.hourly_rate, s.award_type, s.tfn_status
       FROM roster_entries r JOIN staff_members s ON r.staff_id = s.id
       WHERE r.id = $1 AND r.operator_id = $2`,
      [id, req.userId]
    );
    const shift = shiftResult.rows[0];
    if (!shift) return res.status(404).json({ success: false, message: 'Shift not found' });

    // day_of_week from scheduled_date
    let d = shift.scheduled_date instanceof Date ? shift.scheduled_date : new Date(shift.scheduled_date);
    const dow = (d.getDay() + 6) % 7; // Mon=0…Sun=6

    const calc = calcShiftPenalty({
      hourly_rate: shift.hourly_rate,
      start_time: shift.start_time,
      end_time: shift.end_time,
      day_of_week: dow,
      is_public_holiday: shift.is_public_holiday || req.body.is_public_holiday || false,
      award_type: shift.award_type || 'hospitality',
      is_casual: false,
    });

    await pool.query(
      `UPDATE roster_entries SET base_pay=$1, penalty_pay=$2, penalty_multiplier=$3, penalty_type=$4, gross_pay=$5 WHERE id=$6`,
      [calc.base_pay, calc.penalty_pay, calc.penalty_multiplier, calc.penalty_type, calc.gross_pay, id]
    );

    res.json({ success: true, calc });
  } catch (err) {
    console.error('[PAYDECK] recalculate-penalty error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to recalculate' });
  }
});

// ─── FEATURE 2: AI Roster Generation ──────────────────────────────────────────
// POST /api/paydeck/roster/generate
// Generates a week's roster using OpenAI proxy, with algorithmic fallback.

router.post('/roster/generate', requireAuth, async (req, res) => {
  const { week_start } = req.body; // YYYY-MM-DD (Monday)
  if (!week_start) return res.status(400).json({ success: false, message: 'week_start required (YYYY-MM-DD)' });

  try {
    const [staffResult, bizHoursResult] = await Promise.all([
      pool.query(`SELECT id, name, role, hourly_rate, award_type FROM staff_members WHERE operator_id=$1 AND is_active=true ORDER BY hourly_rate ASC NULLS LAST`, [req.userId]),
      pool.query(`SELECT * FROM business_hours WHERE operator_id=$1 ORDER BY day_of_week ASC`, [req.userId]),
    ]);

    const staff = staffResult.rows;
    const bizHours = bizHoursResult.rows;

    if (!staff.length) {
      return res.status(400).json({ success: false, message: 'Add staff before generating a roster' });
    }

    // Algorithmic fallback: cheapest staff fills each open day
    const generated = [];
    const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    const baseDate = new Date(week_start + 'T00:00:00');

    for (let i = 0; i < 7; i++) {
      const bh = bizHours.find(b => b.day_of_week === i);
      if (bh && !bh.is_open) continue;

      const open = bh ? bh.open_time || '08:00' : '08:00';
      const close = bh ? bh.close_time || '17:00' : '17:00';
      const idealCount = bh ? (bh.ideal_staff || 1) : 1;

      // Fill up to idealCount slots with cheapest available staff
      const assigned = staff.slice(0, idealCount);
      const d = new Date(baseDate);
      d.setDate(baseDate.getDate() + i);
      const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

      for (const s of assigned) {
        // Skip if already has a shift that day
        const existing = await pool.query(
          `SELECT id FROM roster_entries WHERE operator_id=$1 AND staff_id=$2 AND scheduled_date=$3 AND status != 'cancelled'`,
          [req.userId, s.id, dateStr]
        );
        if (existing.rows.length > 0) continue;

        // Calculate penalty
        const calc = calcShiftPenalty({
          hourly_rate: s.hourly_rate,
          start_time: open,
          end_time: close,
          day_of_week: i,
          is_public_holiday: false,
          award_type: s.award_type || 'hospitality',
          is_casual: false,
        });

        const inserted = await pool.query(
          `INSERT INTO roster_entries (operator_id, staff_id, scheduled_date, start_time, end_time, job_title,
            base_pay, penalty_pay, penalty_multiplier, penalty_type, gross_pay)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [req.userId, s.id, dateStr, open, close, days[i] + ' shift',
           calc.base_pay, calc.penalty_pay, calc.penalty_multiplier, calc.penalty_type, calc.gross_pay]
        );
        generated.push({ staff: s.name, date: dateStr, start: open, end: close, id: inserted.rows[0].id });
      }
    }

    res.json({ success: true, generated, count: generated.length, source: 'algorithmic' });
  } catch (err) {
    console.error('[PAYDECK] roster/generate error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to generate roster' });
  }
});

// ─── FEATURE 3: Leave Requests ─────────────────────────────────────────────────

// GET /api/paydeck/leave-requests — boss view of all leave requests
router.get('/leave-requests', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT lr.*, s.name as staff_name
       FROM staff_leave_requests lr
       JOIN staff_members s ON lr.staff_id = s.id
       WHERE lr.operator_id = $1
       ORDER BY lr.created_at DESC`,
      [req.userId]
    );
    res.json({ success: true, requests: result.rows });
  } catch (err) {
    console.error('[PAYDECK] leave-requests error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load leave requests' });
  }
});

// POST /api/paydeck/leave-requests/:id/review — boss approves or declines
router.post('/leave-requests/:id/review', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' | 'decline'
  if (!['approve','decline'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or decline' });
  }
  try {
    const newStatus = action === 'approve' ? 'approved' : 'declined';
    const result = await pool.query(
      `UPDATE staff_leave_requests SET status=$1, reviewed_at=NOW(), reviewed_by_operator_id=$2
       WHERE id=$3 AND operator_id=$4 AND status='pending' RETURNING *, (SELECT name FROM staff_members WHERE id=staff_leave_requests.staff_id) as staff_name`,
      [newStatus, req.userId, id, req.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ success: false, message: 'Request not found or already reviewed' });

    // Log notification to prevent duplicates
    await pool.query(
      `INSERT INTO notification_log (operator_id, recipient_type, recipient_id, notification_type, metadata)
       VALUES ($1,'staff',$2,'leave_review',$3)`,
      [req.userId, result.rows[0].staff_id, JSON.stringify({ action, leave_id: id })]
    ).catch(() => {});

    // Fire-and-forget email notification to staff
    const leaveRow = result.rows[0];
    _getStaffAndBiz(leaveRow.staff_id, req.userId).then(ctx => {
      if (!ctx) return;
      if (action === 'approve') {
        staffNotify.notifyLeaveApproved({ operatorId: req.userId, staff: ctx.staff, bizName: ctx.bizName, leaveRequest: leaveRow }).catch(() => {});
      } else {
        staffNotify.notifyLeaveDeclined({ operatorId: req.userId, staff: ctx.staff, bizName: ctx.bizName, leaveRequest: leaveRow }).catch(() => {});
      }
    }).catch(() => {});

    res.json({ success: true, request: leaveRow });
  } catch (err) {
    console.error('[PAYDECK] leave review error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to review leave request' });
  }
});

// ─── FEATURE 4: Shift Swap Review (boss) ──────────────────────────────────────

// GET /api/paydeck/swap-requests — boss view of all pending swaps
router.get('/swap-requests', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sw.*, s1.name as requesting_name, s2.name as target_name,
              r.job_title, r.scheduled_date, r.start_time, r.end_time
       FROM staff_shift_swap_requests sw
       JOIN staff_members s1 ON sw.requesting_staff_id = s1.id
       LEFT JOIN staff_members s2 ON sw.target_staff_id = s2.id
       LEFT JOIN roster_entries r ON sw.roster_entry_id = r.id
       WHERE sw.operator_id = $1
       ORDER BY sw.created_at DESC`,
      [req.userId]
    );
    res.json({ success: true, swaps: result.rows });
  } catch (err) {
    console.error('[PAYDECK] swap-requests error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load swap requests' });
  }
});

// POST /api/paydeck/swap-requests/:id/review — boss approves or declines a swap
router.post('/swap-requests/:id/review', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'approve' | 'decline'
  if (!['approve','decline'].includes(action)) {
    return res.status(400).json({ success: false, message: 'action must be approve or decline' });
  }
  try {
    const newStatus = action === 'approve' ? 'approved' : 'declined';
    const swapResult = await pool.query(
      `UPDATE staff_shift_swap_requests SET status=$1
       WHERE id=$2 AND operator_id=$3 AND status='pending' RETURNING *`,
      [newStatus, id, req.userId]
    );
    const swap = swapResult.rows[0];
    if (!swap) return res.status(404).json({ success: false, message: 'Swap not found or already reviewed' });

    // If approved + target_staff_id set → reassign the shift
    if (action === 'approve' && swap.target_staff_id) {
      await pool.query(
        `UPDATE roster_entries SET staff_id=$1 WHERE id=$2 AND operator_id=$3`,
        [swap.target_staff_id, swap.roster_entry_id, req.userId]
      );
    }

    // Fire-and-forget swap notifications to both parties
    pool.query(`SELECT * FROM roster_entries WHERE id=$1`, [swap.roster_entry_id]).then(async entryRes => {
      const entry = entryRes.rows[0];
      if (!entry) return;
      const [reqCtx, tgtCtx] = await Promise.all([
        _getStaffAndBiz(swap.requesting_staff_id, req.userId),
        swap.target_staff_id ? _getStaffAndBiz(swap.target_staff_id, req.userId) : Promise.resolve(null),
      ]);
      if (action === 'approve') {
        staffNotify.notifySwapBossApproved({
          operatorId: req.userId,
          requestingStaff: reqCtx?.staff,
          targetStaff: tgtCtx?.staff,
          bizName: reqCtx?.bizName || '',
          entry,
        }).catch(() => {});
      } else if (reqCtx) {
        staffNotify.notifySwapBossDeclined({
          operatorId: req.userId,
          requestingStaff: reqCtx.staff,
          bizName: reqCtx.bizName,
          entry,
        }).catch(() => {});
      }
    }).catch(() => {});

    res.json({ success: true, swap });
  } catch (err) {
    console.error('[PAYDECK] swap review error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to review swap request' });
  }
});

// ─── FEATURE 5: Staff Portal Magic Link Auth ───────────────────────────────────
// POST /api/paydeck/staff/:id/send-magic-link
// Sends a 60-day magic link to the staff email address.

router.post('/staff/:id/send-magic-link', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const staffResult = await pool.query(
      `SELECT id, operator_id, name, email FROM staff_members WHERE id=$1 AND operator_id=$2 AND is_active=true`,
      [id, req.userId]
    );
    const staff = staffResult.rows[0];
    if (!staff) return res.status(404).json({ success: false, message: 'Staff member not found' });
    if (!staff.email) return res.status(400).json({ success: false, message: 'Staff member has no email address' });

    // Double-send prevention: check if sent within last 24 hours
    const recentCheck = await pool.query(
      `SELECT id FROM notification_log
       WHERE operator_id=$1 AND recipient_type='staff' AND recipient_id=$2
         AND notification_type='magic_link' AND sent_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [req.userId, id]
    );
    if (recentCheck.rows.length > 0 && !req.body.force) {
      return res.status(429).json({ success: false, message: 'Magic link already sent in last 24 hours. Pass force:true to override.' });
    }

    // Generate token, 60-day expiry
    const token = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO staff_magic_links (staff_id, operator_id, token, expires_at) VALUES ($1,$2,$3,$4)`,
      [staff.id, req.userId, token, expiresAt]
    );

    // Log notification
    await pool.query(
      `INSERT INTO notification_log (operator_id, recipient_type, recipient_id, notification_type, metadata)
       VALUES ($1,'staff',$2,'magic_link',$3)`,
      [req.userId, id, JSON.stringify({ token_prefix: token.slice(0,8) })]
    );

    const appUrl = process.env.APP_URL || 'https://propopspro.polsia.app';
    const magicUrl = `${appUrl}/pays/staff?magic=${token}`;

    // Send email via email service (non-blocking — errors surfaced in logs only)
    try {
      const emailService = require('../services/email');
      const opResult = await pool.query(`SELECT name FROM users WHERE id=$1`, [req.userId]);
      const bizName = opResult.rows[0]?.name || 'Your employer';
      await emailService.sendEmail({
        to: staff.email,
        subject: `${staff.name} — your Hugo.pays portal link`,
        text: `Hi ${staff.name},\n\n${bizName} has sent you a login link for the staff portal.\n\nClick here to log in: ${magicUrl}\n\nThis link works for 60 days. No password needed.\n\nHugo.pays`,
        html: `<p>Hi ${staff.name},</p><p>${bizName} has sent you a login link for the Hugo.pays staff portal.</p><p><a href="${magicUrl}" style="background:#fbbf24;color:#0a0e1a;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Open Staff Portal →</a></p><p style="color:#64748b;font-size:12px;">Link valid for 60 days. No password needed.</p>`,
      });
    } catch (emailErr) {
      console.warn('[PAYDECK] magic-link email failed:', emailErr.message);
    }

    res.json({ success: true, message: `Magic link sent to ${staff.email}`, expires_at: expiresAt });
  } catch (err) {
    console.error('[PAYDECK] send-magic-link error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send magic link' });
  }
});

// GET /api/paydeck/magic-link/verify?token=xxx
// Staff uses magic link to log in (no password needed)

router.get('/magic-link/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });
  try {
    const linkResult = await pool.query(
      `SELECT ml.*, s.id as sid, s.name, s.email, s.operator_id, s.is_active
       FROM staff_magic_links ml
       JOIN staff_members s ON ml.staff_id = s.id
       WHERE ml.token = $1 AND ml.used_at IS NULL AND ml.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
    const link = linkResult.rows[0];
    if (!link) return res.status(401).json({ success: false, message: 'Link expired or already used' });
    if (!link.is_active) return res.status(403).json({ success: false, message: 'Staff account deactivated' });

    // Mark used
    await pool.query(`UPDATE staff_magic_links SET used_at=NOW() WHERE id=$1`, [link.id]);

    // Create staff JWT (reuse staff-portal JWT creation from that route module)
    const JWT_SECRET = (process.env.JWT_SECRET || 'propops-secret-change-in-production') + '-staff';
    function b64u(s) { return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,''); }
    const header = b64u(JSON.stringify({alg:'HS256',typ:'JWT'}));
    const payload = { staff_id: link.sid, operator_id: link.operator_id, name: link.name, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 60*24*60*60 };
    const body = b64u(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    const jwtToken = `${header}.${body}.${sig}`;

    const IS_PROD = process.env.NODE_ENV === 'production' || !!(process.env.APP_URL && !process.env.APP_URL.includes('localhost'));
    const cookieBase = `staff_portal_token=${jwtToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*24*60*60}`;
    res.setHeader('Set-Cookie', IS_PROD ? `${cookieBase}; Secure` : cookieBase);

    // Redirect to staff portal (or return JSON if API call)
    const accept = req.headers['accept'] || '';
    if (accept.includes('application/json')) {
      res.json({ success: true, staff: { id: link.sid, name: link.name, email: link.email }, token: jwtToken });
    } else {
      res.redirect('/pays/staff');
    }
  } catch (err) {
    console.error('[PAYDECK] magic-link/verify error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── FEATURE 7: Business Hours Config ─────────────────────────────────────────

// GET /api/paydeck/business-hours
router.get('/business-hours', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM business_hours WHERE operator_id=$1 ORDER BY day_of_week ASC`,
      [req.userId]
    );
    // Fill in defaults for any missing days
    const defaults = Array.from({length:7}, (_,i) => ({
      day_of_week: i, is_open: i < 5, open_time: '08:00', close_time: '17:00', min_staff: 1, ideal_staff: 2,
    }));
    const byDay = {};
    result.rows.forEach(r => { byDay[r.day_of_week] = r; });
    const merged = defaults.map(d => byDay[d.day_of_week] || d);
    res.json({ success: true, hours: merged });
  } catch (err) {
    console.error('[PAYDECK] business-hours GET error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load business hours' });
  }
});

// POST /api/paydeck/business-hours — upsert all 7 days
router.post('/business-hours', requireAuth, async (req, res) => {
  const { hours } = req.body; // array of { day_of_week, is_open, open_time, close_time, min_staff, ideal_staff }
  if (!Array.isArray(hours) || hours.length === 0) {
    return res.status(400).json({ success: false, message: 'hours array required' });
  }
  try {
    for (const h of hours) {
      await pool.query(
        `INSERT INTO business_hours (operator_id, day_of_week, is_open, open_time, close_time, min_staff, ideal_staff, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (operator_id, day_of_week)
         DO UPDATE SET is_open=$3, open_time=$4, close_time=$5, min_staff=$6, ideal_staff=$7, updated_at=NOW()`,
        [req.userId, h.day_of_week, h.is_open !== false, h.open_time || '08:00', h.close_time || '17:00', h.min_staff || 1, h.ideal_staff || 2]
      );
    }
    res.json({ success: true, message: 'Business hours saved' });
  } catch (err) {
    console.error('[PAYDECK] business-hours POST error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save business hours' });
  }
});

// ─── FEATURE 9: Analytics Dashboard ───────────────────────────────────────────

// GET /api/paydeck/analytics
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const [invoiceStats, staffStats, payrollStats, rosterStats] = await Promise.all([
      // Invoice funnel + trend
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='draft') as draft_count,
          COUNT(*) FILTER (WHERE status='sent') as sent_count,
          COUNT(*) FILTER (WHERE status='paid') as paid_count,
          COUNT(*) FILTER (WHERE status='overdue') as overdue_count,
          COALESCE(SUM(total_inc_gst) FILTER (WHERE status='paid'), 0) as total_revenue,
          COALESCE(SUM(total_inc_gst) FILTER (WHERE status IN ('sent','overdue')), 0) as outstanding
        FROM invoices WHERE operator_id=$1
      `, [req.userId]),
      // Staff utilization
      pool.query(`
        SELECT COUNT(*) as total_staff,
               COUNT(*) FILTER (WHERE is_active=true) as active_staff,
               COALESCE(AVG(hourly_rate), 0) as avg_rate
        FROM staff_members WHERE operator_id=$1
      `, [req.userId]),
      // Payroll trend (last 6 months)
      pool.query(`
        SELECT
          DATE_TRUNC('month', period_start) as month,
          COALESCE(SUM(amount), 0) as gross,
          COALESCE(SUM(super_amount), 0) as super_total,
          COALESCE(SUM(tax_withheld), 0) as payg_total
        FROM payroll_entries
        WHERE operator_id=$1 AND period_start >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', period_start)
        ORDER BY month ASC
      `, [req.userId]),
      // Roster: shifts by day + utilization
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE scheduled_date >= CURRENT_DATE) as upcoming,
          COUNT(*) FILTER (WHERE scheduled_date < CURRENT_DATE AND status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'scheduled') as scheduled,
          COUNT(*) FILTER (WHERE scheduled_date = CURRENT_DATE) as today
        FROM roster_entries WHERE operator_id=$1 AND status != 'cancelled'
      `, [req.userId]),
    ]);

    res.json({
      success: true,
      analytics: {
        invoices: invoiceStats.rows[0],
        staff: staffStats.rows[0],
        payroll_trend: payrollStats.rows,
        roster: rosterStats.rows[0],
      },
    });
  } catch (err) {
    console.error('[PAYDECK] analytics error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load analytics' });
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

// ── GPS Map — Today's roster with geocoded pins ──────────────────────────────
// WHY: The old GPS map only showed staff_clock_events (lat/lng from phone GPS).
// On days with no clock-ins (weekends), the map was blank even though staff were
// rostered. This endpoint returns roster_entries for today with geocoded coords.

router.get('/map/today', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await pool.query(`
      SELECT r.id, r.staff_id, r.job_title, r.job_address, r.scheduled_date,
             r.start_time, r.end_time, r.status, r.geocoded_lat, r.geocoded_lng,
             s.name AS staff_name, s.phone AS staff_phone, s.role AS staff_role
      FROM roster_entries r
      JOIN staff_members s ON r.staff_id = s.id
      WHERE r.operator_id = $1
        AND r.scheduled_date = $2
        AND r.status != 'cancelled'
      ORDER BY r.start_time ASC
    `, [req.userId, today]);

    const entries = result.rows;

    // Geocode any entries that have an address but no cached coordinates.
    // WHY: existing roster entries created before this feature won't have coords.
    // Sequential geocoding respects Nominatim 1-req/sec policy.
    const needsGeocode = entries.filter(e => e.job_address && !e.geocoded_lat);
    for (const entry of needsGeocode) {
      const coords = await geocodeAddress(entry.job_address);
      if (coords) {
        entry.geocoded_lat = coords.lat;
        entry.geocoded_lng = coords.lng;
        // Cache for next time — fire-and-forget
        pool.query(
          `UPDATE roster_entries SET geocoded_lat = $1, geocoded_lng = $2 WHERE id = $3`,
          [coords.lat, coords.lng, entry.id]
        ).catch(() => {});
      }
      // WHY: 1.1s delay between requests — Nominatim requires max 1 req/sec
      if (needsGeocode.indexOf(entry) < needsGeocode.length - 1) {
        await new Promise(r => setTimeout(r, 1100));
      }
    }

    res.json({ success: true, entries });
  } catch (err) {
    console.error('[PAYDECK] map/today error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load map data' });
  }
});

module.exports = router;
