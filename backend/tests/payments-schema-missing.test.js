// PAYMENTS_ENABLED=true before the deposit migration was applied (an operator mistake):
// booking and approvals must keep working without deposits, payments stay unavailable, and the problem is logged.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;

before(async () => {
  t = await startTestApp({ env: { PAYMENTS_ENABLED: 'true' }, migrated: false });
});

after(async () => {
  await t.close();
});

describe('payments switched on without the migration', () => {
  it('keeps booking, lists and approval working, without deposits', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const pet = t.createPet(user);

    const booked = await t.api('POST', '/appointments/create', {
      token: user.token,
      body: {
        user_id: user.id,
        pet_id: pet.id,
        pet_name: pet.name,
        service_type: 'Checkup',
        appointment_date: t.manilaDate(30),
        appointment_time: '13:00:00'
      }
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.deposit, undefined);
    assert.ok(t.logs.some(line => line.includes('payments.schema_missing')));

    const userList = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(userList.status, 200);
    assert.equal(userList.body.appointments[0].deposit.status, 'not_required');

    const approved = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
      token: admin.token,
      body: { id: booked.body.appointment.id, status: 'Approved' }
    });
    assert.equal(approved.status, 200);

    const cancelled = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
      token: admin.token,
      body: { id: booked.body.appointment.id, status: 'Cancelled' }
    });
    assert.equal(cancelled.status, 200);
    // Without the migration no appointment needs a deposit, so no deposit or decision email goes out
    await t.settleEmails();
    assert.equal(t.emails.length, 0);
  });

  it('answers checkout with "unavailable" instead of failing unpredictably', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: 33 });
    const checkout = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointment.id } });
    assert.equal(checkout.status, 503);
    assert.equal(t.paymongo.requests.length, 0);
  });
});
