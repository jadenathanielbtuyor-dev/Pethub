const crypto = require('crypto');
const { VERIFICATION_CODE_TTL_MINUTES } = require('../constants/email');

// Same 6-digit range as before, from the cryptographic generator (Math.random is predictable)
function generateVerificationCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function getExpiryTimestamp() {
  const expiry = new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60 * 1000);
  return expiry.toISOString();
}

module.exports = {
  generateVerificationCode,
  getExpiryTimestamp
};
