// Fixes from the 2026-10-24 system audit: CORS origin matching, error replies that hide server paths, API 404 matching
// by whole path segment, the chatbot's FAQ / emergency matching, verification codes from the cryptographic generator,
// and two frontend helpers (escapeHtml in attribute values, the site root of root-level pages).
// MOCKED: the real Express app with the in-memory database and fake Brevo (helpers/harness.js); the frontend helpers
// run in a node:vm sandbox with a fake window. Nothing leaves the machine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { startTestApp } = require('./helpers/harness');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

describe('CORS origins', () => {
  const preflight = origin => t.api('OPTIONS', '/auth/login', {
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });

  it('allows the Vercel site and localhost on any port', async () => {
    for (const origin of ['https://pethub-zzz-duke1-s-projects.vercel.app', 'http://localhost:5500', 'http://localhost:3000']) {
      const response = await preflight(origin);
      assert.equal(response.status, 204, origin);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
  });

  it('refuses an origin that only contains the word localhost, with a 403 rather than a server error', async () => {
    for (const origin of ['https://localhost.attacker.example', 'https://notlocalhost.example', 'https://attacker.example']) {
      const response = await preflight(origin);
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
      assert.equal(response.body.error, 'Not allowed by CORS');
    }
  });
});

describe('Error replies and API 404s', () => {
  it('a missing static file answers "Not found" without the server path', () => {
    const errorHandler = require('../middleware/errorHandler');
    const reply = {};
    const res = {
      headersSent: false,
      status(code) { reply.status = code; return this; },
      json(body) { reply.body = body; return this; }
    };
    const error = Object.assign(new Error("ENOENT: no such file or directory, stat '/frontend/index.html'"), { code: 'ENOENT', status: 404 });
    errorHandler(error, { method: 'GET', originalUrl: '/', headers: {}, ip: '127.0.0.1' }, res, () => {});
    assert.equal(reply.status, 404);
    assert.equal(JSON.stringify(reply.body).includes('frontend'), false);
    assert.equal(JSON.stringify(reply.body).includes('ENOENT'), false);
  });

  it('matches API prefixes by whole path segment: /admin-dashboard.html is a page, /payments/... is an API 404', async () => {
    const page = await t.api('GET', '/admin-dashboard.html');
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/);

    for (const apiPath of ['/payments', '/payments/checkout', '/contact/unknown']) {
      const api = await t.api('GET', apiPath);
      assert.equal(api.status, 404, apiPath);
      assert.equal(api.body.error, 'API endpoint not found', apiPath);
    }
  });
});

describe('Personal data in replies and logs', () => {
  it('replies do not name the server framework', async () => {
    const response = await t.api('GET', '/appointments/services');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('a contact message is stored once; the activity log does not copy its name, email or text', async () => {
    const message = { name: 'Maria Santos', email: 'maria.contact@example.test', message: 'Please call me about grooming.' };
    const response = await t.api('POST', '/contact', { body: message });
    assert.equal(response.status, 200);
    assert.equal(t.db.table('contact_messages').filter(row => row.email === message.email).length, 1);
    const logs = t.db.table('activity_logs').filter(row => row.action === 'contact_message');
    assert.ok(logs.length >= 1);
    for (const value of Object.values(message)) {
      assert.equal(logs.some(row => String(row.details).includes(value)), false, value);
    }
  });
});

describe('AI chatbot matching', () => {
  const ask = message => t.api('POST', '/ai/chat', { body: { message } });

  it('greets "hi" with the greeting, not with an unrelated canned answer', async () => {
    const response = await ask('hi');
    assert.equal(response.body.isFAQ, true);
    assert.match(response.body.reply, /^Hi! I can help/);
  });

  it('does not answer one- or two-letter fragments from the FAQ', async () => {
    for (const message of ['a', 'is', 'how', 'pet']) {
      const response = await ask(message);
      assert.notEqual(response.body.isFAQ, true, message);
    }
  });

  it('still finds a known question from a specific fragment', async () => {
    assert.match((await ask('add a pet')).body.reply, /My Pets/);
    assert.match((await ask('grooming')).body.reply, /Services/);
  });

  it('routine phrases are not emergencies, but a real emergency word still is', async () => {
    for (const message of ['My dog needs a blood test', 'potty accident on the rug']) {
      assert.notEqual((await ask(message)).body.isEmergency, true, message);
    }
    for (const message of ['blood in his stool', 'my dog is bleeding after a blood test', 'my dog was hit by a car']) {
      assert.equal((await ask(message)).body.isEmergency, true, message);
    }
  });
});

describe('Email verification codes', () => {
  it('are six digits from the cryptographic generator', () => {
    const { generateVerificationCode } = require('../utils/otp');
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'otp.js'), 'utf8');
    assert.match(source, /crypto\.randomInt/);
    assert.doesNotMatch(source, /Math\.random\(/);
    for (let i = 0; i < 2000; i += 1) assert.match(generateVerificationCode(), /^[1-9][0-9]{5}$/);
  });
});

describe('Frontend helpers (fake window)', () => {
  it('escapeHtml also escapes quotes, so stored text cannot add attributes', () => {
    const context = {};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(FRONTEND, 'js', 'core', 'utils.js'), 'utf8'), context);
    const payload = 'x" autofocus onfocus="alert(1)\' <b>&';
    assert.equal(context.escapeHtml(payload), 'x&quot; autofocus onfocus=&quot;alert(1)&#39; &lt;b&gt;&amp;');
    assert.equal(context.escapeHtml(''), '');
    assert.equal(context.escapeHtml(null), '');
  });

  it('pages at the site root (dashboard.html, admin-dashboard.html) find the pages folder', () => {
    const source = fs.readFileSync(path.join(FRONTEND, 'js', 'core', 'storage.js'), 'utf8');
    const loginFor = pathname => {
      const context = { window: { location: { pathname, origin: 'https://pethub.example' } }, sessionStorage: { getItem: () => null } };
      vm.createContext(context);
      vm.runInContext(`${source}\nthis.__login = PATHS.login;`, context);
      return context.__login;
    };
    for (const pathname of ['/', '/index.html', '/dashboard.html', '/admin-dashboard.html', '/pages/user/dashboard.html']) {
      assert.equal(loginFor(pathname), 'https://pethub.example/pages/auth/login.html', pathname);
    }
    assert.equal(loginFor('/pethub/dashboard.html'), 'https://pethub.example/pethub/pages/auth/login.html');
  });
});
