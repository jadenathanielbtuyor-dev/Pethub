const supabase = require('../config/supabase');

function insertActivityLog(log) {
  return supabase
    .from('activity_logs')
    .insert([log]);
}

function countAll() {
  return supabase
    .from('activity_logs')
    .select('id', { count: 'exact', head: true });
}

function listCompletedMedicalRecordActions(actionPrefix, limit = 5000) {
  return supabase
    .from('activity_logs')
    .select('id, target_id, action, created_at')
    .eq('target_table', 'medical_records')
    .ilike('action', `${actionPrefix}%`)
    .order('created_at', { ascending: false })
    .limit(limit);
}

// excludeActions: actions left out (e.g. sign-ins, which otherwise fill the list)
function listRecentSystemLogs(limit = 20, { excludeActions = [] } = {}) {
  let query = supabase
    .from('activity_logs')
    .select('id, actor_id, user_id, target_table, target_id, action, details, created_at');
  excludeActions.forEach(action => { query = query.neq('action', action); });
  return query
    .order('created_at', { ascending: false })
    .limit(limit);
}

function listUserActivityLogs(userId, limit = 20, { excludeActions = [] } = {}) {
  let query = supabase
    .from('activity_logs')
    .select('id, action, details, created_at')
    .eq('user_id', userId);
  excludeActions.forEach(action => { query = query.neq('action', action); });
  return query
    .order('created_at', { ascending: false })
    .limit(limit);
}

// Service-catalog activity, newest first, one page (from..to). Filters: one service, one event type ('legacy' = rows saved
// before types existed), one administrator, and a created_at range (ISO timestamps).
function listServiceActivityPage({ serviceId = '', eventType = '', actorId = '', fromIso = '', toIso = '' } = {}, { from, to }) {
  let query = supabase
    .from('activity_logs')
    .select('id, actor_id, target_id, action, details, event_type, created_at', { count: 'exact' })
    .eq('target_table', 'pethub_service_catalog');
  if (serviceId) query = query.eq('target_id', serviceId);
  if (eventType === 'legacy') query = query.is('event_type', null);
  else if (eventType) query = query.eq('event_type', eventType);
  if (actorId) query = query.eq('actor_id', actorId);
  if (fromIso) query = query.gte('created_at', fromIso);
  if (toIso) query = query.lt('created_at', toIso);
  return query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, to);
}

// The administrators who appear in the service activity (for the "Administrator" filter)
function listServiceActivityActors() {
  return supabase
    .from('activity_logs')
    .select('actor_id')
    .eq('target_table', 'pethub_service_catalog')
    .order('created_at', { ascending: false })
    .limit(500);
}

module.exports = {
  insertActivityLog,
  listServiceActivityPage,
  listServiceActivityActors,
  countAll,
  listCompletedMedicalRecordActions,
  listRecentSystemLogs,
  listUserActivityLogs
};
