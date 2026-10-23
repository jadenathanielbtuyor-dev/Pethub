// The public website and sign-in pages as shipped (frontend/index.html, pages/public, pages/auth): the shared header
// with its menu button, one main heading, links and images that exist, no invented clinic facts, runtime services,
// no unlicensed stock photos or development placeholders, and form limits that match the backend.
// Static file checks only; behaviour in a browser is covered by public-site.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const { CONTACT_LIMITS } = require('../validators/contactValidator');

const PUBLIC_PAGES = ['index.html', 'pages/public/about.html', 'pages/public/services.html', 'pages/public/contact.html', 'pages/public/privacy.html'];
const AUTH_PAGES = ['pages/auth/login.html', 'pages/auth/register.html', 'pages/auth/forgot-password.html', 'pages/auth/verify-email.html'];
const read = file => fs.readFileSync(path.join(FRONTEND, file), 'utf8');
const textOf = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const decode = value => value.replace(/&amp;/g, '&');

describe('Shared header, structure and links', () => {
  for (const file of [...PUBLIC_PAGES, ...AUTH_PAGES]) {
    it(`${file}: header with menu button, skip link, one h1, and links and images that exist`, () => {
      const html = read(file);
      assert.match(html, /<header class="ph-header">/);
      const toggle = html.match(/<button type="button" class="ph-nav-toggle"[^>]*>/)[0];
      assert.match(toggle, /aria-controls="siteNavMenu"/);
      assert.match(toggle, /aria-expanded="false"/);
      assert.match(toggle, /aria-label="Open menu"/);
      assert.match(html, /<div id="siteNavMenu" class="ph-nav-menu">/);
      assert.match(html, /<a href="#main" class="ph-skip-link">/);
      assert.match(html, /<main id="main"[^>]*tabindex="-1"/);
      assert.equal((html.match(/<h1\b/g) || []).length, file.endsWith('register.html') ? 2 : 1, 'one main heading (register: one per step)');
      assert.match(html, /<footer class="footer ph-footer">/);
      assert.match(html, /<body class="ph-site /);

      const dir = path.dirname(path.join(FRONTEND, file));
      const refs = [...html.matchAll(/(?:href|src)="([^"#?][^"]*?)(?:[?#][^"]*)?"/g)].map(match => decode(match[1]))
        .filter(ref => !/^(https?:|mailto:|tel:)/.test(ref));
      assert.ok(refs.length > 10);
      refs.forEach(ref => assert.ok(fs.existsSync(path.resolve(dir, ref)), `${file} links to ${ref}, which exists`));
      [...html.matchAll(/<img\b[^>]*>/g)].forEach(([tag]) => assert.match(tag, /\salt="[^"]*"/, `${file}: every image has alt text`));
    });
  }
});

describe('Content is about the clinic, with nothing invented', () => {
  const INVENTED = [
    /support@pethub\.com/i, /Mon\s*-\s*Fri/i, /8:00 AM/i, /\+?63\s?9\d{2}/, /\(0\d\)\s?\d{3,4}/,
    /â‚±|PHP\s*\d|\bprice[sd]?\s*(from|start)/i, /\d[\d,]*\+\s*(happy|pets|clients|customers)/i, /\b\d\.\d\s*(star|rating)/i,
    /testimonial|what our (clients|customers) say|â˜…/i, /years of experience|award|certified|#1|best in/i,
    /vaccinat\w* service|dental cleaning|surgery/i, /\brabbits?\b|\bbirds?\b|\bhamsters?\b/i
  ];

  for (const file of [...PUBLIC_PAGES, ...AUTH_PAGES]) {
    it(`${file}: no invented contact details, prices, statistics, reviews, services or species`, () => {
      const text = textOf(read(file));
      INVENTED.forEach(pattern => assert.doesNotMatch(text, pattern, `${file} must not say ${pattern}`));
    });
  }

  it('public pages describe the clinic service, not how the website was built', () => {
    for (const file of PUBLIC_PAGES.filter(name => !name.endsWith('privacy.html'))) {
      assert.doesNotMatch(textOf(read(file)), /supabase|node\.?js|express|tailwind|capstone|backend/i, file);
    }
  });

  it('the public Services page loads the current catalog dynamically', () => {
    const html = read('pages/public/services.html');
    assert.match(html, /id="publicServiceCatalog"/);
    assert.ok(html.includes('js/public/services.js'));
    const script = read('js/public/services.js');
    assert.ok(script.includes('appointments/services'));
    assert.ok(script.includes('service.bookable'));
    for (const name of ['Bath', 'Puppy Cut', 'Dog & Cat Full Check Up']) assert.ok(!html.includes(name), name);
  });

  it('the home page links to the dynamic Services page without repeating its service list', () => {
    const html = read('index.html');
    const text = textOf(read('index.html'));
    assert.match(html, /href="pages\/public\/services\.html"/);
    for (const name of ['Puppy Cut', 'Flea and Tick Removal', 'Dog & Cat Full Check Up']) assert.ok(!text.includes(name), name);
  });

  it('public pages contain no development placeholder fields or tags', () => {
    for (const file of PUBLIC_PAGES) assert.doesNotMatch(read(file), /data-placeholder=|ph-placeholder-tag|class="ph-placeholder"/, file);
  });
});

describe('Public imagery', () => {
  it('does not serve third-party stock photos after removing their assets and credits', () => {
    const photosDir = path.join(FRONTEND, 'assets', 'images', 'photos');
    const photos = fs.readdirSync(photosDir).filter(name => /\.(jpe?g|png|webp)$/i.test(name));
    const used = new Set([...PUBLIC_PAGES, ...AUTH_PAGES].filter(file => read(file).includes('images/photos/')));
    assert.equal(used.size, 0);
    assert.deepEqual(photos, []);
    assert.equal(fs.existsSync(path.join(photosDir, 'CREDITS.md')), false);
  });
});
describe('Forms match the backend', () => {
  it('the contact form uses the backend\'s length limits', () => {
    const html = read('pages/public/contact.html');
    assert.match(html, new RegExp(`id="name"[^>]*maxlength="${CONTACT_LIMITS.name}"`));
    assert.match(html, new RegExp(`id="email"[^>]*maxlength="${CONTACT_LIMITS.email}"`));
    assert.match(html, new RegExp(`id="message"[^>]*maxlength="${CONTACT_LIMITS.message}"`));
  });

  it('the login form shows its errors beside each field and has a labelled password toggle', () => {
    const html = read('pages/auth/login.html');
    assert.match(html, /id="email"[^>]*aria-describedby="emailError"/);
    assert.match(html, /id="password"[^>]*aria-describedby="passwordError"/);
    assert.match(html, /<button type="button" id="togglePassword" class="ph-input-toggle" aria-label="Show password" aria-pressed="false">/);
    assert.match(html, /<a href="forgot-password\.html">Forgot password\?<\/a>/);
  });
});
