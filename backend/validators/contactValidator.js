const {
  hasValue,
  trimValue,
  normalizeEmail,
  isEmailLike
} = require('./commonValidator');

function validateContactRequest(body = {}) {
  const cleanName = trimValue(body.name);
  const cleanEmail = normalizeEmail(body.email);
  const cleanMessage = trimValue(body.message);
  const normalizedUserId = hasValue(body.user_id) ? trimValue(body.user_id) : '';

  if (!cleanName || !cleanEmail || !cleanMessage) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Name, email, and message are required' } }
    };
  }

  if (!isEmailLike(cleanEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  return {
    cleanName,
    cleanEmail,
    cleanMessage,
    normalizedUserId
  };
}

module.exports = {
  validateContactRequest
};
