const supabase = require('../config/supabase');

const MEDICAL_RECORD_SELECT = 'id, pet_id, record_date, created_at, created_by, weight, vaccination_status, treatment, medical_notes';
const MEDICAL_RECORD_SUMMARY_SELECT = 'id, pet_id, record_date, created_at, medical_notes, treatment, vaccination_status';

function countAll() {
  return supabase
    .from('medical_records')
    .select('id', { count: 'exact', head: true });
}

function listAllRecords() {
  return supabase
    .from('medical_records')
    .select(MEDICAL_RECORD_SELECT)
    .order('record_date', { ascending: false });
}

function listSummariesByPetIds(petIds) {
  return supabase
    .from('medical_records')
    .select(MEDICAL_RECORD_SUMMARY_SELECT)
    .in('pet_id', petIds);
}

function listByPetIds(petIds) {
  return supabase
    .from('medical_records')
    .select(MEDICAL_RECORD_SELECT)
    .in('pet_id', petIds)
    .order('record_date', { ascending: false });
}

function createMedicalRecord(record) {
  return supabase
    .from('medical_records')
    .insert([record])
    .select(MEDICAL_RECORD_SELECT);
}

module.exports = {
  MEDICAL_RECORD_SELECT,
  countAll,
  listAllRecords,
  listSummariesByPetIds,
  listByPetIds,
  createMedicalRecord
};
