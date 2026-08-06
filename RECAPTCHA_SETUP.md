# Google reCAPTCHA v3 Setup Guide

## Overview

reCAPTCHA v3 has been integrated into your contact form to prevent bot submissions. It's **invisible** to legitimate users but blocks automated attacks.

---

## 🚀 Step 1: Create reCAPTCHA Keys

### **Go to Google reCAPTCHA Admin Console:**
https://www.google.com/recaptcha/admin

### **Sign In:**
- Use your Google account (create one if needed)

### **Click "Create" or "+"**

**Fill in the form:**

| Field | Value |
|-------|-------|
| **Label** | SBL Energy Website |
| **reCAPTCHA type** | reCAPTCHA v3 |
| **Domains** | localhost (for testing) |
| | yoursite.com (when live) |

### **Accept Terms:**
- ✅ Check "Accept the reCAPTCHA Terms of Service"
- ✅ Check "I'm not a robot"

### **Click "Submit"**

---

## 🔑 Step 2: Copy Your Keys

After submission, you'll see two keys:

1. **Site Key** (public - safe to share)
   - Looks like: `6LdL...` (long string)

2. **Secret Key** (private - KEEP SECURE)
   - Looks like: `6LdL...` (long string)
   - Never share this publicly!

---

## ✏️ Step 3: Update .env File

Open `.env` and add your keys:

```
RECAPTCHA_SITE_KEY=6LdL1234567890ABCDEFGHIJKLMNOP
RECAPTCHA_SECRET_KEY=6LdL1234567890ABCDEFGHIJKLMNOP_SECRET
```

**Where to find it:**
```
sbl-2/.env
```

**Before:**
```
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
```

**After:**
```
RECAPTCHA_SITE_KEY=6LdL1234567890ABCDEFGHIJKLMNOP
RECAPTCHA_SECRET_KEY=6LdL1234567890ABCDEFGHIJKLMNOP_SECRET
```

---

## 🔧 Step 4: Update Site Key in HTML

Open `contact.html` and find this line (around line 447):

```javascript
const RECAPTCHA_SITE_KEY = 'YOUR_SITE_KEY_HERE';
```

Replace with your actual site key:

```javascript
const RECAPTCHA_SITE_KEY = '6LdL1234567890ABCDEFGHIJKLMNOP';
```

---

## 🚀 Step 5: Restart Server

```powershell
# Stop server (Ctrl+C)
# Restart
npm start
```

---

## ✅ Step 6: Test

### **Test 1: Normal Submission**
1. Go to: http://localhost:8123/contact.html
2. Fill form normally
3. Click "Send"
4. Should succeed ✅

### **Test 2: Detect Suspicious Activity**
reCAPTCHA scores submissions (0.0 - 1.0):
- **1.0** = Very likely legitimate
- **0.5** = Neutral
- **0.0** = Very likely bot

Legitimate users get 0.5+ → Form accepted
Bots get <0.5 → Form rejected with "Suspicious activity detected"

### **Test 3: Check Server Logs**
```powershell
# Look for reCAPTCHA messages in console
npm start
# Try submitting form, watch for:
# ✅ reCAPTCHA verification passed
# ❌ reCAPTCHA low score
# ⚠️ reCAPTCHA verification error
```

---

## 📊 How It Works

### **User Flow:**
```
User submits contact form
    ↓
reCAPTCHA v3 scores the submission (invisible to user)
    ↓
JavaScript sends score token to server
    ↓
Server verifies token with Google
    ↓
If score > 0.5: Form accepted ✅
If score < 0.5: Form rejected ❌
```

### **What reCAPTCHA Detects:**
- ✅ Bot behavior (automated submissions)
- ✅ Spam patterns
- ✅ Suspicious network activity
- ✅ Cookie/session manipulation
- ✅ Unusual clicking patterns

---

## 🎯 Files Modified

| File | Changes |
|------|---------|
| `contact.html` | Added reCAPTCHA script & token field |
| `server.js` | Added token verification logic |
| `.env` | Added RECAPTCHA keys |

---

## 🔒 Security Best Practices

### **DO:**
✅ Keep SECRET_KEY private (never commit to GitHub)
✅ Rotate keys periodically
✅ Monitor score reports in Google Console
✅ Keep reCAPTCHA v3 (invisible to users)
✅ Use HTTPS in production

### **DON'T:**
❌ Don't hardcode secret key in JavaScript
❌ Don't share secret key
❌ Don't use reCAPTCHA v2 (too annoying)
❌ Don't disable reCAPTCHA for "testing"

---

## 📈 Monitor Scores in Google Console

1. Go to: https://www.google.com/recaptcha/admin
2. Select your site
3. Click "Analytics"
4. View:
   - Score distribution
   - Bot attempt patterns
   - Geographic data
   - Request history

---

## 🧪 Testing Scenarios

### **Legitimate User:**
- Real browser
- Normal clicking
- Typical response time
- **Expected score:** 0.7-1.0 ✅

### **Suspicious Bot:**
- Automated submission
- Instant form filling
- Repeated attempts
- **Expected score:** 0.0-0.3 ❌

### **Compromise (score 0.3-0.7):**
- VPN/Proxy usage
- Unusual network
- **Action:** May require manual verification

---

## ⚠️ Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| "reCAPTCHA verification failed" | Invalid token | Refresh page & retry |
| "Suspicious activity detected" | Score too low | Try from normal network |
| "reCAPTCHA token missing" | JavaScript error | Check browser console |
| "Connection refused" | No internet | Check network |

---

## 🚨 Troubleshooting

### **Problem: reCAPTCHA not working after update**

**Check:**
1. Is RECAPTCHA_SITE_KEY set in .env? 
2. Is RECAPTCHA_SECRET_KEY set in .env?
3. Are domains added in Google Console?
4. Is server restarted after .env change?

**Solution:**
```powershell
# Verify keys
cat .env | grep RECAPTCHA

# Restart server
npm start
```

---

### **Problem: "Verification error" message**

**Cause:** Server can't reach Google API

**Solution:**
1. Check internet connection
2. Check firewall blocking HTTPS
3. Wait 5 minutes (API might be down)
4. Try again

---

### **Problem: All submissions blocked**

**Cause:** reCAPTCHA score threshold too high

**Fix in server.js (line ~127):**
```javascript
if (verifyData.score < 0.5) {  // Change 0.5 to lower value
```

Options:
- `0.3` = Allow some suspicious (more lenient)
- `0.5` = Default (balanced)
- `0.7` = Strict (blocks many users)

---

## 📱 Career Form

reCAPTCHA is automatically applied to career form too since it uses the same `makeFormHandler` function.

---

## 🌍 Production Checklist

Before going live:

- [ ] RECAPTCHA_SITE_KEY added to `.env`
- [ ] RECAPTCHA_SECRET_KEY added to `.env`
- [ ] Domain added in Google reCAPTCHA Console
- [ ] Site key updated in `contact.html`
- [ ] Server restarted
- [ ] Tested form submission
- [ ] Checked server logs
- [ ] `.env` NOT committed to Git
- [ ] HTTPS enabled on site
- [ ] Firewall allows HTTPS outbound (for Google verification)

---

## 🆚 reCAPTCHA Versions

| Feature | v2 | v3 |
|---------|----|----|
| **User Experience** | Shows "I'm not a robot" | Invisible |
| **Accuracy** | Good | Excellent |
| **Annoying** | Yes | No |
| **Recommended** | For high-security | ✅ Default |

You're using **v3** (invisible & better) ✅

---

## 📚 More Information

- reCAPTCHA Documentation: https://developers.google.com/recaptcha
- Admin Console: https://www.google.com/recaptcha/admin
- API Reference: https://developers.google.com/recaptcha/docs/v3

---

## ✅ Setup Complete!

Your contact form is now protected by Google reCAPTCHA v3. Bots will be blocked automatically while legitimate users submit forms without any friction.

🛡️ **Your site is now more secure!**

