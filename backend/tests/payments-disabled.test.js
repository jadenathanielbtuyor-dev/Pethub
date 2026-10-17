// PAYMENTS_ENABLED unset (the default) on a database without the deposit migration:
// everything must behave exactly as before the payment feature, with no payment queries at all.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;

before(async () => {
  t = await startTestApp({ env: { PAYMENTS_ENABLED: '' }, migrated: false });
});

after(async () => {
  await t.close();
});

describe('payments switched off (default)', () => {
  it('books, lists, approves, completes and cancels exactly as before', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const pet = t.createPet(user);
    t.db.log.length = 0;

    const booked = await t.api('POST', '/appointments/create', {
      token: user.token,
      body: {
        user_id: user.id,
        pet_id: pet.id,
        pet_name: pet.name,
        service_type: 'Vaccination',
        appointment_date: t.manilaDate(30),
        appointment_time: '11:00:00'
      }
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.deposit, undefined);
    const appointmentId = booked.body.appointment.id;
    assert.equal(Object.prototype.hasOwnProperty.call(t.appointmentRow(appointmentId), 'deposit_required'), false);

    const userList = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(userList.status, 200);
    assert.equal(userList.body.appointments[0].deposit, undefined);

    const adminList = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.appointments[0].deposit, undefined);

    const approved = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
      token: admin.token,
      body: { id: appointmentId, status: 'Approved' }
    });
    assert.equal(approved.status, 200);
    const completed = await t.api('PUT', '/appointments/updateStatus', {
      token: admin.token,
      body: { id: appointmentId, status: 'Completed', user_id: admin.id }
    });
    assert.equal(completed.status, 200);
    assert.equal(t.appointmentRow(appointmentId).status, 'Completed');

    const second = t.createAppointment(user, { pet, daysAhead: 31 });
    const cancelled = await t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, {
      token: admin.token,
      body: { id: second.id, status: 'Cancelled' }
    });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.refund_required, undefined);

    assert.equal(t.db.log.filter(entry => entry.table === 'payments').length, 0);
    assert.equal(t.paymongo.requests.length, 0);
  });

  it('keeps the payment endpoints closed', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: 32 });

    const checkout = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointment.id } });
    assert.equal(checkout.status, 503);
    const status = await t.api('GET', `/payments/appointment/${appointment.id}`, { token: user.token });
    assert.equal(status.status, 503);
    assert.equal(t.paymongo.requests.length, 0);
  });

  it('does not start the expiry sweep timer twice', () => {
    assert.equal(t.paymentsService.startExpirySweep(), true);
    assert.equal(t.paymentsService.startExpirySweep(), false);
    t.paymentsService.stopExpirySweep();
  });
});
