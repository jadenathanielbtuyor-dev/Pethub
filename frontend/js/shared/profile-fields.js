// Personal-detail rules shared by the registration form (core/auth.js) and the dashboard's "Your details" form
// (user/dashboard.js). They repeat backend/validators/authValidator.js and backend/constants/userProfile.js so each
// field gets its message straight away; the server checks everything again and is the authority.
// backend/tests/profile-fields.test.js runs the same values through both and keeps them in step.
(function initProfileFields(root) {
  const FULLNAME_MAX_LENGTH = 100;
  const EARLIEST_DATE_OF_BIRTH = '1900-01-01';
  const CLINIC_TIME_ZONE = 'Asia/Manila';
  const GENDER_OPTIONS = Object.freeze(['Female', 'Male', 'Non-binary', 'Other', 'Prefer not to say']);
  const ADDRESS_LIMITS = Object.freeze({
    address_line: Object.freeze({ label: 'House/unit number and street', max: 150 }),
    barangay: Object.freeze({ label: 'Barangay', max: 100 }),
    city_municipality: Object.freeze({ label: 'City/municipality', max: 100 }),
    province: Object.freeze({ label: 'Province', max: 100 })
  });
  // The order both forms show them in
  const PROFILE_FIELDS = Object.freeze([
    'date_of_birth', 'gender', 'phone_number', 'address_line', 'barangay', 'city_municipality', 'province', 'postal_code'
  ]);

  const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
  // Letters of any script (with their accents), spaces, and the punctuation names use: hyphen, apostrophes, period, comma
  const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} '’.,-]*$/u;
  const PHONE_MESSAGE = 'Enter a mobile or landline number, such as 0917 123 4567 or 02 8123 4567. For a number outside the Philippines, start with + and the country code.';

  function collapseSpaces(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
  }

  // Today's date at the clinic (YYYY-MM-DD), whatever the visitor's own time zone
  function getClinicDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  function isCalendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  // '' when the number is not acceptable; otherwise the form the server stores (+63... or +<country code>...)
  function normalizeContactNumber(value) {
    const text = String(value ?? '').trim();
    if (!text || text.length > 25) return '';
    let compact = text.replace(/[\s().-]/g, '');
    if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;

    const philippine = /^(?:(?:\+?63)0?|0)(9\d{9}|[2-8]\d{8})$/.exec(compact);
    if (philippine) return `+63${philippine[1]}`;

    const international = /^\+([1-9]\d{7,14})$/.exec(compact);
    if (international && !international[1].startsWith('63')) return `+${international[1]}`;
    return '';
  }

  function getFullNameError(value) {
    const name = collapseSpaces(value);
    if (!name) return 'Enter your full legal name.';
    if (name.length > FULLNAME_MAX_LENGTH) return `Full legal name must be ${FULLNAME_MAX_LENGTH} characters or fewer.`;
    return !CONTROL_CHARACTERS.test(name) && NAME_PATTERN.test(name)
      ? ''
      : 'Enter your full legal name using letters, spaces, hyphens, apostrophes or periods.';
  }

  // The message to show beside a personal-detail field, or '' when its value is acceptable. date_of_birth may be
  // 'invalid' when the browser could not read what was typed.
  function getProfileFieldError(name, rawValue) {
    const value = name === 'gender' ? String(rawValue ?? '') : collapseSpaces(rawValue);

    if (name === 'date_of_birth') {
      if (!value) return 'Enter your date of birth.';
      if (!isCalendarDate(value)) return 'Enter a valid date of birth.';
      if (value > getClinicDate()) return 'Date of birth cannot be in the future.';
      return value >= EARLIEST_DATE_OF_BIRTH ? '' : 'Enter a date of birth from 1900 onwards.';
    }
    if (name === 'gender') {
      if (!value) return 'Choose an option. "Prefer not to say" is a valid choice.';
      return GENDER_OPTIONS.includes(value) ? '' : 'Choose one of the listed options.';
    }
    if (name === 'phone_number') {
      if (!value) return 'Enter a contact number.';
      return normalizeContactNumber(value) ? '' : PHONE_MESSAGE;
    }
    if (name === 'postal_code') {
      if (!value) return 'Enter your postal code.';
      return /^\d{4}$/.test(value) ? '' : 'Enter a 4-digit postal code.';
    }
    const address = ADDRESS_LIMITS[name];
    if (address) {
      if (!value) return `Enter your ${address.label.toLowerCase()}.`;
      if (CONTROL_CHARACTERS.test(value) || !/[\p{L}\p{N}]/u.test(value)) return `Enter a valid ${address.label.toLowerCase()}.`;
      return value.length <= address.max ? '' : `${address.label} must be ${address.max} characters or fewer.`;
    }
    return '';
  }

  // True when every detail has a value (accounts created before they were required may have none)
  function isProfileComplete(profile) {
    if (!profile || typeof profile !== 'object') return false;
    return PROFILE_FIELDS.every(field => profile[field] !== null && profile[field] !== undefined && String(profile[field]).trim() !== '');
  }

  // Stored numbers made readable: +639171234567 -> +63 917 123 4567, +63281234567 -> +63 2 8123 4567,
  // +63321234567 -> +63 32 123 4567; other countries are shown as stored
  function formatContactNumber(value) {
    const text = String(value ?? '');
    const mobile = /^\+63(9\d{2})(\d{3})(\d{4})$/.exec(text);
    if (mobile) return `+63 ${mobile[1]} ${mobile[2]} ${mobile[3]}`;
    const manila = /^\+632(\d{4})(\d{4})$/.exec(text);
    if (manila) return `+63 2 ${manila[1]} ${manila[2]}`;
    const landline = /^\+63([3-8]\d)(\d{3})(\d{4})$/.exec(text);
    if (landline) return `+63 ${landline[1]} ${landline[2]} ${landline[3]}`;
    return text;
  }

  const api = Object.freeze({
    FULLNAME_MAX_LENGTH,
    EARLIEST_DATE_OF_BIRTH,
    GENDER_OPTIONS,
    ADDRESS_LIMITS,
    PROFILE_FIELDS,
    getClinicDate,
    normalizeContactNumber,
    getFullNameError,
    getProfileFieldError,
    isProfileComplete,
    formatContactNumber
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  root.PetHubProfileFields = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
