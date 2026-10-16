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

const supabaseKey = readFirstEnv([
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_KEY'
]);

const env = {
  nodeEnv: readEnv('NODE_ENV', 'development'),
  port: parsePort(readEnv('PORT', '5000')),
  supabase: {
    url: readEnv('SUPABASE_URL'),
    key: supabaseKey.value,
    keyName: supabaseKey.name
  },
  brevo: {
    apiKey: readEnv('BREVO_API_KEY'),
    // Sender settings keep their existing variable names for now
    fromEmail: readEnv('SENDGRID_FROM_EMAIL'),
    fromName: readEnv('SENDGRID_FROM_NAME', 'PetHub')
  },
  gemini: {
    apiKey: readEnv('GEMINI_API_KEY'),
    model: readEnv('GEMINI_MODEL', 'gemini-2.5-flash')
  },
  auth: {
    tokenSecret: readEnv('AUTH_TOKEN_SECRET')
  },
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
    throw new Error('Missing Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY (or SUPABASE_SERVICE_KEY) in Railway/backend environment variables.');
  }

  return env.supabase;
}

module.exports = {
  ...env,
  requireSupabaseConfig
};
