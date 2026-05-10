const supabase = require('../config/supabase');

const PET_SELECT = 'id, user_id, name, species, breed, age, created_at';
const MEDICAL_RECORD_SELECT = 'id, pet_id, record_date, created_at, created_by, weight, vaccination_status, treatment, medical_notes';

async function isUserVerified(userId) {
  const { data, error } = await supabase
    .from('email_verifications')
    .select('id')
    .eq('user_id', String(userId))
    .eq('is_verified', true)
    .limit(1);

  if (error) {
    throw error;
  }
  return Array.isArray(data) && data.length > 0;
}

function getRecordTime(record) {
  const date = new Date(record?.record_date || record?.created_at || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getMedicalRecordSummary(record) {
  if (!record) return null;
  const parts = [
    record.medical_notes,
    record.treatment ? `Treatment: ${record.treatment}` : '',
    record.vaccination_status ? `Vaccination: ${record.vaccination_status}` : ''
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  return parts.length ? parts[0] : 'Medical record available';
}

function buildMedicalRecordContext(records) {
  const counts = {};
  const latestByPet = {};

  (records || []).forEach(record => {
    if (!record || record.pet_id == null) return;
    const petId = String(record.pet_id);
    counts[petId] = (counts[petId] || 0) + 1;

    if (!latestByPet[petId] || getRecordTime(record) > getRecordTime(latestByPet[petId])) {
      latestByPet[petId] = record;
    }
  });

  return { counts, latestByPet };
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Create a new pet for the user
 */
const createPet = async (req, res) => {
  try {
    const { user_id, name, species, breed, age } = req.body || {};
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';
    const cleanName = hasValue(name) ? String(name).trim() : '';
    const cleanSpecies = hasValue(species) ? String(species).trim() : '';
    const cleanBreed = hasValue(breed) ? String(breed).trim() : null;
    const cleanAge = hasValue(age) ? Number(age) : null;

    if (!normalizedUserId || !cleanName || !cleanSpecies) {
      return res.status(400).json({ error: 'user_id, name, and species are required' });
    }

    if (hasValue(age) && (!Number.isFinite(cleanAge) || cleanAge < 0)) {
      return res.status(400).json({ error: 'age must be a valid non-negative number' });
    }

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing PetHub features.' });
    }

    const { data, error } = await supabase
      .from('pets')
      .insert([{ user_id: normalizedUserId, name: cleanName, species: cleanSpecies, breed: cleanBreed, age: cleanAge }])
      .select(PET_SELECT);

    if (error) {
      console.error('Error creating pet:', error);
      return res.status(500).json({ error: 'Failed to create pet' });
    }

    res.status(201).json({ success: true, pet: data[0] });
  } catch (error) {
    console.error('Create pet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get all pets for a specific user
 */
const getUserPets = async (req, res) => {
  try {
    const { user_id } = req.query;
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';

    if (!normalizedUserId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing PetHub features.' });
    }

    const { data: pets, error } = await supabase
      .from('pets')
      .select(PET_SELECT)
      .eq('user_id', normalizedUserId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching pets:', error);
      return res.status(500).json({ error: 'Failed to fetch pets' });
    }

    // Build pet IDs list for medical record count query
    const petIds = (pets || []).map(p => String(p.id)).filter(Boolean);
    
    let recordCounts = {};
    let latestRecordsByPet = {};
    if (petIds.length > 0) {
      const { data: records, error: recordsError } = await supabase
        .from('medical_records')
        .select('id, pet_id, record_date, created_at, medical_notes, treatment, vaccination_status')
        .in('pet_id', petIds);

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

    res.json({ success: true, pets: annotatedPets });
  } catch (error) {
    console.error('Get pets error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Delete a pet (verify user ownership)
 */
const deletePet = async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id } = req.query;
    const normalizedPetId = hasValue(id) ? String(id).trim() : '';
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';

    if (!normalizedPetId || !normalizedUserId) {
      return res.status(400).json({ error: 'id and user_id are required' });
    }

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing PetHub features.' });
    }

    const { data, error } = await supabase
      .from('pets')
      .delete()
      .eq('id', normalizedPetId)
      .eq('user_id', normalizedUserId)
      .select('id');

    if (error) {
      console.error('Error deleting pet:', error);
      return res.status(500).json({ error: 'Failed to delete pet' });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Pet not found or not authorized' });
    }

    res.json({ success: true, message: 'Pet deleted successfully' });
  } catch (error) {
    console.error('Delete pet error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Get medical records for a user, optionally filtered by pet
 */
const getUserMedicalRecords = async (req, res) => {
  try {
    const { user_id, pet_id } = req.query;
    const normalizedUserId = hasValue(user_id) ? String(user_id).trim() : '';
    const normalizedPetId = hasValue(pet_id) ? String(pet_id).trim() : '';

    if (!normalizedUserId) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const verified = await isUserVerified(normalizedUserId);

    if (!verified) {
      return res.status(403).json({ error: 'Please verify your email first before accessing medical records.' });
    }

    // First get all pets for this user to filter medical records
    const { data: userPets, error: petsError } = await supabase
      .from('pets')
      .select('id, name')
      .eq('user_id', normalizedUserId);

    if (petsError) {
      console.error('Error fetching user pets:', petsError);
      return res.status(500).json({ error: 'Failed to fetch medical records' });
    }

    if (!userPets || userPets.length === 0) {
      return res.json({ success: true, records: [] });
    }

    const userPetIds = userPets.map(p => String(p.id));
    if (normalizedPetId && !userPetIds.includes(normalizedPetId)) {
      return res.status(404).json({ error: 'Pet not found' });
    }

    // Get medical records for these pets
    let query = supabase
      .from('medical_records')
      .select(MEDICAL_RECORD_SELECT)
      .in('pet_id', userPetIds)
      .order('record_date', { ascending: false });

    if (normalizedPetId) {
      query = query.eq('pet_id', normalizedPetId);
    }

    const { data: records, error: recordsError } = await query;
    if (recordsError) {
      console.error('Error fetching medical records:', recordsError);
      return res.status(500).json({ error: 'Failed to fetch medical records' });
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
      const { data: creators, error: creatorsError } = await supabase
        .from('users')
        .select('id, fullname')
        .in('id', creatorIds);

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

    res.json({ success: true, records: formattedRecords });
  } catch (error) {
    console.error('Get medical records error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * User medical records are read-only. Admin writes must go through /admin routes.
 */
const createMedicalRecord = async (req, res) => {
  return res.status(403).json({
    success: false,
    error: 'Only admins can create official medical records.'
  });
};

module.exports = { createPet, getUserPets, deletePet, getUserMedicalRecords, createMedicalRecord };
