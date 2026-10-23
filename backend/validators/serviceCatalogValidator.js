const { trimValue } = require('./commonValidator');
const { SERVICE_SPECIES, SERVICE_CATEGORIES } = require('../constants/services');
const { MIN_SERVICE_DURATION_MINUTES, MAX_SERVICE_DURATION_MINUTES } = require('../utils/serviceCatalog');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_KEYS = Object.keys(SERVICE_CATEGORIES);
const ALLOWED_FIELDS = new Set([
  'name', 'description', 'category', 'species', 'duration_minutes',
  'online_booking_enabled', 'display_order', 'expected_version'
]);

function validationError(message, field = '') {
  return { error: { statusCode: 422, body: { success: false, error: message, ...(field ? { field } : {}) } } };
}

function parseInteger(value, { min, max, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return { value: null };
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return { invalid: true };
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return { invalid: true };
  return { value: number };
}

function validateServiceUpdateRequest(params = {}, body = {}, adminUserId = '') {
  const serviceId = trimValue(params.id);
  if (!UUID_PATTERN.test(serviceId)) {
    return { error: { statusCode: 404, body: { success: false, error: 'Service not found.' } } };
  }
  if (!trimValue(adminUserId)) {
    return { error: { statusCode: 401, body: { success: false, error: 'Sign in to manage services.' } } };
  }

  const unknownField = Object.keys(body || {}).find(field => !ALLOWED_FIELDS.has(field));
  if (unknownField) return validationError('This service setting cannot be changed.', unknownField);

  const name = trimValue(body.name);
  if (!name || name.length > 100) return validationError('Enter a service name of 1 to 100 characters.', 'name');

  const description = typeof body.description === 'string' ? body.description.trim() : null;
  if (description === null || description.length > 500) {
    return validationError('Enter a service description of 500 characters or fewer.', 'description');
  }

  const category = trimValue(body.category);
  if (!CATEGORY_KEYS.includes(category)) return validationError('Choose a valid service category.', 'category');

  if (!Array.isArray(body.species)
      || body.species.some(species => !SERVICE_SPECIES.includes(species))
      || new Set(body.species).size !== body.species.length) {
    return validationError('Choose Dog, Cat, or both as the applicable species.', 'species');
  }

  const duration = parseInteger(body.duration_minutes, {
    min: MIN_SERVICE_DURATION_MINUTES,
    max: MAX_SERVICE_DURATION_MINUTES,
    nullable: true
  });
  if (duration.invalid) {
    return validationError(`Enter a whole-number duration from ${MIN_SERVICE_DURATION_MINUTES} to ${MAX_SERVICE_DURATION_MINUTES} minutes, or leave it blank until confirmed.`, 'duration_minutes');
  }

  if (typeof body.online_booking_enabled !== 'boolean') {
    return validationError('Choose whether online booking is enabled for this service.', 'online_booking_enabled');
  }
  const displayOrder = parseInteger(body.display_order, { min: 1, max: 99 });
  if (displayOrder.invalid) return validationError('Display order must be a whole number from 1 to 99.', 'display_order');
  const expectedVersion = parseInteger(body.expected_version, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (expectedVersion.invalid) return validationError('Reload this service before saving its configuration.', 'expected_version');

  if (body.online_booking_enabled && duration.value === null) {
    return validationError('Set a clinic-confirmed duration before enabling online booking.', 'duration_minutes');
  }
  if (body.online_booking_enabled && body.species.length === 0) {
    return validationError('Choose at least one clinic-confirmed species before enabling online booking.', 'species');
  }

  return {
    serviceId,
    adminUserId: String(adminUserId).trim(),
    expectedVersion: expectedVersion.value,
    changes: {
      name,
      description,
      category,
      species: [...body.species],
      duration_minutes: duration.value,
      online_booking_enabled: body.online_booking_enabled,
      display_order: displayOrder.value,
      updated_by: String(adminUserId).trim()
    }
  };
}

module.exports = {
  validateServiceUpdateRequest
};
