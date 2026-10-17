// Requests that arrive at the same moment: two admins approving overlapping appointments, and the same deposit
// booking sent twice (two tabs, a double click). Each pair is started together, so without serialisation both
// requests pass the "is it still free?" check before either one writes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

let t;
let day = 60;
const nextDay = () => {
  day += 1;
  return day;
};

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

function approveVia(endpoint, admin, appointmentId) {
  if (endpoint === 'admin') {
    return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id: appointmentId, status: 'Approved' } });
  }
  return t.api('PUT', '/appointments/updateStatus', { token: admin.token, body: { id: appointmentId, status: 'Approved', user_id: admin.id } });
}

function seedPaidDeposit(user, appointment) {
  return t.db.seed('payments', {
    appointment_id: appointment.id,
    user_id: user.id,
    amount: 100,
    payment_status: 'Paid',
    paid_at: new Date().toISOString(),
    provider_payment_id: `pay_conc${appointment.id.replace(/-/g, '').slice(0, 12)}`,
    provider_checkout_session_id: `cs_conc${appointment.id.replace(/-/g, '').slice(0, 12)}`,
    created_at: new Date().toISOString()
  });
}

describe('simultaneous approvals of overlapping appointments', () => {
  for (const [first, second] of [['admin', 'admin'], ['admin', 'legacy'], ['legacy', 'legacy']]) {
    it(`${first} + ${second} endpoint: exactly one is approved, the other gets the schedule conflict`, async () => {
      const adminA = t.createUser({ role: 'admin', name: 'Admin A' });
      const adminB = t.createUser({ role: 'admin', name: 'Admin B' });
      const userA = t.createUser();
      const userB = t.createUser();
      const daysAhead = nextDay();
      const a = t.createAppointment(userA, { daysAhead, time: '10:00:00', duration: 60, depositRequired: false });
      const b = t.createAppointment(userB, { daysAhead, time: '10:30:00', duration: 60, depositRequired: false });

      const responses = await Promise.all([approveVia(first, adminA, a.id), approveVia(second, adminB, b.id)]);
      const statuses = responses.map(response => response.status).sort();
      assert.deepEqual(statuses, [200, 409]);
      const approved = [a, b].filter(appointment => t.appointmentRow(appointment.id).status === 'Approved');
      assert.equal(approved.length, 1, 'only one of the overlapping appointments holds the slot');
    });
  }

  it('paid deposit appointments: one is approved, the other is refused with refund_required', async () => {
    const adminA = t.createUser({ role: 'admin' });
    const adminB = t.createUser({ role: 'admin' });
    const userA = t.createUser();
    const userB = t.createUser();
    const daysAhead = nextDay();
    const a = t.createAppointment(userA, { daysAhead, time: '14:00:00', duration: 45 });
    const b = t.createAppointment(userB, { daysAhead, time: '14:00:00', duration: 45 });
    seedPaidDeposit(userA, a);
    seedPaidDeposit(userB, b);

    const responses = await Promise.all([approveVia('admin', adminA, a.id), approveVia('legacy', adminB, b.id)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const refused = responses.find(response => response.status === 409);
    assert.equal(refused.body.refund_required, true);
    assert.equal([a, b].filter(appointment => t.appointmentRow(appointment.id).status === 'Approved').length, 1);
  });

  it('approvals on different dates or at non-overlapping times are not held up by each other', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const daysAhead = nextDay();
    const morning = t.createAppointment(user, { daysAhead, time: '08:00:00', duration: 30, depositRequired: false });
    const afternoon = t.createAppointment(user, { daysAhead, time: '15:00:00', duration: 30, depositRequired: false });
    const otherDay = t.createAppointment(user, { daysAhead: nextDay(), time: '08:00:00', duration: 30, depositRequired: false });

    const responses = await Promise.all([morning, afternoon, otherDay].map(appointment => approveVia('admin', admin, appointment.id)));
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
    const { pendingKeyCount } = require(path.join(__dirname, '..', 'utils', 'keyedLock.js'));
    assert.equal(pendingKeyCount(), 0, 'no lock is left behind');
  });
});

describe('the same deposit booking sent twice at once', () => {
  it('creates one appointment; the second request gets it back as already booked', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const booking = {
      user_id: user.id,
      pet_id: pet.id,
      pet_name: pet.name,
      service_type: 'Grooming',
      appointment_date: t.manilaDate(nextDay()),
      appointment_time: '13:00:00'
    };

    const responses = await Promise.all([1, 2, 3].map(() => t.api('POST', '/appointments/create', { token: user.token, body: booking })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 201]);
    const rows = t.db.table('appointments').filter(row => row.user_id === user.id);
    assert.equal(rows.length, 1, 'one appointment row');
    responses.forEach(response => assert.equal(response.body.appointment.id, rows[0].id));
    responses.filter(response => response.status === 200).forEach(response => assert.equal(response.body.already_booked, true));
  });

  it('different bookings from the same customer are still all created', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const date = t.manilaDate(nextDay());
    const responses = await Promise.all(['09:00:00', '11:00:00'].map(time => t.api('POST', '/appointments/create', {
      token: user.token,
      body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: 'Checkup', appointment_date: date, appointment_time: time }
    })));
    assert.deepEqual(responses.map(response => response.status), [201, 201]);
    assert.equal(t.db.table('appointments').filter(row => row.user_id === user.id).length, 2);
  });
});
