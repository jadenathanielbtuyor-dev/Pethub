const { VERIFICATION_CODE_TTL_MINUTES } = require('../constants/email');

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getExpiryTimestamp() {
  const expiry = new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000);
  return expiry.toISOString();
}

module.exports = {
  generateVerificationCode,
  getExpiryTimestamp
};
