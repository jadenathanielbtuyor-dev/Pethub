// Checkout payment methods (fake PayMongo; MOCKED, no network). Every checkout offers card and GCash, which test mode
// simulates (test cards, GCash's Authorize/Fail page). QR Ph is never requested: test-mode QR Ph codes are real.
// The real test account's capabilities endpoint answered ["qrph"], yet a sandbox check on 2026-10-18 showed test-mode
// sessions accepting and showing card and GCash, so that endpoint no longer filters the list.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let slotCounter = 0;

function nextDay() {
  slotCounter += 1;
  return 10 + slotCounter;
}

function lastCreateRequest() {
  return t.paymongo.requests.filter(request => request.method === 'POST' && request.path === '/v1/checkout_sessions').pop();
}

async function checkoutFor(user) {
  const appointment = t.createAppointment(user, { daysAhead: nextDay() });
  const response = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointment.id } });
  return { appointment, response };
}

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

describe('Checkout payment methods', () => {
  it('offers card and GCash on every checkout, and never QR Ph', async () => {
    const { response } = await checkoutFor(t.createUser());
    assert.equal(response.status, 201);
    assert.deepEqual(lastCreateRequest().body.data.attributes.payment_method_types, ['card', 'gcash']);
  });

  it('opens checkout without asking the account capabilities endpoint', async () => {
    const user = t.createUser();
    assert.equal((await checkoutFor(user)).response.status, 201);
    assert.equal((await checkoutFor(user)).response.status, 201);
    assert.equal(t.paymongo.requests.filter(request => request.path.includes('capabilities')).length, 0);
  });

  it('reports a provider refusal of the checkout as unavailable, without a usable payment row', async () => {
    t.paymongo.failNext({ method: 'POST', path: /^\/v1\/checkout_sessions$/, status: 400, code: 'parameter_invalid' });
    const { appointment, response } = await checkoutFor(t.createUser());
    assert.equal(response.status, 502);
    assert.ok(t.paymentsFor(appointment.id).every(row => row.payment_status === 'Failed'));
    assert.ok(t.logs.some(line => line.includes('payments.checkout_create_failed') && line.includes('parameter_invalid')));
  });
});
