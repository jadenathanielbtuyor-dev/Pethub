// Owner cancellation is tested against the Express API and in-memory DB; no production rows/accounts/services are used.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
before(async () => { t = await startTestApp(); });
after(async () => { await t.close(); });

function clinicDateTime(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return {
    appointment_date: `${parts.year}-${parts.month}-${parts.day}`,
    appointment_time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

function seedAppointment(owner, startTimestamp, status = 'Pending') {
  return t.db.seed('appointments', {
    user_id: owner.id, pet_id: null, pet_name: 'Test Pet', service_type: 'Bath', estimated_duration_minutes: 60,
    ...clinicDateTime(startTimestamp), status
  });
}

async function withFixedNow(now, work) {
  const originalNow = Date.now;
  Date.now = () => now;
  try { return await work(); }
  finally { Date.now = originalNow; }
}

describe('Owner appointment cancellation', () => {
  it('allows cancellation at exactly two hours, stores the status, emails a truthful confirmation, and is idempotent', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser({ name: 'Mina Cruz' });
    const appointment = seedAppointment(owner, base + 2 * 60 * 60 * 1000);

    await withFixedNow(base, async () => {
      const cancelled = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      assert.equal(cancelled.body.appointment.status, 'Cancelled');
      assert.equal(t.appointmentRow(appointment.id).status, 'Cancelled');
      const logs = t.db.table('activity_logs').filter(row => row.action === 'appointment_cancelled');
      assert.equal(logs.length, 1);

      await t.settleEmails();
      const [email] = t.emailsTo(owner.email);
      assert.ok(email);
      assert.match(email.text, /You cancelled the appointment below in PetHub/);
      assert.doesNotMatch(email.text, /The clinic cancelled/);

      const again = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
      assert.equal(again.status, 200);
      assert.equal(again.body.already_cancelled, true);
      await t.settleEmails();
      assert.equal(t.emailsTo(owner.email).length, 1);
      assert.equal(t.db.table('activity_logs').filter(row => row.action === 'appointment_cancelled').length, 1);
    });
  });

  it('rejects cancellation inside two hours and after start, leaving the appointment unchanged', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser();
    const near = seedAppointment(owner, base + (2 * 60 - 1) * 60 * 1000, 'Approved');
    const started = seedAppointment(owner, base - 5 * 60 * 1000, 'Pending');

    await withFixedNow(base, async () => {
      const tooLate = await t.api('POST', `/appointments/cancel/${near.id}`, { token: owner.token });
      assert.equal(tooLate.status, 409);
      assert.equal(tooLate.body.code, 'APPOINTMENT_CANCELLATION_CUTOFF');
      assert.equal(t.appointmentRow(near.id).status, 'Approved');
      const afterStart = await t.api('POST', `/appointments/cancel/${started.id}`, { token: owner.token });
      assert.equal(afterStart.status, 409);
      assert.equal(afterStart.body.code, 'APPOINTMENT_CANCELLATION_CUTOFF');
      assert.equal(t.appointmentRow(started.id).status, 'Pending');
      await t.settleEmails();
      assert.equal(t.emailsTo(owner.email).length, 0);
    });
  });

  it('the database cutoff is rechecked if the request crosses the exact deadline before update', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser();
    const appointment = seedAppointment(owner, base + 2 * 60 * 60 * 1000);

    await withFixedNow(base, async () => {
      t.db.interceptNext({ table: 'appointments', action: 'rpc' }, () => {
        Date.now = () => base + 1000;
        return null;
      });
      const response = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'APPOINTMENT_CANCELLATION_CUTOFF');
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
      await t.settleEmails();
      assert.equal(t.emailsTo(owner.email).length, 0);
    });
  });

  it('fails closed when the reviewed database cancellation function is missing', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser();
    const appointment = seedAppointment(owner, base + 4 * 60 * 60 * 1000);

    await withFixedNow(base, async () => {
      t.db.interceptNext({ table: 'appointments', action: 'rpc' }, () => ({
        data: null,
        error: { code: 'PGRST202', message: 'function not found' }
      }));
      const response = await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token });
      assert.equal(response.status, 503);
      assert.equal(response.body.code, 'CANCELLATION_DATABASE_RULE_UNAVAILABLE');
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
    });
  });

  it('is owner-scoped, only permits Pending or Approved status, and requires authentication', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser();
    const other = t.createUser();
    const appointment = seedAppointment(owner, base + 4 * 60 * 60 * 1000);
    const completed = seedAppointment(owner, base + 4 * 60 * 60 * 1000, 'Completed');

    await withFixedNow(base, async () => {
      assert.equal((await t.api('POST', `/appointments/cancel/${appointment.id}`, { token: other.token })).status, 404);
      assert.equal(t.appointmentRow(appointment.id).status, 'Pending');
      assert.equal((await t.api('POST', `/appointments/cancel/${completed.id}`, { token: owner.token })).status, 409);
      assert.equal(t.appointmentRow(completed.id).status, 'Completed');
      assert.equal((await t.api('POST', `/appointments/cancel/${appointment.id}`)).status, 401);
    });
  });

  it('concurrent cancellation requests produce one state change and one email', async () => {
    const base = Math.floor(Date.now() / 1000) * 1000;
    const owner = t.createUser();
    const appointment = seedAppointment(owner, base + 5 * 60 * 60 * 1000);

    await withFixedNow(base, async () => {
      const results = await Promise.all([
        t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token }),
        t.api('POST', `/appointments/cancel/${appointment.id}`, { token: owner.token })
      ]);
      assert.deepEqual(results.map(result => result.status).sort(), [200, 200]);
      assert.equal(results.filter(result => result.body.already_cancelled).length, 1);
      await t.settleEmails();
      assert.equal(t.emailsTo(owner.email).length, 1);
      assert.equal(t.db.table('activity_logs').filter(row => row.action === 'appointment_cancelled' && row.user_id === owner.id).length, 1);
    });
  });
});
