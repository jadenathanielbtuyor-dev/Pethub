// Loads the real PetHub Express app (server.js) for tests, with:
// - dotenv stubbed, so backend/.env (real keys) is never read;
// - config/supabase.js and config/supabaseAdmin.js replaced by an in-memory database;
// - Brevo (email) answered by a fake, and every other outbound request refused and recorded (blockedRequests);
// - none of the removed payment settings (PAYMENTS_ENABLED, PAYMONGO_*) set, so every test also shows the backend
//   starts and works without them.
// Each test file runs in its own process (node --test), so module state never leaks between files.
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const Module = require('module');
const { once } = require('events');
const { createPetHubDatabase } = require('./fakeSupabase');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const REMOVED_PAYMENT_SETTINGS = ['PAYMENTS_ENABLED', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET', 'PAYMONGO_API_URL'];

function stubModule(filename, exports) {
  const stub = new Module(filename, module);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = exports;
  require.cache[filename] = stub;
}

function manilaDate(daysFromToday) {
  const date = new Date(Date.now() + daysFromToday * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// database: options for the in-memory database (helpers/fakeSupabase.js), e.g. { usersProfileColumns: false }
async function startTestApp({ env = {}, adminClientConfigured = true, database = {} } = {}) {
  const secrets = {
    authTokenSecret: crypto.randomBytes(32).toString('hex'),
    brevoApiKey: `xkeysib-fake-${crypto.randomBytes(12).toString('hex')}`
  };

  REMOVED_PAYMENT_SETTINGS.forEach(name => { delete process.env[name]; });
  Object.assign(process.env, {
    NODE_ENV: 'test',
    PETHUB_DISABLE_LISTEN: 'true',
    SUPABASE_URL: 'https://fake-project.supabase.invalid',
    SUPABASE_ANON_KEY: 'fake-anon-key-for-tests',
    SUPABASE_SERVICE_KEY: 'fake-service-key-for-tests',
    SUPABASE_KEY: '',
    AUTH_TOKEN_SECRET: secrets.authTokenSecret,
    FRONTEND_URL: 'https://pethub-frontend.test',
    CORS_ORIGINS: '',
    BREVO_API_KEY: secrets.brevoApiKey,
    SENDGRID_FROM_EMAIL: 'no-reply@pethub.test',
    SENDGRID_FROM_NAME: 'PetHub',
    GEMINI_API_KEY: ''
  }, env);

  const logs = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  ['log', 'warn', 'error', 'info'].forEach(level => {
    console[level] = (...args) => logs.push(`${level} ${util.format(...args)}`);
  });

  stubModule(require.resolve('dotenv', { paths: [BACKEND_DIR] }), { config: () => ({ parsed: {} }) });

  const db = createPetHubDatabase(database);
  const adminState = { configured: adminClientConfigured };
  stubModule(path.join(BACKEND_DIR, 'config', 'supabase.js'), db.client());
  stubModule(path.join(BACKEND_DIR, 'config', 'supabaseAdmin.js'), {
    getSupabaseAdmin: () => {
      if (!adminState.configured) throw new Error('Server-only database access is not configured.');
      return db.client();
    },
    isSupabaseAdminConfigured: () => adminState.configured
  });

  // Fake Brevo transactional email endpoint: records each accepted email; failNextEmail({ status } | { network: true })
  const emails = [];
  const emailFailures = [];
  function brevo(init = {}) {
    const headers = new Headers(init.headers || {});
    if (headers.get('api-key') !== process.env.BREVO_API_KEY) {
      return new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status: 401 });
    }
    const failure = emailFailures.shift();
    if (failure?.network) throw new TypeError('fetch failed');
    if (failure) return new Response(JSON.stringify({ code: 'simulated_failure', message: 'Simulated Brevo failure' }), { status: failure.status || 500 });

    const payload = JSON.parse(init.body);
    emails.push({
      to: payload.to.map(recipient => recipient.email),
      subject: payload.subject,
      text: payload.textContent || '',
      html: payload.htmlContent || ''
    });
    return new Response(JSON.stringify({ messageId: `<fake-${emails.length}@pethub.test>` }), { status: 201 });
  }

  // Every other outbound request (Gemini, PayMongo, anything else) is refused and recorded
  const blockedRequests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url || input);
    if (url === 'https://api.brevo.com/v3/smtp/email') return brevo(init);
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return realFetch(input, init);
    blockedRequests.push(new URL(url).origin);
    throw new Error(`Unexpected outbound request in tests: ${new URL(url).origin}`);
  };

  const app = require(path.join(BACKEND_DIR, 'server.js'));
  const { createAuthToken } = require(path.join(BACKEND_DIR, 'utils', 'authToken.js'));
  const appointmentNotifications = require(path.join(BACKEND_DIR, 'services', 'appointmentNotificationsService.js'));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function api(method, urlPath, { token, body, rawBody, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const response = await realFetch(`${baseUrl}${urlPath}`, {
      method,
      headers: requestHeaders,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = null;
    }
    return { status: response.status, body: json, text, contentType: response.headers.get('content-type') || '' };
  }

  // Appointment emails go out in the background; this waits for every one started so far
  async function settleEmails() {
    await appointmentNotifications.waitForBackgroundTasks();
  }

  function emailsTo(address) {
    return emails.filter(email => email.to.includes(address));
  }

  function createUser({ role = 'user', verified = true, name = 'Test User', password = 'not-used' } = {}) {
    const user = db.seed('users', {
      fullname: name,
      email: `${crypto.randomUUID()}@example.test`,
      password,
      role,
      is_verified: verified
    });
    return { ...user, token: createAuthToken(user.id) };
  }

  function createPet(user, name = 'Mochi') {
    return db.seed('pets', { user_id: user.id, name, species: 'Dog', breed: 'Aspin', age: 3 });
  }

  // Seeds an appointment directly (like rows that already exist in the database)
  function createAppointment(user, { pet, daysAhead = 20, time = '10:00:00', service = 'Checkup', duration = 45, status = 'Pending' } = {}) {
    const ownPet = pet || createPet(user);
    return db.seed('appointments', {
      user_id: user.id,
      pet_id: ownPet.id,
      pet_name: ownPet.name,
      service_type: service,
      estimated_duration_minutes: duration,
      appointment_date: manilaDate(daysAhead),
      appointment_time: time,
      status
    });
  }

  function appointmentRow(appointmentId) {
    return db.find('appointments', row => row.id === appointmentId);
  }

  async function close() {
    await appointmentNotifications.waitForBackgroundTasks();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    Object.assign(console, originalConsole);
  }

  return {
    app,
    db,
    secrets,
    logs,
    adminState,
    baseUrl,
    api,
    emails,
    emailsTo,
    failNextEmail: failure => emailFailures.push(failure),
    settleEmails,
    blockedRequests,
    createUser,
    createPet,
    createAppointment,
    appointmentRow,
    manilaDate,
    close
  };
}

module.exports = {
  startTestApp,
  manilaDate
};
