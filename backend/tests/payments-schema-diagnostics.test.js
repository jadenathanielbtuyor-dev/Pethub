// The Railway "payments.schema_missing" report: PAYMENTS_ENABLED off, but a PayMongo test key and the service-role key
// are set, so the expiry sweep runs. The report must name the exact missing column and the Supabase project it came
// from, never a secret. The payment queries are also pinned to the columns verified in Supabase.
const fs = require('fs');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');
const { createPetHubDatabase } = require('./helpers/fakeSupabase');

const PROJECT_REF = 'abcdefghijklmnopqrst';

// Columns verified in Supabase on 2026-10-17 (the four PayMongo payments columns and deposit_required included)
const VERIFIED_COLUMNS = {
  payments: [
    'id', 'appointment_id', 'user_id', 'amount', 'payment_method', 'payment_reference', 'payment_status',
    'receipt_url', 'paid_at', 'created_at',
    'provider_checkout_session_id', 'provider_payment_id', 'expires_at', 'receipt_email_sent_at'
  ],
  appointments: [
    'id', 'user_id', 'pet_name', 'service_type', 'appointment_date', 'appointment_time', 'status', 'created_at',
    'handled_by', 'pet_id', 'estimated_duration_minutes', 'appointment_reference', 'notes', 'payment_status',
    'reminder_sent', 'confirmed_at', 'cancelled_at', 'deposit_required'
  ]
};

let t;

before(async () => {
  t = await startTestApp({
    env: { PAYMENTS_ENABLED: '', SUPABASE_URL: `https://${PROJECT_REF}.supabase.co` },
    migrated: false
  });
});

after(async () => {
  await t.close();
});

function schemaReports() {
  return t.logs.filter(line => line.includes('payments.schema_missing'));
}

describe('expiry sweep against a database without the PayMongo columns', () => {
  it('reports the exact missing column and the Supabase project, and the sweep ends cleanly', async () => {
    const result = await t.paymentsService.runExpirySweep();
    assert.deepEqual(result, { checked: 0, failed: 0, receiptsSent: 0 });

    const reports = schemaReports();
    assert.equal(reports.length, 1);
    assert.match(reports[0], /source: 'payments'/);
    assert.match(reports[0], /code: '42703'/);
    assert.match(reports[0], /missing_column: 'payments\.provider_checkout_session_id'/);
    assert.match(reports[0], /db_message: 'column payments\.provider_checkout_session_id does not exist'/);
    assert.match(reports[0], new RegExp(`supabase_project: '${PROJECT_REF}'`));
    assert.doesNotMatch(reports[0], /before turning PAYMENTS_ENABLED on/);
  });

  it('reports each source once per interval, so repeated sweeps do not flood the logs or hide another source', async () => {
    await t.paymentsService.runExpirySweep();
    await t.paymentsService.runExpirySweep();
    assert.equal(schemaReports().length, 1);

    t.paymentsService.reportMissingSchema('payments.receipt_email_sent_at', {
      code: 'PGRST204',
      message: "Could not find the 'receipt_email_sent_at' column of 'payments' in the schema cache",
      details: null,
      hint: null
    });
    const reports = schemaReports();
    assert.equal(reports.length, 2);
    assert.match(reports[1], /missing_column: 'payments\.receipt_email_sent_at'/);
    assert.doesNotMatch(reports[1], /db_details|db_hint/);
  });

  it('masks emails, keys, tokens and ids in database error text and cuts it short', () => {
    const email = 'owner.name@example.test';
    const paymongoKey = `sk_test_${'a1'.repeat(12)}`;
    const supabaseKey = `sb_secret_${'b2'.repeat(12)}`;
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXZhbHVl';
    const rowId = '0b3f6c1e-9a7d-4c2b-8e5f-1d2c3b4a5f6e';

    t.paymentsService.reportMissingSchema('test.masking', {
      code: '42703',
      message: `column payments.expires_at does not exist (${email}, ${paymongoKey}, ${rowId})`,
      details: `${jwt} ${'word '.repeat(200)}`,
      hint: `Perhaps you meant ${supabaseKey}\nor ${t.secrets.webhookSecret}`
    });

    const report = schemaReports().find(line => line.includes("source: 'test.masking'"));
    assert.ok(report);
    assert.match(report, /missing_column: 'payments\.expires_at'/);
    [email, paymongoKey, supabaseKey, jwt, rowId, t.secrets.webhookSecret].forEach(secret => {
      assert.ok(!report.includes(secret), 'a masked value reached the log');
    });
    assert.match(report, /\[email\]/);
    assert.match(report, /\[key\]/);
    assert.match(report, /\[token\]/);
    assert.ok(!report.includes('word '.repeat(41)), 'database error text is limited to 200 characters');
  });

  it('never logs keys, the token secret or the full Supabase URL', () => {
    const allLogs = t.logs.join('\n');
    [
      t.secrets.paymongoSecretKey,
      t.secrets.webhookSecret,
      t.secrets.brevoApiKey,
      t.secrets.authTokenSecret,
      process.env.SUPABASE_SERVICE_KEY,
      process.env.SUPABASE_ANON_KEY,
      `https://${PROJECT_REF}.supabase.co`
    ].forEach(secret => assert.ok(!allLogs.includes(secret), 'a secret or the Supabase URL reached the logs'));
  });
});

describe('payment queries match the verified Supabase schema', () => {
  it('selects, filters, orders and updates only verified payments columns', () => {
    const { PAYMENT_SELECT } = require('../repositories/paymentsRepository');
    const source = fs.readFileSync(path.join(__dirname, '..', 'repositories', 'paymentsRepository.js'), 'utf8');
    const columns = [
      ...PAYMENT_SELECT.split(',').map(column => column.trim()),
      ...[...source.matchAll(/\.(?:eq|neq|is|in|lt|lte|gt|gte|order)\('([a-z_]+)'/g)].map(match => match[1]),
      ...[...source.matchAll(/\.update\(\{ ([a-z_]+):/g)].map(match => match[1])
    ];
    assert.ok(columns.length > 11);
    assert.deepEqual(columns.filter(column => !VERIFIED_COLUMNS.payments.includes(column)), []);
  });

  it('runs the automated tests on the verified columns only (no column the real database lacks)', () => {
    const { definitions } = createPetHubDatabase({ migrated: true });
    assert.deepEqual([...definitions.payments.columns].sort(), [...VERIFIED_COLUMNS.payments].sort());
    assert.deepEqual(definitions.appointments.columns.filter(column => !VERIFIED_COLUMNS.appointments.includes(column)), []);
  });
});
