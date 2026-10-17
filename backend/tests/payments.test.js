// Automated tests for the PayMongo deposit flow against the real Express app, a fake Supabase and a fake PayMongo.
// No network access and no real charges. Real sandbox checks live in paymongo.sandbox.test.js (opt-in).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestApp } = require('./helpers/harness');

let t;
let slotCounter = 0;

// Each test books its own day so schedule checks never interfere with each other
function nextDay() {
  slotCounter += 1;
  return 10 + slotCounter;
}

function createRequests(appointmentId) {
  return t.paymongo.requests.filter(request => (
    request.method === 'POST' &&
    request.path === '/v1/checkout_sessions' &&
    request.body?.data?.attributes?.metadata?.pethub_appointment_id === appointmentId
  ));
}

async function checkout(user, appointmentId, body = {}) {
  return t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointmentId, ...body } });
}

async function depositStatus(user, appointmentId) {
  return t.api('GET', `/payments/appointment/${appointmentId}`, { token: user.token });
}

function onlyRow(appointmentId) {
  const rows = t.paymentsFor(appointmentId);
  assert.equal(rows.length, 1, 'expected exactly one payment row');
  return rows[0];
}

async function payAndNotify(appointmentId, options = {}) {
  const row = t.paymentsFor(appointmentId).find(item => item.payment_status === 'Pending');
  const payment = t.paymongo.pay(row.provider_checkout_session_id, options);
  const response = await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
  assert.equal(response.status, 200);
  return { row, payment };
}

async function setStatusVia(endpoint, admin, appointmentId, status) {
  if (endpoint === 'admin') {
    return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id: appointmentId, status } });
  }
  return t.api('PUT', '/appointments/updateStatus', { token: admin.token, body: { id: appointmentId, status, user_id: admin.id } });
}

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

describe('POST /payments/checkout', () => {
  it('requires a signed-in user', async () => {
    const response = await t.api('POST', '/payments/checkout', { body: { appointment_id: crypto.randomUUID() } });
    assert.equal(response.status, 401);
  });

  it('requires a verified account', async () => {
    const user = t.createUser({ verified: false });
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    const response = await checkout(user, appointment.id);
    assert.equal(response.status, 403);
    assert.equal(t.paymentsFor(appointment.id).length, 0);
  });

  it('creates one PayMongo session with the server-side ₱100 amount and ignores browser-sent amount/status', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });

    const response = await checkout(user, appointment.id, { amount: 1, payment_status: 'Paid', status: 'paid' });
    assert.equal(response.status, 201);
    assert.match(response.body.checkout_url, /^https:\/\/checkout\.paymongo\.com\//);
    assert.equal(response.body.amount, 100);
    assert.equal(response.body.currency, 'PHP');
    assert.equal(response.body.status, 'pending');

    const row = onlyRow(appointment.id);
    assert.equal(row.id, response.body.payment_id);
    assert.equal(Number(row.amount), 100);
    assert.equal(row.payment_status, 'Pending');
    assert.equal(row.user_id, user.id);
    assert.match(row.provider_checkout_session_id, /^cs_/);
    const windowMinutes = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60000;
    assert.equal(windowMinutes, 30);

    const [request] = createRequests(appointment.id);
    const attributes = request.body.data.attributes;
    assert.equal(request.authorized, true);
    assert.equal(request.idempotencyKey, row.id);
    assert.deepEqual(attributes.line_items, [{ name: 'Appointment deposit', amount: 10000, currency: 'PHP', quantity: 1 }]);
    assert.deepEqual(attributes.payment_method_types, ['gcash', 'qrph', 'card']);
    assert.equal(attributes.reference_number, row.id);
    assert.deepEqual(attributes.metadata, { pethub_payment_id: row.id, pethub_appointment_id: appointment.id });
    assert.equal(
      attributes.success_url,
      `https://pethub-frontend.test/pages/user/appointments.html?payment=return&appointment_id=${appointment.id}`
    );
    assert.match(attributes.cancel_url, /payment=cancelled/);

    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('resumes the same open session for repeated requests', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });

    const first = await checkout(user, appointment.id);
    const second = await checkout(user, appointment.id);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.checkout_url, first.body.checkout_url);
    assert.equal(second.body.payment_id, first.body.payment_id);
    assert.equal(createRequests(appointment.id).length, 1);
    assert.equal(t.paymentsFor(appointment.id).length, 1);
  });

  it('opens only one session when requests arrive at the same time', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });

    const responses = await Promise.all([1, 2, 3, 4].map(() => checkout(user, appointment.id)));
    const succeeded = responses.filter(response => response.status === 200 || response.status === 201);
    assert.ok(succeeded.length >= 1, 'at least one request opens the checkout');
    responses.filter(response => !succeeded.includes(response)).forEach(response => assert.equal(response.status, 409));
    assert.equal(new Set(succeeded.map(response => response.body.checkout_url)).size, 1);
    assert.equal(createRequests(appointment.id).length, 1);
    assert.equal(t.paymentsFor(appointment.id).filter(row => row.payment_status === 'Pending').length, 1);
  });

  it("answers another user's appointment as not found", async () => {
    const owner = t.createUser();
    const stranger = t.createUser();
    const appointment = t.createAppointment(owner, { daysAhead: nextDay() });

    const response = await checkout(stranger, appointment.id);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'Appointment not found');
    assert.equal(t.paymentsFor(appointment.id).length, 0);
  });

  it('refuses appointments that do not need a deposit (booked before launch)', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });

    const response = await checkout(user, appointment.id);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, 'This appointment does not need a deposit.');
    assert.equal(createRequests(appointment.id).length, 0);
  });

  it('refuses cancelled appointments', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), status: 'Cancelled' });

    const response = await checkout(user, appointment.id);
    assert.equal(response.status, 409);
    assert.equal(createRequests(appointment.id).length, 0);
  });

  it('refuses when an approved appointment already holds the slot', async () => {
    const day = nextDay();
    const user = t.createUser();
    const other = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: day, time: '10:00:00' });
    t.createAppointment(other, { daysAhead: day, time: '10:30:00', status: 'Approved', depositRequired: false });

    const response = await checkout(user, appointment.id);
    assert.equal(response.status, 409);
    assert.match(response.body.error, /no longer available/);
    assert.equal(t.paymentsFor(appointment.id).length, 0);
  });

  it('rejects malformed and unknown appointment ids', async () => {
    const user = t.createUser();
    assert.equal((await checkout(user, 'not a valid id!')).status, 400);
    assert.equal((await checkout(user, 'abc-123')).status, 404);
    assert.equal((await t.api('POST', '/payments/checkout', { token: user.token, body: {} })).status, 400);
  });

  it('does not hand out a session whose payment could not be verified', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id, { amount: 5000 });

    const response = await checkout(user, appointment.id);
    assert.equal(response.status, 409);
    assert.equal(response.body.checkout_url, undefined);
    assert.equal(row.payment_status, 'Pending');
    assert.ok(t.logs.some(line => line.includes('payments.provider_payment_mismatch')));
  });

  it('reports a provider failure, closes the unused row, and allows a retry', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });

    t.paymongo.failNext({ method: 'POST', path: /^\/v1\/checkout_sessions$/, status: 500 });
    const failed = await checkout(user, appointment.id);
    assert.equal(failed.status, 502);
    assert.equal(onlyRow(appointment.id).payment_status, 'Failed');

    const retried = await checkout(user, appointment.id);
    assert.equal(retried.status, 201);
    assert.equal(t.paymentsFor(appointment.id).filter(row => row.payment_status === 'Pending').length, 1);
  });
});

describe('GET /payments/appointment/:appointmentId', () => {
  it('is only available to the appointment owner', async () => {
    const owner = t.createUser();
    const stranger = t.createUser();
    const appointment = t.createAppointment(owner, { daysAhead: nextDay() });

    assert.equal((await t.api('GET', `/payments/appointment/${appointment.id}`)).status, 401);
    const response = await depositStatus(stranger, appointment.id);
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'Appointment not found');
  });

  it('does not treat the checkout redirect as payment', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);

    const response = await t.api('GET', `/payments/appointment/${appointment.id}?payment=return&status=paid`, { token: user.token });
    assert.equal(response.status, 200);
    assert.equal(response.body.deposit.status, 'pending');
    assert.equal(response.body.deposit.can_pay, true);
    assert.equal(onlyRow(appointment.id).payment_status, 'Pending');
  });

  it('confirms a payment directly with PayMongo when the webhook has not arrived', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    const payment = t.paymongo.pay(row.provider_checkout_session_id, { methodType: 'card' });

    const response = await depositStatus(user, appointment.id);
    assert.equal(response.body.deposit.status, 'paid');
    assert.equal(response.body.deposit.payment_method, 'card');
    assert.equal(onlyRow(appointment.id).provider_payment_id, payment.id);
    // Paying never approves the appointment
    assert.equal(response.body.appointment_status, 'Pending');
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('closes a checkout after its 30 minutes once PayMongo confirms the session expired, then allows a new one', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    row.expires_at = new Date(Date.now() - 60 * 1000).toISOString();

    const response = await depositStatus(user, appointment.id);
    assert.equal(response.body.deposit.status, 'unpaid');
    assert.equal(response.body.deposit.last_checkout_status, 'expired');
    assert.equal(row.payment_status, 'Expired');
    assert.equal(t.paymongo.sessions.get(row.provider_checkout_session_id).status, 'expired');

    const retry = await checkout(user, appointment.id);
    assert.equal(retry.status, 201);
    assert.notEqual(retry.body.payment_id, row.id);
  });

  it('keeps an overdue checkout open while PayMongo is still processing, and records the late payment', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    row.expires_at = new Date(Date.now() - 60 * 1000).toISOString();
    t.paymongo.setOngoingPayment(row.provider_checkout_session_id, true);

    const during = await depositStatus(user, appointment.id);
    assert.equal(during.body.deposit.status, 'pending');
    assert.equal(row.payment_status, 'Pending');
    const blocked = await checkout(user, appointment.id);
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /still being processed/);

    t.paymongo.pay(row.provider_checkout_session_id);
    await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
    assert.equal(row.payment_status, 'Paid');

    const after = await depositStatus(user, appointment.id);
    assert.equal(after.body.deposit.status, 'paid');
    assert.equal(after.body.deposit.late_payment, true);
  });
});

describe('POST /payments/webhook', () => {
  it('records a verified payment once; duplicate deliveries change nothing', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    const payment = t.paymongo.pay(row.provider_checkout_session_id);
    const event = t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id);

    const first = await t.sendWebhook(event);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { received: true });
    assert.equal(row.payment_status, 'Paid');
    assert.equal(row.provider_payment_id, payment.id);
    assert.equal(row.payment_method, 'gcash');
    const paidAt = row.paid_at;

    const duplicate = await t.sendWebhook(event);
    assert.equal(duplicate.status, 200);
    assert.equal(row.payment_status, 'Paid');
    assert.equal(row.paid_at, paidAt);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('rejects invalid signatures without touching the database', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id);
    const event = t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id);
    const rawBody = JSON.stringify(event);

    const attempts = [
      { secret: `whsk_${crypto.randomBytes(8).toString('hex')}` },
      { signatureHeader: null },
      { signatureHeader: 'not-a-signature' },
      { signatureHeader: t.signWebhook(rawBody, { slot: 'li' }) },
      { rawBody: rawBody.replace('"amount":10000', '"amount":10001'), signatureHeader: t.signWebhook(rawBody) }
    ];

    for (const attempt of attempts) {
      const response = await t.sendWebhook(event, attempt);
      assert.equal(response.status, 400);
      assert.equal(row.payment_status, 'Pending');
    }
  });

  it('does not record events whose amount, currency, mode, metadata or ids do not match', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id);

    const mutations = [
      resource => { resource.attributes.payments[0].attributes.amount = 5000; },
      resource => { resource.attributes.payments[0].attributes.currency = 'USD'; },
      resource => { resource.attributes.payments[0].attributes.livemode = true; },
      resource => { resource.attributes.metadata.pethub_payment_id = crypto.randomUUID(); },
      resource => { resource.attributes.metadata.pethub_appointment_id = crypto.randomUUID(); },
      resource => { resource.attributes.reference_number = 'someone-else'; },
      resource => { resource.id = 'cs_fakeSomeOtherSession'; },
      resource => { resource.attributes.payments[0].attributes.status = 'failed'; }
    ];

    for (const mutate of mutations) {
      const response = await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id, { mutate }));
      assert.equal(response.status, 200);
      assert.equal(row.payment_status, 'Pending');
    }

    const liveEvent = await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id, { livemode: true }));
    assert.equal(liveEvent.status, 200);
    assert.equal(row.payment_status, 'Pending');
    assert.ok(t.logs.some(line => line.includes('payments.webhook_mismatch')));

    const genuine = await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
    assert.equal(genuine.status, 200);
    assert.equal(row.payment_status, 'Paid');
  });

  it('records a payment that arrives after the checkout was closed locally', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    row.payment_status = 'Expired';
    t.paymongo.pay(row.provider_checkout_session_id);

    const response = await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
    assert.equal(response.status, 200);
    assert.equal(row.payment_status, 'Paid');
    assert.ok(t.logs.some(line => line.includes('payments.late_payment_recorded')));
  });

  it('acknowledges unrelated and unknown events without changes', async () => {
    const otherType = t.paymongo.event('payment.failed', { id: 'pay_fakeUnrelated', type: 'payment', attributes: { status: 'failed' } });
    assert.equal((await t.sendWebhook(otherType)).status, 200);

    const unknownSession = t.paymongo.event('checkout_session.payment.paid', {
      id: 'cs_fakeNotPetHub',
      type: 'checkout_session',
      attributes: { metadata: {}, payments: [], livemode: false }
    });
    assert.equal((await t.sendWebhook(unknownSession)).status, 200);
    assert.ok(t.logs.some(line => line.includes('payments.webhook_unmatched')));

    assert.equal((await t.sendWebhook(null, { rawBody: '{"not":"an event"}' })).status, 400);
  });

  it('marks a full refund as Refunded, ignores partial and duplicate refunds, and retries refunds that arrive first', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const { payment, row } = await payAndNotify(appointment.id);
    assert.equal(row.payment_status, 'Paid');

    assert.equal((await t.sendWebhook(t.paymongo.refundSucceededEvent(payment.id, { amount: 5000 }))).status, 200);
    assert.equal(row.payment_status, 'Paid');

    const fullRefund = t.paymongo.refundSucceededEvent(payment.id);
    assert.equal((await t.sendWebhook(fullRefund)).status, 200);
    assert.equal(row.payment_status, 'Refunded');
    assert.equal((await t.sendWebhook(fullRefund)).status, 200);
    assert.equal(row.payment_status, 'Refunded');

    const early = await t.sendWebhook(t.paymongo.refundSucceededEvent('pay_fakeNotRecordedYet'));
    assert.equal(early.status, 503);
    const stale = await t.sendWebhook(t.paymongo.refundSucceededEvent('pay_fakeNotRecordedYet', {
      createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000)
    }));
    assert.equal(stale.status, 200);

    // A newer "paid" delivery never moves a refunded payment back
    assert.equal((await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id))).status, 200);
    assert.equal(row.payment_status, 'Refunded');
  });

  it('returns a retryable error when the payment cannot be stored, then succeeds on redelivery', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id);
    const event = t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id);

    t.db.failNext({ table: 'payments', action: 'update' }, { code: 'XX000', message: 'simulated outage' });
    const failed = await t.sendWebhook(event);
    assert.equal(failed.status, 500);
    assert.equal(row.payment_status, 'Pending');

    const redelivered = await t.sendWebhook(event);
    assert.equal(redelivered.status, 200);
    assert.equal(row.payment_status, 'Paid');
  });
});

describe('Approval rules on both status endpoints', () => {
  for (const endpoint of ['admin', 'legacy']) {
    it(`${endpoint}: blocks approval while the deposit is unpaid`, async () => {
      const admin = t.createUser({ role: 'admin' });
      const user = t.createUser();
      const appointment = t.createAppointment(user, { daysAhead: nextDay() });

      const response = await setStatusVia(endpoint, admin, appointment.id, 'Approved');
      assert.equal(response.status, 409);
      assert.equal(response.body.deposit_required, true);
      assert.equal(response.body.deposit_status, 'unpaid');
      assert.match(response.body.error, /deposit/);
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
    });

    it(`${endpoint}: approves only after payment, and payment alone never approves`, async () => {
      const admin = t.createUser({ role: 'admin' });
      const user = t.createUser();
      const appointment = t.createAppointment(user, { daysAhead: nextDay() });
      await checkout(user, appointment.id);
      await payAndNotify(appointment.id);
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');

      const response = await setStatusVia(endpoint, admin, appointment.id, 'Approved');
      assert.equal(response.status, 200);
      assert.equal(t.appointmentRow(appointment.id).status, 'Approved');
    });

    it(`${endpoint}: a paid appointment whose slot is taken returns 409 with refund_required`, async () => {
      const day = nextDay();
      const admin = t.createUser({ role: 'admin' });
      const user = t.createUser();
      const other = t.createUser();
      const appointment = t.createAppointment(user, { daysAhead: day, time: '10:00:00' });
      await checkout(user, appointment.id);
      await payAndNotify(appointment.id);
      t.createAppointment(other, { daysAhead: day, time: '10:15:00', status: 'Approved', depositRequired: false });

      const response = await setStatusVia(endpoint, admin, appointment.id, 'Approved');
      assert.equal(response.status, 409);
      assert.equal(response.body.refund_required, true);
      assert.equal(response.body.deposit_status, 'paid');
      assert.match(response.body.error, /refund/);
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');

      const adminList = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
      const listed = adminList.body.appointments.find(item => item.id === appointment.id);
      assert.equal(listed.deposit.status, 'paid');
      assert.equal(listed.deposit.slot_conflict, true);
      assert.equal(listed.deposit.refund_required, true);

      const cancelled = await setStatusVia(endpoint, admin, appointment.id, 'Cancelled');
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.refund_required, true);

      const userList = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
      const own = userList.body.appointments.find(item => item.id === appointment.id);
      assert.equal(own.deposit.status, 'paid');
      assert.equal(own.deposit.refund_required, true);
      assert.equal(own.deposit.can_pay, false);
    });
  }

  it('cancelling closes an open checkout at PayMongo', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);

    const response = await setStatusVia('admin', admin, appointment.id, 'Cancelled');
    assert.equal(response.status, 200);
    assert.equal(response.body.refund_required, undefined);
    assert.equal(row.payment_status, 'Expired');
    assert.equal(t.paymongo.sessions.get(row.provider_checkout_session_id).status, 'expired');
    assert.equal((await checkout(user, appointment.id)).status, 409);
  });

  it('approval confirms an open checkout with PayMongo before deciding', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = onlyRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id);

    const response = await setStatusVia('admin', admin, appointment.id, 'Approved');
    assert.equal(response.status, 200);
    assert.equal(row.payment_status, 'Paid');
    assert.equal(t.appointmentRow(appointment.id).status, 'Approved');
  });

  it('keeps the existing approve, complete, cancel and conflict behaviour for exempt appointments', async () => {
    const day = nextDay();
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const first = t.createAppointment(user, { daysAhead: day, time: '09:00:00', depositRequired: false });
    const overlapping = t.createAppointment(user, { daysAhead: day, time: '09:30:00', depositRequired: false });
    const another = t.createAppointment(user, { daysAhead: day, time: '14:00:00', depositRequired: false });

    assert.equal((await setStatusVia('admin', admin, first.id, 'Approved')).status, 200);
    const conflictResponse = await setStatusVia('legacy', admin, overlapping.id, 'Approved');
    assert.equal(conflictResponse.status, 409);
    assert.equal(conflictResponse.body.error, 'Selected time is unavailable.');
    assert.equal(conflictResponse.body.refund_required, undefined);
    assert.equal((await setStatusVia('legacy', admin, first.id, 'Completed')).status, 200);
    assert.equal((await setStatusVia('admin', admin, first.id, 'Approved')).status, 400);
    assert.equal((await setStatusVia('admin', admin, another.id, 'Cancelled')).status, 200);
    assert.equal(t.appointmentRow(first.id).status, 'Completed');
    assert.equal(t.appointmentRow(another.id).status, 'Cancelled');
  });

  it('refuses non-admins on both status endpoints', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });
    assert.equal((await setStatusVia('admin', user, appointment.id, 'Approved')).status, 403);
    assert.equal((await setStatusVia('legacy', user, appointment.id, 'Approved')).status, 403);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('reports a concurrent status change instead of overwriting it', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });

    t.db.interceptNext({ table: 'appointments', action: 'update' }, (query, database) => {
      database.find('appointments', row => row.id === appointment.id).status = 'Cancelled';
    });
    const response = await setStatusVia('admin', admin, appointment.id, 'Approved');
    assert.equal(response.status, 409);
    assert.match(response.body.error, /changed by someone else/);
    assert.equal(t.appointmentRow(appointment.id).status, 'Cancelled');
  });
});

describe('Booking and appointment lists', () => {
  it('marks new bookings as needing the deposit', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const response = await t.api('POST', '/appointments/create', {
      token: user.token,
      body: {
        user_id: user.id,
        pet_id: pet.id,
        pet_name: pet.name,
        service_type: 'Checkup',
        appointment_date: t.manilaDate(nextDay() + 40),
        appointment_time: '09:00:00'
      }
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.appointment.status, 'Pending');
    assert.equal(response.body.deposit.required, true);
    assert.equal(response.body.deposit.amount, 100);
    assert.equal(response.body.deposit.can_pay, true);
    assert.equal(t.appointmentRow(response.body.appointment.id).deposit_required, true);
  });

  it('shows deposit state in the user list and the admin lists', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const exempt = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });
    const due = t.createAppointment(user, { daysAhead: nextDay() });
    const paid = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, paid.id);
    await payAndNotify(paid.id);

    const userList = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(userList.status, 200);
    const byId = Object.fromEntries(userList.body.appointments.map(item => [item.id, item.deposit]));
    assert.equal(byId[exempt.id].status, 'not_required');
    assert.equal(byId[due.id].status, 'unpaid');
    assert.equal(byId[due.id].can_pay, true);
    assert.equal(byId[paid.id].status, 'paid');
    assert.equal(byId[paid.id].can_pay, false);

    const adminList = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.appointments.find(item => item.id === due.id).deposit.status, 'unpaid');

    const overview = await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.appointments.find(item => item.id === paid.id).deposit.status, 'paid');
  });
});

describe('Booking with the deposit (booking form -> checkout)', () => {
  function bookingBody(user, pet, fields = {}) {
    return {
      user_id: user.id,
      pet_id: pet.id,
      pet_name: pet.name,
      service_type: 'Checkup',
      appointment_date: t.manilaDate(nextDay() + 100),
      appointment_time: '14:00:00',
      ...fields
    };
  }

  function book(user, body) {
    return t.api('POST', '/appointments/create', { token: user.token, body });
  }

  function appointmentsOf(user) {
    return t.db.table('appointments').filter(row => row.user_id === user.id);
  }

  it('validates the booking on the server and creates nothing when it is refused', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const stranger = t.createUser();
    const strangersPet = t.createPet(stranger, 'Kuro');
    const body = bookingBody(user, pet);

    assert.equal((await book(user, { ...body, service_type: '' })).status, 400);
    assert.equal((await book(user, { ...body, service_type: 'Massage' })).status, 400);
    assert.equal((await book(user, { ...body, appointment_date: t.manilaDate(-1) })).status, 400);
    assert.equal((await book(user, { ...body, pet_id: strangersPet.id, pet_name: strangersPet.name })).status, 404);
    assert.equal((await book(user, { ...body, user_id: stranger.id })).status, 403);

    const unverified = t.createUser({ verified: false });
    const unverifiedPet = t.createPet(unverified);
    assert.equal((await book(unverified, bookingBody(unverified, unverifiedPet))).status, 403);

    // An approved appointment holds 14:00-14:45, so 14:30 is refused with the next free time
    t.createAppointment(stranger, { pet: strangersPet, daysAhead: 0, status: 'Approved', depositRequired: false });
    const taken = t.db.table('appointments').at(-1);
    Object.assign(taken, { appointment_date: body.appointment_date, appointment_time: '14:00:00' });
    const conflict = await book(user, { ...body, appointment_time: '14:30:00' });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.suggested_time, '14:45');

    assert.equal(appointmentsOf(user).length, 0);
    assert.equal(appointmentsOf(unverified).length, 0);
  });

  it('ignores an amount, payment status or deposit flag sent by the browser', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const response = await book(user, { ...bookingBody(user, pet), amount: 1, payment_status: 'Paid', deposit_required: false, status: 'Approved' });

    assert.equal(response.status, 201);
    assert.equal(response.body.appointment.status, 'Pending');
    assert.equal(response.body.deposit.amount, 100);
    assert.equal(response.body.deposit.status, 'unpaid');
    assert.equal(t.appointmentRow(response.body.appointment.id).deposit_required, true);
    assert.equal(t.paymentsFor(response.body.appointment.id).length, 0);
  });

  it('sending the same booking again returns the existing appointment, and its checkout resumes the same session', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const body = bookingBody(user, pet);

    const first = await book(user, body);
    assert.equal(first.status, 201);
    const appointmentId = first.body.appointment.id;
    const firstCheckout = await checkout(user, appointmentId);
    assert.equal(firstCheckout.status, 201);

    // e.g. Back from PayMongo or a refresh, then "Continue to Secure Payment" again (time sent without seconds)
    const again = await book(user, { ...body, appointment_time: '14:00' });
    assert.equal(again.status, 200);
    assert.equal(again.body.already_booked, true);
    assert.equal(again.body.appointment.id, appointmentId);
    assert.equal(again.body.deposit.status, 'pending');
    assert.equal(again.body.deposit.can_pay, true);
    assert.equal(appointmentsOf(user).length, 1);

    const resumed = await checkout(user, appointmentId);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.checkout_url, firstCheckout.body.checkout_url);
    assert.equal(createRequests(appointmentId).length, 1);
    assert.equal(t.paymentsFor(appointmentId).length, 1);
  });

  it('a booking sent again after its deposit was paid is returned as paid, with nothing left to pay', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const body = bookingBody(user, pet);
    const first = await book(user, body);
    await checkout(user, first.body.appointment.id);
    await payAndNotify(first.body.appointment.id);

    const again = await book(user, body);
    assert.equal(again.status, 200);
    assert.equal(again.body.appointment.id, first.body.appointment.id);
    assert.equal(again.body.deposit.status, 'paid');
    assert.equal(again.body.deposit.can_pay, false);
    assert.equal((await checkout(user, first.body.appointment.id)).status, 409);
    assert.equal(appointmentsOf(user).length, 1);
    assert.equal(t.appointmentRow(first.body.appointment.id).status, 'Pending');
  });

  it('a different pet, service or time, or a booking whose earlier copy was cancelled, is a new appointment', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const pet = t.createPet(user);
    const otherPet = t.createPet(user, 'Kuro');
    const body = bookingBody(user, pet);

    const first = await book(user, body);
    assert.equal(first.status, 201);
    assert.equal((await book(user, { ...body, pet_id: otherPet.id, pet_name: otherPet.name })).status, 201);
    assert.equal((await book(user, { ...body, service_type: 'Grooming' })).status, 201);
    assert.equal((await book(user, { ...body, appointment_time: '16:00:00' })).status, 201);

    const cancelled = await setStatusVia('admin', admin, first.body.appointment.id, 'Cancelled');
    assert.equal(cancelled.status, 200);
    const rebooked = await book(user, body);
    assert.equal(rebooked.status, 201);
    assert.notEqual(rebooked.body.appointment.id, first.body.appointment.id);
    assert.equal(appointmentsOf(user).length, 5);
  });
});

describe('Expiry sweep', () => {
  it('closes overdue checkouts, fails never-linked rows, and leaves fresh checkouts open', async () => {
    const user = t.createUser();
    const overdue = t.createAppointment(user, { daysAhead: nextDay() });
    const fresh = t.createAppointment(user, { daysAhead: nextDay() });
    const unlinked = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, overdue.id);
    await checkout(user, fresh.id);
    onlyRow(overdue.id).expires_at = new Date(Date.now() - 60 * 1000).toISOString();
    t.db.seed('payments', {
      appointment_id: unlinked.id,
      user_id: user.id,
      amount: 100,
      payment_status: 'Pending',
      created_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    });

    const result = await t.paymentsService.runExpirySweep();
    assert.ok(result.checked >= 2);
    assert.equal(onlyRow(overdue.id).payment_status, 'Expired');
    assert.equal(onlyRow(fresh.id).payment_status, 'Pending');
    assert.equal(onlyRow(unlinked.id).payment_status, 'Failed');
  });
});

describe('Secrets stay out of logs and responses', () => {
  it('never logs keys, signatures, checkout URLs or raw webhook bodies', () => {
    const allLogs = t.logs.join('\n');
    assert.ok(t.logs.length > 0);
    assert.ok(!allLogs.includes(t.secrets.paymongoSecretKey));
    assert.ok(!allLogs.includes(t.secrets.webhookSecret));
    assert.ok(!allLogs.includes(Buffer.from(`${t.secrets.paymongoSecretKey}:`).toString('base64')));
    assert.ok(!allLogs.includes('checkout.paymongo.com'));
    assert.ok(!allLogs.includes('pethub_payment_id'));
    assert.ok(!/te=[0-9a-f]{64}/.test(allLogs));
  });
});

describe('Verified schema', () => {
  it('runs every payment flow above, the expiry sweep included, without a missing-column report', () => {
    assert.ok(!t.logs.some(line => line.includes('payments.schema_missing')));
  });
});
