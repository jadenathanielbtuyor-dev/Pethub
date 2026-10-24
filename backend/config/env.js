const dotenv = require('dotenv');

dotenv.config({ quiet: true });

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://pethub-beige.vercel.app',
  'https://pethub-zzz-duke1-s-projects.vercel.app',
  'https://pethub-git-main-zzz-duke1-s-projects.vercel.app',
  'https://pethub-jxb3zsszt-zzz-duke1-s-projects.vercel.app'
]);

function readEnv(name, defaultValue = '') {
  const value = process.env[name];
  return value === undefined || value === null || value === '' ? defaultValue : value;
}

function readFirstEnv(names = []) {
  for (const name of names) {
    const value = readEnv(name);
    if (value) {
      return { name, value };
    }
  }

  return { name: '', value: '' };
}

function parseCsvEnv(name) {
  return readEnv(name)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

function uniqueValues(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function parsePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : 5000;
}

// What a Supabase API key may do, read from its format (the key itself is never logged):
// 'anon' for the public publishable/anon key, 'service_role' for the server-only secret key, otherwise 'unknown'
function getSupabaseKeyRole(key) {
  const value = String(key || '');
  if (!value) return 'unknown';
  if (value.startsWith('sb_publishable_')) return 'anon';
  if (value.startsWith('sb_secret_')) return 'service_role';

  const parts = value.split('.');
  if (parts.length !== 3) return 'unknown';
  try {
    const role = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role;
    return role === 'anon' || role === 'service_role' ? role : 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

// The browser never talks to Supabase: every query goes through this backend, so it uses the server-only service role
// key when one is set. Row level security can then close the tables to the public key without breaking the app
// (database/migrations/2026-10-20_rls_least_privilege.sql). Without a usable service key the public key is used as
// before. A public key pasted into SUPABASE_SERVICE_KEY by mistake is ignored.
function selectSupabaseKey() {
  const serviceKey = readEnv('SUPABASE_SERVICE_KEY');
  const serviceKeyUsable = serviceKey
    && getSupabaseKeyRole(serviceKey) === 'service_role'
    && serviceKey !== readEnv('SUPABASE_ANON_KEY');
  if (serviceKeyUsable) return { name: 'SUPABASE_SERVICE_KEY', value: serviceKey };
  return readFirstEnv(['SUPABASE_ANON_KEY', 'SUPABASE_KEY']);
}

const supabaseKey = selectSupabaseKey();

const env = {
  nodeEnv: readEnv('NODE_ENV', 'development'),
  port: parsePort(readEnv('PORT', '5000')),
  supabase: {
    url: readEnv('SUPABASE_URL'),
    key: supabaseKey.value,
    keyName: supabaseKey.name,
    keyRole: getSupabaseKeyRole(supabaseKey.value)
  },
  brevo: {
    apiKey: readEnv('BREVO_API_KEY'),
    // Email is sent through Brevo. The sender is read from BREVO_SENDER_EMAIL / BREVO_SENDER_NAME; deployments set up
    // before those names existed still use SENDGRID_FROM_EMAIL / SENDGRID_FROM_NAME (legacy names, same meaning).
    // SENDGRID_API_KEY is not read anywhere.
    fromEmail: readFirstEnv(['BREVO_SENDER_EMAIL', 'SENDGRID_FROM_EMAIL']).value,
    fromName: readFirstEnv(['BREVO_SENDER_NAME', 'SENDGRID_FROM_NAME']).value || 'PetHub'
  },
  gemini: {
    apiKey: readEnv('GEMINI_API_KEY'),
    model: readEnv('GEMINI_MODEL', 'gemini-2.5-flash')
  },
  auth: {
    tokenSecret: readEnv('AUTH_TOKEN_SECRET')
  },
  // Frontend origin used for the My Appointments link in appointment emails (CORS below also allows it)
  frontendUrl: readEnv('FRONTEND_URL').trim(),
  cors: {
    allowedOrigins: uniqueValues([
      ...DEFAULT_ALLOWED_ORIGINS,
      readEnv('FRONTEND_URL'),
      ...parseCsvEnv('CORS_ORIGINS')
    ])
  }
};

env.isProduction = env.nodeEnv === 'production';

function requireSupabaseConfig() {
  if (!env.supabase.url || !env.supabase.key) {
    throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) in Railway/backend environment variables.');
  }

  if (env.isProduction && env.supabase.keyRole !== 'service_role') {
    throw new Error('Production requires a service-role Supabase key in SUPABASE_SERVICE_KEY. The public anon key is not accepted.');
  }

  return env.supabase;
}

module.exports = {
  ...env,
  requireSupabaseConfig,
  getSupabaseKeyRole
};
