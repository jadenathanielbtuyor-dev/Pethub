// Service availability: an admin switches online booking for one service off and on again (the admin dashboard's
// switch sends PUT /admin/services/:id with the service's saved settings and only online_booking_enabled changed),
// new bookings follow the switch at once, and existing appointments are never touched.
// MOCKED: the real Express app with the in-memory database (helpers/harness.js, test-only durations); no live database.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

const UNAVAILABLE = 'This service is temporarily unavailable for online booking. Please select another service.';

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

// What the admin dashboard's switch sends: the saved settings as listed, with only the availability changed
async function setAvailability(actor, serviceName, enabled) {
  const listed = (await t.api('GET', '/admin/services', { token: actor.token })).body.services;
  const service = (listed || []).find(row => row.name === serviceName) || t.db.find('pethub_service_catalog', row => row.name === serviceName);
  return t.api('PUT', `/admin/services/${service.id}`, {
    token: actor.token,
    body: {
      name: service.name,
      description: service.description,
      category: service.category,
      species: service.species,
      duration_minutes: service.duration_minutes,
      online_booking_enabled: enabled,
      display_order: service.display_order,
      expected_version: service.version || 1
    }
  });
}

const row = name => t.db.find('pethub_service_catalog', service => service.name === name);
const book = (user, pet, serviceName, daysAhead = 5, time = '10:00:00') => t.api('POST', '/appointments/create', {
  token: user.token,
  body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_id: row(serviceName).id, service_type: serviceName, appointment_date: t.manilaDate(daysAhead), appointment_time: time }
});

describe('Admin service availability switch', () => {
  it('turns one service off and on again, changing only its availability, and every list follows', async () => {
    const admin = t.createUser({ role: 'admin' });
    const before = { ...row('Trim'), species: [...row('Trim').species] };
    assert.equal(before.online_booking_enabled, true);

    const off = await setAvailability(admin, 'Trim', false);
    assert.equal(off.status, 200, JSON.stringify(off.body));
    assert.equal(off.body.service.online_booking_enabled, false);
    assert.equal(off.body.service.bookable, false);
    const stored = row('Trim');
    assert.equal(stored.online_booking_enabled, false, 'saved in the database');
    assert.equal(stored.duration_minutes, before.duration_minutes, 'duration unchanged');
    assert.deepEqual(stored.species, before.species, 'species unchanged');
    assert.equal(stored.name, before.name);
    assert.equal(stored.version, before.version + 1, 'the concurrency token moves on');
    assert.equal(t.db.table('pethub_service_catalog').length, 9, 'nothing is deleted');

    // A fresh load (what a page refresh does) shows the saved state
    assert.equal((await t.api('GET', '/admin/services', { token: admin.token })).body.services.find(s => s.name === 'Trim').online_booking_enabled, false);
    assert.equal((await t.api('GET', '/appointments/services')).body.services.find(s => s.name === 'Trim').bookable, false);

    const on = await setAvailability(admin, 'Trim', true);
    assert.equal(on.status, 200, JSON.stringify(on.body));
    assert.equal(row('Trim').online_booking_enabled, true);
    assert.equal((await t.api('GET', '/appointments/services')).body.services.find(s => s.name === 'Trim').bookable, true);
  });

  it('will not turn on a service whose duration or species is not confirmed', async () => {
    const admin = t.createUser({ role: 'admin' });
    // Puppy Cut has no confirmed species in the catalog
    assert.deepEqual(row('Puppy Cut').species, []);
    const response = await setAvailability(admin, 'Puppy Cut', true);
    assert.equal(response.status, 422);
    assert.equal(response.body.field, 'species');
    assert.equal(row('Puppy Cut').online_booking_enabled, false);
  });

  it('refuses a pet owner, with or without the admin page, and changes nothing', async () => {
    const owner = t.createUser();
    const versionBefore = row('Bath').version;
    const response = await setAvailability(owner, 'Bath', false);
    assert.equal(response.status, 403);
    assert.equal(row('Bath').online_booking_enabled, true);
    assert.equal(row('Bath').version, versionBefore);
    assert.equal((await t.api('PUT', `/admin/services/${row('Bath').id}`, { body: { online_booking_enabled: false } })).status, 401, 'no token');
  });

  it('a switch based on an outdated list is refused instead of overwriting newer settings', async () => {
    const admin = t.createUser({ role: 'admin' });
    const service = row('Face Trim');
    const response = await t.api('PUT', `/admin/services/${service.id}`, {
      token: admin.token,
      body: { name: service.name, description: service.description, category: service.category, species: service.species,
        duration_minutes: service.duration_minutes, online_booking_enabled: false, display_order: service.display_order, expected_version: service.version + 5 }
    });
    assert.equal(response.status, 409);
    assert.equal(row('Face Trim').online_booking_enabled, true);
  });
});

describe('Booking follows the switch', () => {
  it('a service switched off cannot be booked, with a clear message, and nothing is created', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const pet = t.createPet(owner);
    assert.equal((await setAvailability(admin, 'Nail Cutting', false)).status, 200);
    const before = t.db.table('appointments').length;
    const response = await book(owner, pet, 'Nail Cutting');
    assert.equal(response.status, 409);
    assert.equal(response.body.error, UNAVAILABLE);
    assert.equal(t.db.table('appointments').length, before);

    assert.equal((await setAvailability(admin, 'Nail Cutting', true)).status, 200);
    assert.equal((await book(owner, pet, 'Nail Cutting')).status, 201, 'bookable again once switched back on');
  });

  it('switched off between the API check and the database reservation: the same clear message', async () => {
    const owner = t.createUser();
    const pet = t.createPet(owner);
    const before = t.db.table('appointments').length;
    // The database function re-checks the service under a lock and refuses (P0001) because it was switched off meanwhile
    t.db.interceptNext({ table: 'appointments', action: 'rpc' }, () => {
      row('Medicated Bath').online_booking_enabled = false;
      return { data: null, error: { code: 'P0001', message: 'Service or pet booking configuration changed' } };
    });
    const response = await book(owner, pet, 'Medicated Bath', 6);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, UNAVAILABLE);
    assert.equal(t.db.table('appointments').length, before);
    row('Medicated Bath').online_booking_enabled = true;
  });
});

describe('Existing appointments are never touched by the switch', () => {
  it('keeps every appointment of a switched-off service, visible to its owner and manageable by the admin', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const pet = t.createPet(owner);
    const pending = t.createAppointment(owner, { pet, service: 'Full Grooming', duration: 240, status: 'Pending', daysAhead: 10 });
    const approved = t.createAppointment(owner, { pet, service: 'Full Grooming', duration: 240, status: 'Approved', daysAhead: 12 });
    const completed = t.createAppointment(owner, { pet, service: 'Full Grooming', duration: 240, status: 'Completed', daysAhead: -3 });
    const cancelled = t.createAppointment(owner, { pet, service: 'Full Grooming', duration: 240, status: 'Cancelled', daysAhead: 14 });
    const snapshot = JSON.stringify([pending, approved, completed, cancelled].map(a => t.appointmentRow(a.id)));

    assert.equal((await setAvailability(admin, 'Full Grooming', false)).status, 200);
    assert.equal(JSON.stringify([pending, approved, completed, cancelled].map(a => t.appointmentRow(a.id))), snapshot, 'rows unchanged');

    const ownerList = await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token });
    assert.equal(ownerList.status, 200);
    assert.deepEqual(ownerList.body.appointments.map(a => a.id).sort(), [pending.id, approved.id, completed.id, cancelled.id].sort());

    const adminList = await t.api('GET', '/admin/dashboard/overview', { token: admin.token });
    assert.equal(adminList.status, 200);
    assert.ok(JSON.stringify(adminList.body).includes(pending.id), 'the admin still sees them');

    // The admin can still manage an existing Pending appointment of the switched-off service
    const approve = await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: pending.id, status: 'Approved' } });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(t.appointmentRow(pending.id).status, 'Approved');
    assert.equal(t.appointmentRow(approved.id).status, 'Approved', 'the already approved one was not cancelled');
    assert.equal((await setAvailability(admin, 'Full Grooming', true)).status, 200);
  });
});
