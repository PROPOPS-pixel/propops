const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1); // Required for correct host detection behind Render's proxy
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ─── Resend inbound webhook needs raw body for svix signature verification ───
app.use(
  '/api/email-intake/resend-inbound',
  express.raw({ type: '*/*' }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body;
      try { req.body = JSON.parse(req.rawBody.toString('utf8')); } catch { req.body = {}; }
    }
    next();
  }
);

// ─── Middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple cookie parser (no external dep)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers['cookie'];
  if (cookieHeader) {
    cookieHeader.split(';').forEach(pair => {
      const [key, ...valParts] = pair.trim().split('=');
      if (key) req.cookies[key.trim()] = decodeURIComponent(valParts.join('=') || '');
    });
  }
  next();
});

// ─── Canonical domain redirect ───────────────────────────────────────────────
const CANONICAL_HOST = (() => {
  try { return process.env.APP_URL ? new URL(process.env.APP_URL).host : null; } catch { return null; }
})();

if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = req.hostname;
    if (host === CANONICAL_HOST) return next();
    if (host === 'propops.trade' || host === 'www.propops.trade') return next();
    if (host === 'hugopays.pro' || host === 'www.hugopays.pro') return next();
    if (req.path === '/health') return next();
    if (req.path.startsWith('/api/')) return next();
    if (!((req.headers.accept || '').includes('text/html'))) return next();
    return res.redirect(302, `${process.env.APP_URL}${req.originalUrl}`);
  });
}

// Health check (required for Render)
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ─── API routes ───────────────────────────────────────────────────────────
app.use('/api/leads',         require('./routes/leads'));
app.use('/api/email-intake',  require('./routes/email-intake'));
app.use('/api/waitlist',      require('./routes/waitlist'));

// —— Founder Integrations Status API ——
app.get('/api/founder/integrations-status', async (req, res) => {
  try {
    var categoryMap = { ai: 'AI', comms: 'Comms', leads: 'Leads', billing: 'Billing', infrastructure: 'Infrastructure' };

    var integrations = {
      ai: {
        greg: { name: 'Greg', description: "Hugo's AI brain (Llama 3.1 8B)", status: 'connected' },
        hosted: { name: 'Hosted', description: 'Chat model + action configuration', status: 'connected' }
      },
      comms: {
        twilio: { name: 'Twilio', description: 'Phone: ' + (process.env.TWILIO_PHONE_NUMBER || 'Not set'), status: process.env.TWILIO_ACCOUNT_SID ? 'connected' : 'disconnected' },
        resend: { name: 'Resend', description: 'Transactional email delivery', status: process.env.RESEND_API_KEY ? 'connected' : 'disconnected' },
        email: { name: 'Email', description: 'Email forwarding & auto-intake', status: 'connected' },
        call_forwarding: { name: 'Call Forwarding', description: 'Points to: operator', status: process.env.TWILIO_ACCOUNT_SID ? 'connected' : 'disconnected' }
      },
      leads: {
        hipages: { name: 'Hipages', description: 'Auto-detection via email intake', status: 'connected' },
        lead_portals: { name: 'Lead Portals', description: 'Email intake via Email Forwarding', status: 'connected' }
      },
      billing: {
        stripe: { name: 'Stripe', description: 'Subscriptions & billing (AUS)', status: process.env.STRIPE_SECRET_KEY ? 'connected' : 'disconnected' }
      },
      infrastructure: {
        analytics: { name: 'Analytics', description: 'Stats tracking', status: 'connected' },
        porkbun: { name: 'Porkbun', description: 'Domains: propops.pro, propops.trade', status: 'connected' },
        render: { name: 'Render', description: 'App hosting', status: 'connected' }
      }
    };

    var services = [];
    Object.keys(integrations).forEach(function(catKey) {
      var catLabel = categoryMap[catKey] || catKey;
      var group = integrations[catKey];
      Object.keys(group).forEach(function(svcKey) {
        var svc = group[svcKey];
        services.push({ name: svc.name, description: svc.description, status: svc.status, category: catLabel });
      });
    });

    res.json({ success: true, services: services, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[Integrations API] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Gmail OAuth callback router — MUST mount BEFORE other /api/auth routes to avoid conflicts
const { setupRouter, callbackRouter } = require('./routes/gmail-auth');
app.use('/api/auth/callback', callbackRouter);
app.use('/setup', setupRouter);

const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/auth',     authRouter);

const { router: phoneAuthRouter } = require('./routes/phone-auth');
app.use('/api/auth', phoneAuthRouter);
app.use('/auth',     phoneAuthRouter);

app.use('/api/billing',       require('./routes/billing'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/t',             require('./routes/analytics')); // ad-blocker resistant alias
app.use('/api/listings',      require('./routes/listings'));
app.use('/api/jobs',          require('./routes/jobs'));
app.use('/api/hugo',          require('./routes/hugo'));
app.use('/api/hugo',          require('./routes/hugo-network'));
app.use('/api/hugo',          require('./routes/hugo-brain'));  // unified brain service
app.use('/api/hugo',          require('./routes/hugo-scores')); // Hugo self-monitoring scores
app.use('/api/hugo',          require('./routes/hugo-supervision')); // Hugo supervision loop (transcripts, training, performance)
app.use('/api/supervision',   require('./routes/hugo-supervision')); // Supervision trigger + anomaly endpoints
app.use('/api/hugo/emails',   require('./routes/hugo-emails')); // HUGO email inbox management
app.use('/api/referrals',     require('./routes/referrals'));   // referral panels + service area map
app.use('/api/service-area',  require('./routes/service-area')); // operator service area setup
app.use('/api/paydeck',       require('./routes/paydeck'));       // PAYDECK: staff, roster, invoices, payroll (Premium)
app.use('/api/staff-portal',  require('./routes/staff-portal'));  // Staff portal: invite auth, roster, clock-in/out, swaps
app.use('/api/hugo-widget',   require('./routes/hugo-widget'));
app.use('/api/network-leads', require('./routes/network-leads')); // Hugo widget network front door: leads + tradie signups
app.use('/api',               require('./routes/twilio-voice'));

const { router: adminRouter } = require('./routes/admin');
app.use('/api/admin',     adminRouter);
app.use('/api/dashboard', adminRouter); // hugo-insights at /api/dashboard/hugo-insights
app.use('/api/founder',   require('./routes/founder'));

// ─── Utility endpoints ────────────────────────────────────────────────────────
app.get('/api/email/status', async (req, res) => {
  const { getPendingEmailCount } = require('./services/email');
  const pendingCount = await getPendingEmailCount();
  const providers = { postmark: !!process.env.POSTMARK_SERVER_TOKEN, resend: !!process.env.RESEND_API_KEY, polsia_proxy: !!(process.env.POLSIA_API_KEY || process.env.POLSIA_API_TOKEN), polsia_ema: !!(process.env.POLSIA_EMAIL_API) };
  res.json({ success: true, email_operational: providers.postmark || providers.resend || providers.polsia_proxy, providers, pending_emails: pendingCount, fix: (providers.postmark || providers.resend || providers.polsia_proxy) ? null : 'Set POSTMARK_SERVER_TOKEN or RESEND_API_KEY' });
});

app.post('/api/support/contact', async (req, res) => {
  const { name, email, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ success: false, message: 'Name, email and message are required' });
  if (!email.includes('@')) return res.status(400).json({ success: false, message: 'Invalid email address' });
  if (message.length > 5000) return res.status(400).json({ success: false, message: 'Message too long (max 5000 characters)' });
  try {
    const { sendEmail } = require('./services/email');
    const safe = s => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    await sendEmail({ to: 'support@propops.pro', subject: `Support: ${name} (${email})`, html: `<p><strong>New support message</strong></p><p><strong>Name:</strong> ${safe(name)}</p><p><strong>Email:</strong> ${safe(email)}</p><p><strong>Message:</strong></p><p>${safe(message).replace(/\n/g, '<br>')}</p>` });
    res.json({ success: true, message: "We'll get back to you shortly." });
  } catch (err) {
    console.error('[Support] Contact form error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to send message. Please try again.' });
  }
});

app.get('/api/widget', (req, res) => res.json({ success: true, embed_code: `<script src="${req.protocol}://${req.get('host')}/widget.js"><\/script>`, api_endpoint: `${req.protocol}://${req.get('host')}/api` }));

// ─── Screenshot endpoint ──────────────────────────────────────────────────────
const { _downloadToBuffer, _SS_CACHE } = require('./routes/admin');
const _SS_FALLBACK = 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_55743/images/7169ede8-77c0-46b7-9191-70c9c9a35646.png';
const _SS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
pool.query(`CREATE TABLE IF NOT EXISTS site_settings (key VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`).catch(e => console.error('[DB] site_settings table creation failed:', e.message));

app.get('/api/screenshot', async (req, res) => {
  if (fs.existsSync(_SS_CACHE)) {
    try { const s = fs.statSync(_SS_CACHE); if (Date.now() - s.mtimeMs < _SS_MAX_AGE_MS && s.size > 10000) { res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); return res.sendFile(_SS_CACHE); } } catch {}
  }
  try { const r = await pool.query(`SELECT value FROM site_settings WHERE key = 'screenshot_b64'`); if (r.rows[0]?.value) { const b = Buffer.from(r.rows[0].value, 'base64'); if (b.length > 10000) { res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); return res.send(b); } } } catch {}
  try {
    const url = `https://image.thum.io/get/png/width/1280/${(process.env.APP_URL || 'https://propopspro.polsia.app').replace(/\/$/, '')}/demo-preview.html`;
    const buf = await _downloadToBuffer(url);
    if (buf.length > 20000) { try { fs.writeFileSync(_SS_CACHE, buf); } catch {} res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); return res.send(buf); }
    await new Promise(r => setTimeout(r, 8000));
    const buf2 = await _downloadToBuffer(url);
    if (buf2.length > 20000) { try { fs.writeFileSync(_SS_CACHE, buf2); } catch {} res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); return res.send(buf2); }
  } catch (e) { console.error(`[Screenshot] Generation failed: ${e.message}`); }
  res.redirect(_SS_FALLBACK);
});

// ─── Static files ────────────────────────────────────────────────────────
app.get('/hugo-widget.js', (req, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate').set('Pragma', 'no-cache').set('Expires', '0'); res.sendFile(path.join(__dirname, 'public', 'hugo-widget.js')); });
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─── Pages ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const isPays = req.hostname === 'hugopays.pro' || req.hostname === 'www.hugopays.pro';
  const isTrade = req.hostname === 'propops.trade' || req.hostname === 'www.propops.trade';
  let page = 'index.html';
  if (isPays) page = 'hugopays.html';
  else if (isTrade) page = 'propops-trade.html';
  const htmlPath = path.join(__dirname, 'public', page);
  if (!fs.existsSync(htmlPath)) return res.json({ message: 'Hello from Polsia Instance!' });
  let html = fs.readFileSync(htmlPath, 'utf8').replace('__POLSIA_SLUG__', process.env.POLSIA_ANALYTICS_SLUG || '');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate').set('Pragma', 'no-cache').set('Expires', '0');
  if (isTrade || isPays) res.set('Clear-Site-Data', '"cache"');
  return res.type('html').send(html);
});

app.get('/pwa-entry', (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  if (token && auth.verifySessionToken(token)) return res.redirect(302, '/dashboard');
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(htmlPath)) return res.redirect('/');
  let html = fs.readFileSync(htmlPath, 'utf8').replace('__POLSIA_SLUG__', process.env.POLSIA_ANALYTICS_SLUG || '');
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.type('html').send(html);
});

app.get(['/dashboard', '/dashboard.html'], (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  if (!token || !auth.verifySessionToken(token)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// Founder login page — completely isolated from operator login
app.get('/founder/login', (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  // If already logged in with a valid session, skip the login page
  if (token && auth.verifySessionToken(token)) return res.redirect('/founder');
  res.sendFile(path.join(__dirname, 'public', 'founder-login.html'));
});

// Founder god-mode — is_admin check happens inside the HTML via /api/founder/me
// Redirects to /founder/login (NOT /login) so auth stays isolated from operators
app.get('/founder', (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  if (!token || !auth.verifySessionToken(token)) return res.redirect('/founder/login');
  res.sendFile(path.join(__dirname, 'views', 'founder-dashboard.html'));
});

// Hugo Brain Export — read-only audit page for the founder
// Auth is handled in-page via /api/founder/brain-export (requireFounder middleware)
app.get('/founder/brain-export', (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  if (!token || !auth.verifySessionToken(token)) return res.redirect('/founder/login');
  res.sendFile(path.join(__dirname, 'public', 'founder-brain-export.html'));
});

// Hugo.pays payroll dashboard — URL is the mode (no state management needed)
// /pays and /pays/settings both serve the same SPA; in-page routing handles sections
// WHY redirect includes ?redirect=: login page and magic-link verify need to return users
// to /pays after auth, not /dashboard (which caused the infinite loop — POL-1565942)
app.get(['/pays', '/pays/settings'], (req, res) => {
  const auth = require('./services/auth');
  const token = req.cookies?.propops_session || req.cookies?.relio_session;
  if (!token || !auth.verifySessionToken(token)) return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
  res.sendFile(path.join(__dirname, 'views', 'pays-dashboard.html'));
});

// Staff portal — separate auth, no operator session required
// /pays/staff?invite=TOKEN for first-time setup; /pays/staff for returning staff
app.get('/pays/staff', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'pays-staff-portal.html'));
});
// Founder integrations status
app.get('/api/founder/integrations-status', async (req, res) => {
  res.json({
    twilio: { status: 'connected', label: 'Twilio' },
    resend: { status: 'connected', label: 'Resend' },
    gmail: { status: 'connected', label: 'Gmail' },
    stripe: { status: 'connected', label: 'Stripe' },
    porkbun: { status: 'connected', label: 'Porkbun' },
    render: { status: 'connected', label: 'Render' }
  });
});
app.get('/checkout',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/signup/success',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup-success.html')));
app.get('/login',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/reset-password',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

// ─── Error handler ────────────────────────────────────────────────────────
app.use((err, req, res, next) => { console.error('[Server] Error:', err.message); res.status(500).json({ success: false, message: 'Internal server error' }); });

// ─── Boot ───────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`PropOps server running on port ${port}`);
  require('./routes/startup').runStartup(_SS_CACHE, _downloadToBuffer);
});
