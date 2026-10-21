// My Pets in headless Chrome: the two Add a pet choices (Register a new pet / Use an existing pet), field checks
// including the 1-25 whole-year age rule before anything is sent, the possible-duplicate notice (open the existing
// profile, or confirm a different pet, never both), one pet's profile with its PetHub profile ID and latest recorded
// weight, appointment history and official medical history kept apart, Edit profile sending only what changed, Delete
// offered only for a profile without history, "Request an appointment" preselecting the pet on the booking page, and
// a phone-width layout without sideways scrolling.
// MOCKED (helpers/browser.js): the page's fetch answers from each test's routes; Railway, Vercel and CDN hosts are
// blocked. Every name and value below is made-up test data.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/pets-page.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, sleep, pageUrl, startBrowser, stopBrowser, openTab } = require('./helpers/browser');
const { SERVICE_CATALOG, SERVICE_CATEGORIES } = require('../constants/services');

const day = offset => {
  const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const OWNER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Test Owner', is_verified: true };
const MOCHI_ID = 'a1b2c3d4-0000-4000-8000-00000000000a';
const LUNA_ID = 'a1b2c3d4-0000-4000-8000-00000000000b';
const PETS = [
  { id: MOCHI_ID, user_id: 'u1', name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, created_at: '2026-02-01T00:00:00Z', medical_record_count: 2,
    latest_weight: { value: 12.5, unit: 'kg', record_date: day(-20), record_id: 'r2' } },
  { id: LUNA_ID, user_id: 'u1', name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2, created_at: '2026-03-01T00:00:00Z', medical_record_count: 0, latest_weight: null }
];
const appointment = (id, fields) => ({
  id, user_id: 'u1', pet_id: MOCHI_ID, pet_name: 'Mochi', service_type: 'Bath', estimated_duration_minutes: 60,
  appointment_date: day(5), appointment_time: '10:00:00', status: 'Pending', handled_by: null, handled_by_name: null,
  created_at: `${day(-1)}T08:00:00Z`, ...fields
});
const MOCHI_HISTORY = {
  success: true,
  pet: PETS[0],
  latest_weight: PETS[0].latest_weight,
  appointments: [
    appointment('b0000000-0000-4000-8000-000000000001', {}),
    appointment('d0000000-0000-4000-8000-000000000003', { service_type: 'Trim', appointment_date: day(-20), status: 'Completed', handled_by: 'a1', handled_by_name: 'Test Admin' })
  ],
  medical_records: [
    { id: 'r1', pet_id: MOCHI_ID, record_date: day(-10), created_at: `${day(-10)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: null, vaccination_status: 'Up to date', treatment: 'Deworming', medical_notes: 'Test note one.' },
    { id: 'r2', pet_id: MOCHI_ID, record_date: day(-20), created_at: `${day(-20)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: 12.5, vaccination_status: 'Due soon', treatment: null, medical_notes: 'Test note two.' }
  ],
  unlinked_appointment_count: 1
};
const LUNA_HISTORY = { success: true, pet: PETS[1], latest_weight: null, appointments: [], medical_records: [], unlinked_appointment_count: 0 };
const DUPLICATE = {
  status: 409,
  body: { success: false, code: 'POSSIBLE_DUPLICATE_PET', error: 'You already have a pet profile with these details. Open that profile, or confirm this is a different pet.',
    possible_duplicates: [{ id: MOCHI_ID, name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, created_at: '2026-02-01T00:00:00Z' }] }
};
const SERVICES = SERVICE_CATALOG.map(entry => ({
  name: entry.name, category: entry.category, category_label: SERVICE_CATEGORIES[entry.category], description: entry.description,
  species: [...entry.species], duration_minutes: null, bookable: false
}));
const ok = body => ({ body: { success: true, ...body } });

const routes = (overrides = {}) => ({
  '/auth/user-status': ok({ user: OWNER }),
  '/pets/userPets': ok({ pets: PETS }),
  [`/pets/history/${MOCHI_ID}`]: { body: MOCHI_HISTORY },
  [`/pets/history/${LUNA_ID}`]: { body: LUNA_HISTORY },
  '/pets/create': { status: 201, body: { success: true, pet: { ...PETS[0], id: 'a1b2c3d4-0000-4000-8000-00000000000c' } } },
  '/appointments/services': ok({ services: SERVICES, species: ['Dog', 'Cat'] }),
  '/appointments/userAppointments': ok({ appointments: [] }),
  '/appointments/all': ok({ appointments: [] }),
  ...overrides
});

const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route === '${route}')`;
const setValue = (selector, value) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;

// Reduced motion turns off the site's smooth scrolling (html { scroll-behavior: smooth }), so a real mouse click is
// never sent while the page is still scrolling to a pet it just opened
async function open(query = '', overrides = {}, options = {}) {
  const tab = await openTab({ url: pageUrl('pages/user/pets.html', query), session: OWNER, scenario: { routes: routes(overrides) }, reducedMotion: true, ...options });
  assert.ok(await tab.waitFor(`document.getElementById('petsList').innerText.includes('Luna')`), 'the pets load');
  return tab;
}

async function fillNewPet(tab, { name = 'Mochi', species = 'Dog', breed = 'Aspin', age = '3' } = {}) {
  await tab.evaluate(setValue('#petName', name));
  await tab.evaluate(setValue('#petType', species));
  await tab.evaluate(setValue('#petBreed', breed));
  // Cleared first, then typed like a person would, so the browser itself reads the number
  await tab.evaluate(setValue('#petAge', ''));
  if (age) await tab.type('#petAge', age);
}

describe('My Pets in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('Add a pet offers Register a new pet and Use an existing pet; choosing an existing pet creates nothing', async () => {
    const tab = await open();
    try {
      const choices = await tab.evaluate(`[...document.querySelectorAll('[data-pet-mode]')].map(b => [b.textContent.trim(), b.getAttribute('aria-pressed')])`);
      assert.deepEqual(choices, [['Register a new pet', 'true'], ['Use an existing pet', 'false']]);
      assert.equal(await tab.evaluate(`document.getElementById('petExistingPanel').hidden`), true);

      await tab.click('[data-pet-mode="existing"]');
      assert.equal(await tab.evaluate(`document.getElementById('petNewPanel').hidden`), true);
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('#existingPetSelect option')].map(o => o.textContent)`),
        ['Select a pet', 'Mochi - Dog - Aspin', 'Luna - Cat - Puspin']);
      assert.equal(await tab.evaluate(`document.getElementById('existingPetOpen').disabled`), true, 'nothing to open until a pet is chosen');

      await tab.evaluate(setValue('#existingPetSelect', LUNA_ID));
      await tab.click('#existingPetOpen');
      assert.ok(await tab.waitFor(`!document.getElementById('petDetailPanel').hidden && document.getElementById('petDetailName').textContent === 'Luna'`));
      assert.match(await tab.evaluate('location.search'), new RegExp(`pet=${LUNA_ID}`));
      assert.deepEqual(await tab.evaluate(requests('POST', '/pets/create')), [], 'no pet is created');

      await tab.click('#existingPetBook');
      assert.ok(await tab.waitFor(`location.pathname.endsWith('/appointments.html') && document.getElementById('petSelect').value === '${LUNA_ID}'`, 6000),
        'the booking page opens with the existing profile selected');
      assert.match(await tab.evaluate(textOf('#bookingSummaryPet')), /Luna/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('the form checks every field, including the 1 to 25 whole-year age, before anything is sent', async () => {
    const tab = await open();
    try {
      await tab.click('#petForm button[type=submit]');
      assert.ok(await tab.waitFor(`!document.getElementById('petNameError').hidden`));
      assert.match(await tab.evaluate(textOf('#petError')), /Please fix the 3 highlighted fields/);
      assert.equal(await tab.evaluate('document.activeElement.id'), 'petName');

      for (const age of ['0', '26', '2.5', '-1', '']) {
        await fillNewPet(tab, { name: 'Bantay', breed: '', age });
        await tab.click('#petForm button[type=submit]');
        await sleep(50);
        const state = await tab.evaluate(`({ error: document.getElementById('petAgeError').textContent, shown: !document.getElementById('petAgeError').hidden, invalid: document.getElementById('petAge').getAttribute('aria-invalid') })`);
        assert.equal(state.shown, true, `age "${age}"`);
        assert.equal(state.invalid, 'true', `age "${age}"`);
        assert.match(state.error, age ? /^Age must be a whole number of years from 1 to 25\.$/ : /Enter the pet's age in whole years \(1 to 25\)/, `age "${age}"`);
      }
      assert.deepEqual(await tab.evaluate(requests('POST', '/pets/create')), [], 'nothing was sent');
      assert.match(await tab.evaluate(textOf('#petAgeHelp')), /Whole years from 1 to 25\./);

      for (const age of ['1', '25']) {
        await fillNewPet(tab, { name: `Bantay ${age}`, breed: '', age });
        await tab.click('#petForm button[type=submit]');
        assert.ok(await tab.waitFor(`${requests('POST', '/pets/create')}.length === ${age === '1' ? 1 : 2}`), `age ${age} is sent`);
        assert.ok(await tab.waitFor(`document.getElementById('petForm').dataset.submitting !== 'true'`));
      }
      const sent = JSON.parse((await tab.evaluate(requests('POST', '/pets/create')))[1].body);
      assert.deepEqual(sent, { user_id: 'u1', name: 'Bantay 25', species: 'Dog', breed: null, age: 25 });
    } finally { await tab.close(); }
  });

  it('a possible duplicate is shown with the existing profile; "a different pet" sends the same details once more, confirmed', async () => {
    const tab = await open('', { '/pets/create': [DUPLICATE, { status: 201, body: { success: true, pet: { ...PETS[0], id: 'a1b2c3d4-0000-4000-8000-00000000000c' } } }] });
    try {
      await fillNewPet(tab);
      await tab.click('#petForm button[type=submit]');
      assert.ok(await tab.waitFor(`!document.getElementById('petDuplicateNotice').hidden`));
      const notice = await tab.evaluate(textOf('#petDuplicateNotice'));
      assert.match(notice, /This looks like a pet you already registered/);
      assert.match(notice, /Two pets can share a name, so nothing has been saved or merged/);
      assert.match(notice, /Mochi/);
      assert.match(notice, new RegExp(MOCHI_ID));
      assert.equal(await tab.evaluate('document.activeElement.id'), 'petDuplicateNotice', 'the notice is announced');
      assert.doesNotMatch(await tab.evaluate(textOf('#petSuccess')), /Pet added/);

      await tab.click('#petDuplicateNotice [data-duplicate-confirm]');
      assert.ok(await tab.waitFor(`${requests('POST', '/pets/create')}.length === 2`));
      const [first, second] = (await tab.evaluate(requests('POST', '/pets/create'))).map(request => JSON.parse(request.body));
      assert.equal(first.confirm_not_duplicate, undefined, 'the first request never skips the check');
      assert.deepEqual(second, { ...first, confirm_not_duplicate: true });
      assert.ok(await tab.waitFor(`document.getElementById('petSuccess').innerText.includes('Pet added.')`));
      assert.equal(await tab.evaluate(`document.getElementById('petDuplicateNotice').hidden`), true);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }

    const choosing = await open('', { '/pets/create': DUPLICATE });
    try {
      await fillNewPet(choosing);
      await choosing.click('#petForm button[type=submit]');
      assert.ok(await choosing.waitFor(`!document.getElementById('petDuplicateNotice').hidden`));
      await choosing.click(`#petDuplicateNotice [data-duplicate-open="${MOCHI_ID}"]`);
      assert.ok(await choosing.waitFor(`!document.getElementById('petDetailPanel').hidden && document.getElementById('petDetailName').textContent === 'Mochi'`));
      assert.match(await choosing.evaluate(textOf('#petSuccess')), /No new profile was added/);
      assert.equal(await choosing.evaluate(`document.getElementById('petName').value`), '', 'the form is cleared');
      assert.equal((await choosing.evaluate(requests('POST', '/pets/create'))).length, 1, 'nothing else was sent');
    } finally { await choosing.close(); }
  });

  it('a pet\'s details show its profile ID, latest recorded weight, and appointment and medical history apart', async () => {
    const tab = await open(`?pet=${MOCHI_ID}`);
    try {
      assert.ok(await tab.waitFor(`document.getElementById('petHistory').innerText.includes('Deworming')`));
      const profile = await tab.evaluate(textOf('#petDetailContent .ph-dash-grid-side > div'));
      assert.match(profile, new RegExp(`PETHUB PROFILE ID\\s+${MOCHI_ID}`, 'i'));
      assert.match(profile, /LATEST RECORDED WEIGHT\s+12\.5 kg, recorded/i);

      const sections = await tab.evaluate(`[...document.querySelectorAll('#petHistory .ph-pet-history')].map(s => ({ title: s.querySelector('h4').textContent, text: s.innerText }))`);
      assert.deepEqual(sections.map(section => section.title), ['Appointment history', 'Official medical history']);
      assert.match(sections[0].text, /Bath[\s\S]*Trim/, 'appointments newest first, as the server sent them');
      assert.match(sections[0].text, /Pending/);
      assert.match(sections[0].text, /Completed/);
      assert.match(sections[0].text, /1 older appointment on your account is not linked to a pet profile/);
      assert.doesNotMatch(sections[0].text, /Deworming|Up to date/, 'no medical record details among the appointments');
      assert.match(sections[1].text, /Deworming[\s\S]*Due soon/);
      assert.doesNotMatch(sections[1].text, /Pending|Bath/, 'no appointments among the medical records');
      assert.equal(await tab.evaluate(`document.querySelectorAll('#petHistory input, #petHistory select, #petHistory textarea, #petHistory form').length`), 0);

      // Mochi has history: deleting is explained, not offered
      assert.equal(await tab.evaluate(`document.querySelector('[data-pet-delete]')`), null);
      assert.match(await tab.evaluate(textOf('#petRemoveRegion')), /can't be deleted because PetHub holds 2 appointments and 2 official medical records/);

      await tab.click(`[data-pet-view="${LUNA_ID}"]`);
      assert.ok(await tab.waitFor(`document.getElementById('petHistory').innerText.includes('No medical records yet')`));
      assert.match(await tab.evaluate(textOf('#petDetailWeight')), /^No weight recorded yet$/);
      const empty = await tab.evaluate(textOf('#petHistory'));
      assert.match(empty, /No appointments have been booked in PetHub for Luna/);
      assert.match(empty, /No official records are available in PetHub for Luna yet/);
      assert.match(await tab.evaluate(textOf('#petDetailContent')), /Visits to other clinics, or from before the pet was in PetHub, are not shown/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('Edit profile sends only the changed fields, and checks the age first', async () => {
    const tab = await open(`?pet=${MOCHI_ID}`, { [`/pets/update/${MOCHI_ID}`]: { body: { success: true, pet: { ...PETS[0], age: 4 } } } });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('petEditOpen') !== null`));
      await tab.click('#petEditOpen');
      assert.equal(await tab.evaluate(`document.getElementById('petEditSpecies').value`), 'Dog', 'the saved species stays selected');
      assert.equal(await tab.evaluate('document.activeElement.id'), 'petEditName');

      await tab.type('#petEditAge', '26');
      await tab.click('#petEditForm button[type=submit]');
      assert.ok(await tab.waitFor(`!document.getElementById('petEditAgeError').hidden`));
      assert.deepEqual(await tab.evaluate(requests('PUT', `/pets/update/${MOCHI_ID}`)), []);

      await tab.type('#petEditAge', '4');
      await tab.click('#petEditForm button[type=submit]');
      assert.ok(await tab.waitFor(`${requests('PUT', `/pets/update/${MOCHI_ID}`)}.length === 1`));
      assert.deepEqual(JSON.parse((await tab.evaluate(requests('PUT', `/pets/update/${MOCHI_ID}`)))[0].body), { user_id: 'u1', age: 4 });
      assert.ok(await tab.waitFor(`document.getElementById('petEditForm') === null`), 'the form closes after the server saves');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('a profile without history can be deleted after a second click; the server\'s refusal is shown', async () => {
    const tab = await open(`?pet=${LUNA_ID}`, { [`/pets/delete/${LUNA_ID}`]: { body: { success: true, message: 'Pet deleted successfully' } } });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-pet-delete]') !== null`));
      assert.match(await tab.evaluate(textOf('#petRemoveRegion')), /Luna has no appointments or official medical records in PetHub/);
      await tab.click('[data-pet-delete]');
      assert.deepEqual(await tab.evaluate(requests('DELETE', `/pets/delete/${LUNA_ID}`)), [], 'the first click only asks again');
      await tab.click('[data-pet-delete]');
      assert.ok(await tab.waitFor(`${requests('DELETE', `/pets/delete/${LUNA_ID}`)}.length === 1`));
      assert.ok(await tab.waitFor(`document.getElementById('petDetailPanel').hidden`));
    } finally { await tab.close(); }

    const refused = await open(`?pet=${LUNA_ID}`, {
      [`/pets/delete/${LUNA_ID}`]: { status: 409, body: { success: false, code: 'PET_HAS_HISTORY', error: 'Luna can\'t be deleted because PetHub holds 1 appointment for this profile.' } }
    });
    try {
      assert.ok(await refused.waitFor(`document.querySelector('[data-pet-delete]') !== null`));
      await refused.click('[data-pet-delete]');
      assert.ok(await refused.waitFor(`document.querySelector('[data-pet-delete]').dataset.confirmPending === 'true'`), 'the first click asks again');
      await refused.click('[data-pet-delete]');
      assert.ok(await refused.waitFor(`${requests('DELETE', `/pets/delete/${LUNA_ID}`)}.length === 1`), 'the second click sends the delete');
      assert.ok(await refused.waitFor(`${requests('GET', `/pets/history/${LUNA_ID}`)}.length >= 2`), 'the history is loaded again');
      assert.equal(await refused.evaluate(`document.getElementById('petDetailPanel').hidden`), false, 'the profile stays');
    } finally { await refused.close(); }
  });

  it('on a phone the details, history and duplicate notice fit without sideways scrolling', async () => {
    const tab = await open(`?pet=${MOCHI_ID}`, { '/pets/create': DUPLICATE }, { width: 375, height: 760 });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('petHistory').innerText.includes('Deworming')`));
      await fillNewPet(tab);
      await tab.click('#petForm button[type=submit]');
      assert.ok(await tab.waitFor(`!document.getElementById('petDuplicateNotice').hidden`));
      await sleep(200);
      assert.ok(await tab.evaluate('document.documentElement.scrollWidth - window.innerWidth') <= 0, 'no sideways scrolling');
      const choiceRows = await tab.evaluate(`[...document.querySelectorAll('[data-pet-mode]')].map(b => b.getBoundingClientRect().height)`);
      assert.ok(choiceRows.every(height => height < 70), 'both choices fit');
    } finally { await tab.close(); }
  });
});
