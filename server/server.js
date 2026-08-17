const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
const isEmail = require('isemail');

const PORT = process.env.PORT || 8123;
const SITE_ROOT = path.join(__dirname, '..');

// Email configuration - MUST be set in .env file
const TO_EMAIL = process.env.TO_EMAIL;
const CAREER_EMAIL = process.env.CAREER_EMAIL || TO_EMAIL;

if (!TO_EMAIL) {
  console.error('❌ ERROR: TO_EMAIL environment variable is not set.');
  console.error('   Please add TO_EMAIL to your .env file and restart the server.');
  process.exit(1);
}

// Cloudflare Turnstile. Both keys come from the same widget in the Cloudflare
// dashboard, so a test sitekey needs the matching test secret. The sitekey is public
// and is handed to the browser by /api/config; the secret never leaves the server.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY;
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;

if (!TURNSTILE_SITE_KEY || !TURNSTILE_SECRET_KEY) {
  console.warn('⚠️  WARNING: TURNSTILE_SITE_KEY and/or TURNSTILE_SECRET_KEY are not set.');
  console.warn('   The contact and career forms will not accept submissions.');
  console.warn('   Add both to your .env file and restart the server.');
}



// ============ VISITOR SESSION ============
// Layer 1 of the rate limiting has to tell one visitor from another. Browser headers
// cannot: every Chrome-on-Windows visitor sends the same ones and lands in a single
// shared bucket, while anyone willing to edit their user-agent mints a fresh bucket
// per request. That restrained real visitors and nobody else.
//
// An id we issue ourselves is unique per browser, so each visitor gets their own
// budget. It is still clearable — which is fine, and exactly why this is not the
// security boundary. Clearing it drops the request onto the per-IP limit, which is
// the layer that enforces. Fairness here, enforcement there.
const SESSION_COOKIE = 'sbl_sid';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;  // 24 hours
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;

// Signing makes a tampered id fail verification, so it is replaced rather than
// trusted. Without a configured secret each boot invents one, which is harmless
// while the rate-limit counters themselves live in memory and reset alongside it.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  WARNING: SESSION_SECRET is not set; using a random value for this boot.');
  console.warn('   Visitor sessions are invalidated on every restart, handing everyone a');
  console.warn('   fresh rate-limit budget. Set SESSION_SECRET in your .env to keep them stable.');
}

const app = express();

// ============ SECURITY HEADERS ============
// Registered first so they reach every response — pages, static assets, PDF
// downloads, and error replies alike.
//
//   X-Frame-Options         no other site may display these pages inside a frame.
//                           DENY rather than SAMEORIGIN because nothing here frames
//                           anything of ours. Note the direction: this governs who
//                           may frame us, not what we may frame, so the Turnstile
//                           widget — a Cloudflare page inside our page — is unaffected.
//   X-Content-Type-Options  take the Content-Type at its word instead of sniffing the
//                           body, so a file served as a download can never be guessed
//                           into being a page and executed on this origin.
//   Permissions-Policy      empty allowlists. These capabilities are available to
//                           nobody, this origin included, so no script on the page can
//                           even raise the browser prompt asking a visitor for them.
//
// X-Powered-By is emitted by Express itself, so it is switched off rather than set.
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json());
app.use(cookieParser(SESSION_SECRET));  // signed session id + CSRF token cookies
// Static files moved to end (after PDF endpoint) so logging works

// Hand a session id to any visitor arriving without a valid one. SameSite=Lax
// rather than Strict because PDF downloads are top-level navigations that may
// start from an external link; Strict would withhold the cookie there and drop
// those visitors onto the shared IP bucket. This cookie is not a CSRF defence —
// XSRF-TOKEN still carries that and stays Strict.
app.use((req, res, next) => {
  let sessionId = req.signedCookies[SESSION_COOKIE];

  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    sessionId = crypto.randomBytes(16).toString('hex');
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,      // no client-side code needs to read it
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Lax',
      maxAge: SESSION_MAX_AGE,
      signed: true,
      path: '/'
    });
  }

  req.sessionId = sessionId;
  next();
});

// ============ CLIENT IP / PROXY TRUST ============
// X-Forwarded-For is written by whoever sends the request, so it is only worth
// reading when a proxy we control wrote it. TRUST_PROXY names the hop allowed to do
// that; Express then reads the header from the right, past the hops we vouch for,
// and req.ip becomes the first address nobody vouched for.
//
// Defaults to false: assume no proxy, ignore the header, use the real socket
// address. In production behind a proxy that setting is wrong in the safe
// direction — every visitor shares the proxy's address and the per-IP limits get
// strict — rather than wrong in the direction that lets anyone forge an identity.
//
//   loopback              nginx/Caddy on this machine, forwarding over localhost
//   1                     exactly one proxy in front, whoever it happens to be
//   10.0.0.5,1.2.3.0/24   specific proxy addresses or ranges
function parseTrustProxy(raw) {
  const value = String(raw || '').trim();

  if (!value || value.toLowerCase() === 'false') return false;

  // 'true' trusts the entire chain, which makes Express take the left-most value —
  // the one the client wrote. That is precisely the hole this setting exists to
  // close, so refuse it rather than quietly honouring it.
  if (value.toLowerCase() === 'true') {
    console.error('❌ TRUST_PROXY=true trusts client-supplied headers and is never correct.');
    console.error('   Falling back to false. Use "loopback", a hop count, or proxy addresses.');
    return false;
  }

  if (/^\d+$/.test(value)) return Number(value);  // a bare number is a hop count

  return value;  // a named range ("loopback") or a comma-separated address list
}

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
app.set('trust proxy', TRUST_PROXY);

if (TRUST_PROXY === false) {
  console.log('ℹ️  trust proxy: false — X-Forwarded-For ignored, using the direct socket address.');
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  WARNING: NODE_ENV=production but TRUST_PROXY is not set.');
    console.warn('   If a proxy fronts this server then every visitor arrives wearing its');
    console.warn('   address, so one per-IP rate limit is shared by all of them at once.');
    console.warn('   Set TRUST_PROXY in your .env (usually "loopback") and restart.');
  }
} else {
  console.log(`ℹ️  trust proxy: ${TRUST_PROXY} — client IP read from X-Forwarded-For.`);
}

// ============ DATABASE SETUP ============
const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir);
const dbPath = path.join(dbDir, 'downloads.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to downloads.db');
});

// Enable WAL mode for better concurrency
db.run('PRAGMA journal_mode = WAL', (err) => {
  if (err) console.error('Failed to enable WAL mode:', err.message);
  else console.log('✅ WAL mode enabled (improved concurrency)');
});

// Set busy timeout: retry for up to 5 seconds if database is locked
db.configure('busyTimeout', 5000);

// Create downloads table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_size INTEGER,
    user_agent TEXT,
    referer TEXT,
    status TEXT,
    country TEXT,
    browser TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ip_time ON downloads(ip_address, timestamp);
  CREATE INDEX IF NOT EXISTS idx_file ON downloads(file_name);
  CREATE TABLE IF NOT EXISTS form_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT NOT NULL,
    form_type TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_form_ip_time ON form_submissions(ip_address, timestamp);
  CREATE INDEX IF NOT EXISTS idx_form_type ON form_submissions(form_type);
`);

// ============ LOGGING SETUP ============
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

function logDownload(data) {
  const logFile = path.join(logsDir, 'downloads.csv');
  const timestamp = new Date().toISOString();
  const entry = [
    timestamp,
    data.ip_address,
    data.file_name,
    data.file_size || 0,
    data.user_agent ? data.user_agent.substring(0, 100) : 'unknown',
    data.referer || 'direct',
    data.status || 'unknown'
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');

  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, 'timestamp,ip_address,file_name,file_size,user_agent,referer,status\n');
  }
  fs.appendFileSync(logFile, entry + '\n');

  dbRunWithRetry(`
    INSERT INTO downloads (ip_address, file_name, file_size, user_agent, referer, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [data.ip_address, data.file_name, data.file_size || 0, data.user_agent || 'unknown', data.referer || 'direct', data.status || 'unknown'], (err) => {
    if (err) console.error('Database insert error (downloads):', err.message);
  });
}

// ============ FORM SUBMISSION LOGGING ============
function logFormSubmission(ip, formType, status) {
  const logFile = path.join(logsDir, 'form_submissions.csv');
  const timestamp = new Date().toISOString();
  const entry = `"${timestamp}","${ip}","${formType}","${status}"`;

  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, 'timestamp,ip_address,form_type,status\n');
  }

  try {
    fs.appendFileSync(logFile, entry + '\n');
  } catch (err) {
    console.warn(`⚠️ Warning: Could not write to CSV log (file may be locked): ${err.message}`);
  }

  dbRunWithRetry(`
    INSERT INTO form_submissions (ip_address, form_type, status)
    VALUES (?, ?, ?)
  `, [ip, formType, status], (err) => {
    if (err) console.error('Database insert error (form_submissions):', err.message);
  });

  detectSuspiciousPatterns(ip);
}

// ============ SUSPICIOUS PATTERN DETECTION ============
function detectSuspiciousPatterns(ip) {
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const now = new Date();
  const tenMinutesAgo = new Date(now - windowMs);

  db.all(`
    SELECT COUNT(*) as count, status
    FROM form_submissions
    WHERE ip_address = ? AND timestamp > ?
    GROUP BY status
  `, [ip, tenMinutesAgo.toISOString()], (err, rows) => {
    if (err || !rows) return;

    const successCount = rows.find(r => r.status === 'success')?.count || 0;
    const rateLimitCount = rows.find(r => r.status === 'rate_limit_exceeded')?.count || 0;
    const totalCount = successCount + rateLimitCount;

    // Flag patterns
    if (totalCount >= 7) {
      console.warn(`🚨 Suspicious: IP ${ip} submitted ${totalCount} form(s) in 10 minutes`);
    }
    if (rateLimitCount >= 10) {
      console.warn(`🚨 Suspicious: IP ${ip} has ${rateLimitCount} rate-limited attempts`);
    }
    if (rateLimitCount > 0 && successCount === 0 && rateLimitCount >= 5) {
      console.warn(`🚨 Suspicious: IP ${ip} is blocking bot (${rateLimitCount} blocked attempts)`);
    }
  });
}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ============ RATE LIMIT STATE CLEANUP ============
// Each limiter below trims a visitor's own timestamps when that visitor returns, so
// no single entry grows large. Nothing removes the entry itself, though: someone who
// submits once and leaves stays in the map forever, and the maps end up sized by all
// traffic ever seen rather than by recent traffic. Discarding the session cookie
// mints a fresh key on every request, and layer 1 runs before the per-IP check, so
// that growth follows request rate rather than visitor count.
//
// A periodic sweep drops entries whose window has already elapsed — once the window
// has passed the entry can only ever filter down to empty, so it holds no answer
// worth keeping.
const SWEEP_INTERVAL = 5 * 60 * 1000;  // 5 minutes

function sweepExpired(map, windowMs) {
  const cutoff = Date.now() - windowMs;
  for (const [key, times] of map) {
    // timestamps are appended in order, so the last one is the newest
    if (!times.length || times[times.length - 1] < cutoff) map.delete(key);
  }
}

// Backstop for a burst arriving between two sweeps. Only the session-keyed maps get
// a ceiling, because only their keys are attacker-chosen — a new cookie is a new
// key. Capping the IP maps would let a flood evict real counters and so reset the
// limit it is meant to enforce. Map iterates in insertion order, so the oldest keys
// come first.
function capSize(map, maxEntries, label) {
  if (map.size <= maxEntries) return;

  const excess = map.size - maxEntries;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++removed >= excess) break;
  }
  console.warn(`⚠️ ${label} exceeded ${maxEntries} entries; evicted ${removed} oldest.`);
}

// ============ RATE LIMITING: LAYER 1 - VISITOR SESSION ============
// In-memory rate limit: max 5 submissions per session per 10 minutes.
// Keyed on the id issued above, so one visitor's spamming costs only their own
// budget instead of everyone who happens to run the same browser.
const sessionHits = new Map();
const FORM_SESSION_WINDOW = 10 * 60 * 1000;  // 10 minutes
const FORM_SESSION_MAX_KEYS = 50000;  // ceiling; far above any plausible real load

function rateLimited(sessionId) {
  const now = Date.now();
  const entry = sessionHits.get(sessionId) || [];
  const recent = entry.filter((t) => now - t < FORM_SESSION_WINDOW);
  recent.push(now);
  sessionHits.set(sessionId, recent);
  capSize(sessionHits, FORM_SESSION_MAX_KEYS, 'form session map');
  return recent.length > 5;
}

// ============ RATE LIMITING: LAYER 2 - GLOBAL IP LIMIT ============
// In-memory rate limit: max 30 submissions per IP per hour
// Prevents botnet attacks and header-spoofing attacks from single IP
const ipHits = new Map();
const IP_LIMIT_WINDOW = 60 * 60 * 1000;  // 1 hour in milliseconds
const IP_LIMIT_MAX = 30;  // Max 30 form submissions per hour per IP

function isIpRateLimited(ip) {
  const now = Date.now();
  const entry = ipHits.get(ip) || [];

  // Filter out requests older than 1 hour
  const recent = entry.filter((t) => now - t < IP_LIMIT_WINDOW);

  // Add current request
  recent.push(now);
  ipHits.set(ip, recent);
  // Stale entries are dropped by the periodic sweep; no ceiling here, since evicting
  // IP counters is exactly how a flood would reset the limit it just tripped.

  // Return true if over limit
  return recent.length > IP_LIMIT_MAX;
}

// Monitor global IP rate limit violations
function detectSuspiciousIpActivity(ip, count) {
  // Alert if single IP submits many forms
  if (count >= 15) {
    console.warn(`⚠️ WARNING: IP ${ip} has made ${count} form submissions in 1 hour`);
  }
  if (count >= 20) {
    console.error(`🚨 CRITICAL: IP ${ip} has made ${count} form submissions in 1 hour - potential attack`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Sanitize email headers to prevent header injection attacks
// Strips newlines, carriage returns, and non-printable characters
function sanitizeEmailHeader(str) {
  return String(str || '')
    .trim()
    .replace(/[\r\n]/g, '')                    // Remove newlines and carriage returns
    .replace(/[\x00-\x1F\x7F]/g, '')           // Remove control characters
    .replace(/^\./g, '')                       // Remove leading dots (some mail servers reject)
    .slice(0, 255);                            // Limit length
}

// ============ CSRF TOKEN MANAGEMENT ============
// Store active CSRF tokens with expiration times (1 hour)
const csrfTokens = new Map();
const CSRF_TOKEN_EXPIRY = 3600000;  // 1 hour in milliseconds

function generateCsrfToken() {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, {
    createdAt: Date.now(),
    expires: Date.now() + CSRF_TOKEN_EXPIRY
  });
  return token;
}

// Expired tokens are cleared on the sweep below rather than when a new one is issued.
// The previous "only prune once the map passes 10,000 entries" rule did no work in
// the case that needed it: under steady load the map sits above the threshold with
// every token still unexpired, so each pass sweeps nothing and the map keeps growing.
function sweepCsrfTokens() {
  const now = Date.now();
  for (const [token, data] of csrfTokens) {
    if (data.expires < now) csrfTokens.delete(token);
  }
}

// Checks a token without spending it. Validation runs before the Turnstile check and
// the field checks, so consuming the token here would mean any rejected submission —
// a mistyped email, an expired challenge — left the visitor holding a dead token and
// staring at "please reload the page". The token stays valid until a message is sent.
function validateCsrfToken(cookieToken, bodyToken) {
  // Both tokens must exist
  if (!cookieToken || !bodyToken) return false;

  // They must match exactly
  if (cookieToken !== bodyToken) return false;

  // Token must be in our valid tokens map
  const tokenData = csrfTokens.get(cookieToken);
  if (!tokenData) return false;

  // Token must not be expired
  if (tokenData.expires < Date.now()) {
    csrfTokens.delete(cookieToken);
    return false;
  }

  return true;
}

// Spends the token, called once a submission has actually been delivered. One token
// still buys exactly one message — however many attempts it took to get there — so
// replaying a captured request cannot send a second copy.
function consumeCsrfToken(token) {
  csrfTokens.delete(token);
}

// Retry wrapper for database operations (handles locked database)
function dbRunWithRetry(sql, params, callback, maxRetries = 3) {
  const attempt = (retryCount = 0) => {
    db.run(sql, params, (err) => {
      if (err && err.message.includes('database is locked') && retryCount < maxRetries) {
        setTimeout(() => attempt(retryCount + 1), 100 * (retryCount + 1));
      } else {
        if (callback) callback(err);
      }
    });
  };
  attempt();
}

// ============ CLIENT CONFIG ENDPOINT ============
// Per-environment values the browser needs. Only ever expose public values here —
// the Turnstile sitekey is designed to be visible in the page, the secret is not.
app.get('/api/config', (req, res) => {
  res.json({ turnstileSiteKey: TURNSTILE_SITE_KEY || '' });
});

// ============ CSRF TOKEN ENDPOINT ============
// Generate and return CSRF token for form protection
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();

  // Set cookie with HttpOnly and SameSite=Strict for extra security
  res.cookie('XSRF-TOKEN', token, {
    httpOnly: true,       // Can't be accessed by JavaScript (prevents XSS theft)
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in production
    sameSite: 'Strict',   // Only send to same-origin requests (prevents CSRF)
    maxAge: 3600000,      // 1 hour expiration
    path: '/'
  });

  // Also return token in response body for form embedding
  res.json({ csrfToken: token });
});

function makeFormHandler({ toEmail, subjectPrefix, buildHtml, logLabel, formType }) {
  return async (req, res) => {
    const ip = req.ip;  // derived per the trust proxy setting, not read from the header
    const sessionId = req.sessionId;

    // ============ DUAL-LAYER RATE LIMITING ============
    // Layer 1: Per-visitor budget (max 5 per 10 minutes). Clearing the cookie buys
    // a fresh one, which is why layer 2 below is the limit that actually enforces.
    if (rateLimited(sessionId)) {
      logFormSubmission(ip, formType, 'rate_limit_exceeded_session');
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    // Layer 2: Check global IP rate limit (max 30 per hour per IP)
    // Catches anyone cycling sessions, and botnets working from a single address
    if (isIpRateLimited(ip)) {
      const ipCount = (ipHits.get(ip) || []).length;
      detectSuspiciousIpActivity(ip, ipCount);
      logFormSubmission(ip, formType, 'rate_limit_exceeded_ip');
      return res.status(429).json({ error: 'Too many requests from your IP. Please try again in a few minutes.' });
    }

    const { name, email, website, message } = req.body || {};

    // Honeypot: bots fill every field, real users never see/fill this one.
    if (website) {
      logFormSubmission(ip, formType, 'honeypot_triggered');
      return res.status(200).json({ ok: true });
    }

    // CSRF token validation (prevents cross-site request forgery attacks)
    const cookieToken = req.cookies['XSRF-TOKEN'];
    const bodyToken = req.body?.csrfToken;

    if (!validateCsrfToken(cookieToken, bodyToken)) {
      console.warn(`⚠️ CSRF token validation failed from IP ${ip} (${formType} form)`);
      logFormSubmission(ip, formType, 'csrf_validation_failed');
      return res.status(403).json({ error: 'CSRF token invalid or expired. Please reload the page and try again.' });
    }

    // ============ CLOUDFLARE TURNSTILE VERIFICATION ============
    // Fail closed: without a secret we cannot tell humans from bots, so reject.
    if (!TURNSTILE_SECRET_KEY) {
      console.error('❌ Rejected submission: TURNSTILE_SECRET_KEY is not configured.');
      logFormSubmission(ip, formType, 'turnstile_not_configured');
      return res.status(500).json({ error: 'Verification unavailable. Please email us directly.' });
    }

    const turnstileToken = req.body?.turnstileToken;
    if (!turnstileToken) {
      logFormSubmission(ip, formType, 'turnstile_missing');
      return res.status(400).json({ error: 'Verification missing. Please complete the challenge and try again.' });
    }

    try {
      // remoteip is deliberately omitted: 'trust proxy' is not configured, so the
      // forwarded client IP is spoofable and not worth binding the token to.
      const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: TURNSTILE_SECRET_KEY, response: turnstileToken })
      });
      const verifyData = await verifyRes.json();

      if (!verifyData.success) {
        // timeout-or-duplicate = expired (5 min) or replayed token; the rest are config errors.
        console.warn(`⚠️ Turnstile failed for IP ${ip} (${formType}): ${verifyData['error-codes']?.join(',')}`);
        logFormSubmission(ip, formType, 'turnstile_failed');
        return res.status(400).json({ error: 'Verification failed. Please reload the page and try again.' });
      }
    } catch (err) {
      console.error('Turnstile verification error:', err);
      logFormSubmission(ip, formType, 'turnstile_error');
      return res.status(500).json({ error: 'Verification error. Please try again.' });
    }

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }
    if (name.trim().length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters.' });
    }
    if (name.trim().length > 200) {
      return res.status(400).json({ error: 'Name must be less than 200 characters.' });
    }
    if (email.trim().length > 200) {
      return res.status(400).json({ error: 'Email must be less than 200 characters.' });
    }
    // Email validation using isemail library
    if (!isEmail.validate(email)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }
    // Message is required
    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    if (message.length > 250) {
      return res.status(400).json({ error: 'Message must be less than 250 characters.' });
    }

    try {
      // Sanitize email headers to prevent header injection attacks
      const safeName = sanitizeEmailHeader(name);
      const safeEmail = sanitizeEmailHeader(email);

      const info = await transporter.sendMail({
        from: `"SBL Energy Website" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        replyTo: safeEmail,
        subject: `${subjectPrefix} ${safeName}`,
        html: buildHtml(req.body),
      });
      console.log(`${logLabel} accepted by Gmail:`, info.messageId, info.response);
      consumeCsrfToken(cookieToken);  // spent only now that the message is out
      logFormSubmission(ip, formType, 'success');
      res.json({ ok: true });
    } catch (err) {
      console.error(`Failed to send ${logLabel.toLowerCase()}:`, err.message);
      logFormSubmission(ip, formType, 'error');
      res.status(500).json({ error: 'Failed to send message.' });
    }
  };
}

app.post('/api/contact', makeFormHandler({
  toEmail: TO_EMAIL,
  subjectPrefix: 'New enquiry from',
  logLabel: 'Contact email',
  formType: 'contact',
  buildHtml: ({ name, email, country, phone, message }) => {
    const safe = {
      name: escapeHtml(name).slice(0, 200),
      email: escapeHtml(email).slice(0, 200),
      country: escapeHtml(country || '—').slice(0, 100),
      phone: escapeHtml(phone || '—').slice(0, 50),
      message: escapeHtml(message || '—').slice(0, 5000),
    };
    return `
      <h2>New website enquiry</h2>
      <p><strong>Name:</strong> ${safe.name}</p>
      <p><strong>Email:</strong> ${safe.email}</p>
      <p><strong>Country:</strong> ${safe.country}</p>
      <p><strong>Phone:</strong> ${safe.phone}</p>
      <p><strong>Message:</strong><br>${safe.message.replace(/\n/g, '<br>')}</p>
    `;
  },
}));

app.post('/api/career', makeFormHandler({
  toEmail: CAREER_EMAIL,
  subjectPrefix: 'New job application from',
  logLabel: 'Career application email',
  formType: 'career',
  buildHtml: ({ name, email, phone, position, message }) => {
    const safe = {
      name: escapeHtml(name).slice(0, 200),
      email: escapeHtml(email).slice(0, 200),
      phone: escapeHtml(phone || '—').slice(0, 50),
      position: escapeHtml(position || '—').slice(0, 150),
      message: escapeHtml(message || '—').slice(0, 5000),
    };
    return `
      <h2>New job application</h2>
      <p><strong>Name:</strong> ${safe.name}</p>
      <p><strong>Email:</strong> ${safe.email}</p>
      <p><strong>Phone:</strong> ${safe.phone}</p>
      <p><strong>Applying for:</strong> ${safe.position}</p>
      <p><strong>Cover note:</strong><br>${safe.message.replace(/\n/g, '<br>')}</p>
    `;
  },
}));

// ============ PDF DOWNLOAD WITH RATE LIMIT & TRACKING ============
// DEFENSE #1: Whitelist of allowed PDF files (prevents unauthorized file access)
// AUTOMATIC: Scans filesystem instead of hardcoded list

// Generate PDF whitelist by scanning assets folders
function generatePdfWhitelist() {
  const whitelistSet = new Set();

  // Folders to scan for PDFs
  const foldersToScan = ['tds', 'brochure'];

  foldersToScan.forEach(folder => {
    const folderPath = path.join(SITE_ROOT, 'assets', folder);

    if (fs.existsSync(folderPath)) {
      try {
        const files = fs.readdirSync(folderPath);
        files.forEach(file => {
          if (file.endsWith('.pdf')) {
            const relativePath = `${folder}/${file}`;
            whitelistSet.add(relativePath);
          }
        });
      } catch (err) {
        console.error(`❌ Error scanning folder ${folder}: ${err.message}`);
      }
    } else {
      console.warn(`⚠️ PDF folder not found: assets/${folder}`);
    }
  });

  return whitelistSet;
}

// Initialize whitelist at startup
let ALLOWED_PDF_FILES = generatePdfWhitelist();
console.log(`✅ PDF whitelist loaded: ${ALLOWED_PDF_FILES.size} files`);

// ============ AUTOMATIC WHITELIST RELOAD ============
// Reload whitelist every 5 minutes to pick up new PDFs
// No server restart needed when adding new products!
const PDF_WHITELIST_RELOAD_INTERVAL = 5 * 60 * 1000;  // 5 minutes

setInterval(() => {
  const previousCount = ALLOWED_PDF_FILES.size;
  ALLOWED_PDF_FILES = generatePdfWhitelist();
  const newCount = ALLOWED_PDF_FILES.size;

  if (newCount !== previousCount) {
    console.log(`✅ PDF whitelist reloaded: ${previousCount} → ${newCount} files (${newCount - previousCount > 0 ? '+' : ''}${newCount - previousCount})`);
  }
}, PDF_WHITELIST_RELOAD_INTERVAL);

// ============ PDF DOWNLOAD RATE LIMITING ============
// Layer 1: Per-visitor session (max 25 per 10 minutes)
// Allows legitimate bulk operations while preventing abuse
const pdfSessionHits = new Map();
const PDF_SESSION_LIMIT = 25;  // Max 25 downloads per 10 min per session
const PDF_SESSION_WINDOW = 10 * 60 * 1000;  // 10 minutes
const PDF_SESSION_MAX_KEYS = 50000;  // ceiling; far above any plausible real load
const PDF_SESSION_THRESHOLD = 19;  // Alert at 75% of limit (0.75 × 25 = 18.75 ≈ 19)

function pdfRateLimited(sessionId) {
  const now = Date.now();
  const entry = pdfSessionHits.get(sessionId) || [];
  const recent = entry.filter((t) => now - t < PDF_SESSION_WINDOW);
  recent.push(now);
  pdfSessionHits.set(sessionId, recent);
  capSize(pdfSessionHits, PDF_SESSION_MAX_KEYS, 'PDF session map');

  // Monitor high usage (at 75% of limit)
  if (recent.length >= PDF_SESSION_THRESHOLD && recent.length % 5 === 0) {
    console.warn(`⚠️ PDF MONITOR: Session ${sessionId.slice(0, 8)} has ${recent.length}/${PDF_SESSION_LIMIT} downloads in 10 min`);
  }

  return recent.length > PDF_SESSION_LIMIT;
}

// Layer 2: Global IP-based (max 100 per hour per IP)
// Higher limit than forms because PDFs are legitimate downloads
const pdfIpHits = new Map();
const PDF_IP_LIMIT_WINDOW = 60 * 60 * 1000;  // 1 hour
const PDF_IP_LIMIT_MAX = 100;  // Max 100 PDF downloads per hour per IP
const PDF_IP_THRESHOLD = 75;  // Alert at 75% of limit (0.75 × 100 = 75)

function isPdfIpRateLimited(ip) {
  const now = Date.now();
  const entry = pdfIpHits.get(ip) || [];
  const recent = entry.filter((t) => now - t < PDF_IP_LIMIT_WINDOW);
  recent.push(now);
  pdfIpHits.set(ip, recent);
  // Stale entries are dropped by the periodic sweep; deliberately no ceiling here.

  // Monitor high usage (at 75% of limit) - alert every 5 downloads past threshold
  if (recent.length >= PDF_IP_THRESHOLD) {
    if (recent.length === PDF_IP_THRESHOLD) {
      console.warn(`⚠️ PDF MONITOR: IP ${ip} reached 75% of hourly limit (${recent.length}/${PDF_IP_LIMIT_MAX} downloads)`);
    } else if (recent.length % 5 === 0) {
      console.warn(`⚠️ PDF MONITOR: IP ${ip} has ${recent.length}/${PDF_IP_LIMIT_MAX} downloads in 1 hour`);
    }
  }

  return recent.length > PDF_IP_LIMIT_MAX;
}

// ============ PERIODIC SWEEP ============
// Declared here because it is the first point at which every map exists. Each is
// swept against its own window, so an entry survives exactly as long as it can still
// affect a decision. Memory then tracks recent activity rather than all-time traffic.
setInterval(() => {
  sweepExpired(sessionHits, FORM_SESSION_WINDOW);
  sweepExpired(ipHits, IP_LIMIT_WINDOW);
  sweepExpired(pdfSessionHits, PDF_SESSION_WINDOW);
  sweepExpired(pdfIpHits, PDF_IP_LIMIT_WINDOW);
  sweepCsrfTokens();
}, SWEEP_INTERVAL);

app.get('/assets/:folder/:file', (req, res) => {
  // Normalize path to forward slashes for cross-platform consistency (whitelist uses forward slashes)
  const fullPath = `${req.params.folder}/${req.params.file}`;

  // Only handle PDF requests; let express.static handle others
  if (!req.path.endsWith('.pdf')) {
    return res.sendFile(path.join(SITE_ROOT, req.path));
  }

  const ip = req.ip;  // derived per the trust proxy setting, not read from the header
  const sessionId = req.sessionId;
  const fileName = fullPath;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'direct';

  // ============ DUAL-LAYER PDF RATE LIMITING ============
  // Layer 1: Per-visitor session budget
  // Max: 25 downloads per 10 minutes per session
  if (pdfRateLimited(sessionId)) {
    const sessionCount = (pdfSessionHits.get(sessionId) || []).length;
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'rate_limit_exceeded_session'
    });
    console.error(`🚨 PDF SESSION LIMIT BLOCKED: Session ${sessionId.slice(0, 8)} exceeded 25/10min (attempted ${sessionCount} downloads)`);
    return res.status(429).json({ error: 'Too many downloads from your session. Please wait 10 minutes and try again.' });
  }

  // Layer 2: Check global IP rate limit
  // Max: 100 downloads per hour per IP (allows legitimate bulk operations)
  if (isPdfIpRateLimited(ip)) {
    const pdfCount = (pdfIpHits.get(ip) || []).length;
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'rate_limit_exceeded_ip'
    });
    console.error(`🚨 PDF IP LIMIT BLOCKED: IP ${ip} exceeded 100/hour (attempted ${pdfCount} downloads)`);
    return res.status(429).json({ error: 'Too many downloads from your IP address. Please wait a few minutes and try again.' });
  }

  // ============ DEFENSE #1: WHITELIST CHECK (Option 1) ============
  // Only allow files explicitly in the whitelist
  if (!ALLOWED_PDF_FILES.has(fileName)) {
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'security_violation_whitelist'
    });
    console.error(`🚨 Security: Unauthorized file request from IP ${ip}: ${fileName}`);
    return res.status(403).send('Access denied');
  }

  const filePath = path.join(SITE_ROOT, 'assets', fileName);

  // Security: prevent directory traversal
  const realPath = path.resolve(filePath);
  const allowedPath = path.resolve(path.join(SITE_ROOT, 'assets'));
  if (!realPath.startsWith(allowedPath)) {
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'security_violation'
    });
    console.error(`🚨 Security: Directory traversal attempt from IP ${ip}`);
    return res.status(403).send('Access denied');
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'not_found'
    });
    console.warn(`⚠️ File not found: ${fileName} (requested by ${ip})`);
    return res.status(404).send('File not found');
  }

  // ============ DEFENSE #2: SYMLINK PROTECTION (Option 2) ============
  // Prevent symlink attacks - reject any symlinks
  try {
    const lstat = fs.lstatSync(filePath);  // lstat doesn't follow symlinks
    if (lstat.isSymbolicLink()) {
      logDownload({
        ip_address: ip,
        file_name: fileName,
        file_size: 0,
        user_agent: userAgent,
        referer: referer,
        status: 'security_violation_symlink'
      });
      console.error(`🚨 Security: Symlink traversal attempt from IP ${ip}: ${fileName}`);
      return res.status(403).send('Access denied');
    }

    // Verify symlink target (if any) is still in allowed directory
    const resolvedPath = path.resolve(fs.readlinkSync(filePath));
    if (lstat.isSymbolicLink() && !resolvedPath.startsWith(allowedPath)) {
      logDownload({
        ip_address: ip,
        file_name: fileName,
        file_size: 0,
        user_agent: userAgent,
        referer: referer,
        status: 'security_violation_symlink_target'
      });
      console.error(`🚨 Security: Symlink target outside allowed directory from IP ${ip}`);
      return res.status(403).send('Access denied');
    }
  } catch (err) {
    // readlinkSync throws if file is not a symlink - that's fine
    if (!err.message.includes('not a symbolic link') && !err.message.includes('EINVAL')) {
      logDownload({
        ip_address: ip,
        file_name: fileName,
        file_size: 0,
        user_agent: userAgent,
        referer: referer,
        status: 'error_symlink_check'
      });
      console.error(`❌ Error checking symlink: ${err.message}`);
      return res.status(500).send('Error downloading file');
    }
  }

  try {
    const stats = fs.statSync(filePath);

    // Log successful download
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: stats.size,
      user_agent: userAgent,
      referer: referer,
      status: 'success'
    });

    console.log(`✅ PDF downloaded: ${fileName} (${stats.size} bytes) by ${ip}`);
    res.download(filePath);
  } catch (err) {
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'error'
    });
    console.error(`❌ Error serving PDF: ${err.message}`);
    res.status(500).send('Error downloading file');
  }
});

// ============ STATIC FILES ============
// Served AFTER the PDF endpoint so downloads still get logged.
//
// SITE_ROOT is the repository root, which holds more than the public site: server/
// (this file, .env, downloads.db, the CSV logs), build/ and _build_pages.py, plus
// scraped-html/, overview-backups/ and the .md notes. Publishing that whole tree
// would hand out the visitor logs and the server's own source, so only the four
// asset directories and the generated pages are exposed. This is a whitelist on
// purpose: a new file dropped into the repo is private until published deliberately.
const PUBLIC_DIRS = ['assets', 'css', 'images', 'js'];
const staticOptions = {
  dotfiles: 'deny',
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
};

for (const dir of PUBLIC_DIRS) {
  app.use(`/${dir}`, express.static(path.join(SITE_ROOT, dir), staticOptions));
}

// The pages themselves live directly in the root, so serve exactly those: a bare
// filename ending in .html. The character class rules out separators and traversal,
// so nothing outside SITE_ROOT is reachable and no sibling directory is walked into.
const ROOT_PAGE = /^[A-Za-z0-9._-]+\.html$/;

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  let pathname;
  try {
    pathname = decodeURIComponent(req.path);
  } catch {
    return next(); // malformed percent-encoding — not a page we serve
  }

  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!ROOT_PAGE.test(name)) return next();

  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(SITE_ROOT, name), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`SBL Energy site + contact API running on http://localhost:${PORT}`);
});
