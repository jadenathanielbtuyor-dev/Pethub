const crypto = require('crypto');
const env = require('../config/env');
const logger = require('./logger');
const { AUTH_TOKEN_TTL_HOURS, AUTH_TOKEN_MIN_SECRET_LENGTH } = require('../constants/auth');

// Signed access tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, AUTH_TOKEN_SECRET)).
// The payload carries only the user id and timestamps; roles are always re-read from the database.

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

function createAuthToken(userId) {
  const secret = getTokenSecret();
  if (!secret) {
    throw new Error('AUTH_TOKEN_SECRET is not configured');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(userId),
    iat: nowSeconds,
    exp: nowSeconds + AUTH_TOKEN_TTL_HOURS * 60 * 60
  };
  const payloadPart = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadPart}.${signPayload(payloadPart, secret)}`;
}

/**
 * Returns { userId, expiresAt } for a valid, unexpired token signed with the current secret; otherwise null.
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!userId || !Number.isFinite(payload.exp) || payload.exp <= nowSeconds) {
    return null;
  }

  return { userId, expiresAt: payload.exp };
}

module.exports = {
  createAuthToken,
  verifyAuthToken
};
