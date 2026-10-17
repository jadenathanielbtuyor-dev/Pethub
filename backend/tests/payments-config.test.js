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

describe('webhooks and startup status without a usable test key', () => {
  it('a paid event for a PetHub payment cannot be confirmed with PayMongo, so it is retried later and nothing is recorded', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: 36 });
    const row = t.db.seed('payments', {
      appointment_id: appointment.id,
      user_id: user.id,
      amount: 100,
      payment_status: 'Pending',
      provider_checkout_session_id: 'cs_fakeseededsession01',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString()
    });
    const event = t.paymongo.event('checkout_session.payment.paid', {
      id: 'cs_fakeseededsession01',
      type: 'checkout_session',
      attributes: {
        status: 'active',
        livemode: false,
        reference_number: row.id,
        metadata: { pethub_payment_id: row.id, pethub_appointment_id: appointment.id },
        payments: [{ id: 'pay_fakeseeded0000001', type: 'payment', attributes: { amount: 10000, currency: 'PHP', status: 'paid', livemode: false } }]
      }
    });

    const response = await t.sendWebhook(event);
    assert.equal(response.status, 503);
    assert.equal(row.payment_status, 'Pending');
    assert.equal(t.paymongo.requests.length, 0, 'a live key is never used');
    assert.ok(t.logs.some(line => line.includes('payments.webhook_unconfirmed') && line.includes("reason: 'provider_unavailable'")));
  });

  it('an event that matches no PetHub payment is still acknowledged, so PayMongo does not keep retrying it', async () => {
    const sample = t.paymongo.event('checkout_session.payment.paid', {
      id: 'cs_dashboardsample99',
      type: 'checkout_session',
      attributes: { status: 'active', livemode: false, metadata: null, payments: [] }
    });
    assert.equal((await t.sendWebhook(sample)).status, 200);
    assert.ok(t.logs.some(line => line.includes('payments.webhook_unmatched') && line.includes("provider_session: 'not_checked'")));
  });

  it('the payments.status line says checkout is unavailable and why, without any key', () => {
    t.paymentsService.logStartupStatus();
    const line = t.logs.filter(entry => entry.includes('payments.status')).pop() || '';
    assert.match(line, /deposits: 'on'/);
    assert.match(line, /payments_enabled_setting: 'true'/);
    assert.match(line, /checkout_available: false/);
    assert.match(line, /'paymongo_live_key_refused'/);
    assert.match(line, /frontend_url: 'https:\/\/pethub-frontend\.test'/);
    assert.match(line, /supabase_project: /);
    assert.ok(!line.includes(LIVE_KEY));
    assert.ok(!line.includes(t.secrets.webhookSecret));
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
