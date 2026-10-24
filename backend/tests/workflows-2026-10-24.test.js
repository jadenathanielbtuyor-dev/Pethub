// The 2026-10-24 workflows, end to end against the real Express app and the in-memory database (helpers/harness.js;
// Brevo is faked, nothing leaves the machine):
// - Contact messages require a signed-in account; the sender comes from the token, never the request body; the clinic
//   reads, answers (stored, then emailed) and can resend a failed reply email.
// - The clinic's public contact details live in system_settings and appear on the Contact page and in emails.
// - Owner cancellation: the confirmation email is logged, a failed email keeps the cancellation and is reported to
//   the owner, the clinic sees it and resends it once.
// - The service setup workflow: one save completes the missing settings and switches the service on.
// - Approve only before the start time, complete only after it; a booked service keeps its name.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let admin;
before(async () => {
  t = await startTestApp();
  admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
});
after(async () => { await t.close(); });

const asAdmin = (method, url, body) => t.api(method, url, { token: admin.token, body });
const sendMessage = (user, body) => t.api('POST', '/contact', { token: user?.token, body });

describe('Contact messages require an account', () => {
  it('a signed-out visitor cannot send a message, and nothing is stored', async () => {
    const before = t.db.table('contact_messages').length;
    const response = await t.api('POST', '/contact', { body: { name: 'Visitor', email: 'visitor@example.test', subject: 'Hi', message: 'Hello' } });
    assert.equal(response.status, 401);
    assert.equal(t.db.table('contact_messages').length, before);
  });

  it('the sender is the signed-in account: a name, email or user id in the body cannot change it', async () => {
    const sender = t.createUser({ name: 'Real Sender' });
    const victim = t.createUser({ name: 'Someone Else' });

    const impersonation = await sendMessage(sender, { user_id: victim.id, subject: 'Hi', message: 'Pretending' });
    assert.equal(impersonation.status, 403, 'a user_id that is not the token owner is refused');

    const response = await sendMessage(sender, { name: victim.fullname, email: victim.email, subject: 'Booking help', message: 'Can I bring two dogs?' });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const stored = t.db.find('contact_messages', row => row.id === response.body.contact_message.id);
    assert.equal(stored.user_id, sender.id);
    assert.equal(stored.fullname, 'Real Sender');
    assert.equal(stored.email, sender.email);
    assert.equal(stored.subject, 'Booking help');
    assert.equal(stored.status, 'Unread');
    assert.equal(t.db.table('contact_messages').filter(row => row.email === victim.email).length, 0);
  });

  it('an unverified account must verify its email first', async () => {
    const unverified = t.createUser({ verified: false });
    const response = await sendMessage(unverified, { subject: 'Hi', message: 'Hello' });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /verify your email/);
  });

  it('a repeated identical message (double click or retry) is stored once', async () => {
    const sender = t.createUser();
    const body = { subject: 'Hours', message: 'Are you open on Sunday?' };
    const first = await sendMessage(sender, body);
    const second = await sendMessage(sender, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.contact_message.id, first.body.contact_message.id);
    assert.equal(t.db.table('contact_messages').filter(row => row.user_id === sender.id).length, 1);
  });

  it('a customer sees only their own messages, with a status they understand', async () => {
    const mine = t.createUser();
    const other = t.createUser();
    await sendMessage(mine, { subject: 'Mine', message: 'My question' });
    await sendMessage(other, { subject: 'Theirs', message: 'Their question' });

    const list = await t.api('GET', '/contact/mine', { token: mine.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.messages.map(message => message.subject), ['Mine']);
    assert.equal(list.body.messages[0].status_label, 'Sent');
    assert.equal(list.body.messages[0].handled_by, undefined, 'no admin ids are sent to customers');
    assert.equal((await t.api('GET', '/contact/mine')).status, 401);
    assert.equal((await t.api('GET', `/contact/mine?user_id=${other.id}`, { token: mine.token })).status, 403);
  });
});

describe('The clinic answers contact messages', () => {
  it('admin lists the sender, marks it read, replies once; the reply is stored, emailed (escaped) and shown to the customer', async () => {
    const sender = t.createUser({ name: 'Ana <b>Reyes</b>' });
    const sent = await sendMessage(sender, { subject: 'Vaccines', message: 'Which vaccines does a puppy need?' });
    const id = sent.body.contact_message.id;

    const list = await asAdmin('GET', '/admin/dashboard/contact-messages');
    const listed = list.body.messages.find(message => message.id === id);
    assert.equal(listed.subject, 'Vaccines');
    assert.equal(listed.has_account, true);
    assert.equal(listed.email, sender.email);

    assert.equal((await asAdmin('PUT', '/admin/dashboard/contact-message-status', { id, status: 'Read' })).status, 200);
    assert.equal(t.db.find('contact_messages', row => row.id === id).status, 'Read');

    const reply = await asAdmin('POST', `/admin/dashboard/contact-messages/${id}/reply`, { reply: 'Please bring the <i>vaccination card</i>.\n\nSee you soon.' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.email_status, 'sent');
    const stored = t.db.find('contact_messages', row => row.id === id);
    assert.equal(stored.status, 'Replied');
    assert.equal(stored.handled_by, admin.id);
    assert.ok(stored.replied_at);

    const [email] = t.emailsTo(sender.email);
    assert.equal(email.subject, 'PetHub — The clinic replied to your message');
    assert.match(email.text, /Please bring the <i>vaccination card<\/i>\./);
    assert.ok(email.html.includes('&lt;i&gt;vaccination card&lt;/i&gt;'));
    assert.ok(email.html.includes('Ana &lt;b&gt;Reyes&lt;/b&gt;'));
    assert.ok(!email.html.includes('<i>vaccination'));
    assert.deepEqual(t.db.table('email_logs').filter(row => row.contact_message_id === id).map(row => [row.email_type, row.status]), [['contact_reply', 'Sent']]);

    const again = await asAdmin('POST', `/admin/dashboard/contact-messages/${id}/reply`, { reply: 'Second answer' });
    assert.equal(again.status, 409, 'one reply per message');
    assert.equal(t.emailsTo(sender.email).length, 1);

    // Marking an answered message as read does not take it back to Read
    assert.equal((await asAdmin('PUT', '/admin/dashboard/contact-message-status', { id, status: 'Read' })).status, 200);
    assert.equal(t.db.find('contact_messages', row => row.id === id).status, 'Replied');

    const seen = (await t.api('GET', '/contact/mine', { token: sender.token })).body.messages[0];
    assert.equal(seen.status_label, 'Answered');
    assert.match(seen.reply_message, /vaccination card/);
  });

  it('a failed reply email keeps the reply; the clinic resends it once', async () => {
    const sender = t.createUser();
    const id = (await sendMessage(sender, { subject: 'Grooming', message: 'How long does a bath take?' })).body.contact_message.id;

    t.failNextEmail({ status: 500 });
    const reply = await asAdmin('POST', `/admin/dashboard/contact-messages/${id}/reply`, { reply: 'About an hour.' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.email_status, 'failed');
    assert.equal(t.db.find('contact_messages', row => row.id === id).status, 'Replied', 'the reply is kept');

    const listed = (await asAdmin('GET', '/admin/dashboard/contact-messages')).body.messages.find(message => message.id === id);
    assert.equal(listed.reply_email.status, 'Failed');
    const retried = await asAdmin('POST', `/admin/email-logs/${listed.reply_email.log_id}/retry`, {});
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(t.emailsTo(sender.email).length, 1);
    assert.equal((await asAdmin('POST', `/admin/email-logs/${listed.reply_email.log_id}/retry`, {})).status, 409, 'a delivered email is not sent again');
    assert.equal(t.emailsTo(sender.email).length, 1);
  });

  it('pet owners cannot read the inbox, reply, or resend emails', async () => {
    const owner = t.createUser();
    const id = (await sendMessage(owner, { subject: 'Hi', message: 'Hello' })).body.contact_message.id;
    assert.equal((await t.api('GET', '/admin/dashboard/contact-messages', { token: owner.token })).status, 403);
    assert.equal((await t.api('POST', `/admin/dashboard/contact-messages/${id}/reply`, { token: owner.token, body: { reply: 'x' } })).status, 403);
    assert.equal(t.db.find('contact_messages', row => row.id === id).status, 'Unread');
  });
});

describe('Clinic contact details', () => {
  it('start empty (nothing invented), are saved by an admin only, validated, and published', async () => {
    const empty = await t.api('GET', '/contact/clinic-info');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.configured, false);
    assert.deepEqual(Object.values(empty.body.clinic).filter(Boolean), []);

    const owner = t.createUser();
    assert.equal((await t.api('PUT', '/admin/clinic-settings', { token: owner.token, body: { phone: '0917 123 4567' } })).status, 403);
    assert.equal((await asAdmin('PUT', '/admin/clinic-settings', { phone: '12' })).status, 422);
    assert.equal((await asAdmin('PUT', '/admin/clinic-settings', { email: 'not-an-email' })).status, 422);
    assert.equal((await asAdmin('PUT', '/admin/clinic-settings', { website: 'x' })).status, 422);
    assert.equal(t.db.table('system_settings').length, 0);

    const saved = await asAdmin('PUT', '/admin/clinic-settings', { phone: '0917 123 4567', email: 'Clinic@Example.test', address: '', hours: 'Mon-Sat 9:00-17:00' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const published = await t.api('GET', '/contact/clinic-info');
    assert.equal(published.body.configured, true);
    assert.equal(published.body.clinic.phone, '0917 123 4567');
    assert.equal(published.body.clinic.phone_link, '+639171234567');
    assert.equal(published.body.clinic.email, 'clinic@example.test');
    assert.equal(published.body.clinic.address, null);
    assert.ok(t.db.table('activity_logs').some(row => row.action === 'Updated the clinic contact details' && row.actor_id === admin.id));

    // The cancellation email then lists them under "Need help?"
    const customer = t.createUser();
    const appointment = t.createAppointment(customer, { daysAhead: 30 });
    assert.equal((await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: customer.token })).status, 200);
    const [email] = t.emailsTo(customer.email);
    assert.match(email.text, /Need help\? Contact the clinic:\nPhone: 0917 123 4567\nEmail: clinic@example\.test\nOpening hours: Mon-Sat 9:00-17:00/);

    assert.equal((await asAdmin('PUT', '/admin/clinic-settings', { phone: '', email: '', address: '', hours: '' })).status, 200);
    assert.equal((await t.api('GET', '/contact/clinic-info')).body.configured, false);
  });

  it('without clinic details, emails point to the signed-in Contact page instead', async () => {
    const customer = t.createUser();
    const appointment = t.createAppointment(customer, { daysAhead: 31 });
    assert.equal((await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: customer.token })).status, 200);
    const [email] = t.emailsTo(customer.email);
    assert.match(email.text, /Need help\? Sign in to PetHub and send the clinic a message from the Contact page\.\nhttps:\/\/pethub-frontend\.test\/pages\/public\/contact\.html/);
  });
});

describe('Owner cancellation email delivery', () => {
  it('a failed confirmation keeps the cancellation, tells the owner, shows the clinic, and is resent once', async () => {
    const owner = t.createUser({ name: 'Ben Cruz' });
    const appointment = t.createAppointment(owner, { daysAhead: 40, status: 'Approved' });

    t.failNextEmail({ network: true });
    const response = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
    assert.equal(response.status, 200);
    assert.equal(response.body.email_status, 'failed');
    assert.match(response.body.message, /Appointment cancelled\. We could not confirm that the confirmation email was delivered/);
    assert.equal(t.appointmentRow(appointment.id).status, 'Cancelled', 'the cancellation is kept');
    assert.equal(t.emailsTo(owner.email).length, 0);

    const overview = await asAdmin('GET', '/admin/dashboard/overview');
    const listed = overview.body.appointments.find(row => row.id === appointment.id);
    assert.equal(listed.cancelled_by_owner, true);
    assert.equal(listed.cancelled_by_name, 'Ben Cruz');
    assert.ok(listed.cancelled_at);
    const [failed] = listed.emails;
    assert.equal(failed.type, 'appointment_cancelled_by_owner');
    assert.equal(failed.status, 'Failed');

    // A retried cancellation request does not send anything
    const again = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
    assert.equal(again.body.already_cancelled, true);
    assert.equal(t.emailsTo(owner.email).length, 0);

    const owners = await t.api('POST', `/admin/email-logs/${failed.log_id}/retry`, { token: owner.token, body: {} });
    assert.equal(owners.status, 403, 'only admins resend');
    const [first, second] = await Promise.all([
      asAdmin('POST', `/admin/email-logs/${failed.log_id}/retry`, {}),
      asAdmin('POST', `/admin/email-logs/${failed.log_id}/retry`, {})
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409], 'two admins retrying at once send it once');
    const delivered = t.emailsTo(owner.email);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].subject, 'Your PetHub Appointment Has Been Cancelled');
    assert.equal(t.db.find('email_logs', row => row.id === failed.log_id).status, 'Sent');
  });

  it('the clinic sees who cancelled: the owner or the clinic', async () => {
    const owner = t.createUser();
    const byOwner = t.createAppointment(owner, { daysAhead: 41 });
    const byClinic = t.createAppointment(owner, { daysAhead: 42, time: '14:00:00' });
    await t.api('POST', `/appointments/cancel/${byOwner.id}`, { token: owner.token });
    await asAdmin('PUT', '/admin/dashboard/appointment-status', { id: byClinic.id, status: 'Cancelled' });
    await t.settleEmails();

    const listed = (await asAdmin('GET', '/admin/dashboard/overview')).body.appointments;
    assert.equal(listed.find(row => row.id === byOwner.id).cancelled_by_owner, true);
    assert.equal(listed.find(row => row.id === byClinic.id).cancelled_by_owner, false);
    assert.equal(listed.find(row => row.id === byClinic.id).cancelled_by_name, 'Clinic Admin');
    const ownerView = (await t.api('GET', `/appointments/userAppointments?user_id=${owner.id}`, { token: owner.token })).body.appointments;
    assert.equal(ownerView.find(row => row.id === byClinic.id).cancelled_by_owner, false);
    assert.ok(ownerView.every(row => row.cancelled_by === undefined));
  });
});

describe('Email log safeguards (service level)', () => {
  const path = require('path');
  const delivery = () => require(path.join(__dirname, '..', 'services', 'emailDeliveryService.js'));
  const email = { subject: 'Test', text: 'Test email', html: '<p>Test email</p>' };

  it('a second email of the same type for the same appointment is refused by the log and not sent', async () => {
    const owner = t.createUser();
    const appointment = t.createAppointment(owner, { daysAhead: 90 });
    const send = () => delivery().sendLoggedEmail({ type: 'appointment_cancelled_by_owner', to: owner.email, email, userId: owner.id, appointmentId: appointment.id });
    const first = await send();
    const second = await send();
    assert.equal(first.status, 'sent');
    assert.equal(second.status, 'duplicate');
    assert.equal(t.emailsTo(owner.email).length, 1);
  });

  it('two retries of one failed email at the same moment send it once', async () => {
    const owner = t.createUser();
    const appointment = t.createAppointment(owner, { daysAhead: 91 });
    t.failNextEmail({ status: 500 });
    const failed = await delivery().sendLoggedEmail({ type: 'appointment_approved', to: owner.email, email, userId: owner.id, appointmentId: appointment.id });
    assert.equal(failed.status, 'failed');
    const build = async () => ({ to: owner.email, email });
    const outcomes = await Promise.all([delivery().retryLoggedEmail(failed.logId, build), delivery().retryLoggedEmail(failed.logId, build)]);
    assert.deepEqual(outcomes.map(outcome => outcome.status).sort(), ['not_retryable', 'sent']);
    assert.equal(t.emailsTo(owner.email).length, 1);
  });
});

describe('Service setup workflow', () => {
  it('one save completes the missing settings and switches the service on; switching off stops new bookings only', async () => {
    const puppyCut = t.db.find('pethub_service_catalog', row => row.name === 'Puppy Cut');
    puppyCut.duration_minutes = null;
    puppyCut.species = [];
    puppyCut.online_booking_enabled = false;
    const listed = (await asAdmin('GET', '/admin/services')).body.services.find(row => row.name === 'Puppy Cut');
    assert.equal(listed.bookable, false);

    const body = { name: listed.name, description: listed.description, category: listed.category, display_order: listed.display_order, expected_version: listed.version };
    const incomplete = await asAdmin('PUT', `/admin/services/${listed.id}`, { ...body, species: ['Dog'], duration_minutes: null, online_booking_enabled: true });
    assert.equal(incomplete.status, 422);
    assert.equal(incomplete.body.field, 'duration_minutes');
    assert.equal(t.db.find('pethub_service_catalog', row => row.id === listed.id).online_booking_enabled, false, 'nothing is half-saved');

    const activated = await asAdmin('PUT', `/admin/services/${listed.id}`, { ...body, species: ['Dog'], duration_minutes: 90, online_booking_enabled: true });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(activated.body.service.bookable, true);

    const owner = t.createUser();
    const dog = t.createPet(owner, 'Brownie');
    const booking = await t.api('POST', '/appointments/create', { token: owner.token, body: {
      user_id: owner.id, pet_id: dog.id, service_id: listed.id, appointment_date: t.manilaDate(50), appointment_time: '10:00'
    } });
    assert.equal(booking.status, 201, JSON.stringify(booking.body));

    const off = await asAdmin('PUT', `/admin/services/${listed.id}`, { ...body, species: ['Dog'], duration_minutes: 90, online_booking_enabled: false, expected_version: activated.body.version });
    assert.equal(off.status, 200);
    const refused = await t.api('POST', '/appointments/create', { token: owner.token, body: {
      user_id: owner.id, pet_id: dog.id, service_id: listed.id, appointment_date: t.manilaDate(51), appointment_time: '10:00'
    } });
    assert.equal(refused.status, 409);
    assert.equal(t.appointmentRow(booking.body.appointment.id).status, 'Pending', 'the existing appointment is untouched');
  });

  it('a service with appointments keeps its name; one without can be renamed', async () => {
    const owner = t.createUser();
    t.createAppointment(owner, { daysAhead: 60, service: 'Bath' });
    const services = (await asAdmin('GET', '/admin/services')).body.services;
    const bath = services.find(row => row.name === 'Bath');
    const faceTrim = services.find(row => row.name === 'Face Trim');
    assert.equal(bath.has_appointments, true);
    const settings = service => ({ description: service.description, category: service.category, species: service.species, duration_minutes: service.duration_minutes, online_booking_enabled: service.online_booking_enabled, display_order: service.display_order, expected_version: service.version });

    const renamed = await asAdmin('PUT', `/admin/services/${bath.id}`, { ...settings(bath), name: 'Dog Bath' });
    assert.equal(renamed.status, 409);
    assert.equal(renamed.body.field, 'name');
    assert.equal(t.db.find('pethub_service_catalog', row => row.id === bath.id).name, 'Bath');

    if (!faceTrim.has_appointments) {
      const ok = await asAdmin('PUT', `/admin/services/${faceTrim.id}`, { ...settings(faceTrim), name: 'Face Trim (Grooming)' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    }
  });
});

describe('Appointment status follows the clinic clock', () => {
  it('a request whose start has passed cannot be approved; a future appointment cannot be completed', async () => {
    const owner = t.createUser();
    const pastRequest = t.createAppointment(owner, { daysAhead: -1 });
    const futureApproved = t.createAppointment(owner, { daysAhead: 70, status: 'Approved' });

    const approve = await asAdmin('PUT', '/admin/dashboard/appointment-status', { id: pastRequest.id, status: 'Approved' });
    assert.equal(approve.status, 409);
    assert.equal(approve.body.code, 'APPOINTMENT_START_PASSED');
    const complete = await asAdmin('PUT', '/admin/dashboard/appointment-status', { id: futureApproved.id, status: 'Completed' });
    assert.equal(complete.status, 409);
    assert.equal(complete.body.code, 'APPOINTMENT_NOT_STARTED');
    await t.settleEmails();
    assert.equal(t.emailsTo(owner.email).length, 0, 'no approval email for a time already gone');
    assert.equal(t.appointmentRow(pastRequest.id).status, 'Pending');
    assert.equal(t.appointmentRow(futureApproved.id).status, 'Approved');

    // The past request can still be cancelled, and the visit that took place can be completed
    assert.equal((await asAdmin('PUT', '/admin/dashboard/appointment-status', { id: pastRequest.id, status: 'Cancelled' })).status, 200);
    t.appointmentRow(futureApproved.id).appointment_date = t.manilaDate(-1);
    assert.equal((await asAdmin('PUT', '/admin/dashboard/appointment-status', { id: futureApproved.id, status: 'Completed' })).status, 200);
    await t.settleEmails();
  });
});

describe('Activity log', () => {
  it('a booking is recorded for the owner, and the admin view can leave out sign-ins', async () => {
    const owner = t.createUser();
    t.db.seed('activity_logs', { user_id: owner.id, action: 'user_logged_in', details: 'User logged in successfully' });
    t.db.seed('activity_logs', { user_id: owner.id, action: 'user_logged_out', details: 'User logged out' });
    const bath = t.db.find('pethub_service_catalog', row => row.name === 'Bath');
    const pet = t.createPet(owner, 'Kiko');
    const booked = await t.api('POST', '/appointments/create', { token: owner.token, body: {
      user_id: owner.id, pet_id: pet.id, service_id: bath.id, appointment_date: t.manilaDate(80), appointment_time: '15:00'
    } });
    assert.equal(booked.status, 201, JSON.stringify(booked.body));
    assert.ok(t.db.table('activity_logs').some(row => row.user_id === owner.id && row.action === 'appointment_booked' && row.details === 'Requested Bath for Kiko'));

    const all = (await asAdmin('GET', '/admin/system-logs?limit=200')).body.logs;
    const filtered = (await asAdmin('GET', '/admin/system-logs?limit=200&exclude=sign_ins')).body.logs;
    assert.ok(all.some(log => log.action === 'user_logged_out'));
    assert.ok(filtered.every(log => !['user_logged_in', 'user_logged_out'].includes(log.action)));
    assert.ok(filtered.some(log => log.action === 'appointment_booked'));
    assert.ok(all.some(log => log.action === 'user_logged_out' && /signed out/.test(log.display_text)));
  });
});

describe('Overview booking summary', () => {
  it('reports how many services customers can book online right now', async () => {
    const overview = await asAdmin('GET', '/admin/dashboard/overview');
    const services = t.db.table('pethub_service_catalog');
    assert.equal(overview.body.summary.totalServices, services.length);
    assert.equal(overview.body.summary.bookableServices, services.filter(row => row.online_booking_enabled && row.duration_minutes && row.species.length).length);
  });
});
