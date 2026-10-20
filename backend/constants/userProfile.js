// Registration and account profile rules (validators/authValidator.js). frontend/js/shared/profile-fields.js repeats
// the same limits for its field messages (tests/register-page.test.js keeps the two in step); the server is the
// authority. database/migrations/2026-10-20_users_profile_fields.sql repeats them as CHECK constraints.

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;

const FULLNAME_MAX_LENGTH = 100;
const EMAIL_MAX_LENGTH = 254;

// Stored exactly as listed. "Prefer not to say" is a complete answer: nobody has to disclose a gender.
const GENDER_OPTIONS = Object.freeze(['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say']);

// Personal and contact details on users (phone_number already existed; the rest come from
// database/migrations/2026-10-20_users_profile_fields.sql). Every one is REQUIRED for a new registration and for a
// profile update, but the columns stay nullable: accounts created before these details were asked for keep NULL until
// their owner completes them from the dashboard (PUT /auth/profile).
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

// Addresses are Philippine (barangay, city/municipality, province), so the postal code is the 4-digit PHLPost code
const POSTAL_CODE_PATTERN = /^\d{4}$/;

// Dates of birth before this are treated as typing mistakes, not as an age rule. There is no minimum age: the clinic
// has not stated one.
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
  POSTAL_CODE_PATTERN,
  EARLIEST_DATE_OF_BIRTH,
  CLINIC_TIME_ZONE
};
