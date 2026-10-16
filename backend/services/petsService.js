const usersRepository = require('../repositories/usersRepository');
const petsRepository = require('../repositories/petsRepository');
const medicalRecordsRepository = require('../repositories/medicalRecordsRepository');
const { isUserVerified } = require('../utils/accountVerification');
const {
  buildMedicalRecordContext,
  getMedicalRecordSummary
} = require('../utils/medicalRecords');
const { hasValue } = require('../validators/commonValidator');
const {
  validateCreatePet,
  validateUserIdQuery,
  validateDeletePet,
  validateMedicalRecordsQuery
} = require('../validators/petsValidator');

/**
 * Create a new pet for the user
 */
const createPet = async (req) => {
  try {
    const validation = validateCreatePet(req.body);
    if (validation.error) return validation.error;

    const { normalizedUserId, cleanName, cleanSpecies, cleanBreed, cleanAge } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub features.' } };
    }

    const { data, error } = await petsRepository.createPet({
      user_id: normalizedUserId,
      name: cleanName,
      species: cleanSpecies,
      breed: cleanBreed,
      age: cleanAge
    });

    if (error) {
      console.error('Error creating pet:', error);
      return { statusCode: 500, body: { error: 'Failed to create pet' } };
    }

    return { statusCode: 201, body: { success: true, pet: data[0] } };
  } catch (error) {
    console.error('Create pet error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Get all pets for a specific user
 */
const getUserPets = async (req) => {
  try {
    const validation = validateUserIdQuery(req.query);
    if (validation.error) return validation.error;

    const { normalizedUserId } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub features.' } };
    }

    const { data: pets, error } = await petsRepository.listByUserId(normalizedUserId);

    if (error) {
      console.error('Error fetching pets:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch pets' } };
    }

    // Build pet IDs list for medical record count query
    const petIds = (pets || []).map(p => String(p.id)).filter(Boolean);
    
    let recordCounts = {};
    let latestRecordsByPet = {};
    if (petIds.length > 0) {
      const { data: records, error: recordsError } = await medicalRecordsRepository.listSummariesByPetIds(petIds);

      if (recordsError) {
        console.warn('Unable to load medical record counts:', recordsError);
      }

      const recordContext = buildMedicalRecordContext(records || []);
      recordCounts = recordContext.counts;
      latestRecordsByPet = recordContext.latestByPet;
    }

    const annotatedPets = (pets || []).map(pet => {
      const latestRecord = latestRecordsByPet[String(pet.id)];
      return {
        ...pet,
        medical_record_count: recordCounts[String(pet.id)] || 0,
        latest_medical_record_summary: getMedicalRecordSummary(latestRecord),
        latest_medical_record_date: latestRecord?.record_date || latestRecord?.created_at || null
      };
    });

    return { statusCode: 200, body: { success: true, pets: annotatedPets } };
  } catch (error) {
    console.error('Get pets error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Delete a pet (verify user ownership)
 */
const deletePet = async (req) => {
  try {
    const validation = validateDeletePet(req.params, req.query);
    if (validation.error) return validation.error;

    const { normalizedPetId, normalizedUserId } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub features.' } };
    }

    const { data, error } = await petsRepository.deleteByIdForUser(normalizedPetId, normalizedUserId);

    if (error) {
      console.error('Error deleting pet:', error);
      return { statusCode: 500, body: { error: 'Failed to delete pet' } };
    }

    if (!data || data.length === 0) {
      return { statusCode: 404, body: { error: 'Pet not found or not authorized' } };
    }

    return { statusCode: 200, body: { success: true, message: 'Pet deleted successfully' } };
  } catch (error) {
    console.error('Delete pet error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Get medical records for a user, optionally filtered by pet
 */
const getUserMedicalRecords = async (req) => {
  try {
    const validation = validateMedicalRecordsQuery(req.query);
    if (validation.error) return validation.error;

    const { normalizedUserId, normalizedPetId } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return { statusCode: 403, body: { error: 'Please verify your email first before accessing medical records.' } };
    }

    // First get all pets for this user to filter medical records
    const { data: userPets, error: petsError } = await petsRepository.listBasicByUserId(normalizedUserId);

    if (petsError) {
      console.error('Error fetching user pets:', petsError);
      return { statusCode: 500, body: { error: 'Failed to fetch medical records' } };
    }

    if (!userPets || userPets.length === 0) {
      return { statusCode: 200, body: { success: true, records: [] } };
    }

    const userPetIds = userPets.map(p => String(p.id));
    if (normalizedPetId && !userPetIds.includes(normalizedPetId)) {
      return { statusCode: 404, body: { error: 'Pet not found' } };
    }

    const recordPetIds = normalizedPetId ? [normalizedPetId] : userPetIds;
    const { data: records, error: recordsError } = await medicalRecordsRepository.listByPetIds(recordPetIds);
    if (recordsError) {
      console.error('Error fetching medical records:', recordsError);
      return { statusCode: 500, body: { error: 'Failed to fetch medical records' } };
    }

    const petMap = (userPets || []).reduce((map, pet) => {
      if (pet && pet.id != null) {
        map[String(pet.id)] = pet.name || 'Unknown';
      }
      return map;
    }, {});

    const creatorIds = [...new Set((records || [])
      .map(record => record?.created_by)
      .filter(hasValue)
      .map(value => String(value).trim()))];
    let creatorMap = {};

    if (creatorIds.length > 0) {
      const { data: creators, error: creatorsError } = await usersRepository.listNamesByIds(creatorIds);

      if (creatorsError) {
        console.warn('Unable to load medical record creators:', creatorsError);
      } else if (Array.isArray(creators)) {
        creatorMap = creators.reduce((map, user) => {
          if (user && user.id != null && user.fullname) {
            map[String(user.id)] = user.fullname;
          }
          return map;
        }, {});
      }
    }

    const formattedRecords = (records || []).map(record => ({
      ...record,
      pet_name: petMap[String(record.pet_id)] || 'Unknown',
      created_by_name: record.created_by ? creatorMap[String(record.created_by)] || null : null,
      recorded_by_name: record.created_by ? creatorMap[String(record.created_by)] || null : null
    }));

    return { statusCode: 200, body: { success: true, records: formattedRecords } };
  } catch (error) {
    console.error('Get medical records error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * User medical records are read-only. Admin writes must go through /admin routes.
 */
const createMedicalRecord = async (req) => {
  return { statusCode: 403, body: {
    success: false,
    error: 'Only admins can create official medical records.'
  } };
};

module.exports = {
  createPet,
  getUserPets,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord
};
