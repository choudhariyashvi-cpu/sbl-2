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



const app = express();
app.use(express.json());
app.use(cookieParser());  // Parse cookies for CSRF token validation
// Static files moved to end (after PDF endpoint) so logging works

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

// Generate a fingerprint from browser headers (session/token-based rate limiting)
function generateFingerprint(req) {
  const userAgent = req.headers['user-agent'] || 'unknown';
  const acceptLanguage = req.headers['accept-language'] || 'unknown';
  const acceptEncoding = req.headers['accept-encoding'] || 'unknown';

  const fingerprint = crypto
    .createHash('sha256')
    .update(userAgent + acceptLanguage + acceptEncoding)
    .digest('hex');

  return fingerprint;
}

// ============ RATE LIMITING: LAYER 1 - SESSION/FINGERPRINT ============
// In-memory rate limit: max 5 submissions per fingerprint per 10 minutes
// Prevents same session from spamming even if headers are spoofed
const sessionHits = new Map();
function rateLimited(fingerprint) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const entry = sessionHits.get(fingerprint) || [];
  const recent = entry.filter((t) => now - t < windowMs);
  recent.push(now);
  sessionHits.set(fingerprint, recent);
  // Cleanup: remove fingerprints with no recent activity
  if (recent.length === 0) sessionHits.delete(fingerprint);
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

  // Cleanup: remove IPs with no recent activity
  if (recent.length === 0) {
    ipHits.delete(ip);
    return false;
  }

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
  // Cleanup expired tokens every hour
  if (csrfTokens.size > 10000) {
    const now = Date.now();
    for (const [token, data] of csrfTokens) {
      if (data.expires < now) csrfTokens.delete(token);
    }
  }
  return token;
}

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

  // Mark token as used (prevent replay attacks)
  csrfTokens.delete(cookieToken);
  return true;
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

// ============ CONFIG ENDPOINT ============
app.get('/api/config', (req, res) => {
  res.json({
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '',
  });
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
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const fingerprint = generateFingerprint(req);

    // ============ DUAL-LAYER RATE LIMITING ============
    // Layer 1: Check rate limit using fingerprint (session/token-based)
    // Prevents same session from spamming (max 5 per 10 minutes)
    if (rateLimited(fingerprint)) {
      logFormSubmission(ip, formType, 'rate_limit_exceeded_fingerprint');
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    // Layer 2: Check global IP rate limit (max 30 per hour per IP)
    // Prevents botnet attacks and header-spoofing from single IP
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

    // reCAPTCHA verification disabled for testing
    if (false) {
      const recaptchaToken = req.body.recaptchaToken;
      if (!recaptchaToken) {
        logFormSubmission(ip, formType, 'recaptcha_missing');
        return res.status(400).json({ error: 'reCAPTCHA token missing. Please try again.' });
      }

      try {
        const verifyUrl = 'https://www.google.com/recaptcha/api/siteverify';
        const verifyRes = await fetch(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`
        });
        const verifyData = await verifyRes.json();

        if (!verifyData.success) {
          console.warn(`reCAPTCHA failed for IP ${ip}: ${verifyData['error-codes']?.join(',')}`);
          logFormSubmission(ip, formType, 'recaptcha_failed');
          return res.status(400).json({ error: 'reCAPTCHA verification failed. Please try again.' });
        }

        if (verifyData.score < 0.5) {
          console.warn(`reCAPTCHA low score for IP ${ip}: ${verifyData.score}`);
          logFormSubmission(ip, formType, 'recaptcha_low_score');
          return res.status(400).json({ error: 'Suspicious activity detected. Please try again.' });
        }
      } catch (err) {
        console.error('reCAPTCHA verification error:', err);
        logFormSubmission(ip, formType, 'recaptcha_error');
        return res.status(500).json({ error: 'Verification error. Please try again.' });
      }
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
// Layer 1: Session/fingerprint-based (max 25 per 10 minutes)
// Allows legitimate bulk operations while preventing abuse
const pdfSessionHits = new Map();
const PDF_SESSION_LIMIT = 25;  // Max 25 downloads per 10 min per fingerprint
const PDF_SESSION_THRESHOLD = 19;  // Alert at 75% of limit (0.75 × 25 = 18.75 ≈ 19)

function pdfRateLimited(fingerprint) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const entry = pdfSessionHits.get(fingerprint) || [];
  const recent = entry.filter((t) => now - t < windowMs);
  recent.push(now);
  pdfSessionHits.set(fingerprint, recent);
  // Cleanup: remove fingerprints with no recent activity
  if (recent.length === 0) pdfSessionHits.delete(fingerprint);

  // Monitor high usage (at 75% of limit)
  if (recent.length >= PDF_SESSION_THRESHOLD && recent.length % 5 === 0) {
    console.warn(`⚠️ PDF MONITOR: Fingerprint ${fingerprint} has ${recent.length}/${PDF_SESSION_LIMIT} downloads in 10 min`);
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
  if (recent.length === 0) pdfIpHits.delete(ip);

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

app.get('/assets/:folder/:file', (req, res) => {
  // Normalize path to forward slashes for cross-platform consistency (whitelist uses forward slashes)
  const fullPath = `${req.params.folder}/${req.params.file}`;

  // Only handle PDF requests; let express.static handle others
  if (!req.path.endsWith('.pdf')) {
    return res.sendFile(path.join(SITE_ROOT, req.path));
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const fingerprint = generateFingerprint(req);
  const fileName = fullPath;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'direct';

  // ============ DUAL-LAYER PDF RATE LIMITING ============
  // Layer 1: Check rate limit using fingerprint (session/token-based)
  // Max: 25 downloads per 10 minutes per fingerprint
  if (pdfRateLimited(fingerprint)) {
    const sessionCount = (pdfSessionHits.get(fingerprint) || []).length;
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'rate_limit_exceeded_fingerprint'
    });
    console.error(`🚨 PDF SESSION LIMIT BLOCKED: Fingerprint ${fingerprint} exceeded 25/10min (attempted ${sessionCount} downloads)`);
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

// Serve static files AFTER PDF endpoint so logging works
app.use(express.static(SITE_ROOT, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

app.listen(PORT, () => {
  console.log(`SBL Energy site + contact API running on http://localhost:${PORT}`);
});
