// Registration and account profile rules (validators/authValidator.js). frontend/js/core/auth.js repeats the same
// limits for its field messages; the server is the authority.

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const FULLNAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;

// Stored exactly as listed. Optional, and never needed for booking.
const GENDER_OPTIONS = Object.freeze(['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say']);

// Optional profile columns on users (database/migrations/2026-10-20_users_profile_fields.sql; phone_number already
// existed). Every one is nullable; registration only sends the ones the customer filled in.
const PROFILE_COLUMNS = Object.freeze([
  'phone_number',
  'date_of_birth',
  'gender',
  'address_line',
  'barangay',
  'city_municipality',
  'province',
  'postal_code'
]);

const ADDRESS_MAX_LENGTHS = Object.freeze({
  address_line: 150,
  barangay: 100,
  city_municipality: 100,
  province: 100
});

// Dates of birth before this are treated as typing mistakes, not as an age rule
const EARLIEST_DATE_OF_BIRTH = '1900-01-01';
// "Today" for date-of-birth checks is the clinic's calendar date
const CLINIC_TIME_ZONE = 'Asia/Manila';

module.exports = {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  FULLNAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  GENDER_OPTIONS,
  PROFILE_COLUMNS,
  ADDRESS_MAX_LENGTHS,
  EARLIEST_DATE_OF_BIRTH,
  CLINIC_TIME_ZONE
};
