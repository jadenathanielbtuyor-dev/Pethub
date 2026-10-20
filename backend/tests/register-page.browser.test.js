// The registration page (pages/auth/register.html + js/core/auth.js) and the user dashboard's "Your details" card in
// headless Chrome: field-level validation, the request it sends, the loading, error and success states, repeated
// clicks, dark mode contrast and phone width.
// MOCKED: the page's fetch is replaced before core/api.js loads, and Railway, Vercel and CDN hosts are blocked, so
// nothing leaves the machine and no real account is created.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/register-page.browser.test.js
// Set CHROME_PATH if the browser is not installed in its default place.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const REGISTER_PAGE = pathToFileURL(path.join(FRONTEND, 'pages', 'auth', 'register.html')).href;
const DASHBOARD_PAGE = pathToFileURL(path.join(FRONTEND, 'pages', 'user', 'dashboard.html')).href;
const USER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Maria Santos', is_verified: true, created_at: '2026-01-15T08:00:00Z' };

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

const browserPath = findBrowser();
const skip = process.env.PETHUB_BROWSER_TESTS !== '1'
  ? 'set PETHUB_BROWSER_TESTS=1 to run the headless browser checks'
  : (!browserPath ? 'Chrome or Edge not found (set CHROME_PATH)' : false);

// Runs in the page before any page script and answers API calls from the scenario in localStorage
const FETCH_STUB = `(() => {
  window.__requests = [];
  const scenario = JSON.parse(localStorage.getItem('__scenario') || '{}');
  const reply = (status, data, delay = 0) => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })), delay));
  window.fetch = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const route = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
    const method = (init.method || 'GET').toUpperCase();
    window.__requests.push({ method, route, query, body: init.body || null });
    if (route === '/auth/register') {
      if (scenario.registerNetworkError) return new Promise((resolve, reject) => setTimeout(() => reject(new TypeError('Failed to fetch')), 50));
      const sent = JSON.parse(init.body || '{}');
      const body = scenario.registerBody || { success: true, message: 'User registered successfully. Verification code sent to email.', email: String(sent.email || '').toLowerCase() };
      return reply(scenario.registerStatus || 201, body, scenario.registerDelay ?? 150);
    }
    if (route === '/auth/user-status') {
      const data = { success: true, user: JSON.parse(sessionStorage.getItem('user') || '{}') };
      if ('profile' in scenario) data.profile = scenario.profile;
      return reply(200, data);
    }
    if (route === '/pets/userPets') return reply(200, { success: true, pets: [] });
    if (route === '/appointments/userAppointments') return reply(200, { success: true, appointments: [] });
    if (route === '/pets/medical-records') return reply(200, { success: true, records: [] });
    if (route === '/auth/activity-logs') return reply(200, { success: true, logs: [] });
    return reply(404, { error: 'not stubbed ' + route });
  };
})();`;

let browser = null;
let profileDir = '';
let debuggerOrigin = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startBrowser() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pethub-register-page-'));
  browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank'
  ], { stdio: 'ignore' });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  debuggerOrigin = `http://127.0.0.1:${port}`;
}

async function stopBrowser() {
  if (browser) browser.kill();
  await sleep(300);
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function openTab({ url, scenario = {}, dark = false, width = 1280, signedIn = false }) {
  const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve));
  let counter = 0;
  const pending = new Map();
  const errors = [];
  const consoleText = [];
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++counter;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method === 'Runtime.exceptionThrown') errors.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).split('\n')[0]);
    if (message.method === 'Runtime.consoleAPICalled') consoleText.push(message.params.args.map(arg => String(arg.value ?? arg.description ?? '')).join(' '));
  });
  const evaluate = async expression => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await evaluate(expression)) return true;
      await sleep(50);
    }
    return false;
  };

  for (const domain of ['Page', 'Runtime', 'Network']) await send(`${domain}.enable`);
  await send('Network.setBlockedURLs', { urls: ['*railway.app*', '*vercel.app*', '*jsdelivr.net*', '*googleapis.com*'] });
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  const session = signedIn
    ? `sessionStorage.setItem('authToken', 'test-token'); sessionStorage.setItem('user', ${JSON.stringify(JSON.stringify(USER))});`
    : '';
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('darkMode', ${JSON.stringify(String(dark))}); localStorage.setItem('__scenario', ${JSON.stringify(JSON.stringify(scenario))}); ${session} } catch (e) {}\n${FETCH_STUB}`
  });
  await send('Page.navigate', { url });
  await waitFor('document.readyState === "complete"');

  // Real typing (Input.insertText) after focusing, then leaving the field, like a customer would
  const type = async (selector, text) => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select && el.select(); return true; })()`);
    if (text) await send('Input.insertText', { text });
  };
  const click = async selector => {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  };

  const close = async () => {
    socket.close();
    await fetch(`${debuggerOrigin}/json/close/${target.id}`).catch(() => {});
  };
  return { evaluate, waitFor, type, click, errors, consoleText, close, send };
}

const SUBMIT = '#registerForm button[type=submit]';
const registerRequests = `window.__requests.filter(r => r.route === '/auth/register').map(r => JSON.parse(r.body))`;
// Sets values directly (fast) and fires the events the page listens to
const fill = values => `(() => {
  const values = ${JSON.stringify(values)};
  for (const [id, value] of Object.entries(values)) {
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`;
const REQUIRED = { fullname: 'Maria Santos', email: 'Maria@Example.test', password: 'Clinic#Pass2026', confirmPassword: 'Clinic#Pass2026' };
const fieldErrors = `(() => Object.fromEntries([...document.querySelectorAll('.register-field-error')].filter(e => !e.hidden).map(e => [e.id.replace(/Error$/, ''), e.textContent.trim()])))()`;
const formState = `(() => {
  const value = id => document.getElementById(id).value;
  const button = document.querySelector('${SUBMIT}');
  return {
    values: Object.fromEntries(['fullname', 'email', 'password', 'confirmPassword', 'dateOfBirth', 'gender', 'phoneNumber', 'addressLine', 'barangay', 'cityMunicipality', 'province', 'postalCode'].map(id => [id, value(id)])),
    message: document.getElementById('formMessageContainer').textContent.trim(),
    messageRole: document.getElementById('formMessageContainer').getAttribute('role'),
    button: button.textContent.replace(/\\s+/g, ' ').trim(),
    buttonDisabled: button.disabled,
    formVisible: !document.getElementById('registerFormView').hidden,
    successVisible: !document.getElementById('registerSuccess').hidden,
    detailsOpen: document.getElementById('personalDetails').open,
    focused: document.activeElement && document.activeElement.id
  };
})()`;
const CONTRAST = `
  const luminance = color => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const opaque = color => color && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(color) && !/rgba\\([^)]*, 0(\\.0+)?\\)$/.test(color);
  const background = element => { for (let e = element; e; e = e.parentElement) { const color = getComputedStyle(e).backgroundColor; if (opaque(color) && !/rgba/.test(color)) return color; } return getComputedStyle(document.body).backgroundColor; };
  const ratioOf = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };`;
const lowContrastIn = selector => `(() => { ${CONTRAST}
  return [...document.querySelectorAll(${JSON.stringify(`${selector} *`)})]
    .filter(element => element.children.length === 0 && element.textContent.trim() && element.getClientRects().length && !element.closest('.register-submit'))
    .map(element => [element.textContent.trim().slice(0, 40), Number(ratioOf(getComputedStyle(element).color, background(element)).toFixed(2))])
    .filter(([, value]) => value < 4.5);
})()`;
// Input borders against the card (WCAG 1.4.11 asks 3:1 for the outline of a control)
const weakInputBorders = `(() => { ${CONTRAST}
  return [...document.querySelectorAll('.register-input')].filter(e => e.getClientRects().length)
    .map(e => [e.id, Number(ratioOf(getComputedStyle(e).borderTopColor, background(e.parentElement)).toFixed(2))])
    .filter(([, value]) => value < 3);
})()`;
const submitContrast = `(() => { ${CONTRAST} const b = document.querySelector('${SUBMIT}'); return Number(ratioOf(getComputedStyle(b).color, getComputedStyle(b).backgroundColor).toFixed(2)); })()`;

describe('Registration page in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('labels every field, marks the required ones, and keeps personal details optional and collapsed', async () => {
    const tab = await openTab({ url: REGISTER_PAGE });
    try {
      const fields = await tab.evaluate(`[...document.querySelectorAll('#registerForm input, #registerForm select')].map(e => ({
        id: e.id, required: e.required, label: (document.querySelector('label[for="' + e.id + '"]') || {}).textContent?.replace(/\\s+/g, ' ').trim(),
        autocomplete: e.getAttribute('autocomplete'), describedBy: e.getAttribute('aria-describedby')
      }))`);
      assert.deepEqual(fields.filter(field => field.required).map(field => field.id), ['fullname', 'email', 'password', 'confirmPassword']);
      fields.forEach(field => {
        assert.ok(field.label, `${field.id} has a label`);
        assert.ok(field.autocomplete, `${field.id} has an autocomplete hint`);
        assert.ok(field.describedBy && field.describedBy.includes(`${field.id}Error`), `${field.id} is described by its error`);
      });
      assert.deepEqual(fields.map(field => field.id), ['fullname', 'email', 'password', 'confirmPassword', 'dateOfBirth', 'gender', 'phoneNumber', 'addressLine', 'barangay', 'cityMunicipality', 'province', 'postalCode']);
      assert.equal(await tab.evaluate(`document.getElementById('password').autocomplete`), 'new-password');
      assert.equal(await tab.evaluate(`document.getElementById('dateOfBirth').max`), await tab.evaluate(`(() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })()`));
      assert.deepEqual(await tab.evaluate(`[...document.getElementById('gender').options].map(o => o.textContent)`), ['Select an option', 'Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say']);

      const state = await tab.evaluate(formState);
      assert.equal(state.detailsOpen, false, 'personal details start collapsed');
      assert.equal(state.button, 'Create Account');
      assert.equal(await tab.evaluate(`document.querySelector('h2#registerTitle').textContent.trim()`), 'Create Your PetHub Account');
      assert.equal(await tab.evaluate(`document.querySelector('.register-login-link a').getAttribute('href')`), 'login.html');
      // No links to policy pages that do not exist
      assert.equal(await tab.evaluate(`[...document.querySelectorAll('a')].filter(a => /privacy|terms/i.test(a.textContent + a.href)).length`), 0);
      // Decorative icons are hidden from screen readers
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('.register-card i[class*="ri-"]')].filter(i => !i.closest('[aria-hidden="true"]') && !i.closest('button[aria-label]')).map(i => i.className)`), []);
      assert.deepEqual(tab.errors, []);
    } finally {
      await tab.close();
    }
  });

  it('the password toggles show and hide each password', async () => {
    const tab = await openTab({ url: REGISTER_PAGE });
    try {
      await tab.evaluate(fill({ password: 'Secret#123', confirmPassword: 'Secret#123' }));
      await tab.click('#togglePassword');
      assert.deepEqual(await tab.evaluate(`[document.getElementById('password').type, document.getElementById('togglePassword').getAttribute('aria-pressed'), document.getElementById('confirmPassword').type]`), ['text', 'true', 'password']);
      await tab.click('#togglePasswordConfirm');
      await tab.click('#togglePassword');
      assert.deepEqual(await tab.evaluate(`[document.getElementById('password').type, document.getElementById('confirmPassword').type]`), ['password', 'text']);
    } finally {
      await tab.close();
    }
  });

  it('shows each problem beside its field, focuses the first one and sends nothing', async () => {
    const tab = await openTab({ url: REGISTER_PAGE });
    try {
      await tab.click(SUBMIT);
      await tab.waitFor(`document.getElementById('fullnameError').hidden === false`);
      assert.deepEqual(await tab.evaluate(fieldErrors), {
        fullname: 'Enter your full name.',
        email: 'Enter your email address.',
        password: 'Create a password.',
        confirmPassword: 'Type your password again.'
      });
      const state = await tab.evaluate(formState);
      assert.equal(state.focused, 'fullname');
      assert.equal(state.message, 'Please fix the 4 highlighted fields.');
      assert.equal(state.messageRole, 'alert');
      assert.equal(await tab.evaluate(`document.getElementById('email').getAttribute('aria-invalid')`), 'true');

      await tab.evaluate(fill({ fullname: '12345', email: 'not-an-email', password: 'short', confirmPassword: 'different' }));
      await tab.click(SUBMIT);
      assert.deepEqual(await tab.evaluate(fieldErrors), {
        fullname: 'Enter your full name using letters.',
        email: 'Enter a valid email address, such as name@example.com.',
        password: 'Use at least 8 characters.',
        confirmPassword: 'Passwords do not match.'
      });

      // Fixing a field clears its message while typing
      await tab.type('#fullname', 'Maria Santos');
      assert.equal(await tab.evaluate(`document.getElementById('fullnameError').hidden`), true);
      assert.equal(await tab.evaluate(`document.getElementById('fullname').hasAttribute('aria-invalid')`), false);
      assert.deepEqual(await tab.evaluate(registerRequests), []);
    } finally {
      await tab.close();
    }
  });

  it('opens personal details to show a problem in an optional field', async () => {
    const tab = await openTab({ url: REGISTER_PAGE });
    try {
      await tab.evaluate(fill({ ...REQUIRED, postalCode: '12', phoneNumber: '12345', dateOfBirth: '2999-01-01' }));
      await tab.evaluate(`document.getElementById('personalDetails').open = false`);
      await tab.click(SUBMIT);
      const state = await tab.evaluate(formState);
      assert.equal(state.detailsOpen, true);
      assert.equal(state.focused, 'dateOfBirth');
      assert.deepEqual(await tab.evaluate(fieldErrors), {
        dateOfBirth: 'Date of birth cannot be in the future.',
        phoneNumber: 'Enter a Philippine mobile number, such as 0917 123 4567.',
        postalCode: 'Enter a 4-digit postal code.'
      });
      assert.deepEqual(await tab.evaluate(registerRequests), []);
    } finally {
      await tab.close();
    }
  });

  it('sends only the expected fields, shows the loading state, and sends once however often it is clicked', async () => {
    const tab = await openTab({ url: REGISTER_PAGE, scenario: { registerDelay: 600 } });
    try {
      await tab.evaluate(fill({ ...REQUIRED, fullname: '  Maria   Santos ' }));
      await tab.click(SUBMIT);
      await tab.waitFor(`document.querySelector('${SUBMIT}').disabled`);
      const loading = await tab.evaluate(formState);
      assert.equal(loading.button, 'Creating account...');
      assert.equal(loading.buttonDisabled, true);
      await tab.evaluate(`document.getElementById('registerForm').requestSubmit()`);
      await tab.evaluate(`document.querySelector('${SUBMIT}').click()`);

      await tab.waitFor(`!document.getElementById('registerSuccess').hidden`, 4000);
      const sent = await tab.evaluate(registerRequests);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], { fullname: 'Maria Santos', email: 'Maria@Example.test', password: 'Clinic#Pass2026', confirm_password: 'Clinic#Pass2026' });
    } finally {
      await tab.close();
    }
  });

  it('includes filled-in personal details, then explains the email verification step', async () => {
    const tab = await openTab({ url: REGISTER_PAGE });
    try {
      await tab.evaluate(`document.getElementById('personalDetails').open = true`);
      await tab.evaluate(fill({
        ...REQUIRED,
        dateOfBirth: '1994-06-15', gender: 'Prefer not to say', phoneNumber: '0917 123 4567',
        addressLine: ' Unit 4B,  12 Mabini Street ', cityMunicipality: 'Pasig City', postalCode: '1605'
      }));
      await tab.click(SUBMIT);
      await tab.waitFor(`!document.getElementById('registerSuccess').hidden`, 4000);

      const [sent] = await tab.evaluate(registerRequests);
      assert.deepEqual(sent, {
        fullname: 'Maria Santos', email: 'Maria@Example.test', password: 'Clinic#Pass2026', confirm_password: 'Clinic#Pass2026',
        date_of_birth: '1994-06-15', gender: 'Prefer not to say', phone_number: '0917 123 4567',
        address_line: 'Unit 4B, 12 Mabini Street', city_municipality: 'Pasig City', postal_code: '1605'
      });

      const success = await tab.evaluate(`({
        title: document.getElementById('registerSuccessTitle').textContent.trim(),
        text: document.getElementById('registerSuccessMessage').textContent.replace(/\\s+/g, ' ').trim(),
        focused: document.activeElement.id,
        continueHref: document.getElementById('registerContinueLink').href,
        pending: sessionStorage.getItem('pendingVerificationEmail'),
        storage: JSON.stringify({ ...sessionStorage }) + JSON.stringify(Object.fromEntries(Object.entries({ ...localStorage }).filter(([key]) => key !== '__scenario'))),
        passwordValues: [document.getElementById('password').value, document.getElementById('confirmPassword').value]
      })`);
      assert.equal(success.title, 'Check your email');
      assert.match(success.text, /We sent a 6-digit verification code to maria@example\.test\. Enter it on the next page/);
      assert.equal(success.focused, 'registerSuccessTitle');
      assert.match(success.continueHref, /pages\/auth\/verify-email\.html$/);
      assert.equal(success.pending, 'maria@example.test');
      assert.ok(!success.storage.includes('Clinic#Pass2026'), 'the password is never stored in the browser');
      assert.ok(!success.storage.includes('0917'), 'personal details are not stored in the browser');
      assert.deepEqual(success.passwordValues, ['', ''], 'the form is cleared');
      assert.ok(!tab.consoleText.join('\n').includes('Clinic#Pass2026'), 'the password is never logged');
    } finally {
      await tab.close();
    }
  });

  it('shows "email already registered" beside the email, keeps the other details and clears the passwords', async () => {
    const tab = await openTab({ url: REGISTER_PAGE, scenario: { registerStatus: 400, registerBody: { success: false, error: 'Email already registered', field: 'email' } } });
    try {
      await tab.evaluate(`document.getElementById('personalDetails').open = true`);
      await tab.evaluate(fill({ ...REQUIRED, cityMunicipality: 'Pasig City', gender: 'Female' }));
      await tab.click(SUBMIT);
      await tab.waitFor(`document.getElementById('emailError').hidden === false`, 4000);

      const state = await tab.evaluate(formState);
      assert.equal(await tab.evaluate(`document.getElementById('emailError').textContent`), 'An account with this email already exists. Log in, or use Forgot Password on the login page.');
      assert.equal(state.focused, 'email');
      assert.equal(state.values.fullname, 'Maria Santos');
      assert.equal(state.values.email, 'Maria@Example.test');
      assert.equal(state.values.cityMunicipality, 'Pasig City');
      assert.equal(state.values.gender, 'Female');
      assert.equal(state.values.password, '');
      assert.equal(state.values.confirmPassword, '');
      assert.equal(state.buttonDisabled, false);
      assert.equal(state.button, 'Create Account');
      assert.equal(state.successVisible, false);
    } finally {
      await tab.close();
    }
  });

  it('shows other server refusals as text (never as HTML) and lets the customer try again', async () => {
    const tab = await openTab({ url: REGISTER_PAGE, scenario: { registerStatus: 503, registerBody: { success: false, error: 'Personal details cannot be saved right now. <img src=x onerror="window.__xss=1">' } } });
    try {
      await tab.evaluate(fill(REQUIRED));
      await tab.click(SUBMIT);
      await tab.waitFor(`document.getElementById('formMessageContainer').textContent.length > 0 && !document.querySelector('${SUBMIT}').disabled`, 4000);
      const state = await tab.evaluate(formState);
      assert.match(state.message, /^Personal details cannot be saved right now\. <img src=x/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#formMessageContainer img').length + (window.__xss || 0)`), 0);
      assert.equal(state.values.fullname, 'Maria Santos');
      assert.equal(state.values.password, '');
      assert.equal(state.messageRole, 'alert');
    } finally {
      await tab.close();
    }
  });

  it('an account created without its email goes to the verification step with a warning', async () => {
    const tab = await openTab({ url: REGISTER_PAGE, scenario: { registerStatus: 500, registerBody: { success: false, error: 'Registration created, but failed to send verification email. Please try resending the code.' } } });
    try {
      await tab.evaluate(fill(REQUIRED));
      await tab.click(SUBMIT);
      await tab.waitFor(`!document.getElementById('registerSuccess').hidden`, 4000);
      const panel = await tab.evaluate(`({
        title: document.getElementById('registerSuccessTitle').textContent.trim(),
        text: document.getElementById('registerSuccessMessage').textContent,
        variant: document.getElementById('registerSuccess').dataset.variant,
        pending: sessionStorage.getItem('pendingVerificationEmail')
      })`);
      assert.equal(panel.title, 'Account created');
      assert.match(panel.text, /could not send the verification code to maria@example\.test yet/);
      assert.equal(panel.variant, 'warning');
      assert.equal(panel.pending, 'maria@example.test');
    } finally {
      await tab.close();
    }
  });

  it('a network failure keeps the details, clears the passwords and re-enables the button', async () => {
    const tab = await openTab({ url: REGISTER_PAGE, scenario: { registerNetworkError: true } });
    try {
      await tab.evaluate(fill(REQUIRED));
      await tab.click(SUBMIT);
      await tab.waitFor(`document.getElementById('formMessageContainer').textContent.length > 0 && !document.querySelector('${SUBMIT}').disabled`, 4000);
      const state = await tab.evaluate(formState);
      assert.match(state.message, /could not create your account right now/);
      assert.equal(state.values.email, 'Maria@Example.test');
      assert.equal(state.values.password, '');
      assert.equal(state.successVisible, false);
    } finally {
      await tab.close();
    }
  });

  for (const dark of [false, true]) {
    for (const width of [1280, 390]) {
      it(`stays readable and fits the screen (${dark ? 'dark' : 'light'} mode, ${width}px)`, async () => {
        const tab = await openTab({ url: REGISTER_PAGE, dark, width });
        try {
          assert.equal(await tab.evaluate(`document.body.classList.contains('dark-mode')`), dark);
          // main.js switches the theme after load and every colour has a 0.18 s transition; measure after it ends
          await sleep(400);
          const layout = await tab.evaluate(`({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            introShown: getComputedStyle(document.querySelector('.register-intro')).display !== 'none',
            mobileBrandShown: getComputedStyle(document.querySelector('.register-mobile-brand')).display !== 'none',
            cardHeight: Math.round(document.querySelector('.register-card').getBoundingClientRect().height)
          })`);
          assert.ok(layout.overflow <= 0, `no sideways scrolling (${layout.overflow}px)`);
          assert.equal(layout.introShown, width >= 1024);
          assert.equal(layout.mobileBrandShown, width < 1024);
          if (width >= 1024) assert.ok(layout.cardHeight < 1000, `the card is not overly tall (${layout.cardHeight}px)`);

          // Closed, then open with every message showing
          assert.deepEqual(await tab.evaluate(lowContrastIn('.register-card')), []);
          await tab.evaluate(`document.getElementById('personalDetails').open = true`);
          await tab.evaluate(fill({ postalCode: '1', phoneNumber: 'x', password: 'short' }));
          await tab.click(SUBMIT);
          await tab.evaluate(fill({ password: 'long enough pass' }));
          assert.deepEqual(await tab.evaluate(lowContrastIn('.register-card')), []);
          assert.deepEqual(await tab.evaluate(weakInputBorders), []);
          assert.ok(await tab.evaluate(submitContrast) >= 4.5);
          assert.ok(await tab.evaluate(`document.documentElement.scrollWidth - window.innerWidth`) <= 0, 'still fits with the details open');

          // Keyboard focus is visible on fields
          await tab.evaluate(`document.getElementById('email').focus()`);
          assert.notEqual(await tab.evaluate(`getComputedStyle(document.getElementById('email')).outlineStyle`), 'none');
          assert.deepEqual(tab.errors, []);
        } finally {
          await tab.close();
        }
      });
    }
  }
});

describe('User dashboard "Your details" card in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const card = `(() => {
    const container = document.getElementById('accountDetailsContainer');
    return {
      rows: Object.fromEntries([...container.querySelectorAll('dl > div')].map(row => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim()])),
      note: (container.querySelector('p') || {}).textContent?.trim() || ''
    };
  })()`;

  it('shows the saved details, formatted, and "Not provided" for blanks, without storing them in the browser', async () => {
    const profile = { phone_number: '+639171234567', date_of_birth: '1994-06-15', gender: 'Female', address_line: 'Unit 4B, 12 Mabini Street', barangay: null, city_municipality: 'Pasig City', province: 'Metro Manila', postal_code: '1605' };
    const tab = await openTab({ url: DASHBOARD_PAGE, signedIn: true, scenario: { profile } });
    try {
      await tab.waitFor(`document.querySelector('#accountDetailsContainer dl') !== null`);
      const shown = await tab.evaluate(card);
      assert.deepEqual(shown.rows, {
        'Full name': 'Maria Santos',
        Email: 'owner@example.test',
        'Member since': 'Jan 15, 2026',
        'Contact number': '+63 917 123 4567',
        'Date of birth': 'Jun 15, 1994',
        Gender: 'Female',
        Address: 'Unit 4B, 12 Mabini Street, Pasig City, Metro Manila, 1605'
      });
      assert.match(shown.note, /not available yet/);
      const statusRequest = await tab.evaluate(`window.__requests.find(r => r.route === '/auth/user-status')`);
      assert.match(statusRequest.query, /(^|&)include=profile(&|$)/);
      // __scenario is this test's own mock data
      const storage = await tab.evaluate(`JSON.stringify({ ...sessionStorage }) + JSON.stringify(Object.fromEntries(Object.entries({ ...localStorage }).filter(([key]) => key !== '__scenario')))`);
      assert.ok(!storage.includes('639171234567') && !storage.includes('Mabini'), 'the profile is kept in memory only');
      assert.deepEqual(tab.errors, []);
    } finally {
      await tab.close();
    }
  });

  it('marks empty details as not provided, and says when details could not be loaded', async () => {
    const empty = await openTab({ url: DASHBOARD_PAGE, signedIn: true, scenario: { profile: { phone_number: null, date_of_birth: null, gender: null, address_line: null, barangay: null, city_municipality: null, province: null, postal_code: null } } });
    try {
      await empty.waitFor(`document.querySelector('#accountDetailsContainer dl') !== null`);
      const shown = await empty.evaluate(card);
      ['Contact number', 'Date of birth', 'Gender', 'Address'].forEach(label => assert.equal(shown.rows[label], 'Not provided', label));
    } finally {
      await empty.close();
    }

    // An older backend (no profile in the reply) or a failed profile read
    const unavailable = await openTab({ url: DASHBOARD_PAGE, signedIn: true, scenario: { profile: null } });
    try {
      await unavailable.waitFor(`document.querySelector('#accountDetailsContainer dl') !== null`);
      const shown = await unavailable.evaluate(card);
      assert.deepEqual(Object.keys(shown.rows), ['Full name', 'Email', 'Member since']);
      assert.match(shown.note, /could not be loaded/);
      assert.deepEqual(unavailable.errors, []);
    } finally {
      await unavailable.close();
    }
  });

  for (const dark of [false, true]) {
    it(`the card is readable in ${dark ? 'dark' : 'light'} mode`, async () => {
      const tab = await openTab({ url: DASHBOARD_PAGE, signedIn: true, dark, scenario: { profile: { phone_number: '+639171234567', date_of_birth: null, gender: 'Male', address_line: null, barangay: null, city_municipality: null, province: null, postal_code: null } } });
      try {
        await tab.waitFor(`document.querySelector('#accountDetailsContainer dl') !== null`);
        await sleep(400);
        const low = await tab.evaluate(`(() => { ${CONTRAST}
          return [...document.querySelectorAll('#accountDetailsTitle, #accountDetailsContainer *')]
            .filter(e => e.children.length === 0 && e.textContent.trim() && e.getClientRects().length)
            .map(e => [e.textContent.trim().slice(0, 30), Number(ratioOf(getComputedStyle(e).color, background(e)).toFixed(2))])
            .filter(([, value]) => value < 4.5);
        })()`);
        assert.deepEqual(low, []);
      } finally {
        await tab.close();
      }
    });
  }
});
