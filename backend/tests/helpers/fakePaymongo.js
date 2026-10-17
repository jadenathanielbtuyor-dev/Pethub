// Fake PayMongo API for automated tests (no real charges, no network). It follows the documented behaviour the
// payment code relies on: v1 checkout create/retrieve/expire, expire refusing a paid or ongoing payment (400),
// Idempotency-Key replay, and the webhook event envelope { data: { id, type: 'event', attributes: { type, livemode, data } } }.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function unixSeconds(date = new Date()) {
  return Math.floor(date.getTime() / 1000);
}

class FakePayMongo {
  constructor({ secretKey }) {
    this.expectedAuthorization = `Basic ${Buffer.from(`${secretKey}:`, 'utf8').toString('base64')}`;
    this.sessions = new Map();
    this.idempotentResponses = new Map();
    this.requests = [];
    this.failures = [];
    this.counter = 0;
  }

  nextId(prefix) {
    this.counter += 1;
    return `${prefix}fake${String(this.counter).padStart(6, '0')}`;
  }

  // Makes the next matching request fail once: { method, path: RegExp, status, code } or { network: true }
  failNext(failure) {
    this.failures.push(failure);
  }

  count(method, pathPattern) {
    return this.requests.filter(request => request.method === method && pathPattern.test(request.path)).length;
  }

  async handle(url, init = {}) {
    const { pathname } = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const body = init.body ? JSON.parse(init.body) : null;

    this.requests.push({
      method,
      path: pathname,
      idempotencyKey: headers.get('Idempotency-Key'),
      authorized: headers.get('Authorization') === this.expectedAuthorization,
      body
    });

    if (headers.get('Authorization') !== this.expectedAuthorization) {
      return jsonResponse(401, { errors: [{ code: 'unauthorized', detail: 'Invalid API key.' }] });
    }

    const failureIndex = this.failures.findIndex(failure => (!failure.method || failure.method === method) && (!failure.path || failure.path.test(pathname)));
    if (failureIndex >= 0) {
      const [failure] = this.failures.splice(failureIndex, 1);
      if (failure.network) throw new TypeError('fetch failed');
      return jsonResponse(failure.status, { errors: [{ code: failure.code || 'internal_server_error', detail: 'Simulated failure' }] });
    }

    if (method === 'POST' && pathname === '/v1/checkout_sessions') {
      return this.createSession(body, headers.get('Idempotency-Key'));
    }

    const match = pathname.match(/^\/v1\/checkout_sessions\/([^/]+)(\/expire)?$/);
    if (match) {
      const session = this.sessions.get(decodeURIComponent(match[1]));
      if (!session) return jsonResponse(404, { errors: [{ code: 'not_found', detail: 'Checkout session not found' }] });
      if (method === 'GET' && !match[2]) return jsonResponse(200, { data: this.sessionResource(session), has_more: false });
      if (method === 'POST' && match[2]) return this.expireSession(session);
    }

    return jsonResponse(404, { errors: [{ code: 'not_found', detail: 'Route not found' }] });
  }

  createSession(body, idempotencyKey) {
    if (idempotencyKey && this.idempotentResponses.has(idempotencyKey)) {
      return jsonResponse(200, this.idempotentResponses.get(idempotencyKey));
    }

    const attributes = body?.data?.attributes || {};
    const id = this.nextId('cs_');
    const session = {
      id,
      status: 'active',
      livemode: false,
      ongoingPayment: false,
      attributes,
      payments: [],
      createdAt: unixSeconds()
    };
    this.sessions.set(id, session);

    const response = {
      data: {
        id,
        type: 'checkout_session',
        attributes: {
          checkout_url: `https://checkout.paymongo.com/${id}#cGtfdGVzdF9mYWtl`,
          created_at: session.createdAt,
          updated_at: session.createdAt,
          livemode: false
        }
      },
      has_more: false
    };
    if (idempotencyKey) this.idempotentResponses.set(idempotencyKey, response);
    return jsonResponse(200, response);
  }

  expireSession(session) {
    const hasPaidPayment = session.payments.some(payment => payment.attributes.status === 'paid');
    if (session.status === 'expired' || hasPaidPayment || session.ongoingPayment) {
      return jsonResponse(400, { errors: [{ code: 'invalid_request_body', detail: 'Checkout session cannot be expired.' }] });
    }
    session.status = 'expired';
    return jsonResponse(200, { data: this.sessionResource(session), has_more: false });
  }

  sessionResource(session) {
    return {
      id: session.id,
      type: 'checkout_session',
      attributes: {
        checkout_url: `https://checkout.paymongo.com/${session.id}#cGtfdGVzdF9mYWtl`,
        status: session.status,
        livemode: session.livemode,
        reference_number: session.attributes.reference_number,
        metadata: session.attributes.metadata,
        line_items: session.attributes.line_items,
        payment_method_types: session.attributes.payment_method_types,
        success_url: session.attributes.success_url,
        cancel_url: session.attributes.cancel_url,
        payments: session.payments,
        created_at: session.createdAt,
        updated_at: unixSeconds()
      }
    };
  }

  // Simulates the customer completing payment on the hosted checkout page
  pay(sessionId, { paidAt = new Date(), amount, currency = 'PHP', methodType = 'gcash' } = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown fake session ${sessionId}`);
    const lineItemTotal = (session.attributes.line_items || []).reduce((total, item) => total + item.amount * (item.quantity || 1), 0);
    const payment = {
      id: this.nextId('pay_'),
      type: 'payment',
      attributes: {
        amount: amount ?? lineItemTotal,
        currency,
        status: 'paid',
        paid_at: unixSeconds(paidAt),
        livemode: false,
        source: { id: this.nextId('src_'), type: methodType },
        refunds: [],
        metadata: null
      }
    };
    session.payments.push(payment);
    session.ongoingPayment = false;
    return payment;
  }

  setOngoingPayment(sessionId, ongoing = true) {
    this.sessions.get(sessionId).ongoingPayment = ongoing;
  }

  event(type, resource, { livemode = false, createdAt = new Date() } = {}) {
    return {
      data: {
        id: this.nextId('evt_'),
        type: 'event',
        attributes: {
          type,
          livemode,
          data: resource,
          previous_data: {},
          created_at: unixSeconds(createdAt),
          updated_at: unixSeconds(createdAt)
        }
      }
    };
  }

  checkoutPaidEvent(sessionId, { mutate, livemode = false } = {}) {
    const resource = JSON.parse(JSON.stringify(this.sessionResource(this.sessions.get(sessionId))));
    if (mutate) mutate(resource);
    return this.event('checkout_session.payment.paid', resource, { livemode });
  }

  refundSucceededEvent(paymentId, { amount = 10000, createdAt = new Date() } = {}) {
    return this.event('refund.succeeded', {
      id: this.nextId('ref_'),
      type: 'refund',
      attributes: {
        amount,
        currency: 'PHP',
        livemode: false,
        payment_id: paymentId,
        reason: 'others',
        status: 'succeeded',
        created_at: unixSeconds(createdAt)
      }
    }, { createdAt });
  }
}

module.exports = {
  FakePayMongo
};
