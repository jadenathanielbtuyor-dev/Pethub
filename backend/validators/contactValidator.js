const {
  hasValue,
  trimValue,
  normalizeEmail,
  isEmailLike
} = require('./commonValidator');

const CONTACT_LIMITS = Object.freeze({ name: 100, email: 254, message: 2000 });

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

  if (!isEmailLike(cleanEmail) || cleanEmail.length > CONTACT_LIMITS.email) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  // Same limits as the form's maxlength (pages/public/contact.html); nothing longer is stored
  if (cleanName.length > CONTACT_LIMITS.name) {
    return {
      error: { statusCode: 400, body: { success: false, error: `Name must be ${CONTACT_LIMITS.name} characters or fewer` } }
    };
  }

  if (cleanMessage.length > CONTACT_LIMITS.message) {
    return {
      error: { statusCode: 400, body: { success: false, error: `Message must be ${CONTACT_LIMITS.message.toLocaleString('en-US')} characters or fewer` } }
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
  CONTACT_LIMITS,
  validateContactRequest
};
