const { normalizeEmail, isEmailLike } = require('./commonValidator');
const { normalizeContactNumber } = require('./authValidator');
const { CLINIC_CONTACT_FIELDS } = require('../constants/clinic');

function fieldError(field, message) {
  return { error: { statusCode: 422, body: { success: false, error: message, field } } };
}

// Every field is optional; an empty value removes it from the Contact page and the emails. Values are stored as typed
// (the phone number too, so it reads the way the clinic writes it) after checking them.
function validateClinicContactUpdate(body = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknownField = Object.keys(input).find(field => !Object.prototype.hasOwnProperty.call(CLINIC_CONTACT_FIELDS, field));
  if (unknownField) return fieldError(unknownField, 'This clinic setting cannot be changed.');

  const values = {};
  for (const [name, field] of Object.entries(CLINIC_CONTACT_FIELDS)) {
    const raw = input[name];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') return fieldError(name, `${field.label} must be text.`);
    const text = String(raw ?? '').replace(/\r\n?/g, '\n').trim();
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text)) return fieldError(name, `${field.label} contains characters that cannot be shown.`);
    if (text.length > field.maxLength) return fieldError(name, `${field.label} must be ${field.maxLength} characters or fewer.`);
    values[name] = text || null;
  }

  if (values.phone && !normalizeContactNumber(values.phone)) {
    return fieldError('phone', 'Enter a mobile or landline number, such as 0917 123 4567 or 02 8123 4567, or leave it blank.');
  }
  if (values.email) {
    values.email = normalizeEmail(values.email);
    if (!isEmailLike(values.email)) return fieldError('email', 'Enter a valid email address, or leave it blank.');
  }
  if (values.address && values.address.includes('\n')) values.address = values.address.replace(/\s*\n\s*/g, ', ');

  return { values };
}

module.exports = {
  validateClinicContactUpdate
};
