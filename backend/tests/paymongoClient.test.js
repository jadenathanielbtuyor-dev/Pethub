// Unit tests for utils/paymongoClient.js (no network: fetch is replaced per test)
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const paymongo = require('../utils/paymongoClient');

const WEBHOOK_SECRET = 'whsk_unit_test_secret';
const TEST_KEY = 'sk_test_unit_test_key';

function sign(rawBody, { secret = WEBHOOK_SECRET, timestamp = '1700000000' } = {}) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('verifyWebhookSignature', () => {
  const rawText = '{"data":{"id":"evt_1","type":"event","attributes":{"type":"checkout_session.payment.paid"}}}';
  const rawBody = Buffer.from(rawText, 'utf8');

  it('accepts the test-mode signature computed over "<t>.<raw body>"', () => {
    const header = `t=1700000000,te=${sign(rawText)},li=`;
    assert.equal(paymongo.verifyWebhookSignature({ rawBody, signatureHeader: header, webhookSecret: WEBHOOK_SECRET }), true);
  });

  it('rejects a wrong secret, a changed body, a changed timestamp, and a live-only signature', () => {
    const good = sign(rawText);
    const cases = [
      { header: `t=1700000000,te=${sign(rawText, { secret: 'whsk_other' })},li=` },
      { header: `t=1700000000,te=${good},li=`, body: Buffer.from(rawText.replace('evt_1', 'evt_2')) },
      { header: `t=1700000001,te=${good},li=` },
      { header: `t=1700000000,te=,li=${good}` }
    ];
    cases.forEach(({ header, body = rawBody }) => {
      assert.equal(paymongo.verifyWebhookSignature({ rawBody: body, signatureHeader: header, webhookSecret: WEBHOOK_SECRET }), false);
    });
  });

  it('rejects missing or malformed headers, a missing secret, and a parsed (non-Buffer) body', () => {
    const header = `t=1700000000,te=${sign(rawText)},li=`;
    assert.equal(paymongo.verifyWebhookSignature({ rawBody, signatureHeader: undefined, webhookSecret: WEBHOOK_SECRET }), false);
    assert.equal(paymongo.verifyWebhookSignature({ rawBody, signatureHeader: 'te=abc', webhookSecret: WEBHOOK_SECRET }), false);
    assert.equal(paymongo.verifyWebhookSignature({ rawBody, signatureHeader: 't=1700000000,te=zz', webhookSecret: WEBHOOK_SECRET }), false);
    assert.equal(paymongo.verifyWebhookSignature({ rawBody, signatureHeader: header, webhookSecret: '' }), false);
    assert.equal(paymongo.verifyWebhookSignature({ rawBody: JSON.parse(rawText), signatureHeader: header, webhookSecret: WEBHOOK_SECRET }), false);
  });
});

describe('keys and ids', () => {
  it('classifies secret keys without exposing them', () => {
    assert.equal(paymongo.getSecretKeyMode(''), 'missing');
    assert.equal(paymongo.getSecretKeyMode('sk_test_abc'), 'test');
    assert.equal(paymongo.getSecretKeyMode('sk_live_abc'), 'live');
    assert.equal(paymongo.getSecretKeyMode('pk_test_abc'), 'unknown');
  });

  it('refuses to build a client with a live or missing key', () => {
    assert.throws(() => paymongo.createPayMongoClient({ secretKey: 'sk_live_abc' }), error => {
      assert.equal(error.code, 'invalid_secret_key');
      assert.ok(!error.message.includes('sk_live_abc'));
      return true;
    });
    assert.throws(() => paymongo.createPayMongoClient({ secretKey: '' }), { code: 'invalid_secret_key' });
  });

  it('only accepts PayMongo-shaped ids and https checkout URLs', () => {
    assert.equal(paymongo.isCheckoutSessionId('cs_abc123'), true);
    assert.equal(paymongo.isCheckoutSessionId('cs_abc/../../v1/refunds'), false);
    assert.equal(paymongo.isPaymentId('pay_abc123'), true);
    assert.equal(paymongo.isPaymentId('ref_abc123'), false);
    assert.equal(paymongo.isPayMongoCheckoutUrl('https://checkout.paymongo.com/cs_1#pk'), true);
    assert.equal(paymongo.isPayMongoCheckoutUrl('http://checkout.paymongo.com/cs_1'), false);
    assert.equal(paymongo.isPayMongoCheckoutUrl('https://paymongo.com.evil.test/cs_1'), false);
  });
});

describe('createPayMongoClient requests', () => {
  it('creates a checkout session with Basic auth, an Idempotency-Key and the given amount', async () => {
    const calls = [];
    const client = paymongo.createPayMongoClient({
      secretKey: TEST_KEY,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, { data: { id: 'cs_new1', type: 'checkout_session', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_new1#pk', livemode: false } } });
      }
    });

    const session = await client.createCheckoutSession({
      amountCentavos: 10000,
      currency: 'PHP',
      lineItemName: 'Appointment deposit',
      description: 'PetHub appointment deposit',
      paymentMethodTypes: ['gcash', 'qrph', 'card'],
      referenceNumber: 'row-1',
      metadata: { pethub_payment_id: 'row-1', pethub_appointment_id: 'apt-1' },
      successUrl: 'https://frontend.test/return',
      cancelUrl: 'https://frontend.test/cancel',
      idempotencyKey: 'row-1'
    });

    assert.equal(session.id, 'cs_new1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.paymongo.com/v1/checkout_sessions');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${TEST_KEY}:`).toString('base64')}`);
    assert.equal(calls[0].init.headers['Idempotency-Key'], 'row-1');
    const attributes = JSON.parse(calls[0].init.body).data.attributes;
    assert.equal(attributes.line_items[0].amount, 10000);
    assert.equal(attributes.line_items[0].currency, 'PHP');
    assert.equal(attributes.send_email_receipt, false);
  });

  it('turns PayMongo errors into status + code only, and maps network failures and timeouts', async () => {
    const failing = paymongo.createPayMongoClient({
      secretKey: TEST_KEY,
      fetchImpl: async () => jsonResponse(400, { errors: [{ code: 'parameter_invalid', detail: 'Sensitive provider detail' }] })
    });
    await assert.rejects(failing.retrieveCheckoutSession('cs_1'), error => {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'parameter_invalid');
      assert.ok(!error.message.includes('Sensitive provider detail'));
      return true;
    });

    const offline = paymongo.createPayMongoClient({ secretKey: TEST_KEY, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    await assert.rejects(offline.expireCheckoutSession('cs_1'), { code: 'network_error', status: 0 });

    const slow = paymongo.createPayMongoClient({
      secretKey: TEST_KEY,
      fetchImpl: async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }
    });
    await assert.rejects(slow.retrieveCheckoutSession('cs_1'), { code: 'timeout' });
  });

  it('never builds a request path from an unexpected session id', async () => {
    let called = false;
    const client = paymongo.createPayMongoClient({ secretKey: TEST_KEY, fetchImpl: async () => { called = true; return jsonResponse(200, {}); } });
    await assert.rejects(client.retrieveCheckoutSession('../refunds'), { code: 'invalid_session_id' });
    await assert.rejects(client.expireCheckoutSession('cs_1/../../x'), { code: 'invalid_session_id' });
    assert.equal(called, false);
  });

  it('reads the payment method capabilities array with a GET, keeping only method identifiers', async () => {
    const calls = [];
    const client = paymongo.createPayMongoClient({
      secretKey: TEST_KEY,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, ['qrph', 'card', 'qrph', 42, 'Bad Value', null]);
      }
    });

    assert.deepEqual(await client.listPaymentMethodCapabilities(), ['qrph', 'card']);
    assert.equal(calls[0].url, 'https://api.paymongo.com/v1/merchants/capabilities/payment_methods');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.body, undefined);

    const wrongShape = paymongo.createPayMongoClient({ secretKey: TEST_KEY, fetchImpl: async () => jsonResponse(200, { data: [] }) });
    await assert.rejects(wrongShape.listPaymentMethodCapabilities(), { code: 'invalid_response' });
  });
});

describe('event and resource parsing', () => {
  it('reads the documented event envelope and checkout session fields', () => {
    const event = paymongo.parseWebhookEvent({
      data: {
        id: 'evt_1',
        type: 'event',
        attributes: {
          type: 'checkout_session.payment.paid',
          livemode: false,
          created_at: 1700000000,
          data: {
            id: 'cs_1',
            type: 'checkout_session',
            attributes: {
              status: 'active',
              livemode: false,
              reference_number: 'row-1',
              metadata: { pethub_payment_id: 'row-1', ignored_number: 5 },
              payments: [{ id: 'pay_1', type: 'payment', attributes: { status: 'paid', amount: 10000, currency: 'PHP', paid_at: 1700000100, source: { type: 'gcash' } } }]
            }
          }
        }
      }
    });

    assert.equal(event.type, 'checkout_session.payment.paid');
    assert.equal(event.livemode, false);
    assert.equal(event.createdAt, new Date(1700000000 * 1000).toISOString());

    const session = paymongo.normalizeCheckoutSession(event.resource);
    assert.deepEqual(session.metadata, { pethub_payment_id: 'row-1' });
    assert.equal(session.payments[0].id, 'pay_1');
    assert.equal(session.payments[0].methodType, 'gcash');
    assert.equal(session.payments[0].paidAt, new Date(1700000100 * 1000).toISOString());
  });

  it('returns null for envelopes that are not events', () => {
    assert.equal(paymongo.parseWebhookEvent({ not: 'an event' }), null);
    assert.equal(paymongo.parseWebhookEvent(null), null);
    assert.equal(paymongo.normalizeCheckoutSession({ id: 'pay_1' }), null);
  });
});
