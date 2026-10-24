// Features that do not involve appointments still work after online payments were removed: registration, email
// verification, login, password reset, pets, medical records, contact messages, the admin pages' endpoints and the
// AI chatbot's local answers and fallback. Every non-payment API route is still mounted.
// Runs the real app on the in-memory database; Brevo is faked, Gemini is not configured (GEMINI_API_KEY empty) and
// every outbound request other than Brevo is refused, so the chatbot test covers the local FAQ, emergency handling
// and the missing-key fallback, not a live Gemini answer.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestApp } = require('./helpers/harness');
const { PASSWORD_RESET_MAX_ATTEMPTS } = require('../constants/email');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
});

after(async () => {
  await t.close();
});

async function waitFor(check, label, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function codeIn(email) {
  return email.text.match(/\b(\d{6})\b/)[1];
}

// Registration requires the password confirmation and every personal detail
function registration(fullname, email, password) {
  return {
    fullname, email, password, confirm_password: password,
    date_of_birth: '1990-05-20', gender: 'Prefer not to say', phone_number: '0917 123 4567', address_line: '12 Mabini Street',
    barangay: 'San Isidro', city_municipality: 'Quezon City', province: 'Metro Manila', postal_code: '1100'
  };
}

describe('Registration, email verification and login', () => {
  it('registers, emails a verification code, verifies it and logs in with a session token', async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    const password = 'Registered#2026';

    const registered = await t.api('POST', '/auth/register', { body: registration('New Owner', email, password) });
    assert.equal(registered.status, 201);

    const blocked = await t.api('POST', '/auth/login', { body: { email, password } });
    assert.equal(blocked.status, 403, 'login waits for email verification');

    const verificationEmail = await waitFor(() => t.emailsTo(email)[0], 'the verification email');
    const code = codeIn(verificationEmail);
    assert.equal((await t.api('POST', '/auth/verify-email', { body: { email, code: code === '000000' ? '111111' : '000000' } })).status, 400);
    const verified = await t.api('POST', '/auth/verify-email', { body: { email, code } });
    assert.equal(verified.status, 200);

    assert.equal((await t.api('POST', '/auth/login', { body: { email, password: 'wrong-password' } })).status, 403);
    const login = await t.api('POST', '/auth/login', { body: { email, password } });
    assert.equal(login.status, 200);
    assert.equal(login.body.success, true);
    assert.ok(login.body.token);
    assert.equal(login.body.user.email, email);

    const userId = login.body.user.id;
    const status = await t.api('GET', `/auth/user-status?user_id=${userId}`, { token: login.body.token });
    assert.equal(status.status, 200);
    const activity = await t.api('GET', `/auth/activity-logs?user_id=${userId}`, { token: login.body.token });
    assert.equal(activity.status, 200);
    assert.equal((await t.api('POST', '/auth/logout', { token: login.body.token, body: { userId } })).status, 200);
    assert.equal((await t.api('GET', `/auth/user-status?user_id=${userId}`)).status, 401, 'protected routes still need the token');
  });

  it('refuses a second registration with the same email', async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    assert.equal((await t.api('POST', '/auth/register', { body: registration('Ana Cruz', email, 'Password#2026') })).status, 201);
    const again = await t.api('POST', '/auth/register', { body: registration('Ben Cruz', email, 'Password#2026') });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, 'Email already registered');
  });
});

describe('Password reset', () => {
  it('emails a reset code, resets the password with it, and the old password stops working', async () => {
    const user = t.createUser({ password: 'Old#Password1' });

    const requested = await t.api('POST', '/auth/forgot-password', { body: { email: user.email } });
    assert.equal(requested.status, 200);
    const resetEmail = await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email');
    const code = codeIn(resetEmail);

    const wrongCode = code === '000000' ? '111111' : '000000';
    assert.equal((await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: wrongCode, password: 'New#Password1' } })).status, 400);
    const reset = await t.api('POST', '/auth/reset-password', { body: { email: user.email, code, password: 'New#Password1' } });
    assert.equal(reset.status, 200);

    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Old#Password1' } })).status, 403);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'New#Password1' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/reset-password', { body: { email: user.email, code, password: 'Another#Pass1' } })).status, 400, 'a code works once');
  });

  it(`after ${PASSWORD_RESET_MAX_ATTEMPTS} wrong codes even the right code is refused, and the password is unchanged`, async () => {
    const user = t.createUser({ password: 'Old#Password1' });
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const code = codeIn(await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email'));
    const wrongCode = code === '000000' ? '111111' : '000000';

    for (let attempt = 0; attempt < PASSWORD_RESET_MAX_ATTEMPTS; attempt += 1) {
      assert.equal((await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: wrongCode, password: 'New#Password1' } })).status, 400);
    }
    assert.equal((await t.api('POST', '/auth/reset-password', { body: { email: user.email, code, password: 'New#Password1' } })).status, 400, 'the code is locked');
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Old#Password1' } })).status, 200);
  });

  it('refuses an expired code, and the password is unchanged', async () => {
    const user = t.createUser({ password: 'Old#Password1' });
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const code = codeIn(await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email'));
    t.db.table('password_resets')
      .filter(row => row.user_id === user.id)
      .forEach(row => { row.expires_at = new Date(Date.now() - 1000).toISOString(); });

    assert.equal((await t.api('POST', '/auth/reset-password', { body: { email: user.email, code, password: 'New#Password1' } })).status, 400);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Old#Password1' } })).status, 200);
  });

  it('answers unknown emails the same way and sends nothing', async () => {
    const email = `${crypto.randomUUID()}@example.test`;
    const response = await t.api('POST', '/auth/forgot-password', { body: { email } });
    assert.equal(response.status, 200);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(t.emailsTo(email).length, 0);
  });
});

describe('Pets', () => {
  it('owners add, list and delete their own pets; other customers cannot see or delete them', async () => {
    const owner = t.createUser();
    const stranger = t.createUser();

    const created = await t.api('POST', '/pets/create', {
      token: owner.token,
      body: { user_id: owner.id, name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2 }
    });
    assert.equal(created.status, 201);
    const petId = created.body.pet.id;
    assert.equal((await t.api('POST', '/pets/create', { token: owner.token, body: { user_id: owner.id, name: '' } })).status, 400);

    const list = await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: owner.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.pets.map(pet => pet.name), ['Luna']);
    const strangersList = await t.api('GET', `/pets/userPets?user_id=${stranger.id}`, { token: stranger.token });
    assert.equal(strangersList.body.pets.length, 0);
    assert.equal((await t.api('GET', `/pets/userPets?user_id=${owner.id}`, { token: stranger.token })).status, 403);

    assert.equal((await t.api('DELETE', `/pets/delete/${petId}?user_id=${stranger.id}`, { token: stranger.token })).status, 404);
    assert.equal((await t.api('DELETE', `/pets/delete/${petId}?user_id=${owner.id}`, { token: owner.token })).status, 200);
    assert.equal(t.db.table('pets').filter(pet => pet.id === petId).length, 0);
  });
});

describe('Medical records', () => {
  it('an official weight must be a real measurement and ids must be well-formed; nothing is saved otherwise', async () => {
    const owner = t.createUser();
    const pet = t.createPet(owner, 'Biscuit');
    const visit = t.createAppointment(owner, { pet, daysAhead: -2, status: 'Completed' });
    const body = {
      pet_id: pet.id, appointment_id: visit.id, record_date: t.manilaDate(-2), weight: 0,
      vaccination_status: 'Up to date', treatment: 'Check-up', medical_notes: 'Test note'
    };
    const create = payload => t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body: payload });
    const recordsBefore = t.db.table('medical_records').length;

    const zero = await create(body);
    assert.equal(zero.status, 400);
    assert.match(zero.body.error, /greater than zero/);
    assert.equal((await create({ ...body, weight: -1 })).status, 400);
    assert.equal((await create({ ...body, weight: 3.4, pet_id: 'not-a-pet-id' })).status, 404);
    assert.equal((await create({ ...body, weight: 3.4, appointment_id: 'not-an-appointment-id' })).status, 404);
    assert.equal(t.db.table('medical_records').length, recordsBefore);

    const saved = await create({ ...body, weight: 3.4 });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.record.weight, 3.4);
    assert.equal(saved.body.record.appointment_id, visit.id);
  });

  it('admins add a record after a completed appointment; owners read their pet\'s records but cannot add or read others\'', async () => {
    const owner = t.createUser();
    const stranger = t.createUser();
    const pet = t.createPet(owner, 'Choco');
    const pending = t.createAppointment(owner, { pet, daysAhead: 3 });
    const completed = t.createAppointment(owner, { pet, daysAhead: 4, status: 'Completed' });
    const recordBody = appointmentId => ({
      pet_id: pet.id, appointment_id: appointmentId, record_date: t.manilaDate(4), weight: 12.5,
      vaccination_status: 'Up to date', treatment: 'Deworming', medical_notes: 'Healthy'
    });

    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body: recordBody(pending.id) })).status, 400);
    const created = await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body: recordBody(completed.id) });
    assert.equal(created.status, 201);
    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${admin.id}`, { token: admin.token, body: recordBody(completed.id) })).status, 409, 'one record per appointment');
    assert.equal((await t.api('POST', `/admin/dashboard/medical-records/create?user_id=${owner.id}`, { token: owner.token, body: recordBody(completed.id) })).status, 403);

    const ownerRecords = await t.api('GET', `/pets/medical-records?user_id=${owner.id}&pet_id=${pet.id}`, { token: owner.token });
    assert.equal(ownerRecords.status, 200);
    assert.equal(ownerRecords.body.records.length, 1);
    assert.equal((await t.api('POST', '/pets/medical-records/create', { token: owner.token, body: { user_id: owner.id, pet_id: pet.id } })).status, 403, 'owners are read-only');
    // Another customer never sees them: with no pets the list is empty; with pets of their own, this pet is not found
    const noPets = await t.api('GET', `/pets/medical-records?user_id=${stranger.id}&pet_id=${pet.id}`, { token: stranger.token });
    assert.equal(noPets.status, 200);
    assert.deepEqual(noPets.body.records, []);
    t.createPet(stranger, 'Kuro');
    assert.equal((await t.api('GET', `/pets/medical-records?user_id=${stranger.id}&pet_id=${pet.id}`, { token: stranger.token })).status, 404);
    assert.equal((await t.api('GET', `/pets/medical-records?user_id=${owner.id}&pet_id=${pet.id}`, { token: stranger.token })).status, 403, 'cannot ask as the owner');
  });
});

describe('Contact messages', () => {
  it('signed-in customers send a message; signed-out visitors cannot; admins list it and mark it Read', async () => {
    const customer = t.createUser({ name: 'Visitor Account' });
    const email = customer.email;
    assert.equal((await t.api('POST', '/contact', { body: { subject: 'Hours', message: 'Do you open on Sundays?' } })).status, 401);
    assert.equal((await t.api('POST', '/contact', { token: customer.token, body: { subject: 'Hours', message: 'Do you open on Sundays?' } })).status, 201);
    assert.equal((await t.api('POST', '/contact', { token: customer.token, body: { subject: 'Hours', message: '' } })).status, 400);

    const list = await t.api('GET', `/admin/dashboard/contact-messages?user_id=${admin.id}`, { token: admin.token });
    assert.equal(list.status, 200);
    const message = list.body.messages.find(item => item.email === email);
    assert.ok(message, 'the message is listed for admins');
    assert.equal(message.status, 'Unread');

    const marked = await t.api('PUT', `/admin/dashboard/contact-message-status?user_id=${admin.id}`, { token: admin.token, body: { id: message.id, status: 'Read' } });
    assert.equal(marked.status, 200);
    assert.equal(t.db.find('contact_messages', row => row.email === email).status, 'Read');
  });
});

describe('Admin endpoints', () => {
  it('admins load every dashboard endpoint; other users are refused', async () => {
    const user = t.createUser();
    t.createAppointment(user, { daysAhead: 5 });
    const endpoints = [
      '/admin/dashboard/stats', '/admin/dashboard/users', '/admin/dashboard/pets', '/admin/dashboard/appointments',
      '/admin/dashboard/contact-messages', '/admin/dashboard/overview', '/admin/analytics/summary',
      '/admin/analytics/pet-types', '/admin/analytics/services', '/admin/analytics/appointments-trend', '/admin/system-logs'
    ];
    for (const endpoint of endpoints) {
      const response = await t.api('GET', `${endpoint}?user_id=${admin.id}`, { token: admin.token });
      assert.equal(response.status, 200, endpoint);
      assert.notEqual(response.body.success, false, endpoint);
      assert.equal((await t.api('GET', `${endpoint}?user_id=${user.id}`, { token: user.token })).status, 403, `${endpoint} for a non-admin`);
    }
  });

  it('admins change a user\'s role', async () => {
    const user = t.createUser();
    const response = await t.api('PUT', `/admin/dashboard/user-role?user_id=${admin.id}`, { token: admin.token, body: { id: user.id, role: 'admin' } });
    assert.equal(response.status, 200);
    assert.equal(t.db.find('users', row => row.id === user.id).role, 'admin');
    assert.equal((await t.api('PUT', `/admin/dashboard/user-role?user_id=${admin.id}`, { token: admin.token, body: { id: user.id, role: 'owner' } })).status, 400);
  });
});

describe('AI chatbot', () => {
  it('answers from the local FAQ and flags emergencies without calling Gemini', async () => {
    const faq = await t.api('POST', '/ai/chat', { body: { message: 'What is PetHub?' } });
    assert.equal(faq.status, 200);
    assert.equal(faq.body.isFAQ, true);
    assert.match(faq.body.reply, /PetHub/);
    assert.doesNotMatch(faq.body.reply, /payment|deposit|paymongo/i);

    const emergency = await t.api('POST', '/ai/chat', { body: { message: 'My dog is bleeding a lot' } });
    assert.equal(emergency.status, 200);
    assert.equal(emergency.body.isEmergency, true);
    assert.match(emergency.body.reply, /emergency vet/i);

    assert.equal((await t.api('POST', '/ai/chat', { body: { message: '   ' } })).status, 400);
  });

  it('without a Gemini key, other questions get the existing "temporarily unavailable" fallback and nothing is sent out', async () => {
    const blockedBefore = t.blockedRequests.length;
    const response = await t.api('POST', '/ai/chat', { body: { message: 'How often should I brush my rabbit?' } });
    assert.equal(response.status, 503);
    assert.match(response.body.reply, /temporarily unavailable/);
    assert.equal(t.blockedRequests.length, blockedBefore, 'no request to Gemini without a key');
  });
});

describe('Route inventory', () => {
  // Every API route the app had before online payments were removed, except the three /payments routes and the unused
  // PUT /appointments/updateStatus duplicate (removed 2026-10-24), plus the pet profile routes (PUT /pets/update/:id,
  // GET /pets/history/:id), owner cancellation, and the contact / clinic details / email retry routes added later
  const ROUTES = [
    ['POST', '/auth/login'], ['POST', '/auth/register'], ['POST', '/auth/verify-email'], ['POST', '/auth/resend-code'],
    ['POST', '/auth/forgot-password'], ['POST', '/auth/reset-password'], ['POST', '/auth/logout'], ['GET', '/auth/user-status'],
    ['GET', '/auth/activity-logs'],
    ['POST', '/pets/create'], ['GET', '/pets/userPets'], ['GET', '/pets/medical-records'], ['POST', '/pets/medical-records/create'],
    ['DELETE', '/pets/delete/some-id'], ['PUT', '/pets/update/some-id'], ['GET', '/pets/history/some-id'],
    ['POST', '/appointments/create'], ['GET', '/appointments/userAppointments'], ['GET', '/appointments/all'], ['POST', '/appointments/cancel/some-id'],
    ['POST', '/ai/chat'], ['POST', '/contact'], ['GET', '/contact/mine'], ['GET', '/contact/clinic-info'],
    ['POST', '/admin/dashboard/contact-messages/some-id/reply'], ['GET', '/admin/clinic-settings'], ['PUT', '/admin/clinic-settings'],
    ['POST', '/admin/email-logs/some-id/retry'],
    ['GET', '/admin/dashboard/stats'], ['GET', '/admin/dashboard/users'], ['GET', '/admin/dashboard/pets'], ['GET', '/admin/dashboard/appointments'],
    ['GET', '/admin/dashboard/contact-messages'], ['PUT', '/admin/dashboard/contact-message-status'], ['PUT', '/admin/dashboard/appointment-status'],
    ['POST', '/admin/dashboard/medical-records/create'], ['PUT', '/admin/dashboard/user-role'], ['GET', '/admin/dashboard/overview'],
    ['GET', '/admin/analytics/summary'], ['GET', '/admin/analytics/pet-types'], ['GET', '/admin/analytics/services'],
    ['GET', '/admin/analytics/appointments-trend'], ['GET', '/admin/system-logs']
  ];

  it('every non-payment API route is still mounted', async () => {
    for (const [method, url] of ROUTES) {
      const response = await t.api(method, url, method === 'GET' || method === 'DELETE' ? {} : { body: {} });
      const notFound = response.status === 404 && response.body && response.body.error === 'API endpoint not found';
      assert.equal(notFound, false, `${method} ${url} is mounted (got ${response.status})`);
    }
  });
});
