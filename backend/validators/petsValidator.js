const {
  hasValue,
  trimValue
} = require('./commonValidator');

function validateCreatePet(body = {}) {
  const normalizedUserId = trimValue(body.user_id);
  const cleanName = trimValue(body.name);
  const cleanSpecies = trimValue(body.species);
  const cleanBreed = hasValue(body.breed) ? trimValue(body.breed) : null;
  const cleanAge = hasValue(body.age) ? Number(body.age) : null;

  if (!normalizedUserId || !cleanName || !cleanSpecies) {
    return {
      error: { statusCode: 400, body: { error: 'user_id, name, and species are required' } }
    };
  }

  if (hasValue(body.age) && (!Number.isFinite(cleanAge) || cleanAge < 0)) {
    return {
      error: { statusCode: 400, body: { error: 'age must be a valid non-negative number' } }
    };
  }

  return {
    normalizedUserId,
    cleanName,
    cleanSpecies,
    cleanBreed,
    cleanAge
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

function validateDeletePet(params = {}, query = {}) {
  const normalizedPetId = trimValue(params.id);
  const normalizedUserId = trimValue(query.user_id);

  if (!normalizedPetId || !normalizedUserId) {
    return {
      error: { statusCode: 400, body: { error: 'id and user_id are required' } }
    };
  }

  return { normalizedPetId, normalizedUserId };
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
  validateCreatePet,
  validateUserIdQuery,
  validateDeletePet,
  validateMedicalRecordsQuery
};
