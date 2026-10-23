// Booking the clinic's services once durations are configured: the server checks the pet's species against the
// service, new pets must be dogs or cats, earlier ("legacy") appointments keep working with their saved duration,
// and the admin figures use the catalog.
// MOCKED: the real Express app on the in-memory database (helpers/harness.js) with the harness's MADE-UP test-only
// durations, and a test-only species rule (Puppy Cut for dogs only) to exercise the species check. Neither is clinic
// policy: constants/services.js ships with no durations and both species for every service.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, TEST_ONLY_SERVICE_DURATIONS } = require('./helpers/harness');

let t;
let admin;

before(async () => {
  t = await startTestApp({ serviceSpecies: { 'Puppy Cut': ['Dog'] } });
  admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
});

after(async () => {
  await t.close();
});

let dayOffset = 10;
function book(user, pet, service, { daysAhead, time = '10:00:00' } = {}) {
  dayOffset += 1;
  return t.api('POST', '/appointments/create', {
    token: user.token,
    body: {
      user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: service,
      appointment_date: t.manilaDate(daysAhead ?? dayOffset), appointment_time: time
    }
  });
}

function seedPet(user, species, name = 'Pet') {
  return t.db.seed('pets', { user_id: user.id, name, species, breed: null, age: 2 });
}

describe('Species and services', () => {
  it('the booking page sees the configured durations and species', async () => {
    const user = t.createUser();
    const response = await t.api('GET', '/appointments/services', { token: user.token });
    assert.equal(response.status, 200);
    response.body.services.forEach(service => {
      assert.equal(service.duration_minutes, TEST_ONLY_SERVICE_DURATIONS[service.name], service.name);
      assert.equal(service.bookable, true);
    });
    assert.deepEqual(response.body.services.find(service => service.name === 'Puppy Cut').species, ['Dog']);
  });

  it('books a service for a species it is offered for, storing the server\'s duration', async () => {
    const user = t.createUser();
    const cat = seedPet(user, 'Cat', 'Luna');
    const response = await book(user, cat, 'Medicated Bath');
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.appointment.estimated_duration_minutes, TEST_ONLY_SERVICE_DURATIONS['Medicated Bath']);
    const checkup = await book(user, cat, 'Dog & Cat Full Check Up');
    assert.equal(checkup.status, 201);
  });

  it('refuses a service the pet\'s species is not offered, even when the browser sends it anyway', async () => {
    const user = t.createUser();
    const cat = seedPet(user, 'cat', 'Kuro');
    const refused = await book(user, cat, 'Puppy Cut');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'Puppy Cut is offered for dogs only.');
    const dog = seedPet(user, 'Dog', 'Bantay');
    assert.equal((await book(user, dog, 'Puppy Cut')).status, 201);
    assert.equal(t.db.table('appointments').filter(row => row.pet_id === cat.id).length, 0);
  });

  it('refuses every service for a pet profile of another species saved before the clinic\'s rules', async () => {
    const user = t.createUser();
    const rabbit = seedPet(user, 'Rabbit', 'Bun');
    const response = await book(user, rabbit, 'Bath');
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Bath is offered for dogs and cats only.');
  });

  it('still refuses another customer\'s pet before looking at species', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const ownersCat = seedPet(owner, 'Cat');
    const response = await book(other, ownersCat, 'Puppy Cut');
    assert.equal(response.status, 404);
  });
});

describe('New pet profiles', () => {
  it('accept dogs and cats (any letter case, stored as Dog / Cat) and refuse other species', async () => {
    const user = t.createUser();
    // Age is required for a new profile (constants/pets.js)
    const add = species => t.api('POST', '/pets/create', { token: user.token, body: { user_id: user.id, name: 'Mochi', species, age: 2 } });
    const dog = await add('dog');
    assert.equal(dog.status, 201, JSON.stringify(dog.body));
    assert.equal(t.db.table('pets').filter(row => row.user_id === user.id).pop().species, 'Dog');
    assert.equal((await add(' CAT ')).status, 201);
    for (const species of ['Rabbit', 'Bird', 'Other', 'Dogs', 'Hamster']) {
      const response = await add(species);
      assert.equal(response.status, 400, species);
      assert.equal(response.body.error, 'The clinic cares for dogs and cats only. Choose Dog or Cat.');
    }
    assert.equal(t.db.table('pets').filter(row => row.user_id === user.id).length, 2);
  });
});

describe('Appointments for earlier services', () => {
  it('keep blocking their saved time when approved, and can be approved, completed or cancelled', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const date = 30;
    const legacy = t.createAppointment(user, { pet, service: 'Checkup', duration: 45, daysAhead: date, time: '10:00:00' });
    const approve = await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: legacy.id, status: 'Approved' } });
    assert.equal(approve.status, 200);

    // 10:30 overlaps the earlier service's saved 45 minutes; 10:45 does not
    const overlapping = await book(user, pet, 'Nail Cutting', { daysAhead: date, time: '10:30:00' });
    assert.equal(overlapping.status, 409);
    assert.equal(overlapping.body.suggested_time, '10:45');
    assert.equal((await book(user, pet, 'Nail Cutting', { daysAhead: date, time: '10:45:00' })).status, 201);

    const cancelled = t.createAppointment(user, { pet, service: 'Vaccination', duration: 30, daysAhead: 31 });
    assert.equal((await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: cancelled.id, status: 'Cancelled' } })).status, 200);
    await t.settleEmails();
  });

  it('one saved without a duration can still be approved; it then blocks no time (documented compatibility rule)', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const legacy = t.createAppointment(user, { pet, service: 'Checkup', duration: null, daysAhead: 40, time: '09:00:00' });
    const approve = await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: legacy.id, status: 'Approved' } });
    assert.equal(approve.status, 200);
    assert.equal(t.appointmentRow(legacy.id).estimated_duration_minutes, null, 'no duration is invented for it');
    assert.equal((await book(user, pet, 'Bath', { daysAhead: 40, time: '09:00:00' })).status, 201);
    await t.settleEmails();
  });
});

describe('Admin figures', () => {
  it('chart every catalog service, then earlier services by name', async () => {
    const response = await t.api('GET', `/admin/analytics/services?user_id=${admin.id}`, { token: admin.token });
    assert.equal(response.status, 200);
    const { SERVICE_CATALOG } = require('../constants/services');
    const catalogNames = SERVICE_CATALOG.map(entry => entry.name);
    assert.deepEqual(response.body.labels.slice(0, catalogNames.length), catalogNames);
    const earlier = response.body.labels.slice(catalogNames.length);
    assert.ok(earlier.includes('Checkup (earlier service)'));
    earlier.forEach(label => assert.match(label, /\(earlier service\)$|^Service not recorded$/));
    const counts = Object.fromEntries(response.body.labels.map((label, index) => [label, response.body.values[index]]));
    const appointments = t.db.table('appointments');
    assert.equal(counts['Checkup (earlier service)'], appointments.filter(row => row.service_type === 'Checkup').length);
    assert.equal(counts['Puppy Cut'], appointments.filter(row => row.service_type === 'Puppy Cut').length);
    assert.equal(response.body.values.reduce((sum, value) => sum + value, 0), appointments.length);
  });

  it('count pets as Dog, Cat or Other', async () => {
    const response = await t.api('GET', `/admin/analytics/pet-types?user_id=${admin.id}`, { token: admin.token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.labels, ['Dog', 'Cat', 'Other']);
    const pets = t.db.table('pets');
    assert.equal(response.body.values[2], pets.filter(pet => !['dog', 'cat'].includes(String(pet.species).toLowerCase())).length);
  });

  it('"Upcoming check-ups" counts Pending and Approved check-ups (current and earlier name) in the next 7 days only', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const before = await t.api('GET', `/admin/analytics/summary?user_id=${admin.id}`, { token: admin.token });
    assert.equal(before.status, 200);
    assert.ok(!('vaccinationsDueSoon' in before.body.summary));
    const start = before.body.summary.upcomingCheckups;

    t.createAppointment(user, { pet, service: 'Dog & Cat Full Check Up', daysAhead: 2, status: 'Pending' });
    t.createAppointment(user, { pet, service: 'Checkup', daysAhead: 6, status: 'Approved' });
    t.createAppointment(user, { pet, service: 'Dog & Cat Full Check Up', daysAhead: 3, status: 'Cancelled' });
    t.createAppointment(user, { pet, service: 'Dog & Cat Full Check Up', daysAhead: 9, status: 'Pending' });
    t.createAppointment(user, { pet, service: 'Bath', daysAhead: 2, status: 'Pending' });

    for (const url of ['/admin/analytics/summary', '/admin/dashboard/stats', '/admin/dashboard/overview']) {
      const response = await t.api('GET', `${url}?user_id=${admin.id}`, { token: admin.token });
      assert.equal(response.status, 200, url);
      assert.equal(response.body.summary.upcomingCheckups, start + 2, url);
    }
  });
});
