# SBL Energy Website

Marketing site for SBL Energy Limited — industrial and mining explosives, Nagpur.
47 static pages served by a small Express server that also handles two contact
forms and tracks PDF datasheet downloads.

**This is not a pure static site.** The forms and the download tracking need Node
running. It cannot be hosted on GitHub Pages or any static-only host — the pages
would load but every form submission would fail.

---

## Running it locally

Requires **Node 18 or newer**.

```bash
npm install
npm start
```

Then open <http://localhost:8123>.

A correct start prints:

```
ℹ️  trust proxy: false — X-Forwarded-For ignored, using the direct socket address.
✅ PDF whitelist loaded: 26 files
SBL Energy site + contact API running on http://localhost:8123
Connected to downloads.db
✅ WAL mode enabled (improved concurrency)
```

`trust proxy: false` is correct locally — it means the server ignores forwarded-IP
headers and uses the real connection address.

### Common start-up problems

| Message | Cause |
|---|---|
| `❌ ERROR: TO_EMAIL environment variable is not set` | No `server/.env`, or the file is missing that key. The server refuses to start half-configured. |
| `⚠️ TURNSTILE_SITE_KEY and/or TURNSTILE_SECRET_KEY are not set` | Forms will reject every submission. Fill both in. |
| `Cannot find module 'express'` | Run `npm install` from the repo root, not from `server/`. |
| `EADDRINUSE :::8123` | Another copy is already running. |

---

## Configuration

All settings live in `server/.env`. Copy `server/.env.example` to start — it
documents every value and why it matters, and is the authority if this table and
that file ever disagree.

| Variable | Required | Notes |
|---|---|---|
| `TO_EMAIL` | **Yes** | Where enquiries land. Missing = server exits. |
| `GMAIL_USER` | **Yes** | Sending account. |
| `GMAIL_APP_PASSWORD` | **Yes** | Google app password, not the account password. |
| `TURNSTILE_SITE_KEY` | **Yes** | Public key, handed to the browser. |
| `TURNSTILE_SECRET_KEY` | **Yes** | Server-side key. Never exposed. |
| `NODE_ENV` | Production | `production` enables Secure cookies and HSTS. |
| `SESSION_SECRET` | Production | 64 hex chars. Keeps rate limits stable across restarts. |
| `TRUST_PROXY` | Behind a proxy | `loopback` for nginx/Caddy on the same machine. |
| `CAREER_EMAIL` | Optional | Falls back to `TO_EMAIL`. |
| `PORT` | Optional | Defaults to 8123. |

Values already present in the real environment are **not** overridden by the
`.env` file, so the same code works with systemd `Environment=` lines, Docker, or
a platform host without any change.

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/config` | GET | Returns the public Turnstile sitekey. |
| `/api/csrf-token` | GET | Issues a CSRF token and matching cookie. |
| `/api/contact` | POST | Enquiry form → `TO_EMAIL`. |
| `/api/career` | POST | Job application → `CAREER_EMAIL`. |
| `/assets/:folder/:file` | GET | Tracked, rate-limited PDF download. |

Only POST is routed on the two form endpoints; anything else returns 404.

### What a submission must pass

In order: rate limits → honeypot → CSRF token → Turnstile → field validation →
send. A failure at any step returns a message written for the visitor, and the
CSRF token is only spent once mail is actually delivered — so a rejected attempt
never leaves someone holding a dead token.

Field rules: name 2–200 characters, valid email under 200 characters, message
required and under **2000** characters. Names accept any characters — real names
contain apostrophes, hyphens and accents — and are escaped when written into the
email rather than restricted on input.

---

## Rate limits

Two layers everywhere: a per-visitor session budget for fairness, and a per-IP
budget that does the actual enforcing. Clearing cookies buys a fresh session but
still lands on the IP limit.

| Action | Per session | Per IP |
|---|---|---|
| Form submissions | 5 / 10 min | 30 / hour |
| PDF downloads | 25 / 10 min | 100 / hour |
| CSRF token requests | 30 / 10 min | 200 / hour |

Counters are held in memory, so a restart clears them.

**These limits depend on `TRUST_PROXY` being correct in production.** Set it
wrong and every visitor appears to share one address, so the per-IP limits apply
to all of them collectively.

---

## Download tracking

Every PDF request is recorded twice — to a CSV for spreadsheet review and to
SQLite for querying.

```
server/logs/downloads.csv          timestamp, ip, file, size, user-agent, referer, status
server/logs/form_submissions.csv   timestamp, ip, form type, status
server/data/downloads.db           tables: downloads, form_submissions
```

Recorded statuses include `success`, `rate_limit_exceeded_session`,
`rate_limit_exceeded_ip`, `security_violation_whitelist` and `not_found`.

Logging can never fail a request: if a log file is locked — usually because
someone has the CSV open in Excel — the download still succeeds and the server
prints `⚠️ Could not write downloads.csv`. **A silently broken logger therefore
looks identical to a healthy one**, which is why the runbook has an explicit test
that a row actually appears.

### Querying

```bash
sqlite3 server/data/downloads.db "SELECT file_name, COUNT(*) c FROM downloads WHERE status='success' GROUP BY file_name ORDER BY c DESC;"
```

### Two things that will catch you out

**The database is in WAL mode.** Copying only `downloads.db` can produce a file
with no tables at all — recent writes, and sometimes the schema, live in
`downloads.db-wal`. Always use SQLite's own backup:

```bash
sqlite3 server/data/downloads.db ".backup '/path/to/backup.db'"
```

**`server/data/` is gitignored**, so it does not exist in a fresh clone. Any
deploy that recreates the directory — `git clean -fdx`, `rsync --delete`, delete
and re-clone — destroys the database, and the server silently creates an empty
one with no error. Keep the data outside the deploy path in production.

---

## Which files are public

Only `assets/ css/ images/ js/` and bare `.html` files in the root are served.
Everything else — `server/`, `build/`, `docs/`, `scraped-html/`, the `.md` notes
— is unreachable over the web. This is a whitelist on purpose: a new folder is
private until deliberately published.

PDFs are served through the tracked route rather than as plain static files, so
downloads are always counted and rate-limited.

---

## Deploying

The site needs **one VM with a persistent disk** — the rate limiters are held in
memory and the database is a local file, so multiple instances would multiply the
limits and split the tracking data. EC2 or Compute Engine, not Lambda or Cloud
Run.

1. Set the eight required values (see Configuration), including real Turnstile
   keys — the test keys let every bot through.
2. Put nginx or Caddy in front for TLS, and set `TRUST_PROXY=loopback`.
   With nginx you must set `X-Forwarded-For` yourself; Caddy does it by default.
3. Open only ports 80 and 443. If 8123 is reachable, visitors can bypass the
   proxy.
4. Run under systemd with `Restart=always`.
5. Work through the test runbook — the pre-flight section catches the
   misconfigurations that otherwise surface as silent failures.

## Verifying

A runbook of 42 tests covers the fixes, both forms, the existing protections and
the production deployment — each with the exact command and the exact output
that means pass.

It lives at `docs/test-runbook.html`, which is **gitignored and not part of this
repository**: it documents internal paths, log lines and rate-limit thresholds
that need not be public. Open it from your working copy, or from the private
Artifact it is published to. If you have cloned this repo and the file is
missing, ask whoever maintains the site for a copy.

---

## Regenerating pages

`_build_pages.py` generates the product pages from shared templates. The scripts
in `build/` are an earlier generation of the same idea and are no longer the ones
being edited — check before using them.

```bash
python _build_pages.py
```

---

## Repository layout

```
*.html                47 live pages, served from the root
css/ js/ images/      public assets
assets/tds/           25 product datasheet PDFs
assets/brochure/      1 company brochure  (26 whitelisted in total)
server/server.js      the whole server — pages, forms, tracking
server/.env           secrets (gitignored; .env.example documents every key)
server/data/          SQLite database (gitignored)
server/logs/          CSV logs (gitignored)
docs/                 test runbook — gitignored, local only (see Verifying)
_build_pages.py       page generator
build/                earlier generator, superseded
overview-backups/     original copy from the pre-rewrite site, kept for reference
scraped-html/         original scraped pages, reference only, not served
```
