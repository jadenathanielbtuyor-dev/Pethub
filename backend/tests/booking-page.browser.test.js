// The booking page and the user dashboard in headless Chrome: the ₱100 deposit section, "Continue to Secure Payment"
// (booking, then the existing PayMongo checkout flow), checkout failures, payments switched off, the return from
// PayMongo and the dashboard's separate appointment and payment statuses.
// MOCKED: the page's fetch is replaced before core/api.js loads, Railway, Vercel and CDN hosts are blocked, and the
// PayMongo redirect is recorded and aborted, so nothing leaves the machine and no real payment is made.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/booking-page.browser.test.js
// Set CHROME_PATH if the browser is not installed in its default place.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const BOOKING_PAGE = pathToFileURL(path.join(FRONTEND, 'pages', 'user', 'appointments.html')).href;
const DASHBOARD_PAGE = pathToFileURL(path.join(FRONTEND, 'pages', 'user', 'dashboard.html')).href;
const CHECKOUT_URL = 'https://checkout.paymongo.com/cs_test_booking_page#fake';
const APPOINTMENT_ID = 'b0000000-0000-4000-8000-000000000001';
const POLICY = { required: true, amount: 100, currency: 'PHP', checkout_available: true };
const USER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Owner', is_verified: true };
const UNAVAILABLE_NOTE = 'Bookings need a ₱100 deposit, and online payment is not available right now. Please try again later or contact the clinic.';
const DEPOSIT_SENTENCE = 'Pay the required deposit through secure PayMongo checkout to complete your booking submission.';

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

// A date 30 days ahead in local time (YYYY-MM-DD), so bookings are never in the past
function futureDate(days = 30) {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const FUTURE = futureDate();

const deposit = fields => ({
  required: true, status: 'unpaid', amount: 100, currency: 'PHP', last_checkout_status: null, checkout_expires_at: null,
  paid_at: null, payment_method: null, late_payment: false, duplicate_payment: false, refund_required: false,
  slot_conflict: false, can_pay: false, ...fields
});
const appointment = (fields = {}) => ({
  id: APPOINTMENT_ID, user_id: 'u1', pet_id: 'p1', pet_name: 'Mochi', service_type: 'Checkup', estimated_duration_minutes: 45,
  appointment_date: FUTURE, appointment_time: '10:00:00', status: 'Pending', handled_by: null, handled_by_name: null, ...fields
});

// Runs in the page before any page script and answers API calls from the scenario in localStorage
const FETCH_STUB = `(() => {
  window.__requests = [];
  const scenario = JSON.parse(localStorage.getItem('__scenario') || '{}');
  const next = list => (list.length > 1 ? list.shift() : list[0]);
  const reply = (status, data, delay = 0) => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })), delay));
  window.fetch = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const route = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    window.__requests.push({ method, route, body: init.body || null });
    if (route === '/appointments/userAppointments') {
      if (scenario.listStatus) return reply(scenario.listStatus, { error: 'Failed to fetch appointments' }, scenario.listDelay || 0);
      return reply(200, { success: true, appointments: scenario.appointments || [], ...(scenario.policy ? { deposit_policy: scenario.policy } : {}) }, scenario.listDelay || 0);
    }
    if (route === '/pets/userPets') return reply(200, { success: true, pets: [{ id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog' }] });
    if (route === '/appointments/all') return reply(200, { success: true, appointments: [] });
    if (route === '/appointments/create') return reply(scenario.createStatus || 201, scenario.createBody || {}, 100);
    if (route === '/payments/checkout') { const step = next(scenario.checkouts || [{ status: 500, body: { error: 'not stubbed' } }]); return reply(step.status, step.body, 100); }
    if (route.startsWith('/payments/appointment/')) { const step = next(scenario.statuses || [{ status: 500, body: { error: 'not stubbed' } }]); return reply(step.status, step.body); }
    if (route === '/pets/medical-records') return reply(200, { success: true, records: [] });
    if (route === '/auth/activity-logs') return reply(200, { success: true, logs: [] });
    if (route === '/auth/user-status') return reply(200, { success: true, user: JSON.parse(sessionStorage.getItem('user') || '{}') });
    return reply(404, { error: 'not stubbed ' + route });
  };
})();`;

let browser = null;
let profileDir = '';
let debuggerOrigin = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startBrowser() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pethub-booking-page-'));
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

// One tab with the fetch stub, blocked network and recorded PayMongo navigations
async function openTab({ url, scenario = {}, dark = false, width = 1280 }) {
  const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve));
  let counter = 0;
  const pending = new Map();
  const errors = [];
  const payMongoNavigations = [];
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++counter;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method === 'Runtime.exceptionThrown') errors.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).split('\n')[0]);
    if (message.method === 'Fetch.requestPaused') {
      payMongoNavigations.push(message.params.request.url);
      send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'Aborted' });
    }
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
  await send('Fetch.enable', { patterns: [{ urlPattern: '*paymongo.com*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('darkMode', ${JSON.stringify(String(dark))}); localStorage.setItem('__scenario', ${JSON.stringify(JSON.stringify(scenario))}); sessionStorage.setItem('authToken', 'test-token'); sessionStorage.setItem('user', ${JSON.stringify(JSON.stringify(USER))}); } catch (e) {}\n${FETCH_STUB}`
  });
  await send('Page.navigate', { url });
  await waitFor('document.readyState === "complete"');

  const close = async () => {
    socket.close();
    await fetch(`${debuggerOrigin}/json/close/${target.id}`).catch(() => {});
  };
  return { evaluate, waitFor, errors, payMongoNavigations, close, send };
}

const SUBMIT = 'document.querySelector("#appointmentForm button[type=submit]")';
const panelState = `(() => {
  const text = id => (document.getElementById(id) || {}).textContent?.trim() || '';
  const panel = document.getElementById('depositPanel');
  const note = document.getElementById('depositPanelNote');
  const button = ${SUBMIT};
  return {
    panelVisible: Boolean(panel && panel.getClientRects().length),
    panelText: panel ? panel.textContent.replace(/\\s+/g, ' ').trim() : '',
    amount: text('depositPanelAmount'),
    pet: text('bookingSummaryPet'),
    service: text('bookingSummaryService'),
    dateTime: text('bookingSummaryDateTime'),
    duration: text('bookingSummaryDuration'),
    status: text('depositPaymentStatus'),
    note: note && !note.classList.contains('hidden') ? note.textContent.trim() : '',
    button: button.textContent.replace(/\\s+/g, ' ').trim(),
    buttonDisabled: button.disabled,
    feedback: (document.getElementById('messageContainer') || {}).textContent?.trim() || ''
  };
})()`;
const fillForm = (fields = {}) => `(() => {
  const values = ${JSON.stringify({ petSelect: 'p1', serviceType: 'Checkup', appointmentDate: FUTURE, appointmentTime: '10:00', ...fields })};
  for (const [id, value] of Object.entries(values)) {
    const element = document.getElementById(id);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
})()`;
const resultRows = `Object.fromEntries([...document.querySelectorAll('#bookingPaymentResult dl > div')].map(row => [row.querySelector('dt').textContent.trim(), row.querySelector('dd').textContent.trim()]))`;
const resultText = `(document.getElementById('bookingPaymentResult') || {}).textContent?.replace(/\\s+/g, ' ').trim() || ''`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route.startsWith('${route}'))`;
const petsLoaded = 'document.getElementById("petSelect").options.length > 1';
const CONTRAST = `
  const luminance = color => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const background = element => { for (let e = element; e; e = e.parentElement) { const color = getComputedStyle(e).backgroundColor; if (color && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(color)) return color; } return 'rgb(255, 255, 255)'; };
  const ratio = element => { const a = luminance(getComputedStyle(element).color); const b = luminance(background(element)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };`;
const lowContrastIn = selector => `(() => { ${CONTRAST}
  return [...document.querySelectorAll(${JSON.stringify(`${selector} *`)})]
    .filter(element => element.children.length === 0 && element.textContent.trim() && element.getClientRects().length)
    .map(element => [element.textContent.trim().slice(0, 40), Number(ratio(element).toFixed(2))])
    .filter(([, value]) => value < 4.5);
})()`;

describe('Booking page in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('shows the deposit section and a disabled "Continue to Secure Payment" before the API answers', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { policy: POLICY, listDelay: 1500 } });
    try {
      const state = await tab.evaluate(panelState);
      assert.equal(state.panelVisible, true);
      assert.ok(state.panelText.includes('Appointment Deposit'));
      assert.equal(state.amount, '₱100.00 PHP');
      assert.ok(state.panelText.includes(DEPOSIT_SENTENCE));
      assert.equal(state.status, 'Checking payment availability...');
      assert.equal(state.button, 'Continue to Secure Payment');
      assert.equal(state.buttonDisabled, true);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('updates the summary as selections change and enables the button once deposits are available', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { policy: POLICY } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      assert.ok(await tab.waitFor(`document.getElementById('depositPaymentStatus').textContent.trim() === 'Not paid yet'`));
      let state = await tab.evaluate(panelState);
      assert.deepEqual([state.pet, state.service, state.dateTime, state.duration], ['Not selected', 'Not selected', 'Not selected', 'Not selected']);
      assert.equal(state.buttonDisabled, true, 'disabled until the details are complete');

      await tab.evaluate(fillForm());
      state = await tab.evaluate(panelState);
      assert.equal(state.pet, 'Mochi');
      assert.equal(state.service, 'Checkup');
      assert.match(state.dateTime, /10:00 AM/);
      assert.match(state.duration, /45 min/);
      assert.equal(state.status, 'Not paid yet');
      assert.equal(state.button, 'Continue to Secure Payment');
      assert.equal(state.buttonDisabled, false);

      await tab.evaluate(fillForm({ serviceType: 'Grooming' }));
      assert.equal((await tab.evaluate(panelState)).service, 'Grooming');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('books, then opens the PayMongo checkout from POST /payments/checkout, sending no amount or payment status', async () => {
    const tab = await openTab({
      url: BOOKING_PAGE,
      scenario: {
        policy: POLICY,
        createBody: { success: true, appointment: appointment(), deposit: deposit({ can_pay: true }) },
        checkouts: [{ status: 201, body: { success: true, checkout_url: CHECKOUT_URL } }]
      }
    });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      assert.ok(await tab.waitFor(`document.getElementById('depositPaymentStatus').textContent.trim() === 'Not paid yet'`));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`window.__requests.some(r => r.route === '/payments/checkout')`));
      assert.ok(await tab.waitFor(`document.getElementById('depositPaymentStatus').textContent.trim() === 'Redirecting to PayMongo...'`));
      for (let i = 0; i < 40 && tab.payMongoNavigations.length === 0; i += 1) await sleep(50);

      const created = await tab.evaluate(requests('POST', '/appointments/create'));
      const checkouts = await tab.evaluate(requests('POST', '/payments/checkout'));
      assert.equal(created.length, 1);
      const booking = JSON.parse(created[0].body);
      assert.deepEqual(Object.keys(booking).sort(), ['appointment_date', 'appointment_time', 'pet_id', 'pet_name', 'service_type', 'user_id']);
      assert.equal(checkouts.length, 1);
      assert.equal(checkouts[0].body, JSON.stringify({ appointment_id: APPOINTMENT_ID }));
      // The browser leaves for the URL the backend returned (a fragment is never part of the request)
      assert.deepEqual(tab.payMongoNavigations, [CHECKOUT_URL.split('#')[0]]);
      assert.equal(await tab.evaluate(`sessionStorage.getItem('pethub.depositCheckoutAppointmentId')`), APPOINTMENT_ID);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('when checkout creation fails, shows the error and an incomplete booking, never a completed one', async () => {
    const tab = await openTab({
      url: BOOKING_PAGE,
      scenario: {
        policy: POLICY,
        createBody: { success: true, appointment: appointment(), deposit: deposit({ can_pay: true }) },
        checkouts: [{ status: 502, body: { error: 'PayMongo could not create the checkout.' } }],
        appointments: [appointment({ deposit: deposit({ can_pay: true }) })],
        statuses: [{ status: 200, body: { success: true, appointment_id: APPOINTMENT_ID, appointment_status: 'Pending', deposit: deposit({ can_pay: true }) } }]
      }
    });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`(document.getElementById('bookingPaymentResult') || {}).textContent?.includes('PayMongo could not create the checkout.')`));
      const rows = await tab.evaluate(resultRows);
      assert.equal(rows['Appointment status'], 'Booking incomplete');
      assert.equal(rows['Payment status'], 'Awaiting payment');
      assert.equal(rows.Deposit, '₱100.00');
      const text = await tab.evaluate(resultText);
      assert.match(text, /Your booking is not complete/);
      assert.doesNotMatch(text, /Appointment booked|Payment verified/);
      assert.ok(text.includes('Retry payment'));
      assert.deepEqual(tab.payMongoNavigations, []);
    } finally { await tab.close(); }
  });

  it('does not follow a checkout URL that is not on paymongo.com', async () => {
    const tab = await openTab({
      url: BOOKING_PAGE,
      scenario: {
        policy: POLICY,
        createBody: { success: true, appointment: appointment(), deposit: deposit({ can_pay: true }) },
        checkouts: [{ status: 201, body: { success: true, checkout_url: 'https://paymongo.example.test/checkout' } }],
        appointments: [appointment({ deposit: deposit({ can_pay: true }) })],
        statuses: [{ status: 200, body: { success: true, appointment_id: APPOINTMENT_ID, appointment_status: 'Pending', deposit: deposit({ can_pay: true }) } }]
      }
    });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`(document.getElementById('bookingPaymentResult') || {}).textContent?.includes('Your booking is not complete')`));
      assert.deepEqual(tab.payMongoNavigations, []);
      assert.equal(await tab.evaluate(`location.href.startsWith('file:')`), true);
    } finally { await tab.close(); }
  });

  for (const [label, scenario, status, note] of [
    ['deposits are switched off on the server (no deposit_policy)', {}, 'Online payment unavailable', UNAVAILABLE_NOTE],
    ['deposits are on but checkout is not configured', { policy: { ...POLICY, checkout_available: false } }, 'Online payment unavailable', UNAVAILABLE_NOTE],
    ['availability cannot be checked (list fails)', { listStatus: 500 }, 'Status unavailable', 'We could not check whether online payment is available, so bookings cannot be submitted right now. Refresh the page to try again.']
  ]) {
    it(`books nothing when ${label}, and says so`, async () => {
      const tab = await openTab({ url: BOOKING_PAGE, scenario });
      try {
        assert.ok(await tab.waitFor(petsLoaded));
        assert.ok(await tab.waitFor(`document.getElementById('depositPaymentStatus').textContent.trim() === ${JSON.stringify(status)}`));
        await tab.evaluate(fillForm());
        const state = await tab.evaluate(panelState);
        assert.equal(state.panelVisible, true);
        assert.equal(state.amount, '₱100.00 PHP');
        assert.equal(state.note, note);
        assert.equal(state.button, 'Online payment unavailable');
        assert.equal(state.buttonDisabled, true);

        // Even a forced submit (button bypassed) books nothing
        await tab.evaluate(`document.getElementById('appointmentForm').requestSubmit()`);
        await sleep(300);
        assert.deepEqual(await tab.evaluate(requests('POST', '/appointments/create')), []);
        assert.deepEqual(await tab.evaluate(requests('POST', '/payments/checkout')), []);
        assert.equal((await tab.evaluate(panelState)).feedback, note);
      } finally { await tab.close(); }
    });
  }

  it('with deposits off, an existing deposit-required booking stays incomplete with its ₱100 deposit and no pay button', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { appointments: [appointment({ deposit: deposit({ can_pay: false }) })] } });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('appointment-${APPOINTMENT_ID}') !== null`));
      const card = await tab.evaluate(`document.getElementById('appointment-${APPOINTMENT_ID}').textContent.replace(/\\s+/g, ' ')`);
      assert.match(card, /Appointment status Booking incomplete/);
      assert.match(card, /Payment status Awaiting payment/);
      assert.match(card, /Deposit ₱100\.00/);
      assert.match(card, /Online payment is not available for this appointment right now/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('[data-deposit-action="pay"]').length`), 0);
    } finally { await tab.close(); }
  });

  it('coming back from PayMongo trusts only the server: pending stays incomplete, a verified payment is Pending admin approval', async () => {
    const pendingDeposit = deposit({ status: 'pending', can_pay: true });
    const paidDeposit = deposit({ status: 'paid', paid_at: new Date().toISOString() });
    const tab = await openTab({
      url: `${BOOKING_PAGE}?payment=return&appointment_id=${APPOINTMENT_ID}`,
      scenario: {
        policy: POLICY,
        appointments: [appointment({ deposit: pendingDeposit })],
        statuses: [
          { status: 200, body: { success: true, appointment_id: APPOINTMENT_ID, appointment_status: 'Pending', deposit: pendingDeposit } },
          { status: 200, body: { success: true, appointment_id: APPOINTMENT_ID, appointment_status: 'Pending', deposit: paidDeposit } }
        ]
      }
    });
    try {
      assert.ok(await tab.waitFor(`(document.getElementById('bookingPaymentResult') || {}).textContent?.includes('Payment pending')`));
      let rows = await tab.evaluate(resultRows);
      assert.equal(rows['Appointment status'], 'Booking incomplete', 'the redirect alone does not complete the booking');
      assert.equal(rows['Payment status'], 'Payment pending');
      assert.equal(await tab.evaluate(`location.search`), '', 'the return parameters are removed from the address bar');

      await tab.evaluate(`[...document.querySelectorAll('#bookingPaymentResult button')].find(b => b.textContent.includes('Check payment status')).click()`);
      assert.ok(await tab.waitFor(`(document.getElementById('bookingPaymentResult') || {}).textContent?.includes('Payment verified')`));
      rows = await tab.evaluate(resultRows);
      assert.equal(rows['Payment status'], 'Paid');
      assert.equal(rows['Appointment status'], 'Pending admin approval');
    } finally { await tab.close(); }
  });

  for (const dark of [false, true]) {
    it(`keeps readable contrast in the deposit section and on the button (${dark ? 'dark' : 'light'} mode), and fits a phone screen`, async () => {
      const tab = await openTab({ url: BOOKING_PAGE, dark, width: 375, scenario: { policy: POLICY } });
      try {
        assert.ok(await tab.waitFor(petsLoaded));
        await tab.evaluate(fillForm());
        assert.equal(await tab.evaluate(`document.body.classList.contains('dark-mode')`), dark);
        // The theme fades in with CSS transitions; colours are measured once they have finished
        assert.ok(await tab.waitFor('document.getAnimations().length === 0'));
        const measured = await tab.evaluate(`[...document.querySelectorAll('#depositPanel *')].filter(e => e.children.length === 0 && e.textContent.trim()).length`);
        assert.ok(measured >= 12, `the deposit section's text was measured (${measured} elements)`);
        assert.deepEqual(await tab.evaluate(lowContrastIn('#depositPanel')), []);
        const buttonRatio = await tab.evaluate(`(() => { ${CONTRAST} return Number(ratio(${SUBMIT}).toFixed(2)); })()`);
        assert.ok(buttonRatio >= 4.5, `button contrast ${buttonRatio}`);
        assert.equal(await tab.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'no horizontal scrolling');
      } finally { await tab.close(); }
    });
  }
});

describe('User dashboard in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('shows appointment and payment statuses apart, and never lists an unpaid deposit booking as upcoming', async () => {
    const paidId = 'b0000000-0000-4000-8000-000000000002';
    const tab = await openTab({
      url: DASHBOARD_PAGE,
      scenario: {
        appointments: [
          appointment({ deposit: deposit({ can_pay: true, last_checkout_status: 'expired' }) }),
          appointment({ id: paidId, pet_name: 'Bantay', appointment_date: futureDate(31), deposit: deposit({ status: 'paid' }) })
        ]
      }
    });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('incompleteBookingsNotice') !== null`));
      const notice = await tab.evaluate(`document.getElementById('incompleteBookingsNotice').textContent.replace(/\\s+/g, ' ')`);
      assert.match(notice, /1 booking is not complete/);
      assert.match(notice, /Appointment status: Booking incomplete/);
      assert.match(notice, /Payment: Checkout expired \(₱100\.00 deposit\)/);
      assert.equal(await tab.evaluate(`document.querySelector('#incompleteBookingsNotice a[href="appointments.html#appointment-${APPOINTMENT_ID}"]').textContent.trim()`), 'Pay ₱100 deposit');

      const upcoming = await tab.evaluate(`document.getElementById('recentAppointmentsContainer').textContent.replace(/\\s+/g, ' ')`);
      assert.match(upcoming, /Bantay/);
      assert.match(upcoming, /Pending admin approval/);
      assert.match(upcoming, /Payment: Paid \(₱100\.00 deposit\)/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
