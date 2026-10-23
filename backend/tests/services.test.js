// The migration fixture contains initial metadata only; runtime services come from the persisted service catalog.
// MOCKED: the real Express app on the in-memory database (helpers/harness.js) with serviceDurations: null, so the
// catalog is used as shipped. Nothing talks to Supabase, Brevo or Gemini.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const APPROVED_SERVICES = [
  'Bath', 'Trim', 'Puppy Cut', 'Full Grooming', 'Nail Cutting', 'Face Trim', 'Flea and Tick Removal', 'Medicated Bath',
  'Dog & Cat Full Check Up'
];

let t;

before(async () => {
  t = await startTestApp({ serviceDurations: null });
});

after(async () => {
  await t.close();
});

describe('Service catalog as shipped', () => {
  it('keeps the migration fixture free of invented durations and leaves Puppy Cut species unconfirmed', () => {
    const { SERVICE_CATALOG, SERVICE_SPECIES, STANDARD_DURATION_MINUTES, LEGACY_SERVICE_NAMES } = require('../constants/services');
    assert.deepEqual(SERVICE_CATALOG.map(entry => entry.name), APPROVED_SERVICES);
    assert.deepEqual([...SERVICE_SPECIES], ['Dog', 'Cat']);
    SERVICE_CATALOG.forEach(entry => {
      assert.equal(entry.durationMinutes, null, `${entry.name}: no duration until the clinic confirms one`);
      assert.deepEqual([...entry.species], entry.name === 'Puppy Cut' ? [] : ['Dog', 'Cat'], `${entry.name}: species must reflect clinic confirmation`);
      assert.ok(entry.description && entry.description.length < 80, `${entry.name} has a short description`);
      assert.doesNotMatch(entry.description, /₱|php|peso|price|\d+\s*(min|hour)|guarantee|cure|best|#1/i, `${entry.name}: no price, time or claim`);
      assert.ok(!Object.keys(entry).some(key => /price|cost|fee/i.test(key)), `${entry.name} has no price field`);
    });
    assert.equal(STANDARD_DURATION_MINUTES, null);
    assert.equal(SERVICE_CATALOG.filter(entry => entry.category === 'veterinary').map(entry => entry.name).join(), 'Dog & Cat Full Check Up');
    APPROVED_SERVICES.forEach(name => assert.ok(!LEGACY_SERVICE_NAMES.includes(name), `${name} is not an earlier service`));
  });

  it('public and signed-in pages get the runtime catalog from GET /appointments/services', async () => {
    const user = t.createUser();
    const response = await t.api('GET', '/appointments/services', { token: user.token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.species, ['Dog', 'Cat']);
    assert.deepEqual(response.body.services.map(service => service.name), APPROVED_SERVICES);
    response.body.services.forEach(service => {
      assert.deepEqual(Object.keys(service).sort(), ['bookable', 'category', 'category_label', 'description', 'display_order', 'duration_minutes', 'id', 'name', 'online_booking_enabled', 'service_key', 'species', 'unavailable_reason']);
      assert.equal(service.bookable, false);
      assert.equal(service.online_booking_enabled, false);
      assert.equal(service.duration_minutes, null);
    });
    assert.equal(response.body.services.find(service => service.name === 'Dog & Cat Full Check Up').category_label, 'Veterinary check-up');
    assert.equal((await t.api('GET', '/appointments/services')).status, 200, 'the public Services page uses the same catalog');
  });

  it('refuses to book any service without a confirmed duration, creating nothing', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    for (const service of APPROVED_SERVICES) {
      const response = await t.api('POST', '/appointments/create', {
        token: user.token,
        body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: service, appointment_date: t.manilaDate(3), appointment_time: '10:00:00' }
      });
      assert.equal(response.status, 409, service);
      assert.match(response.body.error, /online booking is disabled/i);
    }
    assert.equal(t.db.table('appointments').length, 0);
  });

  it('earlier service names can no longer be booked', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    for (const service of ['Checkup', 'Vaccination', 'Grooming', 'Dental Cleaning', 'Surgery', 'Other', 'bath']) {
      const response = await t.api('POST', '/appointments/create', {
        token: user.token,
        body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: service, appointment_date: t.manilaDate(3), appointment_time: '10:00:00' }
      });
      assert.equal(response.status, 400, service);
      assert.equal(response.body.error, 'Select a valid service type.');
    }
  });

  it('an existing appointment for an earlier service can still be approved and completed', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const legacy = t.createAppointment(user, { service: 'Checkup', duration: 45, daysAhead: 4 });
    const approve = await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: legacy.id, status: 'Approved' } });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));
    assert.equal(t.appointmentRow(legacy.id).status, 'Approved');
    assert.equal(t.appointmentRow(legacy.id).estimated_duration_minutes, 45, 'the saved duration is kept');
    const complete = await t.api('PUT', '/admin/dashboard/appointment-status', { token: admin.token, body: { id: legacy.id, status: 'Completed' } });
    assert.equal(complete.status, 200);
    await t.settleEmails();
  });
});

describe('Everything that names the services uses the catalog', () => {
  it('the chatbot points to the live catalog and does not embed a fixed service list', () => {
    const ai = fs.readFileSync(path.join(__dirname, '..', 'services', 'aiService.js'), 'utf8');
    for (const name of APPROVED_SERVICES) assert.ok(!ai.includes(name), `the chatbot does not hard-code ${name}`);
    assert.match(ai, /live catalog and booking availability are on the \*\*Services\*\* page/);
    assert.doesNotMatch(ai, /\*\*Vaccination\*\*|\*\*Surgery\*\*|\*\*Dental\*\*|Dental Cleaning|🦜 Bird|🐰 Rabbit/, 'no unsupported services or species are offered');
    assert.doesNotMatch(ai, /₱\s*\d|PHP\s*\d|\d+\s*pesos/i, 'no prices');
  });

  it('the pet form offers only dogs and cats', () => {
    const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'user', 'pets.html'), 'utf8');
    const select = page.match(/<select id="petType"[\s\S]*?<\/select>/)[0];
    const values = [...select.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]).filter(Boolean);
    assert.deepEqual(values, ['Dog', 'Cat']);
  });

  it('the booking page takes its services from the API, not from a list of its own', () => {
    const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'user', 'appointments.html'), 'utf8');
    const select = page.match(/<select id="serviceType"[\s\S]*?<\/select>/)[0];
    assert.equal([...select.matchAll(/<option value="([^"]+)"/g)].length, 0, 'no hard-coded services');
    const script = fs.readFileSync(path.join(FRONTEND, 'js', 'user', 'appointments.js'), 'utf8');
    assert.match(script, /\/appointments\/services/);
    const shared = fs.readFileSync(path.join(FRONTEND, 'js', 'shared', 'appointment-durations.js'), 'utf8');
    assert.doesNotMatch(shared, /Checkup|Vaccination|Surgery|Dental/);
    assert.doesNotMatch(shared, /:\s*\d+\s*,/, 'no durations in the frontend');
  });

  it('the public Services page loads the same runtime catalog instead of repeating service details', () => {
    const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'public', 'services.html'), 'utf8');
    const script = fs.readFileSync(path.join(FRONTEND, 'js', 'public', 'services.js'), 'utf8');
    assert.match(page, /id="publicServiceCatalog"/);
    assert.match(page, /js\/public\/services\.js/);
    for (const name of APPROVED_SERVICES) assert.ok(!page.includes(name), `no static ${name} on the public page`);
    assert.match(script, /appointments\/services/);
  });
});
