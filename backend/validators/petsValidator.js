const {
  hasValue,
  trimValue
} = require('./commonValidator');
const { SERVICE_SPECIES } = require('../constants/services');
const {
  PET_AGE_MIN_YEARS,
  PET_AGE_MAX_YEARS,
  PET_AGE_RANGE_MESSAGE,
  PET_NAME_MAX_LENGTH,
  PET_BREED_MAX_LENGTH
} = require('../constants/pets');
const { normalizeSpecies, describeSpecies } = require('../utils/serviceCatalog');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PET_NOT_FOUND = { statusCode: 404, body: { error: 'Pet not found' } };

// 400 with the form field it is about, so the My Pets page can show it beside that field
function fieldError(field, message) {
  return { error: { statusCode: 400, body: { error: message, field } } };
}

/**
 * Age in whole years within the configured range: a JSON integer, or a string of digits only.
 * Decimals ("2.5", "3.0"), signs, exponents ("1e1"), text and other types are refused.
 * Returns { age }, { missing: true } or { invalid: true }.
 */
function parsePetAge(value) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    return { missing: true };
  }

  let age = NaN;
  if (typeof value === 'number') {
    age = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    age = Number(value.trim());
  }

  if (!Number.isInteger(age) || age < PET_AGE_MIN_YEARS || age > PET_AGE_MAX_YEARS) {
    return { invalid: true };
  }
  return { age };
}

function isAgeInRange(value) {
  return Number.isInteger(value) && value >= PET_AGE_MIN_YEARS && value <= PET_AGE_MAX_YEARS;
}

function validateName(value) {
  const name = trimValue(value);
  if (!name) return fieldError('name', 'Enter the pet\'s name.');
  if (name.length > PET_NAME_MAX_LENGTH) return fieldError('name', `Pet name must be ${PET_NAME_MAX_LENGTH} characters or fewer.`);
  return { value: name };
}

// The clinic cares for dogs and cats only (constants/services.js); stored as 'Dog' / 'Cat'
function validateSpecies(value) {
  if (!hasValue(value)) return fieldError('species', 'Choose the pet\'s species.');
  const species = normalizeSpecies(value);
  if (!species) {
    return fieldError('species', `The clinic cares for ${describeSpecies([...SERVICE_SPECIES])} only. Choose ${SERVICE_SPECIES.join(' or ')}.`);
  }
  return { value: species };
}

// Breed is optional: blank is saved as null
function validateBreed(value) {
  const breed = hasValue(value) ? trimValue(value) : null;
  if (breed && breed.length > PET_BREED_MAX_LENGTH) return fieldError('breed', `Breed must be ${PET_BREED_MAX_LENGTH} characters or fewer.`);
  return { value: breed };
}

function validateAge(value) {
  const parsed = parsePetAge(value);
  if (parsed.missing) return fieldError('age', `Enter the pet's age in whole years (${PET_AGE_MIN_YEARS} to ${PET_AGE_MAX_YEARS}).`);
  if (parsed.invalid) return fieldError('age', PET_AGE_RANGE_MESSAGE);
  return { value: parsed.age };
}

// The owner has seen the possible duplicate and confirmed this is a different pet
function isDuplicateConfirmed(body = {}) {
  return body.confirm_not_duplicate === true || body.confirm_not_duplicate === 'true';
}

function validateCreatePet(body = {}) {
  const normalizedUserId = trimValue(body.user_id);
  if (!normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'user_id is required' } }
    };
  }

  const name = validateName(body.name);
  if (name.error) return name;
  const species = validateSpecies(body.species);
  if (species.error) return species;
  const breed = validateBreed(body.breed);
  if (breed.error) return breed;
  const age = validateAge(body.age);
  if (age.error) return age;

  return {
    normalizedUserId,
    cleanName: name.value,
    cleanSpecies: species.value,
    cleanBreed: breed.value,
    cleanAge: age.value,
    confirmNotDuplicate: isDuplicateConfirmed(body)
  };
}

function validateUserIdQuery(query = {}) {
  const normalizedUserId = trimValue(query.user_id);
  if (!normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'user_id is required' } }
    };
  }

  return { normalizedUserId };
}

// /pets/<action>/:id?user_id= (delete and history); an id that cannot be a pet id is simply not found
function validateDeletePet(params = {}, query = {}) {
  const normalizedPetId = trimValue(params.id);
  const normalizedUserId = trimValue(query.user_id);

  if (!normalizedPetId || !normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'id and user_id are required' } }
    };
  }

  if (!UUID_PATTERN.test(normalizedPetId)) return { error: PET_NOT_FOUND };

  return { normalizedPetId, normalizedUserId };
}

const validatePetHistoryRequest = validateDeletePet;

/**
 * PUT /pets/update/:id: only the profile fields sent are changed (name, species, breed, age); anything else in the
 * body (user_id, id, created_at, medical record fields) is never written. A sent age is checked like a new one; the
 * saved age is checked again by the service when only the species changes.
 */
function validateUpdatePet(params = {}, body = {}) {
  const normalizedPetId = trimValue(params.id);
  const normalizedUserId = trimValue(body.user_id);

  if (!normalizedPetId || !normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'id and user_id are required' } }
    };
  }

  if (!UUID_PATTERN.test(normalizedPetId)) return { error: PET_NOT_FOUND };

  const has = field => Object.prototype.hasOwnProperty.call(body, field);
  const changes = {};

  if (has('name')) {
    const name = validateName(body.name);
    if (name.error) return name;
    changes.name = name.value;
  }
  if (has('species')) {
    const species = validateSpecies(body.species);
    if (species.error) return species;
    changes.species = species.value;
  }
  if (has('breed')) {
    const breed = validateBreed(body.breed);
    if (breed.error) return breed;
    changes.breed = breed.value;
  }
  if (has('age')) {
    const age = validateAge(body.age);
    if (age.error) return age;
    changes.age = age.value;
  }

  if (Object.keys(changes).length === 0) {
    return {
      error: { statusCode: 400, body: { error: 'Change the name, species, breed or age before saving.' } }
    };
  }

  return {
    normalizedPetId,
    normalizedUserId,
    changes,
    confirmNotDuplicate: isDuplicateConfirmed(body)
  };
}

function validateMedicalRecordsQuery(query = {}) {
  const userValidation = validateUserIdQuery(query);
  if (userValidation.error) return userValidation;

  return {
    normalizedUserId: userValidation.normalizedUserId,
    normalizedPetId: trimValue(query.pet_id)
  };
}

module.exports = {
  parsePetAge,
  isAgeInRange,
  validateCreatePet,
  validateUserIdQuery,
  validateDeletePet,
  validatePetHistoryRequest,
  validateUpdatePet,
  validateMedicalRecordsQuery
};
