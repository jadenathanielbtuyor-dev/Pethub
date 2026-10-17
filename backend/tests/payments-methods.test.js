// Checkout payment methods follow what PayMongo reports as configured on the account
// (fake PayMongo; MOCKED, no network). The real test account answered ["qrph"] on 2026-10-17.
const { describe, it, before, after, beforeEach } = require('node:test');
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

function capabilityRequests() {
  return t.paymongo.count('GET', /^\/v1\/merchants\/capabilities\/payment_methods$/);
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

beforeEach(() => {
  t.paymentsService.clearPaymentMethodsCache();
});

describe('Checkout payment methods', () => {
  it('requests only the methods configured on the account (QR Ph only on the current test account)', async () => {
    t.paymongo.paymentMethods = ['qrph'];
    const { response } = await checkoutFor(t.createUser());
    assert.equal(response.status, 201);
    assert.deepEqual(lastCreateRequest().body.data.attributes.payment_method_types, ['qrph']);
  });

  it('keeps PetHub\'s order and leaves out methods PetHub does not offer', async () => {
    t.paymongo.paymentMethods = ['card', 'paymaya', 'qrph', 'gcash'];
    const { response } = await checkoutFor(t.createUser());
    assert.equal(response.status, 201);
    assert.deepEqual(lastCreateRequest().body.data.attributes.payment_method_types, ['gcash', 'qrph', 'card']);
  });

  it('answers "unavailable" without a payment row or session when none of the methods is configured', async () => {
    t.paymongo.paymentMethods = ['paymaya'];
    const before = lastCreateRequest();
    const { appointment, response } = await checkoutFor(t.createUser());
    assert.equal(response.status, 503);
    assert.equal(t.paymentsFor(appointment.id).length, 0);
    assert.equal(lastCreateRequest(), before);
    assert.ok(t.logs.some(line => line.includes('payments.no_supported_payment_methods')));
  });

  it('asks PayMongo once per cache window instead of on every checkout', async () => {
    t.paymongo.paymentMethods = ['qrph', 'card'];
    const user = t.createUser();
    const asked = capabilityRequests();
    assert.equal((await checkoutFor(user)).response.status, 201);
    assert.equal((await checkoutFor(user)).response.status, 201);
    assert.equal(capabilityRequests() - asked, 1);
  });

  it('still opens checkout when the lookup fails, and does not ask again on every request', async () => {
    t.paymongo.failNext({ method: 'GET', path: /capabilities/, status: 500 });
    const user = t.createUser();
    const asked = capabilityRequests();
    const { response } = await checkoutFor(user);
    assert.equal(response.status, 201);
    // With no list known yet, PetHub's full list is sent and PayMongo filters it
    assert.deepEqual(lastCreateRequest().body.data.attributes.payment_method_types, ['gcash', 'qrph', 'card']);
    assert.ok(t.logs.some(line => line.includes('payments.payment_methods_check_failed')));

    assert.equal((await checkoutFor(user)).response.status, 201);
    assert.equal(capabilityRequests() - asked, 1, 'the failure is cached briefly instead of retried per checkout');
  });
});
