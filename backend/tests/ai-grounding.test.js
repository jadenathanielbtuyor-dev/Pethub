// MOCKED: Gemini requests are intercepted in-process; no external AI service is called.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers/harness');

let t;
let calls;

before(async () => {
  t = await startTestApp({ env: { GEMINI_API_KEY: 'test-gemini-key' } });
  calls = [];
});

after(async () => {
  await t.close();
});

function respondWith(payload, status = 200) {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init, body: JSON.parse(init.body || '{}') });
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

function providerReply(text, groundingMetadata) {
  return { candidates: [{
    content: { parts: [{ text }] },
    ...(groundingMetadata ? { groundingMetadata } : {})
  }] };
}

describe('PetHub AI safety and grounding', () => {
  it('handles human animal bites in English and Tagalog before FAQ or Gemini', async () => {
    const english = await t.api('POST', '/ai/chat', { body: { message: 'My dog bit me. What should I do?' } });
    assert.equal(english.status, 200);
    assert.equal(english.body.isEmergency, true);
    assert.match(english.body.reply, /running water with soap for at least 15 minutes/i);
    assert.match(english.body.reply, /medical assessment now/i);
    assert.equal(english.body.sources[0].url, 'https://www.who.int/news-room/fact-sheets/detail/rabies');

    const tagalog = await t.api('POST', '/ai/chat', { body: { message: 'Nakagat ako ng aso, ano ang gagawin?' } });
    assert.equal(tagalog.status, 200);
    assert.match(tagalog.body.reply, /hugasan at banlawan/i);
    assert.match(tagalog.body.reply, /animal-bite center/i);
    assert.equal(calls.length, 0);
  });

  it('answers pet emergencies without Gemini, in Tagalog when described in Tagalog', async () => {
    const tagalog = await t.api('POST', '/ai/chat', { body: { message: 'Nalason yata ang aso ko, ano gagawin ko?' } });
    assert.equal(tagalog.status, 200);
    assert.equal(tagalog.body.isEmergency, true);
    assert.match(tagalog.body.reply, /Kailangan agad ng beterinaryo/);
    assert.match(tagalog.body.reply, /emergency vet clinic/);

    const english = await t.api('POST', '/ai/chat', { body: { message: 'Can rat poison kill my cat?' } });
    assert.equal(english.status, 200);
    assert.equal(english.body.isEmergency, true);
    assert.match(english.body.reply, /immediate veterinary care/);
    assert.equal(calls.length, 0, 'emergency guidance never depends on the AI provider');
  });

  it('sends bounded history and uses the API key header and Search grounding only for a current health question', async () => {
    respondWith(providerReply('Ask a veterinarian for an exam.', {
      groundingChunks: [
        { web: { uri: 'https://www.who.int/news-room/fact-sheets/detail/rabies', title: 'WHO rabies fact sheet' } },
        { web: { uri: 'http://unsafe.example.test/source', title: 'Unsafe' } }
      ]
    }));
    const response = await t.api('POST', '/ai/chat', { body: {
      message: 'What is the current rabies vaccine schedule for my dog?',
      currentPage: 'Pet Owner Dashboard - Appointments',
      history: [
        { role: 'assistant', text: 'Welcome' },
        { role: 'user', text: 'My dog was bitten yesterday.' },
        { role: 'model', text: 'Wash the wound and seek care.' }
      ]
    } });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.grounded, true);
    assert.deepEqual(response.body.sources, [{
      title: 'WHO rabies fact sheet',
      url: 'https://www.who.int/news-room/fact-sheets/detail/rabies'
    }]);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.match(call.url, /models\/gemini-2\.5-flash:generateContent$/);
    assert.doesNotMatch(call.url, /key=/i);
    assert.equal(new Headers(call.init.headers).get('x-goog-api-key'), 'test-gemini-key');
    // google_search is the documented grounding tool for current Gemini models (google_search_retrieval is for older ones)
    assert.deepEqual(call.body.tools, [{ google_search: {} }]);
    assert.equal(call.body.contents.at(-1).parts[0].text, 'What is the current rabies vaccine schedule for my dog?');
    assert.deepEqual(call.body.contents.slice(0, 2).map(entry => entry.role), ['user', 'model']);
    assert.match(call.body.system_instruction.parts[0].text, /Tagalog and Taglish/);
  });

  it('sends no Search tool for a routine question and strips unsafe source URLs', async () => {
    respondWith(providerReply('Brush gently and stop if your pet is distressed.', {
      groundingChunks: [
        { web: { uri: 'javascript:alert(1)', title: 'Unsafe' } },
        { web: { uri: 'https://example.test/grooming', title: 'Safe source' } }
      ]
    }));
    const response = await t.api('POST', '/ai/chat', { body: { message: 'What grooming tools should I use for my dog?' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.grounded, true);
    assert.equal(calls.at(-1).body.tools, undefined);
    assert.deepEqual(response.body.sources, [{ title: 'Safe source', url: 'https://example.test/grooming' }]);
  });

  it('times out safely and does not log provider response bodies or the API key', async () => {
    const ai = require('../services/aiService');
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
    await assert.rejects(
      ai.callGeminiAPI('How often should I brush my dog?', undefined, [], { timeoutMs: 20 }),
      error => error.code === 'AI_TIMEOUT'
    );

    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'provider body must not be logged' } }), { status: 401 });
    const failed = await t.api('POST', '/ai/chat', { body: { message: 'How often should I brush my dog?' } });
    assert.equal(failed.status, 503);
    const logs = t.logs.join('\n');
    assert.doesNotMatch(logs, /provider body must not be logged|test-gemini-key/);
  });
});
