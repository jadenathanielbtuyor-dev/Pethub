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

function listRecentSystemLogs(limit = 20) {
  return supabase
    .from('activity_logs')
    .select('id, actor_id, user_id, target_table, target_id, action, details, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
}

function listUserActivityLogs(userId, limit = 20) {
  return supabase
    .from('activity_logs')
    .select('id, action, details, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
}

module.exports = {
  insertActivityLog,
  countAll,
  listCompletedMedicalRecordActions,
  listRecentSystemLogs,
  listUserActivityLogs
};
