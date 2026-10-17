// Deposit confirmation and appointment decision emails, against the real Express app with a fake Supabase,
// a fake PayMongo and a fake Brevo endpoint (MOCKED: no email is really sent, no network, no charges).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let slotCounter = 0;

function nextDay() {
  slotCounter += 1;
  return 10 + slotCounter;
}

async function checkout(user, appointmentId) {
  const response = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: appointmentId } });
  assert.ok([200, 201].includes(response.status), `checkout returned ${response.status}`);
  return response;
}

function pendingRow(appointmentId) {
  return t.paymentsFor(appointmentId).find(row => row.payment_status === 'Pending');
}

// Customer pays on the hosted page and PayMongo delivers the signed webhook
async function payAndNotify(appointmentId) {
  const row = pendingRow(appointmentId);
  const payment = t.paymongo.pay(row.provider_checkout_session_id);
  const event = t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id);
  const response = await t.sendWebhook(event);
  assert.equal(response.status, 200);
  return { row, payment, event };
}

async function setStatusVia(endpoint, admin, appointmentId, status) {
  if (endpoint === 'admin') {
    return t.api('PUT', `/admin/dashboard/appointment-status?user_id=${admin.id}`, { token: admin.token, body: { id: appointmentId, status } });
  }
  return t.api('PUT', '/appointments/updateStatus', { token: admin.token, body: { id: appointmentId, status, user_id: admin.id } });
}

function receiptsFor(user) {
  return t.emailsTo(user.email).filter(email => email.subject === 'PetHub — Appointment Deposit Payment Confirmed');
}

before(async () => {
  t = await startTestApp();
});

after(async () => {
  await t.close();
});

describe('Deposit payment confirmation email', () => {
  it('is sent once to the customer after a verified webhook, and duplicate deliveries send nothing more', async () => {
    const user = t.createUser({ name: 'Maria Santos' });
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), service: 'Vaccination', time: '14:30:00', duration: 30 });
    await checkout(user, appointment.id);
    assert.equal(t.emailsTo(user.email).length, 0, 'opening checkout sends nothing');

    const { row, payment, event } = await payAndNotify(appointment.id);
    await t.settleEmails();
    assert.equal(row.payment_status, 'Paid');
    assert.ok(row.receipt_email_sent_at, 'the email is recorded on the payment row');

    const [receipt, ...extra] = receiptsFor(user);
    assert.ok(receipt, 'a confirmation email was sent');
    assert.equal(extra.length, 0);
    assert.deepEqual(receipt.to, [user.email]);
    for (const expected of [
      'Hello Maria Santos',
      `Appointment ID: ${appointment.id}`,
      'Pet: Mochi',
      'Service: Vaccination',
      'Time: 2:30 PM – 3:00 PM',
      'Deposit paid: ₱100.00 PHP',
      'Payment status: Paid',
      `PayMongo payment reference: ${payment.id}`,
      'Your appointment is not confirmed yet',
      'does not approve the appointment',
      'sign in to PetHub and open My Appointments: https://pethub-frontend.test/pages/user/appointments.html'
    ]) {
      assert.ok(receipt.text.includes(expected), `email text includes "${expected}"`);
    }
    assert.ok(!/appointment (is|has been) (approved|confirmed)/i.test(receipt.text), 'never claims the appointment is approved');
    assert.match(receipt.html, /Appointment Deposit Payment Confirmed/);

    // PayMongo redelivers the same event, twice at once and once more later
    await Promise.all([t.sendWebhook(event), t.sendWebhook(event)]);
    await t.sendWebhook(event);
    await t.settleEmails();
    assert.equal(receiptsFor(user).length, 1);
    assert.equal(t.appointmentRow(appointment.id).status, 'Pending', 'payment alone never approves');
  });

  it('is sent once when the payment is confirmed by the status check before the webhook arrives', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = pendingRow(appointment.id);
    t.paymongo.pay(row.provider_checkout_session_id);

    const status = await t.api('GET', `/payments/appointment/${appointment.id}`, { token: user.token });
    assert.equal(status.body.deposit.status, 'paid');
    await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
    await t.settleEmails();
    assert.equal(receiptsFor(user).length, 1);
  });

  it('is never sent for a redirect, an unpaid session or an event that does not match', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = pendingRow(appointment.id);

    // Returning from the checkout page without paying
    await t.api('GET', `/payments/appointment/${appointment.id}`, { token: user.token });
    // A "paid" event whose amount was changed
    t.paymongo.pay(row.provider_checkout_session_id, { amount: 100 });
    await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id));
    await t.settleEmails();

    assert.equal(row.payment_status, 'Pending');
    assert.equal(receiptsFor(user).length, 0);
  });

  it('keeps the payment Paid when Brevo fails, and the expiry sweep sends the email later exactly once', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);

    t.failNextEmail({ status: 500 });
    const { row } = await payAndNotify(appointment.id);
    await t.settleEmails();
    assert.equal(row.payment_status, 'Paid', 'a failed email never undoes the payment');
    assert.equal(row.receipt_email_sent_at, null, 'the claim is released so the email can be retried');
    assert.equal(receiptsFor(user).length, 0);
    assert.ok(t.logs.some(line => line.includes('payments.receipt_email_failed')));

    t.failNextEmail({ network: true });
    await t.paymentsService.runExpirySweep();
    assert.equal(row.receipt_email_sent_at, null);
    assert.equal(receiptsFor(user).length, 0);

    const retried = await t.paymentsService.runExpirySweep();
    assert.ok(retried.receiptsSent >= 1);
    assert.equal(receiptsFor(user).length, 1);
    assert.ok(row.receipt_email_sent_at);

    await t.paymentsService.runExpirySweep();
    assert.equal(receiptsFor(user).length, 1, 'a sent email is never repeated');
    assert.equal(row.payment_status, 'Paid');
  });

  it('sends one email when the webhook path and the expiry sweep try to send it at the same time', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);

    // Hold the webhook path's claim (the first update that sets receipt_email_sent_at) until the sweep has sent the email
    let release;
    let claimHeld = false;
    const gate = new Promise(resolve => { release = resolve; });
    const holdFirstClaim = async (query, db) => {
      if (!Object.prototype.hasOwnProperty.call(query.payload || {}, 'receipt_email_sent_at')) {
        db.interceptNext({ table: 'payments', action: 'update' }, holdFirstClaim);
        return undefined;
      }
      claimHeld = true;
      await gate;
      return undefined;
    };
    t.db.interceptNext({ table: 'payments', action: 'update' }, holdFirstClaim);

    const { row } = await payAndNotify(appointment.id);
    while (!claimHeld) await new Promise(resolve => setImmediate(resolve));
    const sweep = await t.paymentsService.runExpirySweep();
    assert.ok(sweep.receiptsSent >= 1, 'the sweep sent the email first');
    release();
    await t.settleEmails();

    assert.equal(receiptsFor(user).length, 1);
    assert.equal(row.payment_status, 'Paid');
  });

  it('tells the customer a refund is due, not that the clinic will review, when an already-cancelled appointment is paid', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const row = pendingRow(appointment.id);

    // The clinic declines while the customer is still on the PayMongo page; PayMongo then confirms a payment anyway
    assert.equal((await setStatusVia('admin', admin, appointment.id, 'Cancelled')).status, 200);
    t.paymongo.pay(row.provider_checkout_session_id);
    assert.equal((await t.sendWebhook(t.paymongo.checkoutPaidEvent(row.provider_checkout_session_id))).status, 200);
    await t.settleEmails();

    assert.equal(row.payment_status, 'Paid', 'a late payment is still recorded');
    const [receipt] = receiptsFor(user);
    assert.ok(receipt);
    assert.match(receipt.text, /due for a refund/);
    assert.match(receipt.text, /does not mean a refund has been made/);
    assert.ok(!receipt.text.includes('waiting for the clinic to review'));
  });

  it('escapes customer-controlled text in the HTML email', async () => {
    const user = t.createUser({ name: '<b>Ana</b>' });
    const pet = t.createPet(user, '<img src=x onerror=alert(1)>');
    const appointment = t.createAppointment(user, { daysAhead: nextDay(), pet });
    await checkout(user, appointment.id);
    await payAndNotify(appointment.id);
    await t.settleEmails();

    const [receipt] = receiptsFor(user);
    assert.ok(receipt);
    assert.ok(!receipt.html.includes('<img src=x'));
    assert.ok(!receipt.html.includes('<b>Ana</b>'));
    assert.ok(receipt.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });
});

describe('Appointment decision emails', () => {
  for (const endpoint of ['admin', 'legacy']) {
    it(`${endpoint}: approving a paid appointment emails the approval once; a refused approval emails nothing`, async () => {
      const admin = t.createUser({ role: 'admin' });
      const user = t.createUser();
      const appointment = t.createAppointment(user, { daysAhead: nextDay() });

      const refused = await setStatusVia(endpoint, admin, appointment.id, 'Approved');
      assert.equal(refused.status, 409);
      await t.settleEmails();
      assert.equal(t.emailsTo(user.email).length, 0);

      await checkout(user, appointment.id);
      await payAndNotify(appointment.id);
      assert.equal((await setStatusVia(endpoint, admin, appointment.id, 'Approved')).status, 200);
      // Repeating the same change is answered from the stored status and sends nothing new
      assert.equal((await setStatusVia(endpoint, admin, appointment.id, 'Approved')).status, 200);
      await t.settleEmails();

      const approvals = t.emailsTo(user.email).filter(email => email.subject === 'PetHub — Appointment Approved');
      assert.equal(approvals.length, 1);
      assert.match(approvals[0].text, /The clinic approved your appointment/);
      assert.match(approvals[0].text, /Deposit: ₱100\.00 paid/);
      assert.equal(receiptsFor(user).length, 1);
    });
  }

  it('declining a paid request explains the refund without claiming it was made', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    await payAndNotify(appointment.id);

    const response = await setStatusVia('admin', admin, appointment.id, 'Cancelled');
    assert.equal(response.status, 200);
    assert.equal(response.body.refund_required, true);
    await t.settleEmails();

    const [declined, ...extra] = t.emailsTo(user.email).filter(email => email.subject === 'PetHub — Appointment Request Declined');
    assert.ok(declined);
    assert.equal(extra.length, 0);
    assert.match(declined.text, /Appointment status: Not approved/);
    assert.match(declined.text, /Deposit: ₱100\.00 paid — refund due/);
    assert.match(declined.text, /does not mean the refund has been completed/);
    // Apart from that disclaimer, nothing says a refund happened
    const withoutDisclaimer = declined.text.replace(/does not mean the refund has been completed/g, '');
    assert.ok(!/refund (has been|was) (made|completed|processed)|refunded/i.test(withoutDisclaimer.replace(/"Deposit refunded"/g, '')));
  });

  it('declining an unpaid request says no deposit was recorded; cancelling an approved booking uses the cancellation email', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const unpaid = t.createAppointment(user, { daysAhead: nextDay() });
    assert.equal((await setStatusVia('admin', admin, unpaid.id, 'Cancelled')).status, 200);

    const booked = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, booked.id);
    await payAndNotify(booked.id);
    assert.equal((await setStatusVia('legacy', admin, booked.id, 'Approved')).status, 200);
    assert.equal((await setStatusVia('legacy', admin, booked.id, 'Cancelled')).status, 200);
    await t.settleEmails();

    const subjects = t.emailsTo(user.email).map(email => email.subject);
    assert.equal(subjects.filter(subject => subject === 'PetHub — Appointment Request Declined').length, 1);
    assert.equal(subjects.filter(subject => subject === 'PetHub — Appointment Cancelled').length, 1);
    const declined = t.emailsTo(user.email).find(email => email.subject === 'PetHub — Appointment Request Declined');
    assert.match(declined.text, /No deposit payment was recorded/);
    const cancelled = t.emailsTo(user.email).find(email => email.subject === 'PetHub — Appointment Cancelled');
    assert.match(cancelled.text, /refund due/);
  });

  it('sends nothing for appointments booked before deposits (exempt), exactly as before', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const first = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });
    const second = t.createAppointment(user, { daysAhead: nextDay(), depositRequired: false });

    assert.equal((await setStatusVia('admin', admin, first.id, 'Approved')).status, 200);
    assert.equal((await setStatusVia('admin', admin, first.id, 'Completed')).status, 200);
    assert.equal((await setStatusVia('legacy', admin, second.id, 'Cancelled')).status, 200);
    await t.settleEmails();
    assert.equal(t.emailsTo(user.email).length, 0);
  });

  it('a failed decision email never undoes the status change', async () => {
    const admin = t.createUser({ role: 'admin' });
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    await payAndNotify(appointment.id);
    await t.settleEmails();

    t.failNextEmail({ status: 503 });
    const response = await setStatusVia('admin', admin, appointment.id, 'Approved');
    await t.settleEmails();
    assert.equal(response.status, 200);
    assert.equal(t.appointmentRow(appointment.id).status, 'Approved');
    assert.ok(t.logs.some(line => line.includes('email.brevo_non_success_status')));
  });
});

describe('Booking form deposit policy', () => {
  it('the user appointment list tells the form a ₱100 deposit is required before booking', async () => {
    const user = t.createUser();
    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.deposit_policy, { required: true, amount: 100, currency: 'PHP', checkout_available: true });
  });
});

describe('Documented refund events', () => {
  it('payment.refunded with a full succeeded refund marks the deposit Refunded; a pending refund update does not', async () => {
    const user = t.createUser();
    const appointment = t.createAppointment(user, { daysAhead: nextDay() });
    await checkout(user, appointment.id);
    const { row, payment } = await payAndNotify(appointment.id);

    const pendingUpdate = t.paymongo.paymentRefundedEvent(payment.id, { type: 'payment.refund.updated', refunds: [{ amount: 10000, status: 'pending' }] });
    assert.equal((await t.sendWebhook(pendingUpdate)).status, 200);
    assert.equal(row.payment_status, 'Paid', 'a refund is not reported before PayMongo confirms it succeeded');

    assert.equal((await t.sendWebhook(t.paymongo.paymentRefundedEvent(payment.id))).status, 200);
    assert.equal(row.payment_status, 'Refunded');
  });
});

describe('Email privacy', () => {
  it('never logs the Brevo key, customer email addresses or email contents', async () => {
    await t.settleEmails();
    assert.ok(t.emails.length > 0);
    const allLogs = t.logs.join('\n');
    assert.ok(!allLogs.includes(t.secrets.brevoApiKey));
    assert.ok(!/@example\.test/.test(allLogs), 'customer addresses are not logged');
    assert.ok(!allLogs.includes('Deposit Payment Confirmed'));
    assert.ok(!allLogs.includes('PayMongo payment reference'));
  });
});
