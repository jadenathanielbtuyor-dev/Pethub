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

// The full profile of one pet, only if it belongs to userId
function findProfileForUser(userId, petId) {
  return supabase
    .from('pets')
    .select(PET_SELECT)
    .eq('id', petId)
    .eq('user_id', userId)
    .maybeSingle();
}

// Changes only the given profile fields of the owner's pet; 0 rows returned = not this owner's pet
function updateByIdForUser(petId, userId, changes) {
  return supabase
    .from('pets')
    .update(changes)
    .eq('id', petId)
    .eq('user_id', userId)
    .select(PET_SELECT);
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

// The owner's pet, with its species for the booking's service check
function findUserPetById(userId, petId) {
  return supabase
    .from('pets')
    .select('id, user_id, name, species')
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
  findProfileForUser,
  updateByIdForUser,
  deleteByIdForUser,
  listBasicByUserId,
  findUserPetById,
  listAllPets,
  listNamesByIds,
  listSpecies,
  findOwnerById
};
