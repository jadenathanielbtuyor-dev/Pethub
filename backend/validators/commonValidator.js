function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function trimValue(value) {
  return hasValue(value) ? String(value).trim() : '';
}

function normalizeEmail(value) {
  return trimValue(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

// Database ids are UUIDs; checking the shape first answers 400/404 instead of a database error for a malformed id
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function isVerifiedValue(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function getLocalDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

module.exports = {
  hasValue,
  trimValue,
  normalizeEmail,
  isEmailLike,
  isUuid,
  isVerifiedValue,
  getLocalDateValue
};
