// PAYMENTS_ENABLED is read strictly: only "true" turns deposits on. A value such as "yes" or "1" keeps them off
// (never on by accident) and is reported at startup, without the value, so a typo on Railway is noticed.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const ENV_PATH = path.join(__dirname, '..', 'config', 'env.js');
let t;

before(async () => {
  t = await startTestApp({ env: { PAYMENTS_ENABLED: 'yes' } });
});

after(async () => {
  await t.close();
});

// A fresh copy of config/env.js for one value (dotenv is already stubbed by the harness, so backend/.env is never read)
function parseWith(value) {
  const saved = process.env.PAYMENTS_ENABLED;
  try {
    if (value === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = value;
    delete require.cache[ENV_PATH];
    const { payments } = require(ENV_PATH);
    return { enabled: payments.enabled, setting: payments.enabledSetting };
  } finally {
    if (saved === undefined) delete process.env.PAYMENTS_ENABLED;
    else process.env.PAYMENTS_ENABLED = saved;
    delete require.cache[ENV_PATH];
  }
}

describe('PAYMENTS_ENABLED parsing', () => {
  it('only "true" (any case, spaces ignored) turns deposits on', () => {
    assert.deepEqual(parseWith('true'), { enabled: true, setting: 'true' });
    assert.deepEqual(parseWith(' TRUE '), { enabled: true, setting: 'true' });
    assert.deepEqual(parseWith('False'), { enabled: false, setting: 'false' });
    assert.deepEqual(parseWith(undefined), { enabled: false, setting: 'unset' });
    assert.deepEqual(parseWith(''), { enabled: false, setting: 'unset' });
    for (const value of ['1', 'yes', 'on', 'enabled', '"true"', 'truee']) {
      assert.deepEqual(parseWith(value), { enabled: false, setting: 'unrecognized' }, value);
    }
  });

  it('an unrecognised value keeps deposits off and is reported once at startup, without its value', async () => {
    const logs = t.logs.join('\n');
    assert.equal(t.logs.filter(line => line.includes('payments.flag_unrecognized')).length, 1);
    assert.ok(!/PAYMENTS_ENABLED[^\n]*\byes\b/.test(logs), 'the value itself is not logged');

    const user = t.createUser();
    const pet = t.createPet(user);
    const booked = await t.api('POST', '/appointments/create', {
      token: user.token,
      body: { user_id: user.id, pet_id: pet.id, pet_name: pet.name, service_type: 'Checkup', appointment_date: t.manilaDate(50), appointment_time: '09:00:00' }
    });
    assert.equal(booked.status, 201);
    assert.equal(booked.body.deposit, undefined);
    assert.equal(t.appointmentRow(booked.body.appointment.id).deposit_required, false);

    const list = await t.api('GET', `/appointments/userAppointments?user_id=${user.id}`, { token: user.token });
    assert.equal(list.body.deposit_policy, undefined);
    const checkout = await t.api('POST', '/payments/checkout', { token: user.token, body: { appointment_id: booked.body.appointment.id } });
    assert.equal(checkout.status, 503);
    assert.equal(t.paymongo.requests.length, 0);
  });
});
