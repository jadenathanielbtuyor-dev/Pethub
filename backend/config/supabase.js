const { createClient } = require('@supabase/supabase-js');
const { requireSupabaseConfig } = require('./env');

const { url, key } = requireSupabaseConfig();

const supabase = createClient(url, key);

module.exports = supabase;
