// Registration with the required personal details (POST /auth/register), password storage, and the account
// checks around it: login with new and older stored passwords, password reset, email verification, the
// dashboard's profile read (GET /auth/user-status?include=profile), profile updates (PUT /auth/profile) and
// admin-only routes.
// Runs the real app on the in-memory database (database after migrations/2026-10-20_users_profile_fields.sql);
// Brevo is faked and no other outbound request is allowed. Nothing here talks to a real Supabase or Brevo.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const BACKEND = path.join(__dirname, '..');
const { isPasswordHash, hashPassword, verifyPassword } = require(path.join(BACKEND, 'utils', 'passwordHash.js'));

let t;

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

function newEmail() {
  return `${crypto.randomUUID()}@example.test`;
}

const FULL_PROFILE = Object.freeze({
  date_of_birth: '1994-06-15',
  gender: 'Female',
  phone_number: '0918 765 4321',
  address_line: 'Unit 4B, 12 Mabini Street',
  barangay: 'San Antonio',
  city_municipality: 'Pasig City',
  province: 'Metro Manila',
  postal_code: '1605'
});

// Every field the registration form sends (all required)
function registration(overrides = {}) {
  const password = overrides.password ?? 'Clinic#Pass2026';
  return {
    fullname: 'Maria Santos',
    email: newEmail(),
    password,
    confirm_password: password,
    ...FULL_PROFILE,
    ...overrides
  };
}

const PROFILE_COLUMNS = ['phone_number', 'date_of_birth', 'gender', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'];

function register(body) {
  return t.api('POST', '/auth/register', { body });
}

function usersWithEmail(email) {
  return t.db.table('users').filter(row => row.email === email);
}

function userRow(email) {
  return t.db.find('users', row => row.email === email);
}

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

async function verifyAndLogin(email, password) {
  const verificationEmail = await waitFor(() => t.emailsTo(email)[0], 'the verification email');
  const verified = await t.api('POST', '/auth/verify-email', { body: { email, code: codeIn(verificationEmail) } });
  assert.equal(verified.status, 200);
  return t.api('POST', '/auth/login', { body: { email, password } });
}

async function assertRefused(body, field, message) {
  const response = await register(body);
  assert.equal(response.status, 400, `${field}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.success, false);
  assert.equal(response.body.field, field);
  if (message) assert.match(response.body.error, message);
  if (typeof body.email === 'string') {
    assert.equal(usersWithEmail(body.email.trim().toLowerCase()).length, 0, `${field}: no account is created`);
  }
  return response;
}

describe('Registering an account', () => {
  it('creates an unverified customer account with a hashed password and emails one verification code', async () => {
    const body = registration();
    const response = await register(body);

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      success: true,
      message: 'User registered successfully. Verification code sent to email.',
      email: body.email
    });

    const row = userRow(body.email);
    assert.equal(row.fullname, 'Maria Santos');
    assert.equal(row.role, 'user');
    assert.equal(row.is_verified, false);
    assert.equal(row.status, 'Active', 'database default kept');
    assert.ok(isPasswordHash(row.password), 'the password is stored as a scrypt hash');
    assert.notEqual(row.password, body.password);
    assert.ok(!row.password.includes(body.password));
    assert.equal(row.phone_number, '+639187654321');
    assert.equal(row.date_of_birth, '1994-06-15');
    assert.equal(row.postal_code, '1605');

    assert.equal(t.db.table('email_verifications').filter(entry => entry.user_id === row.id).length, 1);
    const sent = await waitFor(() => t.emailsTo(body.email)[0], 'the verification email');
    assert.match(sent.text, /\b\d{6}\b/);
    assert.equal(t.emailsTo(body.email).length, 1);

    // Nothing secret comes back: no password, hash or verification code
    assert.ok(!response.text.includes(body.password));
    assert.ok(!response.text.includes(row.password));
    assert.ok(!response.text.includes(codeIn(sent)));
  });

  it('then verifies and logs in with the hashed password; a wrong password is refused', async () => {
    const body = registration({ password: 'Verify#Then#Login1' });
    assert.equal((await register(body)).status, 201);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: body.email, password: body.password } })).status, 403, 'not before verification');

    const login = await verifyAndLogin(body.email, body.password);
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'user');
    assert.ok(login.body.token);
    assert.ok(!login.text.includes(userRow(body.email).password), 'login never returns the hash');
    assert.equal((await t.api('POST', '/auth/login', { body: { email: body.email, password: 'Verify#Then#Login2' } })).status, 403);
  });

  it('saves every personal detail, normalised', async () => {
    const body = registration({
      ...FULL_PROFILE,
      fullname: '  Juan   dela  Cruz ',
      email: `  ${crypto.randomUUID()}@Example.TEST `,
      gender: 'non-binary',
      phone_number: '+63 (917) 123-4567',
      address_line: '  Blk 3   Lot 9 ',
      province: ' Rizal '
    });
    const response = await register(body);
    assert.equal(response.status, 201);

    const email = body.email.trim().toLowerCase();
    assert.equal(response.body.email, email);
    const row = userRow(email);
    assert.equal(row.fullname, 'Juan dela Cruz');
    assert.equal(row.date_of_birth, '1994-06-15');
    assert.equal(row.gender, 'Non-binary');
    assert.equal(row.phone_number, '+639171234567');
    assert.equal(row.address_line, 'Blk 3 Lot 9');
    assert.equal(row.barangay, 'San Antonio');
    assert.equal(row.city_municipality, 'Pasig City');
    assert.equal(row.province, 'Rizal');
    assert.equal(row.postal_code, '1605');
  });

  it('accepts "Prefer not to say" as a complete answer for gender', async () => {
    const body = registration({ gender: 'Prefer not to say' });
    assert.equal((await register(body)).status, 201);
    assert.equal(userRow(body.email).gender, 'Prefer not to say');
  });

  it('accepts Philippine mobile and landline numbers, and numbers from other countries with their country code', async () => {
    const cases = [
      ['09171234567', '+639171234567'], ['0917 123 4567', '+639171234567'], ['0917-123-4567', '+639171234567'],
      ['+639171234567', '+639171234567'], ['639171234567', '+639171234567'], ['+63 917 123 4567', '+639171234567'],
      ['+63 (0) 917 123 4567', '+639171234567'], ['0063 917 123 4567', '+639171234567'],
      ['02 8123 4567', '+63281234567'], ['(02) 8123-4567', '+63281234567'], ['032 123 4567', '+63321234567'],
      ['+63 32 123 4567', '+63321234567'], ['+1 415 555 0100', '+14155550100'], ['0044 20 7946 0958', '+442079460958']
    ];
    for (const [phone, stored] of cases) {
      const body = registration({ phone_number: phone });
      assert.equal((await register(body)).status, 201, phone);
      assert.equal(userRow(body.email).phone_number, stored, phone);
    }
  });

  it('refuses the earlier forms that sent no personal details, creating nothing', async () => {
    const email = newEmail();
    const oldest = await register({ fullname: 'Old Form', email, password: 'OldForm#2026' });
    assert.equal(oldest.status, 400);
    assert.equal(oldest.body.field, 'confirm_password');
    const older = await register({ fullname: 'Old Form', email, password: 'OldForm#2026', confirm_password: 'OldForm#2026' });
    assert.equal(older.status, 400);
    assert.equal(older.body.field, 'date_of_birth');
    assert.equal(usersWithEmail(email).length, 0);
    assert.equal(t.emailsTo(email).length, 0);
  });

  it('keeps the password exactly as typed (no trimming)', async () => {
    const body = registration({ password: '  spaced pass  ' });
    assert.equal((await register(body)).status, 201);
    assert.equal((await verifyAndLogin(body.email, '  spaced pass  ')).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: body.email, password: 'spaced pass' } })).status, 403);
  });
});

describe('Registration validation', () => {
  it('requires full legal name, email, password and its confirmation, naming the missing field', async () => {
    await assertRefused(registration({ fullname: undefined }), 'fullname', /Full legal name is required/);
    await assertRefused(registration({ fullname: '   ' }), 'fullname', /Full legal name is required/);
    await assertRefused(registration({ email: '' }), 'email', /Email address is required/);
    await assertRefused(registration({ password: undefined, confirm_password: undefined }), 'password', /Password is required/);
    await assertRefused(registration({ password: '        ', confirm_password: '        ' }), 'password', /Password is required/);
    await assertRefused(registration({ confirm_password: undefined }), 'confirm_password', /Confirm your password/);
    await assertRefused(registration({ confirm_password: '' }), 'confirm_password', /Confirm your password/);
    const nothing = await register({});
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.field, 'fullname');
  });

  it('accepts names in any script with spaces, hyphens, apostrophes, periods and commas; refuses digits and symbols', async () => {
    for (const name of ['12345', '--- ...', 'Ana\u0000Cruz', 'Maria 2', 'Juan <b>Cruz</b>', 'Ana_Cruz', '@nna']) {
      await assertRefused(registration({ fullname: name }), 'fullname', /letters/);
    }
    await assertRefused(registration({ fullname: 'A'.repeat(101) }), 'fullname', /100 characters/);
    for (const name of ['A'.repeat(100), 'José Ñiño-O\'Brien', 'Ma. Cristina dela Cruz, Jr.', 'D\u2019Angelo Reyes', '\u738b\u5c0f\u660e', 'Zo\u00eb \u00c5ngstr\u00f6m']) {
      const body = registration({ fullname: name });
      assert.equal((await register(body)).status, 201, name);
      assert.equal(userRow(body.email).fullname, name);
    }
  });

  it('rejects malformed and over-long email addresses', async () => {
    for (const email of ['not-an-email', 'owner@', 'owner@clinic', 'two words@clinic.ph', 'owner@@clinic.ph', `${'a'.repeat(250)}@x.ph`]) {
      await assertRefused(registration({ email }), 'email', /valid email/);
    }
  });

  it('enforces the password policy: 8 to 128 characters', async () => {
    await assertRefused(registration({ password: 'Short#7' }), 'password', /at least 8 characters/);
    await assertRefused(registration({ password: 'x'.repeat(129) }), 'password', /128 characters or fewer/);
    assert.equal((await register(registration({ password: 'Exactly8' }))).status, 201);
    assert.equal((await register(registration({ password: 'y'.repeat(128) }))).status, 201);
  });

  it('rejects a password confirmation that does not match', async () => {
    await assertRefused(registration({ confirm_password: 'Something#Else1' }), 'confirm_password', /do not match/);
    await assertRefused(registration({ password: '12345678', confirm_password: 12345678 }), 'confirm_password', /do not match/);
  });

  it('rejects impossible, malformed, too-early and future dates of birth', async () => {
    for (const date of ['2001-02-30', '2001-13-01', '15/06/1994', '1994-6-15', 'yesterday']) {
      await assertRefused(registration({ date_of_birth: date }), 'date_of_birth', /valid date of birth/);
    }
    await assertRefused(registration({ date_of_birth: '1899-12-31' }), 'date_of_birth', /1900/);
    await assertRefused(registration({ date_of_birth: t.manilaDate(1) }), 'date_of_birth', /future/);
    await assertRefused(registration({ date_of_birth: '2999-01-01' }), 'date_of_birth', /future/);

    const today = registration({ date_of_birth: t.manilaDate(0) });
    assert.equal((await register(today)).status, 201, 'today (clinic date) is not in the future');
    assert.equal((await register(registration({ date_of_birth: '1900-01-01' }))).status, 201);
  });

  it('requires every personal detail, naming the first missing one and creating nothing', async () => {
    const fields = ['date_of_birth', 'gender', 'phone_number', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'];
    for (const field of fields) {
      for (const empty of [undefined, null, '', '   ']) {
        const response = await assertRefused(registration({ [field]: empty }), field, /required/);
        if (field === 'gender') assert.match(response.body.error, /Prefer not to say/);
      }
    }
    // Several missing: the first in form order is named
    await assertRefused(registration({ gender: '', postal_code: '', province: '' }), 'gender');
  });

  it('accepts only the listed gender options (any letter case)', async () => {
    await assertRefused(registration({ gender: 'Unknown' }), 'gender', /listed options/);
    const body = registration({ gender: 'PREFER NOT TO SAY' });
    assert.equal((await register(body)).status, 201);
    assert.equal(userRow(body.email).gender, 'Prefer not to say');
  });

  it('rejects contact numbers that are not valid mobile, landline or international numbers', async () => {
    const invalid = ['12345', '0917123456', '091712345678', '0817 123 4567', 'call me', '0917 123 4567 ext 2', '0'.repeat(30),
      '+63123', '+63 917 123 456', '14155550100', '+0123456789', '+1234567', '+1 234 567 890 123 456'];
    for (const phone of invalid) {
      await assertRefused(registration({ phone_number: phone }), 'phone_number', /mobile or landline number/);
    }
  });

  it('rejects over-long address parts and postal codes that are not 4 digits', async () => {
    await assertRefused(registration({ address_line: 'x'.repeat(151) }), 'address_line', /150 characters/);
    await assertRefused(registration({ barangay: 'x'.repeat(101) }), 'barangay', /100 characters/);
    await assertRefused(registration({ city_municipality: 'x'.repeat(101) }), 'city_municipality', /100 characters/);
    await assertRefused(registration({ province: 'x'.repeat(101) }), 'province', /100 characters/);
    await assertRefused(registration({ barangay: 'Bad\u0007Bell' }), 'barangay', /valid barangay/);
    await assertRefused(registration({ province: '---' }), 'province', /valid province/);
    for (const postal of ['123', '12345', '16O5', '1605a']) {
      await assertRefused(registration({ postal_code: postal }), 'postal_code', /4-digit/);
    }
    assert.equal((await register(registration({ address_line: 'x'.repeat(150), barangay: 'y'.repeat(100) }))).status, 201);
  });

  it('rejects values of the wrong type', async () => {
    await assertRefused(registration({ fullname: 123 }), 'fullname');
    await assertRefused(registration({ fullname: ['Maria'] }), 'fullname');
    await assertRefused(registration({ email: [newEmail()] }), 'email');
    await assertRefused(registration({ email: { address: newEmail() } }), 'email');
    await assertRefused(registration({ password: 12345678, confirm_password: 12345678 }), 'password');
    await assertRefused(registration({ date_of_birth: 19940615 }), 'date_of_birth');
    await assertRefused(registration({ gender: true }), 'gender');
    await assertRefused(registration({ phone_number: 9171234567 }), 'phone_number');
    await assertRefused(registration({ postal_code: 1605 }), 'postal_code');
    await assertRefused(registration({ address_line: { street: 'Mabini' } }), 'address_line');

    const arrayBody = await t.api('POST', '/auth/register', { body: [registration()] });
    assert.equal(arrayBody.status, 400);
  });

  it('ignores role, verification status and other privileged or unknown fields', async () => {
    const forcedId = crypto.randomUUID();
    const body = registration({
      role: 'admin',
      is_verified: true,
      id: forcedId,
      status: 'Banned',
      created_at: '2000-01-01T00:00:00Z',
      profile_image: 'https://evil.example/x.png',
      deleted_at: '2000-01-01T00:00:00Z',
      password_hash: 'scrypt$1$1$1$x$y'
    });
    assert.equal((await register(body)).status, 201);

    const row = userRow(body.email);
    assert.equal(row.role, 'user');
    assert.equal(row.is_verified, false);
    assert.notEqual(row.id, forcedId);
    assert.equal(row.status, 'Active');
    assert.notEqual(row.created_at, '2000-01-01T00:00:00Z');
    assert.equal(row.profile_image ?? null, null);
    assert.equal(row.deleted_at ?? null, null);
    assert.ok(!('password_hash' in row));
    assert.equal((await t.api('POST', '/auth/login', { body: { email: body.email, password: body.password } })).status, 403, 'still needs email verification');
  });
});

describe('Duplicate and repeated registrations', () => {
  it('refuses an email that is already registered, in any letter case, without a second email', async () => {
    const body = registration();
    assert.equal((await register(body)).status, 201);
    await waitFor(() => t.emailsTo(body.email)[0], 'the first verification email');

    const again = await register({ ...body, fullname: 'Someone Else', email: body.email.toUpperCase() });
    assert.equal(again.status, 400);
    assert.deepEqual(again.body, { success: false, error: 'Email already registered', field: 'email' });
    assert.equal(usersWithEmail(body.email).length, 1);
    assert.equal(userRow(body.email).fullname, 'Maria Santos', 'the existing account is untouched');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.emailsTo(body.email).length, 1);
  });

  it('the same registration sent several times at once creates one account and sends one email', async () => {
    const body = registration();
    // Slow the duplicate check down so the copies overlap
    for (let i = 0; i < 3; i += 1) {
      t.db.interceptNext({ table: 'users', action: 'select' }, () => new Promise(resolve => setTimeout(resolve, 30)));
    }

    const responses = await Promise.all([register(body), register(body), register(body)]);
    const statuses = responses.map(response => response.status).sort();
    assert.deepEqual(statuses, [201, 400, 400]);
    responses.filter(response => response.status === 400).forEach(response => assert.equal(response.body.error, 'Email already registered'));
    assert.equal(usersWithEmail(body.email).length, 1);
    await waitFor(() => t.emailsTo(body.email)[0], 'the verification email');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.emailsTo(body.email).length, 1);
  });

  it('a duplicate-key error from the database is reported as an existing account', async () => {
    const body = registration();
    t.db.failNext({ table: 'users', action: 'insert' }, { code: '23505', message: 'duplicate key value violates unique constraint "users_email_key"' });
    const response = await register(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'Email already registered');
    assert.equal(response.body.field, 'email');
  });
});

describe('Registration failures', () => {
  it('a database error during the email check creates nothing', async () => {
    const body = registration();
    t.db.failNext({ table: 'users', action: 'select' }, { code: '08006', message: 'connection failure' });
    const response = await register(body);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Database error');
    assert.equal(usersWithEmail(body.email).length, 0);
  });

  it('a failed insert reports a server error without details', async () => {
    const body = registration();
    t.db.failNext({ table: 'users', action: 'insert' }, { code: 'XX000', message: 'internal error near "users"' });
    const response = await register(body);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Failed to register user');
    assert.ok(!response.text.includes('internal error'));
  });

  it('a failed verification record leaves the account to be finished from the verification page', async () => {
    const body = registration();
    t.db.failNext({ table: 'email_verifications', action: 'insert' }, { code: '08006', message: 'connection failure' });
    const response = await register(body);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, 'Failed to initialize email verification');
    assert.equal(usersWithEmail(body.email).length, 1);

    const resend = await t.api('POST', '/auth/resend-code', { body: { email: body.email } });
    assert.equal(resend.status, 200);
    assert.equal((await verifyAndLogin(body.email, body.password)).status, 200);
  });

  it('a failed verification email keeps the account and says the code can be resent', async () => {
    const body = registration();
    t.failNextEmail({ status: 500 });
    const response = await register(body);
    assert.equal(response.status, 500);
    assert.match(response.body.error, /^Registration created, but failed to send verification email/);
    assert.equal(usersWithEmail(body.email).length, 1);
    assert.equal(t.emailsTo(body.email).length, 0);

    // The 60-second resend cooldown counts from the stored code, so age it instead of waiting
    const row = userRow(body.email);
    const pending = t.db.find('email_verifications', entry => entry.user_id === row.id);
    pending.created_at = new Date(Date.now() - 120000).toISOString();
    pending.expires_at = new Date(Date.now() + 60000).toISOString();
    assert.equal((await t.api('POST', '/auth/resend-code', { body: { email: body.email } })).status, 200);
    assert.equal(t.emailsTo(body.email).length, 1);
  });

  it('a rate-limited email provider is reported as delayed delivery', async () => {
    const body = registration();
    t.failNextEmail({ status: 429 });
    const response = await register(body);
    assert.equal(response.status, 500);
    assert.match(response.body.error, /^Email delivery is delayed/);
  });

  it('never writes passwords, hashes or personal details to the logs', async () => {
    const body = registration({ ...FULL_PROFILE, password: 'Log#Secret#Value9' });
    assert.equal((await register(body)).status, 201);
    await register({ ...body, confirm_password: 'Log#Secret#Mismatch' });
    t.db.failNext({ table: 'users', action: 'insert' }, { code: 'XX000', message: 'internal error' });
    await register(registration({ ...FULL_PROFILE, password: 'Log#Secret#Value9' }));

    const logs = t.logs.join('\n');
    const hash = userRow(body.email).password;
    for (const secret of [body.password, 'Log#Secret#Mismatch', hash, '+639187654321', '0918 765 4321', '1994-06-15', 'Mabini Street', 'San Antonio']) {
      assert.ok(!logs.includes(secret), `logs do not contain ${secret}`);
    }
  });
});

describe('Password storage and existing accounts', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const first = await hashPassword('Same#Password1');
    const second = await hashPassword('Same#Password1');
    assert.notEqual(first, second);
    assert.match(first, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    assert.equal(await verifyPassword('Same#Password1', first), true);
    assert.equal(await verifyPassword('Same#Password2', first), false);
    assert.equal(await verifyPassword('', first), false);
    assert.equal(await verifyPassword('anything', ''), false);
    assert.equal(await verifyPassword('anything', null), false);
  });

  it('accounts stored before hashing still log in, and the first successful login upgrades them to a hash', async () => {
    const plaintext = t.createUser({ password: 'Legacy#Plain1' });
    const legacyHash = `sha256$${crypto.createHash('sha256').update('Legacy#Sha256', 'utf8').digest('hex')}`;
    const sha256User = t.createUser({ password: legacyHash });
    // A plaintext password that merely starts like a hash is still compared as plaintext
    const lookalike = t.createUser({ password: 'scrypt$not-a-hash' });

    assert.equal((await t.api('POST', '/auth/login', { body: { email: plaintext.email, password: 'Legacy#Plain1' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: plaintext.email, password: 'Legacy#Plain2' } })).status, 403);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: sha256User.email, password: 'Legacy#Sha256' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: sha256User.email, password: legacyHash } })).status, 403);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: lookalike.email, password: 'scrypt$not-a-hash' } })).status, 200);

    // A successful login replaced the plaintext and sha256$ values with scrypt hashes of the same passwords
    const storedPlain = t.db.find('users', row => row.id === plaintext.id).password;
    const storedSha = t.db.find('users', row => row.id === sha256User.id).password;
    assert.ok(isPasswordHash(storedPlain));
    assert.ok(isPasswordHash(storedSha));
    assert.equal((await t.api('POST', '/auth/login', { body: { email: plaintext.email, password: 'Legacy#Plain1' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: sha256User.email, password: 'Legacy#Sha256' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: sha256User.email, password: legacyHash } })).status, 403);
    // The upgrade only touches rows that are not scrypt values yet, so a lookalike value is left for a password reset
    assert.equal(t.db.find('users', row => row.id === lookalike.id).password, 'scrypt$not-a-hash');
    // A failed login never rewrites anything
    const untouched = t.createUser({ password: 'Legacy#Plain3' });
    assert.equal((await t.api('POST', '/auth/login', { body: { email: untouched.email, password: 'Wrong#Plain3' } })).status, 403);
    assert.equal(t.db.find('users', row => row.id === untouched.id).password, 'Legacy#Plain3');
  });

  it('a password reset stores the new password as a hash', async () => {
    const user = t.createUser({ password: 'Before#Reset1' });
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const resetEmail = await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email');

    const tooLong = await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: codeIn(resetEmail), password: 'z'.repeat(129) } });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /128 characters or fewer/);

    const reset = await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: codeIn(resetEmail), password: 'After#Reset1' } });
    assert.equal(reset.status, 200);
    const stored = t.db.find('users', row => row.id === user.id).password;
    assert.ok(isPasswordHash(stored));
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'After#Reset1' } })).status, 200);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Before#Reset1' } })).status, 403);
  });

  it('unknown emails and wrong passwords get the same refusal', async () => {
    const user = t.createUser({ password: 'Known#Pass1' });
    const unknown = await t.api('POST', '/auth/login', { body: { email: newEmail(), password: 'Known#Pass1' } });
    const wrong = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Wrong#Pass1' } });
    assert.equal(unknown.status, 403);
    assert.deepEqual(unknown.body, wrong.body);
  });
});

describe('Profile on the user dashboard (GET /auth/user-status?include=profile)', () => {
  async function registerVerifiedUser(extra = {}) {
    const body = registration({ ...extra });
    assert.equal((await register(body)).status, 201);
    const login = await verifyAndLogin(body.email, body.password);
    assert.equal(login.status, 200);
    return { ...login.body.user, token: login.body.token };
  }

  it('returns the signed-in customer\'s own details, next to (not inside) the stored user object', async () => {
    const user = await registerVerifiedUser(FULL_PROFILE);
    const response = await t.api('GET', `/auth/user-status?user_id=${user.id}&include=profile`, { token: user.token });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.profile, {
      phone_number: '+639187654321',
      date_of_birth: '1994-06-15',
      gender: 'Female',
      address_line: 'Unit 4B, 12 Mabini Street',
      barangay: 'San Antonio',
      city_municipality: 'Pasig City',
      province: 'Metro Manila',
      postal_code: '1605'
    });
    assert.deepEqual(Object.keys(response.body.user).sort(), ['created_at', 'email', 'fullname', 'id', 'is_verified', 'role']);
    assert.ok(!response.text.includes('scrypt$'), 'the password hash is never returned');
  });

  it('is left out unless asked for; an account created before the details were required gets nulls', async () => {
    const user = await registerVerifiedUser();
    const plain = await t.api('GET', `/auth/user-status?user_id=${user.id}`, { token: user.token });
    assert.equal(plain.status, 200);
    assert.equal('profile' in plain.body, false);

    const legacy = t.createUser();
    const withProfile = await t.api('GET', `/auth/user-status?user_id=${legacy.id}&include=profile`, { token: legacy.token });
    assert.equal(withProfile.status, 200);
    assert.deepEqual(Object.values(withProfile.body.profile), Array(PROFILE_COLUMNS.length).fill(null));
  });

  it('cannot be read for another customer, or without signing in', async () => {
    const owner = await registerVerifiedUser(FULL_PROFILE);
    const other = t.createUser();
    const forbidden = await t.api('GET', `/auth/user-status?user_id=${owner.id}&include=profile`, { token: other.token });
    assert.equal(forbidden.status, 403);
    assert.ok(!forbidden.text.includes('+639187654321'));
    assert.equal((await t.api('GET', `/auth/user-status?user_id=${owner.id}&include=profile`)).status, 401);
  });

  it('admin user lists do not include the new personal details', async () => {
    const admin = t.createUser({ role: 'admin' });
    await registerVerifiedUser(FULL_PROFILE);
    for (const url of [`/admin/dashboard/users?user_id=${admin.id}`, `/admin/dashboard/overview?user_id=${admin.id}`]) {
      const response = await t.api('GET', url, { token: admin.token });
      assert.equal(response.status, 200, url);
      for (const value of ['+639187654321', '1994-06-15', 'Mabini Street', 'scrypt$']) {
        assert.ok(!response.text.includes(value), `${url} does not include ${value}`);
      }
    }
  });

  it('admin routes still refuse customers', async () => {
    const customer = t.createUser();
    const response = await t.api('GET', `/admin/dashboard/users?user_id=${customer.id}`, { token: customer.token });
    assert.equal(response.status, 403);
  });
});
