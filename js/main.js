// ============ PRELOADER ============
// Full fuse animation on the first page of a session; quick version on later pages.
(() => {
  const revisit = sessionStorage.getItem('sbl-preloaded');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.insertAdjacentHTML('afterbegin', `
    <div id="preloader" aria-hidden="true">
      <div class="preloader-bolt"><img src="images/logo/sbl-energy-mark.png" alt="" /></div>
      <div class="preloader-name">SBL <span>Energy</span></div>
      <div class="preloader-fuse"></div>
      <div class="preloader-tag">Initiating</div>
    </div>`);
  const el = document.getElementById('preloader');
  if (revisit) el.classList.add('quick');
  document.documentElement.classList.add('preloading');
  const minTime = reduced ? 0 : (revisit ? 450 : 1500);
  const started = performance.now();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const wait = Math.max(0, minTime - (performance.now() - started));
    setTimeout(() => {
      el.classList.add('done');
      document.documentElement.classList.remove('preloading');
      try { sessionStorage.setItem('sbl-preloaded', '1'); } catch {}
      setTimeout(() => el.remove(), 650);
    }, wait);
  };
  if (document.readyState === 'complete') finish();
  else window.addEventListener('load', finish);
  setTimeout(finish, 6000); // never hold the page hostage
})();

// ============ NAV SCROLL ============
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 30) navbar.classList.add('scrolled');
  else navbar.classList.remove('scrolled');
});

// ============ MOBILE BURGER ============
const burger = document.getElementById('burger');
const navMenu = document.querySelector('.nav-menu');
burger?.addEventListener('click', () => {
  navMenu.classList.toggle('open');
});
document.querySelectorAll('.nav-menu a').forEach(a => {
  a.addEventListener('click', () => navMenu.classList.remove('open'));
});

// ============ REVEAL ON SCROLL ============
const io = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('in');
      io.unobserve(e.target);
    }
  });
}, { threshold: 0.12, rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// ============ STAT COUNTERS ============
const statObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const target = parseInt(el.dataset.target, 10);
      // data-suffix wins (e.g. "M+", "+"); else infer % vs +.
      const suffix = el.dataset.suffix != null ? el.dataset.suffix : (el.textContent.includes('%') ? '%' : '+');
      let current = 0;
      const duration = 1800;
      const start = performance.now();
      const tick = (now) => {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        current = Math.floor(eased * target);
        el.textContent = current.toLocaleString('en-US') + (progress === 1 ? suffix : '');
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      statObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('.stat-num[data-target]').forEach(el => statObserver.observe(el));

// ============ CYCLING PRODUCT BADGE ============
// Rotates through brand names on product pages where a list was supplied.
document.querySelectorAll('.prod-img-badge[data-brands]').forEach(badge => {
  let brands;
  try { brands = JSON.parse(badge.dataset.brands); } catch { return; }
  if (!Array.isArray(brands) || brands.length < 2) return;
  const nameEl = badge.querySelector('.badge-name');
  if (!nameEl) return;
  let i = 0;
  setInterval(() => {
    i = (i + 1) % brands.length;
    nameEl.style.opacity = '0';
    nameEl.style.transform = 'translateY(6px)';
    setTimeout(() => {
      nameEl.textContent = brands[i];
      nameEl.style.opacity = '1';
      nameEl.style.transform = 'translateY(0)';
    }, 220);
  }, 2200);
});

// ============ ROTATING PRODUCT IMAGE ============
// Cross-fades through a list of images on product pages where data-images was supplied.
document.querySelectorAll('.prod-img-frame[data-images]').forEach(frame => {
  let images;
  try { images = JSON.parse(frame.dataset.images); } catch { return; }
  if (!Array.isArray(images) || images.length < 2) return;
  const imgEl = frame.querySelector('img');
  if (!imgEl) return;
  images.forEach(src => { const pre = new Image(); pre.src = src; }); // preload
  imgEl.style.transition = 'opacity .5s ease, transform .6s ease';
  let i = 0;
  setInterval(() => {
    i = (i + 1) % images.length;
    imgEl.style.opacity = '0';
    setTimeout(() => {
      imgEl.src = images[i];
      imgEl.style.opacity = '1';
    }, 500);
  }, 3500);
});

// ============ FORM VALIDATION (contact + career share this) ============
// Same rule set the server enforces — mirrored here for instant feedback.
const EMAIL_PATTERN = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// Per-country digit-count rules for the national number (code stripped). Unlisted codes fall back to GENERIC.
const PHONE_RULES = {
  '+91': { min: 10, max: 10, pattern: /^[6-9]\d{9}$/ }, // Indian mobiles: 10 digits, starts 6-9
  '+1':  { min: 10, max: 10, pattern: /^\d{10}$/ },
};
const GENERIC_PHONE_RULE = { min: 6, max: 14, pattern: /^\d{6,14}$/ };

function isValidEmail(value) {
  return EMAIL_PATTERN.test(String(value || '').trim());
}
function isValidPhone(code, number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return true; // phone is optional — empty is fine
  const rule = PHONE_RULES[code] || GENERIC_PHONE_RULE;
  return rule.pattern.test(digits);
}

// Digit-only typing on the number part of any phone field.
document.querySelectorAll('.phone-number').forEach((input) => {
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '');
  });
});

function showFieldError(form, field, show) {
  const wrap = form.querySelector(`[data-error-for="${field}"]`)?.closest('.form-field') || document.getElementById(field + 'Field');
  const msg = form.querySelector(`[data-error-for="${field}"]`);
  if (msg) msg.classList.toggle('show', show);
  if (wrap) wrap.classList.toggle('invalid', show);
}

// ============ FORM SUBMIT (contact + career share this) ============
// Fetch CSRF token when form loads
async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/csrf-token');
    const data = await res.json();
    return data.csrfToken;
  } catch (err) {
    console.error('Failed to fetch CSRF token:', err);
    return null;
  }
}

// ============ CLOUDFLARE TURNSTILE ============
// The sitekey is per-environment, so it comes from the server rather than the markup.
// That means the widget is rendered explicitly, once we know which key to use.
async function fetchSiteConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('config request failed');
  return res.json();
}

// Loads the Turnstile API once, no matter how many forms ask for it.
let turnstileApiPromise = null;
function loadTurnstileApi() {
  if (turnstileApiPromise) return turnstileApiPromise;
  turnstileApiPromise = new Promise((resolve, reject) => {
    // Defining the callback before injecting the script avoids any load-order race.
    window.onTurnstileReady = () => resolve(window.turnstile);
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileReady';
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error('Turnstile script failed to load'));
    document.head.appendChild(script);
  });
  return turnstileApiPromise;
}

function setupApiForm(formId, endpoint, successMsg) {
  const form = document.getElementById(formId);
  if (!form) return;
  const status = form.querySelector('.form-status');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Fetch and inject CSRF token on page load. A failed fetch has to clear the field
  // rather than store it — assigning null to a dataset property writes the *string*
  // "null", which reads as a real token here and is rejected by the server instead.
  async function refreshCsrfToken() {
    const csrfToken = await fetchCsrfToken();
    if (csrfToken) form.dataset.csrfToken = csrfToken;
    else delete form.dataset.csrfToken;
  }
  refreshCsrfToken();

  const turnstileHost = form.querySelector('.turnstile-field');
  let turnstileWidgetId = null;

  (async function initTurnstile() {
    if (!turnstileHost) return;
    try {
      const { turnstileSiteKey } = await fetchSiteConfig();
      if (!turnstileSiteKey) throw new Error('TURNSTILE_SITE_KEY is not set on the server');
      const turnstile = await loadTurnstileApi();
      turnstileWidgetId = turnstile.render(turnstileHost, {
        sitekey: turnstileSiteKey,
        theme: 'dark'
      });
    } catch (err) {
      // Without a widget the form cannot be submitted, so say so rather than fail silently.
      console.error('Turnstile setup failed:', err.message);
      status.textContent = 'Verification could not load. Please reload the page, or email info@sblenergy.com directly.';
      status.className = 'form-status err';
    }
  })();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.website) return; // honeypot tripped — silently drop

    // Add CSRF token to request
    data.csrfToken = form.dataset.csrfToken;

    // Turnstile also injects a hidden 'cf-turnstile-response' field into the form;
    // read the token from the API instead and drop the stray field from the payload.
    delete data['cf-turnstile-response'];
    data.turnstileToken = (turnstileWidgetId !== null && window.turnstile)
      ? window.turnstile.getResponse(turnstileWidgetId) || ''
      : '';

    const emailOk = isValidEmail(data.email);
    showFieldError(form, 'email', !emailOk);
    const phoneOk = isValidPhone(data.phoneCode, data.phone);
    showFieldError(form, 'phone', !phoneOk);
    if (!emailOk || !phoneOk) {
      status.textContent = 'Please fix the highlighted field(s) above.';
      status.className = 'form-status err';
      return;
    }

    // Check if CSRF token is available
    if (!data.csrfToken) {
      status.textContent = 'Security token missing. Please reload the page and try again.';
      status.className = 'form-status err';
      return;
    }

    // Turnstile usually solves itself, but the token can still be pending or expired.
    if (turnstileHost && !data.turnstileToken) {
      status.textContent = 'Please complete the verification below and try again.';
      status.className = 'form-status err';
      return;
    }

    // Combine country code + national number into one field for the API.
    if (data.phone) {
      const phoneCode = data.phoneCode || '+1';
      data.phone = `${phoneCode} ${data.phone}`.trim();
    }
    delete data.phoneCode;

    submitBtn.disabled = true;
    status.textContent = 'Sending...';
    status.className = 'form-status';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin'  // Include cookies in the request
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        // The API explains why it rejected a submission (rate limit, failed verification,
        // invalid field) in wording meant for the visitor, so pass it straight through.
        throw Object.assign(new Error(errorData.error || 'request failed'), {
          fromServer: Boolean(errorData.error)
        });
      }
      status.textContent = successMsg;
      status.className = 'form-status ok';
      form.reset();
    } catch (err) {
      // Anything without a server explanation is a network or unknown failure.
      status.textContent = err.fromServer
        ? err.message
        : 'Something went wrong. Please email info@sblenergy.com directly.';
      status.className = 'form-status err';
      console.error('Form submission error:', err.message);
    } finally {
      submitBtn.disabled = false;
      // Turnstile tokens are single-use, so issue a fresh one for the next attempt.
      if (turnstileWidgetId !== null && window.turnstile) window.turnstile.reset(turnstileWidgetId);
      // A delivered message spends its CSRF token, and a page left open long enough
      // outlives one, so pick up a fresh token for whatever the visitor does next.
      refreshCsrfToken();
    }
  });
}
setupApiForm('contactForm', '/api/contact', 'Thank you — our team will reach out shortly.');
setupApiForm('careerForm', '/api/career', 'Thank you — our HR team will reach out shortly.');

// ============ CHARACTER COUNTER FOR MESSAGE FIELD ============
const messageField = document.getElementById('messageField');
const charCount = document.getElementById('charCount');
if (messageField && charCount) {
  const updateCharCount = () => {
    charCount.textContent = messageField.value.length;
  };
  messageField.addEventListener('input', updateCharCount);
  messageField.addEventListener('change', updateCharCount);
}

// ============ SMOOTH ANCHOR SCROLL OFFSET ============
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length > 1) {
      const tgt = document.querySelector(id);
      if (tgt) {
        e.preventDefault();
        const offset = 80;
        const top = tgt.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }
  });
});
