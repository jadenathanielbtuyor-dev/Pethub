const {
  hasValue,
  trimValue,
  normalizeEmail,
  isEmailLike
} = require('./commonValidator');

function validateLogin(body = {}) {
  const normalizedEmail = normalizeEmail(body.email);
  const cleanPassword = hasValue(body.password) ? String(body.password) : '';

  if (!normalizedEmail || !cleanPassword) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Email and password are required' } }
    };
  }

  if (!isEmailLike(normalizedEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  return { normalizedEmail, cleanPassword };
}

function validateRegister(body = {}) {
  const cleanName = trimValue(body.fullname);
  const normalizedEmail = normalizeEmail(body.email);
  const cleanPassword = hasValue(body.password) ? String(body.password) : '';

  if (!cleanName || !normalizedEmail || !cleanPassword) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'All fields are required' } }
    };
  }

  if (!isEmailLike(normalizedEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  return { cleanName, normalizedEmail, cleanPassword };
}

function validateVerifyEmail(body = {}) {
  const normalizedEmail = normalizeEmail(body.email);
  const verificationCode = trimValue(body.code);

  if (!normalizedEmail || !verificationCode) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Email and verification code are required' } }
    };
  }

  if (!isEmailLike(normalizedEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  return { normalizedEmail, verificationCode };
}

function validateResendVerificationCode(body = {}) {
  const normalizedEmail = normalizeEmail(body.email);

  if (!normalizedEmail) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Email is required' } }
    };
  }

  if (!isEmailLike(normalizedEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  return { normalizedEmail };
}

function validateRequiredUserId(value) {
  const userId = trimValue(value);
  if (!userId) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'User ID is required' } }
    };
  }

  return { userId };
}

module.exports = {
  validateLogin,
  validateRegister,
  validateVerifyEmail,
  validateResendVerificationCode,
  validateRequiredUserId
};
