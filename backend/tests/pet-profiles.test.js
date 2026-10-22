// Pet profiles on My Pets, against the real Express app with the MOCKED in-memory database (helpers/harness.js: no
// Supabase, no network; every name and value below is made-up test data):
// - registering a pet; a likely duplicate inside one owner's account is shown and not saved until the owner confirms
//   a different pet (never merged); two different pets may share a name; other accounts are never compared or shown
// - the age rule (whole years from 1 to 25) on create and edit, and saved ages outside it left alone
// - editing a profile: only name, species, breed and age, only on the owner's own pet
// - one pet's history: appointments (by pet_id) and official medical records kept apart, newest first, and the latest
//   weight an official record holds (never a made-up one)
// - older appointments saved without a pet_id are never matched to a pet by name
// - booking with an existing pet's id (never creating a pet, never another owner's pet, schedule checks unchanged)
// - deleting only a profile that no appointment or medical record points to
// - official medical records still written by administrators only
// - the server logs of these requests hold no pet names, notes or weights
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');
const { PET_AGE_MIN_YEARS, PET_AGE_MAX_YEARS, PET_AGE_RANGE_MESSAGE } = require('../constants/pets');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const seedPet = (user, fields = {}) => t.db.seed('pets', { user_id: user.id, name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, ...fields });
const petsOf = user => t.db.table('pets').filter(pet => pet.user_id === user.id);
const petRow = petId => t.db.find('pets', pet => pet.id === petId);
const createPet = (user, fields = {}, token = user.token) => t.api('POST', '/pets/create', {
  token,
  body: { user_id: user.id, name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, ...fields }
});
const updatePet = (user, petId, fields, token = user.token) => t.api('PUT', `/pets/update/${petId}`, { token, body: { user_id: user.id, ...fields } });
const getHistory = (user, petId, token = user.token) => t.api('GET', `/pets/history/${petId}?user_id=${user.id}`, { token });
const seedRecord = (pet, fields = {}) => t.db.seed('medical_records', {
  pet_id: pet.id, record_date: t.manilaDate(-10), created_by: null, weight: null, vaccination_status: 'Up to date', treatment: null, medical_notes: 'Test note', ...fields
});

describe('Registering a new pet', () => {
  it('saves a validated profile for the signed-in owner and returns it', async () => {
    const owner = t.createUser();
    const created = await createPet(owner, { name: '  Bantay  ', species: 'dog', breed: '', age: '4' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.pet.user_id, owner.id);
    const row = petRow(created.body.pet.id);
    assert.deepEqual({ name: row.name, species: row.species, breed: row.breed, age: row.age }, { name: 'Bantay', species: 'Dog', breed: null, age: 4 });
  });

  it('a likely duplicate is shown, not saved, until the owner confirms it is a different pet', async () => {
    const owner = t.createUser();
    const existing = seedPet(owner);
    const before = { ...existing };

    const asked = await createPet(owner, { name: ' MOCHI ', species: 'dog', breed: 'aspin', age: 3 });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.code, 'POSSIBLE_DUPLICATE_PET');
    assert.equal(asked.body.possible_duplicates.length, 1);
    assert.equal(asked.body.possible_duplicates[0].id, existing.id);
    assert.deepEqual(Object.keys(asked.body.possible_duplicates[0]).sort(), ['age', 'breed', 'created_at', 'id', 'name', 'species'],
      'only the owner\'s own profile details are shown');
    assert.equal(petsOf(owner).length, 1, 'nothing was saved');

    const confirmed = await createPet(owner, { name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, confirm_not_duplicate: true });
    assert.equal(confirmed.status, 201);
    assert.notEqual(confirmed.body.pet.id, existing.id, 'a separate profile, never merged into the existing one');
    assert.equal(petsOf(owner).length, 2);
    assert.deepEqual(petRow(existing.id), before, 'the existing profile is unchanged');
  });

  it('a blank breed, or an age that has grown since the profile was added, still counts as a likely match', async () => {
    const owner = t.createUser();
    seedPet(owner, { breed: null, age: 2, created_at: new Date(Date.now() - 2.2 * YEAR_MS).toISOString() });
    assert.equal((await createPet(owner, { breed: 'Aspin', age: 4 })).status, 409, 'saved age 2, added two years ago: 4 now');
    assert.equal(petsOf(owner).length, 1);
  });

  it('two different pets may share a name: another species, breed or a clearly different age is saved without a question', async () => {
    const owner = t.createUser();
    seedPet(owner, { name: 'Max', species: 'Dog', breed: 'Aspin', age: 3 });
    for (const fields of [{ species: 'Cat', breed: 'Puspin' }, { breed: 'Beagle' }, { age: 12 }]) {
      const created = await createPet(owner, { name: 'Max', species: 'Dog', breed: 'Aspin', age: 3, ...fields });
      assert.equal(created.status, 201, JSON.stringify(fields));
    }
    assert.equal(petsOf(owner).filter(pet => pet.name === 'Max').length, 4);
  });

  it('only the owner\'s own profiles are compared: another account\'s matching pet is never revealed or moved', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const othersPet = seedPet(other);
    const created = await createPet(owner);
    assert.equal(created.status, 201);
    assert.doesNotMatch(created.text, new RegExp(othersPet.id));
    assert.doesNotMatch(created.text, new RegExp(other.id));
    assert.equal(petRow(othersPet.id).user_id, other.id);
  });

  it('two identical submits at the same moment save one profile; the other is answered as a likely duplicate', async () => {
    const owner = t.createUser();
    const answers = await Promise.all([createPet(owner), createPet(owner)]);
    assert.deepEqual(answers.map(answer => answer.status).sort(), [201, 409]);
    assert.equal(petsOf(owner).length, 1);
  });

  it('cannot add a pet to another account, and signed-out requests are refused', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    assert.equal((await t.api('POST', '/pets/create', { token: owner.token, body: { user_id: other.id, name: 'Intruder', species: 'Dog', age: 2 } })).status, 403);
    assert.equal((await t.api('POST', '/pets/create', { body: { user_id: owner.id, name: 'Mochi', species: 'Dog', age: 2 } })).status, 401);
    assert.equal(petsOf(other).length, 0);
  });
});

describe('Age: whole years from 1 to 25, checked by the server', () => {
  it('is the configured range, and 1 and 25 are accepted', async () => {
    assert.equal(PET_AGE_MIN_YEARS, 1);
    assert.equal(PET_AGE_MAX_YEARS, 25);
    const owner = t.createUser();
    const accepted = [1, 25, '1', '25', ' 7 '];
    for (const [index, age] of accepted.entries()) {
      const created = await createPet(owner, { name: `Pet ${index}`, age });
      assert.equal(created.status, 201, `age ${JSON.stringify(age)}`);
      assert.equal(created.body.pet.age, Number(String(age).trim()));
    }
  });

  it('0, 26, negative numbers, decimals, text, other types and an empty age are refused and nothing is saved', async () => {
    const owner = t.createUser();
    const refused = [0, 26, -1, 100, 2.5, '2.5', '3.0', '-3', '+3', '1e1', 'abc', 'three', '', '   ', null, true, [3], {}];
    for (const age of refused) {
      const response = await createPet(owner, { age });
      assert.equal(response.status, 400, `age ${JSON.stringify(age)}`);
      assert.equal(response.body.field, 'age', `age ${JSON.stringify(age)}`);
    }
    const missing = await t.api('POST', '/pets/create', { token: owner.token, body: { user_id: owner.id, name: 'Mochi', species: 'Dog' } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.field, 'age');
    assert.match(missing.body.error, /whole years \(1 to 25\)/);
    assert.equal((await createPet(owner, { age: 26 })).body.error, PET_AGE_RANGE_MESSAGE);
    assert.doesNotMatch(PET_AGE_RANGE_MESSAGE, /lifespan|live/i, 'the range is an entry rule, not a lifespan claim');
    assert.equal(petsOf(owner).length, 0);
  });

  it('edits use the same rule; a saved age outside it is kept until the age or the species is changed', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner, { age: 30 });
    for (const age of [0, 26, 2.5, '3.0', 'abc', '', null]) {
      const response = await updatePet(owner, pet.id, { age });
      assert.equal(response.status, 400, `age ${JSON.stringify(age)}`);
      assert.equal(response.body.field, 'age');
    }
    assert.equal(petRow(pet.id).age, 30);

    assert.equal((await updatePet(owner, pet.id, { name: 'Rex' })).status, 200);
    assert.equal(petRow(pet.id).age, 30, 'a name change leaves the saved age alone');

    const speciesOnly = await updatePet(owner, pet.id, { species: 'Cat', breed: 'Puspin' });
    assert.equal(speciesOnly.status, 400, 'a new species needs an age in the range');
    assert.equal(speciesOnly.body.field, 'age');
    assert.equal(petRow(pet.id).species, 'Dog');

    assert.equal((await updatePet(owner, pet.id, { species: 'Cat', breed: 'Puspin', age: 12 })).status, 200);
    assert.deepEqual([petRow(pet.id).species, petRow(pet.id).age], ['Cat', 12]);
  });
});

describe('Editing a pet profile', () => {
  it('changes only the fields sent, on the owner\'s own pet', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    const before = { ...pet };
    const saved = await updatePet(owner, pet.id, { name: 'Mochi Jr', breed: '' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.pet.name, 'Mochi Jr');
    assert.deepEqual(petRow(pet.id), { ...before, name: 'Mochi Jr', breed: null });
  });

  it('never writes anything but profile details, and cannot move a pet to another account', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = seedPet(owner);
    const before = { ...pet };

    const extras = await updatePet(owner, pet.id, { name: 'Mochi', id: other.id, created_at: '2000-01-01T00:00:00Z', weight: 99 });
    assert.equal(extras.status, 200);
    assert.deepEqual(petRow(pet.id), before, 'id, created_at and record fields are ignored');

    const recordFields = await updatePet(owner, pet.id, { weight: 99, vaccination_status: 'Up to date', treatment: 'None', medical_notes: 'x' });
    assert.equal(recordFields.status, 400);
    assert.equal(t.db.table('medical_records').filter(record => record.pet_id === pet.id).length, 0);

    assert.equal((await t.api('PUT', `/pets/update/${pet.id}`, { token: owner.token, body: { user_id: other.id, name: 'Moved' } })).status, 403);
    assert.equal(petRow(pet.id).user_id, owner.id);
  });

  it('another owner\'s pet cannot be edited, an id that is not a pet is not found, and signed-out requests are refused', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = seedPet(owner);
    const before = { ...pet };
    assert.equal((await updatePet(other, pet.id, { name: 'Stolen' })).status, 404);
    assert.equal((await updatePet(owner, 'not-a-pet-id', { name: 'Rex' })).status, 404);
    assert.equal((await t.api('PUT', `/pets/update/${pet.id}`, { body: { user_id: owner.id, name: 'Rex' } })).status, 401);
    assert.deepEqual(petRow(pet.id), before);
  });

  it('changing a profile to look like another of the owner\'s profiles asks first', async () => {
    const owner = t.createUser();
    seedPet(owner);
    const luna = seedPet(owner, { name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2 });
    const before = { ...luna };
    const asked = await updatePet(owner, luna.id, { name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3 });
    assert.equal(asked.status, 409);
    assert.equal(asked.body.code, 'POSSIBLE_DUPLICATE_PET');
    assert.deepEqual(petRow(luna.id), before);
    assert.equal((await updatePet(owner, luna.id, { name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, confirm_not_duplicate: true })).status, 200);
    assert.equal(petsOf(owner).length, 2);
  });
});

describe('One pet\'s history', () => {
  it('lists the pet\'s appointments and its official medical records separately, newest first, for that pet only', async () => {
    const owner = t.createUser();
    const mochi = seedPet(owner);
    const luna = seedPet(owner, { name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2 });
    const past = t.createAppointment(owner, { pet: mochi, daysAhead: -30, status: 'Completed', service: 'Bath' });
    const morning = t.createAppointment(owner, { pet: mochi, daysAhead: 5, time: '10:00:00', service: 'Trim' });
    const afternoon = t.createAppointment(owner, { pet: mochi, daysAhead: 5, time: '14:00:00', service: 'Nail Cutting' });
    t.createAppointment(owner, { pet: luna, daysAhead: 6 });
    const oldest = seedRecord(mochi, { record_date: t.manilaDate(-40), weight: 12.1 });
    const newestWithoutWeight = seedRecord(mochi, { record_date: t.manilaDate(-10), weight: null });
    const weighed = seedRecord(mochi, { record_date: t.manilaDate(-20), weight: 12.5 });
    seedRecord(luna, { weight: 4 });

    const response = await getHistory(owner, mochi.id);
    assert.equal(response.status, 200);
    assert.equal(response.body.pet.id, mochi.id);
    assert.deepEqual(response.body.appointments.map(appointment => appointment.id), [afternoon.id, morning.id, past.id]);
    assert.deepEqual(response.body.medical_records.map(record => record.id), [newestWithoutWeight.id, weighed.id, oldest.id]);
    assert.ok(response.body.appointments.every(appointment => appointment.pet_id === mochi.id && !('weight' in appointment)));
    assert.ok(response.body.medical_records.every(record => record.pet_id === mochi.id && !('status' in record)));
    assert.deepEqual(response.body.latest_weight, { value: 12.5, unit: 'kg', record_date: t.manilaDate(-20), record_id: weighed.id },
      'the newest record that has a weight; a newer record without one is skipped');
  });

  it('never makes up a weight: no records, or records without a weight, give null', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    let response = await getHistory(owner, pet.id);
    assert.deepEqual([response.body.appointments, response.body.medical_records, response.body.latest_weight], [[], [], null]);

    seedRecord(pet, { weight: null });
    response = await getHistory(owner, pet.id);
    assert.equal(response.body.medical_records.length, 1);
    assert.equal(response.body.latest_weight, null);
    const listed = await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: owner.token });
    assert.equal(listed.body.pets[0].latest_weight, null);
  });

  it('GET /pets/userPets shows each pet\'s latest recorded weight', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    seedRecord(pet, { record_date: t.manilaDate(-30), weight: 11.8 });
    seedRecord(pet, { record_date: t.manilaDate(-3), weight: 12.4 });
    const listed = await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: owner.token });
    assert.deepEqual(listed.body.pets[0].latest_weight, { value: 12.4, unit: 'kg', record_date: t.manilaDate(-3), record_id: listed.body.pets[0].latest_weight.record_id });
    assert.equal(listed.body.pets[0].medical_record_count, 2);
  });

  it('owner-reported weight is dated, owner-scoped, and separate from official clinical weight', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = seedPet(owner);
    seedRecord(pet, { weight: 8.3, record_date: t.manilaDate(-2) });
    const medicalRecordCount = t.db.table('medical_records').length;

    const saved = await t.api('POST', `/pets/${pet.id}/weight-reports`, { token: owner.token, body: { weight_kg: 9.45 } });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.measurement.pet_id, pet.id);
    assert.equal(saved.body.measurement.user_id, owner.id);
    assert.equal(Number(saved.body.measurement.weight_kg), 9.45);
    assert.equal(saved.body.measurement.source, 'owner_reported');
    assert.ok(saved.body.measurement.recorded_at);
    assert.equal(t.db.table('medical_records').length, medicalRecordCount, 'the clinical table was not changed or appended to');

    const history = await getHistory(owner, pet.id);
    assert.equal(history.body.owner_measurement_history_available, true);
    assert.equal(history.body.owner_measurement_history_supported, true);
    assert.equal(Number(history.body.owner_reported_measurements[0].weight_kg), 9.45);
    assert.deepEqual(history.body.latest_weight, { value: 8.3, unit: 'kg', record_date: t.manilaDate(-2), record_id: history.body.latest_weight.record_id });

    const denied = await t.api('POST', `/pets/${pet.id}/weight-reports`, { token: other.token, body: { weight_kg: 12 } });
    assert.equal(denied.status, 404);
    assert.equal(t.db.table('owner_pet_weight_reports').length, 1);
    assert.equal((await t.api('POST', `/pets/${pet.id}/weight-reports`, { token: owner.token, body: { weight_kg: 0 } })).status, 400);
  });

  it('another owner\'s pet history is not found, and another account\'s id or a signed-out request is refused', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = seedPet(owner);
    seedRecord(pet, { weight: 9 });
    const asOther = await getHistory(other, pet.id);
    assert.equal(asOther.status, 404);
    assert.doesNotMatch(asOther.text, /Test note|"weight"/);
    assert.equal((await t.api('GET', `/pets/history/${pet.id}?user_id=${owner.id}`, { token: other.token })).status, 403);
    assert.equal((await t.api('GET', `/pets/history/${pet.id}?user_id=${owner.id}`)).status, 401);
    assert.equal((await getHistory(owner, 'not-a-pet-id')).status, 404);
  });
});

describe('Older appointments saved without a pet_id', () => {
  it('are never matched to a pet by name, even an ambiguous one, and stay on the owner\'s list unchanged', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const firstMax = seedPet(owner, { name: 'Max', breed: 'Aspin', age: 3 });
    const secondMax = seedPet(owner, { name: 'Max', breed: 'Beagle', age: 9 });
    const legacy = t.db.seed('appointments', {
      user_id: owner.id, pet_id: null, pet_name: 'Max', service_type: 'Checkup', estimated_duration_minutes: 45,
      appointment_date: t.manilaDate(-60), appointment_time: '09:00:00', status: 'Completed'
    });
    t.db.seed('appointments', {
      user_id: other.id, pet_id: null, pet_name: 'Max', service_type: 'Checkup', estimated_duration_minutes: 45,
      appointment_date: t.manilaDate(-50), appointment_time: '09:00:00', status: 'Completed'
    });
    const before = { ...legacy };

    for (const pet of [firstMax, secondMax]) {
      const response = await getHistory(owner, pet.id);
      assert.deepEqual(response.body.appointments, [], `${pet.breed} Max gets no appointment by name`);
      assert.equal(response.body.unlinked_appointment_count, 1, 'only the owner\'s own unlinked appointment is counted');
    }
    const list = await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token });
    const listed = list.body.appointments.find(appointment => appointment.id === legacy.id);
    assert.equal(listed.pet_id, null);
    assert.equal(listed.pet_name, 'Max');
    assert.deepEqual(t.appointmentRow(legacy.id), before, 'the stored appointment is untouched');
  });
});

describe('Booking uses the existing pet profile', () => {
  const book = (user, petId, fields = {}) => t.api('POST', '/appointments/create', {
    token: user.token,
    body: { user_id: user.id, pet_id: petId, service_type: 'Bath', appointment_date: t.manilaDate(15), appointment_time: '10:00', ...fields }
  });

  it('books with the selected pet\'s id, keeps pet_name, and never creates a pet', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    const petCount = t.db.table('pets').length;
    const booked = await book(owner, pet.id);
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.equal(booked.body.appointment.pet_id, pet.id);
    assert.equal(booked.body.appointment.pet_name, 'Mochi');
    assert.equal(t.db.table('pets').length, petCount);
    const response = await getHistory(owner, pet.id);
    assert.deepEqual(response.body.appointments.map(appointment => appointment.id), [booked.body.appointment.id]);
  });

  it('another owner\'s pet id is refused and nothing is booked', async () => {
    const owner = t.createUser();
    const othersPet = seedPet(t.createUser(), { name: 'Kuro' });
    const refused = await book(owner, othersPet.id);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.error, 'Selected pet was not found for this user.');
    assert.equal(t.db.table('appointments').filter(appointment => appointment.pet_id === othersPet.id).length, 0);
  });

  it('the schedule and service checks still apply to a booking for a registered pet', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    t.createAppointment(t.createUser(), { daysAhead: 16, time: '10:00:00', service: 'Bath', duration: 60, status: 'Approved' });
    const conflict = await book(owner, pet.id, { appointment_date: t.manilaDate(16), appointment_time: '10:30' });
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.error, 'Selected time is unavailable.');
    assert.equal((await book(owner, pet.id, { service_type: 'Not a service' })).status, 400);
    assert.equal(t.db.table('appointments').filter(appointment => appointment.pet_id === pet.id).length, 0);
  });
});

describe('Deleting a pet profile', () => {
  it('a profile with no history can be deleted by its owner', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    const deleted = await t.api('DELETE', `/pets/delete/${pet.id}?user_id=${owner.id}`, { token: owner.token });
    assert.equal(deleted.status, 200);
    assert.equal(petRow(pet.id), undefined);
  });

  it('a profile that appointments or official medical records point to is kept, and nothing is removed', async () => {
    const owner = t.createUser();
    const booked = seedPet(owner);
    const visit = t.createAppointment(owner, { pet: booked, daysAhead: -5, status: 'Completed' });
    const recorded = seedPet(owner, { name: 'Luna', species: 'Cat', age: 2 });
    const record = seedRecord(recorded, { weight: 4.2 });

    const first = await t.api('DELETE', `/pets/delete/${booked.id}?user_id=${owner.id}`, { token: owner.token });
    assert.equal(first.status, 409);
    assert.equal(first.body.code, 'PET_HAS_HISTORY');
    assert.deepEqual([first.body.appointment_count, first.body.medical_record_count], [1, 0]);
    assert.match(first.body.error, /holds 1 appointment for it/);
    assert.doesNotMatch(first.body.error, /Mochi/, 'the message (which is logged) does not name the pet');

    const second = await t.api('DELETE', `/pets/delete/${recorded.id}?user_id=${owner.id}`, { token: owner.token });
    assert.equal(second.status, 409);
    assert.deepEqual([second.body.appointment_count, second.body.medical_record_count], [0, 1]);

    assert.ok(petRow(booked.id) && petRow(recorded.id), 'both profiles are kept');
    assert.ok(t.appointmentRow(visit.id));
    assert.ok(t.db.find('medical_records', row => row.id === record.id));
  });

  it('a profile with owner-reported measurement history is also kept', async () => {
    const owner = t.createUser();
    const pet = seedPet(owner);
    assert.equal((await t.api('POST', `/pets/${pet.id}/weight-reports`, { token: owner.token, body: { weight_kg: 5.5 } })).status, 201);
    const deleted = await t.api('DELETE', `/pets/delete/${pet.id}?user_id=${owner.id}`, { token: owner.token });
    assert.equal(deleted.status, 409);
    assert.equal(deleted.body.owner_measurement_count, 1);
    assert.ok(petRow(pet.id));
  });

  it('another owner cannot delete the pet, and an id that is not a pet is not found', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = seedPet(owner);
    assert.equal((await t.api('DELETE', `/pets/delete/${pet.id}?user_id=${other.id}`, { token: other.token })).status, 404);
    assert.equal((await t.api('DELETE', `/pets/delete/not-a-pet-id?user_id=${owner.id}`, { token: owner.token })).status, 404);
    assert.ok(petRow(pet.id));
  });
});

describe('Official medical records stay administrator-only', () => {
  it('owners cannot write a record through any pet route; an admin\'s record appears read-only in the owner\'s history', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
    const owner = t.createUser();
    const pet = seedPet(owner);
    const visit = t.createAppointment(owner, { pet, daysAhead: -2, status: 'Completed' });
    const body = { pet_id: pet.id, appointment_id: visit.id, record_date: t.manilaDate(-2), weight: 10.4, vaccination_status: 'Up to date', treatment: 'Bath', medical_notes: 'Test note' };

    assert.equal((await t.api('POST', '/pets/medical-records/create', { token: owner.token, body: { ...body, user_id: owner.id } })).status, 403);
    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${owner.id}`, { token: owner.token, body })).status, 403);
    assert.equal(t.db.table('medical_records').filter(record => record.pet_id === pet.id).length, 0);

    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body })).status, 201);
    const response = await getHistory(owner, pet.id);
    assert.equal(response.body.medical_records.length, 1);
    assert.equal(response.body.medical_records[0].created_by_name, 'Clinic Admin');
    assert.deepEqual(response.body.latest_weight.value, 10.4);
  });
});

describe('Server logs', () => {
  it('hold no pet names, medical notes or weights from the requests above', () => {
    assert.ok(t.logs.length > 0, 'refused requests were logged');
    for (const line of t.logs) {
      // (weights as fields, not bare numbers: log timestamps such as 02:50:10.403Z contain digits too)
      assert.doesNotMatch(line, /Mochi|Luna|Bantay|Kuro|Test note|weight\W{0,3}\d/i, line);
    }
  });
});
