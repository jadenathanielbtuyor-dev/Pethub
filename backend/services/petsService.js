const usersRepository = require('../repositories/usersRepository');
const petsRepository = require('../repositories/petsRepository');
const appointmentsRepository = require('../repositories/appointmentsRepository');
const medicalRecordsRepository = require('../repositories/medicalRecordsRepository');
const { attachHandledByNames } = require('./appointmentsService');
const { isUserVerified } = require('../utils/accountVerification');
const { runExclusive } = require('../utils/keyedLock');
const {
  buildMedicalRecordContext,
  compareRecordsNewestFirst,
  getLatestRecordedWeight,
  getMedicalRecordSummary
} = require('../utils/medicalRecords');
const { findLikelyDuplicatePets, describeDuplicate } = require('../utils/petDuplicates');
const { hasValue } = require('../validators/commonValidator');
const {
  PET_AGE_RANGE_MESSAGE,
  POSSIBLE_DUPLICATE_PET_CODE,
  POSSIBLE_DUPLICATE_PET_MESSAGE,
  PET_HAS_HISTORY_CODE
} = require('../constants/pets');
const {
  isAgeInRange,
  validateCreatePet,
  validateUserIdQuery,
  validateDeletePet,
  validatePetHistoryRequest,
  validateUpdatePet,
  validateMedicalRecordsQuery
} = require('../validators/petsValidator');

const VERIFY_EMAIL_FIRST = { statusCode: 403, body: { error: 'Please verify your email first before accessing PetHub features.' } };
const PET_NOT_FOUND = { statusCode: 404, body: { error: 'Pet not found' } };

function possibleDuplicateResult(duplicates) {
  return { statusCode: 409, body: {
    success: false,
    error: POSSIBLE_DUPLICATE_PET_MESSAGE,
    code: POSSIBLE_DUPLICATE_PET_CODE,
    possible_duplicates: duplicates.map(describeDuplicate)
  } };
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// The name of the admin who saved each record (created_by_name / recorded_by_name); null when unknown
async function attachRecordCreatorNames(records) {
  const list = Array.isArray(records) ? records : [];
  const creatorIds = [...new Set(list
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

  return list.map(record => ({
    ...record,
    created_by_name: record.created_by ? creatorMap[String(record.created_by)] || null : null,
    recorded_by_name: record.created_by ? creatorMap[String(record.created_by)] || null : null
  }));
}

/**
 * Create a new pet for the user. A likely duplicate of one of the owner's own profiles (utils/petDuplicates.js) is
 * answered with 409 and the matching profiles, and nothing is saved, until the owner confirms a different pet
 * (confirm_not_duplicate: true).
 */
const createPet = async (req) => {
  try {
    const validation = validateCreatePet(req.body);
    if (validation.error) return validation.error;

    const { normalizedUserId, cleanName, cleanSpecies, cleanBreed, cleanAge, confirmNotDuplicate } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) return VERIFY_EMAIL_FIRST;

    const newPet = {
      user_id: normalizedUserId,
      name: cleanName,
      species: cleanSpecies,
      breed: cleanBreed,
      age: cleanAge
    };

    // One profile change at a time per owner, so two identical submits cannot both pass the duplicate check
    const outcome = await runExclusive(`pets:${normalizedUserId}`, async () => {
      const { data: ownerPets, error: listError } = await petsRepository.listByUserId(normalizedUserId);
      if (listError) return { listError };

      const duplicates = findLikelyDuplicatePets(newPet, ownerPets);
      if (duplicates.length > 0 && !confirmNotDuplicate) return { refused: possibleDuplicateResult(duplicates) };

      return petsRepository.createPet(newPet);
    });

    if (outcome.refused) return outcome.refused;

    if (outcome.listError || outcome.error) {
      console.error('Error creating pet:', outcome.listError || outcome.error);
      return { statusCode: 500, body: { error: 'Failed to create pet' } };
    }

    return { statusCode: 201, body: { success: true, pet: outcome.data[0] } };
  } catch (error) {
    console.error('Create pet error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Edit the name, species, breed or age of the owner's own pet. Only the fields sent change. When the species changes
 * and the age is not sent, the saved age must already be in the configured range (it is never changed silently).
 */
const updatePet = async (req) => {
  try {
    const validation = validateUpdatePet(req.params, req.body);
    if (validation.error) return validation.error;

    const { normalizedPetId, normalizedUserId, changes, confirmNotDuplicate } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) return VERIFY_EMAIL_FIRST;

    const outcome = await runExclusive(`pets:${normalizedUserId}`, async () => {
      const { data: pet, error: findError } = await petsRepository.findProfileForUser(normalizedUserId, normalizedPetId);
      if (findError) return { failure: findError };
      if (!pet) return { refused: PET_NOT_FOUND };

      if (changes.species !== undefined && changes.age === undefined && !isAgeInRange(pet.age)) {
        return { refused: { statusCode: 400, body: {
          error: `The saved age is not one this form accepts, so enter the pet's age too. ${PET_AGE_RANGE_MESSAGE}`,
          field: 'age'
        } } };
      }

      const { data: ownerPets, error: listError } = await petsRepository.listByUserId(normalizedUserId);
      if (listError) return { failure: listError };

      const duplicates = findLikelyDuplicatePets({ ...pet, ...changes }, ownerPets, { excludePetId: pet.id });
      if (duplicates.length > 0 && !confirmNotDuplicate) return { refused: possibleDuplicateResult(duplicates) };

      return petsRepository.updateByIdForUser(normalizedPetId, normalizedUserId, changes);
    });

    if (outcome.refused) return outcome.refused;

    if (outcome.failure || outcome.error) {
      console.error('Error updating pet:', outcome.failure || outcome.error);
      return { statusCode: 500, body: { error: 'Failed to update pet' } };
    }

    if (!outcome.data || outcome.data.length === 0) return PET_NOT_FOUND;

    return { statusCode: 200, body: { success: true, pet: outcome.data[0] } };
  } catch (error) {
    console.error('Update pet error:', error);
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

    if (!verified) return VERIFY_EMAIL_FIRST;

    const { data: pets, error } = await petsRepository.listByUserId(normalizedUserId);

    if (error) {
      console.error('Error fetching pets:', error);
      return { statusCode: 500, body: { error: 'Failed to fetch pets' } };
    }

    // Build pet IDs list for medical record count query
    const petIds = (pets || []).map(p => String(p.id)).filter(Boolean);

    let recordCounts = {};
    let latestRecordsByPet = {};
    let recordsByPet = {};
    if (petIds.length > 0) {
      const { data: records, error: recordsError } = await medicalRecordsRepository.listSummariesByPetIds(petIds);

      if (recordsError) {
        console.warn('Unable to load medical record counts:', recordsError);
      }

      const recordContext = buildMedicalRecordContext(records || []);
      recordCounts = recordContext.counts;
      latestRecordsByPet = recordContext.latestByPet;
      recordsByPet = (records || []).reduce((map, record) => {
        if (record && record.pet_id != null) {
          const petId = String(record.pet_id);
          map[petId] = [...(map[petId] || []), record];
        }
        return map;
      }, {});
    }

    const annotatedPets = (pets || []).map(pet => {
      const latestRecord = latestRecordsByPet[String(pet.id)];
      return {
        ...pet,
        medical_record_count: recordCounts[String(pet.id)] || 0,
        latest_medical_record_summary: getMedicalRecordSummary(latestRecord),
        latest_medical_record_date: latestRecord?.record_date || latestRecord?.created_at || null,
        latest_weight: getLatestRecordedWeight(recordsByPet[String(pet.id)])
      };
    });

    return { statusCode: 200, body: { success: true, pets: annotatedPets } };
  } catch (error) {
    console.error('Get pets error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * One pet's profile and history, for its owner only: the appointments booked for it (linked by pet_id) and its
 * official medical records, each newest first, and the latest weight an official record holds. Appointments saved
 * without a pet_id are never matched to a pet by name; they are only counted (unlinked_appointment_count) and stay on
 * the owner's Appointments list.
 */
const getPetHistory = async (req) => {
  try {
    const validation = validatePetHistoryRequest(req.params, req.query);
    if (validation.error) return validation.error;

    const { normalizedPetId, normalizedUserId } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) return VERIFY_EMAIL_FIRST;

    const { data: pet, error: petError } = await petsRepository.findProfileForUser(normalizedUserId, normalizedPetId);

    if (petError) {
      console.error('Error loading pet for history:', petError);
      return { statusCode: 500, body: { error: 'Failed to load pet history' } };
    }

    if (!pet) return PET_NOT_FOUND;

    const [appointmentsResult, recordsResult, unlinkedResult] = await Promise.all([
      appointmentsRepository.listByUserIdAndPetId(normalizedUserId, normalizedPetId),
      medicalRecordsRepository.listByPetIds([normalizedPetId]),
      appointmentsRepository.countUnlinkedByUserId(normalizedUserId)
    ]);

    if (appointmentsResult.error || recordsResult.error) {
      console.error('Error loading pet history:', appointmentsResult.error || recordsResult.error);
      return { statusCode: 500, body: { error: 'Failed to load pet history' } };
    }

    if (unlinkedResult.error) {
      console.warn('Unable to count unlinked appointments:', unlinkedResult.error);
    }

    const records = (recordsResult.data || []).slice().sort(compareRecordsNewestFirst);
    const [appointments, medicalRecords] = await Promise.all([
      attachHandledByNames(appointmentsResult.data || []),
      attachRecordCreatorNames(records)
    ]);

    return { statusCode: 200, body: {
      success: true,
      pet,
      latest_weight: getLatestRecordedWeight(records),
      appointments,
      medical_records: medicalRecords.map(record => ({ ...record, pet_name: pet.name })),
      unlinked_appointment_count: unlinkedResult.error ? null : (unlinkedResult.count || 0)
    } };
  } catch (error) {
    console.error('Get pet history error:', error);
    return { statusCode: 500, body: { error: 'Server error' } };
  }
};

/**
 * Delete a pet (verify user ownership). A pet that any appointment or official medical record points to is kept
 * (409): deleting it could remove or orphan that history, and owners must not be able to start over with a clean
 * history. Removing such a profile needs the clinic and a reviewed data-retention decision.
 */
const deletePet = async (req) => {
  try {
    const validation = validateDeletePet(req.params, req.query);
    if (validation.error) return validation.error;

    const { normalizedPetId, normalizedUserId } = validation;

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) return VERIFY_EMAIL_FIRST;

    // Same key as booking (appointmentsService.createAppointment), so an appointment for this pet cannot be booked
    // between the history check and the delete
    const outcome = await runExclusive(`booking:${normalizedUserId}`, async () => {
      const { data: pet, error: findError } = await petsRepository.findProfileForUser(normalizedUserId, normalizedPetId);
      if (findError) return { failure: findError };
      if (!pet) return { refused: { statusCode: 404, body: { error: 'Pet not found or not authorized' } } };

      const [appointmentCount, recordCount] = await Promise.all([
        appointmentsRepository.countByPetId(normalizedPetId),
        medicalRecordsRepository.countByPetId(normalizedPetId)
      ]);
      if (appointmentCount.error || recordCount.error) return { failure: appointmentCount.error || recordCount.error };

      const appointments = appointmentCount.count || 0;
      const records = recordCount.count || 0;
      if (appointments > 0 || records > 0) {
        const held = [appointments ? plural(appointments, 'appointment') : '', records ? plural(records, 'official medical record') : '']
          .filter(Boolean).join(' and ');
        return { refused: { statusCode: 409, body: {
          success: false,
          // No pet name in the message: failed requests are logged with their error text
          error: `This pet profile can't be deleted because PetHub holds ${held} for it. The profile is kept so that history stays linked to it. Contact the clinic if it needs to be removed.`,
          code: PET_HAS_HISTORY_CODE,
          appointment_count: appointments,
          medical_record_count: records
        } } };
      }

      return petsRepository.deleteByIdForUser(normalizedPetId, normalizedUserId);
    });

    if (outcome.refused) return outcome.refused;

    if (outcome.failure || outcome.error) {
      console.error('Error deleting pet:', outcome.failure || outcome.error);
      return { statusCode: 500, body: { error: 'Failed to delete pet' } };
    }

    if (!outcome.data || outcome.data.length === 0) {
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

    const formattedRecords = (await attachRecordCreatorNames(records || [])).map(record => ({
      ...record,
      pet_name: petMap[String(record.pet_id)] || 'Unknown'
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
  updatePet,
  getUserPets,
  getPetHistory,
  deletePet,
  getUserMedicalRecords,
  createMedicalRecord
};
