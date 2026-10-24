const apiResponse = require('../utils/apiResponse');
const logger = require('../utils/logger');
const { verifyAuthToken } = require('../utils/authToken');
const userSessionsRepository = require('../repositories/userSessionsRepository');
const {
  AUTH_REQUIRED_MESSAGE,
  IDENTITY_MISMATCH_MESSAGE,
  SESSION_CHECK_UNAVAILABLE_MESSAGE
} = require('../constants/auth');

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
 * Rejects the request unless it carries a valid signed token whose server-side session is still open (not logged
 * out, not ended by a password reset, not expired); exposes the verified ids as req.authUserId / req.authSessionId.
 * When the session cannot be checked the request gets a 503, so a brief database problem does not sign anyone out.
 */
async function requireAuth(req, res, next) {
  const token = verifyAuthToken(getBearerToken(req));
  if (!token) {
    logger.authEvent('token.rejected', logger.getRequestDetails(req));
    return apiResponse.error(res, AUTH_REQUIRED_MESSAGE, 401);
  }

  let sessionOpen = false;
  try {
    const { data, error } = await userSessionsRepository.findActiveSession(token.sessionId, token.userId);
    if (error) throw error;
    sessionOpen = Boolean(data);
  } catch (error) {
    logger.error('auth.session_check_failed', { ...logger.getRequestDetails(req), code: error?.code || 'unknown' });
    return apiResponse.error(res, SESSION_CHECK_UNAVAILABLE_MESSAGE, 503);
  }
  if (!sessionOpen) {
    logger.authEvent('session.ended', { ...logger.getRequestDetails(req), token_user_id: token.userId });
    return apiResponse.error(res, AUTH_REQUIRED_MESSAGE, 401);
  }

  const claimsAnotherUser = getClaimedUserIds(req)
    .some(value => Array.isArray(value) || String(value).trim() !== token.userId);
  if (claimsAnotherUser) {
    logger.authEvent('identity.mismatch', { ...logger.getRequestDetails(req), token_user_id: token.userId });
    return apiResponse.error(res, IDENTITY_MISMATCH_MESSAGE, 403);
  }

  req.authUserId = token.userId;
  req.authSessionId = token.sessionId;
  next();
}

module.exports = {
  requireAuth
};
