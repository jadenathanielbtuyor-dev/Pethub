// Customers completing or correcting their own personal details (PUT /auth/profile), especially accounts created before
// the details were required: the update is checked like a registration, saved in one write to the signed-in
// customer's own row, kept across logins, and can never change email, password, role, verification or another account.
// MOCKED: the real Express app on the in-memory database (helpers/harness.js); nothing talks to Supabase or Brevo.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

const DETAILS = Object.freeze({
  fullname: 'Maria Clara Santos',
  date_of_birth: '1988-03-02',
  gender: 'Prefer not to say',
  phone_number: '(02) 8123-4567',
  address_line: 'Unit 2, 45 Rizal Avenue',
  barangay: 'Poblacion',
  city_municipality: 'Makati City',
  province: 'Metro Manila',
  postal_code: '1210'
});

const PROFILE_FIELDS = ['date_of_birth', 'gender', 'phone_number', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'];

function update(user, body) {
  return t.api('PUT', '/auth/profile', { token: user.token, body });
}

function row(user) {
  return t.db.find('users', entry => entry.id === user.id);
}

describe('Completing the details of an account created before they were required', () => {
  it('saves every detail normalised, returns them with the public account fields, and logs no personal values', async () => {
    const user = t.createUser({ name: 'Maria Santos', password: 'Legacy#Plain1' });
    const storedPassword = row(user).password;
    PROFILE_FIELDS.forEach(field => assert.equal(row(user)[field] ?? null, null));

    const response = await update(user, DETAILS);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.profile, {
      phone_number: '+63281234567',
      date_of_birth: '1988-03-02',
      gender: 'Prefer not to say',
      address_line: 'Unit 2, 45 Rizal Avenue',
      barangay: 'Poblacion',
      city_municipality: 'Makati City',
      province: 'Metro Manila',
      postal_code: '1210'
    });
    assert.deepEqual(Object.keys(response.body.user).sort(), ['created_at', 'email', 'fullname', 'id', 'is_verified', 'role']);
    assert.equal(response.body.user.fullname, 'Maria Clara Santos');
    assert.ok(!response.text.includes('Legacy#Plain1'));

    const stored = row(user);
    assert.equal(stored.fullname, 'Maria Clara Santos');
    assert.equal(stored.phone_number, '+63281234567');
    assert.equal(stored.password, storedPassword, 'the password is untouched');
    assert.equal(stored.role, 'user');

    const activity = t.db.table('activity_logs').filter(entry => entry.user_id === user.id && entry.action === 'profile_updated');
    assert.equal(activity.length, 1);
    const logged = JSON.stringify(activity) + t.logs.join('\n');
    for (const value of ['8123', 'Rizal Avenue', 'Poblacion', '1988-03-02']) assert.ok(!logged.includes(value), value);
  });

  it('keeps the details after logging out and in again', async () => {
    const user = t.createUser({ password: 'Persist#Pass1' });
    assert.equal((await update(user, DETAILS)).status, 200);

    const login = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Persist#Pass1' } });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.fullname, 'Maria Clara Santos');
    const status = await t.api('GET', `/auth/user-status?user_id=${user.id}&include=profile`, { token: login.body.token });
    assert.equal(status.status, 200);
    assert.equal(status.body.profile.city_municipality, 'Makati City');
    assert.equal(status.body.profile.phone_number, '+63281234567');
  });

  it('corrects details that were already saved', async () => {
    const user = t.createUser();
    assert.equal((await update(user, DETAILS)).status, 200);
    const corrected = await update(user, { ...DETAILS, barangay: 'San Lorenzo', phone_number: '+1 415 555 0100' });
    assert.equal(corrected.status, 200);
    assert.equal(row(user).barangay, 'San Lorenzo');
    assert.equal(row(user).phone_number, '+14155550100');
  });
});

describe('Profile update validation', () => {
  it('requires the name and every detail, naming the first problem and changing nothing', async () => {
    const user = t.createUser({ name: 'Unchanged Name' });
    for (const field of ['fullname', ...PROFILE_FIELDS]) {
      const response = await update(user, { ...DETAILS, [field]: '' });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.field, field);
      assert.match(response.body.error, /required/i, field);
    }
    const partial = await update(user, { city_municipality: 'Makati City' });
    assert.equal(partial.status, 400);
    assert.equal(partial.body.field, 'fullname');
    assert.equal(row(user).fullname, 'Unchanged Name');
    PROFILE_FIELDS.forEach(field => assert.equal(row(user)[field] ?? null, null, field));
  });

  it('applies the registration rules', async () => {
    const user = t.createUser();
    const cases = [
      ['date_of_birth', '2999-01-01', /future/],
      ['date_of_birth', '2001-02-30', /valid date/],
      ['gender', 'Unknown', /listed options/],
      ['phone_number', '0917 123', /mobile or landline/],
      ['postal_code', '12345', /4-digit/],
      ['fullname', 'Maria 2', /letters/],
      ['address_line', 'x'.repeat(151), /150 characters/]
    ];
    for (const [field, value, message] of cases) {
      const response = await update(user, { ...DETAILS, [field]: value });
      assert.equal(response.status, 400, `${field}=${value}`);
      assert.equal(response.body.field, field);
      assert.match(response.body.error, message);
    }
  });

  it('refuses email, password, role and verification changes, and any other field, changing nothing', async () => {
    const user = t.createUser({ password: 'Keep#Pass1' });
    const before = { ...row(user) };
    const attempts = {
      email: 'new-address@example.test',
      password: 'Changed#Pass1',
      confirm_password: 'Changed#Pass1',
      role: 'admin',
      is_verified: false,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      status: 'Active',
      profile_image: 'https://evil.example/x.png'
    };
    for (const [field, value] of Object.entries(attempts)) {
      const response = await update(user, { ...DETAILS, [field]: value });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.field, field);
    }
    assert.deepEqual(row(user), before);
  });
});

describe('Profile update access', () => {
  it('needs a signed-in customer', async () => {
    assert.equal((await t.api('PUT', '/auth/profile', { body: DETAILS })).status, 401);
    assert.equal((await t.api('PUT', '/auth/profile', { token: 'not-a-token', body: DETAILS })).status, 401);
  });

  it('only ever changes the signed-in customer: another account named in the body or query is refused', async () => {
    const owner = t.createUser({ name: 'Owner Person' });
    const other = t.createUser({ name: 'Other Person' });
    const viaBody = await update(other, { ...DETAILS, user_id: owner.id });
    assert.equal(viaBody.status, 403);
    const viaQuery = await t.api('PUT', `/auth/profile?user_id=${owner.id}`, { token: other.token, body: DETAILS });
    assert.equal(viaQuery.status, 403);
    assert.equal(row(owner).fullname, 'Owner Person');
    assert.equal(row(other).fullname, 'Other Person');

    // Naming one's own id is allowed (the usual request convention)
    assert.equal((await update(other, { ...DETAILS, user_id: other.id })).status, 200);
    assert.equal(row(owner).fullname, 'Owner Person');
  });

  it('a database error saves nothing and returns no details', async () => {
    const user = t.createUser({ name: 'Before Error' });
    t.db.failNext({ table: 'users', action: 'update' }, { code: 'XX000', message: 'internal error near users' });
    const response = await update(user, DETAILS);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Your details could not be saved. Please try again.');
    assert.ok(!response.text.includes('internal error'));
    assert.equal(row(user).fullname, 'Before Error');
  });

  it('an account that no longer exists gets 404', async () => {
    const user = t.createUser();
    t.db.rows.users = t.db.table('users').filter(entry => entry.id !== user.id);
    assert.equal((await update(user, DETAILS)).status, 404);
  });
});
