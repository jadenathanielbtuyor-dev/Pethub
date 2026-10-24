const AUTH_TOKEN_TTL_HOURS = 8;
const AUTH_TOKEN_MIN_SECRET_LENGTH = 32;
const AUTH_REQUIRED_MESSAGE = 'Authentication required. Please log in again.';
const IDENTITY_MISMATCH_MESSAGE = 'You can only access your own account data.';
// The session could not be checked (database unreachable): the request is refused, but the browser keeps its sign-in
const SESSION_CHECK_UNAVAILABLE_MESSAGE = 'PetHub could not check your sign-in right now. Please try again in a moment.';
const SESSION_REVOKED_REASONS = Object.freeze({ logout: 'logout', passwordReset: 'password_reset' });

module.exports = {
  AUTH_TOKEN_TTL_HOURS,
  AUTH_TOKEN_MIN_SECRET_LENGTH,
  AUTH_REQUIRED_MESSAGE,
  IDENTITY_MISMATCH_MESSAGE,
  SESSION_CHECK_UNAVAILABLE_MESSAGE,
  SESSION_REVOKED_REASONS
};
