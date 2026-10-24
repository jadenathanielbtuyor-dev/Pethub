// The 2026-10-24 admin screens in headless Chrome: a multi-pet booking shown as one booking row with each pet beneath
// it ("Cancel whole booking" lists the affected pets first; each pet's buttons change only that pet), rescheduling one
// appointment, adding a service (saved through the API, off until set up), the care reminder rules, and the service
// activity history with server-side filters and pages.
// MOCKED: helpers/browser.js replaces fetch in the page and blocks every external host.
// Opt-in: PETHUB_BROWSER_TESTS=1 node --test tests/admin-bookings-and-catalog.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, pageUrl, startBrowser, stopBrowser, openTab } = require('./helpers/browser');

const ADMIN = { id: 'a1', role: 'admin', email: 'admin@example.test', fullname: 'Test Admin', is_verified: true };
const OWNER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Maria Santos', is_verified: true };
const ok = body => ({ status: 200, body: { success: true, ...body } });
const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route === '${route}').map(r => ({ path: r.path, body: r.body && JSON.parse(r.body) }))`;
// The dashboard restores its last System Management tab while it loads, so tabs are clicked only once it has loaded
const DASHBOARD_READY = `typeof adminDashboardData !== 'undefined' && adminDashboardData.isLoaded === true && adminDashboardData.serviceCatalogLoaded === true`;
const futureDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000));
const GROUP = 'c532b403-0000-4000-8000-000000000001';
const PETS = [
  { id: 'p1', user_id: 'u1', name: 'Brownie', species: 'Dog', breed: 'Aspin', age: 4 },
  { id: 'p2', user_id: 'u1', name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2 }
];
const day = futureDate(9);
const groupRows = [
  { id: 'a0000000-0000-4000-8000-000000000001', user_id: 'u1', user_name: 'Maria Santos', pet_id: 'p1', pet_name: 'Brownie', service_type: 'Bath', estimated_duration_minutes: 60, appointment_date: day, appointment_time: '09:00:00', status: 'Approved', group_id: GROUP, group_position: 1 },
  { id: 'a0000000-0000-4000-8000-000000000002', user_id: 'u1', user_name: 'Maria Santos', pet_id: 'p2', pet_name: 'Luna', service_type: 'Nail Cutting', estimated_duration_minutes: 15, appointment_date: day, appointment_time: '10:00:00', status: 'Pending', group_id: GROUP, group_position: 2 }
];
const single = { id: 'a0000000-0000-4000-8000-000000000003', user_id: 'u1', user_name: 'Maria Santos', pet_id: 'p1', pet_name: 'Brownie', service_type: 'Trim', estimated_duration_minutes: 30, appointment_date: futureDate(20), appointment_time: '10:00:00', status: 'Approved', group_id: null, group_position: null };
const SERVICES = [
  { id: 's-bath', service_key: 'bath', name: 'Bath', category: 'grooming', category_label: 'Grooming', description: '', species: ['Dog', 'Cat'], duration_minutes: 60, online_booking_enabled: true, bookable: true, display_order: 1, version: 1, has_appointments: true, appointment_count: 2 }
];

function baseRoutes(overrides = {}) {
  return {
    '/auth/user-status': ok({ user: ADMIN }),
    '/admin/dashboard/overview': ok({ summary: {}, users: [ADMIN, OWNER], pets: PETS, appointments: [...groupRows, single], medicalRecords: [] }),
    '/admin/system-logs': ok({ logs: [] }),
    '/admin/services': ok({ services: SERVICES }),
    '/admin/clinic-settings': ok({ clinic: { phone: null, email: null, address: null, hours: null }, updated_at: null }),
    '/admin/dashboard/contact-messages': ok({ messages: [] }),
    '/appointments/services': ok({ services: SERVICES }),
    '/admin/care-rules': ok({ rules: [], services: [{ id: 's-bath', name: 'Bath', species: ['Dog', 'Cat'] }], starting_guidance: [{ topic: 'Grooming / face trim', guidance: 'About 6–8 weeks for many coats.' }], guidance_types: [{ value: 'general', label: 'General care guidance' }, { value: 'veterinarian_approved', label: 'Recommended by the clinic veterinarian' }] }),
    '/admin/services/activity': ok({ entries: [], page: 1, page_size: 10, total: 0, total_pages: 1, types: [], admins: [] }),
    ...overrides
  };
}

describe('Multi-pet bookings and rescheduling in Appointment Management (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('shows one booking row with its pets, and cancels the whole booking only after a confirmation listing them', async () => {
    const cancelledRows = groupRows.map(row => ({ ...row, status: 'Cancelled' }));
    const routes = baseRoutes({
      '/admin/dashboard/overview': [
        ok({ summary: {}, users: [ADMIN, OWNER], pets: PETS, appointments: [...groupRows, single], medicalRecords: [] }),
        ok({ summary: {}, users: [ADMIN, OWNER], pets: PETS, appointments: [...cancelledRows, single], medicalRecords: [] })
      ],
      [`/admin/appointment-groups/${GROUP}/cancel`]: ok({ cancelled_appointment_ids: groupRows.map(row => row.id), unchanged: [] })
    });
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#appointments'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`/Multi-pet booking BK-C532B403 · 2 pets/.test(document.getElementById('appointmentsTable').innerText)`));
      const table = await tab.evaluate(textOf('#appointmentsTable'));
      assert.match(table, /buttons in each pet's row change only that pet's appointment/);
      assert.match(table, /Brownie[\s\S]*Pet 1 of 2[\s\S]*Luna[\s\S]*Pet 2 of 2/);
      assert.equal(await tab.evaluate(`document.querySelectorAll('[data-group-cancel]').length`), 1);
      await tab.click(`[data-group-cancel="${GROUP}"]`);
      assert.ok(await tab.waitFor(`document.getElementById('groupCancelDialog')?.open`));
      assert.match(await tab.evaluate(textOf('#groupCancelPets')), /Brownie[\s\S]*Approved → Cancelled[\s\S]*Luna[\s\S]*Pending → Cancelled/);
      // "Keep the booking" changes nothing
      await tab.click('#groupCancelDialog [data-close-dialog].ph-btn-secondary');
      assert.equal(await tab.evaluate(`document.getElementById('groupCancelDialog').open`), false);
      assert.deepEqual(await tab.evaluate(requests('POST', `/admin/appointment-groups/${GROUP}/cancel`)), []);
      await tab.click(`[data-group-cancel="${GROUP}"]`);
      await tab.click('#groupCancelConfirm');
      assert.ok(await tab.waitFor(`/BK-C532B403 cancelled: 2 pet appointments changed to Cancelled/.test(document.getElementById('adminDashboardStatus').textContent)`));
      assert.equal((await tab.evaluate(requests('POST', `/admin/appointment-groups/${GROUP}/cancel`))).length, 1);
      assert.ok(await tab.waitFor(`/No open pet appointments/.test(document.getElementById('appointmentsTable').innerText)`), 'reloaded from the server');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('reschedules one appointment with what the screen showed, and explains a busy time with the next free start', async () => {
    const routes = baseRoutes({
      [`/admin/appointments/${single.id}/schedule`]: [
        { status: 409, body: { success: false, error: 'Selected time is unavailable. Another appointment overlaps that time.', suggested_time: '14:30' } },
        ok({ appointment: { ...single, appointment_time: '14:30:00' } })
      ]
    });
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#appointments'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-appointment-reschedule="${single.id}"]') !== null`));
      await tab.click(`[data-appointment-reschedule="${single.id}"]`);
      assert.ok(await tab.waitFor(`document.getElementById('rescheduleDialog')?.open`));
      assert.match(await tab.evaluate(textOf('#rescheduleIntro')), /Brownie · Trim · now/);
      await tab.evaluate(`(() => { const f = document.getElementById('rescheduleForm'); f.elements.appointment_time.value = '14:00'; return true; })()`);
      await tab.click('#rescheduleSubmit');
      assert.ok(await tab.waitFor(`/next free start that day is 2:30 PM/.test(document.getElementById('rescheduleError').textContent)`));
      assert.equal(await tab.evaluate(`document.getElementById('rescheduleDialog').open`), true, 'the dialog stays open');
      await tab.evaluate(`(() => { const f = document.getElementById('rescheduleForm'); f.elements.appointment_time.value = '14:30'; return true; })()`);
      await tab.click('#rescheduleSubmit');
      assert.ok(await tab.waitFor(`!document.getElementById('rescheduleDialog').open`));
      const sent = await tab.evaluate(requests('PUT', `/admin/appointments/${single.id}/schedule`));
      assert.deepEqual(sent.map(request => request.body), [
        { appointment_date: single.appointment_date, appointment_time: '14:00', expected_status: 'Approved', expected_date: single.appointment_date, expected_time: '10:00' },
        { appointment_date: single.appointment_date, appointment_time: '14:30', expected_status: 'Approved', expected_date: single.appointment_date, expected_time: '10:00' }
      ]);
      assert.ok(await tab.waitFor(`/owner is emailed the new time/.test(document.getElementById('adminDashboardStatus').textContent)`), 'shown after the list reloads');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});

describe('Services & booking: add a service, care rules, activity pages (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('adds a service through the API (off until set up) and shows how many appointments use each service', async () => {
    const created = { id: 's-dental', service_key: 'dental-cleaning', name: 'Dental Cleaning', category: 'veterinary', category_label: 'Veterinary check-up', description: 'Teeth cleaning.', species: [], duration_minutes: null, online_booking_enabled: false, bookable: false, display_order: 2 };
    const routes = baseRoutes({ '/admin/services': [ok({ services: SERVICES }), { status: 201, body: { success: true, service: created, version: 1, updated_at: new Date().toISOString() } }] });
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#system'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(DASHBOARD_READY), 'the dashboard finished loading');
      await tab.click('[data-system-tab="services"]');
      assert.ok(await tab.waitFor(`/2 appointments use this service/.test(document.getElementById('servicesCatalogContainer').innerText)`));
      await tab.click('#addServiceButton');
      assert.ok(await tab.waitFor(`document.getElementById('serviceSetupDialog')?.open`));
      assert.equal(await tab.evaluate(`document.getElementById('serviceSetupSubmit').textContent`), 'Add service');
      await tab.type('#serviceSetupName', 'Dental Cleaning');
      await tab.evaluate(`document.getElementById('serviceSetupCategory').value = 'veterinary'; document.getElementById('serviceSetupDescription').value = 'Teeth cleaning.'; true`);
      await tab.click('#serviceSetupSubmit');
      assert.ok(await tab.waitFor(`!document.getElementById('serviceSetupDialog').open && document.querySelector('[data-service-toggle="s-dental"]') !== null`));
      const posted = await tab.evaluate(requests('POST', '/admin/services'));
      assert.deepEqual(posted[0].body, { name: 'Dental Cleaning', description: 'Teeth cleaning.', category: 'veterinary', species: [], duration_minutes: null, display_order: 2, online_booking_enabled: false });
      assert.ok(await tab.waitFor(`/Dental Cleaning was added\. Online booking for it is off/.test(document.getElementById('adminDashboardStatus').textContent)`));
      assert.equal((await tab.evaluate(requests('GET', '/admin/care-rules'))).length, 1, 'the tab loads its rules once');
      assert.equal((await tab.evaluate(requests('GET', '/admin/services/activity'))).length, 2, 'once on opening, once after the new service');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('adds a care reminder rule and shows the starting guidance as reference only', async () => {
    const rule = { id: 'r1', service_id: 's-bath', service_name: 'Bath', species: null, species_label: 'All species', min_interval_days: 42, max_interval_days: 56, interval_label: '6 weeks to 8 weeks', guidance_type: 'general', guidance_label: 'General care guidance', description: 'Many coats need a bath every 6-8 weeks.', explanation: '', is_active: true, version: 1, open_recommendations: 0 };
    const base = baseRoutes()['/admin/care-rules'].body;
    const routes = baseRoutes({
      '/admin/care-rules': [ok(base), { status: 201, body: { success: true, rule, note: 'Rule changes apply to services completed from now on.' } }, ok({ ...base, rules: [rule] })]
    });
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#system'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(DASHBOARD_READY), 'the dashboard finished loading');
      await tab.click('[data-system-tab="services"]');
      assert.ok(await tab.waitFor(`/No care reminder rules yet/.test(document.getElementById('careRulesContainer').innerText)`));
      assert.match(await tab.evaluate(`document.getElementById('careGuidanceReference').textContent`), /Grooming \/ face trim/);
      await tab.click('#addCareRuleButton');
      assert.ok(await tab.waitFor(`document.getElementById('careRuleDialog')?.open`));
      await tab.type('#careRuleMin', '56');
      await tab.type('#careRuleMax', '42');
      await tab.type('#careRuleDescription', 'Many coats need a bath every 6-8 weeks.');
      await tab.click('#careRuleSubmit');
      assert.match(await tab.evaluate(textOf('#careRuleError')), /latest interval/, 'a backwards range is caught before sending');
      await tab.evaluate(`document.getElementById('careRuleMin').value = '42'; document.getElementById('careRuleMax').value = '56'; true`);
      await tab.click('#careRuleSubmit');
      assert.ok(await tab.waitFor(`/Bath · All species/.test(document.getElementById('careRulesContainer').innerText)`));
      const posted = await tab.evaluate(requests('POST', '/admin/care-rules'));
      assert.deepEqual(posted.map(request => request.body), [{ service_id: 's-bath', species: null, min_interval_days: 42, max_interval_days: 56, guidance_type: 'general', description: 'Many coats need a bath every 6-8 weeks.', explanation: '', is_active: true }]);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('service activity: filters and pages are asked of the server and kept while paging', async () => {
    const entry = index => ({ id: `e${index}`, created_at: new Date(Date.now() - index * 60000).toISOString(), service_id: 's-bath', service_name: 'Bath', event_type: 'service_updated', event_label: 'Settings changed', admin_id: 'a1', admin_name: 'Test Admin', details: `Description: "x${index}" → "y${index}"` });
    const info = { page_size: 10, types: [{ value: 'service_updated', label: 'Settings changed' }, { value: 'service_activated', label: 'Online booking turned on' }], admins: [{ id: 'a1', name: 'Test Admin' }] };
    const routes = baseRoutes({
      '/admin/services/activity': [
        ok({ ...info, entries: Array.from({ length: 10 }, (_, i) => entry(i)), page: 1, total: 23, total_pages: 3 }),
        ok({ ...info, entries: Array.from({ length: 10 }, (_, i) => entry(i + 10)), page: 2, total: 23, total_pages: 3 }),
        ok({ ...info, entries: [entry(30)], page: 1, total: 1, total_pages: 1 }),
        ok({ ...info, entries: [], page: 1, total: 0, total_pages: 1 })
      ]
    });
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#system'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(DASHBOARD_READY), 'the dashboard finished loading');
      await tab.click('[data-system-tab="services"]');
      assert.ok(await tab.waitFor(`/Showing 1–10 of 23, newest first/.test(document.getElementById('serviceActivitySummary').textContent)`));
      assert.match(await tab.evaluate(textOf('#serviceActivityList')), /Bath · Settings changed[\s\S]*Test Admin[\s\S]*Description: "x0" → "y0"/);
      await tab.evaluate(`document.querySelector('#serviceActivityPagination [data-page="2"]').click(); true`);
      assert.ok(await tab.waitFor(`/Showing 11–20 of 23/.test(document.getElementById('serviceActivitySummary').textContent)`));
      await tab.evaluate(`(() => { document.getElementById('serviceActivityType').value = 'service_activated'; document.getElementById('serviceActivityAdmin').value = 'a1'; document.getElementById('serviceActivityFrom').value = '2026-10-01'; document.getElementById('serviceActivityTo').value = '2026-10-31'; document.getElementById('serviceActivityFilters').requestSubmit(); return true; })()`);
      assert.ok(await tab.waitFor(`/Showing 1–1 of 1/.test(document.getElementById('serviceActivitySummary').textContent)`));
      await tab.evaluate(`(() => { document.getElementById('serviceActivityFrom').value = '2026-10-31'; document.getElementById('serviceActivityTo').value = '2026-10-01'; document.getElementById('serviceActivityFilters').requestSubmit(); return true; })()`);
      assert.match(await tab.evaluate(textOf('#serviceActivitySummary')), /start date must be on or before the end date/);
      const queries = (await tab.evaluate(requests('GET', '/admin/services/activity'))).map(request => Object.fromEntries(new URLSearchParams(request.path.split('?')[1])));
      assert.equal(queries.length, 3, 'a backwards date range is not sent');
      assert.deepEqual([queries[0].page, queries[1].page], ['1', '2']);
      assert.deepEqual({ page: queries[2].page, type: queries[2].type, admin_id: queries[2].admin_id, from: queries[2].from, to: queries[2].to }, { page: '1', type: 'service_activated', admin_id: 'a1', from: '2026-10-01', to: '2026-10-31' });
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
