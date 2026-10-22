const supabase = require('../config/supabase');

const BREED_SELECT = 'id, species, name, recognition_status, source_organization, source_url, source_reviewed_at, is_active, created_by, updated_by, created_at, updated_at';

function list({ species = '', activeOnly = true } = {}) {
  let query = supabase.from('pet_breed_catalog').select(BREED_SELECT).order('name', { ascending: true });
  if (species) query = query.eq('species', species);
  if (activeOnly) query = query.eq('is_active', true);
  return query;
}

function listBySpecies(species) {
  return supabase.from('pet_breed_catalog').select('id, species, name, is_active')
    .eq('species', species).order('name', { ascending: true });
}

function findById(id) {
  return supabase.from('pet_breed_catalog').select(BREED_SELECT).eq('id', id).maybeSingle();
}

function create(entry) {
  return supabase.from('pet_breed_catalog').insert([entry]).select(BREED_SELECT);
}

function update(id, changes) {
  return supabase.from('pet_breed_catalog').update(changes).eq('id', id).select(BREED_SELECT);
}

module.exports = { BREED_SELECT, list, listBySpecies, findById, create, update };
