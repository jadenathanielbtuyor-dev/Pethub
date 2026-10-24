const supabase = require('../config/supabase');

const BREED_SELECT = 'id, species, name, recognition_status, source_organization, source_url, source_reviewed_at, is_active, created_by, updated_by, created_at, updated_at';

function list({ species = '', activeOnly = true } = {}) {
  let query = supabase.from('pet_breed_catalog').select(BREED_SELECT).order('name', { ascending: true });
  if (species) query = query.eq('species', species);
  if (activeOnly) query = query.eq('is_active', true);
  return query;
}

// One page of the catalog for the admin Breed Catalog: species, selection status ('active' | 'inactive' | 'all'), a search
// over name and source (already sanitized for PostgREST), and a sort; count: 'exact' gives the total for the page numbers
const BREED_SORTS = Object.freeze({
  name_asc: [['name', true]],
  name_desc: [['name', false]],
  updated_desc: [['updated_at', false], ['name', true]],
  species_name: [['species', true], ['name', true]]
});

function listPage({ species = '', status = 'active', search = '', sort = 'name_asc' } = {}, { from, to }) {
  let query = supabase.from('pet_breed_catalog').select(BREED_SELECT, { count: 'exact' });
  if (species) query = query.eq('species', species);
  if (status === 'active') query = query.eq('is_active', true);
  if (status === 'inactive') query = query.eq('is_active', false);
  if (search) query = query.or(`name.ilike.*${search}*,source_organization.ilike.*${search}*`);
  (BREED_SORTS[sort] || BREED_SORTS.name_asc).forEach(([column, ascending]) => { query = query.order(column, { ascending }); });
  return query.order('id', { ascending: true }).range(from, to);
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

module.exports = { BREED_SELECT, BREED_SORTS, list, listPage, listBySpecies, findById, create, update };
