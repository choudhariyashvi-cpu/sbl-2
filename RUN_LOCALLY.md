# How to Run SBL Energy Website on Localhost

## ✅ Prerequisites Check

Before starting, verify you have:
- [ ] Node.js installed (v14 or higher)
- [ ] npm installed (comes with Node.js)
- [ ] `.env` file created (already done ✓)
- [ ] package.json created (already done ✓)

---

## 🔍 Step 1: Verify Node.js is Installed

### **On Windows (PowerShell):**
```powershell
node --version
npm --version
```

### **Expected Output:**
```
v16.13.0  (or higher)
8.1.0     (or higher)
```

### **If Not Installed:**
1. Download from: https://nodejs.org
2. Install the LTS (Long Term Support) version
3. Restart your terminal/PowerShell
4. Verify with commands above

---

## 🚀 Step 2: Install Dependencies

Navigate to your project directory and install required packages:

### **PowerShell / Command Prompt:**
```powershell
cd C:\Users\choud\OneDrive\Desktop\Claude\sbl-2
npm install
```

### **Expected Output:**
```
added 50 packages in 12.5s
```

### **This Creates:**
```
sbl-2/node_modules/  (folder with all dependencies)
package-lock.json    (lock file for exact versions)
```

---

## 📝 Step 3: Configure .env File (Optional)

The `.env` file is already created with defaults.

### **For Local Testing (Current Setup):**
```
PORT=8123
TO_EMAIL=info@sblenergy.com
GMAIL_USER=        (leave blank for testing)
GMAIL_APP_PASSWORD= (leave blank for testing)
```

**Behavior:**
- ✅ Website runs normally
- ✅ PDF downloads work
- ✅ Database tracking works
- ⚠️ Email won't send (contact form will show error)

### **To Enable Email Notifications:**

**Option A: Using Gmail**
1. Go to: https://myaccount.google.com/apppasswords
2. Generate an "App Password" for Gmail
3. Update `.env` with:
```
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-generated-app-password
```

**Option B: Using Other Email Service**
- Modify `server.js` line 71-78 to change email provider
- See Nodemailer docs: https://nodemailer.com/smtp/

---

## ▶️ Step 4: Start the Server

### **PowerShell / Command Prompt:**
```powershell
npm start
```

### **Expected Output:**
```
Connected to downloads.db
SBL Energy site + contact API running on http://localhost:8123
```

### **If You See Errors:**

**Error: "Cannot find module 'express'"**
```
Solution: Run: npm install
```

**Error: "EADDRINUSE: address already in use :::8123"**
```
Solution: Port 8123 is already in use
Try: Set PORT=8124 in .env file
Or: Kill process using port 8123
```

**Error: "SQLITE_CANTOPEN"**
```
Solution: Server will auto-create database
If persists: Check folder permissions
```

---

## 🌐 Step 5: Access Website

### **In Browser:**
```
http://localhost:8123
```

### **Pages to Test:**

| Page | URL | What to Test |
|------|-----|--------------|
| Home | http://localhost:8123/index.html | Brochure download |
| Products | http://localhost:8123/bulk-explosives.html | PDF download + rate limit |
| Contact | http://localhost:8123/contact.html | Form + character counter |
| TDS | http://localhost:8123/ammonium-nitrate.html | Download TDS PDF |

---

## 🧪 Testing Features

### **Test 1: Character Counter**
1. Go to: http://localhost:8123/contact.html
2. Click message field
3. Type text → watch counter at bottom right
4. Try typing past 1000 chars → should stop

### **Test 2: PDF Download**
1. Go to: http://localhost:8123/bulk-explosives.html
2. Click "Download E-Brochure"
3. File downloads successfully
4. Check: `sbl-2/server/logs/downloads.csv`

### **Test 3: Rate Limiting**
1. Download same PDF 11 times rapidly
2. 11th attempt → Error: "Too many downloads..."
3. Check: `sbl-2/server/logs/downloads.csv` for "rate_limit_exceeded"

### **Test 4: Country Codes**
1. Go to: http://localhost:8123/contact.html
2. Click phone country code dropdown
3. Scroll through → should see 195+ countries

### **Test 5: Form Submission**
1. Go to: http://localhost:8123/contact.html
2. Fill form with valid data
3. Click "Send"
4. If email configured: you get email
5. If email not configured: error message shows (normal)

---

## 📊 Monitoring

### **View Download Logs:**

**CSV (easiest):**
```
Open file: sbl-2/server/logs/downloads.csv
View in: Excel, Google Sheets, or any text editor
```

**Database:**
```
Open file: sbl-2/server/data/downloads.db
Tool: SQLite Browser (https://sqlitebrowser.org/)
```

### **View Server Output:**

The terminal/PowerShell shows:
```
✅ PDF downloaded: tds/ammonium-nitrate.pdf (2MB) by 192.168.1.100
⚠️ Rate limit exceeded for IP: 192.168.1.101
❌ Error serving PDF: File not found
```

---

## 🛑 Stopping the Server

### **Method 1: Keyboard Shortcut**
```
Press: Ctrl + C
```

### **Method 2: Close Terminal**
```
Close the PowerShell/Terminal window
```

### **Expected Output:**
```
^C
(server stops cleanly)
```

---

## 🔄 Restarting Server

```powershell
# Server is running, press Ctrl+C to stop
npm start    # Start again
```

---

## 📁 Key Folders & Files

```
sbl-2/
├── server/
│   ├── server.js              ← Main server file
│   ├── data/
│   │   └── downloads.db       ← SQLite database (created on first run)
│   └── logs/
│       └── downloads.csv      ← Download logs (created on first run)
├── .env                        ← Configuration (already created)
├── package.json                ← Dependencies (already created)
├── index.html                  ← Home page
├── contact.html                ← Contact form
└── assets/
    ├── tds/                    ← Technical data sheets (PDFs)
    └── brochure/               ← Brochure (PDF)
```

---

## 🔧 Troubleshooting

### **Problem: Port 8123 Already in Use**

**Cause:** Another application is using port 8123

**Solutions:**
1. Edit `.env` and change PORT to 8124:
```
PORT=8124
```
2. Then access: http://localhost:8124

OR

Find and kill process using port:
```powershell
# Windows
netstat -ano | findstr :8123
taskkill /PID <process_id> /F
```

---

### **Problem: npm install hangs or fails**

**Cause:** Network issue or package lock issue

**Solution:**
```powershell
# Clear npm cache
npm cache clean --force

# Remove node_modules and package-lock.json
rm -r node_modules
rm package-lock.json

# Try again
npm install
```

---

### **Problem: "Cannot find module" errors**

**Cause:** Dependencies not installed or corrupted

**Solution:**
```powershell
# Reinstall
npm install
```

---

### **Problem: Database "locked" error**

**Cause:** Server still running or file permissions issue

**Solution:**
1. Stop server: Press Ctrl+C
2. Wait 2-3 seconds
3. Start again: npm start

---

### **Problem: PDF downloads not tracked**

**Check:**
1. Is server running? (Should see "running on http://localhost:8123")
2. Does `server/logs/` folder exist?
3. Does `server/data/` folder exist?
4. Check for errors in terminal

---

## ✨ Features to Test

- [x] Website loads at localhost:8123
- [x] All pages accessible
- [x] Contact form displays all 195+ countries
- [x] Character counter shows 0/1000 on message field
- [x] PDF downloads work
- [x] Rate limiting blocks 11+ downloads per 10 min
- [x] CSV log created in `server/logs/downloads.csv`
- [x] Database created in `server/data/downloads.db`
- [x] Form validation works (name min 2 chars, email format, message max 1000)

---

## 📊 Expected Directory After First Run

```
sbl-2/
├── node_modules/               ← Created by: npm install
├── server/
│   ├── server.js
│   ├── data/
│   │   └── downloads.db        ← Created on: first PDF download
│   └── logs/
│       └── downloads.csv       ← Created on: first PDF download
├── package.json
├── package-lock.json           ← Created by: npm install
├── .env
├── index.html
└── ... (other files)
```

---

## 🚀 Quick Reference

| Task | Command |
|------|---------|
| Check Node installed | `node --version` |
| Install dependencies | `npm install` |
| Start server | `npm start` |
| Stop server | `Ctrl + C` |
| View logs | Open `server/logs/downloads.csv` |
| View database | Open `server/data/downloads.db` with SQLite |

---

## ✅ Checklist

- [ ] Node.js v14+ installed
- [ ] npm installed
- [ ] Navigated to sbl-2 folder
- [ ] `.env` file exists
- [ ] `package.json` exists
- [ ] `npm install` completed successfully
- [ ] `npm start` runs without errors
- [ ] Website opens at http://localhost:8123
- [ ] Can download a PDF
- [ ] Download logged in CSV file
- [ ] Character counter works
- [ ] All 195+ countries visible in dropdown

---

## 🆘 Need Help?

1. Check the error message in terminal
2. See "Troubleshooting" section above
3. Read: `DOWNLOAD_TRACKING_GUIDE.md`
4. Read: `SETUP_INSTRUCTIONS.md`

---

**You're Ready!** Run `npm start` to begin. 🎉

