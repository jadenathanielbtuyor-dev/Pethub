const {
  hasValue,
  trimValue,
  normalizeEmail,
  isEmailLike
} = require('./commonValidator');
const {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  FULLNAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  GENDER_OPTIONS,
  ADDRESS_MAX_LENGTHS,
  EARLIEST_DATE_OF_BIRTH,
  CLINIC_TIME_ZONE
} = require('../constants/userProfile');

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ADDRESS_LABELS = Object.freeze({
  address_line: 'House/Unit/Street',
  barangay: 'Barangay',
  city_municipality: 'City/Municipality',
  province: 'Province'
});

// 400 naming the field it is about, so the registration form can show the message beside that field
function fieldError(field, message) {
  return { error: { statusCode: 400, body: { success: false, error: message, field } } };
}

// Missing (undefined / null) reads as '', text is trimmed, and any other type is refused
function readText(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return { value: '' };
  if (typeof value !== 'string') return { invalid: true, value: '' };
  return { value: value.trim() };
}

function collapseSpaces(value) {
  return value.replace(/\s+/g, ' ');
}

function getClinicDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

// YYYY-MM-DD that exists on the calendar (rejects 2026-02-30 instead of rolling it over)
function isCalendarDate(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Philippine mobile numbers written the usual ways (0917 123 4567, +63 917 123 4567, 639171234567),
// stored as +639XXXXXXXXX. Entering a number does not verify it.
function normalizePhilippineMobile(value) {
  if (value.length > 20) return '';
  const match = /^(?:\+?63|0)(9\d{9})$/.exec(value.replace(/[\s().-]/g, ''));
  return match ? `+63${match[1]}` : '';
}

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

// Fields are checked in the order the registration form shows them, and the first problem is reported.
// Only the fields below are read: role, is_verified and anything else in the body are ignored.
function validateRegister(body = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const name = readText(input, 'fullname');
  const cleanName = collapseSpaces(name.value);
  if (name.invalid || !cleanName) return fieldError('fullname', 'Full name is required.');
  if (cleanName.length > FULLNAME_MAX_LENGTH) {
    return fieldError('fullname', `Full name must be ${FULLNAME_MAX_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHARACTERS.test(cleanName) || !/\p{L}/u.test(cleanName)) {
    return fieldError('fullname', 'Enter your full name using letters.');
  }

  const email = readText(input, 'email');
  const normalizedEmail = email.value.toLowerCase();
  if (!email.invalid && !normalizedEmail) return fieldError('email', 'Email address is required.');
  if (email.invalid || normalizedEmail.length > EMAIL_MAX_LENGTH || CONTROL_CHARACTERS.test(normalizedEmail) || !isEmailLike(normalizedEmail)) {
    return fieldError('email', 'Enter a valid email address.');
  }

  // Passwords are used exactly as typed (never trimmed)
  const password = input.password;
  if (password !== undefined && password !== null && typeof password !== 'string') {
    return fieldError('password', 'Enter a valid password.');
  }
  const cleanPassword = typeof password === 'string' ? password : '';
  if (!cleanPassword.trim()) return fieldError('password', 'Password is required.');
  if (cleanPassword.length < PASSWORD_MIN_LENGTH) {
    return fieldError('password', `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
  }
  if (cleanPassword.length > PASSWORD_MAX_LENGTH) {
    return fieldError('password', `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`);
  }

  // Optional: earlier versions of the form did not send it. Checked here, never stored.
  const confirmation = input.confirm_password;
  if (confirmation !== undefined && confirmation !== null && confirmation !== cleanPassword) {
    return fieldError('confirm_password', 'Passwords do not match.');
  }

  // Optional profile details: blank ones are left out, so they stay NULL
  const profile = {};

  const dateOfBirth = readText(input, 'date_of_birth');
  if (dateOfBirth.invalid || (dateOfBirth.value && !isCalendarDate(dateOfBirth.value))) {
    return fieldError('date_of_birth', 'Enter a valid date of birth.');
  }
  if (dateOfBirth.value) {
    if (dateOfBirth.value > getClinicDate()) return fieldError('date_of_birth', 'Date of birth cannot be in the future.');
    if (dateOfBirth.value < EARLIEST_DATE_OF_BIRTH) return fieldError('date_of_birth', 'Enter a date of birth from 1900 onwards.');
    profile.date_of_birth = dateOfBirth.value;
  }

  const gender = readText(input, 'gender');
  const genderOption = GENDER_OPTIONS.find(option => option.toLowerCase() === gender.value.toLowerCase());
  if (gender.invalid || (gender.value && !genderOption)) {
    return fieldError('gender', 'Choose one of the listed options.');
  }
  if (genderOption) profile.gender = genderOption;

  const phone = readText(input, 'phone_number');
  if (phone.invalid || phone.value) {
    const phoneNumber = phone.invalid ? '' : normalizePhilippineMobile(phone.value);
    if (!phoneNumber) return fieldError('phone_number', 'Enter a Philippine mobile number, for example 0917 123 4567.');
    profile.phone_number = phoneNumber;
  }

  for (const [field, maxLength] of Object.entries(ADDRESS_MAX_LENGTHS)) {
    const label = ADDRESS_LABELS[field];
    const text = readText(input, field);
    const value = collapseSpaces(text.value);
    if (text.invalid || CONTROL_CHARACTERS.test(value)) return fieldError(field, `Enter a valid ${label}.`);
    if (value.length > maxLength) return fieldError(field, `${label} must be ${maxLength} characters or fewer.`);
    if (value) profile[field] = value;
  }

  const postalCode = readText(input, 'postal_code');
  if (postalCode.invalid || (postalCode.value && !/^\d{4}$/.test(postalCode.value))) {
    return fieldError('postal_code', 'Enter a 4-digit postal code.');
  }
  if (postalCode.value) profile.postal_code = postalCode.value;

  return { cleanName, normalizedEmail, cleanPassword, profile };
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

  // Same password rules as registration
  if (newPassword.length < PASSWORD_MIN_LENGTH) {
    return {
      error: { statusCode: 400, body: { success: false, error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters long.` } }
    };
  }

  if (newPassword.length > PASSWORD_MAX_LENGTH) {
    return {
      error: { statusCode: 400, body: { success: false, error: `Password must be ${PASSWORD_MAX_LENGTH} characters or fewer.` } }
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
