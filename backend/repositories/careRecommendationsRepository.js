const supabase = require('../config/supabase');

// Clinic-configured follow-up rules (care_recommendation_rules) and the suggestions made for each pet
// (pet_care_recommendations), database/migrations/2026-10-24_multi_pet_booking_and_care_recommendations.sql

const RULE_SELECT = 'id, service_id, species, min_interval_days, max_interval_days, guidance_type, description, explanation, is_active, version, created_by, updated_by, created_at, updated_at';
const RECOMMENDATION_SELECT = 'id, pet_id, user_id, service_id, service_name, source_appointment_id, rule_id, basis, guidance_type, service_date, due_from, due_to, explanation, status, set_by, created_at, updated_at, acknowledged_at, dismissed_at';

function listRules() {
  return supabase.from('care_recommendation_rules').select(RULE_SELECT).order('created_at', { ascending: true });
}

function findRuleById(id) {
  return supabase.from('care_recommendation_rules').select(RULE_SELECT).eq('id', id).maybeSingle();
}

// The active rules of one service (all species and/or one species)
function listActiveRulesForService(serviceId) {
  return supabase.from('care_recommendation_rules').select(RULE_SELECT).eq('service_id', serviceId).eq('is_active', true);
}

function createRule(rule) {
  return supabase.from('care_recommendation_rules').insert([rule]).select(RULE_SELECT);
}

function updateRule(id, expectedVersion, changes) {
  return supabase
    .from('care_recommendation_rules')
    .update({ ...changes, version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('version', expectedVersion)
    .select(RULE_SELECT);
}

// How many open suggestions each rule produced (shown before a rule is changed)
function listOpenRecommendationRuleIds() {
  return supabase.from('pet_care_recommendations').select('rule_id').in('status', ['active', 'acknowledged']).not('rule_id', 'is', null);
}

function findBySourceAppointment(appointmentId) {
  return supabase
    .from('pet_care_recommendations')
    .select(RECOMMENDATION_SELECT)
    .eq('source_appointment_id', appointmentId)
    .neq('status', 'superseded')
    .maybeSingle();
}

function findById(id) {
  return supabase.from('pet_care_recommendations').select(RECOMMENDATION_SELECT).eq('id', id).maybeSingle();
}

function insertRecommendation(recommendation) {
  return supabase.from('pet_care_recommendations').insert([recommendation]).select(RECOMMENDATION_SELECT);
}

// Earlier open suggestions for the same pet and service end when a newer one is made (no duplicate reminders)
function supersedeOpenForPetService(petId, serviceName, exceptId = null) {
  let query = supabase
    .from('pet_care_recommendations')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('pet_id', petId)
    .eq('service_name', serviceName)
    .in('status', ['active', 'acknowledged']);
  if (exceptId) query = query.neq('id', exceptId);
  return query.select('id');
}

// A clinic override replaces the suggestion whatever the owner did with it (it must not stay open beside the new one)
function supersedeById(id) {
  return supabase
    .from('pet_care_recommendations')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['active', 'acknowledged', 'dismissed'])
    .select('id');
}

// The owner's own suggestions they can still see, soonest due first
function listVisibleForUser(userId) {
  return supabase
    .from('pet_care_recommendations')
    .select(RECOMMENDATION_SELECT)
    .eq('user_id', userId)
    .in('status', ['active', 'acknowledged'])
    .order('due_from', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);
}

function listForPet(petId) {
  return supabase
    .from('pet_care_recommendations')
    .select(RECOMMENDATION_SELECT)
    .eq('pet_id', petId)
    .order('created_at', { ascending: false })
    .limit(50);
}

// Owner acknowledges or dismisses their own open suggestion (0 rows when it is not theirs or no longer open)
function updateOwnStatus(id, userId, status) {
  const at = new Date().toISOString();
  const stamp = status === 'dismissed' ? { dismissed_at: at } : { acknowledged_at: at };
  return supabase
    .from('pet_care_recommendations')
    .update({ status, ...stamp, updated_at: at })
    .eq('id', id)
    .eq('user_id', userId)
    .in('status', ['active', 'acknowledged'])
    .select(RECOMMENDATION_SELECT);
}

module.exports = {
  listRules,
  findRuleById,
  listActiveRulesForService,
  createRule,
  updateRule,
  listOpenRecommendationRuleIds,
  findBySourceAppointment,
  findById,
  insertRecommendation,
  supersedeOpenForPetService,
  supersedeById,
  listVisibleForUser,
  listForPet,
  updateOwnStatus
};
