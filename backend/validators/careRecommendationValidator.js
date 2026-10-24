const { trimValue, isUuid } = require('./commonValidator');
const {
  GUIDANCE_TYPES,
  RULE_INTERVAL_LIMITS,
  RULE_DESCRIPTION_MAX,
  RULE_EXPLANATION_MAX,
  OVERRIDE_NOTE_MAX
} = require('../constants/careRecommendations');

const RULE_FIELDS = new Set(['service_id', 'species', 'min_interval_days', 'max_interval_days', 'guidance_type', 'description', 'explanation', 'is_active', 'expected_version']);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function fieldError(message, field) {
  return { error: { statusCode: 422, body: { success: false, error: message, field } } };
}

function parseDays(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= RULE_INTERVAL_LIMITS.minDays && number <= RULE_INTERVAL_LIMITS.maxDays ? number : null;
}

function isRealDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// A rule: which service (and optionally which species) it applies to, the suggested interval range in days, a short
// description, an optional explanation, and whether it is general guidance or veterinarian-approved
function validateRuleBody(body = {}, { requireVersion = false } = {}) {
  const unknown = Object.keys(body || {}).find(field => !RULE_FIELDS.has(field) || (!requireVersion && field === 'expected_version'));
  if (unknown) return fieldError('This rule setting cannot be set.', unknown);

  const serviceId = trimValue(body.service_id);
  if (!isUuid(serviceId)) return fieldError('Choose the service this rule is for.', 'service_id');
  const speciesValue = body.species === null || body.species === undefined ? '' : trimValue(body.species);
  if (speciesValue && !['Dog', 'Cat'].includes(speciesValue)) return fieldError('Choose Dog, Cat, or all species.', 'species');

  const min = parseDays(body.min_interval_days);
  const max = parseDays(body.max_interval_days);
  if (min === null) return fieldError(`Enter the earliest suggested interval as whole days from ${RULE_INTERVAL_LIMITS.minDays} to ${RULE_INTERVAL_LIMITS.maxDays}.`, 'min_interval_days');
  if (max === null) return fieldError(`Enter the latest suggested interval as whole days from ${RULE_INTERVAL_LIMITS.minDays} to ${RULE_INTERVAL_LIMITS.maxDays}.`, 'max_interval_days');
  if (max < min) return fieldError('The latest interval must be the same as or later than the earliest.', 'max_interval_days');

  const guidanceType = trimValue(body.guidance_type);
  if (!Object.values(GUIDANCE_TYPES).includes(guidanceType)) {
    return fieldError('Choose whether this is general guidance or veterinarian-approved.', 'guidance_type');
  }
  const description = trimValue(body.description);
  if (!description || description.length > RULE_DESCRIPTION_MAX) {
    return fieldError(`Enter a description of 1 to ${RULE_DESCRIPTION_MAX} characters (what owners will read).`, 'description');
  }
  const explanation = typeof body.explanation === 'string' ? body.explanation.trim() : '';
  if (explanation.length > RULE_EXPLANATION_MAX) return fieldError(`The explanation must be ${RULE_EXPLANATION_MAX} characters or fewer.`, 'explanation');
  if (typeof body.is_active !== 'boolean') return fieldError('Choose whether the rule is enabled.', 'is_active');

  let expectedVersion = null;
  if (requireVersion) {
    expectedVersion = Number(body.expected_version);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) return fieldError('Reload this rule before saving it.', 'expected_version');
  }

  return {
    expectedVersion,
    rule: {
      service_id: serviceId,
      species: speciesValue || null,
      min_interval_days: min,
      max_interval_days: max,
      guidance_type: guidanceType,
      description,
      explanation,
      is_active: body.is_active
    }
  };
}

// Clinic staff set the next date for one pet: a date range (due_to optional), whether it is the veterinarian's
// recommendation, and an optional note shown to the owner
function validateOverrideBody(body = {}) {
  const dueFrom = trimValue(body.due_from);
  const dueTo = trimValue(body.due_to);
  if (!isRealDate(dueFrom)) return fieldError('Enter the suggested date (YYYY-MM-DD).', 'due_from');
  if (dueTo && !isRealDate(dueTo)) return fieldError('Enter the latest date as YYYY-MM-DD, or leave it empty.', 'due_to');
  if (dueTo && dueTo < dueFrom) return fieldError('The latest date must be on or after the suggested date.', 'due_to');
  const guidanceType = trimValue(body.guidance_type) || GUIDANCE_TYPES.veterinarianApproved;
  if (!Object.values(GUIDANCE_TYPES).includes(guidanceType)) return fieldError('Choose general guidance or veterinarian-approved.', 'guidance_type');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > OVERRIDE_NOTE_MAX) return fieldError(`The note must be ${OVERRIDE_NOTE_MAX} characters or fewer.`, 'note');
  return { dueFrom, dueTo: dueTo || null, guidanceType, note };
}

module.exports = {
  validateRuleBody,
  validateOverrideBody,
  isRealDate
};
