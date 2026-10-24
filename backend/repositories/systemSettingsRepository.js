const supabase = require('../config/supabase');

function listByKeys(keys) {
  return supabase
    .from('system_settings')
    .select('setting_key, setting_value, updated_at')
    .in('setting_key', keys);
}

// One row per key (system_settings_setting_key_key is unique), created or replaced
function upsertValues(entries) {
  const updatedAt = new Date().toISOString();
  return supabase
    .from('system_settings')
    .upsert(entries.map(({ key, value }) => ({ setting_key: key, setting_value: value, updated_at: updatedAt })), { onConflict: 'setting_key' })
    .select('id, setting_key, setting_value, updated_at');
}

module.exports = {
  listByKeys,
  upsertValues
};
