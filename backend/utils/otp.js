function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function getExpiryTimestamp() {
  const expiry = new Date(Date.now() + 10 * 60 * 1000);
  return expiry.toISOString();
}

module.exports = {
  generateVerificationCode,
  getExpiryTimestamp
};
