// The Pet Owner Dashboard and the Admin Dashboard in headless Chrome: the four-section navigation on a desktop (a
// sidebar beside the content) and a phone (a bar that stays at the top, no sideways scrolling), loading, empty, error
// and success states, read-only medical records for owners, records kept apart from the AI assistant (which is sent
// a general question and bounded conversation history), booking closed while services are not configured, and admin changes shown only as the
// server answers them. Contrast is checked in both themes.
// MOCKED (helpers/browser.js): the page's fetch answers from each test's routes; Railway, Vercel and CDN hosts are
// blocked. Every name and value below is made-up test data.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/dashboards.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, sleep, pageUrl, CONTRAST, startBrowser, stopBrowser, openTab } = require('./helpers/browser');
const { SERVICE_CATALOG, SERVICE_CATEGORIES } = require('../constants/services');

const day = offset => {
  const date = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const clinicWallTime = offsetMs => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(Date.now() + offsetMs)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:00` };
};
const OWNER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Test Owner', is_verified: true, created_at: '2026-01-15T08:00:00Z' };
const ADMIN = { id: 'a1', role: 'admin', email: 'admin@example.test', fullname: 'Test Admin', is_verified: true, created_at: '2026-01-01T08:00:00Z' };
const PETS = [
  { id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog', breed: 'Aspin', age: 3, created_at: '2026-02-01T00:00:00Z', medical_record_count: 2 },
  { id: 'p2', user_id: 'u1', name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2, created_at: '2026-03-01T00:00:00Z', medical_record_count: 0 }
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
  appointment('e0000000-0000-4000-8000-000000000004', { pet_id: 'p2', pet_name: 'Luna', service_type: 'Trim', appointment_date: day(-5), status: 'Cancelled', handled_by: 'a1', handled_by_name: 'Test Admin' })
];
const RECORDS = [
  { id: 'r1', pet_id: 'p1', appointment_id: 'd0000000-0000-4000-8000-000000000003', pet_name: 'Mochi', record_date: day(-10), created_at: `${day(-10)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: 12.5, vaccination_status: 'Up to date', treatment: 'Deworming', medical_notes: 'Test note one.' },
  { id: 'r2', pet_id: 'p1', pet_name: 'Mochi', record_date: day(-40), created_at: `${day(-40)}T10:00:00Z`, created_by: 'a1', created_by_name: 'Test Admin', weight: 12.1, vaccination_status: 'Due soon', treatment: null, medical_notes: 'Test note two.' }
];
// The catalog as shipped: no duration confirmed, nothing bookable online
const SERVICES = SERVICE_CATALOG.map(entry => ({
  name: entry.name, category: entry.category, category_label: SERVICE_CATEGORIES[entry.category], description: entry.description,
  species: [...entry.species], duration_minutes: null, online_booking_enabled: false, bookable: false,
  unavailable_reason: 'Online booking is disabled for this service.'
}));
const ADMIN_SERVICES = SERVICES.map((service, index) => ({
  ...service,
  id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  service_key: service.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, ''),
  display_order: index + 1,
  version: 1
}));
const PROFILE = { phone_number: '+639170000000', date_of_birth: '1990-01-01', gender: 'Prefer not to say', address_line: '1 Test Street', barangay: 'Test', city_municipality: 'Test City', province: 'Test Province', postal_code: '1000' };
const ok = body => ({ body: { success: true, ...body } });
const failed = { status: 500, body: { error: 'Server error' } };

// GET /pets/history/:id for one pet: its appointments and official records, as the server returns them
const petHistory = petId => ok({
  pet: PETS.find(pet => pet.id === petId),
  latest_weight: petId === 'p1' ? { value: 12.5, unit: 'kg', record_date: RECORDS[0].record_date, record_id: 'r1' } : null,
  appointments: APPOINTMENTS.filter(item => item.pet_id === petId),
  medical_records: RECORDS.filter(record => record.pet_id === petId),
  unlinked_appointment_count: 0
});

const ownerRoutes = (overrides = {}) => ({
  '/auth/user-status': ok({ user: OWNER, profile: PROFILE }),
  '/pets/userPets': ok({ pets: PETS }),
  '/pets/history/p1': petHistory('p1'),
  '/pets/history/p2': petHistory('p2'),
  '/appointments/userAppointments': ok({ appointments: APPOINTMENTS }),
  '/pets/medical-records': ok({ records: RECORDS }),
  '/auth/activity-logs': ok({ logs: [{ id: 'l1', action: 'user_logged_in', details: '', created_at: new Date().toISOString() }] }),
  '/appointments/services': ok({ services: SERVICES, species: ['Dog', 'Cat'] }),
  '/admin/services': ok({ services: ADMIN_SERVICES }),
  '/appointments/all': ok({ appointments: [] }),
  '/ai/chat': ok({ reply: 'A general tip.' }),
  ...overrides
});
const adminRoutes = (overrides = {}) => ({
  '/auth/user-status': ok({ user: ADMIN }),
  '/admin/dashboard/overview': ok({
    summary: { upcomingCheckups: 0 },
    users: [ADMIN, OWNER, { id: 'u2', role: 'user', fullname: 'Second Owner', email: 'second@example.test', is_verified: false, created_at: new Date().toISOString() }],
    pets: PETS.map(pet => ({ ...pet, owner_name: 'Test Owner' })),
    appointments: APPOINTMENTS,
    medicalRecords: RECORDS
  }),
  '/admin/system-logs': ok({ logs: [
    { id: 'g1', actor_id: 'a1', actor_name: 'Test Admin', action: 'Updated appointment status from Pending to Approved', target_table: 'appointments', display_text: 'Admin Test Admin approved appointment for Test Owner', created_at: new Date().toISOString() },
    { id: 'g2', user_id: 'u1', action: 'user_logged_in', display_text: 'Test Owner signed in', created_at: new Date().toISOString() }
  ] }),
  '/admin/dashboard/contact-messages': ok({ messages: [{ id: 'm1', fullname: 'Visitor', email: 'visitor@example.test', message: 'Test message.', status: 'Unread', created_at: new Date().toISOString() }] }),
  '/admin/services': ok({ services: ADMIN_SERVICES }),
  '/appointments/services': ok({ services: SERVICES, species: ['Dog', 'Cat'] }),
  ...overrides
});

const OWNER_SECTIONS = [
  ['overview', 'pages/user/dashboard.html'],
  ['pets', 'pages/user/pets.html'],
  ['appointments', 'pages/user/appointments.html'],
  ['health', 'pages/user/health.html']
];
const OWNER_LABELS = ['Overview', 'My Pets', 'Appointments', 'Pet Health & AI Assistant'];
const ADMIN_LABELS = ['Overview', 'Appointment Management', 'Pet Owners & Records', 'System Management', 'Breed Catalog'];

const navState = `(() => {
  const links = [...document.querySelectorAll('.ph-dash-nav-link')];
  const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }; };
  return {
    labels: links.map(link => link.getAttribute('aria-label')),
    current: links.filter(link => link.getAttribute('aria-current') === 'page').map(link => link.dataset.dashboardSection),
    links: links.map(box),
    sidebar: box(document.querySelector('.ph-dash-sidebar')),
    main: box(document.getElementById('main')),
    topbarShown: getComputedStyle(document.querySelector('.ph-dash-topbar')).display !== 'none',
    sideways: document.documentElement.scrollWidth - window.innerWidth
  };
})()`;
const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route === '${route}')`;
// Visible text below 4.5:1 (icons and empty elements are skipped), with how many text elements were measured
const lowContrast = selector => `(() => { ${CONTRAST}
  const measured = [...document.querySelectorAll(${JSON.stringify(`${selector} *`)})]
    .filter(e => e.children.length === 0 && e.textContent.trim() && e.getClientRects().length && !e.closest('[hidden], .hidden, option, .sr-only, .ph-btn-primary, .dashboard-inline-loading'))
    .map(e => [e.textContent.trim().slice(0, 40), Number(ratioOf(getComputedStyle(e).color, background(e)).toFixed(2))]);
  return { measured: measured.length, low: measured.filter(([, value]) => value < 4.5) };
})()`;
async function assertReadable(tab, label, minimum) {
  const { measured, low } = await tab.evaluate(lowContrast('.ph-dash-shell'));
  assert.ok(measured >= minimum, `${label}: ${measured} text elements measured`);
  assert.deepEqual(low, [], label);
}

async function open(file, query, session, routes, options = {}) {
  const tab = await openTab({ url: pageUrl(file, query), session, scenario: { routes }, ...options });
  return tab;
}

describe('Pet Owner Dashboard in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('every section shows the same four sections with the current one marked, in a sidebar beside the content on a desktop', async () => {
    for (const [section, file] of OWNER_SECTIONS) {
      const tab = await open(file, '', OWNER, ownerRoutes(), { width: 1280 });
      try {
        assert.ok(await tab.waitFor(`document.querySelectorAll('.ph-dash-nav-link').length === 4`), file);
        const state = await tab.evaluate(navState);
        assert.deepEqual(state.labels, OWNER_LABELS, file);
        assert.deepEqual(state.current, [section], file);
        assert.equal(state.topbarShown, false, `${file}: the sidebar replaces the top bar`);
        assert.ok(state.sidebar.left === 0 && state.sidebar.width > 200, `${file}: sidebar on the left`);
        assert.ok(state.main.left >= state.sidebar.right, `${file}: the sidebar never covers the content`);
        assert.match(await tab.evaluate(textOf('.ph-dash-sidebar')), /Pet Owner Dashboard/);
        assert.deepEqual(tab.errors, [], file);
      } finally { await tab.close(); }
    }
  });

  it('on a phone the four sections stay in a bar at the top while scrolling, and nothing scrolls sideways', async () => {
    for (const [section, file] of OWNER_SECTIONS) {
      const tab = await open(file, '', OWNER, ownerRoutes(), { width: 375, height: 700 });
      try {
        assert.ok(await tab.waitFor(`document.querySelectorAll('.ph-dash-nav-link').length === 4`), file);
        await sleep(300);
        let state = await tab.evaluate(navState);
        assert.equal(state.topbarShown, true, file);
        assert.ok(state.links.every(link => link.left >= 0 && link.right <= 375 && link.top < 160), `${file}: all four links visible at the top`);
        assert.ok(state.links.every(link => link.bottom - link.top < 70), `${file}: labels fit on their row`);
        assert.ok(state.sideways <= 0, `${file}: no sideways scrolling`);
        await tab.evaluate('window.scrollTo(0, 1200)');
        await sleep(150);
        state = await tab.evaluate(navState);
        assert.ok(Math.abs(state.sidebar.top) < 1, `${file}: the section bar stays at the top`);
        assert.deepEqual(state.current, [section]);
      } finally { await tab.close(); }
    }
  });

  it('Overview counts the owner\'s records and says "Unavailable", never 0, when a request fails', async () => {
    const tab = await open('pages/user/dashboard.html', '', OWNER, ownerRoutes({ '/pets/userPets': failed }));
    try {
      assert.ok(await tab.waitFor(`document.getElementById('ownerStatUpcoming').textContent === '2'`));
      assert.ok(await tab.waitFor(`document.getElementById('ownerStatPets').textContent === 'Unavailable'`));
      assert.equal(await tab.evaluate(`document.getElementById('ownerStatPending').textContent`), '1');
      assert.match(await tab.evaluate(textOf('#recentPetsContainer')), /Unable to load pets/);
      const upcoming = await tab.evaluate(textOf('#recentAppointmentsContainer'));
      assert.match(upcoming, /Mochi/);
      assert.match(upcoming, /Pending/);
      assert.match(upcoming, /1 more upcoming appointment/);
      assert.match(await tab.evaluate(textOf('#recentActivityContainer')), /User Logged In/);
    } finally { await tab.close(); }

    const empty = await open('pages/user/dashboard.html', '', OWNER, ownerRoutes({
      '/pets/userPets': ok({ pets: [] }), '/appointments/userAppointments': ok({ appointments: [] }), '/auth/activity-logs': ok({ logs: [] })
    }));
    try {
      assert.ok(await empty.waitFor(`document.getElementById('ownerStatPets').textContent === '0'`));
      assert.equal(await empty.evaluate(`document.getElementById('ownerStatUpcoming').textContent`), '0');
      assert.match(await empty.evaluate(textOf('#recentPetsContainer')), /No pets added yet/);
      assert.match(await empty.evaluate(textOf('#recentAppointmentsContainer')), /No appointments yet/);
      assert.deepEqual(empty.errors, []);
    } finally { await empty.close(); }
  });

  it('My Pets opens one pet with its official medical history, read-only, and shows a history error inside the details', async () => {
    const tab = await open('pages/user/pets.html', '?pet=p1', OWNER, ownerRoutes());
    try {
      assert.ok(await tab.waitFor(`!document.getElementById('petDetailPanel').hidden && document.getElementById('petDetailContent').innerText.includes('Deworming')`));
      const detail = await tab.evaluate(textOf('#petDetailPanel'));
      assert.match(detail, /Official medical history/);
      assert.match(detail, /Official record/);
      assert.match(detail, /12\.5 kg/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#petHistory input, #petHistory textarea, #petHistory select, #petHistory form').length`), 0, 'the history cannot be edited');
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('#petDetailPanel button')].map(b => b.textContent.trim())`), ['Back to all pets', 'Add owner-reported weight', 'Edit profile'],
        'owner-reported weight and profile details are editable separately; Mochi has history, so it cannot be deleted');
      assert.equal(await tab.evaluate('document.activeElement.id'), 'petDetailTitle');

      await tab.evaluate(`document.querySelector('[data-pet-view="p2"]').click()`);
      assert.ok(await tab.waitFor(`document.getElementById('petDetailName').textContent === 'Luna'`));
      assert.ok(await tab.waitFor(`document.getElementById('petDetailContent').innerText.includes('No medical records yet')`), 'Luna\'s history loads');
      assert.match(await tab.evaluate('location.search'), /pet=p2/);
      await tab.evaluate(`document.getElementById('petDetailClose').click()`);
      assert.equal(await tab.evaluate(`document.getElementById('petDetailPanel').hidden`), true);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }

    const broken = await open('pages/user/pets.html', '?pet=p1', OWNER, ownerRoutes({ '/pets/history/p1': failed }));
    try {
      assert.ok(await broken.waitFor(`document.getElementById('petDetailContent').innerText.includes('Unable to load this pet\\'s history')`));
      assert.match(await broken.evaluate(textOf('#petsList')), /Mochi/, 'the pet list still loads');
    } finally { await broken.close(); }
  });

  it('Appointments filters the server\'s list into Upcoming and History, explains the next step, and keeps booking closed', async () => {
    const tab = await open('pages/user/appointments.html', '', OWNER, ownerRoutes());
    try {
      assert.ok(await tab.waitFor(`document.getElementById('appointmentsList').innerText.includes('Luna')`));
      let list = await tab.evaluate(textOf('#appointmentsList'));
      assert.match(list, /Mochi · Bath/);
      assert.match(list, /Luna · Dog & Cat Full Check Up/);
      assert.doesNotMatch(list, /Checkup|Trim/, 'History is not shown under Upcoming');
      assert.match(list, /Waiting for the clinic to approve this request/);
      assert.match(await tab.evaluate(textOf('#appointmentListSummary')), /Showing 2 of 4 appointments \(2 upcoming, 2 in history\)/);

      await tab.evaluate(`document.querySelector('[data-appointment-when="history"]').click()`);
      list = await tab.evaluate(textOf('#appointmentsList'));
      assert.match(list, /Checkup/);
      assert.match(list, /Trim/);
      assert.doesNotMatch(list, /Bath/);
      assert.equal(await tab.evaluate(`document.querySelector('[data-appointment-when="history"]').getAttribute('aria-pressed')`), 'true');

      await tab.evaluate(`(() => { const s = document.getElementById('appointmentStatusFilter'); s.value = 'Cancelled'; s.dispatchEvent(new Event('change')); })()`);
      list = await tab.evaluate(textOf('#appointmentsList'));
      assert.match(list, /Trim/);
      assert.doesNotMatch(list, /Checkup/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#appointmentsList button').length`), 0, 'no change or cancel buttons for owners');

      // Booking: every service waits for a confirmed duration, so the notice replaces the form
      assert.ok(await tab.waitFor(`!document.getElementById('bookingClosedNotice').hidden`));
      assert.equal(await tab.evaluate(`document.getElementById('appointmentForm').hidden`), true);
      assert.equal(await tab.evaluate(`document.querySelector('#appointmentForm button[type=submit]').disabled`), true);
      assert.deepEqual(await tab.evaluate(requests('POST', '/appointments/create')), []);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('shows the clinic-time cancellation deadline and why a late cancellation is unavailable', async () => {
    const eligible = clinicWallTime(3 * 60 * 60 * 1000);
    const late = clinicWallTime(60 * 60 * 1000);
    const appointments = [
      appointment('11111111-1111-4111-8111-111111111111', { appointment_date: eligible.date, appointment_time: eligible.time, status: 'Pending' }),
      appointment('22222222-2222-4222-8222-222222222222', { appointment_date: late.date, appointment_time: late.time, status: 'Approved' })
    ];
    const tab = await open('pages/user/appointments.html', '', OWNER, ownerRoutes({
      '/appointments/userAppointments': ok({ appointments })
    }));
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('#appointmentsList [data-appointment-cancel]').length === 1`));
      const list = await tab.evaluate(textOf('#appointmentsList'));
      assert.match(list, /Cancel by .*Asia\/Manila/);
      assert.match(list, /two-hour cancellation deadline passed/);
      assert.match(list, /Contact the clinic for help/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('Pet Health keeps official records apart from the AI assistant, which receives a general question and bounded history', async () => {
    const tab = await open('pages/user/health.html', '', OWNER, ownerRoutes());
    try {
      assert.ok(await tab.waitFor(`document.getElementById('healthRecords').innerText.includes('12.5 kg')`));
      const records = await tab.evaluate(textOf('#healthRecords'));
      assert.match(records, /Latest recorded for Mochi/);
      assert.match(records, /Up to date/);
      assert.match(records, /Record history \(2\)/);
      assert.match(await tab.evaluate(textOf('#aiAssistantTitle')), /PetHub AI Assistant/);

      assert.ok(await tab.waitFor('Boolean(window.PetHubAI) && document.getElementById("pethub-ai-popup") !== null'));
      await tab.evaluate(`document.querySelector('[data-ai-question]').click()`);
      assert.ok(await tab.waitFor(`${requests('POST', '/ai/chat')}.length === 1`));
      const sent = JSON.parse((await tab.evaluate(requests('POST', '/ai/chat')))[0].body);
      assert.deepEqual(Object.keys(sent).sort(), ['currentPage', 'history', 'message']);
      assert.ok(Array.isArray(sent.history) && sent.history.length <= 10);
      assert.ok(sent.history.every(entry => String(entry.text || '').length <= 1200));
      assert.equal(sent.currentPage, 'Pet Owner Dashboard - Pet Health & AI Assistant');
      assert.match(sent.message, /\bdog\b/);
      assert.doesNotMatch(sent.message, /Mochi|Aspin|12\.5|Deworming/, 'no pet name, profile or record');
      assert.equal(await tab.evaluate(`document.getElementById('pethub-ai-popup').classList.contains('active')`), true);

      // An emergency containing a word the off-topic filter blocks ("kill") still reaches the backend's emergency path;
      // a plainly off-topic question is still answered in the browser without a request
      assert.ok(await tab.waitFor(`window.PetHubAI.ask('Can rat poison kill my cat?') === true`));
      assert.ok(await tab.waitFor(`${requests('POST', '/ai/chat')}.length === 2`));
      assert.equal(JSON.parse((await tab.evaluate(requests('POST', '/ai/chat')))[1].body).message, 'Can rat poison kill my cat?');
      assert.ok(await tab.waitFor(`window.PetHubAI.ask('Help me with my javascript homework') === true`));
      assert.ok(await tab.waitFor(`document.getElementById('pethub-ai-messages').innerText.includes('pet wellness only')`));
      assert.equal(await tab.evaluate(`${requests('POST', '/ai/chat')}.length`), 2);

      await tab.evaluate(`(() => { const s = document.getElementById('healthPetSelect'); s.value = 'p2'; s.dispatchEvent(new Event('change')); })()`);
      assert.match(await tab.evaluate(textOf('#healthRecords')), /No official records for Luna yet/);
      assert.match(await tab.evaluate(`document.querySelector('[data-ai-question]').textContent`), /\bcat\b/);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }

    const broken = await open('pages/user/health.html', '', OWNER, ownerRoutes({ '/pets/medical-records': failed }));
    try {
      assert.ok(await broken.waitFor(`document.getElementById('healthRecords').innerText.includes('Unable to load medical records')`));
    } finally { await broken.close(); }
  });

  for (const dark of [false, true]) {
    it(`text is readable on every section (${dark ? 'dark' : 'light'} mode)`, async () => {
      for (const [, file] of OWNER_SECTIONS) {
        const tab = await open(file, file.includes('pets') ? '?pet=p1' : '', OWNER, ownerRoutes(), { dark });
        try {
          assert.ok(await tab.waitFor(`!document.querySelector('#main .dashboard-loading-state')`, 6000), `${file} finished loading`);
          assert.ok(await tab.waitFor('document.getAnimations().length === 0'));
          await assertReadable(tab, file, 25);
        } finally { await tab.close(); }
      }
    });
  }
});

describe('Admin Dashboard in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const visibleView = `['adminViewOverview', 'adminViewAppointments', 'adminViewRecords', 'adminViewSystem'].filter(id => !document.getElementById(id).hidden)`;

  it('the four sections switch from the sidebar or the phone bar, the address follows, and earlier addresses open the matching section', async () => {
    const tab = await open('pages/admin/dashboard.html', '', ADMIN, adminRoutes(), { width: 1280 });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('statPets').textContent === '2'`));
      assert.deepEqual((await tab.evaluate(navState)).labels, ADMIN_LABELS);
      for (const [section, view] of [['appointments', 'adminViewAppointments'], ['records', 'adminViewRecords'], ['system', 'adminViewSystem'], ['overview', 'adminViewOverview']]) {
        await tab.evaluate(`document.querySelector('.ph-dash-nav-link[data-dashboard-section="${section}"]').click()`);
        assert.deepEqual(await tab.evaluate(visibleView), [view]);
        assert.equal(await tab.evaluate('location.hash'), `#${section}`);
        assert.deepEqual((await tab.evaluate(navState)).current, [section]);
        assert.equal(await tab.evaluate('document.activeElement.tagName'), 'H1', 'focus moves to the section heading');
      }
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }

    const phone = await open('pages/admin/dashboard.html', '#messages', ADMIN, adminRoutes(), { width: 375 });
    try {
      assert.ok(await phone.waitFor(`location.hash === '#system'`));
      assert.deepEqual(await phone.evaluate(visibleView), ['adminViewSystem']);
      assert.equal(await phone.evaluate(`document.getElementById('systemTabMessages').getAttribute('aria-selected')`), 'true');
      assert.ok(await phone.waitFor(`document.getElementById('contactMessagesTable').innerText.includes('Visitor')`));
      assert.ok((await phone.evaluate(navState)).links.every(link => link.left >= 0 && link.right <= 375));
      assert.ok(await phone.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no sideways scrolling');
    } finally { await phone.close(); }

    // The retired Users page forwards to System Management > Users
    const retired = await open('pages/admin/users.html', '', ADMIN, adminRoutes());
    try {
      assert.ok(await retired.waitFor(`location.pathname.endsWith('/pages/admin/dashboard.html') && location.hash === '#system'`, 6000));
      assert.ok(await retired.waitFor(`document.getElementById('systemTabUsers').getAttribute('aria-selected') === 'true'`));
    } finally { await retired.close(); }
  });

  it('Overview figures come from the server\'s records and say "Unavailable" when they cannot be loaded', async () => {
    const tab = await open('pages/admin/dashboard.html', '', ADMIN, adminRoutes());
    try {
      assert.ok(await tab.waitFor(`document.getElementById('statAppointments').textContent === '4'`));
      assert.deepEqual(await tab.evaluate(`['statPetOwners', 'statPets', 'statPending'].map(id => document.getElementById(id).textContent)`), ['2', '2', '1']);
      assert.match(await tab.evaluate(textOf('#overviewPendingList')), /Mochi · Bath/);
      assert.match(await tab.evaluate(textOf('#overviewUpcomingList')), /Luna/);
      const activity = await tab.evaluate(textOf('#overviewAdminActivity'));
      assert.match(activity, /Admin Test Admin approved appointment/);
      assert.doesNotMatch(activity, /signed in/, 'only administrative actions');
      assert.equal(await tab.evaluate(`document.getElementById('alertUnreadMessages').textContent`), '1');
    } finally { await tab.close(); }

    const broken = await open('pages/admin/dashboard.html', '', ADMIN, adminRoutes({ '/admin/dashboard/overview': failed }));
    try {
      assert.ok(await broken.waitFor(`document.getElementById('statPets').textContent === 'Unavailable'`));
      assert.deepEqual(await broken.evaluate(`['statPetOwners', 'statAppointments', 'statPending'].map(id => document.getElementById(id).textContent)`), ['Unavailable', 'Unavailable', 'Unavailable']);
      assert.match(await broken.evaluate(textOf('#adminDashboardStatus')), /could not be loaded/);
      assert.match(await broken.evaluate(textOf('#overviewPendingList')), /Unable to load pending requests/);
    } finally { await broken.close(); }
  });

  it('approval takes two clicks, sends one request, and only the server\'s answer changes what is shown', async () => {
    const approve = `document.querySelector('[data-appointment-action="Approved"][data-appointment-id="b0000000-0000-4000-8000-000000000001"]')`;
    const conflict = await open('pages/admin/dashboard.html', '#appointments', ADMIN, adminRoutes({
      '/admin/dashboard/appointment-status': { status: 409, body: { error: 'Selected time is unavailable.', suggested_time: '11:00' } }
    }));
    try {
      assert.ok(await conflict.waitFor(`${approve} !== null`));
      await conflict.evaluate(`${approve}.click()`);
      assert.equal(await conflict.evaluate(`${approve}.textContent.trim()`), 'Click again to confirm');
      assert.deepEqual(await conflict.evaluate(requests('PUT', '/admin/dashboard/appointment-status')), [], 'nothing is sent on the first click');
      await conflict.evaluate(`${approve}.click()`);
      assert.ok(await conflict.waitFor(`document.getElementById('adminDashboardStatus').innerText.includes('Next available time')`));
      const sent = await conflict.evaluate(requests('PUT', '/admin/dashboard/appointment-status'));
      assert.equal(sent.length, 1);
      assert.deepEqual(JSON.parse(sent[0].body), { id: 'b0000000-0000-4000-8000-000000000001', status: 'Approved' });
      assert.equal(await conflict.evaluate(textOf('#adminDashboardStatus')), 'Selected time is unavailable. Next available time: 11:00 AM.');
      assert.match(await conflict.evaluate(`${approve}.closest('tr').innerText`), /Pending/, 'the appointment still shows Pending');
      assert.equal((await conflict.evaluate(requests('GET', '/admin/dashboard/overview'))).length, 1, 'nothing is reloaded after a refusal');
    } finally { await conflict.close(); }

    const accepted = await open('pages/admin/dashboard.html', '#appointments', ADMIN, adminRoutes({
      '/admin/dashboard/appointment-status': ok({ appointment: { ...APPOINTMENTS[0], status: 'Approved' } })
    }));
    try {
      assert.ok(await accepted.waitFor(`${approve} !== null`));
      await accepted.evaluate(`${approve}.click(); ${approve}.click()`);
      assert.ok(await accepted.waitFor(`document.getElementById('adminDashboardStatus').innerText.includes('Appointment approved.')`));
      assert.equal((await accepted.evaluate(requests('GET', '/admin/dashboard/overview'))).length, 2, 'the list is reloaded from the server');
      // The mocked server still lists it as Pending: the page shows what the server returns, not a guess
      assert.match(await accepted.evaluate(`document.getElementById('appointmentsTable').innerText`), /Pending/);
      assert.deepEqual(accepted.errors, []);
    } finally { await accepted.close(); }
  });

  it('Appointment Management filters by status, service, date and search, and marks earlier services', async () => {
    const tab = await open('pages/admin/dashboard.html', '#appointments', ADMIN, adminRoutes());
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('#appointmentsTable tr').length === 4`));
      const setFilter = (id, value) => tab.evaluate(`(() => { const e = document.getElementById('${id}'); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change')); return true; })()`);
      assert.ok(await tab.waitFor(`[...document.getElementById('appointmentServiceFilter').options].some(o => o.value === 'Checkup')`));
      assert.match(await tab.evaluate(`[...document.getElementById('appointmentServiceFilter').options].find(o => o.value === 'Checkup').textContent`), /earlier service/);
      await setFilter('appointmentServiceFilter', 'Checkup');
      assert.equal(await tab.evaluate(`document.querySelectorAll('#appointmentsTable tr').length`), 1);
      assert.match(await tab.evaluate(textOf('#appointmentsTable')), /Earlier service/);
      await tab.evaluate(`document.getElementById('appointmentFiltersClear').click()`);
      await setFilter('appointmentStatusFilter', 'Approved');
      assert.match(await tab.evaluate(textOf('#appointmentsTable')), /Luna/);
      await setFilter('appointmentStatusFilter', 'all');
      await setFilter('appointmentDateFilter', day(5));
      assert.match(await tab.evaluate(textOf('#appointmentsTable')), /Mochi/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#appointmentsTable tr').length`), 1);
      await setFilter('appointmentDateFilter', day(1));
      assert.match(await tab.evaluate(textOf('#appointmentsTable')), /No matching appointments found/);
      assert.match(await tab.evaluate(textOf('#appointmentFilterSummary')), /Showing 0 of 4/);
    } finally { await tab.close(); }
  });

  it('Pet Owners & Records uses explicit appointment links and does not offer duplicates', async () => {
    const tab = await open('pages/admin/dashboard.html', '#records', ADMIN, adminRoutes());
    try {
      assert.ok(await tab.waitFor(`document.querySelector('#petsTable [data-pet-view="p1"]') !== null`));
      await tab.evaluate(`document.querySelector('[data-records-list="pets"]').click()`);
      await tab.evaluate(`document.querySelector('#petsTable [data-pet-view="p1"]').click()`);
      assert.ok(await tab.waitFor(`!document.getElementById('adminPetDetail').hidden`));
      const detail = await tab.evaluate(textOf('#adminPetDetail'));
      assert.match(detail, /Entered by the owner/);
      assert.match(detail, /Official medical records \(2\)/);
      assert.equal(await tab.evaluate(`document.querySelector('[data-add-record]')`), null);
      assert.match(await tab.evaluate(textOf('#adminPetDetailContent')), /Record linked/);

      // Luna belongs to the same owner: her profile is one click away
      await tab.evaluate(`document.querySelector('#adminPetDetail [data-other-pet="p2"]').click()`);
      assert.ok(await tab.waitFor(`document.getElementById('adminPetDetailName').textContent === 'Luna'`));
      assert.match(await tab.evaluate(textOf('#adminPetDetailContent')), /No completed appointment is currently available to link/);
      assert.equal(await tab.evaluate(`document.querySelector('[data-add-record]')`), null);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('when the server could not read the medical records, they are shown as unavailable and no record can be added', async () => {
    const overview = adminRoutes()['/admin/dashboard/overview'].body;
    const completedUnlinked = appointment('f0000000-0000-4000-8000-000000000005', { pet_id: 'p2', pet_name: 'Luna', appointment_date: day(-3), status: 'Completed', handled_by: 'a1', handled_by_name: 'Test Admin' });
    const unavailable = ok({
      ...overview,
      summary: { ...overview.summary, totalMedicalRecords: null },
      pets: overview.pets.map(pet => ({ ...pet, medical_record_count: null })),
      appointments: [...APPOINTMENTS.slice(0, 2), { ...completedUnlinked, medical_record_link_status: 'unavailable', has_medical_record: false }],
      medicalRecords: [],
      medicalRecordsAvailable: false
    });
    const tab = await open('pages/admin/dashboard.html', '#records', ADMIN, adminRoutes({ '/admin/dashboard/overview': unavailable }));
    try {
      assert.ok(await tab.waitFor(`document.querySelector('#petsTable [data-pet-view="p2"]') !== null`));
      assert.equal(await tab.evaluate(`document.getElementById('alertMedicalRecords').textContent`), 'Unavailable');
      await tab.evaluate(`document.querySelector('[data-records-list="pets"]').click()`);
      assert.doesNotMatch(await tab.evaluate(textOf('#petsTable')), /\d+ records?/, 'no record count in the pets list');
      await tab.evaluate(`document.querySelector('#petsTable [data-pet-view="p2"]').click()`);
      assert.ok(await tab.waitFor(`!document.getElementById('adminPetDetail').hidden`));
      const detail = await tab.evaluate(textOf('#adminPetDetailContent'));
      assert.match(detail, /Official medical records \(unavailable\)/);
      assert.match(detail, /Unable to load medical records/);
      assert.match(detail, /Unavailable: medical records could not be loaded/, 'the official weight is not shown as missing');
      assert.doesNotMatch(detail, /No medical records yet|No weight recorded yet/);
      assert.equal(await tab.evaluate(`document.querySelector('[data-add-record]')`), null, 'no record can be added');

      await tab.evaluate(`location.hash = '#appointments'`);
      assert.ok(await tab.waitFor(`document.getElementById('appointmentsTable').innerText.includes('Records unavailable')`));
      assert.equal(await tab.evaluate(`document.querySelector('#appointmentsTable [data-record-appointment]')`), null, 'no Add Medical Record button');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('System Management lists editable catalog cards and says online booking is closed', async () => {
    const tab = await open('pages/admin/dashboard.html', '#services', ADMIN, adminRoutes());
    try {
      assert.ok(await tab.waitFor(`document.querySelectorAll('#servicesCatalogContainer .service-config-form').length === 9`));
      assert.match(await tab.evaluate(textOf('#bookingStatusSummary')), /Online booking is closed/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#servicesCatalogContainer .ph-status-other').length`), 9, 'all services shown as closed');
      // One availability switch per service; none can be switched on before a duration (and species) is confirmed
      const switches = await tab.evaluate(`[...document.querySelectorAll('#servicesCatalogContainer [role="switch"]')].map(s => ({ label: s.getAttribute('aria-label'), checked: s.getAttribute('aria-checked'), disabled: s.disabled }))`);
      assert.equal(switches.length, 9);
      assert.ok(switches.every(s => s.checked === 'false' && s.disabled), JSON.stringify(switches));
      assert.equal(switches[0].label, 'Online booking for Bath');
      assert.match(await tab.evaluate(textOf('[data-service-row="b0000000-0000-4000-8000-000000000001"]')), /Needs a confirmed duration under Service details[\s\S]*Temporarily unavailable/);
      assert.match(await tab.evaluate(textOf('[data-service-row="b0000000-0000-4000-8000-000000000003"]')), /Needs a confirmed duration and applicable species/, 'Puppy Cut');
      // The detailed settings are folded away and no longer carry their own availability checkbox
      assert.equal(await tab.evaluate(`document.querySelectorAll('#servicesCatalogContainer details.service-settings[open]').length`), 0);
      assert.equal(await tab.evaluate(`document.querySelectorAll('#servicesCatalogContainer input[name="online_booking_enabled"]').length`), 0);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('an admin switches a service off and on from its row: saved through the API, shown at once, without reloading the list', async () => {
    const configured = ADMIN_SERVICES.map(service => (['Bath', 'Trim'].includes(service.name)
      ? { ...service, duration_minutes: service.name === 'Bath' ? 60 : 45, online_booking_enabled: true, bookable: true, unavailable_reason: '' }
      : service));
    const bath = configured[0];
    const trim = configured[1];
    const saved = (service, enabled, version) => ok({ service: { ...service, online_booking_enabled: enabled, bookable: enabled, unavailable_reason: enabled ? '' : 'Online booking is disabled for this service.' }, version, updated_at: new Date().toISOString() });
    const routes = adminRoutes({
      '/admin/services': ok({ services: configured }),
      [`/admin/services/${bath.id}`]: [saved(bath, false, 2), saved(bath, true, 3)],
      [`/admin/services/${trim.id}`]: { status: 500, body: { success: false, error: 'Could not save this service configuration.' } }
    });
    const tab = await open('pages/admin/dashboard.html', '#services', ADMIN, routes);
    const bathSwitch = `[data-service-toggle="${bath.id}"]`;
    const putBodies = `window.__requests.filter(r => r.method === 'PUT' && r.route === '/admin/services/${bath.id}').map(r => JSON.parse(r.body))`;
    const serviceListLoads = `window.__requests.filter(r => r.method === 'GET' && r.route === '/admin/services').length`;
    try {
      assert.ok(await tab.waitFor(`document.querySelector('${bathSwitch}')?.getAttribute('aria-checked') === 'true'`));
      assert.match(await tab.evaluate(textOf('#bookingStatusSummary')), /open for 2 of 9 services/);
      const loadsBefore = await tab.evaluate(serviceListLoads);

      await tab.click(bathSwitch);
      assert.ok(await tab.waitFor(`document.querySelector('${bathSwitch}').getAttribute('aria-checked') === 'false'`));
      assert.deepEqual((await tab.evaluate(putBodies))[0], {
        name: 'Bath', description: bath.description, category: 'grooming', species: ['Dog', 'Cat'], duration_minutes: 60,
        online_booking_enabled: false, display_order: 1, expected_version: 1
      }, 'only the availability changes; duration and species are sent as saved');
      assert.match(await tab.evaluate(textOf(`[data-service-row="${bath.id}"]`)), /Existing appointments are not affected[\s\S]*Temporarily unavailable/);
      assert.match(await tab.evaluate(textOf('#adminDashboardStatus')), /Bath is temporarily unavailable for new online bookings/);
      assert.match(await tab.evaluate(textOf('#bookingStatusSummary')), /open for 1 of 9 services/);
      assert.equal(await tab.evaluate(`document.querySelector('.service-config-form[data-service-id="${bath.id}"]').dataset.serviceVersion`), '2', 'the settings form saves against the new version');
      assert.equal(await tab.evaluate(serviceListLoads), loadsBefore, 'no full reload');

      await tab.click(bathSwitch);
      assert.ok(await tab.waitFor(`document.querySelector('${bathSwitch}').getAttribute('aria-checked') === 'true'`));
      const second = (await tab.evaluate(putBodies))[1];
      assert.equal(second.online_booking_enabled, true);
      assert.equal(second.expected_version, 2);
      assert.match(await tab.evaluate(textOf('#adminDashboardStatus')), /Bath is available for online booking/);

      // A failed save leaves the switch as it was and says so
      await tab.click(`[data-service-toggle="${trim.id}"]`);
      assert.ok(await tab.waitFor(`/Could not save this service configuration/.test(document.getElementById('adminDashboardStatus').textContent)`));
      assert.equal(await tab.evaluate(`document.querySelector('[data-service-toggle="${trim.id}"]').getAttribute('aria-checked')`), 'true');
      assert.equal(await tab.evaluate(`document.querySelector('[data-service-toggle="${trim.id}"]').disabled`), false, 'ready to try again');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('a switch based on an outdated list reloads the latest settings instead of overwriting them', async () => {
    const configured = ADMIN_SERVICES.map((service, index) => (index === 0 ? { ...service, duration_minutes: 60, online_booking_enabled: true, bookable: true } : service));
    const latest = configured.map((service, index) => (index === 0 ? { ...service, online_booking_enabled: false, bookable: false, version: 4 } : service));
    const routes = adminRoutes({
      '/admin/services': [ok({ services: configured }), ok({ services: latest })],
      [`/admin/services/${configured[0].id}`]: { status: 409, body: { success: false, error: 'This service changed after the page loaded. Reload it and try again.' } }
    });
    const tab = await open('pages/admin/dashboard.html', '#services', ADMIN, routes);
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-service-toggle="${configured[0].id}"]')?.getAttribute('aria-checked') === 'true'`));
      await tab.click(`[data-service-toggle="${configured[0].id}"]`);
      assert.ok(await tab.waitFor(`/changed in another session/.test(document.getElementById('adminDashboardStatus').textContent)`));
      assert.ok(await tab.waitFor(`document.querySelector('.service-config-form[data-service-id="${configured[0].id}"]')?.dataset.serviceVersion === '4'`), 'the latest version is loaded');
      assert.equal(await tab.evaluate(`document.querySelector('[data-service-toggle="${configured[0].id}"]').getAttribute('aria-checked')`), 'false');
    } finally { await tab.close(); }
  });

  for (const dark of [false, true]) {
    it(`text is readable on every section (${dark ? 'dark' : 'light'} mode)`, async () => {
      for (const hash of ['#overview', '#appointments', '#records', '#system']) {
        const tab = await open('pages/admin/dashboard.html', hash, ADMIN, adminRoutes(), { dark });
        try {
          assert.ok(await tab.waitFor(`document.getElementById('statPets').textContent === '2'`));
          await sleep(300);
          assert.ok(await tab.waitFor('document.getAnimations().length === 0'));
          await assertReadable(tab, hash, 25);
        } finally { await tab.close(); }
      }
    });
  }
});
