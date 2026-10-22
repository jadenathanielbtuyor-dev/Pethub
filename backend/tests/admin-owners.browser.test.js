// The Admin Dashboard's Pet Owners & Records section in headless Chrome: one search for owners and pets, an owner's
// account (details, only their pets, their appointment history with older unlinked bookings flagged), a pet's profile
// (identity, latest official weight, its own appointment history kept apart from its official medical records, the
// owner's other pets), addresses for each step so Back and deep links work, Appointment Management linking each booking
// to its pet and owner and filtering appointments whose time has passed without an outcome, failed loads, phone width
// and contrast in both themes.
// MOCKED (helpers/browser.js): the page's fetch answers from each test's routes; Railway, Vercel and CDN hosts are
// blocked. Every name and value below is made-up test data.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/admin-owners.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, sleep, pageUrl, CONTRAST, startBrowser, stopBrowser, openTab } = require('./helpers/browser');
const { SERVICE_CATALOG, SERVICE_CATEGORIES } = require('../constants/services');

const day = offset => {
  const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const ADMIN = { id: 'a1', role: 'admin', email: 'admin@example.test', fullname: 'Test Admin', is_verified: true, created_at: '2026-01-01T08:00:00Z' };
const USERS = [
  ADMIN,
  { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Test Owner', is_verified: true, created_at: '2026-01-15T08:00:00Z' },
  { id: 'u2', role: 'user', email: 'second@example.test', fullname: 'Second Owner', is_verified: false, created_at: '2026-02-15T08:00:00Z' },
  { id: 'u3', role: 'user', email: 'nopets@example.test', fullname: 'No Pets Owner', is_verified: true, created_at: '2026-03-15T08:00:00Z' }
];
const PETS = [
  { id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, created_at: '2026-02-01T00:00:00Z', owner_name: 'Test Owner' },
  { id: 'p2', user_id: 'u1', name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2, created_at: '2026-03-01T00:00:00Z', owner_name: 'Test Owner' },
  { id: 'p3', user_id: 'u2', name: 'Kuro', species: 'Cat', breed: null, age: 5, created_at: '2026-03-05T00:00:00Z', owner_name: 'Second Owner' }
];
const appointment = (id, fields) => ({
  id, user_id: 'u1', pet_id: 'p1', pet_name: 'Mochi', service_type: 'Bath', estimated_duration_minutes: 60,
  appointment_date: day(5), appointment_time: '10:00:00', status: 'Pending', handled_by: null, handled_by_name: null,
  owner_fullname: 'Test Owner', ...fields
});
const APPOINTMENTS = [
  appointment('b0000000-0000-4000-8000-000000000001', {}),
  appointment('c0000000-0000-4000-8000-000000000002', { pet_id: 'p2', pet_name: 'Luna', service_type: 'Dog & Cat Full Check Up', estimated_duration_minutes: 45, appointment_date: day(8), status: 'Approved', handled_by: 'a1', handled_by_name: 'Test Admin' }),
  appointment('d0000000-0000-4000-8000-000000000003', { service_type: 'Checkup', estimated_duration_minutes: 45, appointment_date: day(-10), status: 'Completed', handled_by: 'a1', handled_by_name: 'Test Admin', medical_record_link_status: 'linked', medical_record_id: 'r1' }),
  // An older booking that kept only the typed pet name
  appointment('e0000000-0000-4000-8000-000000000004', { pet_id: null, pet_name: 'Max', service_type: 'Checkup', appointment_date: day(-40), status: 'Completed', handled_by: 'a1', handled_by_name: 'Test Admin', medical_record_link_status: 'unresolved' }),
  // Approved, its time has passed, and nobody completed or cancelled it
  appointment('f0000000-0000-4000-8000-000000000005', { user_id: 'u2', pet_id: 'p3', pet_name: 'Kuro', owner_fullname: 'Second Owner', service_type: 'Trim', appointment_date: day(-3), status: 'Approved', handled_by: 'a1', handled_by_name: 'Test Admin' }),
  // Booked from u2 for u1's pet: a data problem to review
  appointment('a0000000-0000-4000-8000-000000000006', { user_id: 'u2', pet_id: 'p1', pet_name: 'Mochi', owner_fullname: 'Second Owner', service_type: 'Nail Cutting', appointment_date: day(-20), status: 'Cancelled', handled_by: 'a1', handled_by_name: 'Test Admin' })
];
const RECORDS = [
  { id: 'r1', pet_id: 'p1', appointment_id: 'd0000000-0000-4000-8000-000000000003', pet_name: 'Mochi', record_date: day(-10), created_at: `${day(-10)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: 12.5, vaccination_status: 'Up to date', treatment: 'Deworming', medical_notes: 'Test note one.' },
  { id: 'r2', pet_id: 'p1', pet_name: 'Mochi', record_date: day(-5), created_at: `${day(-5)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: null, vaccination_status: 'Due soon', treatment: null, medical_notes: 'Test note two.' }
];
const SERVICES = SERVICE_CATALOG.map(entry => ({
  name: entry.name, category: entry.category, category_label: SERVICE_CATEGORIES[entry.category], description: entry.description,
  species: [...entry.species], duration_minutes: null, bookable: false
}));
const ok = body => ({ body: { success: true, ...body } });
const routes = (overrides = {}) => ({
  '/auth/user-status': ok({ user: ADMIN }),
  '/admin/dashboard/overview': ok({ summary: { upcomingCheckups: 0 }, users: USERS, pets: PETS, appointments: APPOINTMENTS, medicalRecords: RECORDS }),
  '/admin/system-logs': ok({ logs: [] }),
  '/admin/dashboard/contact-messages': ok({ messages: [] }),
  '/appointments/services': ok({ services: SERVICES, species: ['Dog', 'Cat'] }),
  ...overrides
});

const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
// Each row's text (the selector names the rows, e.g. '#ownersTable tr' or '.ph-admin-history tbody tr')
const rowsOf = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].map(row => row.innerText.replace(/\\s+/g, ' ').trim())`;
// The breadcrumb's steps (its › separators are drawn by CSS)
const crumbs = `[...document.querySelectorAll('#recordsBreadcrumb li')].map(li => li.textContent.trim())`;
const visible = id => `!document.getElementById(${JSON.stringify(id)}).hidden`;
const setValue = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

async function open(hash = '#records', overrides = {}, options = {}) {
  return openTab({ url: pageUrl('pages/admin/dashboard.html', hash), session: ADMIN, scenario: { routes: routes(overrides) }, reducedMotion: true, ...options });
}

describe('Admin Dashboard: Pet Owners & Records in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('the Owners list shows each owner with their pets and appointments, and one search finds owners and pets', async () => {
    const tab = await open();
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('#ownersTable [data-open-owner]').length === 3`));
      const owners = await tab.evaluate(rowsOf('#ownersTable tr'));
      assert.deepEqual(owners.map(row => row.split(' ').slice(0, 2).join(' ')), ['No Pets', 'Second Owner', 'Test Owner'], 'customers only (no admin without pets), by name');
      assert.match(owners[2], /2 pets Luna, Mochi/);
      assert.match(owners[2], /4 appointments 1 pending/);
      assert.match(owners[1], /1 awaiting an outcome/);
      assert.match(owners[0], /0 pets 0 appointments/);
      assert.equal(await tab.evaluate(textOf('#ownersListCount')), '3');
      assert.equal(await tab.evaluate(textOf('#petsListCount')), '3');

      await tab.evaluate(setValue('#recordsSearchInput', 'kuro'));
      assert.ok(await tab.waitFor(`document.querySelectorAll('#ownersTable [data-open-owner]').length === 1`));
      assert.match(await tab.evaluate(textOf('#ownersTable')), /Second Owner/, 'an owner is found by their pet');
      assert.match(await tab.evaluate(textOf('#recordsSearchSummary')), /1 of 3 owners and 1 of 3 pets match "kuro"/);
      await tab.evaluate(`document.querySelector('[data-records-list="pets"]').click()`);
      assert.equal(await tab.evaluate(visible('petsListPanel')), true);
      assert.equal(await tab.evaluate(visible('ownersListPanel')), false);
      assert.deepEqual((await tab.evaluate(rowsOf('#petsTable tr'))).map(row => row.split(' ')[0]), ['Kuro']);

      await tab.evaluate(setValue('#recordsSearchInput', 'owner@example'));
      assert.ok(await tab.waitFor(`document.querySelectorAll('#petsTable [data-pet-view]').length === 2`), 'pets are found by their owner\'s email');
      await tab.evaluate(setValue('#recordsSearchInput', 'zzz'));
      assert.ok(await tab.waitFor(`document.getElementById('petsTable').innerText.includes('No matching pets found')`));
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('an owner\'s account shows their details, only their pets, and their appointment history with unlinked bookings flagged', async () => {
    const tab = await open();
    try {
      assert.ok(await tab.waitFor(`document.querySelector('#ownersTable [data-open-owner="u1"]') !== null`));
      await tab.click('#ownersTable [data-open-owner="u1"]');
      assert.ok(await tab.waitFor(`location.hash === '#records/owner/u1' && ${visible('adminOwnerDetail')}`));
      assert.equal(await tab.evaluate(visible('recordsDirectory')), false, 'the search steps aside');
      assert.equal(await tab.evaluate('document.activeElement.id'), 'adminOwnerDetailTitle');
      assert.deepEqual(await tab.evaluate(crumbs), ['Pet Owners & Records', 'Test Owner']);

      const account = await tab.evaluate(textOf('#adminOwnerDetailContent'));
      assert.match(account, /owner@example\.test/);
      assert.match(account, /Verified/);
      assert.match(account, /Registered pets \(2\)/);
      assert.match(account, /Mochi[\s\S]*12\.5 kg, recorded/);
      assert.match(account, /Luna[\s\S]*No weight recorded yet/);
      assert.doesNotMatch(account, /Kuro/, 'another owner\'s pet is not listed');

      const history = await tab.evaluate(rowsOf('#adminOwnerDetailContent .ph-admin-history tbody tr'));
      assert.equal(history.length, 4, 'the four appointments booked from this account');
      assert.match(history[0], /Luna .*Approved/, 'newest first');
      assert.match(history.find(row => row.includes('Max')), /Max Not linked to a pet profile .*Completed Relationship unresolved/);
      assert.match(history.find(row => row.includes('Checkup') && row.includes('Mochi')), /Completed Record linked/);
      assert.match(history.find(row => row.includes('Bath')), /Pending Not applicable/);
      assert.match(account, /1 not linked/);
      assert.match(account, /never matched to a pet by name/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }

    const empty = await open('#records/owner/u3');
    try {
      assert.ok(await empty.waitFor(`document.getElementById('adminOwnerDetailContent').innerText.includes('No pets registered')`));
      assert.match(await empty.evaluate(textOf('#adminOwnerDetailContent')), /No appointments yet/);
      assert.equal(await empty.evaluate(`document.querySelectorAll('#adminOwnerDetail .ph-dash-error').length`), 0, 'no pets is not an error');
    } finally { await empty.close(); }
  });

  it('a pet\'s profile keeps its appointments apart from its official records, and links to the owner and their other pets', async () => {
    const tab = await open('#records/owner/u1');
    try {
      assert.ok(await tab.waitFor(`document.querySelector('#adminOwnerDetailContent a[href="#records/pet/p1"]') !== null`));
      await tab.click('#adminOwnerDetailContent a[href="#records/pet/p1"]');
      assert.ok(await tab.waitFor(`location.hash === '#records/pet/p1' && document.getElementById('adminPetDetailName').textContent === 'Mochi'`));
      assert.deepEqual(await tab.evaluate(crumbs), ['Pet Owners & Records', 'Test Owner', 'Mochi']);

      const profile = await tab.evaluate(textOf('#adminPetDetailContent'));
      assert.match(profile, /PETHUB PROFILE ID\s+p1/i);
      assert.match(profile, /LATEST OFFICIAL WEIGHT\s+12\.5 kg, recorded/i, 'the newest record with a weight (a newer one has none)');
      assert.match(profile, /Official medical records \(2\)/);

      const history = await tab.evaluate(rowsOf('#adminPetDetailContent .ph-admin-history tbody tr'));
      assert.equal(history.length, 3, 'appointments booked for this pet by pet_id');
      assert.ok(history.every(row => !row.includes('Max')), 'the unlinked "Max" booking is not attached by name');
      assert.match(history.find(row => row.includes('Nail Cutting')), /Second Owner/, 'a booking from another account names that account');
      assert.match(profile, /Needs review/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#adminPetDetailContent .ph-admin-history .ph-badge-official').length`), 1, 'record flags sit in the history; the records themselves are listed separately');
      assert.doesNotMatch(await tab.evaluate(textOf('#adminPetDetailContent .ph-admin-history')), /Deworming|Test note/, 'no record contents in the appointment history');

      await tab.click('#adminPetDetail [data-other-pet="p2"]');
      assert.ok(await tab.waitFor(`document.getElementById('adminPetDetailName').textContent === 'Luna'`));
      const luna = await tab.evaluate(textOf('#adminPetDetailContent'));
      assert.match(luna, /No medical records yet/);
      assert.match(luna, /No weight recorded yet/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#adminPetDetail .ph-dash-error').length`), 0, 'no records is not an error');

      // Back returns to Mochi, then to the owner, without losing the place
      await tab.evaluate('history.back()');
      assert.ok(await tab.waitFor(`location.hash === '#records/pet/p1' && document.getElementById('adminPetDetailName').textContent === 'Mochi'`));
      await tab.evaluate('history.back()');
      assert.ok(await tab.waitFor(`location.hash === '#records/owner/u1' && ${visible('adminOwnerDetail')}`));

      // The breadcrumb's first step returns to the search, focused on the owner it came from
      await tab.click('#recordsBreadcrumb a[href="#records"]');
      assert.ok(await tab.waitFor(`${visible('recordsDirectory')} && document.activeElement.dataset.openOwner === 'u1'`));
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('a deep link opens an owner or a pet directly, and an unknown one says so', async () => {
    const pet = await open('#records/pet/p3');
    try {
      assert.ok(await pet.waitFor(`document.getElementById('adminPetDetailName').textContent === 'Kuro'`));
      assert.match(await pet.evaluate(textOf('#adminPetDetailContent')), /Second Owner/);
      assert.equal(await pet.evaluate(`document.querySelectorAll('#adminPetDetail [data-other-pet]').length`), 0, 'Kuro is the owner\'s only pet');
    } finally { await pet.close(); }

    const missing = await open('#records/owner/no-such-owner');
    try {
      assert.ok(await missing.waitFor(`document.getElementById('recordsNotice').innerText.includes('Pet owner not found')`));
      assert.equal(await missing.evaluate(visible('recordsDirectory')), true, 'the search is offered instead');
      assert.equal(await missing.evaluate(visible('adminOwnerDetail')), false);
    } finally { await missing.close(); }
  });

  it('Appointment Management links each booking to its pet and owner and finds appointments awaiting an outcome', async () => {
    const tab = await open('#appointments');
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('#appointmentsTable tr').length === 6`));
      assert.match(await tab.evaluate(textOf('#appointmentsTable')), /Max\s+Not linked to a pet profile/);
      await tab.evaluate(setValue('#appointmentStatusFilter', 'needs-outcome'));
      const rows = await tab.evaluate(rowsOf('#appointmentsTable tr'));
      assert.equal(rows.length, 1);
      assert.match(rows[0], /Kuro .*Trim.*Approved Awaiting an outcome/);
      assert.match(rows[0], /Complete Cancel/, 'the admin decides; nothing is completed automatically');

      await tab.click('#appointmentsTable a[href="#records/pet/p3"]');
      assert.ok(await tab.waitFor(`location.hash === '#records/pet/p3' && document.getElementById('adminPetDetailName').textContent === 'Kuro'`));
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('.ph-dash-nav-link[aria-current="page"]')].map(link => link.dataset.dashboardSection)`), ['records']);
      await tab.evaluate('history.back()');
      assert.ok(await tab.waitFor(`location.hash === '#appointments' && document.getElementById('appointmentStatusFilter').value === 'needs-outcome'`), 'back to the filtered list');
    } finally { await tab.close(); }

    const overview = await open('#overview');
    try {
      assert.ok(await overview.waitFor(`document.getElementById('alertAwaitingOutcome').textContent === '1'`));
      await overview.evaluate(`document.getElementById('queueAwaitingOutcome').click()`);
      assert.ok(await overview.waitFor(`location.hash === '#appointments' && document.querySelectorAll('#appointmentsTable tr').length === 1`));
      await overview.evaluate(`window.showAdminView('overview')`);
      await overview.evaluate(`document.querySelector('[data-admin-go="records:owners"]').click()`);
      assert.ok(await overview.waitFor(`location.hash === '#records' && ${visible('ownersListPanel')}`), 'Pet owner accounts opens the Owners list');
    } finally { await overview.close(); }
  });

  it('when the records cannot be loaded, every Pet Owners & Records view says so', async () => {
    const failed = { '/admin/dashboard/overview': { status: 500, body: { error: 'Server error' } } };
    const directory = await open('#records', failed);
    try {
      assert.ok(await directory.waitFor(`document.getElementById('ownersTable').innerText.includes('Unable to load pet owners')`));
      assert.equal(await directory.evaluate(textOf('#ownersListCount')), '', 'no made-up count');
    } finally { await directory.close(); }

    const owner = await open('#records/owner/u1', failed);
    try {
      assert.ok(await owner.waitFor(`document.getElementById('adminOwnerDetailContent').innerText.includes('Unable to load this account')`));
    } finally { await owner.close(); }

    const pet = await open('#records/pet/p1', failed);
    try {
      assert.ok(await pet.waitFor(`document.getElementById('adminPetDetailContent').innerText.includes('Unable to load this pet')`));
      assert.deepEqual(pet.errors, []);
    } finally { await pet.close(); }
  });

  it('on a phone the owner and pet views fit without sideways scrolling', async () => {
    for (const hash of ['#records', '#records/owner/u1', '#records/pet/p1']) {
      const tab = await open(hash, {}, { width: 375, height: 760 });
      try {
        assert.ok(await tab.waitFor(`!document.querySelector('#adminViewRecords .dashboard-loading-state')`, 6000), hash);
        await sleep(200);
        assert.ok(await tab.evaluate('document.documentElement.scrollWidth - window.innerWidth') <= 0, `${hash}: no sideways scrolling`);
        const links = await tab.evaluate(`[...document.querySelectorAll('.ph-dash-nav-link')].map(link => { const r = link.getBoundingClientRect(); return r.bottom - r.top; })`);
        assert.ok(links.every(height => height < 70), `${hash}: the section bar labels fit`);
      } finally { await tab.close(); }
    }
  });

  for (const dark of [false, true]) {
    it(`owner and pet views are readable (${dark ? 'dark' : 'light'} mode)`, async () => {
      for (const hash of ['#records/owner/u1', '#records/pet/p1']) {
        const tab = await open(hash, {}, { dark });
        try {
          assert.ok(await tab.waitFor(`!document.querySelector('#adminViewRecords .dashboard-loading-state')`, 6000), hash);
          assert.ok(await tab.waitFor('document.getAnimations().length === 0'));
          const { measured, low } = await tab.evaluate(`(() => { ${CONTRAST}
            const measured = [...document.querySelectorAll('#adminViewRecords *')]
              .filter(e => e.children.length === 0 && e.textContent.trim() && e.getClientRects().length && !e.closest('[hidden], .hidden, option, .sr-only, .ph-btn-primary'))
              .map(e => [e.textContent.trim().slice(0, 40), Number(ratioOf(getComputedStyle(e).color, background(e)).toFixed(2))]);
            return { measured: measured.length, low: measured.filter(([, value]) => value < 4.5) };
          })()`);
          assert.ok(measured >= 30, `${hash}: ${measured} text elements measured`);
          assert.deepEqual(low, [], hash);
        } finally { await tab.close(); }
      }
    });
  }
});
