// The public website and sign-in pages as shipped (frontend/index.html, pages/public, pages/auth): the shared header
// with its menu button, one main heading, links and images that exist, the clinic's real services (no invented
// services, prices, statistics, reviews or contact details), clearly marked placeholders for facts the clinic still
// has to confirm, photo credits, and form limits that match the backend.
// Static file checks only; behaviour in a browser is covered by public-site.browser.test.js (opt-in).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const { SERVICE_CATALOG, SPECIES_PENDING_CONFIRMATION } = require('../constants/services');
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
    /₱|PHP\s*\d|\bprice[sd]?\s*(from|start)/i, /\d[\d,]*\+\s*(happy|pets|clients|customers)/i, /\b\d\.\d\s*(star|rating)/i,
    /testimonial|what our (clients|customers) say|★/i, /years of experience|award|certified|#1|best in/i,
    /vaccinat\w* service|dental cleaning|surgery/i, /\brabbits?\b|\bbirds?\b|\bhamsters?\b/i
  ];

  for (const file of [...PUBLIC_PAGES, ...AUTH_PAGES]) {
    it(`${file}: no invented contact details, prices, statistics, reviews, services or species`, () => {
      const text = textOf(read(file));
      INVENTED.forEach(pattern => assert.doesNotMatch(text, pattern, `${file} must not say ${pattern}`));
    });
  }

  it('public pages describe the clinic\'s services, not how the website was built', () => {
    for (const file of PUBLIC_PAGES.filter(name => !name.endsWith('privacy.html'))) {
      assert.doesNotMatch(textOf(read(file)), /supabase|node\.?js|express|tailwind|capstone|backend/i, file);
    }
  });

  it('the Services page lists exactly the catalog\'s services, descriptions and species, with a booking link each', () => {
    const html = read('pages/public/services.html');
    const services = [...html.matchAll(/data-service="([^"]+)"/g)].map(match => decode(match[1]));
    assert.deepEqual(services, SERVICE_CATALOG.map(entry => entry.name));
    for (const entry of SERVICE_CATALOG) {
      const block = html.split(`data-service="${entry.name.replace(/&/g, '&amp;')}"`)[1].split(/data-service="|<\/section>/)[0];
      assert.ok(textOf(block).includes(entry.description), `${entry.name}: description from the catalog`);
      const species = [...block.matchAll(/ph-badge-(dog|cat)/g)].map(match => match[1] === 'dog' ? 'Dog' : 'Cat');
      assert.deepEqual(species, [...entry.species], `${entry.name}: species from the catalog`);
      assert.ok(block.includes(`login.html?next=appointments&amp;service=${encodeURIComponent(entry.name).replace(/%20/g, '+')}`), `${entry.name}: book link`);
      assert.equal(block.includes('data-placeholder="species"'), SPECIES_PENDING_CONFIRMATION.includes(entry.name), `${entry.name}: species placeholder only while pending`);
    }
  });

  it('the home page names every grooming service and the check-up', () => {
    const text = textOf(read('index.html'));
    SERVICE_CATALOG.forEach(entry => assert.ok(text.includes(entry.name), entry.name));
  });

  it('every placeholder is visibly labelled and none is hidden', () => {
    for (const file of PUBLIC_PAGES) {
      const html = read(file);
      const placeholders = [...html.matchAll(/<span class="ph-placeholder" data-placeholder="([^"]+)"><span class="ph-placeholder-tag">Placeholder<\/span>([^<]+)<\/span>/g)];
      assert.equal(placeholders.length, (html.match(/data-placeholder=/g) || []).length, `${file}: every placeholder uses the labelled markup`);
      placeholders.forEach(([, , text]) => assert.match(text, /to be (confirmed|provided|set)/i));
    }
    const contact = read('pages/public/contact.html');
    for (const kind of ['clinic-phone', 'clinic-email', 'clinic-address', 'clinic-hours']) {
      assert.ok(contact.includes(`data-placeholder="${kind}"`), kind);
    }
  });
});

describe('Photos and credits', () => {
  it('every photo used is credited on the About page and in CREDITS.md with a Creative Commons licence', () => {
    const photosDir = path.join(FRONTEND, 'assets', 'images', 'photos');
    const photos = fs.readdirSync(photosDir).filter(name => /\.(jpe?g|png|webp)$/i.test(name));
    const credits = fs.readFileSync(path.join(photosDir, 'CREDITS.md'), 'utf8');
    const about = read('pages/public/about.html');
    const used = new Set([...PUBLIC_PAGES, ...AUTH_PAGES].flatMap(file => [...read(file).matchAll(/images\/photos\/([^"]+)"/g)].map(match => match[1])));
    assert.ok(used.size >= 2);
    for (const photo of used) {
      assert.ok(photos.includes(photo), `${photo} exists`);
      const row = credits.split('\n').find(line => line.includes(`\`${photo}\``));
      assert.ok(row, `${photo} is in CREDITS.md`);
      assert.match(row, /CC BY \d\.\d — https:\/\/creativecommons\.org\/licenses\/by\/\d\.\d/);
      assert.match(row, /https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    }
    assert.equal((about.match(/licensed under <a href="https:\/\/creativecommons\.org\/licenses\/by\//g) || []).length, used.size);
    for (const file of PUBLIC_PAGES) {
      const html = read(file);
      [...html.matchAll(/<img src="[^"]*images\/photos\/[^"]+"[^>]*>[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption>/g)]
        .forEach(([, caption]) => assert.match(caption, /CC BY \d\.\d/, `${file}: the photo caption names its licence`));
    }
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
