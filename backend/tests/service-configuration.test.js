// MOCKED: persistent catalog behavior on the real Express routes with an in-memory database; no live database.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;

before(async () => {
  t = await startTestApp({ serviceDurations: null });
});

after(async () => {
  await t.close();
});

describe('Persistent service settings', () => {
  it('serves the current service catalog publicly without invented duration or species rules', async () => {
    const response = await t.api('GET', '/appointments/services');
    assert.equal(response.status, 200);
    assert.equal(response.body.services.length, 9);
    assert.equal(response.body.services.find(service => service.name === 'Puppy Cut').species.length, 0);
    response.body.services.forEach(service => {
      assert.equal(service.duration_minutes, null);
      assert.equal(service.bookable, false);
      assert.ok(service.id);
    });
  });

  it('lets an authenticated admin save clinic-confirmed settings and exposes the new version', async () => {
    const admin = t.createUser({ role: 'admin' });
    const service = t.db.find('pethub_service_catalog', row => row.name === 'Bath');
    const response = await t.api('PUT', `/admin/services/${service.id}`, {
      token: admin.token,
      body: {
        name: 'Bath',
        description: 'Bathing for dogs.',
        category: 'grooming',
        species: ['Dog'],
        duration_minutes: 35,
        online_booking_enabled: true,
        display_order: 1,
        expected_version: 1
      }
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.service.bookable, true);
    assert.equal(response.body.version, 2);
    assert.deepEqual(t.db.find('pethub_service_catalog', row => row.id === service.id).species, ['Dog']);
    assert.equal(t.db.find('pethub_service_catalog', row => row.id === service.id).duration_minutes, 35);

    const publicList = await t.api('GET', '/appointments/services');
    assert.equal(publicList.body.services.find(row => row.id === service.id).bookable, true);
    const adminList = await t.api('GET', '/admin/services', { token: admin.token });
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.services.find(row => row.id === service.id).version, 2);
  });

  it('rejects owners, stale edits, duplicate names, and enabling an unconfigured service', async () => {
    const owner = t.createUser();
    const admin = t.createUser({ role: 'admin' });
    const service = t.db.find('pethub_service_catalog', row => row.name === 'Trim');
    const payload = {
      name: 'Trim', description: 'Clinic-confirmed trim service.', category: 'grooming',
      species: ['Dog'], duration_minutes: 30, online_booking_enabled: true,
      display_order: service.display_order, expected_version: 1
    };

    assert.equal((await t.api('PUT', `/admin/services/${service.id}`, { token: owner.token, body: payload })).status, 403);

    const invalid = await t.api('PUT', `/admin/services/${service.id}`, {
      token: admin.token,
      body: { ...payload, duration_minutes: null }
    });
    assert.equal(invalid.status, 422);

    const duplicate = await t.api('PUT', `/admin/services/${service.id}`, {
      token: admin.token,
      body: { ...payload, name: 'Bath' }
    });
    assert.equal(duplicate.status, 409);

    const saved = await t.api('PUT', `/admin/services/${service.id}`, { token: admin.token, body: payload });
    assert.equal(saved.status, 200);
    const stale = await t.api('PUT', `/admin/services/${service.id}`, { token: admin.token, body: payload });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /changed after the page loaded/i);
  });
});
