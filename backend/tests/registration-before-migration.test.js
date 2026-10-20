// The backend deployed on a database that does not have the optional profile columns yet
// (database/migrations/2026-10-20_users_profile_fields.sql not applied), and checks on that migration file.
// Registration without personal details, login, user status and the admin lists must keep working; registration
// with personal details must be refused clearly instead of dropping them silently.
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

function registration(overrides = {}) {
  return { fullname: 'Before Migration', email: `${crypto.randomUUID()}@example.test`, password: 'Before#Migration1', confirm_password: 'Before#Migration1', ...overrides };
}

describe('Before the profile migration is applied', () => {
  it('registration without personal details still works', async () => {
    const body = registration({ phone_number: '', gender: '' });
    const response = await t.api('POST', '/auth/register', { body });
    assert.equal(response.status, 201);
    assert.equal(t.db.table('users').filter(row => row.email === body.email).length, 1);
  });

  it('registration with personal details is refused with a clear message and creates nothing', async () => {
    const body = registration({ date_of_birth: '1990-01-01', city_municipality: 'Quezon City' });
    const response = await t.api('POST', '/auth/register', { body });
    assert.equal(response.status, 503);
    assert.match(response.body.error, /Personal details cannot be saved right now/);
    assert.equal(t.db.table('users').filter(row => row.email === body.email).length, 0);
    assert.equal(t.emailsTo(body.email).length, 0);

    const logs = t.logs.join('\n');
    assert.match(logs, /2026-10-20_users_profile_fields\.sql/, 'the log names the missing migration');
    assert.ok(!logs.includes('Quezon City'));
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

  it('only adds nullable columns to users (no drops, deletes, updates, policies or grants)', () => {
    assert.doesNotMatch(statements, /\b(DROP|DELETE|UPDATE|TRUNCATE|INSERT|GRANT|REVOKE|POLICY|RENAME)\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|ENABLE\s+ROW/i);
    assert.doesNotMatch(statements, /ALTER\s+TABLE\s+(?!public\.users\b)/i, 'no other table is altered');
    const alterStatements = statements.match(/ALTER\s+TABLE[^;]*;/gi) || [];
    assert.equal(alterStatements.length, 1);
    assert.doesNotMatch(alterStatements[0], /\bNOT\s+NULL\b|\bDEFAULT\b|\bCHECK\b|\bUNIQUE\b|\bREFERENCES\b/i, 'new columns are plain nullable columns');
    assert.match(statements, /BEGIN;[\s\S]*COMMIT;/);
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
