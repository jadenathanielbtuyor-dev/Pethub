const crypto = require('crypto');
const { PAYMONGO_REQUEST_TIMEOUT_MS } = require('../constants/payments');

// Minimal PayMongo REST client (built-in fetch and crypto, no SDK). Everything that depends on PayMongo's
// request and response format lives in this file; the rest of PetHub works with the plain objects it returns.
//
// API version: checkout sessions use the v1 endpoints. PayMongo documents create, retrieve and expire together for v1.
// It recommends /v2 for creating sessions, but documents no retrieve or expire endpoint for v2 sessions, so switching
// CHECKOUT_SESSION_CREATE_PATH to '/v2/checkout_sessions' needs a sandbox check first (tests/paymongo.sandbox.test.js).
const PAYMONGO_API_BASE_URL = 'https://api.paymongo.com';
const CHECKOUT_SESSION_CREATE_PATH = '/v1/checkout_sessions';
const CHECKOUT_SESSIONS_PATH = '/v1/checkout_sessions';

const CHECKOUT_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9]+$/;
const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]+$/;
const HEX_SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;
const METHOD_TYPE_PATTERN = /^[a-z0-9_]{1,32}$/;

class PayMongoError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'PayMongoError';
    this.status = status; // HTTP status from PayMongo, or 0 when no response arrived
    this.code = code; // PayMongo error code, or network_error / timeout / invalid_response
  }
}

function getSecretKeyMode(secretKey) {
  const key = String(secretKey || '');
  if (!key) return 'missing';
  if (key.startsWith('sk_test_')) return 'test';
  if (key.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

function isCheckoutSessionId(value) {
  return typeof value === 'string' && CHECKOUT_SESSION_ID_PATTERN.test(value);
}

function isPaymentId(value) {
  return typeof value === 'string' && PAYMENT_ID_PATTERN.test(value);
}

function isPayMongoCheckoutUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && (url.hostname === 'paymongo.com' || url.hostname.endsWith('.paymongo.com'));
  } catch (error) {
    return false;
  }
}

// PayMongo timestamps are Unix seconds
function toIsoTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const date = new Date(number < 1e11 ? number * 1000 : number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getAttributes(resource) {
  return resource && typeof resource.attributes === 'object' && resource.attributes !== null ? resource.attributes : {};
}

function toStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => typeof entry === 'string'));
}

function readString(value) {
  return typeof value === 'string' ? value : '';
}

function readBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function readInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function normalizeRefund(resource) {
  if (!resource || typeof resource !== 'object') return null;
  // Refunds nested in a payment may come flat or as { id, attributes }
  const attributes = typeof resource.attributes === 'object' && resource.attributes !== null ? resource.attributes : resource;
  return {
    id: readString(resource.id),
    paymentId: readString(attributes.payment_id),
    status: readString(attributes.status),
    amount: readInteger(attributes.amount),
    currency: readString(attributes.currency),
    livemode: readBoolean(attributes.livemode)
  };
}

function normalizePayment(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const attributes = getAttributes(resource);
  const sourceType = attributes.source && typeof attributes.source === 'object' ? attributes.source.type : '';
  return {
    id: readString(resource.id),
    status: readString(attributes.status),
    amount: readInteger(attributes.amount),
    currency: readString(attributes.currency),
    livemode: readBoolean(attributes.livemode),
    paidAt: toIsoTimestamp(attributes.paid_at),
    methodType: typeof sourceType === 'string' && METHOD_TYPE_PATTERN.test(sourceType) ? sourceType : null,
    refunds: (Array.isArray(attributes.refunds) ? attributes.refunds : []).map(normalizeRefund).filter(Boolean)
  };
}

function normalizeCheckoutSession(resource) {
  if (!resource || typeof resource !== 'object' || !isCheckoutSessionId(resource.id)) return null;
  const attributes = getAttributes(resource);
  return {
    id: resource.id,
    status: readString(attributes.status),
    livemode: readBoolean(attributes.livemode),
    checkoutUrl: readString(attributes.checkout_url),
    referenceNumber: readString(attributes.reference_number),
    metadata: toStringMap(attributes.metadata),
    payments: (Array.isArray(attributes.payments) ? attributes.payments : []).map(normalizePayment).filter(Boolean)
  };
}

function parseSignatureHeader(header) {
  const parts = {};
  String(header || '').split(',').forEach(part => {
    const separator = part.indexOf('=');
    if (separator > 0) {
      parts[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  });

  if (!/^\d{1,15}$/.test(parts.t || '')) return null;
  return { timestamp: parts.t, testSignature: parts.te || '', liveSignature: parts.li || '' };
}

function computeWebhookSignature(webhookSecret, timestamp, rawBody) {
  return crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

// Checks the Paymongo-Signature header (t=...,te=...,li=...) against the exact raw request bytes:
// HMAC-SHA256 of "<t>.<raw body>" keyed with the webhook's secret. PetHub runs in test mode only,
// so the test-mode signature (te) is compared; live-mode events never verify here.
// Returns { valid, reason }; reason is a fixed code for the logs (never the header, body or secret):
// missing_secret | body_not_raw | empty_body | missing_header | malformed_header | no_test_signature | signature_mismatch
function checkWebhookSignature({ rawBody, signatureHeader, webhookSecret }) {
  if (!webhookSecret) return { valid: false, reason: 'missing_secret' };
  // A parsed body (JSON middleware ran first) no longer has the exact bytes PayMongo signed
  if (!Buffer.isBuffer(rawBody)) return { valid: false, reason: 'body_not_raw' };
  if (rawBody.length === 0) return { valid: false, reason: 'empty_body' };
  if (!String(signatureHeader || '').trim()) return { valid: false, reason: 'missing_header' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { valid: false, reason: 'malformed_header' };
  // Only a live signature (li) means a live-mode event or endpoint, which this test-mode version never accepts
  if (!HEX_SIGNATURE_PATTERN.test(parsed.testSignature)) return { valid: false, reason: 'no_test_signature' };

  const expected = Buffer.from(computeWebhookSignature(webhookSecret, parsed.timestamp, rawBody), 'hex');
  const received = Buffer.from(parsed.testSignature, 'hex');
  const valid = expected.length === received.length && crypto.timingSafeEqual(expected, received);
  // A mismatch means a different webhook secret than the endpoint's, or a body changed on the way
  return valid ? { valid: true, reason: '' } : { valid: false, reason: 'signature_mismatch' };
}

function verifyWebhookSignature(options) {
  return checkWebhookSignature(options).valid;
}

// Event envelope: { data: { id: 'evt_...', type: 'event', attributes: { type, livemode, data: <resource>, created_at } } }
function parseWebhookEvent(payload) {
  const event = payload && typeof payload === 'object' ? payload.data : null;
  const attributes = getAttributes(event);
  if (typeof attributes.type !== 'string' || !attributes.data || typeof attributes.data !== 'object') {
    return null;
  }

  return {
    id: readString(event.id),
    type: attributes.type,
    livemode: readBoolean(attributes.livemode),
    createdAt: toIsoTimestamp(attributes.created_at),
    resource: attributes.data
  };
}

function createPayMongoClient({ secretKey, fetchImpl, baseUrl = PAYMONGO_API_BASE_URL, timeoutMs = PAYMONGO_REQUEST_TIMEOUT_MS } = {}) {
  if (getSecretKeyMode(secretKey) !== 'test') {
    throw new PayMongoError('A PayMongo test secret key (sk_test_...) is required', { code: 'invalid_secret_key' });
  }

  const authorization = `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`;
  const send = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, { body, idempotencyKey } = {}) {
    const headers = { Accept: 'application/json', Authorization: authorization };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    let response;
    try {
      response = await send(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new PayMongoError(timedOut ? 'PayMongo request timed out' : 'PayMongo request could not be sent', {
        code: timedOut ? 'timeout' : 'network_error'
      });
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }

    if (!response.ok) {
      // Only the status and PayMongo's error code are kept; error details are never passed on to clients or logs
      const firstError = Array.isArray(payload?.errors) ? payload.errors[0] : null;
      const code = typeof firstError?.code === 'string' ? firstError.code.slice(0, 64) : '';
      throw new PayMongoError(`PayMongo responded with HTTP ${response.status}`, { status: response.status, code });
    }

    if (!payload || typeof payload.data !== 'object' || payload.data === null) {
      throw new PayMongoError('PayMongo returned an unexpected response', { status: response.status, code: 'invalid_response' });
    }

    return payload.data;
  }

  function toSessionPath(sessionId, suffix = '') {
    if (!isCheckoutSessionId(sessionId)) {
      throw new PayMongoError('Invalid checkout session id', { code: 'invalid_session_id' });
    }
    return `${CHECKOUT_SESSIONS_PATH}/${encodeURIComponent(sessionId)}${suffix}`;
  }

  function requireSession(resource) {
    const session = normalizeCheckoutSession(resource);
    if (!session) {
      throw new PayMongoError('PayMongo returned an unexpected checkout session', { code: 'invalid_response' });
    }
    return session;
  }

  return {
    async createCheckoutSession({
      amountCentavos,
      currency,
      lineItemName,
      description,
      paymentMethodTypes,
      referenceNumber,
      metadata,
      successUrl,
      cancelUrl,
      idempotencyKey
    }) {
      const resource = await request('POST', CHECKOUT_SESSION_CREATE_PATH, {
        idempotencyKey,
        body: {
          data: {
            attributes: {
              line_items: [{ name: lineItemName, amount: amountCentavos, currency, quantity: 1 }],
              payment_method_types: [...paymentMethodTypes],
              description,
              reference_number: referenceNumber,
              metadata,
              success_url: successUrl,
              cancel_url: cancelUrl,
              send_email_receipt: false,
              show_description: true,
              show_line_items: true
            }
          }
        }
      });

      const session = requireSession(resource);
      if (!isPayMongoCheckoutUrl(session.checkoutUrl)) {
        throw new PayMongoError('PayMongo returned an unexpected checkout URL', { code: 'invalid_response' });
      }
      return session;
    },

    async retrieveCheckoutSession(sessionId) {
      return requireSession(await request('GET', toSessionPath(sessionId)));
    },

    async expireCheckoutSession(sessionId) {
      return requireSession(await request('POST', toSessionPath(sessionId, '/expire')));
    }
  };
}

module.exports = {
  PAYMONGO_API_BASE_URL,
  CHECKOUT_SESSION_CREATE_PATH,
  PayMongoError,
  getSecretKeyMode,
  isCheckoutSessionId,
  isPaymentId,
  isPayMongoCheckoutUrl,
  normalizeCheckoutSession,
  normalizePayment,
  normalizeRefund,
  parseSignatureHeader,
  computeWebhookSignature,
  checkWebhookSignature,
  verifyWebhookSignature,
  parseWebhookEvent,
  createPayMongoClient
};
