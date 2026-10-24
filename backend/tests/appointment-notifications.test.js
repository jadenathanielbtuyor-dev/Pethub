// Appointment approved / cancelled emails (services/appointmentNotificationsService.js), sent for every appointment
// from the admin status endpoint. They go out in the background through Brevo (faked here), use no payment wording,
// are recorded in email_logs, and a failed email never undoes the status change.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const PAYMENT_WORDING = /deposit|payment|paid|refund|checkout|paymongo|₱/i;
const APPOINTMENTS_LINK = 'https://pethub-frontend.test/pages/user/appointments.html';

let t;
let admin;
let day = 200;
const nextDay = () => {
  day += 1;
  return day;
};

before(async () => {
  t = await startTestApp();
  admin = t.createUser({ role: 'admin', name: 'Clinic Admin' });
});

after(async () => {
  await t.close();
});

function setStatusVia(endpoint, appointmentId, status, actor = admin) {
  return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${actor.id}`, { token: actor.token, body: { id: appointmentId, status } });
}

function assertNoPaymentWording(email) {
  assert.doesNotMatch(email.subject, PAYMENT_WORDING);
  assert.doesNotMatch(email.text, PAYMENT_WORDING);
  assert.doesNotMatch(email.html, PAYMENT_WORDING);
}

describe('Approval email', () => {
  for (const endpoint of ['admin']) {
    it(`${endpoint} endpoint: approving emails the customer once, with the appointment details and no payment wording`, async () => {
      const user = t.createUser({ name: 'Ana Reyes' });
      const pet = t.createPet(user, 'Bantay');
      const appointment = t.createAppointment(user, { pet, daysAhead: nextDay(), time: '09:30:00', service: 'Vaccination', duration: 30 });

      const response = await setStatusVia(endpoint, appointment.id, 'Approved');
      assert.equal(response.status, 200);
      await t.settleEmails();

      const sent = t.emailsTo(user.email);
      assert.equal(sent.length, 1);
      const [email] = sent;
      assert.equal(email.subject, 'PetHub — Appointment Approved');
      assert.match(email.text, /Hello Ana Reyes,/);
      assert.match(email.text, /The clinic approved your appointment\./);
      assert.match(email.text, /Pet: Bantay/);
      assert.match(email.text, /Service: Vaccination/);
      assert.match(email.text, /Time: 9:30 AM – 10:00 AM/);
      assert.match(email.text, /Appointment status: Approved/);
      assert.ok(email.text.includes(APPOINTMENTS_LINK), 'links to My Appointments');
      assertNoPaymentWording(email);

      // Approving again changes nothing and sends nothing more
      assert.equal((await setStatusVia(endpoint, appointment.id, 'Approved')).status, 200);
      await t.settleEmails();
      assert.equal(t.emailsTo(user.email).length, 1);
    });
  }
});

describe('Cancellation email', () => {
  it('cancelling a Pending request or an Approved appointment emails a cancellation, not a rejection or refund notice', async () => {
    const user = t.createUser({ name: 'Ben Cruz' });
    const pet = t.createPet(user);
    const request = t.createAppointment(user, { pet, daysAhead: nextDay() });
    const booking = t.createAppointment(user, { pet, daysAhead: nextDay(), status: 'Approved' });

    assert.equal((await setStatusVia('admin', request.id, 'Cancelled')).status, 200);
    assert.equal((await setStatusVia('admin', booking.id, 'Cancelled')).status, 200);
    await t.settleEmails();

    const [requestEmail, bookingEmail] = t.emailsTo(user.email);
    assert.equal(t.emailsTo(user.email).length, 2);
    for (const email of [requestEmail, bookingEmail]) {
      assert.equal(email.subject, 'PetHub — Appointment Cancelled');
      assert.match(email.text, /Appointment status: Cancelled/);
      assert.doesNotMatch(email.text, /declined|reject/i);
      assertNoPaymentWording(email);
    }
    assert.match(requestEmail.text, /The clinic cancelled your appointment request below\./);
    assert.match(bookingEmail.text, /The clinic cancelled your appointment below\./);
  });
});

describe('When no email is sent', () => {
  it('completing an appointment sends nothing', async () => {
    const user = t.createUser();
    // A visit that has taken place (an appointment is completed only after its start time)
    const appointment = t.createAppointment(user, { daysAhead: -1, status: 'Approved' });
    assert.equal((await setStatusVia('admin', appointment.id, 'Completed')).status, 200);
    await t.settleEmails();
    assert.equal(t.emailsTo(user.email).length, 0);
  });

  it('a refused approval (taken slot, invalid change or non-admin) sends nothing', async () => {
    const user = t.createUser();
    const daysAhead = nextDay();
    const first = t.createAppointment(user, { daysAhead, time: '10:00:00' });
    const overlapping = t.createAppointment(user, { daysAhead, time: '10:15:00' });
    const completed = t.createAppointment(user, { daysAhead: nextDay(), status: 'Completed' });

    assert.equal((await setStatusVia('admin', first.id, 'Approved')).status, 200);
    await t.settleEmails();
    const before = t.emailsTo(user.email).length;

    assert.equal((await setStatusVia('admin', overlapping.id, 'Approved')).status, 409);
    assert.equal((await setStatusVia('admin', completed.id, 'Cancelled')).status, 400);
    assert.equal((await setStatusVia('admin', overlapping.id, 'Cancelled', user)).status, 403);
    await t.settleEmails();
    assert.equal(t.emailsTo(user.email).length, before);
  });
});

describe('Email failures and content safety', () => {
  it('a failed or unreachable email never undoes the status change, and the failure is logged', async () => {
    const user = t.createUser();
    const approved = t.createAppointment(user, { daysAhead: nextDay() });
    const cancelled = t.createAppointment(user, { daysAhead: nextDay() });

    t.failNextEmail({ status: 500 });
    const approveResponse = await setStatusVia('admin', approved.id, 'Approved');
    t.failNextEmail({ network: true });
    const cancelResponse = await setStatusVia('admin', cancelled.id, 'Cancelled');
    await t.settleEmails();

    assert.equal(approveResponse.status, 200);
    assert.equal(cancelResponse.status, 200);
    assert.equal(t.appointmentRow(approved.id).status, 'Approved');
    assert.equal(t.appointmentRow(cancelled.id).status, 'Cancelled');
    assert.equal(t.emailsTo(user.email).length, 0);
    const failures = t.logs.filter(line => line.includes('email.delivery_failed'));
    assert.equal(failures.length, 2);
    // Each failure is recorded for the clinic, which can resend it from Appointment Management
    const logged = t.db.table('email_logs').filter(row => [approved.id, cancelled.id].includes(row.appointment_id));
    assert.deepEqual(logged.map(row => row.status).sort(), ['Failed', 'Failed']);
    assert.ok(logged.every(row => row.error_message && !row.error_message.includes(t.secrets.brevoApiKey)));
  });

  it('a customer without an email address is skipped and logged', async () => {
    const user = t.createUser();
    t.db.find('users', row => row.id === user.id).email = '';
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', appointment.id, 'Approved')).status, 200);
    await t.settleEmails();
    assert.ok(t.logs.some(line => line.includes('appointments.decision_email_skipped') && line.includes('no_customer_email')));
  });

  it('escapes customer-controlled text in the HTML email', async () => {
    const user = t.createUser({ name: '<b>Owner</b>' });
    const pet = t.createPet(user, '<script>alert(1)</script>');
    const appointment = t.createAppointment(user, { pet, daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', appointment.id, 'Approved')).status, 200);
    await t.settleEmails();

    const [email] = t.emailsTo(user.email);
    assert.ok(email.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(email.html.includes('&lt;b&gt;Owner&lt;/b&gt;'));
    assert.ok(!email.html.includes('<script>'));
  });

  it('leaves the My Appointments link out when FRONTEND_URL is missing or not https', async () => {
    const env = require(path.join(__dirname, '..', 'config', 'env.js'));
    const original = env.frontendUrl;
    try {
      for (const value of ['', 'http://pethub-frontend.test', 'not a url']) {
        env.frontendUrl = value;
        const user = t.createUser();
        const appointment = t.createAppointment(user, { daysAhead: nextDay() });
        assert.equal((await setStatusVia('admin', appointment.id, 'Approved')).status, 200);
        await t.settleEmails();
        const [email] = t.emailsTo(user.email);
        assert.match(email.text, /sign in to PetHub and open My Appointments\./, `FRONTEND_URL=${JSON.stringify(value)}`);
        assert.doesNotMatch(email.text, /https?:\/\//);
      }
    } finally {
      env.frontendUrl = original;
    }
  });

  it('never logs the Brevo key, customer email addresses or email contents', async () => {
    const user = t.createUser({ name: 'Private Person' });
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', appointment.id, 'Approved')).status, 200);
    await t.settleEmails();

    const logText = t.logs.join('\n');
    assert.ok(logText.includes('email.delivered'));
    assert.ok(!logText.includes(t.secrets.brevoApiKey));
    assert.ok(!logText.includes(user.email));
    assert.ok(!logText.includes('Private Person'));
  });
});
