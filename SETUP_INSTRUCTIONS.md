# Quick Setup Guide - PDF Download Tracking

## 📁 File Locations Reference

```
sbl-2/
├── package.json                    ← Dependencies (NEW)
├── server/
│   ├── server.js                   ← Updated with tracking
│   ├── data/                        ← (AUTO-CREATED)
│   │   └── downloads.db            ← SQLite database
│   └── logs/                        ← (AUTO-CREATED)
│       └── downloads.csv           ← CSV log file
├── DOWNLOAD_TRACKING_GUIDE.md      ← Full documentation (NEW)
└── assets/
    ├── tds/                         ← TDS PDF files
    └── brochure/                    ← Brochure PDF files
```

---

## ⚡ Quick Start (3 steps)

### Step 1: Install Dependencies
```bash
cd sbl-2
npm install
```

**Expected output:**
```
added 50 packages
```

### Step 2: Start Server
```bash
npm start
```

**Expected output:**
```
Connected to downloads.db
SBL Energy site + contact API running on http://localhost:8123
```

### Step 3: Test
1. Open: http://localhost:8123/bulk-explosives.html
2. Click "Download E-Brochure"
3. Check logs:
   - **CSV**: Open `sbl-2/server/logs/downloads.csv`
   - **Database**: Open `sbl-2/server/data/downloads.db` with SQLite

---

## 📊 Viewing Download Data

### **Easiest: CSV File**
```
Path: sbl-2/server/logs/downloads.csv
Open with: Excel, Google Sheets, or any text editor
```

### **Advanced: SQLite Database**
```
Path: sbl-2/server/data/downloads.db
Tool: SQLite Browser (https://sqlitebrowser.org/)
```

---

## 🛡️ Rate Limit Rules

- **Limit**: 10 PDFs per IP per 10 minutes
- **Block message**: "Too many downloads. Try again in 10 minutes."
- **Auto-resets**: After 10 minutes

---

## 📋 What Gets Logged

Each download creates a record with:
- Timestamp (when)
- IP Address (who)
- File Name (which PDF)
- File Size (how big)
- User Agent (what browser/bot)
- Referrer (from which page)
- Status (success/rate-limit/not-found/error)

---

## 🚀 Verify It's Working

**In browser console, paste:**
```javascript
fetch('http://localhost:8123/assets/brochure/sbl-energy-brochure.pdf')
.then(r => console.log('Status:', r.status))
```

**Check CSV file:**
```bash
# Last line should show your download
tail -1 sbl-2/server/logs/downloads.csv
```

---

## 📚 Full Documentation
See: `DOWNLOAD_TRACKING_GUIDE.md` for complete details including:
- SQL queries to analyze data
- Security monitoring
- Privacy/GDPR compliance
- Troubleshooting

---

## ✅ Checklist

- [ ] `npm install` completed
- [ ] `npm start` runs without errors
- [ ] Can download PDFs from website
- [ ] `downloads.csv` file created
- [ ] `downloads.db` file created
- [ ] Read `DOWNLOAD_TRACKING_GUIDE.md`

---

**All set!** Your PDF downloads are now rate-limited and tracked. 🎉

