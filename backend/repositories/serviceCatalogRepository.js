const supabase = require('../config/supabase');

const SERVICE_SELECT = 'id, service_key, name, description, category, species, duration_minutes, online_booking_enabled, display_order, version, created_by, updated_by, created_at, updated_at';

function listAll() {
  return supabase
    .from('pethub_service_catalog')
    .select(SERVICE_SELECT)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
}

function findById(id) {
  return supabase
    .from('pethub_service_catalog')
    .select(SERVICE_SELECT)
    .eq('id', id)
    .maybeSingle();
}

function findByName(name) {
  return supabase
    .from('pethub_service_catalog')
    .select(SERVICE_SELECT)
    .eq('name', name)
    .maybeSingle();
}

function create(service) {
  return supabase
    .from('pethub_service_catalog')
    .insert([service])
    .select(SERVICE_SELECT);
}

function listNamesByIds(ids) {
  return supabase
    .from('pethub_service_catalog')
    .select('id, name')
    .in('id', ids);
}

function updateById(id, expectedVersion, changes) {
  return supabase
    .from('pethub_service_catalog')
    .update({
      ...changes,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .eq('version', expectedVersion)
    .select(SERVICE_SELECT);
}

module.exports = {
  SERVICE_SELECT,
  listAll,
  findById,
  findByName,
  create,
  listNamesByIds,
  updateById
};
