// The booking page and the user dashboard in headless Chrome: the booking summary, "Book Appointment" (enabled by
// valid booking details only, never by payment availability), booking straight through POST /appointments/create,
// repeated clicks, refused bookings, contrast and phone width, and the dashboard's next appointment.
// MOCKED: the page's fetch is replaced before core/api.js loads, Railway, Vercel and CDN hosts are blocked, and any
// navigation to paymongo.com is recorded and aborted, so nothing leaves the machine.
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
const APPOINTMENT_ID = 'b0000000-0000-4000-8000-000000000001';
const USER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Owner', is_verified: true };
const PAYMENT_WORDING = /deposit|payment|paymongo|checkout|refund|₱/i;

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

const appointment = (fields = {}) => ({
  id: APPOINTMENT_ID, user_id: 'u1', pet_id: 'p1', pet_name: 'Mochi', service_type: 'Checkup', estimated_duration_minutes: 45,
  appointment_date: FUTURE, appointment_time: '10:00:00', status: 'Pending', handled_by: null, handled_by_name: null, ...fields
});

// Runs in the page before any page script and answers API calls from the scenario in localStorage
const FETCH_STUB = `(() => {
  window.__requests = [];
  const scenario = JSON.parse(localStorage.getItem('__scenario') || '{}');
  const reply = (status, data, delay = 0) => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })), delay));
  window.fetch = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const route = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    window.__requests.push({ method, route, body: init.body || null });
    if (route === '/appointments/userAppointments') {
      if (scenario.listStatus) return reply(scenario.listStatus, { error: 'Failed to fetch appointments' }, scenario.listDelay || 0);
      return reply(200, { success: true, appointments: scenario.appointments || [] }, scenario.listDelay || 0);
    }
    if (route === '/pets/userPets') return reply(200, { success: true, pets: [{ id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog' }] });
    if (route === '/appointments/all') return reply(200, { success: true, appointments: [] });
    if (route === '/appointments/create') return reply(scenario.createStatus || 201, scenario.createBody || { success: true, appointment: {} }, scenario.createDelay ?? 100);
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

// One tab with the fetch stub, blocked network and recorded paymongo.com navigations (there should never be any)
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
const summaryState = `(() => {
  const text = id => (document.getElementById(id) || {}).textContent?.trim() || '';
  const summary = document.getElementById('bookingSummary');
  const hint = document.getElementById('bookingDetailsHint');
  const button = ${SUBMIT};
  return {
    summaryVisible: Boolean(summary && summary.getClientRects().length),
    summaryText: summary ? summary.textContent.replace(/\\s+/g, ' ').trim() : '',
    pet: text('bookingSummaryPet'),
    service: text('bookingSummaryService'),
    dateTime: text('bookingSummaryDateTime'),
    duration: text('bookingSummaryDuration'),
    hint: hint && !hint.classList.contains('hidden') ? hint.textContent.trim() : '',
    button: button.textContent.replace(/\\s+/g, ' ').trim(),
    buttonDisabled: button.disabled,
    feedback: (document.getElementById('messageContainer') || {}).textContent?.trim() || '',
    pageText: document.body.innerText
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
const formValues = `(() => Object.fromEntries(['petSelect', 'serviceType', 'appointmentDate', 'appointmentTime'].map(id => [id, document.getElementById(id).value])))()`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route.startsWith('${route}'))`;
const paymentRequests = `window.__requests.filter(r => /payment|checkout|deposit/i.test(r.route))`;
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

  it('shows the booking summary and a disabled "Book Appointment" before anything is chosen, with no payment content', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { listDelay: 1500 } });
    try {
      const state = await tab.evaluate(summaryState);
      assert.equal(state.summaryVisible, true);
      assert.ok(state.summaryText.includes('Booking Summary'));
      assert.deepEqual([state.pet, state.service, state.dateTime, state.duration], ['Not selected', 'Not selected', 'Not selected', 'Not selected']);
      assert.equal(state.button, 'Book Appointment');
      assert.equal(state.buttonDisabled, true);
      assert.doesNotMatch(state.pageText, PAYMENT_WORDING);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('updates the summary as selections change and enables the button once the details are valid, even if the list fails to load', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { listStatus: 500 } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      assert.ok(await tab.waitFor(`document.getElementById('appointmentsList').textContent.includes('Failed to fetch appointments')`));
      let state = await tab.evaluate(summaryState);
      assert.equal(state.buttonDisabled, true, 'disabled until the details are complete');
      assert.equal(state.hint, 'Choose a pet, service, date and time to continue.');

      await tab.evaluate(fillForm());
      state = await tab.evaluate(summaryState);
      assert.equal(state.pet, 'Mochi');
      assert.equal(state.service, 'Checkup');
      assert.match(state.dateTime, /10:00 AM/);
      // The end time follows the service's estimated duration (Checkup: 45 minutes)
      assert.match(state.dateTime, /10:45 AM/);
      assert.match(state.duration, /45 min/);
      assert.equal(state.hint, '');
      assert.equal(state.button, 'Book Appointment');
      assert.equal(state.buttonDisabled, false, 'valid details are enough to book');

      await tab.evaluate(fillForm({ serviceType: 'Grooming' }));
      assert.equal((await tab.evaluate(summaryState)).service, 'Grooming');
      await tab.evaluate(fillForm({ appointmentDate: futureDate(-2) }));
      state = await tab.evaluate(summaryState);
      assert.equal(state.buttonDisabled, true, 'a past date disables the button again');
      assert.equal(state.hint, 'Fix the date or time above to continue.');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('books straight through POST /appointments/create, then confirms, resets the form and reloads the list', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { createBody: { success: true, appointment: appointment() } } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`document.getElementById('messageContainer').textContent.includes('Appointment booked')`));

      const [booking] = await tab.evaluate(requests('POST', '/appointments/create'));
      assert.deepEqual(JSON.parse(booking.body), {
        user_id: 'u1', pet_id: 'p1', pet_name: 'Mochi', service_type: 'Checkup', appointment_date: FUTURE, appointment_time: '10:00:00'
      });
      const state = await tab.evaluate(summaryState);
      assert.equal(state.feedback, 'Appointment booked. It is pending clinic approval.');
      assert.equal(state.pet, 'Not selected', 'the form was reset');
      assert.equal(state.button, 'Book Appointment');
      assert.ok(await tab.waitFor(`${requests('GET', '/appointments/userAppointments')}.length >= 2`), 'the list is reloaded');
      assert.deepEqual(await tab.evaluate(paymentRequests), []);
      assert.deepEqual(tab.payMongoNavigations, []);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('a double click sends one booking, and the button shows "Booking..." while it is saved', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { createDelay: 600, createBody: { success: true, appointment: appointment() } } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`(() => { ${SUBMIT}.click(); ${SUBMIT}.click(); document.getElementById('appointmentForm').requestSubmit(); return true; })()`);
      const busy = await tab.evaluate(summaryState);
      assert.equal(busy.button, 'Booking...');
      assert.equal(busy.buttonDisabled, true);
      assert.ok(await tab.waitFor(`document.getElementById('messageContainer').textContent.includes('Appointment booked')`));
      assert.equal((await tab.evaluate(requests('POST', '/appointments/create'))).length, 1);
    } finally { await tab.close(); }
  });

  it('keeps the choices and shows the server\'s answer when a booking is refused', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { createStatus: 400, createBody: { error: 'Selected time is unavailable.', suggested_time: '10:45' } } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`document.getElementById('messageContainer').textContent.includes('Next available time')`));
      const state = await tab.evaluate(summaryState);
      assert.equal(state.feedback, 'That slot is unavailable. Next available time: 10:45 AM.');
      assert.deepEqual(await tab.evaluate(formValues), { petSelect: 'p1', serviceType: 'Checkup', appointmentDate: FUTURE, appointmentTime: '10:00' });
      assert.equal(state.button, 'Book Appointment');
      assert.equal(state.buttonDisabled, false, 'the customer can try again');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('says so when the same booking was already made', async () => {
    const tab = await openTab({ url: BOOKING_PAGE, scenario: { createStatus: 200, createBody: { success: true, already_booked: true, appointment: appointment() } } });
    try {
      assert.ok(await tab.waitFor(petsLoaded));
      await tab.evaluate(fillForm());
      await tab.evaluate(`${SUBMIT}.click()`);
      assert.ok(await tab.waitFor(`document.getElementById('messageContainer').textContent.includes('already booked')`));
      assert.equal((await tab.evaluate(summaryState)).feedback, 'You already booked this appointment.');
    } finally { await tab.close(); }
  });

  it('lists appointments with their reference and clinic status only', async () => {
    const tab = await openTab({
      url: BOOKING_PAGE,
      scenario: { appointments: [appointment(), appointment({ id: 'c0000000-0000-4000-8000-000000000002', status: 'Approved', pet_name: 'Bantay' })] }
    });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('appointmentsList').textContent.includes('Bantay')`));
      const list = await tab.evaluate(`document.getElementById('appointmentsList').innerText`);
      assert.match(list, /PH-B0000000/);
      assert.match(list, /PH-C0000000/);
      assert.match(list, /Pending/);
      assert.match(list, /Approved/);
      assert.doesNotMatch(list, PAYMENT_WORDING);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#appointmentsList button').length`), 0, 'no payment buttons on the cards');
    } finally { await tab.close(); }
  });

  for (const dark of [false, true]) {
    it(`keeps readable contrast in the booking summary and on the button (${dark ? 'dark' : 'light'} mode), and fits a phone screen`, async () => {
      const tab = await openTab({ url: BOOKING_PAGE, dark, width: 375 });
      try {
        assert.ok(await tab.waitFor(petsLoaded));
        await tab.evaluate(fillForm());
        assert.equal(await tab.evaluate(`document.body.classList.contains('dark-mode')`), dark);
        // The theme fades in with CSS transitions; colours are measured once they have finished
        assert.ok(await tab.waitFor('document.getAnimations().length === 0'));
        const measured = await tab.evaluate(`[...document.querySelectorAll('#bookingSummary *')].filter(e => e.children.length === 0 && e.textContent.trim()).length`);
        assert.ok(measured >= 9, `the booking summary's text was measured (${measured} elements)`);
        assert.deepEqual(await tab.evaluate(lowContrastIn('#bookingSummary')), []);
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

  it('shows the next appointment with its clinic status and reference, and no payment details', async () => {
    const tab = await openTab({
      url: DASHBOARD_PAGE,
      scenario: {
        appointments: [
          appointment({ id: 'c0000000-0000-4000-8000-000000000002', pet_name: 'Bantay', appointment_date: futureDate(40), status: 'Approved' }),
          appointment()
        ]
      }
    });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('recentAppointmentsContainer').textContent.includes('Mochi')`));
      const upcoming = await tab.evaluate(`document.getElementById('recentAppointmentsContainer').textContent.replace(/\\s+/g, ' ')`);
      assert.match(upcoming, /Pending/);
      assert.match(upcoming, /Awaiting clinic approval/);
      assert.match(upcoming, /Reference: PH-B0000000/);
      assert.match(upcoming, /1 more upcoming appointment/);
      assert.doesNotMatch(upcoming, PAYMENT_WORDING);
      assert.doesNotMatch(await tab.evaluate('document.body.innerText'), PAYMENT_WORDING);
      assert.deepEqual(await tab.evaluate(paymentRequests), []);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
