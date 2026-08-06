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
function setupApiForm(formId, endpoint, successMsg) {
  const form = document.getElementById(formId);
  if (!form) return;
  const status = form.querySelector('.form-status');
  const submitBtn = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.website) return; // honeypot tripped — silently drop

    const emailOk = isValidEmail(data.email);
    showFieldError(form, 'email', !emailOk);
    const phoneOk = isValidPhone(data.phoneCode, data.phone);
    showFieldError(form, 'phone', !phoneOk);
    if (!emailOk || !phoneOk) {
      status.textContent = 'Please fix the highlighted field(s) above.';
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
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'request failed');
      }
      status.textContent = successMsg;
      status.className = 'form-status ok';
      form.reset();
    } catch (err) {
      status.textContent = 'Something went wrong. Please email info@sblenergy.com directly.';
      status.className = 'form-status err';
      console.error('Form submission error:', err.message);
    } finally {
      submitBtn.disabled = false;
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
