// Persisted breed catalog, tested with the in-memory PetHub database only (no Supabase or external service calls).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

describe('Owner breed choices', () => {
  it('returns only active choices for the selected species', async () => {
    const owner = t.createUser();
    const dogBreeds = await t.api('GET', '/pets/breeds?species=Dog', { token: owner.token });
    const catBreeds = await t.api('GET', '/pets/breeds?species=Cat', { token: owner.token });
    assert.equal(dogBreeds.status, 200);
    assert.ok(dogBreeds.body.breeds.some(entry => entry.name === 'Beagle'));
    assert.ok(dogBreeds.body.breeds.every(entry => entry.species === 'Dog'));
    assert.equal(catBreeds.status, 200);
    assert.ok(catBreeds.body.breeds.some(entry => entry.name === 'Siamese'));
    assert.ok(catBreeds.body.breeds.every(entry => entry.species === 'Cat'));
    assert.equal((await t.api('GET', '/pets/breeds?species=Rabbit', { token: owner.token })).status, 400);
  });

  it('validates a breed against its species, while Mixed Breed and explicit Other remain available', async () => {
    const owner = t.createUser();
    assert.equal((await t.api('POST', '/pets/create', { token: owner.token, body: { name: 'Mochi', species: 'Dog', breed: 'Siamese', age: 3 } })).status, 400);
    const mixed = await t.api('POST', '/pets/create', { token: owner.token, body: { user_id: owner.id, name: 'Mochi', species: 'Dog', breed: 'Mixed Breed', age: 3 } });
    assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
    const other = await t.api('POST', '/pets/create', { token: owner.token, body: { user_id: owner.id, name: 'Luna', species: 'Cat', breed: 'Blue Puspin', breed_other: true, age: 2 } });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.equal(other.body.pet.breed, 'Blue Puspin');
  });
});

describe('Administrator breed catalog', () => {
  it('is admin-only and a saved admin entry is persisted as unverified and appears on a fresh owner response', async () => {
    const owner = t.createUser();
    const admin = t.createUser({ role: 'admin' });
    assert.equal((await t.api('GET', '/admin/breeds', { token: owner.token })).status, 403);
    assert.equal((await t.api('GET', '/admin/breeds')).status, 401);

    const added = await t.api('POST', '/admin/breeds', {
      token: admin.token,
      body: { species: 'Dog', name: '  Unverified   Clinic Terrier  ', source_organization: 'Clinic review' }
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.breed.name, 'Unverified Clinic Terrier');
    assert.equal(added.body.breed.recognition_status, 'unverified');
    assert.equal(added.body.breed.source_reviewed_at, null);
    const fresh = await t.api('GET', '/pets/breeds?species=Dog', { token: owner.token });
    assert.ok(fresh.body.breeds.some(entry => entry.id === added.body.breed.id && entry.name === 'Unverified Clinic Terrier'));
    const logs = t.db.table('activity_logs').filter(row => row.target_table === 'pet_breed_catalog');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].actor_id, admin.id);
  });

  it('rejects same-species case-insensitive duplicates, but permits the same display name for another species', async () => {
    const admin = t.createUser({ role: 'admin' });
    const added = await t.api('POST', '/admin/breeds', { token: admin.token, body: { species: 'Dog', name: 'Duplicate Terrier' } });
    assert.equal(added.status, 201);
    const duplicate = await t.api('POST', '/admin/breeds', { token: admin.token, body: { species: 'Dog', name: '  duplicate   terrier ' } });
    assert.equal(duplicate.status, 409);
    const otherSpecies = await t.api('POST', '/admin/breeds', { token: admin.token, body: { species: 'Cat', name: 'Duplicate Terrier' } });
    assert.equal(otherSpecies.status, 201);
  });

  it('can rename and deactivate without deleting or rewriting existing pet breed values', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const added = await t.api('POST', '/admin/breeds', { token: admin.token, body: { species: 'Dog', name: 'Retained Terrier' } });
    const pet = t.createPet(owner);
    const edited = await t.api('PUT', `/pets/update/${pet.id}`, { token: owner.token, body: { user_id: owner.id, breed: 'Retained Terrier' } });
    assert.equal(edited.status, 200);

    const renamed = await t.api('PUT', `/admin/breeds/${added.body.breed.id}`, { token: admin.token, body: { name: 'Updated Terrier' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.breed.name, 'Updated Terrier');
    const disabled = await t.api('PUT', `/admin/breeds/${added.body.breed.id}`, { token: admin.token, body: { is_active: false } });
    assert.equal(disabled.status, 200);
    assert.equal(t.db.find('pets', row => row.id === pet.id).breed, 'Retained Terrier');
    const ownerChoices = await t.api('GET', '/pets/breeds?species=Dog', { token: owner.token });
    assert.ok(!ownerChoices.body.breeds.some(entry => entry.id === added.body.breed.id));
    const adminList = await t.api('GET', '/admin/breeds?species=Dog', { token: admin.token });
    assert.equal(adminList.body.breeds.find(entry => entry.id === added.body.breed.id).is_active, false);
  });
});
