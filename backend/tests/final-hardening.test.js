// Final hardening (2026-10-24): server-side sessions (logging out and resetting a password end a token before it
// expires), security headers on API replies, CORS limited to PetHub's own Vercel deployments, the Brevo sender variable
// names, the two migration files, and the frontend's Content-Security-Policy / Subresource Integrity configuration.
// MOCKED: the real Express app with the in-memory database and fake Brevo (helpers/harness.js); nothing leaves the machine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startTestApp } = require('./helpers/harness');

const BACKEND = path.join(__dirname, '..');
const FRONTEND = path.join(BACKEND, '..', 'frontend');
const MIGRATIONS = path.join(BACKEND, 'database', 'migrations');

// BREVO_SENDER_EMAIL is set next to the harness's SENDGRID_FROM_EMAIL, so the new name must win
let t;
before(async () => { t = await startTestApp({ env: { BREVO_SENDER_EMAIL: 'clinic-sender@pethub.test', BREVO_SENDER_NAME: 'PetHub Clinic' } }); });
after(async () => { await t.close(); });

async function waitFor(check, label, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const codeIn = email => email.text.match(/\b(\d{6})\b/)[1];
const status = (user, token) => t.api('GET', `/auth/user-status?user_id=${user.id}`, { token });
const sessionsOf = user => t.db.table('user_sessions').filter(row => row.user_id === user.id);
const openSessionsOf = user => sessionsOf(user).filter(row => row.revoked_at === null);

async function login(user, password) {
  const response = await t.api('POST', '/auth/login', { body: { email: user.email, password } });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

function payloadOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

// A token signed with the server's real secret (the old format without a session id, or a forged session id)
function signToken(payload) {
  const part = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${part}.${crypto.createHmac('sha256', t.secrets.authTokenSecret).update(part).digest('base64url')}`;
}

describe('Server-side sessions', () => {
  it('a login opens one session row that holds no token, and the token names that row', async () => {
    const user = t.createUser({ password: 'Session#Pass1' });
    const before = sessionsOf(user).length;
    const token = await login(user, 'Session#Pass1');

    const rows = sessionsOf(user);
    assert.equal(rows.length, before + 1);
    const session = rows.find(row => row.id === payloadOf(token).sid);
    assert.ok(session, 'the token carries the new session id');
    assert.deepEqual(Object.keys(session).sort(), ['created_at', 'expires_at', 'id', 'revoked_at', 'revoked_reason', 'user_id']);
    assert.ok(!JSON.stringify(t.db.table('user_sessions')).includes(token.split('.')[1]), 'no token signature is stored');
    const hours = (Date.parse(session.expires_at) - Date.now()) / 3600000;
    assert.ok(hours > 7.9 && hours <= 8, `expires in 8 hours (${hours})`);
    assert.equal(payloadOf(token).exp, Math.floor(Date.parse(session.expires_at) / 1000));
    assert.equal((await status(user, token)).status, 200);
  });

  it('logging out ends that token at once; another device stays signed in until it logs out', async () => {
    const user = t.createUser({ password: 'Session#Pass2' });
    const laptop = await login(user, 'Session#Pass2');
    const phone = await login(user, 'Session#Pass2');

    const out = await t.api('POST', '/auth/logout', { token: laptop, body: { userId: user.id } });
    assert.equal(out.status, 200);
    assert.equal((await status(user, laptop)).status, 401, 'the logged-out token is refused');
    assert.equal((await status(user, phone)).status, 200, 'the other session continues');
    assert.equal(sessionsOf(user).find(row => row.id === payloadOf(laptop).sid).revoked_reason, 'logout');
    assert.equal((await t.api('POST', '/auth/logout', { token: laptop, body: { userId: user.id } })).status, 401, 'cannot log out twice');
    assert.equal(t.db.table('activity_logs').filter(row => row.user_id === user.id && row.action === 'user_logged_out').length, 1);
  });

  it('a password reset ends every session of the account, and the new password signs in', async () => {
    const user = t.createUser({ password: 'Before#Reset9' });
    const first = await login(user, 'Before#Reset9');
    const second = await login(user, 'Before#Reset9');
    const other = t.createUser();

    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const resetEmail = await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email');
    const reset = await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: codeIn(resetEmail), password: 'After#Reset9' } });
    assert.equal(reset.status, 200);
    assert.match(reset.body.message, /signed-in sessions were signed out/);

    for (const token of [first, second, user.token]) assert.equal((await status(user, token)).status, 401);
    assert.equal(openSessionsOf(user).length, 0);
    assert.ok(sessionsOf(user).every(row => row.revoked_reason === 'password_reset'));
    assert.equal((await status(other, other.token)).status, 200, "another account's session is untouched");
    assert.equal((await status(user, await login(user, 'After#Reset9'))).status, 200);
  });

  it('a reset whose session clean-up fails still changes the password and says so only in the server log', async () => {
    const user = t.createUser({ password: 'Before#Reset8' });
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const resetEmail = await waitFor(() => t.emailsTo(user.email).find(email => /reset code/i.test(email.text)), 'the reset email');
    t.db.failNext({ table: 'user_sessions', action: 'update' }, { code: '08006', message: 'connection failure' });
    const reset = await t.api('POST', '/auth/reset-password', { body: { email: user.email, code: codeIn(resetEmail), password: 'After#Reset8' } });
    assert.equal(reset.status, 200);
    assert.match(t.logs.join('\n'), /Password reset session revoke error/);
    assert.equal((await t.api('POST', '/auth/login', { body: { email: user.email, password: 'After#Reset8' } })).status, 200);
  });

  it('refuses tokens without an open session: old format, unknown session, another account\'s session, expired or revoked row', async () => {
    const user = t.createUser();
    const other = t.createUser();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;

    assert.equal((await status(user, signToken({ sub: user.id, iat: now, exp }))).status, 401, 'token from before sessions existed');
    assert.equal((await status(user, signToken({ sub: user.id, sid: crypto.randomUUID(), iat: now, exp }))).status, 401, 'unknown session');
    assert.equal((await status(user, signToken({ sub: user.id, sid: 'not-a-uuid', iat: now, exp }))).status, 401, 'malformed session id');
    const othersSession = openSessionsOf(other)[0].id;
    assert.equal((await status(user, signToken({ sub: user.id, sid: othersSession, iat: now, exp }))).status, 401, "another account's session");

    const ownSession = openSessionsOf(user)[0];
    assert.equal((await status(user, user.token)).status, 200);
    ownSession.expires_at = new Date(Date.now() - 1000).toISOString();
    assert.equal((await status(user, user.token)).status, 401, 'the database expiry counts even if the token has not expired');

    const revoked = t.createUser();
    Object.assign(openSessionsOf(revoked)[0], { revoked_at: new Date().toISOString(), revoked_reason: 'logout' });
    assert.equal((await status(revoked, revoked.token)).status, 401);
  });

  it('admin routes refuse a logged-out admin token', async () => {
    const admin = t.createUser({ role: 'admin', password: 'Admin#Session1' });
    const token = await login(admin, 'Admin#Session1');
    assert.equal((await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token })).status, 200);
    assert.equal((await t.api('POST', '/auth/logout', { token, body: { userId: admin.id } })).status, 200);
    assert.equal((await t.api('GET', `/admin/dashboard/overview?user_id=${admin.id}`, { token })).status, 401);
    assert.equal((await t.api('PUT', `/admin/services/${t.db.table('pethub_service_catalog')[0].id}`, { token, body: {} })).status, 401);
  });

  it('when the session cannot be checked the request gets a 503 (not a sign-out) and works again afterwards', async () => {
    const user = t.createUser();
    t.db.failNext({ table: 'user_sessions', action: 'select' }, { code: '08006', message: 'connection failure' });
    const unavailable = await status(user, user.token);
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.body.error, /could not check your sign-in/);
    assert.equal((await status(user, user.token)).status, 200);
    assert.equal(openSessionsOf(user).length, 1);
  });

  it('a login whose session cannot be stored issues no token', async () => {
    const user = t.createUser({ password: 'NoSession#1' });
    t.db.failNext({ table: 'user_sessions', action: 'insert' }, { code: '08006', message: 'connection failure' });
    const response = await t.api('POST', '/auth/login', { body: { email: user.email, password: 'NoSession#1' } });
    assert.equal(response.status, 500);
    assert.equal(response.body.token, undefined);
    assert.match(response.body.error, /temporarily unavailable/);
  });

  it('a logout whose session cannot be ended says so, and the session is ended by the next try', async () => {
    const user = t.createUser({ password: 'Logout#Retry1' });
    const token = await login(user, 'Logout#Retry1');
    t.db.failNext({ table: 'user_sessions', action: 'update' }, { code: '08006', message: 'connection failure' });
    const failed = await t.api('POST', '/auth/logout', { token, body: { userId: user.id } });
    assert.equal(failed.status, 503);
    assert.equal((await status(user, token)).status, 200, 'honest: the session was not ended');
    assert.equal((await t.api('POST', '/auth/logout', { token, body: { userId: user.id } })).status, 200);
    assert.equal((await status(user, token)).status, 401);
  });

  it('the identity rules still apply on top of the session check', async () => {
    const user = t.createUser();
    const other = t.createUser();
    assert.equal((await t.api('GET', `/auth/user-status?user_id=${other.id}`, { token: user.token })).status, 403);
    assert.equal((await t.api('GET', '/pets/userPets', { token: user.token, headers: { 'X-User-ID': other.id } })).status, 403);
  });
});

describe('Security headers on API replies', () => {
  it('every API reply has nosniff, no framing, no referrer and a CSP that allows nothing', async () => {
    for (const reply of [
      await t.api('GET', '/appointments/services'),
      await t.api('GET', '/contact/clinic-info'),
      await t.api('GET', '/auth/no-such-route'),
      await t.api('POST', '/auth/login', { body: { email: 'nobody@example.test', password: 'x' } })
    ]) {
      assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(reply.headers.get('x-frame-options'), 'DENY');
      assert.equal(reply.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(reply.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      assert.equal(reply.headers.get('x-powered-by'), null);
    }
  });

  it('replies to signed-in requests are never cached; public ones keep normal caching', async () => {
    const user = t.createUser();
    assert.equal((await status(user, user.token)).headers.get('cache-control'), 'no-store');
    assert.equal((await t.api('GET', '/appointments/services')).headers.get('cache-control'), null);
  });

  it('HSTS is sent on HTTPS (Railway forwards the protocol) and not on plain local HTTP', async () => {
    const https = await t.api('GET', '/appointments/services', { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(https.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
    assert.equal((await t.api('GET', '/appointments/services')).headers.get('strict-transport-security'), null);
  });

  it('frontend pages this server serves locally get the basic headers but not the API policy', async () => {
    const home = await t.api('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.contentType, /text\/html/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('content-security-policy'), null);
  });
});

describe('CORS', () => {
  const preflight = origin => t.api('OPTIONS', '/auth/login', {
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  });

  it("allows PetHub's own Vercel deployments", async () => {
    for (const origin of [
      'https://pethub-zzz-duke1-s-projects.vercel.app',
      'https://pethub-git-main-zzz-duke1-s-projects.vercel.app',
      'https://pethub-a1b2c3d4e-zzz-duke1-s-projects.vercel.app'
    ]) {
      const response = await preflight(origin);
      assert.equal(response.status, 204, origin);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
  });

  it('refuses every other vercel.app site and look-alike addresses', async () => {
    for (const origin of [
      'https://evil.vercel.app',
      'https://pethub-zzz-duke1-s-projects.vercel.app.evil.example',
      'https://pethub-x-zzz-duke1-s-projects-vercel.app',
      'http://pethub-git-main-zzz-duke1-s-projects.vercel.app'
    ]) {
      const response = await preflight(origin);
      assert.equal(response.status, 403, origin);
      assert.equal(response.headers.get('access-control-allow-origin'), null, origin);
    }
  });
});

describe('Brevo sender settings', () => {
  it('emails are sent from BREVO_SENDER_EMAIL when it is set (SENDGRID_FROM_EMAIL is only the fallback)', async () => {
    const user = t.createUser();
    assert.equal((await t.api('POST', '/auth/forgot-password', { body: { email: user.email } })).status, 200);
    const email = await waitFor(() => t.emailsTo(user.email)[0], 'the reset email');
    assert.equal(email.from, 'clinic-sender@pethub.test');
  });
});

describe('Migration files', () => {
  const read = name => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
  const statements = sql => sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

  it('user_sessions: one transaction, additive, RLS on, closed to the public API roles, self-checking', () => {
    const sql = statements(read('2026-10-24_user_sessions.sql'));
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
    assert.match(sql, /CREATE TABLE public\.user_sessions/);
    assert.match(sql, /ALTER TABLE public\.user_sessions ENABLE ROW LEVEL SECURITY;/);
    assert.match(sql, /REVOKE ALL ON TABLE public\.user_sessions FROM PUBLIC, anon, authenticated;/);
    assert.match(sql, /\$preflight\$/);
    assert.match(sql, /\$postcheck\$/);
    assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
    assert.doesNotMatch(sql, /ALTER TABLE public\.(?!user_sessions)/);
  });

  it('legacy password removal: never reads the old value out, leaves only scrypt hashes or random markers', () => {
    const sql = statements(read('2026-10-24_remove_legacy_plaintext_password.sql'));
    assert.match(sql, /^BEGIN;/m);
    assert.match(sql, /^COMMIT;/m);
    assert.doesNotMatch(sql, /RETURNING|RAISE NOTICE|\bCOPY\b/i);
    // Outside string literals the password column appears only in NOT LIKE filters and in the one SET: never selected
    const code = sql.replace(/'(?:[^']|'')*'/g, "''");
    const uses = (code.match(/\bpassword\b/g) || []).length;
    const filters = (code.match(/\bpassword NOT LIKE ''/g) || []).length;
    assert.equal((code.match(/\bSET password = /g) || []).length, 1);
    assert.equal(uses, filters + 1);
    assert.match(sql, /SET password = 'reset-required\$' \|\| replace\(gen_random_uuid\(\)::text \|\| gen_random_uuid\(\)::text, '-', ''\)/);
    assert.match(sql, /WHERE password NOT LIKE 'scrypt\$%' AND password NOT LIKE 'reset-required\$%'/);
    assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE)\b/i);
  });
});

describe('Frontend Content-Security-Policy and Subresource Integrity (frontend/vercel.json)', () => {
  const config = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'vercel.json'), 'utf8'));
  const pageHeaders = config.headers.find(entry => entry.source === '/(.*)').headers;
  const csp = pageHeaders.find(header => header.key === 'Content-Security-Policy').value;
  const directive = name => (csp.split(';').map(part => part.trim()).find(part => part.startsWith(`${name} `)) || '').split(' ').slice(1);

  function htmlFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      if (entry.name === 'node_modules') return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return htmlFiles(full);
      return entry.name.endsWith('.html') ? [full] : [];
    });
  }
  const pages = htmlFiles(FRONTEND).map(file => ({ file: path.relative(FRONTEND, file), html: fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') }));

  it('allows every inline script on every page by its hash, and nothing inline by default', () => {
    assert.ok(!directive('script-src').includes("'unsafe-inline'"));
    assert.ok(!directive('script-src').includes("'unsafe-eval'"));
    const allowed = directive('script-src').filter(source => source.startsWith("'sha256-"));
    const used = new Set();
    for (const { file, html } of pages) {
      for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        const hash = `'sha256-${crypto.createHash('sha256').update(match[1], 'utf8').digest('base64')}'`;
        assert.ok(allowed.includes(hash), `${file}: inline script ${hash} is not in the CSP`);
        used.add(hash);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, `${file}: inline event handler`);
    }
    assert.deepEqual([...used].sort(), [...allowed].sort(), 'no stale hashes in the CSP');
  });

  it('pins each external script and stylesheet to an exact version with an integrity hash (Google Fonts CSS excepted)', () => {
    for (const { file, html } of pages) {
      for (const [tag] of html.matchAll(/<(script|link)\b[^>]*\b(src|href)="https:\/\/[^"]+"[^>]*>/g)) {
        if (/rel="preconnect"/.test(tag) || /fonts\.googleapis\.com\/css2/.test(tag)) continue;
        assert.match(tag, /@\d+\.\d+\.\d+\//, `${file}: ${tag} is not pinned to a version`);
        assert.match(tag, /integrity="sha384-[A-Za-z0-9+/]{64}"/, `${file}: ${tag} has no integrity hash`);
        assert.match(tag, /crossorigin="anonymous"/, `${file}: ${tag}`);
        const url = tag.match(/(?:src|href)="([^"]+)"/)[1];
        const sources = /<script/.test(tag) ? directive('script-src') : directive('style-src');
        assert.ok(sources.some(source => url === source || (source.endsWith('/') && url.startsWith(source))), `${file}: ${url} is not allowed by the CSP`);
      }
    }
  });

  it('only the Railway API is reachable from pages, nothing may frame them, and the usual headers are set', () => {
    assert.deepEqual(directive('connect-src'), ["'self'", 'https://pethub-production-f14d.up.railway.app']);
    assert.deepEqual(directive('frame-ancestors'), ["'none'"]);
    assert.deepEqual(directive('object-src'), ["'none'"]);
    const api = fs.readFileSync(path.join(FRONTEND, 'js', 'core', 'api.js'), 'utf8');
    assert.match(api, /const API_BASE_URL = 'https:\/\/pethub-production-f14d\.up\.railway\.app';/);
    const byName = Object.fromEntries(pageHeaders.map(({ key, value }) => [key, value]));
    assert.equal(byName['X-Content-Type-Options'], 'nosniff');
    assert.equal(byName['X-Frame-Options'], 'DENY');
    assert.equal(byName['Referrer-Policy'], 'strict-origin-when-cross-origin');
  });
});
