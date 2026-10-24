// The 2026-10-24 screens in headless Chrome: the Contact page for visitors, customers and staff; the owner's
// cancellation dialog; the admin's message dialog (read, reply, delivery) and clinic contact details.
// MOCKED: helpers/browser.js replaces fetch in the page and blocks every external host; nothing leaves the machine.
// Opt-in (needs Chrome or Edge): PETHUB_BROWSER_TESTS=1 node --test tests/contact-and-cancel.browser.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, pageUrl, startBrowser, stopBrowser, openTab } = require('./helpers/browser');

const CUSTOMER = { id: 'u1', role: 'user', email: 'owner@example.test', fullname: 'Maria Santos', is_verified: true };
const ADMIN = { id: 'a1', role: 'admin', email: 'admin@example.test', fullname: 'Test Admin', is_verified: true };
const ok = body => ({ status: 200, body: { success: true, ...body } });
const textOf = selector => `(document.querySelector(${JSON.stringify(selector)}) || {}).innerText || ''`;
const requests = (method, route) => `window.__requests.filter(r => r.method === '${method}' && r.route === '${route}')`;
const shown = selector => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && !el.hidden && el.getClientRects().length); })()`;
const NO_CLINIC = ok({ configured: false, clinic: { phone: null, email: null, address: null, hours: null, phone_link: null } });

const clinicWallTime = offsetMs => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(Date.now() + offsetMs)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:00` };
};

describe('Contact page in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  it('a signed-out visitor sees the clinic details and a login prompt, not the form', async () => {
    const routes = { '/contact/clinic-info': ok({ configured: true, clinic: { phone: '0917 123 4567', phone_link: '+639171234567', email: 'clinic@example.test', address: null, hours: 'Mon-Sat 9:00-17:00' } }) };
    const tab = await openTab({ url: pageUrl('pages/public/contact.html'), scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('clinicDetails').innerText.includes('0917 123 4567')`));
      assert.equal(await tab.evaluate(`document.querySelector('#clinicDetails a[href^="tel:"]').getAttribute('href')`), 'tel:+639171234567');
      assert.doesNotMatch(await tab.evaluate(textOf('#clinicDetails')), /Address/, 'details the clinic has not entered are left out');
      assert.equal(await tab.evaluate(shown('#contactSignedOut')), true);
      assert.match(await tab.evaluate(textOf('#contactSignedOut')), /Please log in to your PetHub account to send us a message\./);
      assert.equal(await tab.evaluate(shown('#contactForm')), false, 'no form for signed-out visitors');
      assert.match(await tab.evaluate(`document.querySelector('#contactSignedOut a.ph-btn-primary').href`), /login\.html\?next=contact$/);
      assert.match(await tab.evaluate(`document.querySelector('#contactSignedOut a.ph-btn-secondary').href`), /register\.html\?next=contact$/);
      assert.deepEqual(await tab.evaluate(requests('GET', '/contact/mine')), [], 'nothing private is requested');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('logging in from the prompt comes back to the Contact page', async () => {
    const routes = {
      '/auth/login': ok({ user: CUSTOMER, token: 'test-token' }),
      '/contact/clinic-info': NO_CLINIC,
      '/contact/mine': ok({ messages: [] })
    };
    const tab = await openTab({ url: pageUrl('pages/auth/login.html', '?next=contact'), scenario: { routes } });
    try {
      await tab.type('#email', 'owner@example.test');
      await tab.type('#password', 'Clinic#Pass2026');
      await tab.click('#loginForm button[type=submit]');
      assert.ok(await tab.waitFor(`location.pathname.endsWith('/pages/public/contact.html')`, 4000));
      assert.ok(await tab.waitFor(shown('#contactForm')));
    } finally { await tab.close(); }
  });

  it('a signed-in customer sends only a subject and message; the sender comes from the account; replies are listed', async () => {
    const reply = { id: 'm0', subject: 'Earlier question', message: 'Do you groom cats?', status: 'Replied', status_label: 'Answered', created_at: new Date(Date.now() - 86400000).toISOString(), reply_message: 'Yes, <b>we do</b>.', replied_at: new Date().toISOString() };
    const routes = {
      '/contact/clinic-info': NO_CLINIC,
      '/contact/mine': [ok({ messages: [reply] }), ok({ messages: [{ id: 'm1', subject: 'Parking', message: 'Is there parking?', status: 'Unread', status_label: 'Sent', created_at: new Date().toISOString() }, reply] })],
      '/contact': { status: 201, body: { success: true, message: 'Message sent to the clinic.', contact_message: { id: 'm1' } } }
    };
    const tab = await openTab({ url: pageUrl('pages/public/contact.html'), session: CUSTOMER, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(shown('#contactForm')));
      assert.equal(await tab.evaluate(shown('#contactSignedOut')), false);
      assert.match(await tab.evaluate(textOf('#contactSender')), /Sending as Maria Santos \(owner@example\.test\)/);
      assert.match(await tab.evaluate(textOf('#clinicDetails')), /hasn't published its phone number/);
      assert.ok(await tab.waitFor(`document.getElementById('myMessagesList').innerText.includes('Reply from the clinic')`));
      assert.ok(await tab.evaluate(`document.getElementById('myMessagesList').innerHTML.includes('&lt;b&gt;we do&lt;/b&gt;')`), 'replies are shown as text');

      // Empty fields are caught before sending
      await tab.click('#contactForm button[type=submit]');
      assert.match(await tab.evaluate(textOf('#subjectError')), /Enter a subject/);
      assert.deepEqual(await tab.evaluate(requests('POST', '/contact')), []);

      await tab.type('#subject', 'Parking');
      await tab.type('#message', 'Is there parking?');
      assert.match(await tab.evaluate(textOf('#messageCount')), /^17 \/ 2,000$/);
      await tab.click('#contactForm button[type=submit]');
      assert.ok(await tab.waitFor(`${requests('POST', '/contact')}.length === 1`));
      assert.deepEqual(JSON.parse((await tab.evaluate(requests('POST', '/contact')))[0].body), { subject: 'Parking', message: 'Is there parking?' }, 'no name, email or user id is sent');
      assert.ok(await tab.waitFor(`/Your message was sent to the clinic/.test(document.getElementById('formMessage').textContent)`));
      assert.equal(await tab.evaluate(`document.getElementById('subject').value`), '');
      assert.ok(await tab.waitFor(`document.getElementById('myMessagesList').innerText.includes('Parking')`));
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('clinic staff are pointed to the Admin Dashboard instead of the form', async () => {
    const tab = await openTab({ url: pageUrl('pages/public/contact.html'), session: ADMIN, scenario: { routes: { '/contact/clinic-info': NO_CLINIC } } });
    try {
      assert.ok(await tab.waitFor(shown('#contactStaffNote')));
      assert.equal(await tab.evaluate(shown('#contactForm')), false);
      assert.equal(await tab.evaluate(shown('#contactSignedOut')), false);
    } finally { await tab.close(); }
  });
});

describe('Owner cancellation dialog in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const id = '11111111-1111-4111-8111-111111111111';
  const start = clinicWallTime(5 * 60 * 60 * 1000);
  const pending = { id, user_id: 'u1', pet_id: 'p1', pet_name: 'Mochi', service_type: 'Bath', estimated_duration_minutes: 60, appointment_date: start.date, appointment_time: start.time, status: 'Pending', created_at: new Date().toISOString() };
  const cancelled = { ...pending, status: 'Cancelled', cancelled_at: new Date().toISOString(), cancelled_by_owner: true };

  it('names the appointment, changes nothing on "Keep", and shows the server result after "Cancel appointment"', async () => {
    const routes = {
      '/pets/userPets': ok({ pets: [{ id: 'p1', user_id: 'u1', name: 'Mochi', species: 'Dog' }] }),
      '/appointments/services': ok({ services: [], species: ['Dog', 'Cat'] }),
      '/appointments/userAppointments': [ok({ appointments: [pending] }), ok({ appointments: [cancelled] })],
      [`/appointments/cancel/${id}`]: ok({ message: 'Appointment cancelled. We could not confirm that the confirmation email was delivered; the cancellation is saved and shown below, and the clinic can see that the email needs to be resent.', email_status: 'failed', appointment: cancelled })
    };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes } });
    const cancelRequests = requests('POST', `/appointments/cancel/${id}`);
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-appointment-cancel]') !== null`));
      await tab.click('[data-appointment-cancel]');
      assert.ok(await tab.waitFor(`document.getElementById('cancelAppointmentDialog').open`));
      const facts = await tab.evaluate(textOf('#cancelAppointmentFacts'));
      // Labels are shown in capitals by CSS, which innerText reflects
      assert.match(facts, /pet\s+mochi/i);
      assert.match(facts, /service\s+bath/i);
      assert.match(facts, /date\s+\w{3} \d{1,2}, \d{4}/i);
      assert.match(facts, /time\s+\d{1,2}:\d{2} [AP]M - /i);
      assert.match(await tab.evaluate(textOf('#cancelAppointmentDeadline')), /until .* \(Asia\/Manila\), 2 hours before it starts/);

      await tab.click('#cancelAppointmentDialog button.ph-btn-secondary');
      assert.ok(await tab.waitFor(`!document.getElementById('cancelAppointmentDialog').open`));
      assert.deepEqual(await tab.evaluate(cancelRequests), [], '"Keep appointment" sends nothing');
      assert.equal(await tab.evaluate(`document.activeElement.hasAttribute('data-appointment-cancel')`), true, 'focus returns to the button');

      await tab.click('[data-appointment-cancel]');
      assert.ok(await tab.waitFor(`document.getElementById('cancelAppointmentDialog').open`));
      await tab.click('#confirmCancelAppointment');
      assert.ok(await tab.waitFor(`${cancelRequests}.length === 1`));
      assert.ok(await tab.waitFor(`!document.getElementById('cancelAppointmentDialog').open`));
      assert.match(await tab.evaluate(textOf('#appointmentActionFeedback')), /could not confirm that the confirmation email was delivered/);
      // The cancelled appointment stays in the history, marked as cancelled by the owner
      await tab.click('[data-appointment-when="all"]');
      assert.ok(await tab.waitFor(`/Cancelled[\\s\\S]*By you/i.test(document.getElementById('appointmentsList').innerText)`));
      assert.equal(await tab.evaluate(`document.querySelectorAll('[data-appointment-cancel]').length`), 0, 'no cancel action any more');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('a refusal from the server (cutoff passed meanwhile) is explained in the dialog', async () => {
    const routes = {
      '/pets/userPets': ok({ pets: [] }),
      '/appointments/services': ok({ services: [], species: ['Dog', 'Cat'] }),
      '/appointments/userAppointments': ok({ appointments: [pending] }),
      [`/appointments/cancel/${id}`]: { status: 409, body: { error: 'Appointments can only be cancelled at least 2 hours before their scheduled start time. Please contact the clinic for help.', code: 'APPOINTMENT_CANCELLATION_CUTOFF' } }
    };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-appointment-cancel]') !== null`));
      await tab.click('[data-appointment-cancel]');
      await tab.click('#confirmCancelAppointment');
      assert.ok(await tab.waitFor(`/at least 2 hours before/.test(document.getElementById('cancelAppointmentError').textContent)`));
      assert.equal(await tab.evaluate(`document.getElementById('confirmCancelAppointment').disabled`), true, 'it cannot be sent again');
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('with nothing upcoming, the default view offers the history in one click', async () => {
    const past = { ...pending, id: '22222222-2222-4222-8222-222222222222', appointment_date: '2026-01-10', status: 'Completed' };
    const routes = {
      '/pets/userPets': ok({ pets: [] }),
      '/appointments/services': ok({ services: [], species: ['Dog', 'Cat'] }),
      '/appointments/userAppointments': ok({ appointments: [past] })
    };
    const tab = await openTab({ url: pageUrl('pages/user/appointments.html'), session: CUSTOMER, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`document.getElementById('appointmentsList').innerText.includes('No upcoming appointments')`));
      assert.match(await tab.evaluate(textOf('#appointmentsList')), /1 past or cancelled appointment in your history/);
      await tab.click('[data-show-history]');
      assert.ok(await tab.waitFor(`document.querySelector('[data-appointment-when="history"]').getAttribute('aria-pressed') === 'true'`));
      assert.match(await tab.evaluate(textOf('#appointmentsList')), /Completed/);
    } finally { await tab.close(); }
  });
});

describe('Admin contact messages in a browser (mocked API)', { skip }, () => {
  before(startBrowser);
  after(stopBrowser);

  const unread = { id: 'm1', user_id: 'u1', has_account: true, fullname: 'Maria Santos', email: 'owner@example.test', subject: 'Vaccines', message: 'Which vaccines does a puppy need?', status: 'Unread', created_at: new Date().toISOString(), reply_email: null };
  const replied = { ...unread, status: 'Replied', reply_message: 'Please bring the vaccination card.', replied_at: new Date().toISOString(), handled_by_name: 'Test Admin', reply_email: { log_id: '33333333-3333-4333-8333-333333333333', status: 'Failed', error: 'Brevo error: 500' } };
  const baseRoutes = () => ({
    '/auth/user-status': ok({ user: ADMIN }),
    '/admin/dashboard/overview': ok({ summary: {}, users: [ADMIN], pets: [], appointments: [], medicalRecords: [] }),
    '/admin/system-logs': ok({ logs: [] }),
    '/admin/services': ok({ services: [] }),
    '/admin/clinic-settings': ok({ clinic: { phone: null, email: null, address: null, hours: null }, updated_at: null }),
    '/appointments/services': ok({ services: [] })
  });

  it('opening a message marks it read; one reply is sent; a failed reply email can be resent', async () => {
    const routes = {
      ...baseRoutes(),
      '/admin/dashboard/contact-messages': [ok({ messages: [unread] }), ok({ messages: [replied] })],
      '/admin/dashboard/contact-message-status': ok({ message: { ...unread, status: 'Read' } }),
      '/admin/dashboard/contact-messages/m1/reply': ok({ message: replied, email_status: 'failed' }),
      '/admin/email-logs/33333333-3333-4333-8333-333333333333/retry': ok({ email_status: 'sent', message: 'Email sent.' })
    };
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#system'), session: ADMIN, scenario: { routes } });
    try {
      assert.ok(await tab.waitFor(`document.querySelector('[data-system-tab="messages"]') !== null`));
      await tab.click('[data-system-tab="messages"]');
      assert.ok(await tab.waitFor(`document.querySelector('[data-message-open="m1"]') !== null`));
      assert.match(await tab.evaluate(textOf('#contactMessagesTable')), /Maria Santos[\s\S]*Vaccines[\s\S]*Unread/);
      // No clinic details yet: the form is open so the gap is visible
      assert.ok(await tab.waitFor(`document.getElementById('clinicSettingsPanel').open`));

      await tab.click('[data-message-open="m1"]');
      assert.ok(await tab.waitFor(`document.getElementById('contactMessageDialog')?.open`));
      assert.match(await tab.evaluate(textOf('#contactMessageBody')), /Which vaccines does a puppy need\?/);
      assert.ok(await tab.waitFor(`${requests('PUT', '/admin/dashboard/contact-message-status')}.length === 1`), 'opening marks it read');

      await tab.type('#contactReplyText', 'Please bring the vaccination card.');
      await tab.click('#contactReplyForm button[type=submit]');
      assert.ok(await tab.waitFor(`${requests('POST', '/admin/dashboard/contact-messages/m1/reply')}.length === 1`));
      assert.deepEqual(JSON.parse((await tab.evaluate(requests('POST', '/admin/dashboard/contact-messages/m1/reply')))[0].body), { reply: 'Please bring the vaccination card.' });
      assert.ok(await tab.waitFor(`!document.getElementById('contactMessageReplyView').hidden`));
      assert.match(await tab.evaluate(textOf('#contactMessageReplyView')), /Your reply by Test Admin[\s\S]*could not be delivered/);
      assert.equal(await tab.evaluate(`document.getElementById('contactReplyForm').hidden`), true, 'one reply per message');

      await tab.click('#contactMessageReplyView [data-email-retry]');
      assert.ok(await tab.waitFor(`${requests('POST', '/admin/email-logs/33333333-3333-4333-8333-333333333333/retry')}.length === 1`));
      assert.ok(await tab.waitFor(`/Email sent\\./.test(document.getElementById('adminDashboardStatus').textContent)`));
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });

  it('saves the clinic contact details, and shows the field the server refused', async () => {
    const routes = {
      ...baseRoutes(),
      '/admin/dashboard/contact-messages': ok({ messages: [] }),
      '/admin/clinic-settings': [
        ok({ clinic: { phone: null, email: null, address: null, hours: null } }),
        { status: 422, body: { success: false, error: 'Enter a mobile or landline number, such as 0917 123 4567 or 02 8123 4567, or leave it blank.', field: 'phone' } },
        ok({ clinic: { phone: '0917 123 4567', email: 'clinic@example.test', address: null, hours: null } })
      ]
    };
    const tab = await openTab({ url: pageUrl('pages/admin/dashboard.html', '#system'), session: ADMIN, scenario: { routes } });
    try {
      // Wait for the first loads to finish, so the layout no longer moves under the clicks
      assert.ok(await tab.waitFor(`document.getElementById('alertOnlineBooking').textContent === '0 of 0'`));
      await tab.click('[data-system-tab="messages"]');
      assert.ok(await tab.waitFor(`document.getElementById('contactMessagesTable').innerText.includes('No contact messages yet')`));
      assert.ok(await tab.waitFor(`document.getElementById('clinicSettingsPanel').open`));
      await tab.type('#clinicPhone', '12');
      await tab.click('#clinicSettingsForm button[type=submit]');
      assert.ok(await tab.waitFor(`/mobile or landline/.test(document.getElementById('clinicSettingsStatus').textContent)`));
      assert.equal(await tab.evaluate(`document.getElementById('clinicPhone').getAttribute('aria-invalid')`), 'true');

      await tab.type('#clinicPhone', '0917 123 4567');
      await tab.type('#clinicEmail', 'clinic@example.test');
      await tab.click('#clinicSettingsForm button[type=submit]');
      assert.ok(await tab.waitFor(`/Saved/.test(document.getElementById('clinicSettingsStatus').textContent)`));
      const puts = await tab.evaluate(requests('PUT', '/admin/clinic-settings'));
      assert.deepEqual(JSON.parse(puts[1].body), { phone: '0917 123 4567', email: 'clinic@example.test', address: '', hours: '' });
      assert.deepEqual(tab.errors, []);
    } finally { await tab.close(); }
  });
});
