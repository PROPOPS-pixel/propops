const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const { sendWaitlistConfirmation } = require('../services/email');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// POST /api/waitlist — Sign up for early access
router.post('/', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email || typeof email !== 'string') {
            return res.status(400).json({ success: false, message: 'Email is required.' });
        }

        const trimmed = email.trim().toLowerCase();
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmed)) {
            return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
        }

        // Check for duplicate
        const existing = await pool.query('SELECT id FROM waitlist WHERE email = $1', [trimmed]);
        if (existing.rows.length > 0) {
            // Resend confirmation for duplicates too — user may not have received it
            sendWaitlistConfirmation(trimmed).catch(err =>
                console.error('[Waitlist] Failed to resend confirmation:', err.message)
            );
            return res.json({ success: true, message: 'You\'re on the list!' });
        }

        await pool.query(
            'INSERT INTO waitlist (email, source) VALUES ($1, $2)',
            [trimmed, 'landing_page']
        );

        console.log(`[Waitlist] New signup: ${trimmed}`);

        // Send confirmation email (non-blocking — signup succeeds even if email fails)
        sendWaitlistConfirmation(trimmed).catch(err =>
            console.error('[Waitlist] Failed to send confirmation email:', err.message)
        );

        res.json({ success: true, message: 'You\'re on the list!' });
    } catch (err) {
        console.error('[Waitlist] Error:', err.message);
        res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
    }
});

// GET /api/waitlist/count — Public count for social proof
router.get('/count', async (req, res) => {
    try {
        const result = await pool.query('SELECT COUNT(*) as count FROM waitlist');
        res.json({ success: true, count: parseInt(result.rows[0].count, 10) });
    } catch (err) {
        res.json({ success: true, count: 0 });
    }
});

module.exports = router;
