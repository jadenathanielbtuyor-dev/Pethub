const crypto = require('crypto');
const env = require('../config/env');
const logger = require('./logger');
const { AUTH_TOKEN_TTL_HOURS, AUTH_TOKEN_MIN_SECRET_LENGTH } = require('../constants/auth');

// Signed access tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, AUTH_TOKEN_SECRET)).
// The payload carries only the user id, the server-side session id (user_sessions.id) and timestamps; roles are
// always re-read from the database, and middleware/requireAuth.js checks the session on every request, so logging out
// or resetting the password ends a token before it expires. Tokens without a session id (issued before sessions
// existed) are refused.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getTokenSecret() {
  const secret = env.auth.tokenSecret;
  return secret && secret.length >= AUTH_TOKEN_MIN_SECRET_LENGTH ? secret : '';
}

if (!getTokenSecret()) {
  logger.warn('auth.token_secret_missing', { minLength: AUTH_TOKEN_MIN_SECRET_LENGTH });
}

function signPayload(payloadPart, secret) {
  return crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

// When a session that starts now ends (stored in user_sessions.expires_at and in the token)
function getSessionExpiry(nowMs = Date.now()) {
  return new Date(Math.floor(nowMs / 1000) * 1000 + AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000);
}

function createAuthToken(userId, sessionId, expiresAt) {
  const secret = getTokenSecret();
  if (!secret) {
    throw new Error('AUTH_TOKEN_SECRET is not configured');
  }
  if (!UUID_PATTERN.test(String(sessionId || ''))) {
    throw new Error('A session id is required to sign a token');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expirySeconds = Math.floor(new Date(expiresAt || getSessionExpiry()).getTime() / 1000);
  const payload = {
    sub: String(userId),
    sid: String(sessionId),
    iat: nowSeconds,
    exp: expirySeconds
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${signPayload(payloadPart, secret)}`;
}

/**
 * Returns { userId, sessionId, expiresAt } for a valid, unexpired token signed with the current secret; otherwise
 * null. Whether the session is still open is checked against the database by requireAuth.
 */
function verifyAuthToken(token) {
  const secret = getTokenSecret();
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const [payloadPart, signaturePart] = parts;
  const expectedSignature = Buffer.from(signPayload(payloadPart, secret));
  const receivedSignature = Buffer.from(signaturePart);
  if (
    expectedSignature.length !== receivedSignature.length ||
    !crypto.timingSafeEqual(expectedSignature, receivedSignature)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }

  const userId = typeof payload?.sub === 'string' ? payload.sub.trim() : '';
  const sessionId = typeof payload?.sid === 'string' ? payload.sid.trim() : '';
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!userId || !UUID_PATTERN.test(sessionId) || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    return null;
  }

  return { userId, sessionId, expiresAt: payload.exp };
}

module.exports = {
  createAuthToken,
  verifyAuthToken,
  getSessionExpiry
};
