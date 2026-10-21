// What each dashboard section may load and change, checked against the real app (helpers/harness.js: in-memory
// database, no real services):
// - Pet Owner Dashboard: every endpoint its four sections use returns only the signed-in owner's records, and an
//   owner who changes the user_id (query, X-User-ID header or body) or a pet id gets nothing of another owner's.
// - Admin Dashboard: the writes its sections make (status changes, medical records, roles, messages) are refused for
//   pet owners and signed-out visitors and change nothing; approvals follow the server's transition and schedule rules
//   (including earlier "Checkup" appointments with their saved duration); the owner sees the server's result.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

describe('Pet Owner Dashboard sections load only the signed-in owner\'s records', () => {
  it('Overview, My Pets, Appointments and Pet Health refuse another owner\'s id in the query or the X-User-ID header', async () => {
    const owner = t.createUser({ name: 'Owner A' });
    const other = t.createUser({ name: 'Owner B' });
    t.createAppointment(owner, { pet: t.createPet(owner, 'Mochi') });

    const ownerEndpoints = [
      `/auth/user-status?user_id=${owner.id}&include=profile`,
      `/pets/userPets?user_id=${owner.id}`,
      `/appointments/userAppointments?user_id=${owner.id}`,
      `/pets/medical-records?user_id=${owner.id}`,
      `/auth/activity-logs?user_id=${owner.id}`
    ];
    for (const url of ownerEndpoints) {
      assert.equal((await t.api('GET', url, { token: owner.token })).status, 200, `${url} works for its owner`);
      assert.equal((await t.api('GET', url, { token: other.token })).status, 403, `${url} with another owner's id`);
      const ownId = url.replace(owner.id, other.id);
      assert.equal((await t.api('GET', ownId, { token: other.token, headers: { 'X-User-ID': owner.id } })).status, 403, `${url} with the header`);
      assert.equal((await t.api('GET', url)).status, 401, `${url} signed out`);
    }
  });

  it('each list holds only the owner\'s own pets, appointments and records', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
    const owner = t.createUser({ name: 'Owner A' });
    const other = t.createUser({ name: 'Owner B' });
    const ownerPet = t.createPet(owner, 'Mochi');
    const otherPet = t.createPet(other, 'Kuro');
    const ownerVisit = t.createAppointment(owner, { pet: ownerPet, daysAhead: 6, status: 'Completed' });
    t.createAppointment(other, { pet: otherPet, daysAhead: 7 });
    const created = await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, {
      token: admin.token,
      body: { pet_id: ownerPet.id, appointment_id: ownerVisit.id, record_date: t.manilaDate(6), weight: 10, vaccination_status: 'Up to date', treatment: 'Bath', medical_notes: 'Test note' }
    });
    assert.equal(created.status, 201);

    const pets = await t.api('GET', `/pets/userPets?user_id=${other.id}`, { token: other.token });
    assert.deepEqual(pets.body.pets.map(pet => pet.name), ['Kuro']);
    const appointments = await t.api('GET', `/appointments/userAppointments?user_id=${other.id}`, { token: other.token });
    assert.deepEqual(appointments.body.appointments.map(appointment => appointment.pet_name), ['Kuro']);
    const records = await t.api('GET', `/pets/medical-records?user_id=${other.id}`, { token: other.token });
    assert.deepEqual(records.body.records, [], 'another owner\'s record is never listed');
    // Asking for the other owner's pet by id
    assert.equal((await t.api('GET', `/pets/medical-records?user_id=${other.id}&pet_id=${ownerPet.id}`, { token: other.token })).status, 404);
    // The owner reads it, attributed to the admin who recorded it
    const ownerRecords = await t.api('GET', `/pets/medical-records?user_id=${owner.id}&pet_id=${ownerPet.id}`, { token: owner.token });
    assert.equal(ownerRecords.body.records.length, 1);
    assert.equal(ownerRecords.body.records[0].created_by_name, 'Clinic Admin');
  });

  it('My Pets cannot add a pet for, or delete a pet of, another owner; owners cannot write medical records', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const pet = t.createPet(owner, 'Mochi');

    assert.equal((await t.api('POST', '/pets/create', { token: other.token, body: { user_id: owner.id, name: 'Intruder', species: 'Dog' } })).status, 403);
    assert.equal((await t.api('DELETE', `/pets/delete/${pet.id}?user_id=${other.id}`, { token: other.token })).status, 404);
    assert.ok(t.db.find('pets', row => row.id === pet.id), 'the pet is still there');
    assert.equal(t.db.table('pets').filter(row => row.name === 'Intruder').length, 0);

    const recordBody = { user_id: owner.id, pet_id: pet.id, record_date: t.manilaDate(0), weight: 5 };
    assert.equal((await t.api('POST', '/pets/medical-records/create', { token: owner.token, body: recordBody })).status, 403);
    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${owner.id}`, { token: owner.token, body: recordBody })).status, 403);
    assert.equal(t.db.table('medical_records').filter(row => row.pet_id === pet.id).length, 0);
  });
});

describe('Admin Dashboard operations are for administrators only', () => {
  it('pet owners and signed-out visitors are refused every write the four sections make, and nothing changes', async () => {
    const owner = t.createUser();
    const visit = t.createAppointment(owner, { daysAhead: 9 });
    const writes = [
      ['PUT', '/admin/dashboard/appointment-status', { id: visit.id, status: 'Approved' }],
      ['POST', '/admin/dashboard/medical-records/create', { pet_id: visit.pet_id, record_date: t.manilaDate(0) }],
      ['PUT', '/admin/dashboard/user-role', { id: owner.id, role: 'admin' }],
      ['PUT', '/admin/dashboard/contact-message-status', { id: 'any', status: 'Read' }],
      ['PUT', '/appointments/updateStatus', { id: visit.id, status: 'Approved' }]
    ];
    for (const [method, route, body] of writes) {
      assert.equal((await t.api(method, `${route}?user_id=${owner.id}`, { token: owner.token, body })).status, 403, `${route} as an owner`);
      assert.equal((await t.api(method, route, { body })).status, 401, `${route} signed out`);
    }
    for (const route of ['/admin/dashboard/overview', '/admin/system-logs', '/admin/dashboard/contact-messages']) {
      assert.equal((await t.api('GET', `${route}?user_id=${owner.id}`, { token: owner.token })).status, 403, route);
    }
    assert.equal(t.appointmentRow(visit.id).status, 'Pending');
    assert.equal(t.db.find('users', row => row.id === owner.id).role, 'user');
  });

  it('Appointment Management: the server applies the schedule and status rules, and the owner sees its result', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
    const owner = t.createUser();
    const pet = t.createPet(owner, 'Mochi');
    const setStatus = (id, status) => t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id, status } });
    const ownerStatus = async id => (await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token }))
      .body.appointments.find(appointment => appointment.id === id);

    // An earlier "Checkup" appointment keeps its saved 45 minutes in the schedule check
    t.createAppointment(owner, { pet, daysAhead: 12, time: '09:00:00', service: 'Checkup', duration: 45, status: 'Approved' });
    const overlapping = t.createAppointment(owner, { pet, daysAhead: 12, time: '09:30:00', service: 'Bath', duration: 60 });
    const refused = await setStatus(overlapping.id, 'Approved');
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'Selected time is unavailable.');
    assert.equal(refused.body.suggested_time, '09:45');
    assert.equal(t.appointmentRow(overlapping.id).status, 'Pending', 'a refused approval changes nothing');
    assert.equal((await ownerStatus(overlapping.id)).status, 'Pending');

    const free = t.createAppointment(owner, { pet, daysAhead: 12, time: '14:00:00', service: 'Bath', duration: 60 });
    const approved = await setStatus(free.id, 'Approved');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.appointment.status, 'Approved');
    const seenByOwner = await ownerStatus(free.id);
    assert.equal(seenByOwner.status, 'Approved');
    assert.equal(seenByOwner.handled_by_name, 'Clinic Admin');

    // Declining a request is recorded as Cancelled; final statuses cannot change again
    assert.equal((await setStatus(overlapping.id, 'Cancelled')).status, 200);
    assert.equal((await ownerStatus(overlapping.id)).status, 'Cancelled');
    assert.equal((await setStatus(overlapping.id, 'Approved')).status, 400);
    assert.equal((await setStatus(free.id, 'Pending')).status, 400);
    assert.equal(t.appointmentRow(free.id).status, 'Approved');
    await t.settleEmails();
  });

  it('Pet & Medical Records: a record is attributed to the signed-in admin and cannot claim another creator', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
    const otherAdmin = t.createUser({ role: 'admin', name: 'Other Admin' });
    const owner = t.createUser();
    const pet = t.createPet(owner, 'Luna');
    const visit = t.createAppointment(owner, { pet, daysAhead: 2, status: 'Completed' });
    const body = { pet_id: pet.id, appointment_id: visit.id, record_date: t.manilaDate(2), weight: 4.2, vaccination_status: 'Due soon', treatment: 'Check-up', medical_notes: 'Test note' };

    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body: { ...body, created_by: otherAdmin.id } })).status, 400);
    const created = await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body });
    assert.equal(created.status, 201);
    assert.equal(created.body.record.created_by, admin.id);
    assert.deepEqual(
      Object.keys(created.body.record).filter(key => !['id', 'appointment_id', 'has_medical_record', 'medical_record_action_completed'].includes(key)).sort(),
      ['created_at', 'created_by', 'medical_notes', 'pet_id', 'record_date', 'treatment', 'vaccination_status', 'weight'],
      'only the medical_records columns are stored'
    );
  });
});
