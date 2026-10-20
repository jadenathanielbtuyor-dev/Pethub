// The browser's personal-detail rules (frontend/js/shared/profile-fields.js, used by the registration page and the
// dashboard's "Your details" form) against the server's (validators/authValidator.js): the same values must be
// accepted or refused by both, and phone numbers must be normalised the same way. Also checks the dashboard form's
// fields against the profile columns. Pure functions and static files; no browser or network.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');
const shared = require(path.join(FRONTEND, 'js', 'shared', 'profile-fields.js'));
const { validateProfileUpdate, normalizeContactNumber } = require('../validators/authValidator');
const profileRules = require('../constants/userProfile');

const VALID = Object.freeze({
  fullname: 'Maria Santos',
  date_of_birth: '1994-06-15',
  gender: 'Female',
  phone_number: '0917 123 4567',
  address_line: '12 Mabini Street',
  barangay: 'San Antonio',
  city_municipality: 'Pasig City',
  province: 'Metro Manila',
  postal_code: '1605'
});

function serverAccepts(field, value) {
  const result = validateProfileUpdate({ ...VALID, [field]: value });
  return !result.error;
}

function browserAccepts(field, value) {
  return field === 'fullname' ? shared.getFullNameError(value) === '' : shared.getProfileFieldError(field, value) === '';
}

const today = shared.getClinicDate();
const CASES = {
  fullname: ['Maria Santos', '  Juan  dela Cruz ', 'José Ñiño-O\'Brien', 'Ma. Cristina dela Cruz, Jr.', 'D’Angelo', '王小明',
    '', '   ', '12345', 'Maria 2', '--- ...', 'Ana_Cruz', '@nna', 'A'.repeat(100), 'A'.repeat(101), 'Ana\u0007Cruz'],
  date_of_birth: ['1994-06-15', '1900-01-01', today, '1899-12-31', '2999-01-01', '2001-02-30', '1994-6-15', 'yesterday', ''],
  gender: [...profileRules.GENDER_OPTIONS, '', 'Unknown'],
  phone_number: ['09171234567', '0917 123 4567', '+63 (917) 123-4567', '639171234567', '+63 0917 123 4567', '0063 917 123 4567',
    '02 8123 4567', '(02) 8123-4567', '032 123 4567', '+1 415 555 0100', '0044 20 7946 0958', '',
    '0917123456', '091712345678', '0817 123 4567', '+63123', '14155550100', '12345', '+0123456789', '+1234567', 'call me', '0'.repeat(30)],
  address_line: ['12 Mabini Street', 'Blk 3 Lot 9', 'x'.repeat(150), 'x'.repeat(151), '', '---', 'Bad\u0007Bell'],
  barangay: ['San Antonio', 'Brgy. 143', 'y'.repeat(100), 'y'.repeat(101), '', '...'],
  city_municipality: ['Pasig City', 'z'.repeat(101), ''],
  province: ['Metro Manila', 'Rizal', '', '---'],
  postal_code: ['1605', '0400', '', '123', '12345', '16O5', '1605a']
};

describe('Browser and server personal-detail rules agree', () => {
  for (const [field, values] of Object.entries(CASES)) {
    it(`${field}: the same values are accepted and refused`, () => {
      for (const value of values) {
        assert.equal(browserAccepts(field, value), serverAccepts(field, value), `${field} = ${JSON.stringify(value)}`);
      }
      assert.ok(values.some(value => serverAccepts(field, value)), 'some values are valid');
      assert.ok(values.some(value => !serverAccepts(field, value)), 'some values are invalid');
    });
  }

  it('phone numbers are normalised to the same stored form', () => {
    for (const value of CASES.phone_number) {
      assert.equal(shared.normalizeContactNumber(value), normalizeContactNumber(value.trim()), JSON.stringify(value));
    }
  });

  it('formats stored numbers for reading without changing numbers from other countries', () => {
    assert.equal(shared.formatContactNumber('+639171234567'), '+63 917 123 4567');
    assert.equal(shared.formatContactNumber('+63281234567'), '+63 2 8123 4567');
    assert.equal(shared.formatContactNumber('+63321234567'), '+63 32 123 4567');
    assert.equal(shared.formatContactNumber('+14155550100'), '+14155550100');
    // Every readable form is accepted again unchanged, so the dashboard form can be saved as shown
    for (const stored of ['+639171234567', '+63281234567', '+63321234567', '+14155550100']) {
      assert.equal(normalizeContactNumber(shared.formatContactNumber(stored)), stored);
    }
  });

  it('a profile is complete only when every detail has a value', () => {
    const complete = Object.fromEntries(profileRules.PROFILE_COLUMNS.map(column => [column, 'x']));
    assert.equal(shared.isProfileComplete(complete), true);
    for (const column of profileRules.PROFILE_COLUMNS) {
      assert.equal(shared.isProfileComplete({ ...complete, [column]: null }), false, column);
      assert.equal(shared.isProfileComplete({ ...complete, [column]: '  ' }), false, column);
    }
    assert.equal(shared.isProfileComplete(null), false);
    assert.deepEqual([...shared.PROFILE_FIELDS].sort(), [...profileRules.PROFILE_COLUMNS].sort());
  });
});

describe('Dashboard "Your details" form', () => {
  const page = fs.readFileSync(path.join(FRONTEND, 'pages', 'user', 'dashboard.html'), 'utf8');
  const form = page.match(/<form id="accountDetailsForm"[\s\S]*?<\/form>/)[0];

  it('has every editable field, required and labelled, and nothing protected', () => {
    const inputs = [...form.matchAll(/<(input|select)\b[^>]*>/g)].map(match => match[0]);
    const names = inputs.map(tag => tag.match(/name="([^"]+)"/)[1]);
    assert.deepEqual(names, ['fullname', ...shared.PROFILE_FIELDS]);
    inputs.forEach(tag => {
      assert.match(tag, /\srequired\b/);
      const id = tag.match(/id="([^"]+)"/)[1];
      assert.match(form, new RegExp(`<label for="${id}"`), `${id} has a label`);
    });
    assert.doesNotMatch(form, /name="(email|password|role|is_verified)"/);
    for (const [field, max] of Object.entries(profileRules.ADDRESS_MAX_LENGTHS)) {
      assert.match(form, new RegExp(`name="${field}"[^>]*maxlength="${max}"`), field);
    }
    const genders = [...form.match(/<select id="profileGender"[\s\S]*?<\/select>/)[0].matchAll(/<option value="([^"]*)"/g)].map(match => match[1]).filter(Boolean);
    assert.deepEqual(genders, [...profileRules.GENDER_OPTIONS]);
  });

  it('loads the shared rules before the dashboard script', () => {
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
    assert.ok(scripts.indexOf('../../js/shared/profile-fields.js') > -1);
    assert.ok(scripts.indexOf('../../js/shared/profile-fields.js') < scripts.indexOf('../../js/user/dashboard.js'));
  });
});
