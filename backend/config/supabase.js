const { createClient } = require('@supabase/supabase-js');
const { requireSupabaseConfig } = require('./env');
const logger = require('../utils/logger');

const { url, key, keyName, keyRole } = requireSupabaseConfig();

const supabase = createClient(url, key);

// Names the variable and the kind of key in use, never the key itself
if (keyRole === 'service_role') {
  logger.info('supabase.client_key', { variable: keyName, role: keyRole });
} else {
  logger.warn('supabase.client_key', {
    variable: keyName,
    role: keyRole,
    note: 'Set SUPABASE_SERVICE_KEY (service role) before enabling row level security, or every query will be refused.'
  });
}

module.exports = supabase;
