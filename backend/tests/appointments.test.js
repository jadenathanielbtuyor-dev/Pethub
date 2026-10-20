// Appointment booking and management after online payments were removed: booking needs no deposit, checkout, payment
// record or payment setting, and approving or cancelling never looks at payments. The server stays the source of truth
// for validation, ownership, schedule conflicts and repeated submissions. The removed /payments endpoints answer with
// the JSON API 404, and no part of the running app loads the payment modules or touches the legacy payments table.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const BACKEND = path.join(__dirname, '..');
const PAYMENT_SETTINGS = ['PAYMENTS_ENABLED', 'PAYMONGO_SECRET_KEY', 'PAYMONGO_WEBHOOK_SECRET', 'PAYMONGO_API_URL'];
const PAYMENT_FIELDS = ['deposit', 'deposit_policy', 'deposit_required', 'payment_status', 'refund_required', 'checkout_url', 'payment_id'];

let t;
let day = 100;
const nextDay = () => {
  day += 1;
  return day;
};

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

// The server checks "today" and "now" in its own local time
function localDate(daysFromToday = 0) {
  const date = new Date(Date.now() + daysFromToday * 24 * 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function bookingBody(user, pet, fields = {}) {
  return {
    user_id: user.id,
    pet_id: pet.id,
    pet_name: pet.name,
    service_type: 'Dog & Cat Full Check Up',
    appointment_date: t.manilaDate(nextDay()),
    appointment_time: '10:00:00',
    ...fields
  };
}

function book(user, body) {
  return t.api('POST', '/appointments/create', { token: user.token, body });
}

function setStatusVia(endpoint, admin, appointmentId, status) {
  if (endpoint === 'admin') {
    return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id: appointmentId, status } });
  }
  return t.api('PUT', '/appointments/updateStatus', { token: admin.token, body: { id: appointmentId, status, user_id: admin.id } });
}

function appointmentsOf(user) {
  return t.db.table('appointments').filter(row => row.user_id === user.id);
}

function paymentQueries() {
  return t.db.log.filter(entry => entry.table === 'payments');
}

function assertNoPaymentFields(object, label) {
  PAYMENT_FIELDS.forEach(field => assert.equal(Object.prototype.hasOwnProperty.call(object, field), false, `${label} has no ${field}`));
}

describe('Booking without payments', () => {
  it('books a valid appointment with no payment settings, and creates nothing but a Pending appointment', async () => {
    PAYMENT_SETTINGS.forEach(name => assert.equal(process.env[name], undefined, `${name} is not set`));
    const user = t.createUser();
    const pet = t.createPet(user);
    let insertPayload = null;
    t.db.interceptNext({ table: 'appointments', action: 'insert' }, query => { insertPayload = query.payload; });
    t.db.log.length = 0;

    const response = await book(user, bookingBody(user, pet));
    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);
    assert.equal(response.body.appointment.status, 'Pending');
    assert.equal(response.body.appointment.estimated_duration_minutes, 45);
    assertNoPaymentFields(response.body, 'the booking response');
    assertNoPaymentFields(response.body.appointment, 'the booked appointment');

    // Only appointment columns are written; the legacy payment columns keep their database defaults
    assert.deepEqual(Object.keys(insertPayload[0]).sort(), [
      'appointment_date', 'appointment_time', 'estimated_duration_minutes', 'pet_id', 'pet_name', 'service_type', 'status', 'user_id'
    ]);
    assert.equal(appointmentsOf(user).length, 1);
    assert.equal(paymentQueries().length, 0, 'the payments table is never queried');
    assert.equal(t.db.table('payments').length, 0, 'no payment record is created');
    assert.deepEqual(t.blockedRequests, [], 'nothing outside PetHub (such as PayMongo) is contacted');

    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.appointments.length, 1);
    assertNoPaymentFields(list.body, 'the user list response');
    assertNoPaymentFields(list.body.appointments[0], 'the listed appointment');
    assert.equal(paymentQueries().length, 0);
  });

  it('stores the duration of the chosen service, whatever the browser sends', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const response = await book(user, bookingBody(user, pet, { service_type: 'Full Grooming', estimated_duration_minutes: 5 }));
    assert.equal(response.status, 201);
    assert.equal(response.body.appointment.estimated_duration_minutes, 240);
    assert.equal(t.appointmentRow(response.body.appointment.id).estimated_duration_minutes, 240);
  });

  it('ignores payment and status fields sent by the browser', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const response = await book(user, bookingBody(user, pet, {
      amount: 1, payment_status: 'Paid', deposit_required: true, status: 'Approved', checkout_url: 'https://checkout.example.test'
    }));
    assert.equal(response.status, 201);
    assert.equal(response.body.appointment.status, 'Pending');
    const row = t.appointmentRow(response.body.appointment.id);
    assert.equal(row.status, 'Pending');
    assert.equal(row.payment_status, 'Pending', 'the legacy column keeps its database default');
    assert.equal(row.deposit_required, false, 'the legacy column keeps its database default');
  });

  it('rejects incomplete or invalid bookings, past dates and past times, and creates nothing', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const body = bookingBody(user, pet);

    assert.equal((await book(user, { ...body, service_type: '' })).status, 400);
    assert.equal((await book(user, { ...body, service_type: 'Massage' })).status, 400);
    assert.equal((await book(user, { ...body, pet_id: '' })).status, 400);
    assert.equal((await book(user, { ...body, appointment_date: '' })).status, 400);
    assert.equal((await book(user, { ...body, appointment_date: 'not-a-date' })).status, 400);
    assert.equal((await book(user, { ...body, appointment_time: '25:99' })).status, 400);

    const pastDate = await book(user, { ...body, appointment_date: localDate(-1) });
    assert.equal(pastDate.status, 400);
    assert.equal(pastDate.body.error, 'Appointment date cannot be in the past.');

    const now = new Date();
    if (now.getHours() > 0 || now.getMinutes() > 0) {
      const pastTime = await book(user, { ...body, appointment_date: localDate(0), appointment_time: '00:00:00' });
      assert.equal(pastTime.status, 400);
      assert.equal(pastTime.body.error, 'Appointment time must be later than the current time when booking for today.');
    }

    assert.equal(appointmentsOf(user).length, 0);
  });

  it('requires sign-in, a verified account and the customer\'s own pet', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const stranger = t.createUser();
    const strangersPet = t.createPet(stranger, 'Kuro');
    const body = bookingBody(user, pet);

    assert.equal((await t.api('POST', '/appointments/create', { body })).status, 401);
    assert.equal((await t.api('POST', '/appointments/create', { body, token: 'not-a-real-token' })).status, 401);
    assert.equal((await book(user, { ...body, user_id: stranger.id })).status, 403, 'cannot book as someone else');
    assert.equal((await book(user, { ...body, pet_id: strangersPet.id, pet_name: strangersPet.name })).status, 404, 'cannot book another customer\'s pet');

    const unverified = t.createUser({ verified: false });
    const unverifiedPet = t.createPet(unverified);
    assert.equal((await book(unverified, bookingBody(unverified, unverifiedPet))).status, 403);

    assert.equal(appointmentsOf(user).length, 0);
    assert.equal(appointmentsOf(stranger).length, 0);
    assert.equal(appointmentsOf(unverified).length, 0);
  });

  it('refuses a time that overlaps an approved appointment (using the service duration) and suggests the next free time', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const other = t.createUser();
    const date = t.manilaDate(nextDay());
    // Approved 14:00-14:45 holds the slot
    t.db.seed('appointments', {
      user_id: other.id, pet_id: t.createPet(other).id, pet_name: 'Kuro', service_type: 'Checkup', estimated_duration_minutes: 45,
      appointment_date: date, appointment_time: '14:00:00', status: 'Approved'
    });

    const overlapping = await book(user, bookingBody(user, pet, { appointment_date: date, appointment_time: '14:30:00' }));
    assert.equal(overlapping.status, 400);
    assert.equal(overlapping.body.error, 'Selected time is unavailable.');
    assert.equal(overlapping.body.suggested_time, '14:45');

    // Full Grooming takes 4 hours in these tests (test-only durations), so 11:00 runs into the 14:00 appointment
    const longService = await book(user, bookingBody(user, pet, { appointment_date: date, appointment_time: '11:00:00', service_type: 'Full Grooming' }));
    assert.equal(longService.status, 400);

    // 13:15 + 45 minutes ends exactly when the approved appointment starts
    const adjacent = await book(user, bookingBody(user, pet, { appointment_date: date, appointment_time: '13:15:00' }));
    assert.equal(adjacent.status, 201);
    assert.equal(appointmentsOf(user).length, 1);
  });

  it('a repeated submission returns the existing Pending appointment instead of a duplicate', async () => {
    const user = t.createUser();
    const pet = t.createPet(user);
    const body = bookingBody(user, pet);

    const first = await book(user, body);
    const again = await book(user, body);
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.body.already_booked, true);
    assert.equal(again.body.appointment.id, first.body.appointment.id);
    assert.equal(appointmentsOf(user).length, 1);

    // A different time, pet or service, or the same booking after the earlier copy was cancelled, is a new appointment
    const otherPet = t.createPet(user, 'Kuro');
    assert.equal((await book(user, { ...body, appointment_time: '15:00:00' })).status, 201);
    assert.equal((await book(user, { ...body, pet_id: otherPet.id, pet_name: otherPet.name })).status, 201);
    assert.equal((await book(user, { ...body, service_type: 'Bath' })).status, 201);
    t.appointmentRow(first.body.appointment.id).status = 'Cancelled';
    const rebooked = await book(user, body);
    assert.equal(rebooked.status, 201);
    assert.notEqual(rebooked.body.appointment.id, first.body.appointment.id);
    assert.equal(appointmentsOf(user).length, 5);
  });
});

describe('Appointment management without payment checks', () => {
  it('admins approve, complete and cancel on both status endpoints, including appointments with the legacy deposit flag', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const pet = t.createPet(user);
    const daysAhead = nextDay();
    // Booked while deposits were on (legacy flag) and never paid: no longer blocks approval
    const legacy = t.db.seed('appointments', {
      user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: 'Checkup', estimated_duration_minutes: 45,
      appointment_date: t.manilaDate(daysAhead), appointment_time: '09:00:00', status: 'Pending', deposit_required: true
    });
    const ordinary = t.createAppointment(user, { pet, daysAhead, time: '13:00:00' });
    t.db.log.length = 0;

    const approved = await setStatusVia('admin', admin, legacy.id, 'Approved');
    assert.equal(approved.status, 200);
    assert.equal(approved.body.appointment.status, 'Approved');
    assert.equal(approved.body.appointment.handled_by, admin.id);
    assertNoPaymentFields(approved.body, 'the approval response');

    const completed = await setStatusVia('legacy', admin, legacy.id, 'Completed');
    assert.equal(completed.status, 200);
    assert.equal(t.appointmentRow(legacy.id).status, 'Completed');

    const approvedLegacyRoute = await setStatusVia('legacy', admin, ordinary.id, 'Approved');
    assert.equal(approvedLegacyRoute.status, 200);
    const cancelled = await setStatusVia('admin', admin, ordinary.id, 'Cancelled');
    assert.equal(cancelled.status, 200);
    assertNoPaymentFields(cancelled.body, 'the cancellation response');
    assert.equal(t.appointmentRow(ordinary.id).status, 'Cancelled');

    assert.equal(paymentQueries().length, 0, 'status changes never query the payments table');
    assert.deepEqual(t.blockedRequests, []);

    const adminList = await t.api('GET', `/admin/dashboard/appointments?user_id=${admin.id}`, { token: admin.token });
    assert.equal(adminList.status, 200);
    adminList.body.appointments.forEach(appointment => assertNoPaymentFields(appointment, 'an admin list appointment'));
    const overview = await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token: admin.token });
    assert.equal(overview.status, 200);
    overview.body.appointments.forEach(appointment => assertNoPaymentFields(appointment, 'an overview appointment'));
    assert.equal(paymentQueries().length, 0);
  });

  it('records each status change in the activity log', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', admin, appointment.id, 'Approved')).status, 200);
    assert.equal((await setStatusVia('legacy', admin, appointment.id, 'Cancelled')).status, 200);

    const logs = t.db.table('activity_logs').filter(row => String(row.target_id) === appointment.id);
    assert.deepEqual(logs.map(row => row.action), [
      'Updated appointment status from Pending to Approved',
      'Updated appointment status to Cancelled'
    ]);
  });

  it('keeps rejecting invalid status changes', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const pending = t.createAppointment(user, { daysAhead: nextDay() });
    const completed = t.createAppointment(user, { daysAhead: nextDay(), status: 'Completed' });
    const cancelled = t.createAppointment(user, { daysAhead: nextDay(), status: 'Cancelled' });

    assert.equal((await setStatusVia('admin', admin, pending.id, 'Completed')).status, 400, 'Pending cannot jump to Completed');
    assert.equal((await setStatusVia('legacy', admin, completed.id, 'Approved')).status, 400);
    assert.equal((await setStatusVia('admin', admin, cancelled.id, 'Approved')).status, 400);
    assert.equal((await setStatusVia('admin', admin, pending.id, 'Paid')).status, 400, 'not a status');
    assert.equal(t.appointmentRow(pending.id).status, 'Pending');
    assert.equal(t.appointmentRow(completed.id).status, 'Completed');
    assert.equal(t.appointmentRow(cancelled.id).status, 'Cancelled');
  });

  it('refuses non-admins on both status endpoints', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', user, appointment.id, 'Approved')).status, 403);
    assert.equal((await setStatusVia('legacy', user, appointment.id, 'Approved')).status, 403);
    assert.equal((await t.api('PUT', '/admin/dashboard/appointment-status', { body: { id: appointment.id, status: 'Approved' } })).status, 401);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('refuses approval into a taken slot with the schedule conflict only', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const daysAhead = nextDay();
    const first = t.createAppointment(user, { daysAhead, time: '09:00:00' });
    const overlapping = t.createAppointment(user, { daysAhead, time: '09:30:00' });

    assert.equal((await setStatusVia('admin', admin, first.id, 'Approved')).status, 200);
    for (const endpoint of ['admin', 'legacy']) {
      const conflict = await setStatusVia(endpoint, admin, overlapping.id, 'Approved');
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error, 'Selected time is unavailable.');
      assert.equal(conflict.body.suggested_time, '09:45');
      assertNoPaymentFields(conflict.body, 'the conflict response');
    }
    assert.equal(t.appointmentRow(overlapping.id).status, 'Pending');
  });

  it('reports a concurrent status change instead of overwriting it', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    for (const endpoint of ['admin', 'legacy']) {
      const appointment = t.createAppointment(user, { daysAhead: nextDay() });
      t.db.interceptNext({ table: 'appointments', action: 'update' }, (query, database) => {
        database.find('appointments', row => row.id === appointment.id).status = 'Cancelled';
      });
      const response = await setStatusVia(endpoint, admin, appointment.id, 'Approved');
      assert.equal(response.status, 409);
      assert.match(response.body.error, /changed by someone else/);
      assert.equal(t.appointmentRow(appointment.id).status, 'Cancelled');
    }
  });
});

describe('Removed payment functionality', () => {
  it('the payment endpoints are gone and answer with the JSON API 404, not the frontend page', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    t.db.log.length = 0;

    const requests = [
      ['POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointment.id } }],
      ['GET', `/payments/appointment/${appointment.id}`, { token: user.token }],
      ['POST', '/payments/webhook', { rawBody: JSON.stringify({ data: { attributes: { type: 'checkout_session.payment.paid' } } }), headers: { 'Content-Type': 'application/json', 'Paymongo-Signature': 't=1,te=abc,li=' } }],
      ['GET', '/payments', {}]
    ];
    for (const [method, url, options] of requests) {
      const response = await t.api(method, url, options);
      assert.equal(response.status, 404, `${method} ${url}`);
      assert.match(response.contentType, /application\/json/, `${method} ${url} answers JSON`);
      assert.equal(response.body.error, 'API endpoint not found');
    }
    assert.equal(paymentQueries().length, 0);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
  });

  it('the running app never loads a payment module', () => {
    const loaded = Object.keys(require.cache).filter(file => file.startsWith(BACKEND) && !file.includes(`${path.sep}node_modules${path.sep}`));
    assert.ok(loaded.some(file => file.endsWith(path.join('services', 'appointmentsService.js'))), 'the app modules were loaded');
    const paymentModules = loaded.filter(file => /payments?(Service|Controller|Repository|Validator|Webhook)?\.js$|paymongo|depositReceipt/i.test(path.basename(file)));
    assert.deepEqual(paymentModules, []);
  });

  it('no backend source outside the tests imports a payment module or reads a payment setting', () => {
    const files = [];
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'tests', 'logs'].includes(entry.name)) walk(full);
      } else if (entry.name.endsWith('.js')) {
        files.push(full);
      }
    });
    walk(BACKEND);

    // The payment-only files themselves are listed for deletion; everything else must not depend on them
    const paymentOnly = /^(paymentsService|paymentsController|payments|paymentsWebhook|paymentsRepository|paymentsValidator|paymongoClient|depositReceiptEmail)\.js$/;
    const active = files.filter(file => !paymentOnly.test(path.basename(file)) && !file.endsWith(path.join('constants', 'payments.js')));
    assert.ok(active.length > 20);
    for (const file of active) {
      const source = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /require\([^)]*(payments|paymongo|depositReceipt)/i, `${path.relative(BACKEND, file)} imports a payment module`);
      assert.doesNotMatch(source, /PAYMENTS_ENABLED|PAYMONGO_/, `${path.relative(BACKEND, file)} reads a payment setting`);
    }
  });

  it('configuration has no payment settings but keeps FRONTEND_URL', () => {
    const env = require(path.join(BACKEND, 'config', 'env.js'));
    assert.equal(env.payments, undefined);
    assert.equal(env.frontendUrl, 'https://pethub-frontend.test');
    assert.ok(env.cors.allowedOrigins.includes('https://pethub-frontend.test'), 'FRONTEND_URL is still allowed by CORS');
  });
});
