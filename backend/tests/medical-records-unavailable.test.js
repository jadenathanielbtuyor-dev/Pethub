// When the medical records can't be read, the admin overview and the owner's pet list still load, but they report the
// records as unavailable instead of as zero. Checked against the real app with the MOCKED in-memory database
// (helpers/harness.js: no Supabase, no network; all names and values are made-up test data):
// - GET /admin/dashboard/overview: medicalRecordsAvailable false, record totals and per-pet counts null, and a completed
//   appointment is 'unavailable' (not 'none'), so the dashboard never offers to add a record that may already exist
// - GET /pets/userPets: each pet has medical_records_available false and null record count / latest weight
// - when the records load, both report them as available with their real counts
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

// The error PostgREST returned live while medical_records lacked the column the backend selects (2026-10-23 logs)
const MISSING_COLUMN = { code: '42703', message: 'column medical_records.appointment_id does not exist' };

function seedCompletedVisitWithRecord(admin, owner) {
  const pet = t.createPet(owner, 'Mochi');
  const visit = t.createAppointment(owner, { pet, daysAhead: -10, status: 'Completed' });
  t.db.seed('medical_records', {
    pet_id: pet.id, appointment_id: visit.id, record_date: t.manilaDate(-10), created_by: admin.id, weight: 12.4,
    vaccination_status: 'Up to date', treatment: 'Deworming', medical_notes: 'Healthy.'
  });
  return { pet, visit };
}

describe('Admin overview when the medical records cannot be read', () => {
  it('reports the records as unavailable, not as zero, and marks completed visits unavailable', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner A' });
    const { pet, visit } = seedCompletedVisitWithRecord(admin, owner);

    t.db.failNext({ table: 'medical_records', action: 'select' }, MISSING_COLUMN);
    const response = await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });

    assert.equal(response.status, 200, 'the rest of the dashboard still loads');
    assert.equal(response.body.medicalRecordsAvailable, false);
    assert.equal(response.body.summary.totalMedicalRecords, null);
    assert.equal(response.body.stats.totalMedicalRecords, null);
    assert.deepEqual(response.body.medicalRecords, []);
    assert.equal(response.body.pets.find(item => item.id === pet.id).medical_record_count, null);
    const listed = response.body.appointments.find(item => item.id === visit.id);
    assert.equal(listed.medical_record_link_status, 'unavailable');
    assert.equal(listed.has_medical_record, false);
  });

  it('reports the records as available, with their real counts, when they load', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner B' });
    const { pet, visit } = seedCompletedVisitWithRecord(admin, owner);

    const response = await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });

    assert.equal(response.status, 200);
    assert.equal(response.body.medicalRecordsAvailable, true);
    assert.ok(response.body.summary.totalMedicalRecords >= 1);
    assert.equal(response.body.pets.find(item => item.id === pet.id).medical_record_count, 1);
    assert.equal(response.body.appointments.find(item => item.id === visit.id).medical_record_link_status, 'linked');
  });
});

describe("Owner's pet list when the medical records cannot be read", () => {
  it('still lists the pets, with record figures marked unavailable instead of zero', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner C' });
    const { pet } = seedCompletedVisitWithRecord(admin, owner);

    t.db.failNext({ table: 'medical_records', action: 'select' }, MISSING_COLUMN);
    const response = await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: owner.token });

    assert.equal(response.status, 200);
    const listed = response.body.pets.find(item => item.id === pet.id);
    assert.equal(listed.name, 'Mochi');
    assert.equal(listed.medical_records_available, false);
    assert.equal(listed.medical_record_count, null);
    assert.equal(listed.latest_weight, null);
    assert.equal(listed.latest_medical_record_date, null);
  });

  it('reports the real count and official weight when the records load', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner D' });
    const { pet } = seedCompletedVisitWithRecord(admin, owner);

    const response = await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: owner.token });

    assert.equal(response.status, 200);
    const listed = response.body.pets.find(item => item.id === pet.id);
    assert.equal(listed.medical_records_available, true);
    assert.equal(listed.medical_record_count, 1);
    assert.equal(Number(listed.latest_weight.value), 12.4);
  });
});
