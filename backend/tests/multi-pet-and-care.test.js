// Multi-pet bookings, clinic rescheduling, admin-managed services with their activity history, breed catalog pages and
// pet care recommendations (2026-10-24 additions).
// MOCKED: the real Express app with the in-memory database and fake Brevo (helpers/harness.js); the database functions
// are emulated with the same outcomes the live dry run of the migration showed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp({ serviceSpecies: { 'Puppy Cut': ['Dog'] } }); });
after(async () => { await t.close(); });

const service = name => t.db.find('pethub_service_catalog', row => row.name === name);
const pet = (owner, name, species = 'Dog', breed = 'Aspin') => t.db.seed('pets', { user_id: owner.id, name, species, breed, age: 3 });
const book = (owner, { date = t.manilaDate(10), time = '09:00', items, token = owner.token } = {}) =>
  t.api('POST', '/appointments/group', { token, body: { user_id: owner.id, appointment_date: date, appointment_time: time, items } });
const rowsOfGroup = groupId => t.db.table('appointments').filter(row => row.group_id === groupId).sort((a, b) => a.group_position - b.group_position);
const setStatus = (admin, id, status) => t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id, status } });
let dayCounter = 30;
const freshDay = () => t.manilaDate(dayCounter++);

describe('Multi-pet booking (POST /appointments/group)', () => {
  it('books two pets with the same service, one after another, in one booking', async () => {
    const owner = t.createUser();
    const [a, b] = [pet(owner, 'Brownie'), pet(owner, 'Mochi')];
    const bath = service('Bath');
    const date = freshDay();
    const response = await book(owner, { date, items: [{ pet_id: a.id, service_id: bath.id }, { pet_id: b.id, service_id: bath.id }] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.group.pet_count, 2);
    assert.equal(response.body.group.scheduling, 'sequential');
    assert.equal(response.body.group.total_duration_minutes, bath.duration_minutes * 2);
    const rows = rowsOfGroup(response.body.group.id);
    assert.deepEqual(rows.map(row => [row.pet_name, row.service_type, row.status, row.appointment_time.slice(0, 5), row.group_position]), [
      ['Brownie', 'Bath', 'Pending', '09:00', 1],
      ['Mochi', 'Bath', 'Pending', `${String(9 + Math.floor(bath.duration_minutes / 60)).padStart(2, '0')}:${String(bath.duration_minutes % 60).padStart(2, '0')}`, 2]
    ]);
    // Both dashboards read the same rows
    const ownerList = await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token });
    assert.equal(ownerList.body.appointments.filter(row => row.group_id === response.body.group.id).length, 2);
  });

  it('books different services for different pets, and three or more pets', async () => {
    const owner = t.createUser();
    const cat = pet(owner, 'Luna', 'Cat', 'Puspin');
    const dogs = [pet(owner, 'Rex'), pet(owner, 'Bantay')];
    const items = [
      { pet_id: dogs[0].id, service_id: service('Puppy Cut').id },
      { pet_id: cat.id, service_id: service('Dog & Cat Full Check Up').id },
      { pet_id: dogs[1].id, service_id: service('Nail Cutting').id }
    ];
    const response = await book(owner, { date: freshDay(), time: '10:00', items });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.deepEqual(rowsOfGroup(response.body.group.id).map(row => row.service_type), ['Puppy Cut', 'Dog & Cat Full Check Up', 'Nail Cutting']);
    assert.equal(response.body.group.total_duration_minutes, items.reduce((sum, item) => sum + t.db.find('pethub_service_catalog', s => s.id === item.service_id).duration_minutes, 0));
  });

  it("refuses another owner's pet and names the position; nothing is saved", async () => {
    const owner = t.createUser();
    const stranger = t.createUser();
    const before = t.db.table('appointments').length;
    const response = await book(owner, { date: freshDay(), items: [
      { pet_id: pet(owner, 'Own').id, service_id: service('Bath').id },
      { pet_id: pet(stranger, 'NotYours').id, service_id: service('Bath').id }
    ] });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body.item_errors.map(item => [item.position, item.field]), [[2, 'pet_id']]);
    assert.match(response.body.item_errors[0].error, /not on your account/);
    assert.equal(t.db.table('appointments').length, before);
  });

  it('explains which pet and service are unavailable, and keeps nothing half-saved', async () => {
    const owner = t.createUser();
    const cat = pet(owner, 'Whiskers', 'Cat', 'Puspin');
    const dog = pet(owner, 'Choco');
    const trim = service('Trim');
    trim.online_booking_enabled = false;
    try {
      const before = t.db.table('appointments').length;
      const response = await book(owner, { date: freshDay(), items: [
        { pet_id: dog.id, service_id: service('Bath').id },
        { pet_id: cat.id, service_id: service('Puppy Cut').id },
        { pet_id: pet(owner, 'Third').id, service_id: trim.id }
      ] });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body.item_errors.map(item => [item.position, item.pet_name]), [[2, 'Whiskers'], [3, 'Third']]);
      assert.match(response.body.item_errors[0].error, /Puppy Cut is offered for dogs only/);
      assert.match(response.body.item_errors[1].error, /Trim is temporarily unavailable/);
      assert.equal(t.db.table('appointments').length, before);
    } finally {
      trim.online_booking_enabled = true;
    }
  });

  it('refuses a booking whose slot overlaps another appointment, naming the pet, with a whole-booking suggestion', async () => {
    const owner = t.createUser();
    const other = t.createUser();
    const date = freshDay();
    const bath = service('Bath');
    // Another owner's appointment starts during the second pet's slot
    t.db.seed('appointments', { user_id: other.id, pet_id: pet(other, 'Busy').id, pet_name: 'Busy', service_type: 'Bath', estimated_duration_minutes: 30, appointment_date: date, appointment_time: `${String(9 + Math.floor((bath.duration_minutes + 10) / 60)).padStart(2, '0')}:${String((bath.duration_minutes + 10) % 60).padStart(2, '0')}:00`, status: 'Approved' });
    const before = t.db.table('appointments').length;
    const response = await book(owner, { date, items: [{ pet_id: pet(owner, 'One').id, service_id: bath.id }, { pet_id: pet(owner, 'Two').id, service_id: bath.id }] });
    assert.equal(response.status, 409);
    assert.equal(response.body.position, 2);
    assert.match(response.body.error, /Two's Bath/);
    assert.ok(response.body.suggested_time, 'a start time where the whole booking fits');
    assert.equal(t.db.table('appointments').length, before);
    const retried = await book(owner, { date, time: response.body.suggested_time, items: [{ pet_id: t.db.find('pets', p => p.name === 'One' && p.user_id === owner.id).id, service_id: bath.id }, { pet_id: t.db.find('pets', p => p.name === 'Two' && p.user_id === owner.id).id, service_id: bath.id }] });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
  });

  it('a repeated request returns the same booking instead of a second one', async () => {
    const owner = t.createUser();
    const items = [{ pet_id: pet(owner, 'Twice1').id, service_id: service('Bath').id }, { pet_id: pet(owner, 'Twice2').id, service_id: service('Bath').id }];
    const date = freshDay();
    const first = await book(owner, { date, items });
    const second = await book(owner, { date, items });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.already_booked, true);
    assert.equal(second.body.group.id, first.body.group.id);
    assert.equal(t.db.table('appointment_groups').filter(group => group.user_id === owner.id).length, 1);
  });

  it('a failed database call leaves no booking behind', async () => {
    const owner = t.createUser();
    const before = [t.db.table('appointments').length, t.db.table('appointment_groups').length];
    t.db.failNext({ table: 'appointments', action: 'rpc' }, { code: '08006', message: 'connection failure' });
    const response = await book(owner, { date: freshDay(), items: [{ pet_id: pet(owner, 'F1').id, service_id: service('Bath').id }, { pet_id: pet(owner, 'F2').id, service_id: service('Bath').id }] });
    assert.equal(response.status, 500);
    assert.deepEqual([t.db.table('appointments').length, t.db.table('appointment_groups').length], before);
  });

  it('validates the shape: one pet, too many pets, the same pet twice, a past date, past midnight', async () => {
    const owner = t.createUser();
    const dog = pet(owner, 'Solo');
    const bath = service('Bath');
    assert.equal((await book(owner, { items: [{ pet_id: dog.id, service_id: bath.id }] })).status, 400);
    const many = Array.from({ length: 7 }, (_, index) => ({ pet_id: pet(owner, `Many${index}`).id, service_id: bath.id }));
    assert.match((await book(owner, { items: many })).body.error, /up to 6 pets/);
    const twice = await book(owner, { items: [{ pet_id: dog.id, service_id: bath.id }, { pet_id: dog.id, service_id: service('Trim').id }] });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.item_errors[0].position, 2);
    const past = await book(owner, { date: t.manilaDate(-1), items: [{ pet_id: dog.id, service_id: bath.id }, { pet_id: pet(owner, 'Past2').id, service_id: bath.id }] });
    assert.equal(past.status, 400);
    const late = await book(owner, { date: freshDay(), time: '23:45', items: [{ pet_id: dog.id, service_id: bath.id }, { pet_id: pet(owner, 'Late2').id, service_id: bath.id }] });
    assert.equal(late.status, 400);
    assert.match(late.body.error, /past midnight/);
    assert.equal((await t.api('POST', '/appointments/group', { body: { items: [] } })).status, 401);
  });
});

describe('Admin manages each pet of a booking', () => {
  async function bookedGroup() {
    const owner = t.createUser({ name: 'Group Owner' });
    const response = await book(owner, { date: freshDay(), items: [
      { pet_id: pet(owner, 'Alpha').id, service_id: service('Bath').id },
      { pet_id: pet(owner, 'Beta').id, service_id: service('Trim').id },
      { pet_id: pet(owner, 'Gamma').id, service_id: service('Nail Cutting').id }
    ] });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { owner, group: response.body.group, rows: rowsOfGroup(response.body.group.id) };
  }

  it('approving one pet changes only that pet; the email names every pet of the booking', async () => {
    const admin = t.createUser({ role: 'admin' });
    const { owner, rows } = await bookedGroup();
    const approved = await setStatus(admin, rows[0].id, 'Approved');
    assert.equal(approved.status, 200);
    assert.deepEqual(rowsOfGroup(rows[0].group_id).map(row => row.status), ['Approved', 'Pending', 'Pending']);
    await t.settleEmails();
    const email = t.emailsTo(owner.email).find(item => /Approved/.test(item.subject));
    assert.match(email.text, /one part of a booking for 3 pets: Alpha \(Bath[\s\S]*Beta \(Trim[\s\S]*Gamma \(Nail Cutting/);
    assert.match(email.text, /this email is about Alpha only/);
  });

  it('cancelling the whole booking cancels every open pet appointment, records each, and leaves finished ones', async () => {
    const admin = t.createUser({ role: 'admin' });
    const { owner, group, rows } = await bookedGroup();
    rows[2].status = 'Completed';
    const response = await t.api('POST', `/admin/appointment-groups/${group.id}/cancel?user_id=${admin.id}`, { token: admin.token, body: {} });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body.cancelled_appointment_ids, [rows[0].id, rows[1].id]);
    assert.deepEqual(rowsOfGroup(group.id).map(row => [row.status, row.cancelled_by ?? null]), [['Cancelled', admin.id], ['Cancelled', admin.id], ['Completed', null]]);
    assert.equal(response.body.unchanged[0].pet_name, 'Gamma');
    assert.equal(t.db.table('activity_logs').filter(row => [rows[0].id, rows[1].id].includes(row.target_id) && /whole booking cancelled/.test(row.action)).length, 2);
    await t.settleEmails();
    assert.equal(t.emailsTo(owner.email).filter(item => /Cancelled/.test(item.subject)).length, 2);
    assert.equal((await t.api('POST', `/admin/appointment-groups/${group.id}/cancel?user_id=${admin.id}`, { token: admin.token, body: {} })).status, 409);
    assert.equal((await t.api('POST', `/admin/appointment-groups/${group.id}/cancel?user_id=${owner.id}`, { token: owner.token, body: {} })).status, 403);
    assert.equal((await t.api('POST', `/admin/appointment-groups/${crypto.randomUUID()}/cancel?user_id=${admin.id}`, { token: admin.token, body: {} })).status, 404);
  });

  it('rescheduling moves one pet only, checks the slot and refuses stale or forbidden requests', async () => {
    const admin = t.createUser({ role: 'admin' });
    const { owner, rows } = await bookedGroup();
    // Copies of what the admin's screen showed before the move (the rows themselves change)
    const target = { ...rows[1] };
    const otherDates = [rows[0].appointment_date, rows[2].appointment_date];
    const newDate = freshDay();
    const move = (body, as = admin) => t.api('PUT', `/admin/appointments/${target.id}/schedule?user_id=${as.id}`, { token: as.token, body: {
      appointment_date: newDate, appointment_time: '15:00', expected_status: 'Pending', expected_date: target.appointment_date, expected_time: target.appointment_time, ...body
    } });
    assert.equal((await move({}, owner)).status, 403);
    const moved = await move({});
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.appointment.appointment_date, newDate);
    assert.deepEqual(rowsOfGroup(target.group_id).map(row => row.appointment_date), [otherDates[0], newDate, otherDates[1]]);
    await t.settleEmails();
    const email = t.emailsTo(owner.email).find(item => /Rescheduled/.test(item.subject));
    assert.match(email.text, /Previously:/);
    assert.match(email.text, /3:00 PM/);
    // The screen still shows the old time: refused, nothing changes
    const stale = await move({ appointment_time: '16:00' });
    assert.equal(stale.status, 409);
    // A busy slot is refused with a suggestion
    t.db.seed('appointments', { user_id: owner.id, pet_id: rows[0].pet_id, pet_name: 'Busy', service_type: 'Bath', estimated_duration_minutes: 30, appointment_date: newDate, appointment_time: '17:00:00', status: 'Approved' });
    const busy = await t.api('PUT', `/admin/appointments/${target.id}/schedule?user_id=${admin.id}`, { token: admin.token, body: {
      appointment_date: newDate, appointment_time: '17:00', expected_status: 'Pending', expected_date: newDate, expected_time: '15:00'
    } });
    assert.equal(busy.status, 409);
    assert.ok(busy.body.suggested_time);
    const same = await t.api('PUT', `/admin/appointments/${target.id}/schedule?user_id=${admin.id}`, { token: admin.token, body: {
      appointment_date: newDate, appointment_time: '15:00', expected_status: 'Pending', expected_date: newDate, expected_time: '15:00'
    } });
    assert.equal(same.status, 400);
  });
});

describe('Admin-managed service catalog', () => {
  const newService = (overrides = {}) => ({
    name: `Dental Cleaning ${crypto.randomUUID().slice(0, 6)}`, description: 'Professional teeth cleaning.', category: 'veterinary',
    species: ['Dog', 'Cat'], duration_minutes: 60, online_booking_enabled: false, display_order: 20, ...overrides
  });

  it('adds a service that the booking page lists at once, and records who added it', async () => {
    const admin = t.createUser({ role: 'admin' });
    const body = newService({ online_booking_enabled: true });
    const created = await t.api('POST', `/admin/services?user_id=${admin.id}`, { token: admin.token, body });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.service.bookable, true);
    const row = t.db.find('pethub_service_catalog', item => item.id === created.body.service.id);
    assert.equal(row.created_by, admin.id);
    assert.match(row.service_key, /^dental-cleaning-/);
    const publicList = await t.api('GET', '/appointments/services');
    assert.ok(publicList.body.services.some(item => item.name === body.name && item.bookable));
    // ... and can be booked right away, also for several pets
    const owner = t.createUser();
    const group = await book(owner, { date: freshDay(), items: [{ pet_id: pet(owner, 'Toothy').id, service_id: row.id }, { pet_id: pet(owner, 'Smiley', 'Cat', 'Puspin').id, service_id: row.id }] });
    assert.equal(group.status, 201, JSON.stringify(group.body));
  });

  it('refuses activation without a duration or species, a duplicate name, unknown fields, and non-admins', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const post = (body, as = admin) => t.api('POST', `/admin/services?user_id=${as.id}`, { token: as.token, body });
    assert.equal((await post(newService({ duration_minutes: null, online_booking_enabled: true }))).body.field, 'duration_minutes');
    assert.equal((await post(newService({ species: [], online_booking_enabled: true }))).body.field, 'species');
    assert.equal((await post(newService({ name: 'bath ' }))).status, 409);
    assert.equal((await post({ ...newService(), id: crypto.randomUUID() })).status, 422);
    assert.equal((await post(newService(), owner)).status, 403);
    const unconfigured = await post(newService({ duration_minutes: null }));
    assert.equal(unconfigured.status, 201);
    assert.equal(unconfigured.body.service.bookable, false);
  });

  it('editing and deactivating a service never changes existing appointments', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const created = await t.api('POST', `/admin/services?user_id=${admin.id}`, { token: admin.token, body: newService({ online_booking_enabled: true }) });
    const row = t.db.find('pethub_service_catalog', item => item.id === created.body.service.id);
    const appointment = t.db.seed('appointments', { user_id: owner.id, pet_id: pet(owner, 'Kept').id, pet_name: 'Kept', service_type: row.name, estimated_duration_minutes: 60, appointment_date: freshDay(), appointment_time: '09:00:00', status: 'Approved' });
    const snapshot = JSON.stringify(appointment);
    const update = await t.api('PUT', `/admin/services/${row.id}?user_id=${admin.id}`, { token: admin.token, body: {
      name: row.name, description: 'Updated description', category: row.category, species: row.species, duration_minutes: 90,
      online_booking_enabled: false, display_order: row.display_order, expected_version: row.version
    } });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(JSON.stringify(t.db.find('appointments', item => item.id === appointment.id)), snapshot);
    const admins = await t.api('GET', `/admin/services?user_id=${admin.id}`, { token: admin.token });
    assert.equal(admins.body.services.find(item => item.id === row.id).appointment_count, 1);
    const publicList = await t.api('GET', '/appointments/services');
    assert.equal(publicList.body.services.find(item => item.id === row.id).bookable, false);
  });

  it('service activity: newest first, typed, with change details, filters and pages', async () => {
    const admin = t.createUser({ role: 'admin', name: 'Activity Admin' });
    const created = await t.api('POST', `/admin/services?user_id=${admin.id}`, { token: admin.token, body: newService() });
    let row = t.db.find('pethub_service_catalog', item => item.id === created.body.service.id);
    const put = changes => t.api('PUT', `/admin/services/${row.id}?user_id=${admin.id}`, { token: admin.token, body: {
      name: row.name, description: row.description, category: row.category, species: row.species, duration_minutes: row.duration_minutes,
      online_booking_enabled: row.online_booking_enabled, display_order: row.display_order, expected_version: row.version, ...changes
    } });
    assert.equal((await put({ online_booking_enabled: true })).status, 200);
    row = t.db.find('pethub_service_catalog', item => item.id === row.id);
    assert.equal((await put({ duration_minutes: 45 })).status, 200);
    row = t.db.find('pethub_service_catalog', item => item.id === row.id);
    assert.equal((await put({ online_booking_enabled: false })).status, 200);
    // An entry recorded before types existed
    t.db.seed('activity_logs', { actor_id: admin.id, user_id: admin.id, target_table: 'pethub_service_catalog', target_id: row.id, action: `Updated service configuration for ${row.name}`, created_at: '2026-01-01T00:00:00.000Z' });

    const activity = query => t.api('GET', `/admin/services/activity?user_id=${admin.id}&service_id=${row.id}${query || ''}`, { token: admin.token });
    const all = await activity('&page_size=10');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.entries.map(entry => entry.event_type), ['service_deactivated', 'service_updated', 'service_activated', 'service_created', 'legacy']);
    assert.match(all.body.entries[1].details, /Duration: 60 min → 45 min/);
    assert.equal(all.body.entries[0].admin_name, 'Activity Admin');
    assert.equal(all.body.entries[4].event_label, 'Settings changed (details were not recorded then)');

    const paged = await activity('&page_size=2&page=2');
    assert.deepEqual([paged.body.page, paged.body.total, paged.body.total_pages, paged.body.entries.length], [2, 5, 3, 2]);
    assert.equal((await activity('&page_size=2&page=9')).body.page, 3, 'a page past the end shows the last page');
    assert.deepEqual((await activity('&type=service_activated')).body.entries.map(entry => entry.event_type), ['service_activated']);
    assert.equal((await activity('&type=legacy')).body.total, 1);
    assert.equal((await activity(`&admin_id=${crypto.randomUUID()}`)).body.total, 0);
    assert.equal((await activity('&from=2026-01-01&to=2026-01-01')).body.total, 1);
    assert.equal((await activity('&type=nonsense')).status, 400);
    const owner = t.createUser();
    assert.equal((await t.api('GET', `/admin/services/activity?user_id=${owner.id}`, { token: owner.token })).status, 403);
  });
});

describe('Breed catalog pages (GET /admin/breeds)', () => {
  it('pages, searches, filters and sorts in the database and keeps the filters in the reply', async () => {
    const admin = t.createUser({ role: 'admin' });
    const list = query => t.api('GET', `/admin/breeds?user_id=${admin.id}&${query}`, { token: admin.token });
    const totalDogs = t.db.table('pet_breed_catalog').filter(row => row.species === 'Dog' && row.is_active).length;
    const first = await list('species=Dog&status=active&page=1&page_size=10');
    assert.equal(first.status, 200);
    assert.deepEqual([first.body.breeds.length, first.body.total, first.body.total_pages, first.body.page], [10, totalDogs, Math.ceil(totalDogs / 10), 1]);
    const second = await list('species=Dog&status=active&page=2&page_size=10');
    assert.ok(second.body.breeds.every(row => !first.body.breeds.some(other => other.id === row.id)), 'no overlap between pages');
    assert.ok(first.body.breeds.every((row, index, rows) => index === 0 || rows[index - 1].name.localeCompare(row.name) <= 0));
    assert.deepEqual(first.body.filters, { species: 'Dog', status: 'active', search: '', sort: 'name_asc' });

    const searched = await list('species=Dog&status=all&q=terrier&page_size=5');
    assert.ok(searched.body.breeds.every(row => /terrier/i.test(row.name) || /terrier/i.test(row.source_organization || '')));
    assert.equal(searched.body.filters.search, 'terrier');
    const desc = await list('species=Dog&sort=name_desc&page_size=3');
    assert.ok(desc.body.breeds[0].name.localeCompare(desc.body.breeds[1].name) >= 0);

    // A page past the end (e.g. after entries were disabled) shows the last page; no match shows an empty first page
    const past = await list('species=Dog&status=active&page=99&page_size=10');
    assert.equal(past.body.page, first.body.total_pages);
    const none = await list('q=zzzz-no-such-breed');
    assert.deepEqual([none.body.total, none.body.page, none.body.breeds.length], [0, 1, 0]);
    assert.equal((await list('status=sometimes')).status, 400);
    // Search text cannot change the filter itself
    const injected = await list('q=' + encodeURIComponent('a,is_active.eq.false)'));
    assert.equal(injected.status, 200);
  });
});

describe('Pet care recommendations', () => {
  async function completed(owner, dog, serviceName, daysAgo = 1) {
    const admin = t.createUser({ role: 'admin' });
    const appointment = t.db.seed('appointments', {
      user_id: owner.id, pet_id: dog.id, pet_name: dog.name, service_type: serviceName, estimated_duration_minutes: 30,
      appointment_date: t.manilaDate(-daysAgo), appointment_time: '09:00:00', status: 'Approved'
    });
    const response = await setStatus(admin, appointment.id, 'Completed');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return { admin, appointment, response };
  }
  const recsOf = petId => t.db.table('pet_care_recommendations').filter(row => row.pet_id === petId);
  async function addRule(admin, body) {
    return t.api('POST', `/admin/care-rules?user_id=${admin.id}`, { token: admin.token, body: {
      species: null, min_interval_days: 42, max_interval_days: 56, guidance_type: 'general',
      description: 'Many coats need grooming every 6-8 weeks.', explanation: 'Coat type affects the schedule.', is_active: true, ...body
    } });
  }

  it('a completed service with a clinic rule suggests the next one, explains why, and appears for the owner', async () => {
    const owner = t.createUser();
    const dog = pet(owner, 'Fluffy');
    const admin = t.createUser({ role: 'admin' });
    const faceTrim = service('Face Trim');
    assert.equal((await addRule(admin, { service_id: faceTrim.id })).status, 201);
    const { appointment, response } = await completed(owner, dog, 'Face Trim', 2);
    assert.equal(response.body.care_recommendation, 'created');
    const [rec] = recsOf(dog.id);
    assert.equal(rec.basis, 'rule');
    assert.equal(rec.source_appointment_id, appointment.id);
    const date = new Date(`${appointment.appointment_date}T00:00:00Z`);
    const plus = days => new Date(date.getTime() + days * 86400000).toISOString().slice(0, 10);
    assert.deepEqual([rec.due_from, rec.due_to], [plus(42), plus(56)]);
    assert.match(rec.explanation, /Fluffy had Face Trim on .*Many coats need grooming every 6-8 weeks\. Coat type affects the schedule\./);

    const ownerView = await t.api('GET', '/pets/care-recommendations', { token: owner.token });
    assert.equal(ownerView.status, 200);
    const shown = ownerView.body.recommendations.find(item => item.id === rec.id);
    assert.equal(shown.pet_name, 'Fluffy');
    assert.equal(shown.guidance_label, 'General care guidance');
    assert.match(shown.disclaimer, /not a diagnosis/);
    // Nothing was booked automatically
    assert.equal(t.db.table('appointments').filter(row => row.pet_id === dog.id).length, 1);
  });

  it('prefers a species rule; without any rule it says the clinic should advise and invents no date', async () => {
    const owner = t.createUser();
    const admin = t.createUser({ role: 'admin' });
    const cat = pet(owner, 'Mittens', 'Cat', 'Puspin');
    const dog = pet(owner, 'Biscuit');
    const fullGrooming = service('Full Grooming');
    await addRule(admin, { service_id: fullGrooming.id, min_interval_days: 60, max_interval_days: 90 });
    await addRule(admin, { service_id: fullGrooming.id, species: 'Cat', min_interval_days: 90, max_interval_days: 120, guidance_type: 'veterinarian_approved', description: 'Cats: every 3-4 months.' });
    await completed(owner, cat, 'Full Grooming');
    await completed(owner, dog, 'Medicated Bath');
    const [catRec] = recsOf(cat.id);
    assert.equal(catRec.guidance_type, 'veterinarian_approved');
    assert.match(catRec.explanation, /Cats: every 3-4 months/);
    const [dogRec] = recsOf(dog.id);
    assert.deepEqual([dogRec.basis, dogRec.due_from, dogRec.due_to], ['needs_review', null, null]);
    assert.match(dogRec.explanation, /has not set a follow-up schedule for Medicated Bath/);
  });

  it('requested, cancelled and approved appointments never produce a suggestion', async () => {
    const owner = t.createUser();
    const admin = t.createUser({ role: 'admin' });
    const dog = pet(owner, 'NoRec');
    const pending = t.createAppointment(owner, { pet: dog, daysAhead: 5, service: 'Bath', duration: 30 });
    assert.equal((await setStatus(admin, pending.id, 'Cancelled')).status, 200);
    const approvedOnly = t.createAppointment(owner, { pet: dog, daysAhead: 6, time: '11:00:00', service: 'Bath', duration: 30 });
    assert.equal((await setStatus(admin, approvedOnly.id, 'Approved')).status, 200);
    assert.equal(recsOf(dog.id).length, 0);
    assert.equal((await t.api('POST', `/admin/appointments/${pending.id}/care-recommendation?user_id=${admin.id}`, { token: admin.token, body: {} })).status, 409);
  });

  it('no duplicate reminders: one per completed visit, and a newer visit replaces the older reminder', async () => {
    const owner = t.createUser();
    const dog = pet(owner, 'Repeat');
    const { admin, appointment } = await completed(owner, dog, 'Bath', 40);
    const again = await t.api('POST', `/admin/appointments/${appointment.id}/care-recommendation?user_id=${admin.id}`, { token: admin.token, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(recsOf(dog.id).length, 1);
    await completed(owner, dog, 'Bath', 2);
    assert.deepEqual(recsOf(dog.id).map(row => row.status).sort(), ['active', 'superseded']);
  });

  it('a changed rule applies to later visits only; earlier suggestions keep their dates', async () => {
    const owner = t.createUser();
    const admin = t.createUser({ role: 'admin' });
    const trim = service('Trim');
    const created = await addRule(admin, { service_id: trim.id, min_interval_days: 30, max_interval_days: 45 });
    const first = pet(owner, 'Before');
    await completed(owner, first, 'Trim');
    const rule = created.body.rule;
    const changed = await t.api('PUT', `/admin/care-rules/${rule.id}?user_id=${admin.id}`, { token: admin.token, body: {
      service_id: trim.id, species: null, min_interval_days: 50, max_interval_days: 70, guidance_type: 'general', description: rule.description,
      explanation: '', is_active: true, expected_version: rule.version
    } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.match(changed.body.note, /completed from now on/);
    const second = pet(owner, 'After');
    await completed(owner, second, 'Trim');
    const span = row => (new Date(row.due_from) - new Date(row.service_date)) / 86400000;
    assert.equal(span(recsOf(first.id)[0]), 30);
    assert.equal(span(recsOf(second.id)[0]), 50);
    const rules = await t.api('GET', `/admin/care-rules?user_id=${admin.id}`, { token: admin.token });
    assert.equal(rules.body.rules.find(item => item.id === rule.id).open_recommendations, 2);
    assert.ok(rules.body.starting_guidance.length >= 5);
    const disabled = await t.api('PUT', `/admin/care-rules/${rule.id}?user_id=${admin.id}`, { token: admin.token, body: {
      service_id: trim.id, species: null, min_interval_days: 50, max_interval_days: 70, guidance_type: 'general', description: rule.description,
      explanation: '', is_active: false, expected_version: rule.version + 1
    } });
    assert.equal(disabled.status, 200);
    const third = pet(owner, 'Disabled');
    await completed(owner, third, 'Trim');
    assert.equal(recsOf(third.id)[0].basis, 'needs_review');
    const events = t.db.table('activity_logs').filter(row => row.target_id === trim.id).map(row => row.event_type);
    assert.ok(['care_rule_created', 'care_rule_updated', 'care_rule_disabled'].every(type => events.includes(type)));
  });

  it('validates rules and keeps them admin-only', async () => {
    const admin = t.createUser({ role: 'admin' });
    const owner = t.createUser();
    const bath = service('Bath');
    assert.equal((await addRule(admin, { service_id: bath.id, min_interval_days: 60, max_interval_days: 30 })).body.field, 'max_interval_days');
    assert.equal((await addRule(admin, { service_id: bath.id, guidance_type: 'prescription' })).body.field, 'guidance_type');
    assert.equal((await addRule(admin, { service_id: service('Puppy Cut').id, species: 'Cat' })).body.field, 'species');
    assert.equal((await addRule(admin, { service_id: crypto.randomUUID() })).status, 422);
    assert.equal((await addRule(owner, { service_id: bath.id })).status, 403);
    assert.equal((await t.api('GET', `/admin/care-rules?user_id=${owner.id}`, { token: owner.token })).status, 403);
    assert.equal((await addRule(admin, { service_id: bath.id })).status, 201);
    assert.equal((await addRule(admin, { service_id: bath.id })).status, 409, 'one rule per service and species');
  });

  it("owners acknowledge or dismiss their own reminders only; clinic staff can set a pet's next date", async () => {
    const owner = t.createUser();
    const stranger = t.createUser();
    const dog = pet(owner, 'Ace');
    const { admin } = await completed(owner, dog, 'Flea and Tick Removal');
    const [rec] = recsOf(dog.id);
    assert.equal((await t.api('POST', `/pets/care-recommendations/${rec.id}/dismiss`, { token: stranger.token, body: {} })).status, 404);
    assert.equal((await t.api('POST', `/pets/care-recommendations/${rec.id}/acknowledge`, { token: owner.token, body: {} })).status, 200);
    assert.equal(recsOf(dog.id)[0].status, 'acknowledged');

    const override = await t.api('POST', `/admin/care-recommendations/${rec.id}/override?user_id=${admin.id}`, { token: admin.token, body: {
      due_from: t.manilaDate(60), due_to: t.manilaDate(75), guidance_type: 'veterinarian_approved', note: 'Recheck the skin.'
    } });
    assert.equal(override.status, 200, JSON.stringify(override.body));
    const rows = recsOf(dog.id);
    assert.deepEqual(rows.map(row => row.status).sort(), ['active', 'superseded']);
    const current = rows.find(row => row.status === 'active');
    assert.deepEqual([current.basis, current.set_by, current.guidance_type], ['clinic_set', admin.id, 'veterinarian_approved']);
    assert.match(current.explanation, /Recheck the skin/);
    const adminView = await t.api('GET', `/admin/pets/${dog.id}/care-recommendations?user_id=${admin.id}`, { token: admin.token });
    assert.equal(adminView.body.recommendations.length, 2, 'the superseded suggestion stays for audit');
    assert.equal((await t.api('POST', `/admin/care-recommendations/${rec.id}/override?user_id=${admin.id}`, { token: admin.token, body: { due_from: t.manilaDate(60) } })).status, 409);
    assert.equal((await t.api('POST', `/admin/care-recommendations/${current.id}/override?user_id=${owner.id}`, { token: owner.token, body: { due_from: t.manilaDate(60) } })).status, 403);
    assert.equal((await t.api('POST', `/pets/care-recommendations/${current.id}/dismiss`, { token: owner.token, body: {} })).status, 200);
    const ownerView = await t.api('GET', '/pets/care-recommendations', { token: owner.token });
    assert.ok(!ownerView.body.recommendations.some(item => item.pet_id === dog.id), 'dismissed reminders are no longer shown');
  });
});
