// The backend deployed on a database that does not have the profile columns yet
// (database/migrations/2026-10-20_users_profile_fields.sql not applied), and checks on that migration file.
// Login, user status and the admin lists must keep working. Registration (whose personal details are required) and
// profile updates must be refused clearly, saving nothing, instead of creating accounts without the details.
// This is why the migration has to be applied before this backend is deployed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startTestApp } = require('./helpers/harness');
const { USERS_PROFILE_MIGRATION_COLUMNS } = require('./helpers/fakeSupabase');

const BACKEND = path.join(__dirname, '..');
const MIGRATION = path.join(BACKEND, 'database', 'migrations', '2026-10-20_users_profile_fields.sql');

let t;

before(async () => {
  t = await startTestApp({ database: { usersProfileColumns: false } });
});

after(async () => {
  await t.close();
});

const DETAILS = Object.freeze({
  date_of_birth: '1990-01-01',
  gender: 'Female',
  phone_number: '0917 123 4567',
  address_line: '12 Mabini Street',
  barangay: 'San Isidro',
  city_municipality: 'Quezon City',
  province: 'Metro Manila',
  postal_code: '1100'
});

function registration(overrides = {}) {
  return {
    fullname: 'Before Migration',
    email: `${crypto.randomUUID()}@example.test`,
    password: 'Before#Migration1',
    confirm_password: 'Before#Migration1',
    ...DETAILS,
    ...overrides
  };
}

describe('Before the profile migration is applied', () => {
  it('registration without personal details is refused by validation, as on any database', async () => {
    const body = registration({ phone_number: '', gender: '' });
    const response = await t.api('POST', '/auth/register', { body });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, 'gender');
    assert.equal(t.db.table('users').filter(row => row.email === body.email).length, 0);
  });

  it('a complete registration is refused with a clear message and creates nothing', async () => {
    const body = registration();
    const response = await t.api('POST', '/auth/register', { body });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /New accounts cannot be created right now/);
    assert.equal(t.db.table('users').filter(row => row.email === body.email).length, 0);
    assert.equal(t.emailsTo(body.email).length, 0);

    const logs = t.logs.join('\n');
    assert.match(logs, /2026-10-20_users_profile_fields\.sql/, 'the log names the missing migration');
    assert.ok(!logs.includes('Quezon City'));
  });

  it('a profile update is refused with a clear message and changes nothing', async () => {
    const user = t.createUser({ name: 'Unchanged Name' });
    const response = await t.api('PUT', '/auth/profile', { token: user.token, body: { fullname: 'New Name', ...DETAILS } });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /cannot be saved right now/);
    assert.equal(t.db.find('users', row => row.id === user.id).fullname, 'Unchanged Name');
    assert.match(t.logs.join('\n'), /Profile update error: .*2026-10-20_users_profile_fields\.sql/);
  });

  it('login, user status and the admin lists keep working; the dashboard profile is reported as unavailable', async () => {
    const user = t.createUser({ password: 'Legacy#Plain1' });
    const admin = t.createUser({ role: 'admin' });

    const login = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'Legacy#Plain1' } });
    assert.equal(login.status, 200);
    const status = await t.api('GET', `/auth/user-status?user_id=${user.id}`, { token: user.token });
    assert.equal(status.status, 200);
    const withProfile = await t.api('GET', `/auth/user-status?user_id=${user.id}&include=profile`, { token: user.token });
    assert.equal(withProfile.status, 200);
    assert.equal(withProfile.body.user.id, user.id);
    assert.equal(withProfile.body.profile, null);

    for (const url of ['/admin/dashboard/users', '/admin/dashboard/overview']) {
      assert.equal((await t.api('GET', `${url}?user_id=${admin.id}`, { token: admin.token })).status, 200, url);
    }
  });
});

describe('The profile migration file', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const statements = sql
    .split('\n')
    .map(line => line.replace(/--.*$/, '').trim())
    .filter(Boolean)
    .join('\n');

  it('only adds nullable columns to users, with checks that accept NULL (no drops, deletes, updates, policies or grants)', () => {
    assert.doesNotMatch(statements, /\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT|GRANT|REVOKE|POLICY|RENAME)\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|ENABLE\s+ROW/i);
    assert.doesNotMatch(statements, /ALTER\s+TABLE\s+(?!public\.users\b)/i, 'no other table is altered');
    const alterStatements = statements.match(/ALTER\s+TABLE[^;]*;/gi) || [];
    assert.equal(alterStatements.length, 1);
    // Existing accounts have no details, so nothing may be NOT NULL, defaulted, unique or referenced
    assert.doesNotMatch(alterStatements[0], /\bNOT\s+NULL\b|\bDEFAULT\b|\bUNIQUE\b|\bREFERENCES\b/i);
    const checks = [...alterStatements[0].matchAll(/ADD CONSTRAINT (\w+) CHECK \((\w+) IS NULL OR /g)].map(match => match[2]);
    assert.deepEqual(checks, USERS_PROFILE_MIGRATION_COLUMNS, 'one NULL-accepting check per new column');
    assert.equal((alterStatements[0].match(/\bCHECK\b/g) || []).length, USERS_PROFILE_MIGRATION_COLUMNS.length);
    assert.match(statements, /BEGIN;[\s\S]*COMMIT;/);
  });

  it('repeats the backend rules in its checks', () => {
    const { GENDER_OPTIONS, ADDRESS_MAX_LENGTHS, EARLIEST_DATE_OF_BIRTH } = require(path.join(BACKEND, 'constants', 'userProfile.js'));
    const genderCheck = statements.match(/gender IN \(([^)]*)\)/)[1].split(',').map(option => option.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(genderCheck, GENDER_OPTIONS);
    for (const [column, maxLength] of Object.entries(ADDRESS_MAX_LENGTHS)) {
      assert.match(statements, new RegExp(`char_length\\(${column}\\) BETWEEN 1 AND ${maxLength}\\)`), column);
    }
    assert.match(statements, new RegExp(`date_of_birth >= DATE '${EARLIEST_DATE_OF_BIRTH}'`));
    assert.ok(statements.includes("postal_code ~ '^[0-9]{4}$'"), 'postal code check');
  });

  it('adds exactly the columns the backend reads and the test database models', () => {
    const added = [...statements.matchAll(/ADD COLUMN IF NOT EXISTS (\w+) (\w+)/g)].map(match => [match[1], match[2]]);
    assert.deepEqual(added.map(([column]) => column), USERS_PROFILE_MIGRATION_COLUMNS);
    assert.deepEqual(Object.fromEntries(added).date_of_birth, 'date');
    added.filter(([column]) => column !== 'date_of_birth').forEach(([column, type]) => assert.equal(type, 'text', column));

    const { PROFILE_COLUMNS } = require(path.join(BACKEND, 'constants', 'userProfile.js'));
    assert.deepEqual([...PROFILE_COLUMNS].sort(), ['phone_number', ...USERS_PROFILE_MIGRATION_COLUMNS].sort(), 'phone_number already exists; the rest come from the migration');

    const repository = fs.readFileSync(path.join(BACKEND, 'repositories', 'usersRepository.js'), 'utf8');
    const profileSelect = repository.match(/USER_PROFILE_SELECT = '([^']+)'/)[1].split(',').map(column => column.trim());
    assert.deepEqual(profileSelect.filter(column => column !== 'id').sort(), [...PROFILE_COLUMNS].sort());
    const sharedSelects = [...repository.matchAll(/const USER_(?!PROFILE)\w+_SELECT = '([^']+)'/g)].map(match => match[1]).join(',');
    USERS_PROFILE_MIGRATION_COLUMNS.forEach(column => assert.ok(!sharedSelects.includes(column), `${column} is not in a shared select`));
  });

  it('is marked as not applied', () => {
    assert.match(sql, /NOT APPLIED/);
  });
});
