// Appointment lists show the newest appointments first: appointment_date descending, then appointment_time
// descending, then created_at descending (the most recently booked first). Rows without a date or time come last.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let admin;
let owner;
let expectedOrder;

function seedAppointment(user, pet, label, appointmentDate, appointmentTime, createdAt) {
  return t.db.seed('appointments', {
    user_id: user.id,
    pet_id: pet.id,
    pet_name: label,
    service_type: 'Checkup',
    estimated_duration_minutes: 45,
    appointment_date: appointmentDate,
    appointment_time: appointmentTime,
    status: 'Pending',
    created_at: createdAt
  });
}

before(async () => {
  t = await startTestApp();
  admin = t.createUser({ role: 'admin' });
  owner = t.createUser();
  const other = t.createUser();
  const pet = t.createPet(owner);
  const otherPet = t.createPet(other);

  // Seeded out of order on purpose
  seedAppointment(owner, pet, 'A same day, 09:00', '2026-12-05', '09:00:00', '2026-10-01T08:00:00.000Z');
  seedAppointment(owner, pet, 'B same slot, booked earlier', '2026-12-05', '15:30:00', '2026-10-01T09:00:00.000Z');
  seedAppointment(owner, pet, 'C latest date', '2026-12-07', '08:00:00', '2026-09-01T08:00:00.000Z');
  seedAppointment(owner, pet, 'D earliest date', '2026-11-30', '17:00:00', '2026-10-10T08:00:00.000Z');
  seedAppointment(owner, pet, 'E same slot, booked later', '2026-12-05', '15:30:00', '2026-10-02T09:00:00.000Z');
  seedAppointment(owner, pet, 'F no time', '2026-12-05', null, '2026-10-03T09:00:00.000Z');
  seedAppointment(other, otherPet, 'X other customer', '2026-12-06', '11:00:00', '2026-10-04T09:00:00.000Z');

  expectedOrder = [
    'C latest date',
    'X other customer',
    'E same slot, booked later',
    'B same slot, booked earlier',
    'A same day, 09:00',
    'F no time',
    'D earliest date'
  ];
});

after(async () => {
  await t.close();
});

const labels = appointments => appointments.map(appointment => appointment.pet_name);

describe('appointment lists are newest first', () => {
  it('admin management list: date, then time, then booking time, all descending', async () => {
    const response = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
    assert.equal(response.status, 200);
    assert.deepEqual(labels(response.body.appointments), expectedOrder);
  });

  it('admin dashboard overview uses the same order', async () => {
    const response = await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });
    assert.equal(response.status, 200);
    assert.deepEqual(labels(response.body.appointments), expectedOrder);
  });

  it("the customer's own list uses the same order", async () => {
    const response = await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token });
    assert.equal(response.status, 200);
    assert.deepEqual(labels(response.body.appointments), expectedOrder.filter(label => label !== 'X other customer'));
  });

  it('a newly booked appointment takes its place by date and time, not at the end', async () => {
    const pet = t.createPet(owner, 'Kuro');
    const booked = await t.api('POST', '/appointments/create', {
      token: owner.token,
      body: {
        user_id: owner.id,
        pet_id: pet.id,
        pet_name: pet.name,
        service_type: 'Dog & Cat Full Check Up',
        appointment_date: '2026-12-06',
        appointment_time: '10:00:00'
      }
    });
    assert.equal(booked.status, 201);

    const response = await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token });
    assert.deepEqual(labels(response.body.appointments).slice(0, 3), ['C latest date', 'Kuro', 'E same slot, booked later']);
  });
});
