const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { verifyAuthToken } = require('../utils/authToken');
const { AUTH_REQUIRED_MESSAGE, IDENTITY_MISMATCH_MESSAGE } = require('../constants/auth');

function getBearerToken(req) {
  const match = String(req.headers?.authorization || '').match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

// Existing routes still receive the requester's id as user_id / userId / X-User-ID.
// Those values are no longer trusted on their own: each one must match the signed token.
function getClaimedUserIds(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return [req.query?.user_id, req.headers?.['x-user-id'], body.user_id, body.userId]
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '');
}

/**
 * Rejects the request unless it carries a valid signed token; exposes the verified id as req.authUserId.
 */
function requireAuth(req, res, next) {
  const session = verifyAuthToken(getBearerToken(req));
  if (!session) {
    logger.authEvent('token.rejected', logger.getRequestDetails(req));
    return apiResponse.error(res, AUTH_REQUIRED_MESSAGE, 401);
  }

  const claimsAnotherUser = getClaimedUserIds(req)
    .some(value => Array.isArray(value) || String(value).trim() !== session.userId);
  if (claimsAnotherUser) {
    logger.authEvent('identity.mismatch', { ...logger.getRequestDetails(req), token_user_id: session.userId });
    return apiResponse.error(res, IDENTITY_MISMATCH_MESSAGE, 403);
  }

  req.authUserId = session.userId;
  next();
}

/**
 * For public routes that optionally attribute the request to a signed-in user (e.g. contact form):
 * a body user_id is kept only when a valid token proves it.
 */
function optionalAuth(req, res, next) {
  const session = verifyAuthToken(getBearerToken(req));
  req.authUserId = session ? session.userId : '';

  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (body && Object.prototype.hasOwnProperty.call(body, 'user_id') && String(body.user_id).trim() !== req.authUserId) {
    delete body.user_id;
  }

  next();
}

module.exports = {
  requireAuth,
  optionalAuth
};
