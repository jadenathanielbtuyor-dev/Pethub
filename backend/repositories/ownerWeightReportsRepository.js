const supabase = require('../config/supabase');

const WEIGHT_REPORT_SELECT = 'id, pet_id, user_id, weight_kg, source, recorded_at, created_at';

function listByPetIdForUser(petId, userId) {
  return supabase.from('owner_pet_weight_reports').select(WEIGHT_REPORT_SELECT)
    .eq('pet_id', petId).eq('user_id', userId).order('recorded_at', { ascending: false });
}

function create(report) {
  return supabase.from('owner_pet_weight_reports').insert([report]).select(WEIGHT_REPORT_SELECT);
}

function countByPetId(petId) {
  return supabase.from('owner_pet_weight_reports').select('id', { count: 'exact', head: true }).eq('pet_id', petId);
}

module.exports = { WEIGHT_REPORT_SELECT, listByPetIdForUser, create, countByPetId };
