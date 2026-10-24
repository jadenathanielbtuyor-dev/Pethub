// Request limits on the public endpoints (middleware/rateLimit.js, constants/rateLimits.js) with the real limits, and
// client address handling behind Railway's single proxy hop (server.js trusts one hop).
// MOCKED: the real Express app with the in-memory database and fake Brevo (helpers/harness.js); nothing leaves the machine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestApp } = require('./helpers/harness');
const { RATE_LIMITS } = require('../constants/rateLimits');

const newEmail = () => `${crypto.randomUUID()}@example.test`;

describe('Request limits on public endpoints', () => {
  let t;
  before(async () => { t = await startTestApp({ realRateLimits: true }); });
  after(async () => { await t.close(); });

  it('stops repeated logins from one address with 429 and Retry-After, without touching other limits', async () => {
    const body = { email: newEmail(), password: 'Wrong#Pass1' };
    const headers = { 'X-Forwarded-For': '198.51.100.10' };
    for (let i = 0; i < RATE_LIMITS.login.max; i += 1) {
      assert.equal((await t.api('POST', '/auth/login', { body, headers })).status, 403);
    }
    const blocked = await t.api('POST', '/auth/login', { body, headers });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.success, false);
    assert.match(blocked.body.error, /^Too many attempts\. Please wait \d+ minutes? and try again\.$/);

    // Another address still gets through, and the same address can still use a different endpoint
    assert.equal((await t.api('POST', '/auth/login', { body, headers: { 'X-Forwarded-For': '198.51.100.11' } })).status, 403);
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: body.email }, headers })).status, 200);
  });

  it('counts only the address added by the proxy, not addresses a client writes into X-Forwarded-For itself', async () => {
    for (let i = 0; i < RATE_LIMITS.forgotPassword.max; i += 1) {
      const spoofed = { 'X-Forwarded-For': `203.0.113.${i}, 198.51.100.20` };
      assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: newEmail() }, headers: spoofed })).status, 200);
    }
    // A new first entry does not help: the proxy's own entry (the last one) is the same address
    const blocked = await fetch(`${t.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.250, 198.51.100.20' },
      body: JSON.stringify({ email: newEmail() })
    });
    assert.equal(blocked.status, 429);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= RATE_LIMITS.forgotPassword.windowMinutes * 60, `Retry-After ${retryAfter}`);
  });

  it('limits registration, verification codes and the chatbot', async () => {
    const cases = [
      ['register', '/auth/register', () => ({ fullname: 'Limit Test', email: 'not-an-email' })],
      ['verifyEmail', '/auth/verify-email', () => ({ email: newEmail(), code: '000000' })],
      ['resendCode', '/auth/resend-code', () => ({ email: newEmail() })],
      ['resetPassword', '/auth/reset-password', () => ({ email: newEmail(), code: '000000', password: 'New#Pass123' })],
      ['aiChat', '/ai/chat', () => ({ message: 'how do i add a pet' })]
    ];
    for (const [name, route, makeBody] of cases) {
      const headers = { 'X-Forwarded-For': `192.0.2.${cases.findIndex(entry => entry[0] === name) + 1}` };
      for (let i = 0; i < RATE_LIMITS[name].max; i += 1) {
        assert.notEqual((await t.api('POST', route, { body: makeBody(), headers })).status, 429, `${name} request ${i + 1}`);
      }
      assert.equal((await t.api('POST', route, { body: makeBody(), headers })).status, 429, `${name} over the limit`);
    }
    assert.deepEqual(t.blockedRequests, []);
  });

  it('limits contact messages per account (sending one requires signing in)', async () => {
    const sender = t.createUser();
    const other = t.createUser();
    const send = (user, headers = {}) => t.api('POST', '/contact', { token: user.token, body: { subject: '', message: '' }, headers });
    for (let i = 0; i < RATE_LIMITS.contact.max; i += 1) {
      assert.notEqual((await send(sender, { 'X-Forwarded-For': `198.51.100.${i + 1}` })).status, 429, `contact request ${i + 1}`);
    }
    assert.equal((await send(sender, { 'X-Forwarded-For': '198.51.100.200' })).status, 429, 'a new address does not reset the account limit');
    assert.equal((await send(other)).status, 400, 'another account is not limited');
    assert.equal((await t.api('POST', '/contact', { body: { subject: 'Hi', message: 'Hi' } })).status, 401, 'signed-out visitors are refused before the limit');
  });

  it('limits booking requests per account, not per address, and creates nothing while refusing', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const before = t.db.table('appointments').length;
    const book = user => t.api('POST', '/appointments/create', { token: user.token, body: {} });
    for (let i = 0; i < RATE_LIMITS.booking.max; i += 1) {
      assert.notEqual((await book(owner)).status, 429, `booking request ${i + 1}`);
    }
    assert.equal((await book(owner)).status, 429, 'over the limit');
    assert.notEqual((await book(other)).status, 429, 'another account on the same address is still served');
    assert.equal(t.db.table('appointments').length, before);
  });

  it('does not log client addresses or request bodies when it blocks', async () => {
    const blockedLines = t.logs.filter(line => line.includes('rate_limit.blocked'));
    assert.ok(blockedLines.length > 0);
    blockedLines.forEach(line => {
      assert.doesNotMatch(line, /198\.51\.100|203\.0\.113|192\.0\.2|Wrong#Pass1|example\.test/);
    });
  });
});
