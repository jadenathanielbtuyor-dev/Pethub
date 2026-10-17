// PAYMENTS_ENABLED off (before deposits are switched on, or after a rollback), on the migrated database.
// New bookings need no deposit (the agreed rollback flow), but appointments already marked deposit_required keep
// their deposit rules: never approvable unpaid, their deposit stays visible, cancelling closes an open checkout and
// flags a paid deposit for refund, and a payment PayMongo confirms for an open checkout is still recorded.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let day = 40;

before(async () => {
  t = await startTestApp({ env: { PAYMENTS_ENABLED: '' } });
});

after(async () => {
  await t.close();
});

function approve(endpoint, admin, appointmentId, status = 'Approved') {
  if (endpoint === 'admin') {
    return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id: appointmentId, status } });
  }
  return t.api('PUT', '/appointments/updateStatus', { token: admin.token, body: { id: appointmentId, status, user_id: admin.id } });
}

// A checkout opened while deposits were still on
function seedOpenCheckout(user, appointment) {
  const row = t.db.seed('payments', {
    appointment_id: appointment.id,
    user_id: user.id,
    amount: 100,
    payment_status: 'Pending',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 20 * 60 * 1000).toISOString()
  });
  t.paymongo.createSession({ data: { attributes: {
    reference_number: row.id,
    metadata: { pethub_payment_id: row.id, pethub_appointment_id: appointment.id },
    line_items: [{ name: 'Appointment deposit', amount: 10000, currency: 'PHP', quantity: 1 }]
  } } });
  row.provider_checkout_session_id = [...t.paymongo.sessions.keys()].at(-1);
  return row;
}

function seedPaidDeposit(user, appointment) {
  return t.db.seed('payments', {
    appointment_id: appointment.id,
    user_id: user.id,
    amount: 100,
    payment_status: 'Paid',
    paid_at: new Date().toISOString(),
    provider_payment_id: `pay_seeded${appointment.id.slice(0, 8)}`,
    provider_checkout_session_id: `cs_seeded${appointment.id.slice(0, 8)}`,
    created_at: new Date().toISOString()
  });
}

describe('payments switched off', () => {
  it('new bookings need no deposit, exactly as before', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const booked = await t.api('POST', '/appointments/create', {
      token: user.token,
      body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: 'Checkup', appointment_date: t.manilaDate(day += 1), appointment_time: '09:00:00' }
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.deposit, undefined);
    assert.equal(t.appointmentRow(booked.body.appointment.id).deposit_required, false);

    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.body.deposit_policy, undefined);
    assert.equal(list.body.appointments[0].deposit, undefined);
  });

  for (const endpoint of ['admin', 'legacy']) {
    it(`${endpoint}: an unpaid deposit-required appointment still cannot be approved`, async () => {
      const admin = t.createUser({ role: 'admin' });
      const user = t.createUser();
      const appointment = t.createAppointment(user, { daysAhead: day += 1 });

      const response = await approve(endpoint, admin, appointment.id);
      assert.equal(response.status, 409);
      assert.equal(response.body.deposit_status, 'unpaid');
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
    });
  }

  it('a deposit-required appointment with a verified payment can be approved, and the customer is emailed', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: day += 1 });
    seedPaidDeposit(user, appointment);

    const response = await approve('admin', admin, appointment.id);
    assert.equal(response.status, 200);
    await t.settleEmails();
    assert.equal(t.emailsTo(user.email).length, 1);
  });

  it('lists keep showing the deposit of deposit-required appointments only; it cannot be paid online now', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const needsDeposit = t.createAppointment(user, { daysAhead: day += 1 });
    const exempt = t.createAppointment(user, { daysAhead: day += 1, depositRequired: false });

    const userList = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    const byId = Object.fromEntries(userList.body.appointments.map(item => [item.id, item]));
    assert.equal(byId[needsDeposit.id].deposit.status, 'unpaid');
    assert.equal(byId[needsDeposit.id].deposit.can_pay, false);
    assert.equal(byId[exempt.id].deposit, undefined);

    const adminList = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
    const adminById = Object.fromEntries(adminList.body.appointments.map(item => [item.id, item]));
    assert.equal(adminById[needsDeposit.id].deposit.status, 'unpaid');
    assert.equal(adminById[exempt.id].deposit, undefined);

    assert.equal((await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: needsDeposit.id } })).status, 503);
  });

  it('cancelling closes the open checkout at PayMongo; cancelling a paid one flags the refund', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const open = t.createAppointment(user, { daysAhead: day += 1 });
    const row = seedOpenCheckout(user, open);

    assert.equal((await approve('admin', admin, open.id, 'Cancelled')).status, 200);
    assert.equal(t.db.find('payments', item => item.id === row.id).payment_status, 'Expired');
    assert.equal(t.paymongo.sessions.get(row.provider_checkout_session_id).status, 'expired');

    const paid = t.createAppointment(user, { daysAhead: day += 1 });
    seedPaidDeposit(user, paid);
    const cancelled = await approve('admin', admin, paid.id, 'Cancelled');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.refund_required, true);
  });

  it('a payment PayMongo confirms for an open checkout is still recorded, once, without approving', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: day += 1 });
    const row = seedOpenCheckout(user, appointment);

    t.paymongo.pay(row.provider_checkout_session_id);
    const event = t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id);
    assert.equal((await t.sendWebhook(event)).status, 200);
    assert.equal((await t.sendWebhook(event)).status, 200);
    assert.equal(t.db.find('payments', item => item.id === row.id).payment_status, 'Paid');
    assert.equal(t.db.table('payments').filter(item => item.appointment_id === appointment.id).length, 1);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });
});
