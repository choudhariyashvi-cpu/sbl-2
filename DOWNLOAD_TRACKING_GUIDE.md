# PDF Download Tracking & Rate Limiting Guide

## Overview
Your website now has:
- ✅ **Rate Limiting**: Max 10 PDF downloads per IP per 10 minutes
- ✅ **Database Logging**: SQLite database tracks all downloads
- ✅ **CSV Logging**: Plain text log for quick analysis
- ✅ **Security**: Prevents bot abuse, tracks suspicious activity

---

## File Locations

### 1. **Database File** (All download data stored here)
```
Location: sbl-2/server/data/downloads.db
Type: SQLite 3 database
Size: Grows ~1KB per download
Retention: Permanent (unless manually deleted)
Access: Read-only recommended, don't delete during operation
```

**What's stored:**
- All download attempts (success, rate limit, not found, errors)
- IP addresses
- File names
- File sizes
- User agents (browser info)
- Referrer pages
- Timestamps

---

### 2. **CSV Log File** (Quick reference, human-readable)
```
Location: sbl-2/server/logs/downloads.csv
Format: Comma-separated values
Size: ~200 bytes per download
Retention: Until manually deleted
Access: Open with Excel, Google Sheets, or text editor
```

**Example content:**
```
timestamp,ip_address,file_name,file_size,user_agent,referer,status
"2026-07-29T14:32:45Z","192.168.1.100","tds/ammonium-nitrate-tds.pdf","2048576","Mozilla/5.0 (Windows NT 10.0; Win64; x64)","https://yoursite.com/ammonium-nitrate.html","success"
"2026-07-29T14:33:12Z","192.168.1.101","brochure/sbl-energy-brochure.pdf","5242880","Mozilla/5.0 (iPhone; CPU iPhone OS 14_6)","https://yoursite.com/bulk.html","success"
"2026-07-29T14:34:20Z","192.168.1.102","tds/neo-base-tds.pdf","1536000","curl/7.64.1","direct","rate_limit_exceeded"
```

---

### 3. **Application Log** (Server console output)
```
Location: Terminal/Console output when running: npm start
Format: Human-readable status messages
Example outputs:
  ✅ PDF downloaded: tds/ammonium-nitrate-tds.pdf (2048576 bytes) by 192.168.1.100
  ⚠️ Rate limit exceeded for IP: 192.168.1.102
  🚨 Security: Directory traversal attempt from IP 192.168.1.105
  ❌ Error serving PDF: File not found
```

---

## Rate Limiting Details

### **Limits Applied:**
```
- Maximum downloads: 10 per IP per 10 minutes
- Reset period: 10 minutes (automatic)
- Per IP address: Each unique IP counted separately
```

### **Rate Limit Behavior:**
```
Download #1-9    → ✅ OK (succeeds)
Download #10     → ✅ OK (last one allowed)
Download #11     → ❌ BLOCKED (429 error)
                    Message: "Too many downloads. Try again in 10 minutes."
                    Logged: status = "rate_limit_exceeded"

After 10 minutes → ✅ Counter resets, user can download again
```

---

## How to Install & Run

### **Step 1: Install Dependencies**
```bash
cd sbl-2
npm install
```

This installs:
- express (web server)
- nodemailer (email)
- sqlite3 (database)
- dotenv (environment variables)

### **Step 2: Run the Server**
```bash
npm start
```

Expected output:
```
Connected to downloads.db
SBL Energy site + contact API running on http://localhost:8123
```

### **Step 3: Test It**
1. Visit: http://localhost:8123/bulk-explosives.html
2. Click "Download E-Brochure"
3. Check logs:
   - CSV: `sbl-2/server/logs/downloads.csv`
   - Database: `sbl-2/server/data/downloads.db`

---

## Accessing & Analyzing Data

### **Option 1: View CSV Log (Easiest)**

**Open in Excel/Google Sheets:**
1. Open file: `sbl-2/server/logs/downloads.csv`
2. Excel auto-detects columns
3. Create pivot tables, charts, filters

**Command line (Mac/Linux):**
```bash
tail -20 sbl-2/server/logs/downloads.csv    # Last 20 downloads
grep "success" sbl-2/server/logs/downloads.csv | wc -l    # Total successful
grep "rate_limit" sbl-2/server/logs/downloads.csv    # Suspicious IPs
```

---

### **Option 2: Query Database (Most Powerful)**

**Install SQLite client:**
```bash
# Mac
brew install sqlite3

# Windows (download from sqlite.org or use WSL)
# Or use: https://sqlitebrowser.org/
```

**Open database:**
```bash
sqlite3 sbl-2/server/data/downloads.db
```

**Useful Queries:**

**1. Total downloads by file:**
```sql
SELECT file_name, COUNT(*) as downloads, SUM(file_size) as total_bytes
FROM downloads
WHERE status = 'success'
GROUP BY file_name
ORDER BY downloads DESC;
```

**2. Most active IPs (potential bots):**
```sql
SELECT ip_address, COUNT(*) as attempts, 
       SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successful
FROM downloads
GROUP BY ip_address
ORDER BY attempts DESC
LIMIT 10;
```

**3. Suspicious activity (rate limits):**
```sql
SELECT ip_address, file_name, COUNT(*) as blocked_attempts, 
       MIN(timestamp) as first_attempt, MAX(timestamp) as last_attempt
FROM downloads
WHERE status = 'rate_limit_exceeded'
GROUP BY ip_address
ORDER BY blocked_attempts DESC;
```

**4. Downloads in last 24 hours:**
```sql
SELECT timestamp, ip_address, file_name, status
FROM downloads
WHERE timestamp > datetime('now', '-1 day')
ORDER BY timestamp DESC;
```

**5. Failed/error downloads:**
```sql
SELECT ip_address, file_name, status, COUNT(*) as count
FROM downloads
WHERE status != 'success'
GROUP BY ip_address, file_name, status
ORDER BY count DESC;
```

**6. Download timeline (by hour):**
```sql
SELECT strftime('%Y-%m-%d %H:00', timestamp) as hour, COUNT(*) as count
FROM downloads
WHERE status = 'success'
GROUP BY hour
ORDER BY hour DESC;
```

---

## Security Monitoring

### **How to Detect Attacks:**

**1. Rapid downloads from one IP:**
```sql
SELECT ip_address, COUNT(*) as count
FROM downloads
WHERE status = 'rate_limit_exceeded'
GROUP BY ip_address
HAVING count > 5;
```
→ If any IP > 5 rate limits = **likely bot**

**2. Unusual user agents (bots):**
```sql
SELECT user_agent, COUNT(*) as count
FROM downloads
WHERE user_agent LIKE '%curl%' 
   OR user_agent LIKE '%wget%'
   OR user_agent LIKE '%bot%'
GROUP BY user_agent;
```
→ curl, wget = **automated scraping**

**3. Directory traversal attempts:**
```sql
SELECT * FROM downloads
WHERE status = 'security_violation'
OR file_name LIKE '%..%';
```
→ Attempts to access unauthorized files

**4. Failed downloads (potential reconnaissance):**
```sql
SELECT ip_address, COUNT(*) as failed_attempts
FROM downloads
WHERE status = 'not_found'
GROUP BY ip_address
HAVING count > 3
ORDER BY failed_attempts DESC;
```
→ Multiple 404s = **probing for vulnerabilities**

---

## What Gets Logged

### **Success (Normal Download)**
```json
{
  "timestamp": "2026-07-29T14:32:45Z",
  "ip_address": "192.168.1.100",
  "file_name": "tds/ammonium-nitrate-tds.pdf",
  "file_size": 2048576,
  "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "referer": "https://yoursite.com/ammonium-nitrate.html",
  "status": "success"
}
```

### **Rate Limited (Suspicious)**
```json
{
  "timestamp": "2026-07-29T14:34:20Z",
  "ip_address": "192.168.1.102",
  "file_name": "brochure/sbl-energy-brochure.pdf",
  "file_size": 0,
  "user_agent": "curl/7.64.1",
  "referer": "direct",
  "status": "rate_limit_exceeded"
}
```

### **Security Violation (Attack)**
```json
{
  "timestamp": "2026-07-29T14:35:10Z",
  "ip_address": "192.168.1.105",
  "file_name": "../../etc/passwd",
  "file_size": 0,
  "user_agent": "unknown",
  "referer": "direct",
  "status": "security_violation"
}
```

### **Status Codes:**
- `success` - PDF downloaded successfully
- `rate_limit_exceeded` - Too many requests from this IP
- `not_found` - File doesn't exist (404)
- `security_violation` - Directory traversal or malicious request
- `error` - Server error while serving file

---

## Database Schema

```sql
CREATE TABLE downloads (
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

-- Indexes for fast queries
CREATE INDEX idx_ip_time ON downloads(ip_address, timestamp);
CREATE INDEX idx_file ON downloads(file_name);
```

---

## Privacy & GDPR Compliance

### **What you're logging:**
- ✅ IP address (identifies user location)
- ✅ Timestamp (when accessed)
- ✅ File accessed (user interests)
- ✅ User-Agent (device/browser type)
- ✅ Referer (which page they came from)

### **Required actions:**
1. **Update Privacy Policy**: "We log PDF downloads for security purposes"
2. **Retention Period**: Keep logs for 90 days, then delete
3. **User Rights**: Users can request download history
4. **Data Protection**: Database should be encrypted at rest

### **Retention Script (Optional):**
```sql
-- Delete downloads older than 90 days
DELETE FROM downloads 
WHERE timestamp < datetime('now', '-90 days');
```

---

## Troubleshooting

### **Problem: Database locked**
**Cause:** Server still running  
**Fix:** Stop server (`Ctrl+C`), wait 2 seconds, restart

### **Problem: Can't download PDFs**
**Check:**
1. Is server running? (`npm start`)
2. Is file in correct location? (`assets/tds/` or `assets/brochure/`)
3. Check console for error messages

### **Problem: CSV file not created**
**Check:**
1. Does `server/logs/` directory exist?
2. Does server have write permissions?
3. Check console for errors

### **Problem: Downloads too slow**
**Cause:** Large file size  
**Solution:** Compress PDFs before uploading

---

## Performance Impact

- **Database**: ~1KB per download (negligible)
- **CSV Log**: ~200 bytes per download (negligible)
- **Rate limiting**: In-memory, very fast (<1ms)
- **Overall server impact**: <1% overhead

---

## Next Steps (Optional Enhancements)

1. **Email alerts**: Notify admin on suspicious activity
2. **IP blocking**: Auto-block IPs after 10 rate limits
3. **Gating**: Require email before PDF download
4. **Analytics dashboard**: Web UI to view statistics
5. **Backup**: Automated database backups daily

---

**Questions?** Check the error messages in:
1. Server console
2. `sbl-2/server/logs/downloads.csv`
3. `sbl-2/server/data/downloads.db`

