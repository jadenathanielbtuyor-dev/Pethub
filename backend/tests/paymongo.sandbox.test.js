// Opt-in checks against the real PayMongo TEST API. Skipped by default (npm test never calls PayMongo).
// Nothing is paid: sessions are created, read and expired, so no money moves.
//   PAYMONGO_SANDBOX_TESTS=1   v1 create -> retrieve -> expire, plus Idempotency-Key replay
//   PAYMONGO_SANDBOX_TESTS=v2  also checks whether the v1 retrieve/expire endpoints accept a v2-created session
// The key comes from PAYMONGO_SECRET_KEY (environment, or backend/.env when opted in) and must be sk_test_...
// Only ids and status codes are printed; keys and checkout URLs never are.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const mode = String(process.env.PAYMONGO_SANDBOX_TESTS || '').trim().toLowerCase();
const runV1 = ['1', 'true', 'v2'].includes(mode);
const runV2 = mode === 'v2';

function loadTestSecretKey() {
  if (!process.env.PAYMONGO_SECRET_KEY) {
    require('dotenv').config({ quiet: true, path: path.join(__dirname, '..', '.env') });
  }
  const paymongo = require('../utils/paymongoClient');
  const secretKey = String(process.env.PAYMONGO_SECRET_KEY || '').trim();
  assert.equal(paymongo.getSecretKeyMode(secretKey), 'test', 'PAYMONGO_SECRET_KEY must be a PayMongo test key (sk_test_...)');
  return secretKey;
}

function sessionInput(reference) {
  return {
    amountCentavos: 10000,
    currency: 'PHP',
    lineItemName: 'Appointment deposit',
    description: 'PetHub sandbox check (not a real booking)',
    paymentMethodTypes: ['gcash', 'qrph', 'card'],
    referenceNumber: reference,
    metadata: { pethub_payment_id: reference, pethub_appointment_id: 'sandbox-check' },
    successUrl: 'https://example.com/pethub-sandbox-return',
    cancelUrl: 'https://example.com/pethub-sandbox-cancel',
    idempotencyKey: reference
  };
}

test('PayMongo sandbox: v1 checkout create, idempotent replay, retrieve and expire', {
  skip: runV1 ? false : 'set PAYMONGO_SANDBOX_TESTS=1 to run against the PayMongo test API'
}, async () => {
  const paymongo = require('../utils/paymongoClient');
  const client = paymongo.createPayMongoClient({ secretKey: loadTestSecretKey() });
  const reference = `pethub-sandbox-${Date.now()}`;

  let created;
  try {
    created = await client.createCheckoutSession(sessionInput(reference));
  } catch (error) {
    // A 400 here usually means a payment method in CHECKOUT_PAYMENT_METHOD_TYPES is not enabled on the account
    throw new Error(`create failed: HTTP ${error.status} ${error.code}`);
  }

  const replayed = await client.createCheckoutSession(sessionInput(reference));
  assert.equal(replayed.id, created.id, 'the same Idempotency-Key should return the same session');

  const retrieved = await client.retrieveCheckoutSession(created.id);
  assert.equal(retrieved.id, created.id);
  assert.equal(retrieved.status, 'active');
  assert.equal(retrieved.livemode, false);
  assert.equal(retrieved.referenceNumber, reference);
  assert.equal(retrieved.metadata.pethub_payment_id, reference);

  const expired = await client.expireCheckoutSession(created.id);
  assert.equal(expired.status, 'expired');

  await assert.rejects(client.expireCheckoutSession(created.id), error => error.status === 400);
  console.log(`sandbox v1: ${created.id} created, replayed, retrieved (active), expired; second expire -> 400`);
});

test('PayMongo sandbox: do v1 retrieve/expire accept a v2-created session?', {
  skip: runV2 ? false : 'set PAYMONGO_SANDBOX_TESTS=v2 to check v2 compatibility'
}, async () => {
  const secretKey = loadTestSecretKey();
  const authorization = `Basic ${Buffer.from(`${secretKey}:`).toString('base64')}`;
  const reference = `pethub-sandbox-v2-${Date.now()}`;
  const input = sessionInput(reference);

  const createResponse = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: authorization, 'Idempotency-Key': reference },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: [{ name: input.lineItemName, amount: input.amountCentavos, currency: input.currency, quantity: 1 }],
          payment_method_types: input.paymentMethodTypes,
          description: input.description,
          reference_number: reference,
          metadata: input.metadata,
          success_url: input.successUrl,
          cancel_url: input.cancelUrl
        }
      }
    })
  });
  assert.equal(createResponse.status, 200, `v2 create returned HTTP ${createResponse.status}`);
  const sessionId = (await createResponse.json())?.data?.id;
  assert.match(String(sessionId), /^cs_/);

  const retrieveResponse = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${sessionId}`, {
    headers: { Accept: 'application/json', Authorization: authorization }
  });
  const expireResponse = await fetch(`https://api.paymongo.com/v1/checkout_sessions/${sessionId}/expire`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: authorization }
  });

  console.log(`sandbox v2: ${sessionId} -> v1 retrieve HTTP ${retrieveResponse.status}, v1 expire HTTP ${expireResponse.status}`);
  assert.equal(retrieveResponse.status, 200, 'v1 retrieve did not accept a v2 session; keep CHECKOUT_SESSION_CREATE_PATH on v1');
  assert.equal(expireResponse.status, 200, 'v1 expire did not accept a v2 session; keep CHECKOUT_SESSION_CREATE_PATH on v1');
});
