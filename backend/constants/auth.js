const AUTH_TOKEN_TTL_HOURS = 8;
const AUTH_TOKEN_MIN_SECRET_LENGTH = 32;
const AUTH_REQUIRED_MESSAGE = 'Authentication required. Please log in again.';
const IDENTITY_MISMATCH_MESSAGE = 'You can only access your own account data.';

module.exports = {
  AUTH_TOKEN_TTL_HOURS,
  AUTH_TOKEN_MIN_SECRET_LENGTH,
  AUTH_REQUIRED_MESSAGE,
  IDENTITY_MISMATCH_MESSAGE
};
