// The 2026-10-24 owner screens in headless Chrome: booking several pets in one booking (pet choices, a service per pet
// limited to what that pet can have, "use the first pet's service for all", the summary with each pet's time slot,
// what is sent, and a refused pet marked without losing the other choices), grouped appointment cards, and the care
// reminders on the dashboard (why, labels, booking only by choice, acknowledge and dismiss).
// MOCKED: helpers/browser.js replaces fetch in the page and blocks every external host; the services use made-up
// test-only durations. Opt-in: PETHUB_BROWSER_TESTS=1 node --test tests/group-booking-and-care.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, pageUrl, startBrowser, stopBrowser, openTab } = require('./helpers/browser');

const CUSTOMER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Maria Santos', is_verified: true };
const ok = body => ({ status: 200, body: { success: true, ...body } });
const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
const PETS = [
  { id: 'p1', user_id: 'u1', name: 'Brownie', species: 'Dog', breed: 'Aspin', age: 4 },
  { id: 'p2', user_id: 'u1', name: 'Luna', species: 'Cat', breed: 'Puspin', age: 2 },
  { id: 'p3', user_id: 'u1', name: 'Choco', species: 'Dog', breed: 'Shih Tzu', age: 6 }
];
const service = (id, name, minutes, species = ['Dog', 'Cat'], category = 'grooming') => ({
  id, service_key: id, name, category, category_label: category === 'grooming' ? 'Grooming' : 'Veterinary check-up', description: '',
  species, duration_minutes: minutes, online_booking_enabled: true, bookable: true, unavailable_reason: '', display_order: 1
});
const SERVICES = [service('s-bath', 'Bath', 60), service('s-puppy', 'Puppy Cut', 90, ['Dog']), service('s-nail', 'Nail Cutting', 15), service('s-check', 'Dog & Cat Full Check Up', 45, ['Dog', 'Cat'], 'veterinary')];
const futureDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + days * 86400000));
const pick = (petId, name) => `(() => { const s = document.querySelector('[data-group-service="${petId}"]'); s.value = [...s.options].find(o => o.textContent.startsWith(${JSON.stringify(name)})).value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`;
const setWhen = (date, time) => `(() => { const d = document.getElementById('groupBookingDate'); d.value = ${JSON.stringify(date)}; d.dispatchEvent(new Event('change')); const t = document.getElementById('groupBookingTime'); t.value = ${JSON.stringify(time)}; t.dispatchEvent(new Event('change')); return true; })()`;

describe('Booking several pets (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  function bookingRoutes(groupAnswers) {
    return {
      '/pets/userPets': ok({ pets: PETS }),
      '/appointments/services': ok({ services: SERVICES, species: ['Dog', 'Cat'] }),
      '/appointments/userAppointments': ok({ appointments: [] }),
      '/appointments/all': ok({ appointments: [] }),
      '/appointments/group': groupAnswers
    };
  }

  it('offers each pet only its services, shows each slot in order, and sends one booking', async () => {
    const date = futureDate(10);
    const created = { status: 201, body: { success: true, group: { id: 'g1', pet_count: 2 }, appointments: [{ id: 'a1' }, { id: 'a2' }] } };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes: bookingRoutes([created]) } });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('bookingModeGroup') && document.querySelector('#serviceCardList [data-service-name]')`));
      await tab.click('#bookingModeGroup');
      assert.ok(await tab.waitFor(`!document.getElementById('groupBookingForm').hidden && document.getElementById('appointmentForm').hidden`));
      assert.match(await tab.evaluate(textOf('#groupPetChoices')), /Brownie[\s\S]*Dog · Aspin · 4 yrs[\s\S]*Luna[\s\S]*Cat · Puspin · 2 yrs/);
      await tab.click('[data-group-pet][value="p1"]');
      await tab.click('[data-group-pet][value="p2"]');
      const catServices = await tab.evaluate(`[...document.querySelector('[data-group-service="p2"]').options].map(o => o.textContent)`);
      assert.ok(!catServices.some(name => /Puppy Cut/.test(name)), 'the dogs-only service is not offered for the cat');
      assert.equal(await tab.evaluate(`document.getElementById('groupBookingSubmit').disabled`), true, 'incomplete booking cannot be sent');
      await tab.evaluate(pick('p1', 'Puppy Cut'));
      await tab.evaluate(pick('p2', 'Dog & Cat Full Check Up'));
      await tab.evaluate(setWhen(date, '09:00'));
      assert.match(await tab.evaluate(textOf('#groupSummaryList')), /#1 Brownie[\s\S]*Puppy Cut · 9:00 AM – 10:30 AM \(1 hr 30 min\)[\s\S]*#2 Luna[\s\S]*Dog & Cat Full Check Up · 10:30 AM – 11:15 AM \(45 min\)/);
      assert.match(await tab.evaluate(textOf('#groupSummaryTotal')), /2 pets .*seen one after another: 9:00 AM to 11:15 AM \(2 hr 15 min in total\)/);
      assert.equal(await tab.evaluate(`document.getElementById('groupBookingSubmit').disabled`), false);
      await tab.click('#groupBookingSubmit');
      assert.ok(await tab.waitFor(`/Booking sent for 2 pets/.test(document.getElementById('groupBookingMessage').textContent)`));
      const sent = await tab.evaluate(`window.__requests.filter(r => r.route === '/appointments/group').map(r => JSON.parse(r.body))`);
      assert.deepEqual(sent, [{ user_id: 'u1', appointment_date: date, appointment_time: '09:00:00', items: [{ pet_id: 'p1', service_id: 's-puppy' }, { pet_id: 'p2', service_id: 's-check' }] }]);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('"use the first pet\'s service" skips pets who cannot have it; a refused pet is marked and every choice stays', async () => {
    const refused = { status: 409, body: { success: false, error: "Selected time is unavailable. Choco's Puppy Cut (from 10:00 AM) overlaps another appointment.", position: 2, pet_id: 'p3', suggested_time: '13:00' } };
    const created = { status: 201, body: { success: true, group: { id: 'g2', pet_count: 3 }, appointments: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] } };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes: bookingRoutes([refused, created]) } });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('#serviceCardList [data-service-name]')`));
      await tab.click('#bookingModeGroup');
      for (const id of ['p1', 'p3', 'p2']) await tab.click(`[data-group-pet][value="${id}"]`);
      await tab.evaluate(pick('p1', 'Puppy Cut'));
      await tab.click('#groupSameService');
      assert.ok(await tab.waitFor(`document.querySelector('[data-group-service="p3"]').selectedOptions[0].textContent.startsWith('Puppy Cut')`));
      assert.equal(await tab.evaluate(`document.querySelector('[data-group-service="p2"]').value`), '', 'the cat is not given a dogs-only service');
      assert.match(await tab.evaluate(textOf('#groupBookingMessage')), /except Luna, who cannot have it/);
      await tab.evaluate(pick('p2', 'Nail Cutting'));
      await tab.evaluate(setWhen(futureDate(11), '08:30'));
      await tab.click('#groupBookingSubmit');
      assert.ok(await tab.waitFor(`document.querySelector('[data-group-pet-row="p3"]').classList.contains('has-error')`));
      assert.equal(await tab.evaluate(`document.querySelector('[data-group-pet-row="p1"]').classList.contains('has-error')`), false);
      assert.match(await tab.evaluate(textOf('#groupBookingMessage')), /Choco's Puppy Cut .* overlaps another appointment/);
      assert.deepEqual(await tab.evaluate(`['p1','p3','p2'].map(id => document.querySelector('[data-group-service="' + id + '"]').value)`), ['s-puppy', 's-puppy', 's-nail'], 'choices kept');
      await tab.click('[data-group-use-time]');
      assert.equal(await tab.evaluate(`document.getElementById('groupBookingTime').value`), '13:00');
      await tab.click('#groupBookingSubmit');
      assert.ok(await tab.waitFor(`/Booking sent for 3 pets/.test(document.getElementById('groupBookingMessage').textContent)`));
      const sent = await tab.evaluate(`window.__requests.filter(r => r.route === '/appointments/group').map(r => JSON.parse(r.body).appointment_time)`);
      assert.deepEqual(sent, ['08:30:00', '13:00:00']);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('appointment cards of one booking name the other pets; the mode switch is hidden when booking is closed', async () => {
    const day = futureDate(12);
    const appointments = [
      { id: 'a1', user_id: 'u1', pet_id: 'p1', pet_name: 'Brownie', service_type: 'Bath', estimated_duration_minutes: 60, appointment_date: day, appointment_time: '09:00:00', status: 'Pending', group_id: 'g1', group_position: 1 },
      { id: 'a2', user_id: 'u1', pet_id: 'p2', pet_name: 'Luna', service_type: 'Nail Cutting', estimated_duration_minutes: 15, appointment_date: day, appointment_time: '10:00:00', status: 'Approved', group_id: 'g1', group_position: 2 }
    ];
    const routes = { ...bookingRoutes([]), '/appointments/userAppointments': ok({ appointments }), '/appointments/services': ok({ services: SERVICES.map(item => ({ ...item, bookable: false, online_booking_enabled: false })) }) };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`/Pet 2 of 2 in one booking/.test(document.getElementById('appointmentsList').innerText)`));
      assert.match(await tab.evaluate(textOf('#appointmentsList')), /Booked together with Luna \(Nail Cutting\)[\s\S]*Booked together with Brownie \(Bath\)/);
      assert.ok(await tab.waitFor(`!document.getElementById('bookingClosedNotice').hidden`));
      assert.equal(await tab.evaluate(`document.getElementById('bookingModeSwitch').hidden`), true);
      assert.equal(await tab.evaluate(`document.getElementById('groupBookingForm').hidden`), true);
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});

describe('Care reminders on the owner dashboard (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const reminder = (overrides = {}) => ({
    id: 'r1', pet_id: 'p2', pet_name: 'Luna', service_id: 's-bath', service_name: 'Face Trim', service_date: '2026-10-20',
    due_from: futureDate(30), due_to: futureDate(44), basis: 'rule', basis_label: "Suggested from the clinic's care schedule",
    guidance_type: 'general', guidance_label: 'General care guidance', status: 'active', bookable_now: true,
    explanation: 'Luna had Face Trim on October 20, 2026. Many coats need a face trim every 6-8 weeks.',
    disclaimer: 'This is a general care reminder, not a diagnosis or prescription.', ...overrides
  });

  it('explains each reminder, links to booking only, and acknowledges or dismisses without booking anything', async () => {
    const routes = {
      '/auth/user-status': ok({ user: CUSTOMER, profile: null }),
      '/pets/userPets': ok({ pets: PETS }),
      '/appointments/userAppointments': ok({ appointments: [] }),
      '/appointments/services': ok({ services: SERVICES }),
      '/auth/activity-logs': ok({ logs: [] }),
      '/pets/care-recommendations': [
        ok({ recommendations: [reminder(), reminder({ id: 'r2', pet_id: 'p1', pet_name: 'Brownie', service_name: 'Medicated Bath', basis: 'needs_review', basis_label: 'Ask the clinic', guidance_type: null, guidance_label: null, due_from: null, due_to: null, bookable_now: false, explanation: 'The clinic has not set a follow-up schedule for Medicated Bath.' })], disclaimer: 'This is a general care reminder, not a diagnosis or prescription.' }),
        ok({ recommendations: [reminder({ status: 'acknowledged' })] }),
        ok({ recommendations: [] })
      ],
      '/pets/care-recommendations/r1/acknowledge': ok({ recommendation: reminder({ status: 'acknowledged' }) }),
      '/pets/care-recommendations/r1/dismiss': ok({ recommendation: reminder({ status: 'dismissed' }) })
    };
    const tab = await openTab({ url: pageUrl('pages/user/dashboard.html'), session: CUSTOMER, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`/Next Face Trim for Luna:/.test(document.getElementById('careRemindersList').innerText)`));
      const text = await tab.evaluate(textOf('#careRemindersList'));
      assert.match(text, /Why you see this:[\s\S]*every 6-8 weeks/);
      assert.match(text, /General care guidance/);
      assert.match(text, /Ask the clinic when Brownie should next have Medicated Bath/);
      assert.match(text, /Medicated Bath can't be booked online right now/);
      assert.match(text, /not a diagnosis/);
      assert.match(await tab.evaluate(`document.querySelector('#careRemindersList a.ph-btn-primary').getAttribute('href')`), /appointments\.html\?pet=p2&service=Face\+Trim/);
      await tab.click('[data-care-ack="r1"]');
      assert.ok(await tab.waitFor(`/You marked this as seen/.test(document.getElementById('careRemindersList').innerText)`));
      assert.match(await tab.evaluate(textOf('#careRemindersStatus')), /Nothing was booked/);
      await tab.click('[data-care-dismiss="r1"]');
      assert.ok(await tab.waitFor(`/No care reminders right now/.test(document.getElementById('careRemindersList').innerText)`));
      const writes = await tab.evaluate(`window.__requests.filter(r => r.method === 'POST').map(r => r.route)`);
      assert.deepEqual(writes, ['/pets/care-recommendations/r1/acknowledge', '/pets/care-recommendations/r1/dismiss'], 'no booking request was made');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
