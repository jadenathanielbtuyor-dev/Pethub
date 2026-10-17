// Unsafe or incomplete configuration: a live PayMongo key is refused, and a missing service-role client fails closed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestApp } = require('./helpers/harness');

const LIVE_KEY = `sk_live_${crypto.randomBytes(12).toString('hex')}`;
let t;

before(async () => {
  t = await startTestApp({ env: { PAYMENTS_ENABLED: 'true', PAYMONGO_SECRET_KEY: LIVE_KEY } });
});

after(async () => {
  await t.close();
});

describe('live key refused', () => {
  it('never contacts PayMongo and logs the problem without the key', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: 30 });

    const checkout = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointment.id } });
    assert.equal(checkout.status, 503);
    assert.equal(t.paymongo.requests.length, 0);
    assert.equal(t.paymentsService.startExpirySweep(), false);

    const logs = t.logs.join('\n');
    assert.ok(logs.includes('payments.live_key_refused'));
    assert.ok(!logs.includes(LIVE_KEY));
  });

  it('still requires the deposit for new bookings, so approval waits (fail closed)', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: 31 });

    const response = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
      token: admin.token,
      body: { id: appointment.id, status: 'Approved' }
    });
    assert.equal(response.status, 409);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');

    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.body.appointments[0].deposit.status, 'unpaid');
    assert.equal(list.body.appointments[0].deposit.can_pay, false);
  });

  it('refuses new bookings while the deposit cannot be paid, and creates nothing', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);

    const response = await bookFor(user, pet, 34);
    assert.equal(response.status, 503);
    assert.match(response.body.error, /₱100 deposit/);
    assert.equal(t.db.table('appointments').filter(row => row.user_id === user.id).length, 0);
    assert.equal(t.paymongo.requests.length, 0);

    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.body.deposit_policy.required, true);
    assert.equal(list.body.deposit_policy.checkout_available, false);
  });
});

function bookFor(user, pet, daysAhead) {
  return t.api('POST', '/appointments/create', {
    token: user.token,
    body: {
      user_id: user.id,
      pet_id: pet.id,
      pet_name: pet.name,
      service_type: 'Checkup',
      appointment_date: t.manilaDate(daysAhead),
      appointment_time: '09:00:00'
    }
  });
}

describe('service-role client missing', () => {
  it('blocks approval of deposit appointments with 503 but leaves exempt ones alone', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const needsDeposit = t.createAppointment(user, { daysAhead: 32 });
    const exempt = t.createAppointment(user, { daysAhead: 33, depositRequired: false });

    t.adminState.configured = false;
    try {
      const blocked = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
        token: admin.token,
        body: { id: needsDeposit.id, status: 'Approved' }
      });
      assert.equal(blocked.status, 503);
      assert.equal(t.appointmentRow(needsDeposit.id).status, 'Pending');

      const allowed = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
        token: admin.token,
        body: { id: exempt.id, status: 'Approved' }
      });
      assert.equal(allowed.status, 200);

      const webhook = await t.sendWebhook({ data: { id: 'evt_x', type: 'event', attributes: { type: 'payment.paid', livemode: false, data: {} } } });
      assert.equal(webhook.status, 503);

      // Deposits are required, but no payment can be recorded: new bookings are refused instead of created unpaid
      const pet = t.createPet(user);
      const booking = await bookFor(user, pet, 35);
      assert.equal(booking.status, 503);
      assert.equal(t.db.table('appointments').filter(row => row.user_id === user.id).length, 2);
    } finally {
      t.adminState.configured = true;
    }
  });
});
