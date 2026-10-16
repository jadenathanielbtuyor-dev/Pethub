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

function validatePasswordResetRequest(body = {}) {
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

function validatePasswordReset(body = {}) {
  const normalizedEmail = normalizeEmail(body.email);
  const resetCode = trimValue(body.code);
  const newPassword = hasValue(body.password) ? String(body.password) : '';

  if (!normalizedEmail || !resetCode || !newPassword) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Email, reset code, and new password are required' } }
    };
  }

  if (!isEmailLike(normalizedEmail)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter a valid email address' } }
    };
  }

  if (!/^\d{6}$/.test(resetCode)) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Enter the 6-digit reset code sent to your email' } }
    };
  }

  // Same minimum the registration form enforces
  if (newPassword.length < 8) {
    return {
      error: { statusCode: 400, body: { success: false, error: 'Password must be at least 8 characters long.' } }
    };
  }

  return { normalizedEmail, resetCode, newPassword };
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
  validatePasswordResetRequest,
  validatePasswordReset,
  validateRequiredUserId
};
