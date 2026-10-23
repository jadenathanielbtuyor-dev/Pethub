// The browser's API wrapper (frontend/js/core/api.js) stops waiting after 30 seconds, so a page never stays "Loading"
// forever, and says whether a change might still have been saved. Run in a node:vm sandbox with a fake window: the
// fetch below never answers on its own, and AbortSignal.timeout is replaced so the test can fire the timeout at once.
// No network request is made.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'core', 'api.js'), 'utf8');

function loadApi() {
  const timeouts = [];
  const sent = [];
  const fakeAbortSignal = {
    timeout(ms) {
      const controller = new AbortController();
      timeouts.push({ ms, fire: () => controller.abort(new DOMException('signal timed out', 'TimeoutError')) });
      return controller.signal;
    },
    any: signals => AbortSignal.any(signals)
  };
  // Answers only when told to; otherwise rejects with the signal's reason once it is aborted, like a browser fetch
  const fetch = (input, init = {}) => new Promise((resolve, reject) => {
    sent.push({ input, init, resolve });
    init.signal?.addEventListener('abort', () => reject(init.signal.reason));
  });
  const context = { fetch, Headers, Response, Error, DOMException, AbortSignal: fakeAbortSignal, sessionStorage: { getItem: () => 'test-token' } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(API_SOURCE, context);
  return { api: context, timeouts, sent };
}

describe('API request timeout (frontend/js/core/api.js, fake window)', () => {
  it('a read with no answer fails after 30 seconds with a clear message', async () => {
    const { api, timeouts } = loadApi();
    const request = api.fetch(`${api.API_BASE_URL}/pets/userPets`);
    assert.deepEqual(timeouts.map(entry => entry.ms), [30000]);
    timeouts[0].fire();
    await assert.rejects(request, { message: 'PetHub took too long to respond. Check your connection and try again.' });
  });

  it('a change that times out warns that it may still have been saved', async () => {
    const { api, timeouts } = loadApi();
    const request = api.fetch(`${api.API_BASE_URL}/appointments/create`, { method: 'POST', body: '{}' });
    timeouts[0].fire();
    await assert.rejects(request, { message: /Your change may still have been saved: refresh the page to check/ });
  });

  it('an answer in time is returned unchanged, with the session token attached', async () => {
    const { api, sent } = loadApi();
    const request = api.fetch(`${api.API_BASE_URL}/pets/userPets`);
    sent[0].resolve(new Response('{"success":true}', { status: 200 }));
    const response = await request;
    assert.equal(response.status, 200);
    assert.equal(sent[0].init.headers.get('Authorization'), 'Bearer test-token');
  });

  it("the caller's own cancellation still arrives as an AbortError, not as a timeout", async () => {
    const { api } = loadApi();
    const controller = new AbortController();
    const request = api.fetch(`${api.API_BASE_URL}/appointments/all?appointment_date=2026-11-02`, { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, { name: 'AbortError' });
  });

  it('requests to other sites (icons, fonts) get no timeout and no token', async () => {
    const { api, timeouts, sent } = loadApi();
    api.fetch('https://cdn.jsdelivr.net/npm/remixicon@4.3.0/fonts/remixicon.css');
    assert.equal(timeouts.length, 0);
    assert.equal(sent[0].init.signal, undefined);
    assert.equal(sent[0].init.headers, undefined);
  });
});
