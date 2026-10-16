const supabase = require('../config/supabase');

const PET_SELECT = 'id, user_id, name, species, breed, age, created_at';

function countAll() {
  return supabase
    .from('pets')
    .select('id', { count: 'exact', head: true });
}

function createPet(pet) {
  return supabase
    .from('pets')
    .insert([pet])
    .select(PET_SELECT);
}

function listByUserId(userId) {
  return supabase
    .from('pets')
    .select(PET_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

function deleteByIdForUser(petId, userId) {
  return supabase
    .from('pets')
    .delete()
    .eq('id', petId)
    .eq('user_id', userId)
    .select('id');
}

function listBasicByUserId(userId) {
  return supabase
    .from('pets')
    .select('id, name')
    .eq('user_id', userId);
}

function findUserPetById(userId, petId) {
  return supabase
    .from('pets')
    .select('id, user_id, name')
    .eq('id', petId)
    .eq('user_id', userId)
    .limit(1);
}

function listAllPets() {
  return supabase
    .from('pets')
    .select(PET_SELECT)
    .order('created_at', { ascending: false });
}

function listNamesByIds(petIds) {
  return supabase
    .from('pets')
    .select('id, name')
    .in('id', petIds);
}

function listSpecies() {
  return supabase
    .from('pets')
    .select('species');
}

function findOwnerById(petId) {
  return supabase
    .from('pets')
    .select('id, user_id')
    .eq('id', petId)
    .maybeSingle();
}

module.exports = {
  PET_SELECT,
  countAll,
  createPet,
  listByUserId,
  deleteByIdForUser,
  listBasicByUserId,
  findUserPetById,
  listAllPets,
  listNamesByIds,
  listSpecies,
  findOwnerById
};
