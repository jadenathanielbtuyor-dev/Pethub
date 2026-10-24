// Security hardening checks: error replies that do not echo internals, the database key the backend chooses, no
// database credentials in the frontend, no passwords in server logs, and passwords saved before hashing never working.
// Request limits are checked in tests/rate-limits.test.js.
// MOCKED: the real Express app with the in-memory database and fake Brevo (helpers/harness.js); no Supabase, Brevo or
// Gemini request leaves the machine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { startTestApp } = require('./helpers/harness');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const { hashPassword, isPasswordHash } = require('../utils/passwordHash');

const newEmail = () => `${crypto.randomUUID()}@example.test`;

// One app per test file: server.js is loaded once per process (helpers/harness.js)
let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

describe('Error replies and logs', () => {

  it('answers malformed JSON with a plain 400 that does not echo the body', async () => {
    const response = await t.api('POST', '/auth/login', {
      rawBody: '{"email": "a@example.test", "password": "Secret#Leak1"',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { success: false, error: 'The request body must be valid JSON.' });
  });

  it('never writes passwords into the server log', async () => {
    const password = `Unique#${crypto.randomBytes(6).toString('hex')}`;
    const email = newEmail();
    await t.api('POST', '/auth/register', { body: { fullname: 'Log Check', email, password, confirm_password: `${password}x` } });
    await t.api('POST', '/auth/login', { body: { email, password } });
    const hashed = t.createUser({ password });
    assert.equal((await t.api('POST', '/auth/login', { body: { email: hashed.email, password } })).status, 200);
    const legacy = t.createUser({ storedPassword: password });
    assert.equal((await t.api('POST', '/auth/login', { body: { email: legacy.email, password } })).status, 403);
    await t.api('POST', '/auth/login', { body: { email: hashed.email, password: `${password}-wrong` } });
    assert.ok(t.logs.length > 0);
    t.logs.forEach(line => assert.ok(!line.includes(password), `a log line contains the password: ${line.slice(0, 80)}`));
  });
});

describe('Contact form limits', () => {
  const { CONTACT_LIMITS } = require('../validators/contactValidator');

  it('stores messages within the limits and refuses longer ones without storing anything', async () => {
    const sender = t.createUser();
    const send = body => t.api('POST', '/contact', { token: sender.token, body });
    const ok = await send({ subject: 'S'.repeat(CONTACT_LIMITS.subject), message: 'M'.repeat(CONTACT_LIMITS.message) });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const before = t.db.table('contact_messages').length;

    const longSubject = await send({ subject: 'S'.repeat(CONTACT_LIMITS.subject + 1), message: 'Hello' });
    assert.equal(longSubject.status, 400);
    assert.match(longSubject.body.error, /Subject must be 120 characters or fewer/);
    const longMessage = await send({ subject: 'Visit', message: 'M'.repeat(CONTACT_LIMITS.message + 1) });
    assert.equal(longMessage.status, 400);
    assert.match(longMessage.body.error, /Message must be 2,000 characters or fewer/);
    const noSubject = await send({ subject: '   ', message: 'Hello' });
    assert.equal(noSubject.status, 400);
    assert.equal(t.db.table('contact_messages').length, before);
  });
});

describe('Passwords saved before hashing', () => {

  it('a plaintext value never logs in, is not echoed and is not written anywhere by the attempt', async () => {
    const user = t.createUser({ storedPassword: 'Plain#Before1' });
    const login = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Plain#Before1' } });
    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'password_reset_required');
    assert.ok(!login.text.includes('Plain#Before1'));
    assert.equal(t.db.find('users', row => row.id === user.id).password, 'Plain#Before1');
    t.logs.forEach(line => assert.ok(!line.includes('Plain#Before1'), line.slice(0, 80)));
  });

  it('only scrypt hashes verify', async () => {
    const { verifyPassword } = require('../utils/passwordHash');
    assert.equal(await verifyPassword('Reset#New1', await hashPassword('Reset#New1')), true);
    assert.equal(await verifyPassword('Plain#Old1', 'Plain#Old1'), false);
    const sha = `sha256$${crypto.createHash('sha256').update('Plain#Old1', 'utf8').digest('hex')}`;
    assert.equal(await verifyPassword('Plain#Old1', sha), false);
    assert.equal(isPasswordHash(`reset-required$${'a'.repeat(64)}`), false);
  });
});

describe('Database key selection (config/env.js)', () => {
  const fakeJwt = role => [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url'),
    'signature'
  ].join('.');

  // Loads config/env.js in a separate process from an empty folder, so backend/.env (real keys) is never read
  function selectedKey(variables) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pethub-env-'));
    try {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake.supabase.invalid', ...variables };
      const script = `const e = require(${JSON.stringify(path.join(BACKEND, 'config', 'env.js'))}); process.stdout.write(JSON.stringify({ name: e.supabase.keyName, role: e.supabase.keyRole }));`;
      const result = spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  function requireConfig(variables) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pethub-env-'));
    try {
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, SUPABASE_URL: 'https://fake.supabase.invalid', ...variables };
      const script = `require(${JSON.stringify(path.join(BACKEND, 'config', 'env.js'))}).requireSupabaseConfig();`;
      return spawnSync(process.execPath, ['-e', script], { cwd, env, encoding: 'utf8' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  it('uses the server-only service role key when it is set', () => {
    assert.deepEqual(selectedKey({ SUPABASE_SERVICE_KEY: fakeJwt('service_role'), SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_SERVICE_KEY', role: 'service_role' });
    assert.deepEqual(selectedKey({ SUPABASE_SERVICE_KEY: 'sb_secret_fake', SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_SERVICE_KEY', role: 'service_role' });
  });

  it('falls back to the public key, and ignores a public key pasted into SUPABASE_SERVICE_KEY', () => {
    assert.deepEqual(selectedKey({ SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_ANON_KEY', role: 'anon' });
    assert.deepEqual(selectedKey({ SUPABASE_SERVICE_KEY: 'sb_publishable_fake', SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_ANON_KEY', role: 'anon' });
    assert.deepEqual(selectedKey({ SUPABASE_SERVICE_KEY: fakeJwt('anon'), SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_ANON_KEY', role: 'anon' });
    assert.deepEqual(selectedKey({ SUPABASE_SERVICE_KEY: 'not-a-recognized-key', SUPABASE_ANON_KEY: 'sb_publishable_fake' }), { name: 'SUPABASE_ANON_KEY', role: 'anon' });
  });

  it('requires a service-role key for production startup', () => {
    const publicKey = requireConfig({ NODE_ENV: 'production', SUPABASE_ANON_KEY: 'sb_publishable_fake' });
    assert.notEqual(publicKey.status, 0);
    assert.match(publicKey.stderr, /Production requires a service-role Supabase key/);
    const serviceKey = requireConfig({ NODE_ENV: 'production', SUPABASE_SERVICE_KEY: fakeJwt('service_role') });
    assert.equal(serviceKey.status, 0, serviceKey.stderr);
  });
});

describe('Frontend holds no database credentials', () => {
  function frontendFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules') return [];
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return frontendFiles(full);
      return /\.(html|js|css|json)$/.test(entry.name) ? [full] : [];
    });
  }

  it('contains no Supabase URL, key or service role reference', () => {
    const offenders = frontendFiles(FRONTEND).filter(file => {
      const text = fs.readFileSync(file, 'utf8');
      return /sb_(publishable|secret)_|service_role|\.supabase\.co\b|eyJhbGciOi|SUPABASE_[A-Z_]*KEY/.test(text);
    });
    assert.deepEqual(offenders.map(file => path.relative(FRONTEND, file)), []);
  });
});
