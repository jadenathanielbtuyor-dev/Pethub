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
  PROFILE_COLUMNS,
  ADDRESS_MAX_LENGTHS,
  POSTAL_CODE_PATTERN,
  EARLIEST_DATE_OF_BIRTH,
  CLINIC_TIME_ZONE
} = require('../constants/userProfile');

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
// Letters of any script (with their accents), spaces, and the punctuation names use: hyphen, apostrophes, period, comma
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '’.,-]*$/u;
const ADDRESS_LABELS = Object.freeze({
  address_line: 'House/unit number and street',
  barangay: 'Barangay',
  city_municipality: 'City/municipality',
  province: 'Province'
});
// Account fields a profile update must never change; each has its own workflow (or none) instead
const PROTECTED_PROFILE_FIELDS = Object.freeze({
  email: 'Your email address cannot be changed here.',
  password: 'Use Forgot Password on the login page to change your password.',
  confirm_password: 'Use Forgot Password on the login page to change your password.',
  role: 'Your account type cannot be changed here.',
  is_verified: 'Your verification status cannot be changed here.'
});
// The signed-in account's own id may accompany any request (middleware/requireAuth.js checks it against the token)
const IDENTITY_FIELDS = Object.freeze(['user_id', 'userId']);

// 400 naming the field it is about, so the form can show the message beside that field
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

function asObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
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

// Philippine mobile (0917 123 4567) and landline (02 8123 4567, 032 123 4567) numbers, written with 0, 63 or +63, are
// stored as +63 and the national number. Numbers from other countries must start with + (or 00) and the country code,
// and are stored as + and 8 to 15 digits (the international maximum). Entering a number does not verify it.
function normalizeContactNumber(value) {
  if (value.length > 25) return '';
  let compact = value.replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;

  const philippine = /^(?:(?:\+?63)0?|0)(9\d{9}|[2-8]\d{8})$/.exec(compact);
  if (philippine) return `+63${philippine[1]}`;

  const international = /^\+([1-9]\d{7,14})$/.exec(compact);
  if (international && !international[1].startsWith('63')) return `+${international[1]}`;
  return '';
}

function validateFullName(input) {
  const name = readText(input, 'fullname');
  const cleanName = collapseSpaces(name.value);
  if (name.invalid || !cleanName) return fieldError('fullname', 'Full legal name is required.');
  if (cleanName.length > FULLNAME_MAX_LENGTH) {
    return fieldError('fullname', `Full legal name must be ${FULLNAME_MAX_LENGTH} characters or fewer.`);
  }
  if (CONTROL_CHARACTERS.test(cleanName) || !NAME_PATTERN.test(cleanName)) {
    return fieldError('fullname', 'Enter your full legal name using letters, spaces, hyphens, apostrophes or periods.');
  }
  return { cleanName };
}

// Every personal and contact detail, in the order the forms show them; the first problem is reported
function validateProfileDetails(input) {
  const profile = {};

  const dateOfBirth = readText(input, 'date_of_birth');
  if (!dateOfBirth.invalid && !dateOfBirth.value) return fieldError('date_of_birth', 'Date of birth is required.');
  if (dateOfBirth.invalid || !isCalendarDate(dateOfBirth.value)) {
    return fieldError('date_of_birth', 'Enter a valid date of birth.');
  }
  if (dateOfBirth.value > getClinicDate()) return fieldError('date_of_birth', 'Date of birth cannot be in the future.');
  if (dateOfBirth.value < EARLIEST_DATE_OF_BIRTH) return fieldError('date_of_birth', 'Enter a date of birth from 1900 onwards.');
  profile.date_of_birth = dateOfBirth.value;

  const gender = readText(input, 'gender');
  if (!gender.invalid && !gender.value) {
    return fieldError('gender', 'Gender is required. "Prefer not to say" is a valid choice.');
  }
  const genderOption = GENDER_OPTIONS.find(option => option.toLowerCase() === gender.value.toLowerCase());
  if (gender.invalid || !genderOption) return fieldError('gender', 'Choose one of the listed options.');
  profile.gender = genderOption;

  const phone = readText(input, 'phone_number');
  if (!phone.invalid && !phone.value) return fieldError('phone_number', 'Contact number is required.');
  const phoneNumber = phone.invalid ? '' : normalizeContactNumber(phone.value);
  if (!phoneNumber) {
    return fieldError('phone_number', 'Enter a mobile or landline number, such as 0917 123 4567 or 02 8123 4567. For a number outside the Philippines, start with + and the country code.');
  }
  profile.phone_number = phoneNumber;

  for (const [field, maxLength] of Object.entries(ADDRESS_MAX_LENGTHS)) {
    const label = ADDRESS_LABELS[field];
    const text = readText(input, field);
    const value = collapseSpaces(text.value);
    if (!text.invalid && !value) return fieldError(field, `${label} is required.`);
    if (text.invalid || CONTROL_CHARACTERS.test(value) || !/[\p{L}\p{N}]/u.test(value)) {
      return fieldError(field, `Enter a valid ${label.toLowerCase()}.`);
    }
    if (value.length > maxLength) return fieldError(field, `${label} must be ${maxLength} characters or fewer.`);
    profile[field] = value;
  }

  const postalCode = readText(input, 'postal_code');
  if (!postalCode.invalid && !postalCode.value) return fieldError('postal_code', 'Postal code is required.');
  if (postalCode.invalid || !POSTAL_CODE_PATTERN.test(postalCode.value)) {
    return fieldError('postal_code', 'Enter a 4-digit postal code.');
  }
  profile.postal_code = postalCode.value;

  return { profile };
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

// Every field is required. Fields are checked in the order the registration form shows them, and the first problem is
// reported. Only the fields below are read: role, is_verified and anything else in the body are ignored.
function validateRegister(body = {}) {
  const input = asObject(body);

  const name = validateFullName(input);
  if (name.error) return name;
  const { cleanName } = name;

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

  // Checked here, never stored
  const confirmation = input.confirm_password;
  if (confirmation === undefined || confirmation === null || confirmation === '') {
    return fieldError('confirm_password', 'Confirm your password.');
  }
  if (confirmation !== cleanPassword) return fieldError('confirm_password', 'Passwords do not match.');

  const details = validateProfileDetails(input);
  if (details.error) return details;

  return { cleanName, normalizedEmail, cleanPassword, profile: details.profile };
}

// PUT /auth/profile: the full legal name and every personal detail, all required (the form always sends them all).
// Email, password, role and verification status have their own workflows and are refused here, as is any other field.
function validateProfileUpdate(body = {}) {
  const input = asObject(body);
  const editable = new Set(['fullname', ...PROFILE_COLUMNS, ...IDENTITY_FIELDS]);

  for (const field of Object.keys(input)) {
    if (Object.prototype.hasOwnProperty.call(PROTECTED_PROFILE_FIELDS, field)) {
      return fieldError(field, PROTECTED_PROFILE_FIELDS[field]);
    }
    if (!editable.has(field)) return fieldError(field, 'This detail cannot be changed here.');
  }

  const name = validateFullName(input);
  if (name.error) return name;

  const details = validateProfileDetails(input);
  if (details.error) return details;

  return { cleanName: name.cleanName, profile: details.profile };
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
  validateProfileUpdate,
  normalizeContactNumber,
  validateVerifyEmail,
  validateResendVerificationCode,
  validatePasswordResetRequest,
  validatePasswordReset,
  validateRequiredUserId
};
