const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const crypto = require('crypto');
const isEmail = require('isemail');

const PORT = process.env.PORT || 8123;
const SITE_ROOT = path.join(__dirname, '..');
const TO_EMAIL = process.env.TO_EMAIL || 'choudhari.yashvi@gmail.com';
const CAREER_EMAIL = process.env.CAREER_EMAIL || TO_EMAIL;



const app = express();
app.use(express.json());
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

// In-memory rate limit: max 5 submissions per fingerprint per 10 minutes
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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function makeFormHandler({ toEmail, subjectPrefix, buildHtml, logLabel, formType }) {
  return async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const fingerprint = generateFingerprint(req);

    // Check rate limit using fingerprint (session/token-based)
    if (rateLimited(fingerprint)) {
      logFormSubmission(ip, formType, 'rate_limit_exceeded');
      return res.status(429).json({ error: 'Too many requests, please try again later.' });
    }

    const { name, email, website, message } = req.body || {};

    // Honeypot: bots fill every field, real users never see/fill this one.
    if (website) {
      logFormSubmission(ip, formType, 'honeypot_triggered');
      return res.status(200).json({ ok: true });
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
    if (message && message.length > 250) {
      return res.status(400).json({ error: 'Message must be less than 250 characters.' });
    }

    try {
      const info = await transporter.sendMail({
        from: `"SBL Energy Website" <${process.env.GMAIL_USER}>`,
        to: toEmail,
        replyTo: escapeHtml(email),
        subject: `${subjectPrefix} ${escapeHtml(name)}`,
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
const pdfSessionHits = new Map();
function pdfRateLimited(fingerprint) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const entry = pdfSessionHits.get(fingerprint) || [];
  const recent = entry.filter((t) => now - t < windowMs);
  recent.push(now);
  pdfSessionHits.set(fingerprint, recent);
  // Cleanup: remove fingerprints with no recent activity
  if (recent.length === 0) pdfSessionHits.delete(fingerprint);
  return recent.length > 10; // Max 10 downloads per 10 min per fingerprint
}

app.get('/assets/:folder/:file', (req, res) => {
  const fullPath = path.join(req.params.folder, req.params.file);

  // Only handle PDF requests; let express.static handle others
  if (!req.path.endsWith('.pdf')) {
    return res.sendFile(path.join(SITE_ROOT, req.path));
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const fingerprint = generateFingerprint(req);
  const fileName = fullPath;
  const userAgent = req.headers['user-agent'] || 'unknown';
  const referer = req.headers['referer'] || 'direct';

  // Check rate limit using fingerprint (session/token-based)
  if (pdfRateLimited(fingerprint)) {
    logDownload({
      ip_address: ip,
      file_name: fileName,
      file_size: 0,
      user_agent: userAgent,
      referer: referer,
      status: 'rate_limit_exceeded'
    });
    console.warn(`⚠️ Rate limit exceeded for fingerprint: ${fingerprint}`);
    return res.status(429).json({ error: 'Too many downloads. Try again in 10 minutes.' });
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
