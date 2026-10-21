// What the Admin Dashboard's Pet Owners & Records section is built from, checked against the real app with the MOCKED
// in-memory database (helpers/harness.js: no Supabase, no network; all names and values are made-up test data):
// - GET /admin/dashboard/overview ties every pet to its owner account and every appointment to the account that booked
//   it and to its pet by pet_id; an older appointment without a pet_id comes back unchanged and unlinked
// - account rows carry no password, verification code or other sign-in secret
// - only administrators can load these records
// - PetHub always keeps an administrator: the last one cannot be demoted, not even by themselves
// - GET /admin/system-logs never returns more than 200 entries per request
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

const overviewOf = admin => t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });
const setRole = (admin, id, role) => t.api('PUT', `/admin/dashboard/user-role?user_id=${admin.id}`, { token: admin.token, body: { id, role } });
const roleOf = userId => t.db.find('users', row => row.id === userId).role;
// Leaves `keep` as the only administrator in this file's database
function onlyAdmin(keep) {
  t.db.table('users').forEach(row => {
    if (row.role === 'admin' && row.id !== keep.id) row.role = 'user';
  });
}

describe('Owner, pet and appointment links in the admin records', () => {
  it('ties every pet to its owner and every appointment to its booking account and pet', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
    const owner = t.createUser({ name: 'Owner A' });
    const other = t.createUser({ name: 'Owner B' });
    const noPets = t.createUser({ name: 'Owner C' });
    const mochi = t.createPet(owner, 'Mochi');
    const luna = t.createPet(owner, 'Luna');
    const kuro = t.createPet(other, 'Kuro');
    const booked = t.createAppointment(owner, { pet: mochi, daysAhead: 4 });
    t.createAppointment(other, { pet: kuro, daysAhead: 5 });

    const response = await overviewOf(admin);
    assert.equal(response.status, 200);
    const { users, pets, appointments } = response.body;

    const ownerOf = petId => pets.find(pet => pet.id === petId);
    assert.deepEqual([mochi.id, luna.id].map(id => [ownerOf(id).user_id, ownerOf(id).owner_name]), [[owner.id, 'Owner A'], [owner.id, 'Owner A']]);
    assert.deepEqual([ownerOf(kuro.id).user_id, ownerOf(kuro.id).owner_name], [other.id, 'Owner B']);
    assert.ok(users.some(user => user.id === noPets.id), 'an owner without pets is listed too');
    assert.equal(pets.filter(pet => pet.user_id === noPets.id).length, 0);

    const listed = appointments.find(appointment => appointment.id === booked.id);
    assert.deepEqual([listed.user_id, listed.owner_fullname, listed.pet_id, listed.pet_name], [owner.id, 'Owner A', mochi.id, 'Mochi']);
  });

  it('an older appointment without a pet_id is returned unchanged and never linked by name', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner D' });
    t.createPet(owner, 'Max');
    t.createPet(owner, 'Max');
    const legacy = t.db.seed('appointments', {
      user_id: owner.id, pet_id: null, pet_name: 'Max', service_type: 'Checkup', estimated_duration_minutes: 45,
      appointment_date: t.manilaDate(-30), appointment_time: '09:00:00', status: 'Completed'
    });
    const before = { ...legacy };

    const listed = (await overviewOf(admin)).body.appointments.find(appointment => appointment.id === legacy.id);
    assert.equal(listed.pet_id, null);
    assert.equal(listed.pet_name, 'Max');
    assert.deepEqual(t.appointmentRow(legacy.id), before, 'the stored row is untouched');
  });

  it('account rows never carry a password, verification code or other sign-in secret', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser({ name: 'Owner E', password: 'scrypt$not-a-real-hash-but-secret' });
    t.db.seed('email_verifications', { user_id: owner.id, verification_code: '483920', expires_at: new Date(Date.now() + 600000).toISOString(), is_verified: false });

    for (const route of ['/admin/dashboard/overview', '/admin/dashboard/users']) {
      const response = await t.api('GET', `${route}?user_id=${admin.id}`, { token: admin.token });
      assert.equal(response.status, 200, route);
      const row = response.body.users.find(user => user.id === owner.id);
      assert.deepEqual(Object.keys(row).sort(), ['created_at', 'email', 'fullname', 'id', 'is_verified', 'role'], route);
      assert.doesNotMatch(response.text, /scrypt\$|not-a-real-hash|483920|"password"|verification_code/, route);
    }
  });

  it('pet owners and signed-out visitors cannot load the owner, pet, appointment or record lists', async () => {
    const owner = t.createUser();
    for (const route of ['/admin/dashboard/overview', '/admin/dashboard/users', '/admin/dashboard/pets', '/admin/dashboard/appointments']) {
      const asOwner = await t.api('GET', `${route}?user_id=${owner.id}`, { token: owner.token });
      assert.equal(asOwner.status, 403, route);
      assert.equal(asOwner.body.users ?? asOwner.body.pets ?? asOwner.body.appointments, undefined, `${route}: no records in the refusal`);
      assert.equal((await t.api('GET', route)).status, 401, route);
    }
  });
});

describe('PetHub keeps an administrator', () => {
  it('the last administrator cannot be demoted, not even by themselves, and nothing is changed or logged', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Only Admin' });
    onlyAdmin(admin);
    const logsBefore = t.db.table('activity_logs').length;

    const refused = await setRole(admin, admin.id, 'user');
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /at least one administrator/);
    assert.equal(roleOf(admin.id), 'admin');
    assert.equal(t.db.table('activity_logs').length, logsBefore, 'a refused change is not logged');
  });

  it('with a second administrator, one of them can be changed to a user; then the remaining one cannot', async () => {
    const first = t.createUser({ role: 'admin', name: 'First Admin' });
    onlyAdmin(first);
    const second = t.createUser({ name: 'Future Admin' });

    assert.equal((await setRole(first, second.id, 'admin')).status, 200);
    assert.equal((await setRole(second, first.id, 'user')).status, 200);
    assert.equal(roleOf(first.id), 'user');
    assert.equal((await setRole(second, second.id, 'user')).status, 409);
    assert.equal(roleOf(second.id), 'admin');
  });

  it('two administrators demoting each other at the same moment still leave one administrator', async () => {
    const first = t.createUser({ role: 'admin' });
    onlyAdmin(first);
    const second = t.createUser({ role: 'admin' });

    const answers = await Promise.all([setRole(first, second.id, 'user'), setRole(second, first.id, 'user')]);
    assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 409]);
    assert.equal([roleOf(first.id), roleOf(second.id)].filter(role => role === 'admin').length, 1);
  });
});

describe('Activity log requests', () => {
  it('return 20 entries by default and never more than 200', async () => {
    const admin = t.createUser({ role: 'admin' });
    for (let index = 0; index < 230; index += 1) {
      t.db.seed('activity_logs', { user_id: admin.id, action: 'user_logged_in', details: '', created_at: new Date(Date.now() - index * 1000).toISOString() });
    }
    const count = async query => (await t.api('GET', `/admin/system-logs?user_id=${admin.id}${query}`, { token: admin.token })).body.logs.length;
    assert.equal(await count(''), 20);
    assert.equal(await count('&limit=5'), 5);
    assert.equal(await count('&limit=100000'), 200);
    assert.equal(await count('&limit=-3'), 20);
    assert.equal(await count('&limit=abc'), 20);
  });
});
