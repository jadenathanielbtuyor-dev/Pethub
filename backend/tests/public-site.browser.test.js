// The public website and sign-in pages in headless Chrome: the mobile menu (button name and state, keyboard, Escape,
// focus leaving, clicking outside), the desktop layout, no sideways scrolling at 320/375/768/1280 px, readable
// contrast in light and dark mode, sticky-header anchors, reduced motion, the signed-in header, the login page's field
// messages and password toggle, the "book" path through login, and the forgot-password steps.
// MOCKED: helpers/browser.js replaces fetch in the page and blocks every external host; nothing leaves the machine.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/public-site.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, sleep, pageUrl, CONTRAST, startBrowser, stopBrowser, openTab } = require('./helpers/browser');

const PAGES = [
  'index.html', 'pages/public/about.html', 'pages/public/services.html', 'pages/public/contact.html', 'pages/public/privacy.html',
  'pages/auth/login.html', 'pages/auth/register.html', 'pages/auth/forgot-password.html', 'pages/auth/verify-email.html'
];
const CUSTOMER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Maria Santos', is_verified: true };

const menuState = `(() => {
  const toggle = document.querySelector('[data-nav-toggle]');
  const menu = document.getElementById('siteNavMenu');
  return {
    toggleShown: getComputedStyle(toggle).display !== 'none',
    expanded: toggle.getAttribute('aria-expanded'),
    label: toggle.getAttribute('aria-label'),
    menuShown: menu.getClientRects().length > 0,
    focused: document.activeElement === toggle ? 'toggle' : (document.activeElement && document.activeElement.textContent.trim())
  };
})()`;

const lowContrast = `(() => { ${CONTRAST}
  return [...document.querySelectorAll('header *, main *, footer *')]
    .filter(e => e.children.length === 0 && e.textContent.trim() && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
    .filter(e => !e.closest('.ph-skip-link'))
    .map(e => [e.textContent.trim().slice(0, 40), Number(ratioOf(getComputedStyle(e).color, background(e)).toFixed(2))])
    .filter(([, value]) => value < 4.5);
})()`;

describe('Public site in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('the phone menu opens and closes with its button, Escape, a link, focus leaving and a click outside', async () => {
    const tab = await openTab({ url: pageUrl('index.html'), width: 375 });
    try {
      let state = await tab.evaluate(menuState);
      assert.deepEqual([state.toggleShown, state.expanded, state.label, state.menuShown], [true, 'false', 'Open menu', false]);

      // Keyboard: Enter on the button opens it, Tab reaches the first link, Escape closes and returns focus
      await tab.evaluate(`document.querySelector('[data-nav-toggle]').focus()`);
      await tab.press('Enter', 'Enter', 13, '\r');
      state = await tab.evaluate(menuState);
      assert.deepEqual([state.expanded, state.label, state.menuShown], ['true', 'Close menu', true]);
      await tab.press('Tab', 'Tab', 9);
      assert.equal((await tab.evaluate(menuState)).focused, 'Home');
      await tab.press('Escape', 'Escape', 27);
      state = await tab.evaluate(menuState);
      assert.deepEqual([state.expanded, state.menuShown, state.focused], ['false', false, 'toggle']);

      // Focus moving out of the header closes it
      await tab.click('[data-nav-toggle]');
      assert.equal((await tab.evaluate(menuState)).expanded, 'true');
      await tab.evaluate(`document.querySelector('#siteNavMenu a').focus(); document.getElementById('main').focus()`);
      assert.equal((await tab.evaluate(menuState)).expanded, 'false');

      // A click elsewhere closes it
      await tab.click('[data-nav-toggle]');
      await tab.evaluate(`document.querySelector('.ph-hero').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
      assert.equal((await tab.evaluate(menuState)).expanded, 'false');

      // Choosing a link closes it (the click is stopped so the page stays put)
      await tab.click('[data-nav-toggle]');
      await tab.evaluate(`(() => { const link = document.querySelector('#siteNavMenu a'); link.addEventListener('click', e => e.preventDefault(), { once: true }); link.click(); return true; })()`);
      assert.equal((await tab.evaluate(menuState)).expanded, 'false');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('on a wide screen the links sit in one row and there is no menu button', async () => {
    const tab = await openTab({ url: pageUrl('pages/public/services.html'), width: 1280 });
    try {
      const state = await tab.evaluate(menuState);
      assert.equal(state.toggleShown, false);
      assert.equal(state.menuShown, true);
      const tops = await tab.evaluate(`[...document.querySelectorAll('.ph-nav-links a, .ph-nav-actions a')].map(a => Math.round(a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2))`);
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 4, `one row (${tops})`);
      assert.equal(await tab.evaluate(`document.querySelector('.ph-nav-links a[aria-current="page"]').textContent`), 'Services');
    } finally { await tab.close(); }
  });

  for (const width of [320, 375, 768, 1280]) {
    it(`every public and sign-in page fits ${width}px without sideways scrolling`, async () => {
      for (const file of PAGES) {
        const tab = await openTab({ url: pageUrl(file), width });
        try {
          const overflow = await tab.evaluate('document.documentElement.scrollWidth - window.innerWidth');
          assert.ok(overflow <= 0, `${file} at ${width}px scrolls sideways by ${overflow}px`);
          assert.deepEqual(tab.errors, [], file);
        } finally { await tab.close(); }
      }
    });
  }

  for (const dark of [false, true]) {
    for (const width of [375, 1280]) {
      it(`text is readable in ${dark ? 'dark' : 'light'} mode at ${width}px`, async () => {
        for (const file of PAGES) {
          const tab = await openTab({ url: pageUrl(file), width, dark });
          try {
            assert.equal(await tab.evaluate(`document.body.classList.contains('dark-mode')`), dark);
            await sleep(350);
            if (width < 768) await tab.click('[data-nav-toggle]');
            assert.deepEqual(await tab.evaluate(lowContrast), [], file);
          } finally { await tab.close(); }
        }
      });
    }
  }

  it('a link to a section lands below the sticky header', async () => {
    for (const width of [375, 1280]) {
      const tab = await openTab({ url: pageUrl('pages/public/services.html', '#check-up'), width });
      try {
        await sleep(200);
        const gap = await tab.evaluate(`document.getElementById('check-up').getBoundingClientRect().top - document.querySelector('.ph-header').getBoundingClientRect().bottom`);
        assert.ok(gap >= 0, `the heading is not hidden under the header at ${width}px (${gap}px)`);
      } finally { await tab.close(); }
    }
  });

  it('respects reduced motion', async () => {
    const tab = await openTab({ url: pageUrl('index.html'), reducedMotion: true });
    try {
      const durations = await tab.evaluate(`[...document.querySelectorAll('.ph-btn, .ph-nav-links a, .ph-card')].map(e => parseFloat(getComputedStyle(e).transitionDuration))`);
      assert.ok(durations.length > 3);
      assert.ok(durations.every(seconds => seconds <= 0.001), `transitions are effectively off (${durations})`);
    } finally { await tab.close(); }
  });

  it('signed in, the header offers the dashboard and log out, and booking links go straight to booking', async () => {
    const tab = await openTab({ url: pageUrl('pages/public/services.html'), session: CUSTOMER });
    try {
      const nav = await tab.evaluate(`({
        account: document.querySelector('[data-auth-link]').textContent.trim(),
        accountHref: document.querySelector('[data-auth-link]').href,
        logout: (document.querySelector('[data-logout-link]') || {}).textContent,
        book: document.querySelector('.ph-nav-actions [data-book-link]').href,
        bath: document.querySelector('[data-service="Bath"] [data-book-link]').href
      })`);
      assert.equal(nav.account, 'My dashboard');
      assert.match(nav.accountHref, /pages\/user\/dashboard\.html$/);
      assert.equal(nav.logout, 'Log out');
      assert.match(nav.book, /pages\/user\/appointments\.html$/);
      assert.match(nav.bath, /pages\/user\/appointments\.html\?service=Bath$/);
    } finally { await tab.close(); }
  });
});

describe('Sign-in pages in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const loginState = `(() => ({
    emailError: document.getElementById('emailError').hidden ? '' : document.getElementById('emailError').textContent,
    passwordError: document.getElementById('passwordError').hidden ? '' : document.getElementById('passwordError').textContent,
    message: document.getElementById('formMessageContainer').textContent.trim(),
    focused: document.activeElement && document.activeElement.id,
    requests: window.__requests.filter(r => r.route === '/auth/login').length
  }))()`;

  it('login shows problems beside each field, and the server\'s refusal below the form', async () => {
    const tab = await openTab({
      url: pageUrl('pages/auth/login.html'),
      scenario: { routes: { '/auth/login': { status: 403, body: { success: false, error: 'Invalid email or password' } } } }
    });
    try {
      await tab.click('#loginForm button[type=submit]');
      let state = await tab.evaluate(loginState);
      assert.deepEqual(state, {
        emailError: 'Enter your email address.',
        passwordError: 'Enter your password.',
        message: 'Please fix the 2 highlighted fields.',
        focused: 'email',
        requests: 0
      });
      assert.equal(await tab.evaluate(`document.getElementById('email').getAttribute('aria-invalid')`), 'true');

      await tab.type('#email', 'not-an-email');
      await tab.type('#password', 'whatever-pass');
      await tab.click('#loginForm button[type=submit]');
      state = await tab.evaluate(loginState);
      assert.equal(state.emailError, 'Enter a valid email address, such as name@example.com.');
      assert.equal(state.passwordError, '');
      assert.equal(state.requests, 0);

      await tab.type('#email', 'owner@example.test');
      await tab.click('#loginForm button[type=submit]');
      await tab.waitFor(`document.getElementById('formMessageContainer').textContent.includes('Invalid email or password')`);
      state = await tab.evaluate(loginState);
      assert.deepEqual([state.emailError, state.passwordError, state.requests], ['', '', 1], 'the refusal does not say which field was wrong');
      assert.equal(await tab.evaluate(`document.querySelector('#loginForm button[type=submit]').textContent.trim()`), 'Log in');
    } finally { await tab.close(); }
  });

  it('the password toggle names its action and state', async () => {
    const tab = await openTab({ url: pageUrl('pages/auth/login.html') });
    try {
      const toggle = `(() => { const b = document.getElementById('togglePassword'); return [document.getElementById('password').type, b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]; })()`;
      assert.deepEqual(await tab.evaluate(toggle), ['password', 'Show password', 'false']);
      await tab.click('#togglePassword');
      assert.deepEqual(await tab.evaluate(toggle), ['text', 'Hide password', 'true']);
      await tab.click('#togglePassword');
      assert.deepEqual(await tab.evaluate(toggle), ['password', 'Show password', 'false']);
    } finally { await tab.close(); }
  });

  it('"Book" through login continues to the booking page with the service chosen; other destinations are ignored', async () => {
    const routes = {
      '/auth/login': { status: 200, body: { success: true, user: CUSTOMER, token: 'test-token' } },
      '/pets/userPets': { status: 200, body: { success: true, pets: [{ id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog' }] } },
      '/appointments/userAppointments': { status: 200, body: { success: true, appointments: [] } },
      '/appointments/services': { status: 200, body: { success: true, species: ['Dog', 'Cat'], services: [
        { name: 'Bath', category: 'grooming', category_label: 'Grooming', description: 'A bath for your dog or cat.', species: ['Dog', 'Cat'], duration_minutes: 60, bookable: true }
      ] } }
    };
    const tab = await openTab({ url: pageUrl('pages/auth/login.html', '?next=appointments&service=Bath'), scenario: { routes } });
    try {
      await tab.type('#email', 'owner@example.test');
      await tab.type('#password', 'Clinic#Pass2026');
      await tab.click('#loginForm button[type=submit]');
      assert.ok(await tab.waitFor(`location.pathname.endsWith('/pages/user/appointments.html') && location.search === '?service=Bath'`, 4000));
      assert.ok(await tab.waitFor(`document.getElementById('serviceType') && document.getElementById('serviceType').value === 'Bath'`, 4000), 'the service is chosen');
    } finally { await tab.close(); }

    const other = await openTab({ url: pageUrl('pages/auth/login.html', '?next=https%3A%2F%2Fevil.example'), scenario: { routes } });
    try {
      await other.type('#email', 'owner@example.test');
      await other.type('#password', 'Clinic#Pass2026');
      await other.click('#loginForm button[type=submit]');
      assert.ok(await other.waitFor(`location.pathname.endsWith('/pages/user/dashboard.html')`, 4000));
    } finally { await other.close(); }
  });

  it('forgot password moves to the code step and labels both password toggles', async () => {
    const tab = await openTab({ url: pageUrl('pages/auth/forgot-password.html') });
    try {
      const shown = id => `document.getElementById('${id}').getClientRects().length > 0`;
      assert.equal(await tab.evaluate(shown('requestResetForm')), true);
      assert.equal(await tab.evaluate(shown('resetPasswordForm')), false, 'the second step starts hidden');
      await tab.click('#haveCodeButton');
      assert.equal(await tab.evaluate(shown('requestResetForm')), false);
      assert.equal(await tab.evaluate(shown('resetPasswordForm')), true);
      await tab.click('#togglePasswordConfirm');
      assert.equal(await tab.evaluate(`document.getElementById('togglePasswordConfirm').getAttribute('aria-label')`), 'Hide password confirmation');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
